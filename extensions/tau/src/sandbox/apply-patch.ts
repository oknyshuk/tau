import { access, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import * as Diff from "diff";

import { getWorkerApprovalBroker } from "../agent/approval-broker.js";
import { errorMessage } from "../shared/error-message.js";
import { isRecord } from "../shared/json.js";
import { loadPersistedState } from "../shared/state.js";
import type { SandboxConfig } from "./config.js";
import { computeEffectiveConfig } from "./config.js";
import { checkFilesystemApproval } from "./approval.js";
import { checkWriteAllowed } from "./fs-policy.js";
import { APPLY_PATCH_TOOL_NAME } from "./mutation-tools.js";
import { discoverWorkspaceRoot } from "./workspace-root.js";

const FILE_MUTATION_QUEUE_KEY = Symbol.for("@earendil-works/pi-coding-agent:file-mutation-queues");

const _global = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
const fileMutationQueues: Map<string, Promise<void>> =
	_global[FILE_MUTATION_QUEUE_KEY] ??
	(_global[FILE_MUTATION_QUEUE_KEY] = new Map<string, Promise<void>>());

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = path.resolve(filePath);
	try {
		return await realpath(resolvedPath);
	} catch {
		return resolvedPath;
	}
}

async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = await getMutationQueueKey(filePath);
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
	let releaseNext!: () => void;
	const nextQueue = new Promise<void>((resolve) => {
		releaseNext = resolve;
	});
	const chainedQueue = currentQueue.then(() => nextQueue);
	fileMutationQueues.set(key, chainedQueue);
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

const ApplyPatchParams = Type.Object({
	input: Type.String({
		description:
			"The full Codex apply_patch body, including *** Begin Patch / *** End Patch markers.",
	}),
});

type ParsePatchResult = {
	readonly patch: string;
	readonly hunks: readonly PatchHunk[];
};

type AddFileHunk = {
	readonly type: "add";
	readonly path: string;
	readonly contents: string;
};

type DeleteFileHunk = {
	readonly type: "delete";
	readonly path: string;
};

type UpdateFileChunk = {
	readonly changeContext?: string | undefined;
	readonly oldLines: readonly string[];
	readonly newLines: readonly string[];
	readonly isEndOfFile: boolean;
};

type UpdateFileHunk = {
	readonly type: "update";
	readonly path: string;
	readonly movePath?: string | undefined;
	readonly chunks: readonly UpdateFileChunk[];
};

type PatchHunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

type ResolvedAddOperation = {
	readonly type: "add";
	readonly absolutePath: string;
	readonly contents: string;
};

type ResolvedDeleteOperation = {
	readonly type: "delete";
	readonly absolutePath: string;
};

type ResolvedUpdateOperation = {
	readonly type: "update";
	readonly absolutePath: string;
	readonly movePath?: string | undefined;
	readonly chunks: readonly UpdateFileChunk[];
};

type ResolvedPatchOperation =
	| ResolvedAddOperation
	| ResolvedDeleteOperation
	| ResolvedUpdateOperation;

type FileDiff = {
	readonly filePath: string;
	readonly diff: string;
};

type ApplyPatchSummary = {
	readonly added: readonly string[];
	readonly modified: readonly string[];
	readonly deleted: readonly string[];
	readonly diffs: readonly FileDiff[];
};

type SessionSandboxContext = {
	readonly workspaceRoot: string;
	readonly effectiveConfig: ReturnType<typeof computeEffectiveConfig>;
};

type ApplyPatchToolOptions = {
	readonly resolveSessionSandboxContext?:
		| ((ctx: ExtensionContext) => SessionSandboxContext)
		| undefined;
};

function readSessionOverride(value: unknown): SandboxConfig | undefined {
	if (!isRecord(value)) return undefined;

	const next: SandboxConfig = {};
	const preset = value["preset"];
	if (preset === "read-only" || preset === "workspace-write" || preset === "full-access") {
		next.preset = preset;
	}

	const subagent = value["subagent"];
	if (typeof subagent === "boolean") {
		next.subagent = subagent;
	}

	return next;
}

function resolveDefaultSessionSandboxContext(ctx: {
	readonly cwd: string;
	readonly sessionManager: { readonly getEntries: () => unknown[] };
}): SessionSandboxContext {
	const persisted = loadPersistedState(ctx);
	const workspaceRoot = discoverWorkspaceRoot(ctx.cwd);
	const sessionOverride = readSessionOverride(persisted.sandbox?.["sessionOverride"]);
	const effectiveConfig = computeEffectiveConfig({
		workspaceRoot,
		...(sessionOverride ? { sessionOverride } : {}),
	});
	return { workspaceRoot, effectiveConfig };
}

