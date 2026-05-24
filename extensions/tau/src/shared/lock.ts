import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Effect, type Scope, Schema } from "effect";

type ParsedLockMetadata =
	| {
			readonly _tag: "valid";
			readonly metadata: SharedLockMetadata;
	  }
	| {
			readonly _tag: "invalid";
			readonly reason: string;
	  };

type LockMatch =
	| {
			readonly type: "token";
			readonly token: string;
	  }
	| {
			readonly type: "raw";
			readonly raw: string;
	  };

interface LockSnapshot {
	readonly raw: string;
	readonly mtimeMs: number;
	readonly parsed: ParsedLockMetadata;
}

interface SharedLockMetadata {
	readonly pid: number;
	readonly token: string;
	readonly acquiredAtMs?: number;
}

export interface SharedFileLockConfig {
	readonly staleMs: number;
	readonly retryDelayMs: number;
	readonly maxAttempts: number;
	readonly heldPolicy: "fail" | "wait";
}

interface SharedFileLockLease {
	readonly path: string;
	readonly token: string;
	readonly acquiredAtMs: number;
}

interface SharedFileLockInfo {
	readonly path: string;
	readonly holderPid?: number;
	readonly acquiredAtMs?: number;
}

export class SharedFileLockHeld extends Schema.TaggedErrorClass<SharedFileLockHeld>()(
	"SharedFileLockHeld",
	{
		path: Schema.String,
		holderPid: Schema.optional(Schema.Number),
		acquiredAtMs: Schema.optional(Schema.Number),
	},
) {}

export class SharedFileLockCorrupt extends Schema.TaggedErrorClass<SharedFileLockCorrupt>()(
	"SharedFileLockCorrupt",
	{
		path: Schema.String,
		reason: Schema.String,
		reclaimAttempted: Schema.Boolean,
	},
) {}

export class SharedFileLockTimeout extends Schema.TaggedErrorClass<SharedFileLockTimeout>()(
	"SharedFileLockTimeout",
	{
		path: Schema.String,
		attempts: Schema.Number,
		reclaimAttempted: Schema.Boolean,
	},
) {}

export class SharedFileLockIoError extends Schema.TaggedErrorClass<SharedFileLockIoError>()(
	"SharedFileLockIoError",
	{
		path: Schema.String,
		operation: Schema.String,
		reason: Schema.String,
		reclaimAttempted: Schema.Boolean,
		cause: Schema.Defect,
	},
) {}

type SharedFileLockError =
	| SharedFileLockHeld
	| SharedFileLockCorrupt
	| SharedFileLockTimeout
	| SharedFileLockIoError;

function toSharedFileLockError(
	lockPath: string,
	operation: string,
	error: unknown,
): SharedFileLockError {
	if (
		error instanceof SharedFileLockHeld ||
		error instanceof SharedFileLockCorrupt ||
		error instanceof SharedFileLockTimeout ||
		error instanceof SharedFileLockIoError
	) {
		return error;
	}

	return toIoError(
		lockPath,
		operation,
		`Failed to ${operation} shared lock ${lockPath}`,
		false,
		error,
	);
}

function isNodeError(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return !isNodeError(error, "ESRCH");
	}
}

function parseLockMetadata(raw: string): ParsedLockMetadata {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error: unknown) {
		return {
			_tag: "invalid",
			reason: `Invalid lock JSON: ${String(error)}`,
		};
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			_tag: "invalid",
			reason: "Lock payload must be a JSON object",
		};
	}

	const pid = "pid" in parsed ? parsed.pid : undefined;
	const token = "token" in parsed ? parsed.token : undefined;
	const acquiredAtMs = "acquiredAtMs" in parsed ? parsed.acquiredAtMs : undefined;

	if (typeof pid !== "number" || !Number.isFinite(pid) || typeof token !== "string") {
		return {
			_tag: "invalid",
			reason: "Lock payload must include numeric pid and string token",
		};
	}

	if (
		acquiredAtMs !== undefined &&
		(typeof acquiredAtMs !== "number" || !Number.isFinite(acquiredAtMs))
	) {
		return {
			_tag: "invalid",
			reason: "Lock payload acquiredAtMs must be numeric when present",
		};
	}

	return {
		_tag: "valid",
		metadata: {
			pid,
			token,
			...(typeof acquiredAtMs === "number" ? { acquiredAtMs } : {}),
		},
	};
}

function toIoError(
	pathValue: string,
	operation: string,
	reason: string,
	reclaimAttempted: boolean,
	cause: unknown,
): SharedFileLockIoError {
	return new SharedFileLockIoError({
		path: pathValue,
		operation,
		reason,
		reclaimAttempted,
		cause,
	});
}

async function ensureLockDirectory(lockPath: string): Promise<void> {
	try {
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
	} catch (error: unknown) {
		throw toIoError(lockPath, "mkdir", `Failed to create lock directory for ${lockPath}`, false, error);
	}
}

