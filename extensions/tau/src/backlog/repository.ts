import path from "node:path";
import { Database as DatabaseSync } from "bun:sqlite";

import { NodeFileSystem } from "@effect/platform-node";
import { FileSystem, Effect, Layer, Schema } from "effect";

import {
	BacklogIssueImportedEventSchema,
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
	BacklogLegacyImportError,
	BacklogLockError,
	BacklogStorageError,
} from "./errors.js";
import { assertNoDependencyCyclesEffect } from "./graph.js";
import {
	type Comment,
	decodeIssue,
	type Dependency,
	encodeIssue,
	type EncodedIssue,
	type Issue,
} from "./schema.js";
import { BacklogConfig, BacklogLegacyImport, BacklogRepository } from "./services.js";
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

const toLegacyImportError = (source: string, reason: string, cause: unknown): BacklogLegacyImportError =>
	new BacklogLegacyImportError({
		source,
		reason,
		cause,
	});

type SqliteRow = Record<string, unknown>;

const decodeImportedEventSchema = Schema.decodeUnknownEffect(BacklogIssueImportedEventSchema);

const decodeImportedEvent = (
	value: unknown,
): Effect.Effect<Extract<BacklogEvent, { kind: "issue.imported" }>, BacklogContractValidationError, never> =>
	decodeImportedEventSchema(value).pipe(
		Effect.mapError(
			(error) =>
				new BacklogContractValidationError({
					reason: String(error),
					entity: "backlog.event",
				}),
		),
	);

const nowIso = (): string => new Date().toISOString();

const canonicalizeLegacyTimestamp = (value: string | undefined): string | undefined => {
	if (!value) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return undefined;
	}

	return new Date(timestamp).toISOString();
};

const issueTimestamp = (issue: Issue): number => {
	const updated = issue.updated_at ? Date.parse(issue.updated_at) : Number.NaN;
	if (!Number.isNaN(updated)) {
		return updated;
	}
	const created = issue.created_at ? Date.parse(issue.created_at) : Number.NaN;
	if (!Number.isNaN(created)) {
		return created;
	}
	return 0;
};

const mergeImportedIssues = (
	jsonlIssues: ReadonlyArray<Issue>,
	dbIssues: ReadonlyArray<Issue>,
): ReadonlyArray<Issue> => {
	const merged = new Map<string, Issue>();

	for (const issue of jsonlIssues) {
		merged.set(issue.id, issue);
	}

	for (const issue of dbIssues) {
		const existing = merged.get(issue.id);
		if (!existing || issueTimestamp(issue) > issueTimestamp(existing)) {
			merged.set(issue.id, issue);
		}
	}

	return [...merged.values()];
};

const getRecord = (value: unknown): SqliteRow | null => {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as SqliteRow;
};

const getString = (row: SqliteRow, key: string): string | undefined => {
	const value = row[key];
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const getNumber = (row: SqliteRow, key: string): number | undefined => {
	const value = row[key];
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "bigint") {
		return Number(value);
	}
	if (typeof value === "string") {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
};

const getBoolean = (row: SqliteRow, key: string): boolean | undefined => {
	const value = row[key];
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (value === 0) return false;
		if (value === 1) return true;
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true" || normalized === "1") return true;
		if (normalized === "false" || normalized === "0") return false;
	}
	return undefined;
};

const getStringArray = (row: SqliteRow, key: string): ReadonlyArray<string> | undefined => {
	const value = row[key];
	if (Array.isArray(value)) {
		const strings = value.filter((item): item is string => typeof item === "string");
		return strings.length > 0 ? strings : undefined;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) {
			return undefined;
		}
		const strings = parsed.filter((item): item is string => typeof item === "string");
		return strings.length > 0 ? strings : undefined;
	} catch {
		return undefined;
	}
};

const tableExists = (database: DatabaseSync, table: string): boolean => {
	const row = database
		.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
		.get(table);
	return row !== null && row !== undefined;
};

const readTableRows = (
	database: DatabaseSync,
	table: "issues" | "dependencies" | "comments" | "labels",
): ReadonlyArray<SqliteRow> => {
	if (!tableExists(database, table)) {
		return [];
	}
	return database
		.prepare(`SELECT * FROM ${table}`)
		.all()
		.map(getRecord)
		.filter((row): row is SqliteRow => row !== null);
};