function normalizePatchPath(rawPath: string, lineNumber: number): string {
	const trimmed = rawPath.trim();
	if (trimmed.length === 0) {
		throw new Error(`Invalid patch hunk at line ${lineNumber}: file path must not be empty`);
	}
	if (path.isAbsolute(trimmed)) {
		throw new Error(
			`Invalid patch hunk at line ${lineNumber}: file paths must be relative, got "${trimmed}"`,
		);
	}
	return trimmed;
}

function stripHeredoc(input: string): string {
	const match = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	return match?.[2] ?? input;
}

function normalizePatchInput(input: string): string {
	return stripHeredoc(input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim());
}

function locatePatchBoundaries(text: string): { readonly lines: readonly string[]; readonly begin: number; readonly end: number } {
	const lines = text.split("\n");
	const begin = lines.findIndex((line) => line === BEGIN_PATCH_MARKER);
	const explicitEnd = lines.findIndex((line) => line === END_PATCH_MARKER);
	if (begin === -1) {
		throw new Error("Invalid patch format: missing Begin/End markers");
	}
	const end = explicitEnd === -1 ? lines.length : explicitEnd;
	if (begin >= end) {
		throw new Error("Invalid patch format: missing Begin/End markers");
	}
	return { lines, begin, end };
}

function hasDiffHeaders(lines: ReadonlyArray<string>): boolean {
	return lines.some(
		(line) =>
			line.startsWith("diff --git ") ||
			line.startsWith("--- ") ||
			line.startsWith("rename from ") ||
			line.startsWith("rename to "),
	);
}

function normalizeDiffPath(filePath: string): string {
	if (filePath === "/dev/null") return filePath;
	if (filePath.startsWith("a/") || filePath.startsWith("b/")) return filePath.slice(2);
	return filePath;
}

function parseDiffHeaderPath(line: string, prefix: "--- " | "+++ "): string {
	const body = line.slice(prefix.length);
	const tabIndex = body.indexOf("\t");
	const value = tabIndex === -1 ? body : body.slice(0, tabIndex);
	return normalizeDiffPath(value.trim());
}

function parseDiffGitPaths(line: string): readonly [string, string] | undefined {
	const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
	if (!match) return undefined;
	return [match[1]!, match[2]!];
}

function parseChunkHeader(line: string): string | undefined {
	if (line === "@@") return undefined;

	const unified = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@(?:\s?(.*))?$/);
	if (unified) {
		const ctx = unified[1]?.trim();
		return ctx === undefined || ctx.length === 0 ? undefined : ctx;
	}

	const ctx = line.slice(2).trim();
	return ctx.length === 0 ? undefined : ctx;
}

function parseChunks(
	lines: ReadonlyArray<string>,
	start: number,
	end = lines.length,
): { readonly chunks: UpdateFileChunk[]; readonly next: number } {
	const chunks: UpdateFileChunk[] = [];
	let i = start;

	while (i < end) {
		const line = lines[i]!;
		if (line.startsWith("***") || line.startsWith("diff --git ")) break;
		if (!line.startsWith("@@")) {
			i++;
			continue;
		}

		const ctx = parseChunkHeader(line);
		const oldLines: string[] = [];
		const newLines: string[] = [];
		let isEndOfFile = false;
		i++;

		while (i < end) {
			const innerLine = lines[i]!;
			if (innerLine === "*** End of File") {
				isEndOfFile = true;
				i++;
				break;
			}
			if (innerLine.startsWith("@@") || innerLine.startsWith("***") || innerLine.startsWith("diff --git ")) {
				break;
			}
			if (innerLine.startsWith(" ")) {
				const text = innerLine.slice(1);
				oldLines.push(text);
				newLines.push(text);
			} else if (innerLine.startsWith("-")) {
				oldLines.push(innerLine.slice(1));
			} else if (innerLine.startsWith("+")) {
				newLines.push(innerLine.slice(1));
			} else if (innerLine === "\\ No newline at end of file") {
				// intentionally ignored
			}
			i++;
		}

		chunks.push({
			oldLines,
			newLines,
			isEndOfFile,
			...(ctx === undefined ? {} : { changeContext: ctx }),
		});
	}

	return { chunks, next: i };
}

function parseAddContent(lines: ReadonlyArray<string>, start: number, end: number): { readonly content: string; readonly next: number } {
	let contents = "";
	let i = start;
	while (i < end) {
		const line = lines[i]!;
		if (line.startsWith("***")) break;
		if (line.startsWith("+")) {
			contents += line.slice(1);
			contents += "\n";
		}
		i++;
	}
	return { content: contents, next: i };
}

