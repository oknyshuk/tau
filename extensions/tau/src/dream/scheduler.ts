import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Dirent, Stats } from "node:fs";

import { Clock, Effect, Layer, Option, Ref, Schema, Context } from "effect";

import type { DreamConfig } from "./config.js";
import type {
	DreamAutoPermit,
	DreamRunRequest,
	DreamRunResult,
	DreamTranscriptCandidate,
} from "./domain.js";
import {
	DreamDisabled,
	DreamLockCorrupt,
	DreamLockHeld,
	DreamLockIoError,
	DreamNotEnoughSessions,
	DreamSessionScanThrottled,
	DreamTooSoon,
	type DreamConfigError,
	type DreamGateError,
	type DreamLockError,
} from "./errors.js";
import { DreamLock, type DreamLockApi } from "./lock.js";
import {
	dreamTranscriptRoot,
	isDreamTranscriptFile,
	parseDreamTranscriptSessionId,
} from "./transcripts.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

const DREAM_STATE_SCHEMA = Schema.Struct({
	lastCompletedAtMs: Schema.Number,
});
type DreamState = typeof DREAM_STATE_SCHEMA.Type;

const decodeDreamState = Schema.decodeUnknownSync(DREAM_STATE_SCHEMA);

export interface DreamSchedulerApi {
	readonly evaluateAutoStart: (
		request: DreamRunRequest,
	) => Effect.Effect<DreamAutoPermit, DreamConfigError | DreamGateError | DreamLockError>;

	readonly markCompleted: (
		cwd: string,
		result: DreamRunResult,
	) => Effect.Effect<void, DreamLockError>;

	readonly readLastCompletedAt: (
		cwd: string,
	) => Effect.Effect<number | null, DreamLockError>;
}

interface DreamSchedulerLiveConfig {
	readonly loadConfig: (cwd: string) => Effect.Effect<DreamConfig, DreamConfigError>;
}

export class DreamScheduler extends Context.Service<DreamScheduler, DreamSchedulerApi>()(
	"DreamScheduler",
) {}

function isNodeError(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === code
	);
}

function errorReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function dreamStatePath(cwd: string): string {
	return path.join(cwd, ".pi", "tau", "dream-state.json");
}

function readDirEntries(dirPath: string): Effect.Effect<ReadonlyArray<Dirent>, DreamLockIoError> {
	return Effect.tryPromise({
		try: () => fs.readdir(dirPath, { withFileTypes: true }),
		catch: (cause) => cause,
	}).pipe(
		Effect.catchIf(
			(cause) => isNodeError(cause, "ENOENT"),
			() => Effect.succeed([] as ReadonlyArray<Dirent>),
		),
		Effect.mapError(
			(cause) =>
				new DreamLockIoError({
					path: dirPath,
					operation: "readdir",
					reason: errorReason(cause),
				}),
		),
	);
}

function collectTranscriptFiles(
	dirPath: string,
): Effect.Effect<ReadonlyArray<string>, DreamLockIoError> {
	return Effect.gen(function* () {
		const entries = yield* readDirEntries(dirPath);
		const files: Array<string> = [];

		for (const entry of entries) {
			const absolutePath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				const nestedFiles = yield* collectTranscriptFiles(absolutePath);
				files.push(...nestedFiles);
				continue;
			}

			if (entry.isFile() && isDreamTranscriptFile(entry.name)) {
				files.push(absolutePath);
			}
		}

		return files;
	});
}

function readFileTouchedAtMs(filePath: string): Effect.Effect<number | null, DreamLockIoError> {
	return Effect.tryPromise({
		try: () => fs.stat(filePath),
		catch: (cause) => cause,
	}).pipe(
		Effect.catchIf(
			(cause) => isNodeError(cause, "ENOENT"),
			() => Effect.succeed<Stats | null>(null),
		),
		Effect.mapError(
			(cause) =>
				new DreamLockIoError({
					path: filePath,
					operation: "stat",
					reason: errorReason(cause),
				}),
		),
		Effect.map((stats) => {
			if (stats === null || !stats.isFile()) {
				return null;
			}

			return Math.trunc(stats.mtimeMs);
		}),
	);
}

function scanTranscriptCandidates(
	cwd: string,
	sinceMs: number,
	currentSessionId: string | undefined,
): Effect.Effect<ReadonlyArray<DreamTranscriptCandidate>, DreamLockIoError> {
	return Effect.gen(function* () {
		const transcriptRoot = dreamTranscriptRoot(cwd);
		const transcriptFiles = yield* collectTranscriptFiles(transcriptRoot);
		const candidates: Array<DreamTranscriptCandidate> = [];

		for (const transcriptPath of transcriptFiles) {
			const touchedAt = yield* readFileTouchedAtMs(transcriptPath);
			if (touchedAt === null || touchedAt <= sinceMs) {
				continue;
			}

			const sessionId = parseDreamTranscriptSessionId(transcriptPath);
			if (sessionId === null) {
				continue;
			}

			if (currentSessionId !== undefined && sessionId === currentSessionId) {
				continue;
			}

			candidates.push({
				sessionId,
				path: transcriptPath,
				touchedAt,
			});
		}

		candidates.sort((a, b) => b.touchedAt - a.touchedAt);
		return candidates;
	});
}

function ensureDreamLockNotHeld(
	lock: DreamLockApi,
	cwd: string,
): Effect.Effect<void, DreamLockError> {
	return lock.inspect(cwd).pipe(
		Effect.flatMap((lockInfo) =>
			Option.isSome(lockInfo)
				? Effect.fail(
						new DreamLockHeld({
							path: lockInfo.value.path,
							...(lockInfo.value.holderPid === undefined
								? {}
								: { holderPid: lockInfo.value.holderPid }),
						}),
					)
				: Effect.void,
		),
	);
}