const parseDependencyRow = (row: SqliteRow): Dependency | undefined => {
	const issueId = getString(row, "issue_id");
	const dependsOnId = getString(row, "depends_on_id");
	const type = getString(row, "type");
	const createdAt = getString(row, "created_at");
	if (!issueId || !dependsOnId || !type || !createdAt) {
		return undefined;
	}

	return {
		issue_id: issueId,
		depends_on_id: dependsOnId,
		type,
		created_at: createdAt,
		...(getString(row, "created_by") ? { created_by: getString(row, "created_by") } : {}),
		...(getString(row, "thread_id") ? { thread_id: getString(row, "thread_id") } : {}),
		...("metadata" in row && row["metadata"] !== undefined ? { metadata: row["metadata"] } : {}),
	} satisfies Dependency;
};

const parseCommentRow = (row: SqliteRow): Comment | undefined => {
	const id = getNumber(row, "id");
	const issueId = getString(row, "issue_id");
	const author = getString(row, "author");
	const text = getString(row, "text");
	const createdAt = getString(row, "created_at");
	if (id === undefined || !issueId || !author || !text || !createdAt) {
		return undefined;
	}
	return { id, issue_id: issueId, author, text, created_at: createdAt };
};

const mapDbIssueRowCandidate = (
	row: SqliteRow,
	depsByIssue: ReadonlyMap<string, ReadonlyArray<Dependency>>,
	commentsByIssue: ReadonlyMap<string, ReadonlyArray<Comment>>,
	labelsByIssue: ReadonlyMap<string, ReadonlyArray<string>>,
): Effect.Effect<Record<string, unknown> | undefined, BacklogLegacyImportError, never> =>
	Effect.gen(function* () {
		const id = getString(row, "id");
		const title = getString(row, "title");
		if (!id || !title) {
			return yield* Effect.fail(
				toLegacyImportError(
					".beads/beads.db",
					"Invalid SQLite issue row: missing or empty required field 'id' or 'title'",
					new Error("invalid-issue-row"),
				),
			);
		}

		const candidate: Record<string, unknown> = { id, title };
		const setIfDefined = (key: string, value: unknown): void => {
			if (value !== undefined) {
				candidate[key] = value;
			}
		};

		setIfDefined("description", getString(row, "description"));
		setIfDefined("design", getString(row, "design"));
		setIfDefined("acceptance_criteria", getString(row, "acceptance_criteria"));
		setIfDefined("notes", getString(row, "notes"));
		setIfDefined("status", getString(row, "status"));
		setIfDefined("priority", getNumber(row, "priority"));
		setIfDefined("issue_type", getString(row, "issue_type"));
		setIfDefined("assignee", getString(row, "assignee"));
		setIfDefined("owner", getString(row, "owner"));
		setIfDefined("estimated_minutes", getNumber(row, "estimated_minutes"));
		setIfDefined("created_at", getString(row, "created_at"));
		setIfDefined("created_by", getString(row, "created_by"));
		setIfDefined("updated_at", getString(row, "updated_at"));
		setIfDefined("closed_at", getString(row, "closed_at"));
		setIfDefined("close_reason", getString(row, "close_reason"));
		setIfDefined("closed_by_session", getString(row, "closed_by_session"));
		setIfDefined("due_at", getString(row, "due_at"));
		setIfDefined("defer_until", getString(row, "defer_until"));
		setIfDefined("external_ref", getString(row, "external_ref"));
		setIfDefined("source_system", getString(row, "source_system"));
		setIfDefined("compaction_level", getNumber(row, "compaction_level"));
		setIfDefined("compacted_at", getString(row, "compacted_at"));
		setIfDefined("compacted_at_commit", getString(row, "compacted_at_commit"));
		setIfDefined("original_size", getNumber(row, "original_size"));
		setIfDefined("deleted_at", getString(row, "deleted_at"));
		if (candidate["deleted_at"] !== undefined) {
			return undefined;
		}
		setIfDefined("deleted_by", getString(row, "deleted_by"));
		setIfDefined("delete_reason", getString(row, "delete_reason"));
		setIfDefined("original_type", getString(row, "original_type"));
		setIfDefined("sender", getString(row, "sender"));
		setIfDefined("ephemeral", getBoolean(row, "ephemeral"));
		setIfDefined("pinned", getBoolean(row, "pinned"));
		setIfDefined("is_template", getBoolean(row, "is_template"));
		setIfDefined("quality_score", getNumber(row, "quality_score"));
		setIfDefined("crystallizes", getBoolean(row, "crystallizes"));
		setIfDefined("await_type", getString(row, "await_type"));
		setIfDefined("await_id", getString(row, "await_id"));
		setIfDefined("timeout", getNumber(row, "timeout_ns"));
		setIfDefined("waiters", getStringArray(row, "waiters"));
		setIfDefined("hook_bead", getString(row, "hook_bead"));
		setIfDefined("role_bead", getString(row, "role_bead"));
		setIfDefined("agent_state", getString(row, "agent_state"));
		setIfDefined("last_activity", getString(row, "last_activity"));
		setIfDefined("role_type", getString(row, "role_type"));
		setIfDefined("rig", getString(row, "rig"));
		setIfDefined("mol_type", getString(row, "mol_type"));
		setIfDefined("work_type", getString(row, "work_type"));
		setIfDefined("event_kind", getString(row, "event_kind"));
		setIfDefined("actor", getString(row, "actor"));
		setIfDefined("target", getString(row, "target"));
		setIfDefined("payload", getString(row, "payload"));

		const dependencies = depsByIssue.get(id);
		const comments = commentsByIssue.get(id);
		const labels = labelsByIssue.get(id);
		if (dependencies && dependencies.length > 0) {
			candidate["dependencies"] = dependencies;
		}
		if (comments && comments.length > 0) {
			candidate["comments"] = comments;
		}
		if (labels && labels.length > 0) {
			candidate["labels"] = labels;
		}

		return candidate;
	});

