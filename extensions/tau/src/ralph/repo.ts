import * as fs from "node:fs";
import * as path from "node:path";

import { Effect, FileSystem, Layer, Option, Context } from "effect";

import { StorageError, atomicWriteFileString, toStorageError } from "../shared/atomic-write.js";
import { nowIso } from "../shared/clock.js";
import { LoopContractValidationError } from "../loops/errors.js";
import { loopTaskFile } from "../loops/paths.js";
import { LoopRepo, LoopRepoLive } from "../loops/repo.js";
import type {
	LoopPersistedState,
	LoopSessionRef,
	RalphLoopPersistedState,
} from "../loops/schema.js";
import {
	RALPH_ARCHIVE_STATE_DIR,
	RALPH_ARCHIVE_TASKS_DIR,
	RALPH_DIR,
	RALPH_STATE_DIR,
	RALPH_TASKS_DIR,
} from "./paths.js";
import { RalphContractValidationError } from "./errors.js";
import type { LoopState } from "./schema.js";
import { emptyRalphLoopMetrics } from "./schema.js";
import { isRecord } from "../shared/json.js";

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

const optionContains = (option: Option.Option<string>, value: string | undefined): boolean => {
	if (value === undefined) {
		return false;
	}
	return Option.match(option, {
		onNone: () => false,
		onSome: (optionValue) => optionValue === value,
	});
};


const LEGACY_LAYOUT_MESSAGE =
	"Legacy Ralph layout detected under .pi/ralph. Import or remove old flat files, then retry.";


function isSafeRawTaskDirectoryName(taskId: string): boolean {
	return taskId.length > 0 && taskId !== "." && taskId !== "..";
}

function rawRalphTaskId(value: unknown, expectedTaskId: string): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const kind = value["kind"];
	const previousKind = value["previousKind"];
	if (!(kind === "ralph" || (kind === "blocked_manual_resolution" && previousKind === "ralph"))) {
		return undefined;
	}
	const taskId = value["taskId"];
	return taskId === expectedTaskId ? expectedTaskId : undefined;
}

interface RawRalphStateFile {
	readonly taskId: string;
	readonly safeForDirectoryDeletion: boolean;
}

function toContractError(entity: string, reason: string): RalphContractValidationError {
	return new RalphContractValidationError({
		entity,
		reason,
	});
}

function mapLoopRepoError(
	error: LoopContractValidationError | StorageError,
): RalphContractValidationError | StorageError {
	if (error instanceof StorageError) {
		return error;
	}
	return toContractError(error.entity, error.reason);
}

function makeLegacyLayoutError(): RalphContractValidationError {
	return toContractError("ralph.legacy_layout", LEGACY_LAYOUT_MESSAGE);
}

async function hasFlatFilesInDir(dir: string): Promise<boolean> {
	try {
		const entries = await fs.promises.readdir(dir);
		for (const entry of entries) {
			if (entry.endsWith(".state.json") || entry.endsWith(".md")) {
				return true;
			}
		}
	} catch {
		// Directory does not exist.
	}
	return false;
}

const detectLegacyLayout = (cwd: string): Effect.Effect<boolean, never, never> =>
	Effect.promise(async () => {
		const root = path.resolve(cwd, ".pi", "ralph");
		const archive = path.join(root, "archive");
		return (await hasFlatFilesInDir(root)) || (await hasFlatFilesInDir(archive));
	});

function lifecycleToStatus(lifecycle: LoopPersistedState["lifecycle"]): LoopState["status"] {
	switch (lifecycle) {
		case "active":
			return "active";
		case "paused":
		case "draft":
			return "paused";
		case "completed":
		case "archived":
			return "completed";
	}
}

function statusToLifecycle(status: LoopState["status"]): RalphLoopPersistedState["lifecycle"] {
	switch (status) {
		case "active":
			return "active";
		case "paused":
			return "paused";
		case "completed":
			return "completed";
	}
}

function ownershipFile(option: Option.Option<LoopSessionRef>): Option.Option<string> {
	return Option.map(option, (session) => session.sessionFile);
}

function normalizeSessionRef(
	existing: Option.Option<LoopSessionRef>,
	sessionFile: Option.Option<string>,
): Option.Option<LoopSessionRef> {
	return Option.match(sessionFile, {
		onNone: () => Option.none(),
		onSome: (file) =>
			Option.match(existing, {
				onNone: () =>
					Option.some({
						sessionId: file,
						sessionFile: file,
					}),
				onSome: (current) =>
					current.sessionFile === file
						? Option.some(current)
						: Option.some({
								sessionId: file,
								sessionFile: file,
							}),
			}),
	});
}

