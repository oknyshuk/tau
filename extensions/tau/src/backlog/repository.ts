import path from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { FileSystem, Effect, Layer } from "effect";

import {
	decodeBacklogEvent,
	replayBacklogEventsEffect,
	resolveBacklogPaths,
	sortBacklogEvents,
	type BacklogEvent,
} from "./contract.js";
import {
	BacklogCacheError,
	BacklogContractValidationError,
	BacklogDependencyCycleError,
	BacklogLockError,
	BacklogStorageError,
} from "./errors.js";
import { assertNoDependencyCyclesEffect } from "./graph.js";
import {
	decodeIssue,
	encodeIssue,
	type EncodedIssue,
	type Issue,
} from "./schema.js";
import { BacklogConfig, BacklogRepository } from "./services.js";
import {
	acquireSharedFileLockScoped,
	describeSharedFileLockError,
	SharedFileLockCorrupt,
	SharedFileLockHeld,
	SharedFileLockIoError,
	SharedFileLockTimeout,
	type SharedFileLockConfig,
} from "../shared/lock.js";

const BACKLOG_LOCK_STALE_MS = 10_000;
const BACKLOG_LOCK_MAX_ATTEMPTS = 50;
const BACKLOG_LOCK_RETRY_MS = 100;

const backlogLockConfig: SharedFileLockConfig = {
	staleMs: BACKLOG_LOCK_STALE_MS,
	retryDelayMs: BACKLOG_LOCK_RETRY_MS,
	maxAttempts: BACKLOG_LOCK_MAX_ATTEMPTS,
	heldPolicy: "wait",
};

const toStorageError = (
	operation: string,
	targetPath: string,
	reason: string,
	cause: unknown,
): BacklogStorageError =>
	new BacklogStorageError({
		operation,
		path: targetPath,
		reason,
		cause,
	});

const toCacheError = (
	operation: string,
	targetPath: string,
	reason: string,
	cause: unknown,
): BacklogCacheError =>
	new BacklogCacheError({
		operation,
		path: targetPath,
		reason,
		cause,
	});

const toLockError = (
	lockPath: string,
	reason: string,
	reclaimAttempted: boolean,
	cause: unknown,
): BacklogLockError =>
	new BacklogLockError({
		lockPath,
		reason,
		reclaimAttempted,
		cause,
	});

const toBacklogLockErrorFromShared = (lockPath: string, error: unknown): BacklogLockError => {
	if (error instanceof BacklogLockError) {
		return error;
	}
	if (
		error instanceof SharedFileLockHeld ||
		error instanceof SharedFileLockCorrupt ||
		error instanceof SharedFileLockTimeout ||
		error instanceof SharedFileLockIoError
	) {
		const reclaimAttempted =
			error instanceof SharedFileLockCorrupt ||
			error instanceof SharedFileLockTimeout ||
			error instanceof SharedFileLockIoError
				? error.reclaimAttempted
				: false;
		return toLockError(lockPath, describeSharedFileLockError(error), reclaimAttempted, error);
	}
	return toLockError(lockPath, String(error), false, error);
};

const writeEventFileUnchecked = (
	fs: FileSystem.FileSystem,
	eventsRoot: string,
	cacheRoot: string,
	event: BacklogEvent,
): Effect.Effect<void, BacklogStorageError, never> =>
	Effect.gen(function* () {
		const finalPath = eventFilePath(eventsRoot, event);
		const tempPath = path.join(cacheRoot, `.event-tmp-${safeFileToken(event.event_id)}-${process.pid}-${Date.now()}`);

		yield* fs.makeDirectory(path.dirname(finalPath), { recursive: true }).pipe(
			Effect.mapError((error) =>
				toStorageError("mkdir-events", finalPath, `Failed to create event directory for ${finalPath}`, error),
			),
		);
		yield* fs.makeDirectory(cacheRoot, { recursive: true }).pipe(
			Effect.mapError((error) =>
				toStorageError("mkdir-cache", cacheRoot, "Failed to create cache directory", error),
			),
		);
		yield* fs.writeFileString(tempPath, `${JSON.stringify(event)}\n`, { flag: "wx" }).pipe(
			Effect.mapError((error) =>
				toStorageError("write-temp-event", tempPath, `Failed to write temp event ${tempPath}`, error),
			),
		);

		yield* fs.rename(tempPath, finalPath).pipe(
			Effect.mapError((error) =>
				toStorageError(
					"rename-event",
					finalPath,
					`Failed to move event from temp file ${tempPath} to ${finalPath}`,
					error,
				),
			),
		);
	});

const datePathFromRecordedAt = (recordedAt: string): string => recordedAt.slice(0, 10).split("-").join(path.sep);