function derivePatchedContent(input: string, chunks: readonly UpdateFileChunk[]): string {
	const eol = input.includes("\r\n") ? "\r\n" : "\n";
	const lines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}

	const replacements: Array<{ readonly startIndex: number; readonly oldLength: number; readonly newSegment: readonly string[] }> = [];
	let lineIndex = 0;

	for (const chunk of chunks) {
		if (chunk.changeContext !== undefined) {
			const contextIndex = seekSequence(lines, [chunk.changeContext], lineIndex, false);
			if (contextIndex === undefined) {
				throw new Error(`Failed to find context '${chunk.changeContext}' in file`);
			}
			lineIndex = contextIndex + 1;
		}

		if (chunk.oldLines.length === 0) {
			replacements.push({ startIndex: lineIndex, oldLength: 0, newSegment: chunk.newLines });
			continue;
		}

		let searchPattern = [...chunk.oldLines];
		let newSegment = [...chunk.newLines];
		let foundIndex = seekSequence(lines, searchPattern, lineIndex, chunk.isEndOfFile);
		if (foundIndex === undefined && searchPattern[searchPattern.length - 1] === "") {
			searchPattern = searchPattern.slice(0, -1);
			if (newSegment[newSegment.length - 1] === "") {
				newSegment = newSegment.slice(0, -1);
			}
			foundIndex = seekSequence(lines, searchPattern, lineIndex, chunk.isEndOfFile);
		}

		if (foundIndex === undefined) {
			throw new Error(`Failed to find expected lines in file:\n${chunk.oldLines.join("\n")}`);
		}

		replacements.push({ startIndex: foundIndex, oldLength: searchPattern.length, newSegment });
		lineIndex = foundIndex + searchPattern.length;
	}

	replacements.sort((left, right) => left.startIndex - right.startIndex);

	const nextLines = [...lines];
	for (const replacement of [...replacements].reverse()) {
		nextLines.splice(replacement.startIndex, replacement.oldLength, ...replacement.newSegment);
	}

	if (nextLines[nextLines.length - 1] !== "") {
		nextLines.push("");
	}

	const text = nextLines.join("\n");
	return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function parseGitPatch(text: string): PatchHunk[] {
	const lines = text.split("\n");
	const hunks: PatchHunk[] = [];
	let i = 0;

	while (i < lines.length) {
		while (i < lines.length && lines[i]!.trim() === "") i++;
		if (i >= lines.length) break;

		let oldPath: string | undefined;
		let newPath: string | undefined;
		let renameFrom: string | undefined;
		let renameTo: string | undefined;

		if (lines[i]!.startsWith("diff --git ")) {
			const parsedPaths = parseDiffGitPaths(lines[i]!);
			if (!parsedPaths) throw new Error(`invalid git diff header: ${lines[i]}`);
			const [parsedOldPath, parsedNewPath] = parsedPaths;
			oldPath = parsedOldPath;
			newPath = parsedNewPath;
			i++;
		}

		while (i < lines.length) {
			const line = lines[i]!;
			if (line.startsWith("diff --git ")) break;
			if (line.startsWith("rename from ")) {
				renameFrom = line.slice("rename from ".length).trim();
				i++;
				continue;
			}
			if (line.startsWith("rename to ")) {
				renameTo = line.slice("rename to ".length).trim();
				i++;
				continue;
			}
			if (line.startsWith("--- ")) {
				oldPath = parseDiffHeaderPath(line, "--- ");
				i++;
				if (i >= lines.length || !lines[i]!.startsWith("+++ ")) {
					throw new Error("missing new file header");
				}
				newPath = parseDiffHeaderPath(lines[i]!, "+++ ");
				i++;
				break;
			}
			if (line.startsWith("@@")) break;
			i++;
		}

		const parsed = parseChunks(lines, i);
		i = parsed.next;

		const fromPath = normalizeDiffPath(renameFrom ?? oldPath ?? "/dev/null");
		const toPath = normalizeDiffPath(renameTo ?? newPath ?? fromPath);

		if (fromPath === "/dev/null") {
			if (toPath === "/dev/null") throw new Error("invalid diff: both file paths are /dev/null");
			hunks.push({
				type: "add",
				path: toPath,
				contents: derivePatchedContent("", parsed.chunks),
			});
			continue;
		}

		if (toPath === "/dev/null") {
			hunks.push({ type: "delete", path: fromPath });
			continue;
		}

		if (parsed.chunks.length === 0 && fromPath === toPath) {
			throw new Error(`no hunks found for ${fromPath}`);
		}

		hunks.push({
			type: "update",
			path: fromPath,
			chunks: parsed.chunks,
			...(toPath === fromPath ? {} : { movePath: toPath }),
		});
	}

	if (hunks.length === 0) {
		throw new Error("no hunks found");
	}

	return hunks;
}