function toLoopState(state: RalphLoopPersistedState): LoopState {
	return {
		name: state.taskId,
		taskFile: state.taskFile,
		iteration: state.ralph.iteration,
		maxIterations: state.ralph.maxIterations,
		itemsPerIteration: state.ralph.itemsPerIteration,
		reflectEvery: state.ralph.reflectEvery,
		reflectInstructions: state.ralph.reflectInstructions,
		status: lifecycleToStatus(state.lifecycle),
		executionProfile: state.ralph.pinnedExecutionProfile,
		startedAt: Option.getOrElse(state.startedAt, () => state.createdAt),
		lastReflectionAt: state.ralph.lastReflectionAt,
		completedAt: state.completedAt,
		controllerSessionFile: ownershipFile(state.ownership.controller),
		activeIterationSessionFile: ownershipFile(state.ownership.child),
		pendingDecision: state.ralph.pendingDecision,
		sandboxProfile: state.ralph.sandboxProfile,
		metrics: state.ralph.metrics,
		capabilityContract: state.ralph.capabilityContract,
		deferredConfigMutations: state.ralph.deferredConfigMutations,
	};
}

function ensureRalphState(
	state: LoopPersistedState,
	entity: string,
): Effect.Effect<RalphLoopPersistedState, RalphContractValidationError, never> {
	if (state.kind === "ralph") {
		return Effect.succeed(state);
	}
	return Effect.fail(
		toContractError(entity, `task "${state.taskId}" is kind "${state.kind}", expected "ralph"`),
	);
}

export function loopOwnsSessionFile(loop: LoopState, sessionFile: string | undefined): boolean {
	return (
		optionContains(loop.controllerSessionFile, sessionFile) ||
		optionContains(loop.activeIterationSessionFile, sessionFile)
	);
}

function ralphDir(cwd: string): string {
	return path.resolve(cwd, RALPH_DIR);
}

function legacyRalphDir(cwd: string): string {
	return path.resolve(cwd, ".pi", "ralph");
}

const readOptionalFile = (
	fs: FileSystem.FileSystem,
	filePath: string,
): Effect.Effect<Option.Option<string>, StorageError, never> =>
	fs.readFileString(filePath).pipe(
		Effect.map((content) => Option.some(content)),
		Effect.catchIf(isNotFound, () => Effect.succeed(Option.none())),
		Effect.mapError((error) =>
			toStorageError("read-file", filePath, `Failed to read ${filePath}`, error),
		),
	);

function toPersistedState(
	state: LoopState,
	existing: Option.Option<RalphLoopPersistedState>,
	archived: boolean,
	timestamp: string,
): RalphLoopPersistedState {
	const existingValue = Option.getOrUndefined(existing);
	const lifecycle = archived
		? "archived"
		: existingValue?.lifecycle === "draft" && state.status === "paused"
			? "draft"
			: statusToLifecycle(state.status);

	return {
		taskId: state.name,
		title: existingValue?.title ?? state.name,
		taskFile: state.taskFile,
		kind: "ralph",
		lifecycle,
		createdAt: existingValue?.createdAt ?? state.startedAt,
		updatedAt: timestamp,
		startedAt: Option.some(state.startedAt),
		completedAt: state.completedAt,
		archivedAt:
			lifecycle === "archived"
				? Option.some(timestamp)
				: (existingValue?.archivedAt ?? Option.none()),
		ownership: {
			controller: normalizeSessionRef(
				existingValue?.ownership.controller ?? Option.none(),
				state.controllerSessionFile,
			),
			child: normalizeSessionRef(
				existingValue?.ownership.child ?? Option.none(),
				state.activeIterationSessionFile,
			),
		},
		ralph: {
			iteration: state.iteration,
			maxIterations: state.maxIterations,
			itemsPerIteration: state.itemsPerIteration,
			reflectEvery: state.reflectEvery,
			reflectInstructions: state.reflectInstructions,
			lastReflectionAt: state.lastReflectionAt,
			pendingDecision: state.pendingDecision,
			pinnedExecutionProfile: state.executionProfile,
			sandboxProfile: state.sandboxProfile,
			metrics: state.metrics ?? existingValue?.ralph.metrics ?? emptyRalphLoopMetrics(),
			capabilityContract: state.capabilityContract,
			deferredConfigMutations: state.deferredConfigMutations,
		},
	};
}