const safeFileToken = (value: string): string => value.replace(/[^A-Za-z0-9._-]/gu, "_");

const eventFilePath = (
	eventsRoot: string,
	event: Pick<BacklogEvent, "recorded_at" | "event_id">,
): string => path.join(eventsRoot, datePathFromRecordedAt(event.recorded_at), `${safeFileToken(event.event_id)}.json`);

const lockPathFor = (cacheRoot: string): string => path.join(cacheRoot, ".lock");

const listFilesRecursive = (
	fs: FileSystem.FileSystem,
	rootDir: string,
): Effect.Effect<ReadonlyArray<string>, BacklogStorageError, never> =>
	Effect.gen(function* () {
		const exists = yield* fs.exists(rootDir).pipe(
			Effect.mapError((error) =>
				toStorageError("exists-events-dir", rootDir, `Failed to inspect event directory ${rootDir}`, error),
			),
		);
		if (!exists) {
			return [];
		}

		const entries = yield* fs.readDirectory(rootDir).pipe(
			Effect.mapError((error) =>
				toStorageError("list-events", rootDir, `Failed to read directory ${rootDir}`, error),
			),
		);

		const files: string[] = [];
		for (const name of [...entries].sort((a, b) => a.localeCompare(b))) {
			const absolutePath = path.join(rootDir, name);
			const info = yield* fs.stat(absolutePath).pipe(
				Effect.mapError((error) =>
					toStorageError("stat-event-entry", absolutePath, `Failed to stat ${absolutePath}`, error),
				),
			);

			if (info.type === "Directory") {
				const nested = yield* listFilesRecursive(fs, absolutePath);
				files.push(...nested);
				continue;
			}

			if (info.type === "File") {
				files.push(absolutePath);
			}
		}

		return files;
	});

const parseMaterializedIssues = (
	raw: string,
): Effect.Effect<ReadonlyArray<Issue>, BacklogCacheError | BacklogContractValidationError, never> =>
	Effect.gen(function* () {
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			return [];
		}

		const parsed: Issue[] = [];
		for (const [index, line] of trimmed.split(/\n+/u).entries()) {
			const value = yield* Effect.try({
				try: () => JSON.parse(line) as unknown,
				catch: (error) =>
					toCacheError(
						"parse-materialized-cache-json",
						".pi/backlog/cache/issues.jsonl",
						`Invalid JSONL cache entry at line ${index + 1}`,
						error,
					),
			});
			parsed.push(yield* decodeIssue(value));
		}

		return parsed;
	});

const serializeMaterializedIssues = (
	issues: ReadonlyArray<Issue>,
): Effect.Effect<string, BacklogContractValidationError, never> =>
	Effect.gen(function* () {
		if (issues.length === 0) {
			return "";
		}

		const encoded: EncodedIssue[] = [];
		for (const issue of issues) {
			encoded.push(yield* encodeIssue(issue));
		}
		return `${encoded.map((issue) => JSON.stringify(issue)).join("\n")}\n`;
	});

export const BacklogConfigLive = (workspaceRoot: string) => {
	const paths = resolveBacklogPaths(workspaceRoot);
	return Layer.succeed(
		BacklogConfig,
		BacklogConfig.of({
			workspaceRoot,
			eventsRoot: paths.canonicalEventsDir,
			cacheRoot: paths.materializedCacheDir,
			issuesCachePath: paths.materializedIssuesPath,
		}),
	);
};