async function readLockSnapshot(lockPath: string, reclaimAttempted: boolean): Promise<LockSnapshot | null> {
	try {
		const [stats, raw] = await Promise.all([fs.stat(lockPath), fs.readFile(lockPath, "utf8")]);
		return {
			raw,
			mtimeMs: stats.mtimeMs,
			parsed: parseLockMetadata(raw),
		};
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) {
			return null;
		}
		throw toIoError(lockPath, "read", `Failed to read lock file ${lockPath}`, reclaimAttempted, error);
	}
}

function isReclaimable(snapshot: LockSnapshot, config: SharedFileLockConfig): boolean {
	if (snapshot.parsed._tag === "invalid") {
		return Date.now() - snapshot.mtimeMs > config.staleMs;
	}

	return !processExists(snapshot.parsed.metadata.pid);
}

async function lockFileMatches(
	lockPath: string,
	expected: LockMatch,
	reclaimAttempted: boolean,
): Promise<boolean> {
	let raw: string;
	try {
		raw = await fs.readFile(lockPath, "utf8");
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) {
			return false;
		}
		throw toIoError(lockPath, "read", `Failed to read lock file ${lockPath}`, reclaimAttempted, error);
	}

	if (expected.type === "raw") {
		return raw === expected.raw;
	}

	const metadata = parseLockMetadata(raw);
	return metadata._tag === "valid" && metadata.metadata.token === expected.token;
}

