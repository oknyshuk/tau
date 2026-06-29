import path from "node:path";
import { Effect, Schema } from "effect";

import { BacklogContractValidationError } from "./errors.js";

export const BACKLOG_STORAGE = Object.freeze({
	rootDir: ".pi/backlog",
	canonicalEventsDir: ".pi/backlog/events",
	materializedCacheDir: ".pi/backlog/cache",
	materializedIssuesPath: ".pi/backlog/cache/issues.jsonl",
});

export const BACKLOG_CACHE_POLICY = Object.freeze({
	path: ".pi/backlog/cache/**",
	derived: true,
	canonical: false,
	gitIgnored: true,
	materialized: true,
	description: "Derived, non-canonical, git-ignored materialized cache.",
});

const CANONICAL_RECORDED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isCanonicalRecordedAt(value: string): boolean {
	if (!CANONICAL_RECORDED_AT_PATTERN.test(value)) {
		return false;
	}

	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		return false;
	}

	return new Date(timestamp).toISOString() === value;
}

export const BacklogRecordedAtSchema = Schema.String.check(
	Schema.makeFilter(
		(value) =>
			isCanonicalRecordedAt(value) ||
			"recorded_at must be a real canonical UTC ISO-8601 timestamp with millisecond precision",
	),
);

export function resolveBacklogPaths(workspaceRoot: string) {
	return Object.freeze({
		rootDir: path.join(workspaceRoot, BACKLOG_STORAGE.rootDir),
		canonicalEventsDir: path.join(workspaceRoot, BACKLOG_STORAGE.canonicalEventsDir),
		materializedCacheDir: path.join(workspaceRoot, BACKLOG_STORAGE.materializedCacheDir),
		materializedIssuesPath: path.join(workspaceRoot, BACKLOG_STORAGE.materializedIssuesPath),
	});
}

type BacklogFieldValue = unknown;

const BacklogFieldValuesSchema = Schema.Record(Schema.String, Schema.Unknown);
type BacklogFieldValues = Schema.Schema.Type<typeof BacklogFieldValuesSchema>;

const BacklogEventEnvelopeFields = {
	schema_version: Schema.Literal(1),
	event_id: Schema.NonEmptyString,
	issue_id: Schema.NonEmptyString,
	recorded_at: BacklogRecordedAtSchema,
	actor: Schema.NonEmptyString,
} as const;

export const BacklogIssueCreatedEventSchema = Schema.Struct({
	...BacklogEventEnvelopeFields,
	kind: Schema.Literal("issue.created"),
	fields: BacklogFieldValuesSchema,
});

const BacklogIssueImportedEventSchema = Schema.Struct({
	...BacklogEventEnvelopeFields,
	kind: Schema.Literal("issue.imported"),
	source: Schema.Struct({
		system: Schema.NonEmptyString,
		issue_id: Schema.NonEmptyString,
	}),
	fields: BacklogFieldValuesSchema,
});

export const BacklogIssueUpdatedEventSchema = Schema.Struct({
	...BacklogEventEnvelopeFields,
	kind: Schema.Literal("issue.updated"),
	set_fields: BacklogFieldValuesSchema,
	unset_fields: Schema.Array(Schema.NonEmptyString),
});

const BacklogEventSchema = Schema.Union([
	BacklogIssueCreatedEventSchema,
	BacklogIssueImportedEventSchema,
	BacklogIssueUpdatedEventSchema,
] as const);
export type BacklogEvent = Schema.Schema.Type<typeof BacklogEventSchema>;

const decodeRecordedAtSchema = Schema.decodeUnknownEffect(BacklogRecordedAtSchema);
const decodeBacklogEventSchema = Schema.decodeUnknownEffect(BacklogEventSchema);

const decodeBacklogRecordedAt = (
	value: unknown,
): Effect.Effect<string, BacklogContractValidationError, never> =>
	decodeRecordedAtSchema(value).pipe(
		Effect.mapError((error) =>
			new BacklogContractValidationError({
				reason: String(error),
				entity: "backlog.recorded_at",
			}),
		),
	);

export const decodeBacklogEvent = (
	value: unknown,
): Effect.Effect<BacklogEvent, BacklogContractValidationError, never> =>
	decodeBacklogEventSchema(value).pipe(
		Effect.mapError((error) =>
			new BacklogContractValidationError({
				reason: String(error),
				entity: "backlog.event",
			}),
		),
	);

type BacklogFieldClock = {
	readonly recorded_at: string;
	readonly event_id: string;
	readonly deleted: boolean;
};

type BacklogMaterializedIssue = {
	readonly issue_id: string;
	readonly origin_kind: "issue.created" | "issue.imported";
	readonly fields: Readonly<Record<string, BacklogFieldValue>>;
	readonly field_clock: Readonly<Record<string, BacklogFieldClock>>;
};

type BacklogFieldRevision =
	| {
			readonly deleted: false;
			readonly value: BacklogFieldValue;
			readonly recorded_at: string;
			readonly event_id: string;
	  }
	| {
			readonly deleted: true;
			readonly recorded_at: string;
			readonly event_id: string;
	  };

type MutableBacklogMaterializedIssue = {
	readonly issue_id: string;
	readonly origin_kind: "issue.created" | "issue.imported";
	revisions: Map<string, BacklogFieldRevision>;
};

