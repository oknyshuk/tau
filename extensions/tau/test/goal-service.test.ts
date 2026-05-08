import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";

import type { AgentEndEvent, ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import { PiAPILive } from "../src/effect/pi.js";
import { GOAL_ENTRY_TYPE, makeGoalSnapshot } from "../src/goal/schema.js";
import { Goal, GoalLive } from "../src/services/goal.js";

type AppendedEntry = {
	readonly customType: string;
	readonly data: unknown;
};

type GoalRuntimeHarness = {
	readonly run: <A, E>(effect: Effect.Effect<A, E, Goal>) => Promise<A>;
	readonly dispose: () => Promise<void>;
	readonly appended: ReadonlyArray<AppendedEntry>;
};

function makeGoalRuntime(): GoalRuntimeHarness {
	const appended: AppendedEntry[] = [];
	const pi = {
		appendEntry: (customType: string, data?: unknown) => {
			appended.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	const runtime = ManagedRuntime.make(GoalLive.pipe(Layer.provide(PiAPILive(pi))));
	return {
		run: (effect) => runtime.runPromise(effect),
		dispose: () => runtime.dispose(),
		appended,
	};
}

function makeAssistantMessage(
	tokens: number,
	withToolCall: boolean,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		content: withToolCall
			? [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]
			: [{ type: "text", text: "done" }],
		usage: {
			input: tokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason,
		timestamp: 0,
	};
}

function makeAgentEnd(tokens: number, withToolCall = false): AgentEndEvent {
	return {
		type: "agent_end",
		messages: [makeAssistantMessage(tokens, withToolCall)],
	};
}

function makeAbortedAgentEndAfterToolCall(): AgentEndEvent {
	return {
		type: "agent_end",
		messages: [
			makeAssistantMessage(0, true, "toolUse"),
			makeAssistantMessage(0, false, "aborted"),
		],
	};
}

function makeCustomEntry(id: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-05-01T00:00:00.000Z",
		customType: GOAL_ENTRY_TYPE,
		data,
	};
}

describe("goal service", () => {
	const runtimes: GoalRuntimeHarness[] = [];

	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) {
			await runtime.dispose();
		}
	});

	it("persists a created goal and refuses duplicate model-created goals", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.create("session-1", "  ship goal support  ", 1_000, null, {
					failIfExists: true,
				});
			}),
		);

		expect(snapshot.objective).toBe("ship goal support");
		expect(snapshot.tokenBudget).toBe(1_000);
		expect(harness.appended).toHaveLength(1);
		expect(harness.appended[0]?.customType).toBe(GOAL_ENTRY_TYPE);

		await expect(
			harness.run(
				Effect.gen(function* () {
					const goal = yield* Goal;
					return yield* goal.create("session-1", "replace", null, null, {
						failIfExists: true,
					});
				}),
			),
		).rejects.toMatchObject({ reason: "a thread goal already exists" });
	});

	it("allows a model-created goal after the previous goal is complete", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "first", null, null, { failIfExists: true });
				yield* goal.setStatus("session-1", "complete");
				return yield* goal.create("session-1", "second", null, null, { failIfExists: true });
			}),
		);

		expect(snapshot.objective).toBe("second");
		expect(snapshot.status).toBe("active");
	});

	it("rehydrates the latest goal entry on the active branch", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);
		const first = makeGoalSnapshot("first", null, null, "2026-05-01T00:00:00.000Z");
		const second = makeGoalSnapshot("second", 100, null, "2026-05-01T00:01:00.000Z");

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.rehydrate("session-1", [
					makeCustomEntry("a", { version: 2, snapshot: first }),
					makeCustomEntry("b", { version: 2, snapshot: second }),
				]);
			}),
		);

		expect(snapshot?.objective).toBe("second");
		expect(snapshot?.tokenBudget).toBe(100);
	});

	it("rejects old goal entry versions with a clear error", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		await expect(
			harness.run(
				Effect.gen(function* () {
					const goal = yield* Goal;
					return yield* goal.rehydrate("session-1", [
						makeCustomEntry("a", {
							version: 1,
							snapshot: {
								objective: "old",
								status: "active",
								tokenBudget: null,
								tokensUsed: 0,
								timeUsedSeconds: 0,
								createdAt: "2026-05-01T00:00:00.000Z",
								updatedAt: "2026-05-01T00:00:00.000Z",
								continuationSuppressed: false,
								budgetLimitPromptSent: false,
							},
						}),
					]);
				}),
			),
		).rejects.toMatchObject({ reason: expect.stringContaining("unsupported goal entry version 1") });
	});

	it("accounts turn usage and budget-limits the goal before agent end", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", 100);
				yield* goal.markAgentStart("session-1", 0);
				return yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(150, false),
					2_500,
				);
			}),
		);

		expect(result.budgetLimitReached).toBe(true);
		expect(result.snapshot?.status).toBe("budget_limited");
		expect(result.snapshot?.tokensUsed).toBe(150);
		expect(result.snapshot?.timeUsedSeconds).toBe(2);
	});

	it("budget-limits the goal when time budget is reached", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null, 5);
				yield* goal.markAgentStart("session-1", 0);
				return yield* goal.accountAgentEnd("session-1", makeAgentEnd(0), 5_000);
			}),
		);

		expect(result.budgetLimitReached).toBe(true);
		expect(result.snapshot?.status).toBe("budget_limited");
		expect(result.snapshot?.timeUsedSeconds).toBe(5);
	});

	it("returns a live snapshot while a goal turn is running", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.markAgentStart("session-1", 1_000);
				return yield* goal.liveSnapshot("session-1", 6_200);
			}),
		);

		expect(snapshot?.timeUsedSeconds).toBe(5);
	});

	it("updates the same non-complete command goal without replacing accounting", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", 100);
				yield* goal.markAgentStart("session-1", 0);
				yield* goal.accountTurnEnd("session-1", makeAssistantMessage(25, false), 1_500);
				return yield* goal.create("session-1", "finish", 200);
			}),
		);

		expect(snapshot.status).toBe("active");
		expect(snapshot.tokenBudget).toBe(200);
		expect(snapshot.tokensUsed).toBe(25);
		expect(snapshot.timeUsedSeconds).toBe(1);
	});

	it("suppresses repeated continuation when a dispatched continuation did no tool work", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.markContinuationDispatched("session-1");
				return yield* goal.accountAgentEnd("session-1", makeAgentEnd(25), 1_000);
			}),
		);

		expect(result.snapshot?.continuationSuppressed).toBe(true);
	});

	it("suppresses repeated continuation when a dispatched continuation is aborted after tool work", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.markContinuationDispatched("session-1");
				return yield* goal.accountAgentEnd(
					"session-1",
					makeAbortedAgentEndAfterToolCall(),
					1_000,
				);
			}),
		);

		expect(result.snapshot?.status).toBe("paused");
		expect(result.snapshot?.continuationSuppressed).toBe(true);
	});

	it("pauses the goal when an active turn ends with an aborted assistant message", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.markAgentStart("session-1", 0);
				return yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(0, false, "aborted"),
					1_000,
				);
			}),
		);

		expect(result.snapshot?.status).toBe("paused");
		expect(result.snapshot?.continuationSuppressed).toBe(true);
	});
});