const readBeadsIssuesJsonl = (
	fs: FileSystem.FileSystem,
	beadsIssuesPath: string,
): Effect.Effect<ReadonlyArray<Issue>, BacklogLegacyImportError | BacklogContractValidationError, never> =>
	Effect.gen(function* () {
		const exists = yield* fs.exists(beadsIssuesPath).pipe(
			Effect.mapError((error) =>
				toLegacyImportError(
					".beads/issues.jsonl",
					`Failed to inspect legacy issues file ${beadsIssuesPath}`,
					error,
				),
			),
		);
		if (!exists) {
			return [];
		}

		const raw = yield* fs.readFileString(beadsIssuesPath).pipe(
			Effect.mapError((error) =>
				toLegacyImportError(
					".beads/issues.jsonl",
					`Failed to read legacy issues file ${beadsIssuesPath}`,
					error,
				),
			),
		);

		const lines = raw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);

		const issues: Issue[] = [];
		for (const [index, line] of lines.entries()) {
			const parsed = yield* Effect.try({
				try: () => JSON.parse(line) as unknown,
				catch: (error) =>
					toLegacyImportError(
						".beads/issues.jsonl",
						`Invalid JSON in .beads/issues.jsonl at line ${index + 1}`,
						error,
					),
			});
			issues.push(yield* decodeIssue(parsed));
		}

		return issues;
	});

const readBeadsIssuesDb = (
	fs: FileSystem.FileSystem,
	dbPath: string,
): Effect.Effect<ReadonlyArray<Issue>, BacklogLegacyImportError | BacklogContractValidationError, never> =>
	Effect.gen(function* () {
		const exists = yield* fs.exists(dbPath).pipe(
			Effect.mapError((error) =>
				toLegacyImportError(
					".beads/beads.db",
					`Failed to inspect legacy db file ${dbPath}`,
					error,
				),
			),
		);
		if (!exists) {
			return [];
		}

		return yield* Effect.acquireUseRelease(
			Effect.try({
				try: () => new DatabaseSync(dbPath, { readonly: true }),
				catch: (error) =>
					toLegacyImportError(
						".beads/beads.db",
						`Failed to open SQLite database at ${dbPath}`,
						error,
					),
			}),
			(database) =>
				Effect.gen(function* () {
					const dependencyRows = yield* Effect.try({
						try: () => readTableRows(database, "dependencies"),
						catch: (error) =>
							toLegacyImportError(".beads/beads.db", "Failed to read dependencies table", error),
					});
					const depsByIssue = new Map<string, Dependency[]>();
					for (const row of dependencyRows) {
						const dependency = parseDependencyRow(row);
						if (!dependency) continue;
						const existing = depsByIssue.get(dependency.issue_id);
						if (existing) {
							existing.push(dependency);
						} else {
							depsByIssue.set(dependency.issue_id, [dependency]);
						}
					}

					const commentRows = yield* Effect.try({
						try: () => readTableRows(database, "comments"),
						catch: (error) => toLegacyImportError(".beads/beads.db", "Failed to read comments table", error),
					});
					const commentsByIssue = new Map<string, Comment[]>();
					for (const row of commentRows) {
						const comment = parseCommentRow(row);
						if (!comment) continue;
						const existing = commentsByIssue.get(comment.issue_id);
						if (existing) {
							existing.push(comment);
						} else {
							commentsByIssue.set(comment.issue_id, [comment]);
						}
					}

					const labelRows = yield* Effect.try({
						try: () => readTableRows(database, "labels"),
						catch: (error) => toLegacyImportError(".beads/beads.db", "Failed to read labels table", error),
					});
					const labelsByIssue = new Map<string, string[]>();
					for (const row of labelRows) {
						const issueId = getString(row, "issue_id");
						const label = getString(row, "label");
						if (!issueId || !label) continue;
						const existing = labelsByIssue.get(issueId);
						if (existing) {
							existing.push(label);
						} else {
							labelsByIssue.set(issueId, [label]);
						}
					}

					const issueRows = yield* Effect.try({
						try: () => readTableRows(database, "issues"),
						catch: (error) => toLegacyImportError(".beads/beads.db", "Failed to read issues table", error),
					});

					const issues: Issue[] = [];
					for (const row of issueRows) {
						const candidate = yield* mapDbIssueRowCandidate(row, depsByIssue, commentsByIssue, labelsByIssue);
						if (!candidate) {
							continue;
						}
						issues.push(yield* decodeIssue(candidate));
					}

					return issues;
				}),
			(database, _exit) =>
				Effect.sync(() => {
					database.close();
				}),
		);
	});