async function reclaimLockIfStillMatches(lockPath: string, expected: LockMatch): Promise<boolean> {
	const claimPath = `${lockPath}.claim-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

	try {
		await fs.link(lockPath, claimPath);
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) {
			return false;
		}
		throw toIoError(lockPath, "reclaim-link", `Failed to create reclaim claim link ${claimPath}`, true, error);
	}

	try {
		const claimMatches = await lockFileMatches(claimPath, expected, true);
		if (!claimMatches) {
			return false;
		}

		let lockStat: Awaited<ReturnType<typeof fs.stat>>;
		let claimStat: Awaited<ReturnType<typeof fs.stat>>;
		try {
			[lockStat, claimStat] = await Promise.all([fs.stat(lockPath), fs.stat(claimPath)]);
		} catch (error: unknown) {
			if (isNodeError(error, "ENOENT")) {
				return false;
			}
			throw toIoError(lockPath, "reclaim-stat", `Failed to stat reclaim paths for ${lockPath}`, true, error);
		}

		if (lockStat.dev !== claimStat.dev || lockStat.ino !== claimStat.ino) {
			return false;
		}

		try {
			await fs.unlink(lockPath);
			return true;
		} catch (error: unknown) {
			if (isNodeError(error, "ENOENT")) {
				return false;
			}
			throw toIoError(lockPath, "reclaim-unlink", `Failed to reclaim lock at ${lockPath}`, true, error);
		}
	} finally {
		try {
			await fs.unlink(claimPath);
		} catch {
			// Best-effort claim cleanup only. The main lock outcome has already been decided.
		}
	}
}

function lockMatchForSnapshot(snapshot: LockSnapshot): LockMatch {
	if (snapshot.parsed._tag === "valid") {
		return {
			type: "token",
			token: snapshot.parsed.metadata.token,
		};
	}

	return {
		type: "raw",
		raw: snapshot.raw,
	};
}

export async function inspectSharedFileLock(
	lockPath: string,
	config: SharedFileLockConfig,
): Promise<SharedFileLockInfo | null> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const snapshot = await readLockSnapshot(lockPath, true);
		if (snapshot === null) {
			return null;
		}

		if (isReclaimable(snapshot, config)) {
			const reclaimed = await reclaimLockIfStillMatches(lockPath, lockMatchForSnapshot(snapshot));
			if (reclaimed) {
				return null;
			}
			continue;
		}

		if (snapshot.parsed._tag === "invalid") {
			throw new SharedFileLockCorrupt({
				path: lockPath,
				reason: snapshot.parsed.reason,
				reclaimAttempted: false,
			});
		}

		return {
			path: lockPath,
			holderPid: snapshot.parsed.metadata.pid,
			...(snapshot.parsed.metadata.acquiredAtMs !== undefined
				? { acquiredAtMs: snapshot.parsed.metadata.acquiredAtMs }
				: {}),
		};
	}

	throw new SharedFileLockIoError({
		path: lockPath,
		operation: "inspect-race",
		reason: "Lock changed repeatedly during inspection",
		reclaimAttempted: true,
		cause: new Error("inspect-race"),
	});
}

export async function acquireSharedFileLock(
	lockPath: string,
	config: SharedFileLockConfig,
): Promise<SharedFileLockLease> {
	await ensureLockDirectory(lockPath);
	let reclaimAttempted = false;

	for (let attempt = 0; attempt < config.maxAttempts; attempt += 1) {
		const token = crypto.randomBytes(8).toString("hex");
		const acquiredAtMs = Date.now();

		try {
			await fs.writeFile(
				lockPath,
				JSON.stringify({ pid: process.pid, token, acquiredAtMs } satisfies SharedLockMetadata),
				{
					encoding: "utf8",
					flag: "wx",
				},
			);
			return {
				path: lockPath,
				token,
				acquiredAtMs,
			};
		} catch (error: unknown) {
			if (!isNodeError(error, "EEXIST")) {
				throw toIoError(lockPath, "acquire-write", `Failed to create lock file ${lockPath}`, false, error);
			}
		}

		const snapshot = await readLockSnapshot(lockPath, false);
		if (snapshot === null) {
			if (config.heldPolicy === "wait") {
				await new Promise<void>((resolve) => setTimeout(resolve, config.retryDelayMs));
				continue;
			}
			continue;
		}

		reclaimAttempted = isReclaimable(snapshot, config);
		if (reclaimAttempted) {
			const reclaimed = await reclaimLockIfStillMatches(lockPath, lockMatchForSnapshot(snapshot));
			if (reclaimed) {
				continue;
			}
		}

		if (snapshot.parsed._tag === "invalid") {
			throw new SharedFileLockCorrupt({
				path: lockPath,
				reason: snapshot.parsed.reason,
				reclaimAttempted,
			});
		}

		if (config.heldPolicy === "fail") {
			throw new SharedFileLockHeld({
				path: lockPath,
				holderPid: snapshot.parsed.metadata.pid,
				...(snapshot.parsed.metadata.acquiredAtMs !== undefined
					? { acquiredAtMs: snapshot.parsed.metadata.acquiredAtMs }
					: {}),
			});
		}

		if (attempt === config.maxAttempts - 1) {
			throw new SharedFileLockTimeout({
				path: lockPath,
				attempts: config.maxAttempts,
				reclaimAttempted,
			});
		}

		await new Promise<void>((resolve) => setTimeout(resolve, config.retryDelayMs));
	}

	throw new SharedFileLockTimeout({
		path: lockPath,
		attempts: config.maxAttempts,
		reclaimAttempted,
	});
}

export async function releaseSharedFileLock(lease: SharedFileLockLease): Promise<void> {
	const matches = await lockFileMatches(lease.path, { type: "token", token: lease.token }, false);
	if (!matches) {
		return;
	}

	try {
		await fs.unlink(lease.path);
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) {
			return;
		}
		throw toIoError(lease.path, "release", `Failed to remove lock file ${lease.path}`, false, error);
	}
}

export const acquireSharedFileLockEffect = (
	lockPath: string,
	config: SharedFileLockConfig,
): Effect.Effect<SharedFileLockLease, SharedFileLockError, never> =>
	Effect.tryPromise({
		try: () => acquireSharedFileLock(lockPath, config),
		catch: (error) => toSharedFileLockError(lockPath, "acquire", error),
	});

export const releaseSharedFileLockEffect = (
	lease: SharedFileLockLease,
): Effect.Effect<void, SharedFileLockError, never> =>
	Effect.tryPromise({
		try: () => releaseSharedFileLock(lease),
		catch: (error) => toSharedFileLockError(lease.path, "release", error),
	});

export const acquireSharedFileLockScoped = (
	lockPath: string,
	config: SharedFileLockConfig,
): Effect.Effect<SharedFileLockLease, SharedFileLockError, Scope.Scope> =>
	Effect.acquireRelease(acquireSharedFileLockEffect(lockPath, config), (lease) =>
		releaseSharedFileLockEffect(lease).pipe(
			Effect.tapError((error) => Effect.logWarning("Shared file lock release failed", error)),
			Effect.orElseSucceed(() => undefined),
		),
	);

export async function withSharedFileLock<T>(
	lockPath: string,
	config: SharedFileLockConfig,
	fn: () => Promise<T>,
): Promise<T> {
	const lease = await acquireSharedFileLock(lockPath, config);
	try {
		return await fn();
	} finally {
		await releaseSharedFileLock(lease);
	}
}

export function describeSharedFileLockError(error: unknown): string {
	if (error instanceof SharedFileLockHeld) {
		return error.holderPid !== undefined
			? `Lock held at ${error.path} by pid ${error.holderPid}`
			: `Lock held at ${error.path}`;
	}
	if (error instanceof SharedFileLockCorrupt) {
		return `Corrupt lock at ${error.path}: ${error.reason}`;
	}
	if (error instanceof SharedFileLockTimeout) {
		return `Timed out acquiring lock at ${error.path} after ${error.attempts} attempts`;
	}
	if (error instanceof SharedFileLockIoError) {
		return `Lock I/O error at ${error.path}: ${error.reason}`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
