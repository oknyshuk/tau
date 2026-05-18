import { DateTime, Effect, Fiber, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

import {
	_createTurnLimitGuard as createTurnLimitGuard,
	_isAssistantMessage as isAssistantMessage,
} from "../src/dream/subagent.js";
import {
	buildDreamPrompt,
	_formatMemorySnapshotForPrompt as formatMemorySnapshotForPrompt,
} from "../src/dream/prompt.js";
import { DreamFinishParams } from "../src/dream/domain.js";
import { createMemoryEntry, type MemoryEntriesSnapshot, type MemoryBucketEntriesSnapshot } from "../src/memory/format.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(id: string, scope: "project" | "global" | "user", content: string) {
	return createMemoryEntry(content, {
		id,
		scope,
		summary: `${scope} hook ${id}`,
		now: DateTime.makeUnsafe("2025-01-01T00:00:00Z"),
	});
}

function makeBucket(
	bucket: "project" | "global" | "user",
	entries: ReturnType<typeof makeEntry>[] = [],
	limitChars = 25_000,
): MemoryBucketEntriesSnapshot {
	const chars = entries.reduce((sum, e) => sum + e.content.length, 0);
	return {
		bucket,
		path: `/fake/.pi/tau/memories/${bucket.toUpperCase()}.jsonl`,
		entries,
		chars,
		limitChars,
		usagePercent: Math.round((chars / limitChars) * 100),
	};
}

function makeSnapshot(
	overrides: Partial<Record<"project" | "global" | "user", ReturnType<typeof makeEntry>[]>> = {},
): MemoryEntriesSnapshot {
	return {
		project: makeBucket("project", overrides.project ?? []),
		global: makeBucket("global", overrides.global ?? []),
		user: makeBucket("user", overrides.user ?? [], 25_000),
	};
}

// ---------------------------------------------------------------------------
// isAssistantMessage
// ---------------------------------------------------------------------------

describe("isAssistantMessage", () => {
	it("accepts an object with role=assistant and array content", () => {
		expect(
			isAssistantMessage({
				role: "assistant",
				content: [{ type: "text", text: "hello" }],
			}),
		).toBe(true);
	});

	it("rejects a user message", () => {
		expect(isAssistantMessage({ role: "user", content: [] })).toBe(false);
	});

	it("rejects null", () => {
		expect(isAssistantMessage(null)).toBe(false);
	});

	it("rejects missing content", () => {
		expect(isAssistantMessage({ role: "assistant" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// turn limit guard
// ---------------------------------------------------------------------------

describe("createTurnLimitGuard", () => {
	it("allows exactly maxTurns turn_start events before aborting", async () => {
		const listeners: Array<(event: AgentEvent, signal: AbortSignal) => void> = [];
		let aborts = 0;
		const turnStartEvent = { type: "turn_start" } as unknown as AgentEvent;

		const guard = createTurnLimitGuard(
			{
				agent: {
					subscribe: (listener) => {
						listeners.push(listener);
						return () => undefined;
					},
				},
				abort: async () => {
					aborts += 1;
				},
			},
			1,
		);

		const guardPromise = Effect.runPromise(guard);

		listeners[0]?.(turnStartEvent, new AbortController().signal);
		expect(aborts).toBe(0);

		listeners[0]?.(turnStartEvent, new AbortController().signal);

		await expect(guardPromise).resolves.toEqual({
			_tag: "turn_limit_exceeded",
			maxTurns: 1,
		});
		expect(aborts).toBe(1);
	});

	it("unsubscribes the turn listener when interrupted", async () => {
		let unsubscribed = 0;

		const fiber = Effect.runFork(
			createTurnLimitGuard(
				{
					agent: {
						subscribe: () => {
							return () => {
								unsubscribed += 1;
							};
						},
					},
					abort: async () => undefined,
				},
				10,
			),
		);

		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(unsubscribed).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// formatMemorySnapshotForPrompt
// ---------------------------------------------------------------------------

describe("formatMemorySnapshotForPrompt", () => {
	it("formats an empty snapshot", () => {
		const text = formatMemorySnapshotForPrompt(makeSnapshot());
		expect(text).toContain("(empty)");
		expect(text).toContain("### project");
		expect(text).toContain("### global");
		expect(text).toContain("### user");
	});

	it("includes entry ids and summary hooks", () => {
		const entry = makeEntry("abc123456789", "project", "Some durable fact");
		const text = formatMemorySnapshotForPrompt(
			makeSnapshot({ project: [entry] }),
		);
		expect(text).toContain("[abc123456789]");
		expect(text).toContain("project hook abc123456789");
		expect(text).not.toContain("Some durable fact");
	});

	it("includes usage stats", () => {
		const text = formatMemorySnapshotForPrompt(makeSnapshot());
		expect(text).toContain("0/25000 chars");
	});
});

// ---------------------------------------------------------------------------
// buildDreamPrompt
// ---------------------------------------------------------------------------

describe("buildDreamPrompt", () => {
	it("directs dream to curate memory scopes without reading thread transcripts", () => {
		const prompt = buildDreamPrompt({
			runId: "dream-run-1",
			mode: "manual",
			nowIso: "2025-01-01T00:00:00Z",
			memorySnapshot: makeSnapshot({
				global: [makeEntry("glob12345678", "global", "Project uses npm run gate")],
				user: [makeEntry("user12345678", "user", "User is in Poland")],
			}),
		});

		expect(prompt).not.toContain("Transcript paths to review");
		expect(prompt).not.toContain("Read the transcript files");
		expect(prompt).not.toContain("read_thread");
		expect(prompt).not.toContain("find_thread");
		expect(prompt).toContain("Do not read thread or session transcripts");
		expect(prompt).toContain("Move misplaced entries to the correct scope");
		expect(prompt).toContain("project: workspace-specific facts");
		expect(prompt).toContain("global: cross-project facts");
		expect(prompt).toContain("user: who the user is");
	});
});

// ---------------------------------------------------------------------------
// DreamFinishParams schema decoding
// ---------------------------------------------------------------------------

describe("DreamFinishParams schema", () => {
	const decode = Schema.decodeUnknownSync(DreamFinishParams);

	it("decodes a valid finish params", () => {
		const params = decode({
			runId: "abc123",
			summary: "Consolidated 3 sessions",
			reviewedSessions: ["sess-1", "sess-2"],
			noChanges: false,
		});

		expect(params.runId).toBe("abc123");
		expect(params.summary).toBe("Consolidated 3 sessions");
		expect(params.reviewedSessions).toEqual(["sess-1", "sess-2"]);
		expect(params.noChanges).toBe(false);
	});

	it("decodes params with no changes", () => {
		const params = decode({
			runId: "xyz789",
			summary: "No changes needed",
			reviewedSessions: [],
			noChanges: true,
		});
		expect(params.noChanges).toBe(true);
		expect(params.reviewedSessions).toEqual([]);
	});

	it("rejects missing runId", () => {
		expect(() =>
			decode({
				summary: "Bad",
				reviewedSessions: [],
				noChanges: false,
			}),
		).toThrow();
	});

	it("rejects missing summary", () => {
		expect(() =>
			decode({
				runId: "abc",
				reviewedSessions: [],
				noChanges: false,
			}),
		).toThrow();
	});
});
