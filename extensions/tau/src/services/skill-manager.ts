import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effect, Layer, Context } from "effect";
import * as Diff from "diff";

import { getHomeDir } from "../shared/home.js";

import {
	SkillAlreadyExists,
	SkillFileError,
	SkillInvalidContent,
	SkillInvalidName,
	SkillNotFound,
	SkillPatchFailed,
	SkillSecurityViolation,
	type SkillMutationError,
} from "../skill-manage/errors.js";
import {
	checkInjectionPatterns,
	validateFilePath,
	validateFrontmatter,
	validateName,
} from "../skill-manage/validation.js";
import { EXTENSION_ROOT, findNearestWorkspaceRoot } from "../shared/discovery.js";

export interface SkillCreateResult {
	readonly name: string;
	readonly path: string;
	readonly category?: string;
}

export interface SkillEditResult {
	readonly name: string;
	readonly path: string;
}

export interface SkillPatchResult {
	readonly name: string;
	readonly replacements: number;
	readonly filePath: string;
	readonly diff: string;
}

export interface SkillDeleteResult {
	readonly name: string;
}

export interface SkillWriteFileResult {
	readonly name: string;
	readonly filePath: string;
}

export interface SkillRemoveFileResult {
	readonly name: string;
	readonly filePath: string;
}

interface SkillManagerService {
	readonly create: (
		name: string,
		content: string,
		category?: string,
		cwd?: string,
	) => Effect.Effect<SkillCreateResult, SkillMutationError>;
	readonly edit: (
		name: string,
		content: string,
		cwd?: string,
	) => Effect.Effect<SkillEditResult, SkillMutationError>;
	readonly patch: (
		name: string,
		oldString: string,
		newString: string,
		filePath?: string,
		replaceAll?: boolean,
		cwd?: string,
	) => Effect.Effect<SkillPatchResult, SkillMutationError>;
	readonly remove: (
		name: string,
		cwd?: string,
	) => Effect.Effect<SkillDeleteResult, SkillMutationError>;
	readonly writeFile: (
		name: string,
		filePath: string,
		fileContent: string,
		cwd?: string,
	) => Effect.Effect<SkillWriteFileResult, SkillMutationError>;
	readonly removeFile: (
		name: string,
		filePath: string,
		cwd?: string,
	) => Effect.Effect<SkillRemoveFileResult, SkillMutationError>;
}

interface SkillMatch {
	readonly path: string;
	readonly root: string;
}

function getSkillsDir(): string {
	const override = process.env["TAU_SKILLS_DIR"];
	if (override) {
		return override;
	}
	return path.join(getHomeDir(), ".pi", "agent", "skills");
}

function getLegacySkillsDir(): string {
	return path.join(getHomeDir(), ".agents", "skills");
}

function getTauSkillsDir(): string {
	return path.join(EXTENSION_ROOT, "skills");
}

function pushUniquePath(paths: string[], candidate: string): void {
	const normalized = path.resolve(candidate);
	if (!paths.includes(normalized)) {
		paths.push(normalized);
	}
}