function parsePatch(input: string): ParsePatchResult {
	const text = normalizePatchInput(input);
	if (text.length === 0) {
		throw new Error("patchText is required");
	}
	if (text === `${BEGIN_PATCH_MARKER}\n${END_PATCH_MARKER}`) {
		throw new Error("patch rejected: empty patch");
	}

	if (text.startsWith(BEGIN_PATCH_MARKER)) {
		const { lines, begin, end } = locatePatchBoundaries(text);
		const hunks: PatchHunk[] = [];
		let i = begin + 1;
		let lineNumber = 2;

		while (i < end) {
			while (i < end && lines[i]!.trim() === "") {
				i++;
				lineNumber++;
			}
			if (i === end) break;

			const line = lines[i]!;
			if (line.startsWith(ADD_FILE_MARKER)) {
				const hunkPath = normalizePatchPath(line.slice(ADD_FILE_MARKER.length), lineNumber);
				const parsed = parseAddContent(lines, i + 1, end);
				hunks.push({ type: "add", path: hunkPath, contents: parsed.content });
				lineNumber += parsed.next - i;
				i = parsed.next;
				continue;
			}
			if (line.startsWith(DELETE_FILE_MARKER)) {
				const hunkPath = normalizePatchPath(line.slice(DELETE_FILE_MARKER.length), lineNumber);
				hunks.push({ type: "delete", path: hunkPath });
				i++;
				lineNumber++;
				continue;
			}
			if (line.startsWith(UPDATE_FILE_MARKER)) {
				const hunkPath = normalizePatchPath(line.slice(UPDATE_FILE_MARKER.length), lineNumber);
				i++;
				lineNumber++;
				let movePath: string | undefined;
				if (i < end && lines[i]!.startsWith(MOVE_TO_MARKER)) {
					movePath = normalizePatchPath(lines[i]!.slice(MOVE_TO_MARKER.length), lineNumber);
					i++;
					lineNumber++;
				}
				const parsed = parseChunks(lines, i, end);
				if (parsed.chunks.length === 0) {
					throw new Error(`Invalid patch hunk at line ${lineNumber}: no hunks found`);
				}
				hunks.push({
					type: "update",
					path: hunkPath,
					chunks: parsed.chunks,
					...(movePath === undefined ? {} : { movePath }),
				});
				lineNumber += parsed.next - i;
				i = parsed.next;
				continue;
			}

			throw new Error(`Invalid patch hunk at line ${lineNumber}: '${line}' is not a valid hunk header`);
		}

		if (hunks.length === 0) {
			throw new Error("no hunks found");
		}

		return { patch: lines.join("\n"), hunks };
	}

	const lines = text.split("\n");
	if (hasDiffHeaders(lines)) {
		const hunks = parseGitPatch(text);
		return { patch: text, hunks };
	}

	// Try raw hunk(s) without wrapper
	const parsed = parseChunks(lines, 0);
	if (parsed.chunks.length === 0) {
		throw new Error("Invalid patch format: expected git/unified diff");
	}
	return {
		patch: text,
		hunks: [{ type: "update", path: "", chunks: parsed.chunks }],
	};
}

function seekSequence(
	lines: readonly string[],
	pattern: readonly string[],
	start: number,
	eof: boolean,
): number | undefined {
	if (pattern.length === 0) {
		return start;
	}
	if (pattern.length > lines.length) {
		return undefined;
	}

	const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
	const maxStart = lines.length - pattern.length;

	for (let index = searchStart; index <= maxStart; index += 1) {
		let ok = true;
		for (let offset = 0; offset < pattern.length; offset += 1) {
			if (lines[index + offset] !== pattern[offset]) {
				ok = false;
				break;
			}
		}
		if (ok) return index;
	}

	for (let index = searchStart; index <= maxStart; index += 1) {
		let ok = true;
		for (let offset = 0; offset < pattern.length; offset += 1) {
			if (lines[index + offset]?.trimEnd() !== pattern[offset]?.trimEnd()) {
				ok = false;
				break;
			}
		}
		if (ok) return index;
	}

	for (let index = searchStart; index <= maxStart; index += 1) {
		let ok = true;
		for (let offset = 0; offset < pattern.length; offset += 1) {
			if (lines[index + offset]?.trim() !== pattern[offset]?.trim()) {
				ok = false;
				break;
			}
		}
		if (ok) return index;
	}

	const normalizeLoose = (value: string): string =>
		value
			.trim()
			.replace(/[‐‑‒–—―−]/gu, "-")
			.replace(/[‘’‚‛]/gu, "'")
			.replace(/[“”„‟]/gu, '"')
			.replace(/\u2026/gu, "...")
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/gu, " ");

	for (let index = searchStart; index <= maxStart; index += 1) {
		let ok = true;
		for (let offset = 0; offset < pattern.length; offset += 1) {
			if (normalizeLoose(lines[index + offset] ?? "") !== normalizeLoose(pattern[offset] ?? "")) {
				ok = false;
				break;
			}
		}
		if (ok) return index;
	}

	return undefined;
}