function parseRecordedAt(recordedAt: string): number {
	const timestamp = Date.parse(recordedAt);
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareEventOrder(
	a: Pick<BacklogEvent, "recorded_at" | "event_id">,
	b: Pick<BacklogEvent, "recorded_at" | "event_id">,
): number {
	const timestampDelta = parseRecordedAt(a.recorded_at) - parseRecordedAt(b.recorded_at);
	if (timestampDelta !== 0) {
		return timestampDelta;
	}
	return a.event_id.localeCompare(b.event_id);
}

function originFieldsError(issueId: string, fields: BacklogFieldValues): BacklogContractValidationError | undefined {
	const idValue = fields["id"];
	if (typeof idValue !== "string" || idValue !== issueId) {
		return new BacklogContractValidationError({
			reason: `Origin event for issue ${issueId} must set fields.id to the same issue id`,
			entity: "backlog.event",
		});
	}
	return undefined;
}

function immutableIssueIdError(
	event: Extract<BacklogEvent, { kind: "issue.updated" }>,
): BacklogContractValidationError | undefined {
	if ("id" in event.set_fields || event.unset_fields.includes("id")) {
		return new BacklogContractValidationError({
			reason: `Update event ${event.event_id} cannot modify issue id ${event.issue_id}`,
			entity: "backlog.event",
		});
	}
	return undefined;
}

function shouldReplaceRevision(
	existing: BacklogFieldRevision | undefined,
	candidate: Pick<BacklogEvent, "recorded_at" | "event_id">,
): boolean {
	if (!existing) {
		return true;
	}
	return compareEventOrder(candidate, existing) >= 0;
}

function applyFieldSet(
	state: MutableBacklogMaterializedIssue,
	event: Pick<BacklogEvent, "recorded_at" | "event_id">,
	fields: BacklogFieldValues,
): void {
	for (const [field, value] of Object.entries(fields)) {
		const existing = state.revisions.get(field);
		if (!shouldReplaceRevision(existing, event)) {
			continue;
		}
		state.revisions.set(field, {
			deleted: false,
			value,
			recorded_at: event.recorded_at,
			event_id: event.event_id,
		});
	}
}

function applyFieldUnset(
	state: MutableBacklogMaterializedIssue,
	event: Pick<BacklogEvent, "recorded_at" | "event_id">,
	fields: ReadonlyArray<string>,
): void {
	for (const field of fields) {
		const existing = state.revisions.get(field);
		if (!shouldReplaceRevision(existing, event)) {
			continue;
		}
		state.revisions.set(field, {
			deleted: true,
			recorded_at: event.recorded_at,
			event_id: event.event_id,
		});
	}
}

function materializeIssue(state: MutableBacklogMaterializedIssue): BacklogMaterializedIssue {
	const fields: Record<string, BacklogFieldValue> = {};
	const fieldClock: Record<string, BacklogFieldClock> = {};

	for (const [field, revision] of state.revisions.entries()) {
		fieldClock[field] = {
			recorded_at: revision.recorded_at,
			event_id: revision.event_id,
			deleted: revision.deleted,
		};
		if (!revision.deleted) {
			fields[field] = revision.value;
		}
	}

	return Object.freeze({
		issue_id: state.issue_id,
		origin_kind: state.origin_kind,
		fields: Object.freeze(fields),
		field_clock: Object.freeze(fieldClock),
	});
}

export function compareBacklogEvents(a: BacklogEvent, b: BacklogEvent): number {
	return compareEventOrder(a, b);
}

export function sortBacklogEvents(events: ReadonlyArray<BacklogEvent>): ReadonlyArray<BacklogEvent> {
	return [...events].sort(compareBacklogEvents);
}

export const replayBacklogEvents = (
	events: ReadonlyArray<BacklogEvent>,
): Effect.Effect<ReadonlyMap<string, BacklogMaterializedIssue>, BacklogContractValidationError, never> =>
	Effect.gen(function* () {
		const issues = new Map<string, MutableBacklogMaterializedIssue>();

		for (const event of sortBacklogEvents(events)) {
			const existing = issues.get(event.issue_id);

			switch (event.kind) {
				case "issue.created": {
					if (existing) {
						return yield* Effect.fail(
							new BacklogContractValidationError({
								reason: `Issue ${event.issue_id} already has an origin event`,
								entity: "backlog.event",
							}),
						);
					}
					const originError = originFieldsError(event.issue_id, event.fields);
					if (originError) {
						return yield* Effect.fail(originError);
					}
					const state: MutableBacklogMaterializedIssue = {
						issue_id: event.issue_id,
						origin_kind: event.kind,
						revisions: new Map(),
					};
					applyFieldSet(state, event, event.fields);
					issues.set(event.issue_id, state);
					break;
				}
				case "issue.imported": {
					if (existing) {
						return yield* Effect.fail(
							new BacklogContractValidationError({
								reason: `Issue ${event.issue_id} already has an origin event`,
								entity: "backlog.event",
							}),
						);
					}
					const originError = originFieldsError(event.issue_id, event.fields);
					if (originError) {
						return yield* Effect.fail(originError);
					}
					const state: MutableBacklogMaterializedIssue = {
						issue_id: event.issue_id,
						origin_kind: event.kind,
						revisions: new Map(),
					};
					applyFieldSet(state, event, event.fields);
					issues.set(event.issue_id, state);
					break;
				}
				case "issue.updated": {
					if (!existing) {
						return yield* Effect.fail(
							new BacklogContractValidationError({
								reason: `Update event ${event.event_id} references issue ${event.issue_id} before an origin event`,
								entity: "backlog.event",
							}),
						);
					}
					const immutableError = immutableIssueIdError(event);
					if (immutableError) {
						return yield* Effect.fail(immutableError);
					}
					applyFieldSet(existing, event, event.set_fields);
					applyFieldUnset(existing, event, event.unset_fields);
					break;
				}
			}
		}

		return new Map(
			Array.from(issues.entries(), ([issueId, issue]) => [issueId, materializeIssue(issue)]),
		);
	});