function readStateFromDisk(cwd: string): Effect.Effect<number | null, DreamLockError> {
	const statePath = dreamStatePath(cwd);

	return Effect.tryPromise({
		try: () => fs.readFile(statePath, "utf8"),
		catch: (cause) => cause,
	}).pipe(
		Effect.catchIf(
			(cause) => isNodeError(cause, "ENOENT"),
			() => Effect.succeed<string | null>(null),
		),
		Effect.mapError(
			(cause) =>
				new DreamLockIoError({
					path: statePath,
					operation: "read",
					reason: errorReason(cause),
				}),
		),
		Effect.flatMap((raw) => {
			if (raw === null) {
				return Effect.succeed<number | null>(null);
			}

			return Effect.try({
				try: () => JSON.parse(raw) as unknown,
				catch: (cause) =>
					new DreamLockCorrupt({
						path: statePath,
						reason: `Invalid JSON: ${errorReason(cause)}`,
					}),
			}).pipe(
				Effect.flatMap((json) =>
					Effect.try({
						try: () => decodeDreamState(json),
						catch: (cause) =>
							new DreamLockCorrupt({
								path: statePath,
								reason: `Invalid state shape: ${errorReason(cause)}`,
							}),
					}),
				),
				Effect.map((state) => state.lastCompletedAtMs),
			);
		}),
	);
}

function writeStateToDisk(cwd: string, state: DreamState): Effect.Effect<void, DreamLockError> {
	const statePath = dreamStatePath(cwd);
	const parentDir = path.dirname(statePath);
	const serialized = `${JSON.stringify(state, null, 2)}\n`;

	const ensureDir = Effect.tryPromise({
		try: () => fs.mkdir(parentDir, { recursive: true }),
		catch: (cause) => cause,
	}).pipe(
		Effect.mapError(
			(cause) =>
				new DreamLockIoError({
					path: parentDir,
					operation: "mkdir",
					reason: errorReason(cause),
				}),
		),
	);

	const writeState = Effect.tryPromise({
		try: () => fs.writeFile(statePath, serialized, "utf8"),
		catch: (cause) => cause,
	}).pipe(
		Effect.mapError(
			(cause) =>
				new DreamLockIoError({
					path: statePath,
					operation: "write",
					reason: errorReason(cause),
				}),
		),
	);

	return Effect.flatMap(ensureDir, () => writeState);
}

export const DreamSchedulerLive = (config: DreamSchedulerLiveConfig) =>
	Layer.effect(
		DreamScheduler,
		Effect.gen(function* () {
			const lastScanAtRef = yield* Ref.make<number | null>(null);
			const lock = yield* DreamLock;

			const readLastCompletedAt: DreamSchedulerApi["readLastCompletedAt"] = Effect.fn(
				"DreamScheduler.readLastCompletedAt",
			)(function* (cwd) {
				return yield* readStateFromDisk(cwd);
			});

			const markCompleted: DreamSchedulerApi["markCompleted"] = Effect.fn(
				"DreamScheduler.markCompleted",
			)(function* (cwd, result) {
				const nextState: DreamState = {
					lastCompletedAtMs: result.finishedAt,
				};
				yield* writeStateToDisk(cwd, nextState);
			});

			const evaluateAutoStart: DreamSchedulerApi["evaluateAutoStart"] = Effect.fn(
				"DreamScheduler.evaluateAutoStart",
			)(function* (request) {
				const dreamConfig = yield* config.loadConfig(request.cwd);
				if (!dreamConfig.enabled || !dreamConfig.auto.enabled) {
					return yield* Effect.fail(new DreamDisabled({ mode: request.mode }));
				}

				const lastCompletedAtMs = yield* readStateFromDisk(request.cwd);
				const nowMs = yield* Clock.currentTimeMillis;

				if (lastCompletedAtMs !== null) {
					const hoursSinceLastRun = (nowMs - lastCompletedAtMs) / HOUR_MS;
					if (hoursSinceLastRun < dreamConfig.auto.minHoursSinceLastRun) {
						return yield* Effect.fail(
							new DreamTooSoon({
								lastCompletedAtMs,
								hoursSinceLastRun,
								minHoursSinceLastRun: dreamConfig.auto.minHoursSinceLastRun,
							}),
						);
					}
				}

				const throttleMs = dreamConfig.auto.scanThrottleMinutes * MINUTE_MS;
				const lastScanAtMs = yield* Ref.get(lastScanAtRef);
				if (lastScanAtMs !== null && nowMs - lastScanAtMs < throttleMs) {
					return yield* Effect.fail(
						new DreamSessionScanThrottled({
							lastScanAtMs,
							scanThrottleMinutes: dreamConfig.auto.scanThrottleMinutes,
						}),
					);
				}

				yield* ensureDreamLockNotHeld(lock, request.cwd);

				const sinceMs = lastCompletedAtMs ?? 0;
				const sessions = yield* scanTranscriptCandidates(
					request.cwd,
					sinceMs,
					request.currentSessionId,
				);

				yield* Ref.set(lastScanAtRef, nowMs);

				if (sessions.length < dreamConfig.auto.minSessionsSinceLastRun) {
					return yield* Effect.fail(
						new DreamNotEnoughSessions({
							found: sessions.length,
							required: dreamConfig.auto.minSessionsSinceLastRun,
						}),
					);
				}

				return {
					sinceMs,
					sessions,
				} satisfies DreamAutoPermit;
			});

			return DreamScheduler.of({
				evaluateAutoStart,
				markCompleted,
				readLastCompletedAt,
			});
		}),
	);