function resolveOperations(cwd: string, hunks: readonly PatchHunk[]): ResolvedPatchOperation[] {
	return hunks.map((hunk) => {
		const absolutePath = path.resolve(cwd, hunk.path);
		if (hunk.type === "add") {
			return {
				type: "add",
				absolutePath,
				contents: hunk.contents,
			} satisfies ResolvedAddOperation;
		}
		if (hunk.type === "delete") {
			return {
				type: "delete",
				absolutePath,
			} satisfies ResolvedDeleteOperation;
		}
		return {
			type: "update",
			absolutePath,
			...(hunk.movePath !== undefined
				? { movePath: path.resolve(cwd, hunk.movePath) }
				: {}),
			chunks: hunk.chunks,
		} satisfies ResolvedUpdateOperation;
	});
}

function collectMutationPaths(operations: readonly ResolvedPatchOperation[]): string[] {
	const unique = new Set<string>();
	for (const operation of operations) {
		unique.add(operation.absolutePath);
		if (operation.type === "update" && operation.movePath !== undefined) {
			unique.add(operation.movePath);
		}
	}
	return [...unique].sort();
}

async function ensureFilesystemAccess(
	ctx: ExtensionContext,
	sandboxContext: SessionSandboxContext,
	paths: readonly string[],
): Promise<void> {
	for (const targetPath of paths) {
		const check = checkWriteAllowed({
			targetPath,
			cwd: ctx.cwd,
			workspaceRoot: sandboxContext.workspaceRoot,
			filesystemMode: sandboxContext.effectiveConfig.filesystemMode,
		});
		if (check.allowed) {
			continue;
		}

		const approval = await checkFilesystemApproval(
			ctx,
			sandboxContext.effectiveConfig.approvalPolicy,
			targetPath,
			APPLY_PATCH_TOOL_NAME,
			{ timeoutSeconds: sandboxContext.effectiveConfig.approvalTimeoutSeconds },
			getWorkerApprovalBroker(ctx.sessionManager.getSessionId()),
		);
		if (!approval.approved) {
			throw new Error(`${check.reason} (${approval.reason})`);
		}
		ctx.ui.notify?.(`Approved: ${APPLY_PATCH_TOOL_NAME} ${targetPath}`, "info");
	}
}

async function withMutationQueues<A>(
	paths: readonly string[],
	effect: () => Promise<A>,
): Promise<A> {
	const sortedPaths = [...new Set(paths)].sort();
	const run = async (index: number): Promise<A> => {
		const targetPath = sortedPaths[index];
		if (targetPath === undefined) {
			return effect();
		}
		return withFileMutationQueue(targetPath, async () => run(index + 1));
	};
	return run(0);
}

type ValidatedOperation =
	| { type: "add"; absolutePath: string; contents: string; relPath: string }
	| { type: "delete"; absolutePath: string; oldContents: string; relPath: string }
	| {
			type: "update";
			absolutePath: string;
			oldContents: string;
			nextContents: string;
			relPath: string;
			movePath?: string;
	  };

