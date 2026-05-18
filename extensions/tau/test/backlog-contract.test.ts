import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";

import {
	BACKLOG_CACHE_POLICY,
	BACKLOG_STORAGE,
	BacklogRecordedAtSchema,
	compareBacklogEvents,
	decodeBacklogEvent,
	replayBacklogEvents,
	resolveBacklogPaths,
	sortBacklogEvents,
} from "../src/backlog/contract.js";
import { BacklogContractValidationError } from "../src/backlog/errors.js";

const decodeEvent = (value: unknown) => Effect.runSync(decodeBacklogEvent(value));

describe("backlog contract", () => {
	it("defines tracked events and ignored cache paths", () => {
		expect(BACKLOG_STORAGE.canonicalEventsDir).toBe(".pi/backlog/events");
		expect(BACKLOG_STORAGE.materializedCacheDir).toBe(".pi/backlog/cache");
		expect(BACKLOG_STORAGE.materializedIssuesPath).toBe(".pi/backlog/cache/issues.jsonl");
		expect(BACKLOG_CACHE_POLICY).toEqual({
			path: ".pi/backlog/cache/**",
			derived: true,
			canonical: false,
			gitIgnored: true,
			materialized: true,
			description: "Derived, non-canonical, git-ignored materialized cache.",
		});

		expect(resolveBacklogPaths("/workspace")).toEqual({
			rootDir: "/workspace/.pi/backlog",
			canonicalEventsDir: "/workspace/.pi/backlog/events",
			materializedCacheDir: "/workspace/.pi/backlog/cache",
			materializedIssuesPath: "/workspace/.pi/backlog/cache/issues.jsonl",
		});
	});

	it("accepts only canonical recorded_at timestamps", () => {
		expect(Schema.decodeUnknownSync(BacklogRecordedAtSchema)("2026-03-29T12:00:00.123Z")).toBe(
			"2026-03-29T12:00:00.123Z",
		);

		expect(() => Schema.decodeUnknownSync(BacklogRecordedAtSchema)("2026-03-29T12:00:00Z")).toThrow();
		expect(() => Schema.decodeUnknownSync(BacklogRecordedAtSchema)("2026-03-29T12:00:00.123+02:00")).toThrow();
		expect(() => Schema.decodeUnknownSync(BacklogRecordedAtSchema)("2026-02-29T12:00:00.000Z")).toThrow();
		expect(() =>
			decodeEvent({
				schema_version: 1,
				event_id: "evt-bad-ts",
				issue_id: "tau-1",
				recorded_at: "2026-03-29T12:00:00Z",
				actor: "alice",
				kind: "issue.created",
				fields: { id: "tau-1", title: "One" },
			}),
		).toThrow();
		expect(() =>
			decodeEvent({
				schema_version: 1,
				event_id: "evt-impossible-ts",
				issue_id: "tau-1",
				recorded_at: "2026-02-29T12:00:00.000Z",
				actor: "alice",
				kind: "issue.created",
				fields: { id: "tau-1", title: "Impossible" },
			}),
		).toThrow();
	});

	it("orders replay by recorded_at then event_id", () => {
		const late = decodeEvent({
			schema_version: 1,
			event_id: "evt-200",
			issue_id: "tau-1",
			recorded_at: "2026-03-29T12:00:01.000Z",
			actor: "alice",
			kind: "issue.updated",
			set_fields: { status: "in_progress" },
			unset_fields: [],
		});
		const firstTieBreaker = decodeEvent({
			schema_version: 1,
			event_id: "evt-001",
			issue_id: "tau-1",
			recorded_at: "2026-03-29T12:00:00.000Z",
			actor: "alice",
			kind: "issue.created",
			fields: { id: "tau-1", title: "One" },
		});
		const secondTieBreaker = decodeEvent({
			schema_version: 1,
			event_id: "evt-002",
			issue_id: "tau-1",
			recorded_at: "2026-03-29T12:00:00.000Z",
			actor: "bob",
			kind: "issue.updated",
			set_fields: { priority: 1 },
			unset_fields: [],
		});

		expect(compareBacklogEvents(firstTieBreaker, secondTieBreaker)).toBeLessThan(0);
		expect(sortBacklogEvents([late, secondTieBreaker, firstTieBreaker]).map((event) => event.event_id)).toEqual([
			"evt-001",
			"evt-002",
			"evt-200",
		]);
	});

	it("replays concurrent same-issue edits with field-level last-write-wins", () => {
		const issue = Effect.runSync(replayBacklogEvents([
			decodeEvent({
				schema_version: 1,
				event_id: "evt-001",
				issue_id: "tau-1",
				recorded_at: "2026-03-29T12:00:00.000Z",
				actor: "alice",
				kind: "issue.created",
				fields: {
					id: "tau-1",
					title: "Backlog contract",
					priority: 2,
					status: "open",
				},
			}),
			decodeEvent({
				schema_version: 1,
				event_id: "evt-010",
				issue_id: "tau-1",
				recorded_at: "2026-03-29T12:01:00.000Z",
				actor: "bob",
				kind: "issue.updated",
				set_fields: { status: "in_progress" },
				unset_fields: [],
			}),
			decodeEvent({
				schema_version: 1,
				event_id: "evt-011",
				issue_id: "tau-1",
				recorded_at: "2026-03-29T12:01:00.000Z",
				actor: "carol",
				kind: "issue.updated",
				set_fields: { priority: 1, title: "Backlog contract v2" },
				unset_fields: [],
			}),
			decodeEvent({
				schema_version: 1,
				event_id: "evt-012",
				issue_id: "tau-1",
				recorded_at: "2026-03-29T12:01:00.000Z",
				actor: "dave",
				kind: "issue.updated",
				set_fields: { status: "blocked" },
				unset_fields: ["priority"],
			}),
		])).get("tau-1");

		expect(issue).toBeDefined();
		expect(issue?.fields).toEqual({
			id: "tau-1",
			title: "Backlog contract v2",
			status: "blocked",
		});
		expect(issue?.field_clock["status"]).toEqual({
			recorded_at: "2026-03-29T12:01:00.000Z",
			event_id: "evt-012",
			deleted: false,
		});
		expect(issue?.field_clock["priority"]).toEqual({
			recorded_at: "2026-03-29T12:01:00.000Z",
			event_id: "evt-012",
			deleted: true,
		});
	});

	it("preserves imported issue ids and unknown imported fields", () => {
		const issue = Effect.runSync(replayBacklogEvents([
			decodeEvent({
				schema_version: 1,
				event_id: "evt-import-001",
				issue_id: "tau-legacy-7",
				recorded_at: "2026-03-29T12:00:00.000Z",
				actor: "importer",
				kind: "issue.imported",
				source: {
					system: "legacy-import",
					issue_id: "tau-legacy-7",
				},
				fields: {
					id: "tau-legacy-7",
					title: "Imported",
					custom_payload: {
						nested: ["a", "b"],
					},
				},
			}),
		])).get("tau-legacy-7");

		expect(issue?.origin_kind).toBe("issue.imported");
		expect(issue?.fields["id"]).toBe("tau-legacy-7");
		expect(issue?.fields["custom_payload"]).toEqual({ nested: ["a", "b"] });
	});

	it("rejects updates before an origin event", () => {
		expect(() =>
				Effect.runSync(replayBacklogEvents([
					decodeEvent({
					schema_version: 1,
					event_id: "evt-002",
					issue_id: "tau-1",
					recorded_at: "2026-03-29T12:00:00.000Z",
					actor: "alice",
					kind: "issue.updated",
					set_fields: { status: "open" },
					unset_fields: [],
				}),
			])),
		).toThrow(BacklogContractValidationError);
	});
});
