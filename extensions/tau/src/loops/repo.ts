import * as path from "node:path";

import { Effect, FileSystem, Layer, Option, Context } from "effect";

import { StorageError, atomicWriteFileString, toStorageError } from "../shared/atomic-write.js";
import {
	decodeLoopPersistedStateJsonWithMigration,
	encodeLoopPersistedStateJson,
	type LoopPersistedState,
} from "./schema.js";
import { LoopContractValidationError } from "./errors.js";
import {
	LOOPS_DIR,
	LOOPS_ARCHIVE_STATE_DIR,
	LOOPS_ARCHIVE_TASKS_DIR,
	LOOPS_STATE_DIR,
	LOOPS_TASKS_DIR,
	loopStateFile,
	loopTaskFile,
} from "./paths.js";
import { resolveLoopWorkspacePath, resolveLoopWorkspaceRoot } from "./workspace-root.js";

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

function withFileContext(
	cwd: string,
	filePath: string,
	error: LoopContractValidationError,
): LoopContractValidationError {
	const relativePath = path.relative(resolveLoopWorkspaceRoot(cwd), filePath);
	const displayPath = relativePath.length > 0 ? relativePath : filePath;
	return new LoopContractValidationError({
		entity: error.entity,
		reason: `${displayPath}: ${error.reason}`,
	});
}

function loopsRoot(cwd: string): string {
	return resolveLoopWorkspacePath(cwd, LOOPS_DIR);
}

function resolveTaskPath(cwd: string, taskId: string, archived = false): string {
	return resolveLoopWorkspacePath(cwd, loopTaskFile(taskId, archived));
}

function resolveStatePath(cwd: string, taskId: string, archived = false): string {
	return resolveLoopWorkspacePath(cwd, loopStateFile(taskId, archived));
}

const readOptionalFile = (
	fs: FileSystem.FileSystem,
	filePath: string,
): Effect.Effect<Option.Option<string>, StorageError, never> =>
	fs.readFileString(filePath).pipe(
		Effect.map((content) => Option.some(content)),
		Effect.catchIf(isNotFound, () => Effect.succeed(Option.none())),
		Effect.mapError((error) => toStorageError("read-file", filePath, `Failed to read ${filePath}`, error)),
	);
const renameIfExists = (
	fs: FileSystem.FileSystem,
	sourcePath: string,
	destinationPath: string,
): Effect.Effect<void, StorageError, never> =>
	Effect.gen(function* () {
		const exists = yield* fs.exists(sourcePath).pipe(
			Effect.mapError((error) => toStorageError("exists-path", sourcePath, `Failed to inspect ${sourcePath}`, error)),
		);
		if (!exists) {
			return yield* Effect.void;
		}
		yield* fs.makeDirectory(path.dirname(destinationPath), { recursive: true }).pipe(
			Effect.mapError((error) =>
				toStorageError(
					"mkdir-parent",
					path.dirname(destinationPath),
					`Failed to create parent directory for ${destinationPath}`,
					error,
				),
			),
		);
		yield* fs.rename(sourcePath, destinationPath).pipe(
			Effect.mapError((error) =>
				toStorageError("rename-path", sourcePath, `Failed to rename ${sourcePath} to ${destinationPath}`, error),
			),
		);
	});

interface LoopRepoService {
	readonly loadState: (
		cwd: string,
		taskId: string,
		archived?: boolean,
	) => Effect.Effect<Option.Option<LoopPersistedState>, LoopContractValidationError | StorageError, never>;
	readonly saveState: (
		cwd: string,
		state: LoopPersistedState,
		archived?: boolean,
	) => Effect.Effect<void, LoopContractValidationError | StorageError, never>;
	readonly listStates: (
		cwd: string,
		archived?: boolean,
	) => Effect.Effect<ReadonlyArray<LoopPersistedState>, LoopContractValidationError | StorageError, never>;
	readonly readTaskFile: (
		cwd: string,
		taskId: string,
		archived?: boolean,
	) => Effect.Effect<Option.Option<string>, StorageError, never>;
	readonly writeTaskFile: (
		cwd: string,
		taskId: string,
		content: string,
		archived?: boolean,
	) => Effect.Effect<void, StorageError, never>;
	readonly ensureTaskFile: (
		cwd: string,
		taskId: string,
		content: string,
	) => Effect.Effect<boolean, StorageError, never>;
	readonly deleteState: (cwd: string, taskId: string, archived?: boolean) => Effect.Effect<void, StorageError, never>;
	readonly deleteTaskFile: (
		cwd: string,
		taskId: string,
		archived?: boolean,
	) => Effect.Effect<void, StorageError, never>;
	readonly archiveTaskArtifacts: (cwd: string, taskId: string) => Effect.Effect<void, StorageError, never>;
	readonly existsLoopsDirectory: (cwd: string) => Effect.Effect<boolean, StorageError, never>;
	readonly removeLoopsDirectory: (cwd: string) => Effect.Effect<void, StorageError, never>;
}