async function validateAndPlanOperations(
	operations: readonly ResolvedPatchOperation[],
	cwd: string,
): Promise<readonly ValidatedOperation[]> {
	const virtualState = new Map<string, string | null>();
	const originalContents = new Map<string, string>();
	const planned: ValidatedOperation[] = [];

	// Precompute which paths are written by operations that come AFTER each index.
	const laterWritePaths: Set<string>[] = [];
	const acc = new Set<string>();
	for (let i = operations.length - 1; i >= 0; i--) {
		laterWritePaths[i] = new Set(acc);
		const op = operations[i]!;
		if (op.type === "add") {
			acc.add(op.absolutePath);
		}
		if (op.type === "update") {
			acc.add(op.absolutePath);
			if (op.movePath !== undefined) {
				acc.add(op.movePath);
			}
		}
	}

	for (let i = 0; i < operations.length; i++) {
		const operation = operations[i]!;
		if (operation.type === "add") {
			const virtual = virtualState.get(operation.absolutePath);
			if (virtual !== undefined) {
				if (virtual !== null) {
					throw new Error(
						`Cannot add file ${path.relative(cwd, operation.absolutePath) || path.basename(operation.absolutePath)}: file already exists`,
					);
				}
				// Path was deleted earlier in this patch — allow recreation.
			} else {
				const exists = await access(operation.absolutePath).then(() => true, () => false);
				if (exists) {
					throw new Error(
						`Cannot add file ${path.relative(cwd, operation.absolutePath) || path.basename(operation.absolutePath)}: file already exists`,
					);
				}
			}
			virtualState.set(operation.absolutePath, operation.contents);
			planned.push({
				type: "add",
				absolutePath: operation.absolutePath,
				contents: operation.contents,
				relPath: path.relative(cwd, operation.absolutePath) || path.basename(operation.absolutePath),
			});
			continue;
		}

		if (operation.type === "delete") {
			const current = virtualState.get(operation.absolutePath);
			if (current === null) {
				throw new Error(
					`Cannot delete file ${path.relative(cwd, operation.absolutePath) || path.basename(operation.absolutePath)}: file does not exist`,
				);
			}
			let oldContents: string;
			if (current !== undefined) {
				oldContents = current;
			} else {
				try {
					oldContents = await readFile(operation.absolutePath, "utf8");
				} catch {
					throw new Error(
						`Cannot delete file ${path.relative(cwd, operation.absolutePath) || path.basename(operation.absolutePath)}: file does not exist`,
					);
				}
			}
			if (!originalContents.has(operation.absolutePath)) {
				originalContents.set(operation.absolutePath, oldContents);
			}
			virtualState.set(operation.absolutePath, null);
			planned.push({
				type: "delete",
				absolutePath: operation.absolutePath,
				oldContents,
				relPath: path.relative(cwd, operation.absolutePath) || path.basename(operation.absolutePath),
			});
			continue;
		}

		const current = virtualState.get(operation.absolutePath);
		let input: string;
		if (current !== undefined) {
			if (current === null) {
				throw new Error(
					`Cannot update file ${path.relative(cwd, operation.absolutePath) || path.basename(operation.absolutePath)}: file was deleted`,
				);
			}
			input = current;
		} else {
			input = await readFile(operation.absolutePath, "utf8");
		}
		if (!originalContents.has(operation.absolutePath)) {
			originalContents.set(operation.absolutePath, input);
		}

		const nextContents = derivePatchedContent(input, operation.chunks);

		if (operation.movePath !== undefined) {
			const virtualMove = virtualState.get(operation.movePath);
			if (virtualMove !== undefined) {
				if (virtualMove !== null) {
					throw new Error(
						`Cannot move to ${path.relative(cwd, operation.movePath) || path.basename(operation.movePath)}: file already exists`,
					);
				}
				// Destination was deleted earlier in this patch — allow move.
			} else {
				const moveExists = await access(operation.movePath).then(() => true, () => false);
				if (moveExists && !laterWritePaths[i]!.has(operation.movePath)) {
					throw new Error(
						`Cannot move to ${path.relative(cwd, operation.movePath) || path.basename(operation.movePath)}: file already exists`,
					);
				}
			}
			virtualState.set(operation.movePath, nextContents);
			virtualState.set(operation.absolutePath, null);
			planned.push({
				type: "update",
				absolutePath: operation.absolutePath,
				oldContents: originalContents.get(operation.absolutePath) ?? input,
				nextContents,
				relPath: path.relative(cwd, operation.movePath) || path.basename(operation.movePath),
				movePath: operation.movePath,
			});
			continue;
		}

		virtualState.set(operation.absolutePath, nextContents);
		planned.push({
			type: "update",
			absolutePath: operation.absolutePath,
			oldContents: originalContents.get(operation.absolutePath) ?? input,
			nextContents,
			relPath: path.relative(cwd, operation.absolutePath) || path.basename(operation.absolutePath),
		});
	}

	return planned;
}