export const BacklogRepositoryLive = Layer.effect(
	BacklogRepository,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const config = yield* BacklogConfig;
		const lockPath = lockPathFor(config.cacheRoot);

		const readEvents = (): Effect.Effect<
			ReadonlyArray<BacklogEvent>,
			BacklogStorageError | BacklogContractValidationError,
			never
		> =>
			Effect.gen(function* () {
				const filePaths = yield* listFilesRecursive(fs, config.eventsRoot);

				const events: BacklogEvent[] = [];
				for (const filePath of filePaths) {
					const raw = yield* fs.readFileString(filePath).pipe(
						Effect.mapError((error) =>
							toStorageError("read-event", filePath, `Failed to read backlog event file ${filePath}`, error),
						),
					);
					const parsed = yield* Effect.try({
						try: () => JSON.parse(raw) as unknown,
						catch: (error) =>
							toStorageError("parse-event-json", filePath, `Invalid JSON in backlog event file ${filePath}`, error),
					});
					events.push(yield* decodeBacklogEvent(parsed));
				}

				return sortBacklogEvents(events);
			});

		const validateMaterializedState = (
			events: ReadonlyArray<BacklogEvent>,
		): Effect.Effect<void, BacklogContractValidationError | BacklogDependencyCycleError, never> =>
			Effect.gen(function* () {
				const replayed = yield* replayBacklogEventsEffect(events);
				const issues: Issue[] = [];
				for (const issue of replayed.values()) {
					issues.push(yield* decodeIssue(issue.fields));
				}
				yield* assertNoDependencyCyclesEffect(issues);
			});

		const appendEvent = (
			event: BacklogEvent,
		): Effect.Effect<
			void,
			BacklogStorageError | BacklogContractValidationError | BacklogDependencyCycleError,
			never
		> =>
			Effect.gen(function* () {
				const existing = yield* readEvents();
				yield* validateMaterializedState([...existing, event]);
				yield* writeEventFileUnchecked(fs, config.eventsRoot, config.cacheRoot, event);
			});

		const writeMaterializedIssues = (
			issues: ReadonlyArray<Issue>,
		): Effect.Effect<void, BacklogCacheError | BacklogContractValidationError, never> =>
			Effect.gen(function* () {
				yield* fs.makeDirectory(config.cacheRoot, { recursive: true }).pipe(
					Effect.mapError((error) =>
						toCacheError("mkdir-cache", config.cacheRoot, `Failed to create cache directory`, error),
					),
				);
				const serialized = yield* serializeMaterializedIssues(issues);
				const tempPath = `${config.issuesCachePath}.tmp-${process.pid}-${Date.now()}`;
				yield* fs.writeFileString(tempPath, serialized).pipe(
					Effect.mapError((error) =>
						toCacheError("write-cache-temp", tempPath, `Failed to write temporary cache`, error),
					),
				);
				yield* fs.rename(tempPath, config.issuesCachePath).pipe(
					Effect.mapError((error) =>
						toCacheError("rename-cache", config.issuesCachePath, `Failed to commit cache`, error),
					),
				);
			});

		const rebuildMaterializedIssues = (): Effect.Effect<
			ReadonlyArray<Issue>,
			BacklogStorageError | BacklogCacheError | BacklogContractValidationError | BacklogDependencyCycleError,
			never
		> =>
			Effect.gen(function* () {
				const events = yield* readEvents();
				const replayed = yield* replayBacklogEventsEffect(events);
				const issues: Issue[] = [];
				for (const issue of replayed.values()) {
					issues.push(yield* decodeIssue(issue.fields));
				}
				yield* assertNoDependencyCyclesEffect(issues);
				yield* writeMaterializedIssues(issues);
				return issues;
			});

		const readMaterializedIssues = (): Effect.Effect<
			ReadonlyArray<Issue>,
			BacklogCacheError | BacklogContractValidationError | BacklogStorageError | BacklogDependencyCycleError,
			never
		> =>
			Effect.gen(function* () {
				const exists = yield* fs.exists(config.issuesCachePath).pipe(
					Effect.mapError((error) =>
						toCacheError(
							"exists-materialized-cache",
							config.issuesCachePath,
							`Failed to inspect materialized cache ${config.issuesCachePath}`,
							error,
						),
					),
				);
				if (!exists) {
					return yield* rebuildMaterializedIssues();
				}

				const raw = yield* fs.readFileString(config.issuesCachePath).pipe(
					Effect.mapError((error) =>
						toCacheError(
							"read-materialized-cache",
							config.issuesCachePath,
							`Failed to read materialized cache ${config.issuesCachePath}`,
							error,
						),
					),
				);
				return yield* parseMaterializedIssues(raw);
			});

		const withWriteLock = <A, E>(
			effect: Effect.Effect<A, E, never>,
		): Effect.Effect<A, E | BacklogLockError, never> =>
			Effect.scoped(
				Effect.gen(function* () {
					yield* fs.makeDirectory(config.cacheRoot, { recursive: true }).pipe(
						Effect.mapError((error) =>
							toLockError(lockPath, `Failed to create lock directory ${config.cacheRoot}`, false, error),
						),
					);

					yield* acquireSharedFileLockScoped(lockPath, backlogLockConfig).pipe(
						Effect.mapError((error) => toBacklogLockErrorFromShared(lockPath, error)),
					);

					return yield* effect;
				}),
			);

		return BacklogRepository.of({
			readEvents,
			appendEvent,
			readMaterializedIssues,
			writeMaterializedIssues,
			rebuildMaterializedIssues,
			withWriteLock,
		});
	}),
);

export const BacklogInfrastructureLive = (workspaceRoot: string) =>
	BacklogRepositoryLive.pipe(
		Layer.provide(BacklogConfigLive(workspaceRoot)),
		Layer.provide(NodeFileSystem.layer),
	);
