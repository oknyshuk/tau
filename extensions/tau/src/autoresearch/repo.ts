import * as path from "node:path";

import { Effect, FileSystem, Layer, Option, Context } from "effect";

import { StorageError, atomicWriteFileString, toStorageError } from "../shared/atomic-write.js";
import {
	AUTORESEARCH_JSONL,
	AUTORESEARCH_MD,
	AUTORESEARCH_SH,
	AUTORESEARCH_CHECKS_SH,
	AUTORESEARCH_IDEAS_MD,
	AUTORESEARCH_CONFIG_JSON,
	AUTORESEARCH_DIR,
} from "./paths.js";

const isPlatformReasonTag = (error: unknown, tag: string): boolean => {
	if (typeof error !== "object" || error === null) {
		return false;
	}
	if (!("_tag" in error) || error._tag !== "PlatformError") {
		return false;
	}
	if (!("reason" in error) || typeof error.reason !== "object" || error.reason === null) {
		return false;
	}
	return "_tag" in error.reason && error.reason._tag === tag;
};

const isNotFound = (error: unknown): boolean => isPlatformReasonTag(error, "NotFound");

const readOptionalFile = (
	fs: FileSystem.FileSystem,
	filePath: string,
): Effect.Effect<Option.Option<string>, StorageError, never> =>
	fs.readFileString(filePath).pipe(
		Effect.map((content) => Option.some(content)),
		Effect.catchIf(isNotFound, () => Effect.succeed(Option.none())),
		Effect.mapError((error) => toStorageError("read-file", filePath, `Failed to read ${filePath}`, error)),
	);

const atomicAppendFileString = (
	fs: FileSystem.FileSystem,
	filePath: string,
	content: string,
): Effect.Effect<void, StorageError, never> =>
	Effect.gen(function* () {
		const exists = yield* fs.exists(filePath).pipe(
			Effect.mapError((error) => toStorageError("exists-file", filePath, `Failed to inspect ${filePath}`, error)),
		);
		if (!exists) {
			yield* atomicWriteFileString(fs, filePath, content);
			return;
		}
		const existing = yield* fs.readFileString(filePath).pipe(
			Effect.mapError((error) => toStorageError("read-file", filePath, `Failed to read ${filePath}`, error)),
		);
		yield* atomicWriteFileString(fs, filePath, `${existing}${content}`);
	});

interface AutoresearchRepoService {
	readonly readJsonl: (workDir: string) => Effect.Effect<Option.Option<string>, StorageError, never>;
	readonly writeJsonl: (workDir: string, content: string) => Effect.Effect<void, StorageError, never>;
	readonly appendJsonlLine: (workDir: string, line: string) => Effect.Effect<void, StorageError, never>;
	readonly readAutoresearchMd: (workDir: string) => Effect.Effect<Option.Option<string>, StorageError, never>;
	readonly readAutoresearchSh: (workDir: string) => Effect.Effect<Option.Option<string>, StorageError, never>;
	readonly readAutoresearchChecksSh: (workDir: string) => Effect.Effect<Option.Option<string>, StorageError, never>;
	readonly readAutoresearchIdeasMd: (workDir: string) => Effect.Effect<Option.Option<string>, StorageError, never>;
	readonly writeAutoresearchIdeasMd: (workDir: string, content: string) => Effect.Effect<void, StorageError, never>;
	readonly readConfigJson: (cwd: string) => Effect.Effect<Option.Option<string>, StorageError, never>;
	readonly readRunJson: (runDirectory: string) => Effect.Effect<Option.Option<string>, StorageError, never>;
	readonly writeRunJson: (runDirectory: string, content: string) => Effect.Effect<void, StorageError, never>;
	readonly ensureAutoresearchDir: (workDir: string) => Effect.Effect<void, StorageError, never>;
	readonly listRunDirectories: (workDir: string) => Effect.Effect<ReadonlyArray<string>, StorageError, never>;
	readonly readBenchmarkLog: (runDirectory: string) => Effect.Effect<Option.Option<string>, StorageError, never>;
	readonly readChecksLog: (runDirectory: string) => Effect.Effect<Option.Option<string>, StorageError, never>;
}

export class AutoresearchRepo extends Context.Service<AutoresearchRepo, AutoresearchRepoService>()(
	"AutoresearchRepo",
) {}