export interface RalphRepoService {
	readonly loadState: (
		cwd: string,
		name: string,
		archived?: boolean,
	) => Effect.Effect<
		Option.Option<LoopState>,
		RalphContractValidationError | StorageError,
		never
	>;
	readonly saveState: (
		cwd: string,
		state: LoopState,
		archived?: boolean,
	) => Effect.Effect<void, RalphContractValidationError | StorageError, never>;
	readonly listLoops: (
		cwd: string,
		archived?: boolean,
	) => Effect.Effect<
		ReadonlyArray<LoopState>,
		RalphContractValidationError | StorageError,
		never
	>;
	readonly findLoopBySessionFile: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<
		Option.Option<LoopState>,
		RalphContractValidationError | StorageError,
		never
	>;
	readonly readTaskFile: (
		cwd: string,
		taskFile: string,
	) => Effect.Effect<Option.Option<string>, StorageError, never>;
	readonly writeTaskFile: (
		cwd: string,
		taskFile: string,
		content: string,
	) => Effect.Effect<void, StorageError, never>;
	readonly ensureTaskFile: (
		cwd: string,
		taskFile: string,
		content: string,
	) => Effect.Effect<boolean, StorageError, never>;
	readonly deleteState: (
		cwd: string,
		name: string,
		archived?: boolean,
	) => Effect.Effect<void, StorageError, never>;
	readonly deleteTaskByLoopName: (
		cwd: string,
		name: string,
		archived?: boolean,
	) => Effect.Effect<void, StorageError, never>;
	readonly archiveLoop: (
		cwd: string,
		state: LoopState,
	) => Effect.Effect<void, RalphContractValidationError | StorageError, never>;
	readonly existsRalphDirectory: (cwd: string) => Effect.Effect<boolean, StorageError, never>;
	readonly removeRalphDirectory: (
		cwd: string,
	) => Effect.Effect<void, RalphContractValidationError | StorageError, never>;
}

export class RalphRepo extends Context.Service<RalphRepo, RalphRepoService>()("RalphRepo") {}