function makeTempPath(targetPath: string): string {
	return `${targetPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function applyResolvedPatch(
	operations: readonly ResolvedPatchOperation[],
	cwd: string,
): Promise<ApplyPatchSummary> {
	if (operations.length === 0) {
		throw new Error("No files were modified.");
	}

	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];
	const diffs: FileDiff[] = [];

	// Acquire queues BEFORE validation so no other mutation can race.
	await withMutationQueues(collectMutationPaths(operations), async () => {
		const planned = await validateAndPlanOperations(operations, cwd);
		const temps: Array<{ temp: string; final: string }> = [];
		const deletesToRun: ValidatedOperation[] = [];
		const moveSourcesToDelete = new Set<string>();

		try {
			// Build deduplicated write list (last planned op per final path wins).
			const writesToRun: ValidatedOperation[] = [];
			const writePathsSeen = new Set<string>();
			const deletePathsSeen = new Set<string>();
			for (let i = planned.length - 1; i >= 0; i--) {
				const op = planned[i]!;
				if (op.type === "delete") {
					// Skip deletes for paths that are written again later in the same patch.
					if (!deletePathsSeen.has(op.absolutePath) && !writePathsSeen.has(op.absolutePath)) {
						deletePathsSeen.add(op.absolutePath);
						deletesToRun.push(op);
					}
					continue;
				}
				if (op.type === "update" && op.movePath !== undefined) {
					if (!writePathsSeen.has(op.absolutePath)) {
						moveSourcesToDelete.add(op.absolutePath);
					}
				}
				const finalPath =
					op.type === "add"
						? op.absolutePath
						: op.type === "update" && op.movePath !== undefined
							? op.movePath
							: op.absolutePath;
				if (writePathsSeen.has(finalPath)) continue;
				writePathsSeen.add(finalPath);
				writesToRun.unshift(op);
			}

			for (const op of writesToRun) {
				if (op.type === "add") {
					await mkdir(path.dirname(op.absolutePath), { recursive: true });
					const temp = makeTempPath(op.absolutePath);
					await writeFile(temp, op.contents, "utf8");
					temps.push({ temp, final: op.absolutePath });
					continue;
				}

				// update
				if (op.type === "update" && op.movePath !== undefined) {
					await mkdir(path.dirname(op.movePath), { recursive: true });
					const temp = makeTempPath(op.movePath);
					await writeFile(temp, op.nextContents, "utf8");
					temps.push({ temp, final: op.movePath });
					continue;
				}

				if (op.type === "update") {
					await mkdir(path.dirname(op.absolutePath), { recursive: true });
					const temp = makeTempPath(op.absolutePath);
					await writeFile(temp, op.nextContents, "utf8");
					temps.push({ temp, final: op.absolutePath });
				}
			}

			// Commit all temp files via rename (atomic on POSIX).
			for (const { temp, final } of temps) {
				await rename(temp, final);
			}

			// Perform deletes (explicit + move sources) ONLY after successful renames.
			// Tolerate ENOENT — a prior operation in the same patch may have already removed the path.
			const deleteTargets = new Set<string>([
				...deletesToRun.map((op) => op.absolutePath),
				...moveSourcesToDelete,
			]);
			for (const targetPath of deleteTargets) {
				await rm(targetPath).catch((error: unknown) => {
					if (
						typeof error === "object" &&
						error !== null &&
						"code" in error &&
						error.code === "ENOENT"
					) {
						return;
					}
					throw error;
				});
			}

			// Collect results. Deduplicate by keeping the last planned operation per path.
			const seenPaths = new Set<string>();
			for (let i = planned.length - 1; i >= 0; i--) {
				const op = planned[i]!;
				if (op.type === "add") {
					if (!seenPaths.has(op.relPath)) {
						seenPaths.add(op.relPath);
						added.unshift(op.relPath);
						diffs.unshift({ filePath: op.relPath, diff: generateDiffString("", op.contents) });
					}
					continue;
				}

				if (op.type === "delete") {
					if (!seenPaths.has(op.relPath)) {
						seenPaths.add(op.relPath);
						deleted.unshift(op.relPath);
						diffs.unshift({ filePath: op.relPath, diff: generateDiffString(op.oldContents, "") });
					}
					continue;
				}

				if (op.type === "update" && op.movePath !== undefined) {
					if (!seenPaths.has(op.relPath)) {
						seenPaths.add(op.relPath);
						modified.unshift(op.relPath);
						diffs.unshift({ filePath: op.relPath, diff: generateDiffString(op.oldContents, op.nextContents) });
					}
					continue;
				}

				if (!seenPaths.has(op.relPath)) {
					seenPaths.add(op.relPath);
					modified.unshift(op.relPath);
					diffs.unshift({ filePath: op.relPath, diff: generateDiffString(op.oldContents, op.nextContents) });
				}
			}
		} catch (error) {
			// Best-effort cleanup of temp files on failure.
			for (const { temp } of temps) {
				await rm(temp).catch((cleanupError) => {
					console.warn("apply-patch temp cleanup failed:", cleanupError);
				});
			}
			throw error;
		}
	});

	return { added, modified, deleted, diffs };
}

function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): string {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (part === undefined) continue;
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			for (const line of raw) {
				if (part.added) {
					output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
					newLineNum++;
				} else {
					output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange =
				i < parts.length - 1 &&
				(parts[i + 1]?.added === true || parts[i + 1]?.removed === true);

			if (lastWasChange || nextPartIsChange) {
				let linesToShow = raw;
				let skipStart = 0;
				let skipEnd = 0;

				if (!lastWasChange) {
					skipStart = Math.max(0, raw.length - contextLines);
					linesToShow = raw.slice(skipStart);
				}

				if (!nextPartIsChange && linesToShow.length > contextLines) {
					skipEnd = linesToShow.length - contextLines;
					linesToShow = linesToShow.slice(0, contextLines);
				}

				if (skipStart > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skipStart;
					newLineNum += skipStart;
				}

				for (const line of linesToShow) {
					output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skipEnd > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skipEnd;
					newLineNum += skipEnd;
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return output.join("\n");
}

function formatSummary(summary: ApplyPatchSummary): string {
	const lines = ["Success. Updated the following files:"];
	for (const filePath of summary.added) {
		lines.push(`A ${filePath}`);
	}
	for (const filePath of summary.modified) {
		lines.push(`M ${filePath}`);
	}
	for (const filePath of summary.deleted) {
		lines.push(`D ${filePath}`);
	}
	return lines.join("\n");
}

const APPLY_PATCH_DESCRIPTION = [
	"Apply a Codex-style patch to the filesystem.",
	"Provide the full patch in the input string using this format:",
	"*** Begin Patch",
	"*** Add File: path/to/file",
	"+new line",
	"*** Update File: path/to/existing",
	"@@ optional context",
	"-old line",
	"+new line",
	"*** Delete File: path/to/remove",
	"*** End Patch",
	"Use relative paths only.",
].join("\n");

type DiffTheme = {
	fg: (color: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext", text: string) => string;
	inverse: (text: string) => string;
};

function renderColoredDiff(diffText: string, theme: DiffTheme): string {
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (line === undefined) {
			i++;
			continue;
		}
		const prefix = line[0];

		if (prefix === "-") {
			const removedLines: string[] = [];
			while (i < lines.length && lines[i]?.[0] === "-") {
				removedLines.push(lines[i] ?? "");
				i++;
			}
			const addedLines: string[] = [];
			while (i < lines.length && lines[i]?.[0] === "+") {
				addedLines.push(lines[i] ?? "");
				i++;
			}

			if (removedLines.length === 1 && addedLines.length === 1) {
				const removedContent = (removedLines[0] ?? "").replace(/^-\s*\d*\s/, "");
				const addedContent = (addedLines[0] ?? "").replace(/^\+\s*\d*\s/, "");
				const wordDiff = Diff.diffWords(removedContent, addedContent);
				let removedRendered = (removedLines[0] ?? "").replace(removedContent, "");
				let addedRendered = (addedLines[0] ?? "").replace(addedContent, "");
				for (const part of wordDiff) {
					if (part.removed) {
						removedRendered += theme.inverse(part.value);
					} else if (part.added) {
						addedRendered += theme.inverse(part.value);
					} else {
						removedRendered += part.value;
						addedRendered += part.value;
					}
				}
				result.push(theme.fg("toolDiffRemoved", removedRendered));
				result.push(theme.fg("toolDiffAdded", addedRendered));
			} else {
				for (const line of removedLines) {
					result.push(theme.fg("toolDiffRemoved", line));
				}
				for (const line of addedLines) {
					result.push(theme.fg("toolDiffAdded", line));
				}
			}
		} else if (prefix === "+") {
			result.push(theme.fg("toolDiffAdded", line));
			i++;
		} else {
			result.push(theme.fg("toolDiffContext", line));
			i++;
		}
	}

	return result.join("\n");
}

export function createApplyPatchToolDefinition(
	options?: ApplyPatchToolOptions,
): ToolDefinition {
	return {
		name: APPLY_PATCH_TOOL_NAME,
		label: APPLY_PATCH_TOOL_NAME,
		description: APPLY_PATCH_DESCRIPTION,
		promptSnippet: "Apply Codex-style multi-file patches for file mutations",
		promptGuidelines: [
			"For openai and openai-codex models, use apply_patch instead of edit or write for filesystem changes.",
			"Pass the entire Codex patch body in the input string, including *** Begin Patch and *** End Patch.",
		],
		parameters: ApplyPatchParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = isRecord(params) ? params["input"] : undefined;
			if (typeof input !== "string") {
				throw new Error("apply_patch requires a string input field");
			}

			try {
				const sandboxContext = options?.resolveSessionSandboxContext
					? options.resolveSessionSandboxContext(ctx)
					: resolveDefaultSessionSandboxContext(ctx);
				const parsed = parsePatch(input);
				const operations = resolveOperations(ctx.cwd, parsed.hunks);
				await ensureFilesystemAccess(ctx, sandboxContext, collectMutationPaths(operations));
				const summary = await applyResolvedPatch(operations, ctx.cwd);
				return {
					content: [{ type: "text" as const, text: formatSummary(summary) }],
					details: summary,
				};
			} catch (error) {
				throw new Error(errorMessage(error));
			}
		},
		renderResult(result, _options, theme) {
			const summary = (result as { details?: ApplyPatchSummary }).details;
			if (!summary?.diffs?.length) {
				return new Text("", 0, 0);
			}
			const parts: string[] = [];
			for (const fileDiff of summary.diffs) {
				if (fileDiff.diff) {
					const header = theme.fg("toolTitle", fileDiff.filePath);
					parts.push(`${header}\n${renderColoredDiff(fileDiff.diff, theme)}`);
				}
			}
			return new Text(parts.length > 0 ? `\n${parts.join("\n\n")}` : "", 0, 0);
		},
	};
}

export const __test__ = {
	parsePatch,
	seekSequence,
	derivePatchedContent,
	rewriteInputToOperations: (cwd: string, input: string): readonly ResolvedPatchOperation[] =>
		resolveOperations(cwd, parsePatch(input).hunks),
	applyResolvedPatch,
	formatSummary,
};