const importedEventForIssue = (
	issue: Issue,
): Effect.Effect<BacklogEvent, BacklogContractValidationError, never> =>
	Effect.gen(function* () {
		const recordedAt =
			canonicalizeLegacyTimestamp(issue.updated_at) ??
			canonicalizeLegacyTimestamp(issue.created_at) ??
			nowIso();
		const actor = issue.created_by ?? issue.owner ?? "beads-import";
		const encodedIssue = yield* encodeIssue(issue);
		return yield* decodeImportedEvent({
			schema_version: 1,
			event_id: `import-${issue.id}`,
			issue_id: issue.id,
			recorded_at: recordedAt,
			kind: "issue.imported",
			actor,
			source: {
				system: "beads",
				issue_id: issue.id,
			},
			fields: encodedIssue,
		});
	});

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

export const BacklogLegacyImportLive = Layer.effect(
	BacklogLegacyImport,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const config = yield* BacklogConfig;
		return BacklogLegacyImport.of({
			importIfNeeded: () =>
				Effect.gen(function* () {
					const canonicalEvents = yield* listFilesRecursive(fs, config.eventsRoot).pipe(
						Effect.mapError((error) =>
							toLegacyImportError(
								".pi/backlog/events",
								"Failed to inspect canonical backlog events before legacy import",
								error,
							),
						),
					);
					if (canonicalEvents.length > 0) {
						return [];
					}

					const beadsDir = path.join(config.workspaceRoot, ".beads");
					const jsonlIssues = yield* readBeadsIssuesJsonl(fs, path.join(beadsDir, "issues.jsonl"));
					const dbIssues = yield* readBeadsIssuesDb(fs, path.join(beadsDir, "beads.db"));
					const issuesToImport = mergeImportedIssues(jsonlIssues, dbIssues);

					for (const issue of issuesToImport) {
						const event = yield* importedEventForIssue(issue);
						yield* writeEventFileUnchecked(fs, config.eventsRoot, config.cacheRoot, event);
					}

					return issuesToImport;
				}),
		});
	}),
);

export const BacklogRepositoryLive = Layer.effect(
	BacklogRepository,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const config = yield* BacklogConfig;
		const legacyImport = yield* BacklogLegacyImport;
		const lockPath = lockPathFor(config.cacheRoot);

		const readEvents = (): Effect.Effect<
			ReadonlyArray<BacklogEvent>,
			BacklogStorageError | BacklogLegacyImportError | BacklogContractValidationError,
			never
		> =>
			Effect.gen(function* () {
				yield* legacyImport.importIfNeeded();
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
				const existing = yield* readEvents().pipe(
					Effect.catchTags({
						BacklogLegacyImportError: (error) =>
							Effect.fail(
								toStorageError("legacy-import", config.eventsRoot, `Legacy import failed: ${error.reason}`, error),
							),
					}),
				);
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
				const events = yield* readEvents().pipe(
					Effect.catchTags({
						BacklogLegacyImportError: (error) =>
							Effect.fail(
								toStorageError("legacy-import", config.eventsRoot, `Legacy import failed: ${error.reason}`, error),
							),
					}),
				);
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
		Layer.provide(BacklogLegacyImportLive),
		Layer.provide(BacklogConfigLive(workspaceRoot)),
		Layer.provide(NodeFileSystem.layer),
	);