export class LoopRepo extends Context.Service<LoopRepo, LoopRepoService>()("LoopRepo") {}

export const LoopRepoLive = Layer.effect(
	LoopRepo,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		const ensureLayout = (cwd: string): Effect.Effect<void, StorageError, never> =>
			Effect.gen(function* () {
				yield* fs
					.makeDirectory(resolveLoopWorkspacePath(cwd, LOOPS_TASKS_DIR), { recursive: true })
					.pipe(
						Effect.mapError((error) =>
							toStorageError("mkdir-loops-tasks", resolveLoopWorkspacePath(cwd, LOOPS_TASKS_DIR), `Failed to create ${LOOPS_TASKS_DIR}`, error),
						),
					);
				yield* fs
					.makeDirectory(resolveLoopWorkspacePath(cwd, LOOPS_STATE_DIR), { recursive: true })
					.pipe(
						Effect.mapError((error) =>
							toStorageError("mkdir-loops-state", resolveLoopWorkspacePath(cwd, LOOPS_STATE_DIR), `Failed to create ${LOOPS_STATE_DIR}`, error),
						),
					);
				yield* fs
					.makeDirectory(resolveLoopWorkspacePath(cwd, LOOPS_ARCHIVE_TASKS_DIR), { recursive: true })
					.pipe(
						Effect.mapError((error) =>
							toStorageError("mkdir-loops-archive-tasks", resolveLoopWorkspacePath(cwd, LOOPS_ARCHIVE_TASKS_DIR), `Failed to create ${LOOPS_ARCHIVE_TASKS_DIR}`, error),
						),
					);
				yield* fs
					.makeDirectory(resolveLoopWorkspacePath(cwd, LOOPS_ARCHIVE_STATE_DIR), { recursive: true })
					.pipe(
						Effect.mapError((error) =>
							toStorageError("mkdir-loops-archive-state", resolveLoopWorkspacePath(cwd, LOOPS_ARCHIVE_STATE_DIR), `Failed to create ${LOOPS_ARCHIVE_STATE_DIR}`, error),
						),
					);
			});

		const loadState: LoopRepoService["loadState"] = Effect.fn("LoopRepo.loadState")(
			function* (cwd, taskId, archived = false) {
				const filePath = resolveStatePath(cwd, taskId, archived);
				const contentOption = yield* readOptionalFile(fs, filePath);
				if (Option.isNone(contentOption)) {
					return Option.none();
				}
				const decoded = yield* decodeLoopPersistedStateJsonWithMigration(contentOption.value).pipe(
					Effect.mapError((error) => withFileContext(cwd, filePath, error)),
				);
				if (decoded.migrated) {
					const encoded = yield* encodeLoopPersistedStateJson(decoded.state).pipe(
						Effect.mapError((error) => withFileContext(cwd, filePath, error)),
					);
					yield* atomicWriteFileString(fs, filePath, encoded);
				}
				return Option.some(decoded.state);
			},
		);

		const saveState: LoopRepoService["saveState"] = Effect.fn("LoopRepo.saveState")(
			function* (cwd, state, archived = false) {
				yield* ensureLayout(cwd);
				const filePath = resolveStatePath(cwd, state.taskId, archived);
				const encoded = yield* encodeLoopPersistedStateJson(state);
				yield* atomicWriteFileString(fs, filePath, encoded);
			},
		);

		const listStates: LoopRepoService["listStates"] = Effect.fn("LoopRepo.listStates")(
			function* (cwd, archived = false) {
				const dir = resolveLoopWorkspacePath(cwd, archived ? LOOPS_ARCHIVE_STATE_DIR : LOOPS_STATE_DIR);
				const exists = yield* fs.exists(dir).pipe(
					Effect.mapError((error) => toStorageError("exists-dir", dir, `Failed to inspect ${dir}`, error)),
				);
				if (!exists) {
					return [];
				}

				const entries = yield* fs.readDirectory(dir).pipe(
					Effect.mapError((error) => toStorageError("read-dir", dir, `Failed to read ${dir}`, error)),
				);
				const states: LoopPersistedState[] = [];
				for (const entry of [...entries].sort((left, right) => left.localeCompare(right))) {
					if (!entry.endsWith(".json")) {
						continue;
					}
					const filePath = path.join(dir, entry);
					const contentOption = yield* readOptionalFile(fs, filePath);
					if (Option.isNone(contentOption)) {
						continue;
					}
					const decoded = yield* decodeLoopPersistedStateJsonWithMigration(contentOption.value).pipe(
						Effect.mapError((error) => withFileContext(cwd, filePath, error)),
					);
					if (decoded.migrated) {
						const encoded = yield* encodeLoopPersistedStateJson(decoded.state).pipe(
							Effect.mapError((error) => withFileContext(cwd, filePath, error)),
						);
						yield* atomicWriteFileString(fs, filePath, encoded);
					}
					states.push(decoded.state);
				}

				return states;
			},
		);

		const readTaskFile: LoopRepoService["readTaskFile"] = Effect.fn("LoopRepo.readTaskFile")(
			function* (cwd, taskId, archived = false) {
				return yield* readOptionalFile(fs, resolveTaskPath(cwd, taskId, archived));
			},
		);

		const writeTaskFile: LoopRepoService["writeTaskFile"] = Effect.fn("LoopRepo.writeTaskFile")(
			function* (cwd, taskId, content, archived = false) {
				yield* ensureLayout(cwd);
				yield* atomicWriteFileString(fs, resolveTaskPath(cwd, taskId, archived), content);
			},
		);

		const ensureTaskFile: LoopRepoService["ensureTaskFile"] = Effect.fn("LoopRepo.ensureTaskFile")(
			function* (cwd, taskId, content) {
				yield* ensureLayout(cwd);
				const taskPath = resolveTaskPath(cwd, taskId, false);
				const exists = yield* fs.exists(taskPath).pipe(
					Effect.mapError((error) => toStorageError("exists-task", taskPath, `Failed to inspect ${taskPath}`, error)),
				);
				if (exists) {
					return false;
				}
				yield* atomicWriteFileString(fs, taskPath, content);
				return true;
			},
		);

		const deleteState: LoopRepoService["deleteState"] = Effect.fn("LoopRepo.deleteState")(
			function* (cwd, taskId, archived = false) {
				yield* fs.remove(resolveStatePath(cwd, taskId, archived), { force: true }).pipe(
					Effect.mapError((error) =>
						toStorageError(
							"remove-state",
							resolveStatePath(cwd, taskId, archived),
							`Failed to remove ${resolveStatePath(cwd, taskId, archived)}`,
							error,
						),
					),
				);
			},
		);

		const deleteTaskFile: LoopRepoService["deleteTaskFile"] = Effect.fn("LoopRepo.deleteTaskFile")(
			function* (cwd, taskId, archived = false) {
				yield* fs.remove(resolveTaskPath(cwd, taskId, archived), { force: true }).pipe(
					Effect.mapError((error) =>
						toStorageError(
							"remove-task",
							resolveTaskPath(cwd, taskId, archived),
							`Failed to remove ${resolveTaskPath(cwd, taskId, archived)}`,
							error,
						),
					),
				);
			},
		);

		const archiveTaskArtifacts: LoopRepoService["archiveTaskArtifacts"] = Effect.fn(
			"LoopRepo.archiveTaskArtifacts",
		)(function* (cwd, taskId) {
			yield* ensureLayout(cwd);

			yield* renameIfExists(
				fs,
				resolveTaskPath(cwd, taskId, false),
				resolveTaskPath(cwd, taskId, true),
			);
		});

		const existsLoopsDirectory: LoopRepoService["existsLoopsDirectory"] = Effect.fn(
			"LoopRepo.existsLoopsDirectory",
		)(function* (cwd) {
			return yield* fs.exists(loopsRoot(cwd)).pipe(
				Effect.mapError((error) => toStorageError("exists-loops-root", loopsRoot(cwd), `Failed to inspect ${loopsRoot(cwd)}`, error)),
			);
		});

		const removeLoopsDirectory: LoopRepoService["removeLoopsDirectory"] = Effect.fn(
			"LoopRepo.removeLoopsDirectory",
		)(function* (cwd) {
			yield* fs.remove(loopsRoot(cwd), { recursive: true, force: true }).pipe(
				Effect.mapError((error) => toStorageError("remove-loops-root", loopsRoot(cwd), `Failed to remove ${loopsRoot(cwd)}`, error)),
			);
		});

		return LoopRepo.of({
			loadState,
			saveState,
			listStates,
			readTaskFile,
			writeTaskFile,
			ensureTaskFile,
			deleteState,
			deleteTaskFile,
			archiveTaskArtifacts,
			existsLoopsDirectory,
			removeLoopsDirectory,
		});
	}),
);