function getAncestorAgentsSkillDirs(cwd: string, stopAt: string): ReadonlyArray<string> {
	const roots: string[] = [];
	const resolvedCwd = path.resolve(cwd);
	const resolvedStopAt = path.resolve(stopAt);
	let current = resolvedCwd;
	for (;;) {
		pushUniquePath(roots, path.join(current, ".agents", "skills"));
		if (current === resolvedStopAt) {
			break;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return roots;
}

function getSkillRoots(cwd: string): ReadonlyArray<string> {
	const roots: string[] = [];
	const resolvedCwd = path.resolve(cwd);
	const workspaceRoot = findNearestWorkspaceRoot(resolvedCwd);

	pushUniquePath(roots, path.join(resolvedCwd, ".pi", "skills"));
	pushUniquePath(roots, path.join(workspaceRoot, ".pi", "skills"));
	pushUniquePath(roots, path.join(resolvedCwd, "skills"));
	pushUniquePath(roots, path.join(workspaceRoot, "skills"));
	for (const root of getAncestorAgentsSkillDirs(resolvedCwd, workspaceRoot)) {
		pushUniquePath(roots, root);
	}
	if (resolvedCwd === EXTENSION_ROOT || resolvedCwd.startsWith(`${EXTENSION_ROOT}${path.sep}`)) {
		pushUniquePath(roots, getTauSkillsDir());
	}
	pushUniquePath(roots, getSkillsDir());
	pushUniquePath(roots, getLegacySkillsDir());

	return roots;
}

function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function fileError(reason: string, error: unknown): SkillFileError {
	return new SkillFileError({ reason: `${reason}: ${String(error)}` });
}

const requireWorkspaceCwd = Effect.fn("SkillManager.requireWorkspaceCwd")(function* (
	cwd: string | undefined,
) {
	if (typeof cwd !== "string" || cwd.length === 0) {
		return yield* Effect.fail(new SkillFileError({ reason: "cwd is required" }));
	}
	return cwd;
});

function resolveChildPath(root: string, childPath: string): string | undefined {
	const resolved = path.resolve(root, childPath);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		return undefined;
	}
	return resolved;
}

function normalizeCategory(category: string | undefined): string | undefined {
	const normalized = category?.trim();
	if (normalized === undefined || normalized.length === 0) {
		return undefined;
	}
	return normalized;
}

function validateCategory(category: string): string | undefined {
	if (category.includes("..") || category.includes("/") || category.includes("\\")) {
		return "category must be a single directory name.";
	}
	return undefined;
}

function countOccurrences(content: string, oldString: string): number {
	if (oldString.length === 0) {
		return 0;
	}
	return content.split(oldString).length - 1;
}

function generateDiffString(oldContent: string, newContent: string, contextLines = 4): string {
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
		if (part === undefined) {
			continue;
		}

		const rawLines = part.value.split("\n");
		if (rawLines[rawLines.length - 1] === "") {
			rawLines.pop();
		}

		if (part.added || part.removed) {
			for (const line of rawLines) {
				if (part.added === true) {
					output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
					newLineNum += 1;
					continue;
				}
				output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
				oldLineNum += 1;
			}
			lastWasChange = true;
			continue;
		}

		const nextPart = parts[i + 1];
		const nextPartIsChange = nextPart?.added === true || nextPart?.removed === true;

		if (lastWasChange || nextPartIsChange) {
			let linesToShow = rawLines;
			let skipStart = 0;
			let skipEnd = 0;

			if (!lastWasChange) {
				skipStart = Math.max(0, rawLines.length - contextLines);
				linesToShow = rawLines.slice(skipStart);
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
				oldLineNum += 1;
				newLineNum += 1;
			}

			if (skipEnd > 0) {
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += skipEnd;
				newLineNum += skipEnd;
			}
		} else {
			oldLineNum += rawLines.length;
			newLineNum += rawLines.length;
		}

		lastWasChange = false;
	}

	return output.join("\n");
}

async function findSkillDirs(dir: string): Promise<string[]> {
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error, "ENOENT")) {
			return [];
		}
		throw error;
	}

	entries.sort((left, right) => left.name.localeCompare(right.name));

	const childResults = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => findSkillDirs(path.join(dir, entry.name))),
	);

	const skillDirs = entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")
		? [dir]
		: [];
	return [...skillDirs, ...childResults.flat()];
}

async function cleanupEmptyDirectories(startDir: string, stopDir: string): Promise<void> {
	let currentDir = startDir;

	while (currentDir !== stopDir) {
		let entries: string[];
		try {
			entries = await fs.readdir(currentDir);
		} catch (error) {
			if (isNodeError(error, "ENOENT")) {
				return;
			}
			throw error;
		}

		if (entries.length > 0) {
			return;
		}

		try {
			await fs.rmdir(currentDir);
		} catch (error) {
			if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTEMPTY")) {
				return;
			}
			throw error;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) {
			return;
		}
		currentDir = parentDir;
	}
}

