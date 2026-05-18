import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Data, Effect } from "effect";
import { atomicWriteFileStringSync } from "./atomic-write.js";
import { isRecord, type AnyRecord } from "./json.js";

type JsonFileReadResult =
	| { readonly _tag: "missing" }
	| { readonly _tag: "invalid"; readonly reason: string }
	| { readonly _tag: "ok"; readonly data: AnyRecord };

export class JsonFileError extends Data.TaggedError("JsonFileError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export function parseJsonObject(
	raw: string,
	filePath: string,
): Effect.Effect<AnyRecord, JsonFileError> {
	return Effect.try({
		try: () => JSON.parse(raw) as unknown,
		catch: (cause) =>
			new JsonFileError({
				message: `Invalid JSON in ${filePath}`,
				cause,
			}),
	}).pipe(
		Effect.flatMap((json) =>
			isRecord(json)
				? Effect.succeed(json)
				: Effect.fail(
						new JsonFileError({
							message: `Invalid JSON in ${filePath}: top-level JSON value must be an object`,
						}),
					),
		),
	);
}

export function readJsonFileDetailed(filePath: string): JsonFileReadResult {
	if (!fs.existsSync(filePath)) {
		return { _tag: "missing" };
	}

	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const json: unknown = JSON.parse(raw);
		if (!isRecord(json)) {
			return { _tag: "invalid", reason: "top-level JSON value must be an object" };
		}
		return { _tag: "ok", data: json };
	} catch (error) {
		return {
			_tag: "invalid",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export function readJsonFile(filePath: string): AnyRecord | null {
	const result = readJsonFileDetailed(filePath);
	return result._tag === "ok" ? result.data : null;
}

export function readJsonObjectFileEffect(
	filePath: string,
): Effect.Effect<AnyRecord | null, JsonFileError> {
	return Effect.tryPromise({
		try: () => fsPromises.readFile(filePath, "utf-8"),
		catch: (cause) => cause,
	}).pipe(
		Effect.flatMap((raw) => parseJsonObject(raw, filePath)),
		Effect.catchIf(
			(cause) =>
				typeof cause === "object" &&
				cause !== null &&
				"code" in cause &&
				cause.code === "ENOENT",
			() => Effect.succeed(null),
		),
		Effect.mapError((cause) =>
			cause instanceof JsonFileError
				? cause
				: new JsonFileError({
						message: `Failed to read JSON file ${filePath}`,
						cause,
					}),
		),
	);
}

export function readJsonObjectFileOrThrow(filePath: string): AnyRecord {
	const result = readJsonFileDetailed(filePath);
	if (result._tag === "missing") {
		throw new Error(`Missing JSON file at ${filePath}`);
	}
	if (result._tag === "ok") return result.data;
	throw new Error(`Invalid JSON at ${filePath}: ${result.reason}`);
}

export function writeJsonFile(filePath: string, obj: unknown): void {
	atomicWriteFileStringSync(filePath, JSON.stringify(obj, null, 2) + "\n");
}

export function safeRealpath(targetPath: string): string {
	const absolute = path.isAbsolute(targetPath) ? targetPath : path.resolve(targetPath);
	try {
		return fs.realpathSync(absolute);
	} catch (error) {
		const parent = path.dirname(absolute);
		const filename = path.basename(absolute);
		try {
			return path.join(fs.realpathSync(parent), filename);
		} catch (parentError) {
			console.warn(
				`safeRealpath: failed to resolve ${absolute} via parent ${parent}:`,
				parentError,
			);
			return absolute;
		}
	}
}

export function isPathInsideRoot(targetPath: string, root: string): boolean {
	const resolved = safeRealpath(targetPath);
	const resolvedRoot = safeRealpath(root);
	const normalizedTarget = path.normalize(resolved);
	const normalizedRoot = path.normalize(resolvedRoot);

	return (
		normalizedTarget === normalizedRoot ||
		normalizedTarget.startsWith(normalizedRoot + path.sep)
	);
}

export function collectTempRoots(): readonly string[] {
	const tempRoots = new Set<string>();

	const addPath = (candidate: string) => {
		tempRoots.add(candidate);
		try {
			tempRoots.add(fs.realpathSync(candidate));
		} catch (error) {
			console.warn(`collectTempRoots: ignoring inaccessible temp root ${candidate}:`, error);
		}
	};

	addPath("/tmp");
	addPath(os.tmpdir());

	const envTmpDir = process.env["TMPDIR"];
	if (envTmpDir) {
		addPath(envTmpDir);
	}

	return Array.from(tempRoots);
}