export const AutoresearchRepoLive = Layer.effect(
	AutoresearchRepo,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		const readJsonl: AutoresearchRepoService["readJsonl"] = (workDir) =>
			readOptionalFile(fs, path.join(workDir, AUTORESEARCH_JSONL));

		const writeJsonl: AutoresearchRepoService["writeJsonl"] = (workDir, content) =>
			atomicWriteFileString(fs, path.join(workDir, AUTORESEARCH_JSONL), content);

		const appendJsonlLine: AutoresearchRepoService["appendJsonlLine"] = (workDir, line) =>
			atomicAppendFileString(fs, path.join(workDir, AUTORESEARCH_JSONL), `${line}\n`);

		const readAutoresearchMd: AutoresearchRepoService["readAutoresearchMd"] = (workDir) =>
			readOptionalFile(fs, path.join(workDir, AUTORESEARCH_MD));

		const readAutoresearchSh: AutoresearchRepoService["readAutoresearchSh"] = (workDir) =>
			readOptionalFile(fs, path.join(workDir, AUTORESEARCH_SH));

		const readAutoresearchChecksSh: AutoresearchRepoService["readAutoresearchChecksSh"] = (workDir) =>
			readOptionalFile(fs, path.join(workDir, AUTORESEARCH_CHECKS_SH));

		const readAutoresearchIdeasMd: AutoresearchRepoService["readAutoresearchIdeasMd"] = (workDir) =>
			readOptionalFile(fs, path.join(workDir, AUTORESEARCH_IDEAS_MD));

		const writeAutoresearchIdeasMd: AutoresearchRepoService["writeAutoresearchIdeasMd"] = (workDir, content) =>
			atomicWriteFileString(fs, path.join(workDir, AUTORESEARCH_IDEAS_MD), content);

		const readConfigJson: AutoresearchRepoService["readConfigJson"] = (cwd) =>
			readOptionalFile(fs, path.join(cwd, AUTORESEARCH_CONFIG_JSON));

		const readRunJson: AutoresearchRepoService["readRunJson"] = (runDirectory) =>
			readOptionalFile(fs, path.join(runDirectory, "run.json"));

		const writeRunJson: AutoresearchRepoService["writeRunJson"] = (runDirectory, content) =>
			atomicWriteFileString(fs, path.join(runDirectory, "run.json"), content);

		const ensureAutoresearchDir: AutoresearchRepoService["ensureAutoresearchDir"] = (workDir) =>
			fs.makeDirectory(path.join(workDir, AUTORESEARCH_DIR), { recursive: true }).pipe(
				Effect.mapError((error) =>
					toStorageError(
						"mkdir-autoresearch-dir",
						path.join(workDir, AUTORESEARCH_DIR),
						`Failed to create ${AUTORESEARCH_DIR}`,
						error,
					),
				),
			);

		const listRunDirectories: AutoresearchRepoService["listRunDirectories"] = Effect.fn(
			"AutoresearchRepo.listRunDirectories",
		)(function* (workDir) {
			const runsDir = path.join(workDir, AUTORESEARCH_DIR, "runs");
			const exists = yield* fs.exists(runsDir).pipe(
				Effect.mapError((error) => toStorageError("exists-runs-dir", runsDir, `Failed to inspect ${runsDir}`, error)),
			);
			if (!exists) {
				return [];
			}
			const entries = yield* fs.readDirectory(runsDir).pipe(
				Effect.mapError((error) => toStorageError("read-runs-dir", runsDir, `Failed to read ${runsDir}`, error)),
			);
			return entries
				.filter((name) => /^\d{4}$/.test(name))
				.sort((left, right) => right.localeCompare(left));
		});

		const readBenchmarkLog: AutoresearchRepoService["readBenchmarkLog"] = (runDirectory) =>
			readOptionalFile(fs, path.join(runDirectory, "benchmark.log"));

		const readChecksLog: AutoresearchRepoService["readChecksLog"] = (runDirectory) =>
			readOptionalFile(fs, path.join(runDirectory, "checks.log"));

		return AutoresearchRepo.of({
			readJsonl,
			writeJsonl,
			appendJsonlLine,
			readAutoresearchMd,
			readAutoresearchSh,
			readAutoresearchChecksSh,
			readAutoresearchIdeasMd,
			writeAutoresearchIdeasMd,
			readConfigJson,
			readRunJson,
			writeRunJson,
			ensureAutoresearchDir,
			listRunDirectories,
			readBenchmarkLog,
			readChecksLog,
		});
	}),
);