const tryFile = <A>(reason: string, thunk: () => Promise<A>): Effect.Effect<A, SkillFileError> =>
	Effect.tryPromise({
		try: thunk,
		catch: (error) => fileError(reason, error),
	});

const cleanupTempFile = Effect.fn("SkillManager.cleanupTempFile")(function* (tempPath: string) {
	yield* Effect.tryPromise({
		try: () => fs.unlink(tempPath),
		catch: (error) => error,
	}).pipe(
		Effect.catch((error: unknown) =>
			isNodeError(error, "ENOENT")
				? Effect.void
				: Effect.fail(
						fileError(`failed to remove temporary skill file ${tempPath}`, error),
					),
		),
	);
});

const atomicWrite = Effect.fn("SkillManager.atomicWrite")(function* (
	destinationPath: string,
	content: string,
) {
	yield* tryFile(`failed to create directory ${path.dirname(destinationPath)}`, () =>
		fs.mkdir(path.dirname(destinationPath), { recursive: true }),
	);

	const tempPath = path.join(
		path.dirname(destinationPath),
		`.skill_${crypto.randomBytes(6).toString("hex")}.tmp`,
	);

	yield* tryFile(`failed to write temporary skill file ${tempPath}`, () =>
		fs.writeFile(tempPath, content, "utf8"),
	).pipe(
		Effect.flatMap(() =>
			tryFile(`failed to replace ${destinationPath}`, () =>
				fs.rename(tempPath, destinationPath),
			),
		),
		Effect.catch((error: SkillFileError) =>
			cleanupTempFile(tempPath).pipe(
				Effect.catch(() => Effect.void),
				Effect.andThen(Effect.fail(error)),
			),
		),
	);
});

const findSkill = Effect.fn("SkillManager.findSkill")(function* (name: string, cwd?: string) {
	const resolvedCwd = yield* requireWorkspaceCwd(cwd);
	for (const root of getSkillRoots(resolvedCwd)) {
		const skillDirs = yield* tryFile(`failed to scan skills directory ${root}`, () =>
			findSkillDirs(root),
		);
		const skillPath = skillDirs.find((candidate) => path.basename(candidate) === name);
		if (skillPath !== undefined) {
			return { path: skillPath, root } satisfies SkillMatch;
		}
	}
	return undefined;
});

const findSkillOrFail = Effect.fn("SkillManager.findSkillOrFail")(function* (
	name: string,
	cwd?: string,
) {
	const skill = yield* findSkill(name, cwd);
	if (skill === undefined) {
		return yield* Effect.fail(new SkillNotFound({ name }));
	}
	return skill;
});

const ensureValidName = Effect.fn("SkillManager.ensureValidName")(function* (name: string) {
	const reason = validateName(name);
	if (reason !== undefined) {
		return yield* Effect.fail(new SkillInvalidName({ name, reason }));
	}
	return name;
});

const ensureValidContent = Effect.fn("SkillManager.ensureValidContent")(function* (
	content: string,
) {
	const reason = validateFrontmatter(content);
	if (reason !== undefined) {
		return yield* Effect.fail(new SkillInvalidContent({ reason }));
	}
	return content;
});

const ensureValidFilePath = Effect.fn("SkillManager.ensureValidFilePath")(function* (
	filePath: string,
) {
	const reason = validateFilePath(filePath);
	if (reason !== undefined) {
		return yield* Effect.fail(new SkillInvalidContent({ reason }));
	}
	return filePath;
});