const RalphRepoBase = Layer.effect(
	RalphRepo,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const loopRepo = yield* LoopRepo;

		const loadState: RalphRepoService["loadState"] = Effect.fn("RalphRepo.loadState")(
			function* (cwd, name, archived = false) {
				if (yield* detectLegacyLayout(cwd)) {
					return yield* Effect.fail(makeLegacyLayoutError());
				}
				const persisted = yield* loopRepo
					.loadState(cwd, name, archived)
					.pipe(Effect.mapError(mapLoopRepoError));
				if (Option.isNone(persisted)) {
					return Option.none();
				}
				const ralphState = yield* ensureRalphState(persisted.value, "ralph.loop_state");
				return Option.some(toLoopState(ralphState));
			},
		);

		const saveState: RalphRepoService["saveState"] = Effect.fn("RalphRepo.saveState")(
			function* (cwd, state, archived = false) {
				const existing = yield* loopRepo
					.loadState(cwd, state.name, archived)
					.pipe(Effect.mapError(mapLoopRepoError));
				const existingRalph = Option.isSome(existing)
					? Option.some(yield* ensureRalphState(existing.value, "ralph.loop_state"))
					: Option.none<RalphLoopPersistedState>();
				const timestamp = yield* nowIso;
				const nextState = toPersistedState(state, existingRalph, archived, timestamp);
				yield* loopRepo
					.saveState(cwd, nextState, archived)
					.pipe(Effect.mapError(mapLoopRepoError));
			},
		);

		const listLoops: RalphRepoService["listLoops"] = Effect.fn("RalphRepo.listLoops")(
			function* (cwd, archived = false) {
				if (yield* detectLegacyLayout(cwd)) {
					return yield* Effect.fail(makeLegacyLayoutError());
				}
				const persisted = yield* loopRepo
					.listStates(cwd, archived)
					.pipe(Effect.mapError(mapLoopRepoError));
				const loops: LoopState[] = [];
				for (const state of persisted) {
					if (state.kind !== "ralph") {
						continue;
					}
					loops.push(toLoopState(state));
				}
				return loops;
			},
		);

		const findLoopBySessionFile: RalphRepoService["findLoopBySessionFile"] = Effect.fn(
			"RalphRepo.findLoopBySessionFile",
		)(function* (cwd, sessionFile) {
			if (sessionFile === undefined) {
				return Option.none();
			}

			const loops = yield* listLoops(cwd, false);
			const candidates = loops.filter(
				(loop) => loop.status !== "completed" && loopOwnsSessionFile(loop, sessionFile),
			);
			if (candidates.length === 0) {
				return Option.none();
			}

			const active = candidates.filter((loop) => loop.status === "active");
			if (active.length === 1) {
				const onlyActive = active[0];
				return onlyActive === undefined ? Option.none() : Option.some(onlyActive);
			}

			const paused = candidates.filter((loop) => loop.status === "paused");
			if (active.length === 0 && paused.length === 1) {
				const onlyPaused = paused[0];
				return onlyPaused === undefined ? Option.none() : Option.some(onlyPaused);
			}

			return Option.none();
		});

		const readTaskFile: RalphRepoService["readTaskFile"] = Effect.fn("RalphRepo.readTaskFile")(
			function* (cwd, taskFile) {
				return yield* readOptionalFile(fs, path.resolve(cwd, taskFile));
			},
		);

		const writeTaskFile: RalphRepoService["writeTaskFile"] = Effect.fn(
			"RalphRepo.writeTaskFile",
		)(function* (cwd, taskFile, content) {
			yield* atomicWriteFileString(fs, path.resolve(cwd, taskFile), content);
		});

		const ensureTaskFile: RalphRepoService["ensureTaskFile"] = Effect.fn(
			"RalphRepo.ensureTaskFile",
		)(function* (cwd, taskFile, content) {
			const target = path.resolve(cwd, taskFile);
			const exists = yield* fs
				.exists(target)
				.pipe(
					Effect.mapError((error) =>
						toStorageError("exists-task", target, `Failed to inspect ${target}`, error),
					),
				);
			if (exists) {
				return false;
			}
			yield* atomicWriteFileString(fs, target, content);
			return true;
		});

		const deleteState: RalphRepoService["deleteState"] = Effect.fn("RalphRepo.deleteState")(
			function* (cwd, name, archived = false) {
				yield* loopRepo.deleteState(cwd, name, archived);
			},
		);

		const deleteTaskByLoopName: RalphRepoService["deleteTaskByLoopName"] = Effect.fn(
			"RalphRepo.deleteTaskByLoopName",
		)(function* (cwd, name, archived = false) {
			yield* loopRepo.deleteTaskFile(cwd, name, archived);
		});

		const archiveLoop: RalphRepoService["archiveLoop"] = Effect.fn("RalphRepo.archiveLoop")(
			function* (cwd, state) {
				const persisted = yield* loopRepo
					.loadState(cwd, state.name, false)
					.pipe(Effect.mapError(mapLoopRepoError));
				if (Option.isNone(persisted) || persisted.value.kind !== "ralph") {
					return yield* Effect.void;
				}

				const timestamp = yield* nowIso;
				const archivedState: RalphLoopPersistedState = {
					...persisted.value,
					taskFile: path.join(RALPH_ARCHIVE_TASKS_DIR, `${persisted.value.taskId}.md`),
					lifecycle: "archived",
					updatedAt: timestamp,
					archivedAt: Option.some(timestamp),
					ownership: {
						controller: Option.none(),
						child: Option.none(),
					},
					ralph: {
						...persisted.value.ralph,
						pendingDecision: Option.none(),
					},
				};

				const canonicalTaskFile = loopTaskFile(persisted.value.taskId);
				if (path.normalize(persisted.value.taskFile) !== path.normalize(canonicalTaskFile)) {
					const taskContent = yield* readOptionalFile(
						fs,
						path.resolve(cwd, persisted.value.taskFile),
					);
					if (Option.isSome(taskContent)) {
						yield* loopRepo
							.writeTaskFile(cwd, persisted.value.taskId, taskContent.value)
							.pipe(Effect.mapError(mapLoopRepoError));
					}
				}

				yield* loopRepo.archiveTaskArtifacts(cwd, persisted.value.taskId);
				if (path.normalize(persisted.value.taskFile) !== path.normalize(canonicalTaskFile)) {
					const activeTasksRoot = path.resolve(cwd, RALPH_TASKS_DIR);
					const sourceTaskFile = path.resolve(cwd, persisted.value.taskFile);
					if (sourceTaskFile.startsWith(`${activeTasksRoot}${path.sep}`)) {
						yield* fs.remove(sourceTaskFile, { force: true }).pipe(
							Effect.mapError((error) =>
								toStorageError(
									"remove-task",
									sourceTaskFile,
									`Failed to remove ${sourceTaskFile}`,
									error,
								),
							),
						);
					}
				}
				yield* loopRepo
					.saveState(cwd, archivedState, true)
					.pipe(Effect.mapError(mapLoopRepoError));
				yield* loopRepo.deleteState(cwd, persisted.value.taskId, false);
			},
		);

		const existsRalphDirectory: RalphRepoService["existsRalphDirectory"] = Effect.fn(
			"RalphRepo.existsRalphDirectory",
		)(function* (cwd) {
			const canonicalExists = yield* fs
				.exists(ralphDir(cwd))
				.pipe(
					Effect.mapError((error) =>
						toStorageError(
							"exists-ralph-dir",
							ralphDir(cwd),
							`Failed to inspect ${ralphDir(cwd)}`,
							error,
						),
					),
				);
			if (canonicalExists) {
				return true;
			}
			return yield* fs
				.exists(legacyRalphDir(cwd))
				.pipe(
					Effect.mapError((error) =>
						toStorageError(
							"exists-legacy-ralph-dir",
							legacyRalphDir(cwd),
							`Failed to inspect ${legacyRalphDir(cwd)}`,
							error,
						),
					),
				);
		});

		const removeRalphDirectory: RalphRepoService["removeRalphDirectory"] = Effect.fn(
			"RalphRepo.removeRalphDirectory",
		)(function* (cwd) {
			const readRawRalphStateFiles = Effect.fn("RalphRepo.readRawRalphStateFiles")(function* (
				stateDirectory: string,
			) {
				const absoluteStateDirectory = path.resolve(cwd, stateDirectory);
				const exists = yield* fs
					.exists(absoluteStateDirectory)
					.pipe(
						Effect.mapError((error) =>
							toStorageError(
								"exists-ralph-state-dir",
								absoluteStateDirectory,
								`Failed to inspect ${absoluteStateDirectory}`,
								error,
							),
						),
					);
				if (!exists) {
					return [];
				}

				const entries = yield* fs
					.readDirectory(absoluteStateDirectory)
					.pipe(
						Effect.mapError((error) =>
							toStorageError(
								"read-ralph-state-dir",
								absoluteStateDirectory,
								`Failed to read ${absoluteStateDirectory}`,
								error,
							),
						),
					);

				const stateFiles: RawRalphStateFile[] = [];
				for (const entry of [...entries].sort((left, right) => left.localeCompare(right))) {
					if (!entry.endsWith(".json")) {
						continue;
					}
					const expectedTaskId = entry.slice(0, -".json".length);
					const filePath = path.join(absoluteStateDirectory, entry);
					const content = yield* readOptionalFile(fs, filePath);
					if (Option.isNone(content)) {
						continue;
					}

					let parsed: unknown;
					try {
						parsed = JSON.parse(content.value) as unknown;
					} catch {
						continue;
					}

					const taskId = rawRalphTaskId(parsed, expectedTaskId);
					if (taskId !== undefined) {
						stateFiles.push({
							taskId,
							safeForDirectoryDeletion: isSafeRawTaskDirectoryName(taskId),
						});
					}
				}

				return stateFiles;
			});

			const activeStateFiles = yield* readRawRalphStateFiles(RALPH_STATE_DIR);
			for (const stateFile of activeStateFiles) {
				yield* loopRepo.deleteState(cwd, stateFile.taskId, false);
				yield* loopRepo.deleteTaskFile(cwd, stateFile.taskId, false);
				if (stateFile.safeForDirectoryDeletion) {
					yield* loopRepo.deletePhaseDirectory(cwd, stateFile.taskId, false);
					yield* loopRepo.deleteRunDirectory(cwd, stateFile.taskId, false);
				}
			}

			const archivedStateFiles = yield* readRawRalphStateFiles(RALPH_ARCHIVE_STATE_DIR);
			for (const stateFile of archivedStateFiles) {
				yield* loopRepo.deleteState(cwd, stateFile.taskId, true);
				yield* loopRepo.deleteTaskFile(cwd, stateFile.taskId, true);
				if (stateFile.safeForDirectoryDeletion) {
					yield* loopRepo.deletePhaseDirectory(cwd, stateFile.taskId, true);
					yield* loopRepo.deleteRunDirectory(cwd, stateFile.taskId, true);
				}
			}

			yield* fs
				.remove(legacyRalphDir(cwd), {
					recursive: true,
					force: true,
				})
				.pipe(
					Effect.mapError((error) =>
						toStorageError(
							"remove-ralph-dir",
							legacyRalphDir(cwd),
							`Failed to remove ${legacyRalphDir(cwd)}`,
							error,
						),
					),
				);
		});

		return RalphRepo.of({
			loadState,
			saveState,
			listLoops,
			findLoopBySessionFile,
			readTaskFile,
			writeTaskFile,
			ensureTaskFile,
			deleteState,
			deleteTaskByLoopName,
			archiveLoop,
			existsRalphDirectory,
			removeRalphDirectory,
		});
	}),
);

export const RalphRepoLive = RalphRepoBase.pipe(Layer.provideMerge(LoopRepoLive));