const ensureNoInjectionPatterns = Effect.fn("SkillManager.ensureNoInjectionPatterns")(function* (
	content: string,
) {
	const pattern = checkInjectionPatterns(content);
	if (pattern !== undefined) {
		return yield* Effect.fail(
			new SkillSecurityViolation({
				reason: `content contains disallowed prompt injection pattern: ${pattern}`,
			}),
		);
	}
	return content;
});

const ensureValidCategory = Effect.fn("SkillManager.ensureValidCategory")(function* (
	category: string | undefined,
) {
	const normalized = normalizeCategory(category);
	if (normalized === undefined) {
		return undefined;
	}

	const reason = validateCategory(normalized);
	if (reason !== undefined) {
		return yield* Effect.fail(new SkillInvalidContent({ reason }));
	}

	return normalized;
});

const resolveSkillFileTarget = Effect.fn("SkillManager.resolveSkillFileTarget")(function* (
	skillPath: string,
	filePath: string,
) {
	const resolved = resolveChildPath(skillPath, filePath);
	if (resolved === undefined) {
		return yield* Effect.fail(
			new SkillInvalidContent({ reason: "file_path must stay within the skill directory." }),
		);
	}
	return resolved;
});

export class SkillManager extends Context.Service<SkillManager, SkillManagerService>()(
	"SkillManager",
) {}

export const SkillManagerLive = Layer.effect(
	SkillManager,
	Effect.gen(function* () {
		yield* Effect.void;

		const create: SkillManagerService["create"] = Effect.fn("SkillManager.create")(function* (
			name: string,
			content: string,
			category?: string,
			cwd?: string,
		) {
			const resolvedCwd = yield* requireWorkspaceCwd(cwd);
			yield* ensureValidName(name);
			yield* ensureValidContent(content);
			yield* ensureNoInjectionPatterns(content);
			const normalizedCategory = yield* ensureValidCategory(category);

			const existingSkill = yield* findSkill(name, resolvedCwd);
			if (existingSkill !== undefined) {
				return yield* Effect.fail(
					new SkillAlreadyExists({ name, path: existingSkill.path }),
				);
			}

			const baseDir =
				normalizedCategory === undefined
					? getSkillsDir()
					: path.join(getSkillsDir(), normalizedCategory);
			const skillPath = resolveChildPath(baseDir, name);
			if (skillPath === undefined) {
				return yield* Effect.fail(
					new SkillInvalidContent({
						reason: "skill path must stay within the skills directory.",
					}),
				);
			}

			yield* atomicWrite(path.join(skillPath, "SKILL.md"), content);

			const result: SkillCreateResult =
				normalizedCategory === undefined
					? { name, path: skillPath }
					: { name, path: skillPath, category: normalizedCategory };
			return result;
		});

		const edit: SkillManagerService["edit"] = Effect.fn("SkillManager.edit")(function* (
			name: string,
			content: string,
			cwd?: string,
		) {
			const resolvedCwd = yield* requireWorkspaceCwd(cwd);
			const skill = yield* findSkillOrFail(name, resolvedCwd);
			yield* ensureValidContent(content);
			yield* ensureNoInjectionPatterns(content);
			yield* atomicWrite(path.join(skill.path, "SKILL.md"), content);
			return { name, path: skill.path } satisfies SkillEditResult;
		});

		const patch: SkillManagerService["patch"] = Effect.fn("SkillManager.patch")(function* (
			name: string,
			oldString: string,
			newString: string,
			filePath?: string,
			replaceAll?: boolean,
			cwd?: string,
		) {
			const resolvedCwd = yield* requireWorkspaceCwd(cwd);
			if (oldString.length === 0) {
				return yield* Effect.fail(
					new SkillPatchFailed({ reason: "old_string must not be empty" }),
				);
			}

			const skill = yield* findSkillOrFail(name, resolvedCwd);
			if (filePath !== undefined) {
				yield* ensureValidFilePath(filePath);
			}

			const targetPath =
				filePath === undefined
					? path.join(skill.path, "SKILL.md")
					: yield* resolveSkillFileTarget(skill.path, filePath);
			const currentContent = yield* tryFile(`failed to read ${targetPath}`, () =>
				fs.readFile(targetPath, "utf8"),
			);

			const replacements = countOccurrences(currentContent, oldString);
			if (replacements === 0) {
				return yield* Effect.fail(new SkillPatchFailed({ reason: "old_string not found" }));
			}
			if (replacements > 1 && replaceAll !== true) {
				return yield* Effect.fail(
					new SkillPatchFailed({
						reason: `matched ${replacements} times, provide more context or set replaceAll`,
					}),
				);
			}

			const nextContent =
				replaceAll === true
					? currentContent.split(oldString).join(newString)
					: currentContent.replace(oldString, newString);
			const diff = generateDiffString(currentContent, nextContent);

			yield* ensureNoInjectionPatterns(nextContent);
			if (filePath === undefined) {
				yield* ensureValidContent(nextContent);
			}

			yield* atomicWrite(targetPath, nextContent);
			return {
				name,
				replacements: replaceAll === true ? replacements : 1,
				filePath: filePath ?? "SKILL.md",
				diff,
			} satisfies SkillPatchResult;
		});

		const remove: SkillManagerService["remove"] = Effect.fn("SkillManager.remove")(function* (
			name: string,
			cwd?: string,
		) {
			const resolvedCwd = yield* requireWorkspaceCwd(cwd);
			const skill = yield* findSkillOrFail(name, resolvedCwd);
			yield* tryFile(`failed to remove skill ${skill.path}`, () =>
				fs.rm(skill.path, { recursive: true }),
			);
			yield* tryFile(`failed to clean up empty directories for ${skill.path}`, () =>
				cleanupEmptyDirectories(path.dirname(skill.path), skill.root),
			);
			return { name } satisfies SkillDeleteResult;
		});

		const writeFile: SkillManagerService["writeFile"] = Effect.fn("SkillManager.writeFile")(
			function* (name: string, filePath: string, fileContent: string, cwd?: string) {
				const resolvedCwd = yield* requireWorkspaceCwd(cwd);
				yield* ensureValidFilePath(filePath);
				const skill = yield* findSkillOrFail(name, resolvedCwd);
				yield* ensureNoInjectionPatterns(fileContent);
				const targetPath = yield* resolveSkillFileTarget(skill.path, filePath);
				yield* atomicWrite(targetPath, fileContent);
				return { name, filePath } satisfies SkillWriteFileResult;
			},
		);

		const removeFile: SkillManagerService["removeFile"] = Effect.fn("SkillManager.removeFile")(
			function* (name: string, filePath: string, cwd?: string) {
				const resolvedCwd = yield* requireWorkspaceCwd(cwd);
				yield* ensureValidFilePath(filePath);
				const skill = yield* findSkillOrFail(name, resolvedCwd);
				const targetPath = yield* resolveSkillFileTarget(skill.path, filePath);

				yield* Effect.tryPromise({
					try: () => fs.stat(targetPath),
					catch: (error) => error,
				}).pipe(
					Effect.catch((error: unknown) =>
						isNodeError(error, "ENOENT")
							? Effect.fail(
									new SkillFileError({ reason: `file not found: ${filePath}` }),
								)
							: Effect.fail(fileError(`failed to inspect ${targetPath}`, error)),
					),
				);

				yield* tryFile(`failed to remove file ${targetPath}`, () => fs.unlink(targetPath));
				yield* tryFile(`failed to clean up empty directories for ${targetPath}`, () =>
					cleanupEmptyDirectories(path.dirname(targetPath), skill.path),
				);
				return { name, filePath } satisfies SkillRemoveFileResult;
			},
		);

		return SkillManager.of({
			create,
			edit,
			patch,
			remove,
			writeFile,
			removeFile,
		});
	}),
);
