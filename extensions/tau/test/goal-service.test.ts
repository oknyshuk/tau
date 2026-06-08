import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";

import type { AgentEndEvent, ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

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
				return yield* goal.create("session-1", "  ship\n\tgoal support  ", 1_000, null, {
					failIfExists: true,
				});
			}),
		);

		expect(snapshot.objective).toBe("ship\n\tgoal support");
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
		).rejects.toMatchObject({
			reason:
				"cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete",
		});
	});

	it("accepts and rehydrates a 4000 code point objective like codex", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);
		const objective = "😀".repeat(4_000);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.create("session-1", objective, null);
			}),
		);
		const entryData = harness.appended[0]?.data;
		if (entryData === undefined) {
			throw new Error("expected goal snapshot to be persisted");
		}
		const restored = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.rehydrate("session-2", [
					makeCustomEntry("goal", entryData),
				]);
			}),
		);

		expect(snapshot.objective).toBe(objective);
		expect(restored?.objective).toBe(objective);
	});

	it("refuses a model-created goal after the previous goal is complete", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		await expect(
			harness.run(
				Effect.gen(function* () {
					const goal = yield* Goal;
					yield* goal.create("session-1", "first", null, null, { failIfExists: true });
					yield* goal.setStatus("session-1", "complete");
					return yield* goal.create("session-1", "second", null, null, {
						failIfExists: true,
					});
				}),
			),
		).rejects.toMatchObject({
			reason:
				"cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete",
		});
	});

	it("updates an existing external goal after completion without replacing accounting", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "first", null, null, { failIfExists: true });
				yield* goal.markAgentStart("session-1", 0);
				yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(25, false),
					1_500,
				);
				const completed = yield* goal.setStatus("session-1", "complete");
				const updated = yield* goal.create("session-1", "second", null, null);
				return { completed, updated };
			}),
		);

		expect(result.updated.objective).toBe("second");
		expect(result.updated.status).toBe("active");
		expect(result.updated.tokensUsed).toBe(25);
		expect(result.updated.timeUsedSeconds).toBe(1);
		expect(result.updated.createdAt).toBe(result.completed?.createdAt);
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

	it("budget-limits an over-budget active goal during rehydration", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);
		const restored = {
			...makeGoalSnapshot(
				"ship goal support",
				100,
				null,
				"2026-05-01T00:00:00.000Z",
			),
			tokensUsed: 100,
		};

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.rehydrate("session-1", [
					makeCustomEntry("a", { version: 2, snapshot: restored }),
				]);
			}),
		);

		expect(snapshot?.status).toBe("budget_limited");
		expect(snapshot?.tokensUsed).toBe(100);
		expect(snapshot?.budgetLimitPromptSent).toBe(false);
	});

	it("restores idle accounting for an active rehydrated goal", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);
		const restored = makeGoalSnapshot(
			"ship goal support",
			null,
			null,
			"2026-05-01T00:00:00.000Z",
		);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.rehydrate("session-1", [
					makeCustomEntry("a", { version: 2, snapshot: restored }),
				]);
				yield* goal.restoreAfterResume("session-1", 1_000);
				const live = yield* goal.liveSnapshot("session-1", 2_600);
				const prepared = yield* goal.prepareExternalMutation("session-1", 2_600);
				return { live, prepared };
			}),
		);

		expect(result.live?.timeUsedSeconds).toBe(1);
		expect(result.prepared.snapshot?.timeUsedSeconds).toBe(1);
	});

	it("keeps restored idle accounting when an agent turn starts", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);
		const restored = makeGoalSnapshot(
			"ship goal support",
			null,
			null,
			"2026-05-01T00:00:00.000Z",
		);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.rehydrate("session-1", [
					makeCustomEntry("a", { version: 2, snapshot: restored }),
				]);
				yield* goal.restoreAfterResume("session-1", 1_000);
				yield* goal.markAgentStart("session-1", 2_000);
				return yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(10, false),
					3_500,
				);
			}),
		);

		expect(result.snapshot?.tokensUsed).toBe(10);
		expect(result.snapshot?.timeUsedSeconds).toBe(2);
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

	it("excludes cached reads and total tokens from goal token accounting", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", 700);
				yield* goal.markAgentStart("session-1", 0);
				const message = makeAssistantMessage(0, false);
				return yield* goal.accountTurnEnd(
					"session-1",
					{
						...message,
						usage: {
							...message.usage,
							input: 500,
							output: 80,
							cacheRead: 400,
							cacheWrite: 30,
							totalTokens: 1_010,
						},
					},
					1_000,
				);
			}),
		);

		expect(result.snapshot?.tokensUsed).toBe(610);
		expect(result.snapshot?.status).toBe("active");
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

	for (const status of ["active", "paused", "blocked"] as const) {
		it(`keeps an over-budget goal budget-limited when setting ${status}`, async () => {
			const harness = makeGoalRuntime();
			runtimes.push(harness);

			const result = await harness.run(
				Effect.gen(function* () {
					const goal = yield* Goal;
					yield* goal.create("session-1", "finish", 40);
					yield* goal.markAgentStart("session-1", 0);
					const limited = yield* goal.accountTurnEnd(
						"session-1",
						makeAssistantMessage(50, false),
						1_000,
					);
					const updated = yield* goal.setStatus("session-1", status);
					return { limited, updated };
				}),
			);

			expect(result.limited.snapshot?.status).toBe("budget_limited");
			expect(result.updated?.status).toBe("budget_limited");
			expect(result.updated?.tokensUsed).toBe(50);
			expect(harness.appended).toHaveLength(3);
		});
	}

	for (const status of ["active", "paused", "blocked"] as const) {
		it(`keeps a time-over-budget goal budget-limited when setting ${status}`, async () => {
			const harness = makeGoalRuntime();
			runtimes.push(harness);

			const result = await harness.run(
				Effect.gen(function* () {
					const goal = yield* Goal;
					yield* goal.create("session-1", "finish", null, 5);
					yield* goal.markAgentStart("session-1", 0);
					const limited = yield* goal.accountAgentEnd(
						"session-1",
						makeAgentEnd(0),
						5_000,
					);
					const updated = yield* goal.setStatus("session-1", status);
					return { limited, updated };
				}),
			);

			expect(result.limited.snapshot?.status).toBe("budget_limited");
			expect(result.updated?.status).toBe("budget_limited");
			expect(result.updated?.timeUsedSeconds).toBe(5);
			expect(harness.appended).toHaveLength(3);
		});
	}

	it("keeps timing a budget-limited wrap-up turn until agent end", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", 1);
				yield* goal.markAgentStart("session-1", 0);
				const limited = yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(1, false),
					1_000,
				);
				const liveDuringWrapUp = yield* goal.liveSnapshot("session-1", 2_500);
				const stopped = yield* goal.accountAgentEnd(
					"session-1",
					makeAgentEnd(0),
					2_500,
				);
				const liveAfterStop = yield* goal.liveSnapshot("session-1", 6_000);
				return { limited, liveDuringWrapUp, stopped, liveAfterStop };
			}),
		);

		expect(result.limited.snapshot?.status).toBe("budget_limited");
		expect(result.limited.snapshot?.timeUsedSeconds).toBe(1);
		expect(result.liveDuringWrapUp?.status).toBe("budget_limited");
		expect(result.liveDuringWrapUp?.timeUsedSeconds).toBe(2);
		expect(result.stopped.snapshot?.timeUsedSeconds).toBe(2);
		expect(result.liveAfterStop?.status).toBe("budget_limited");
		expect(result.liveAfterStop?.timeUsedSeconds).toBe(2);
	});

	it("does not append a new event when the budget-limit prompt is already marked sent", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", 100);
				yield* goal.markAgentStart("session-1", 0);
				yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(150, false),
					0,
				);
				const first = yield* goal.markBudgetLimitPromptSent("session-1");
				const second = yield* goal.markBudgetLimitPromptSent("session-1");
				return { first, second };
			}),
		);

		expect(result.first?.budgetLimitPromptSent).toBe(true);
		expect(result.second?.budgetLimitPromptSent).toBe(true);
		expect(harness.appended).toHaveLength(3);
	});

	it("starts model-created goal accounting from the creating turn", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null, null, {
					startActiveAccountingAtMs: 0,
				});
				const createTurn = yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(100, true),
					1_000,
				);
				const createAgentEnd = yield* goal.accountAgentEnd(
					"session-1",
					makeAgentEnd(0, true),
					2_500,
				);
				yield* goal.markAgentStart("session-1", 3_000);
				const nextTurn = yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(25, false),
					4_500,
				);
				return { createTurn, createAgentEnd, nextTurn };
			}),
		);

		expect(result.createTurn.snapshot?.status).toBe("active");
		expect(result.createTurn.snapshot?.tokensUsed).toBe(100);
		expect(result.createTurn.snapshot?.timeUsedSeconds).toBe(1);
		expect(result.createAgentEnd.snapshot?.status).toBe("active");
		expect(result.createAgentEnd.snapshot?.tokensUsed).toBe(100);
		expect(result.createAgentEnd.snapshot?.timeUsedSeconds).toBe(2);
		expect(result.nextTurn.snapshot?.tokensUsed).toBe(125);
		expect(result.nextTurn.snapshot?.timeUsedSeconds).toBe(3);
	});

	it("accounts the terminal turn after update_goal completes the goal", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.markAgentStart("session-1", 0);
				yield* goal.setStatus("session-1", "complete", {
					accountCurrentTurn: true,
				});
				const turnResult = yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(40, true),
					2_500,
				);
				const endResult = yield* goal.accountAgentEnd(
					"session-1",
					makeAgentEnd(0),
					5_000,
				);
				return { turnResult, endResult };
			}),
		);

		expect(result.turnResult.snapshot?.status).toBe("complete");
		expect(result.turnResult.snapshot?.tokensUsed).toBe(40);
		expect(result.turnResult.snapshot?.timeUsedSeconds).toBe(2);
		expect(result.endResult.snapshot).toBeNull();
		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);
		expect(snapshot?.status).toBe("complete");
		expect(snapshot?.tokensUsed).toBe(40);
		expect(snapshot?.timeUsedSeconds).toBe(2);
	});

	it("accounts the terminal turn after update_goal blocks the goal", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.markAgentStart("session-1", 0);
				yield* goal.setStatus("session-1", "blocked", {
					accountCurrentTurn: true,
				});
				return yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(23, true),
					1_000,
				);
			}),
		);

		expect(result.snapshot?.status).toBe("blocked");
		expect(result.snapshot?.tokensUsed).toBe(23);
		expect(result.snapshot?.timeUsedSeconds).toBe(1);
	});

	it("preserves terminal accounting when blocked status is repeated before turn end", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.markAgentStart("session-1", 0);
				yield* goal.setStatus("session-1", "blocked", {
					accountCurrentTurn: true,
				});
				yield* goal.setStatus("session-1", "blocked", {
					accountCurrentTurn: true,
				});
				return yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(23, false),
					1_500,
				);
			}),
		);

		expect(result.snapshot?.status).toBe("blocked");
		expect(result.snapshot?.tokensUsed).toBe(23);
		expect(result.snapshot?.timeUsedSeconds).toBe(1);
		expect(harness.appended).toHaveLength(3);
	});

	it("does not account later turns after a manual terminal status update", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.setStatus("session-1", "complete");
				return yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(40, false),
					2_000,
				);
			}),
		);

		expect(result.snapshot).toBeNull();
		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);
		expect(snapshot?.status).toBe("complete");
		expect(snapshot?.tokensUsed).toBe(0);
		expect(snapshot?.timeUsedSeconds).toBe(0);
	});

	it("updates a completed goal status explicitly like codex", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.setStatus("session-1", "complete");
				return yield* goal.setStatus("session-1", "paused");
			}),
		);

		expect(snapshot?.status).toBe("paused");
		expect(harness.appended).toHaveLength(3);
	});

	it("persists repeated complete status updates like codex", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.setStatus("session-1", "complete");
				return yield* goal.setStatus("session-1", "complete");
			}),
		);

		expect(snapshot?.status).toBe("complete");
		expect(harness.appended).toHaveLength(3);
	});

	it("does not append a new event when setting the same paused status", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.setStatus("session-1", "paused");
				return yield* goal.setStatus("session-1", "paused");
			}),
		);

		expect(snapshot?.status).toBe("paused");
		expect(harness.appended).toHaveLength(2);
	});

	it("starts resumed accounting from the next agent start after a direct pause", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.markAgentStart("session-1", 0);
				yield* goal.setStatus("session-1", "paused");
				yield* goal.setStatus("session-1", "active");
				yield* goal.markAgentStart("session-1", 5_000);
				return yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(10, false),
					7_000,
				);
			}),
		);

		expect(result.snapshot?.status).toBe("active");
		expect(result.snapshot?.timeUsedSeconds).toBe(2);
		expect(result.snapshot?.tokensUsed).toBe(10);
	});

	it("does not append a new event when setting unchanged active status", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				return yield* goal.setStatus("session-1", "active");
			}),
		);

		expect(snapshot?.status).toBe("active");
		expect(snapshot?.budgetLimitPromptSent).toBe(false);
		expect(harness.appended).toHaveLength(1);
	});

	it("does not append a new event when clearing a missing goal", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.clear("session-1");
				yield* goal.create("session-1", "finish", null);
				yield* goal.clear("session-1");
				yield* goal.clear("session-1");
			}),
		);

		expect(harness.appended).toHaveLength(2);
		expect(harness.appended[1]?.data).toEqual({
			version: 2,
			snapshot: null,
		});
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

	it("does not append a new event when creating the same unchanged active goal", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", 100);
				return yield* goal.create("session-1", "finish", 100);
			}),
		);

		expect(snapshot.status).toBe("active");
		expect(snapshot.objective).toBe("finish");
		expect(snapshot.tokenBudget).toBe(100);
		expect(snapshot.budgetLimitPromptSent).toBe(false);
		expect(harness.appended).toHaveLength(1);
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
		expect(harness.appended).toHaveLength(3);
	});

	it("budget-limits the same command goal when an updated token budget is already spent", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", 100);
				yield* goal.markAgentStart("session-1", 0);
				yield* goal.accountTurnEnd("session-1", makeAssistantMessage(25, false), 1_500);
				return yield* goal.create("session-1", "finish", 10);
			}),
		);

		expect(snapshot.status).toBe("budget_limited");
		expect(snapshot.tokenBudget).toBe(10);
		expect(snapshot.tokensUsed).toBe(25);
		expect(snapshot.budgetLimitPromptSent).toBe(false);
		expect(harness.appended).toHaveLength(3);
	});

	it("accounts active progress before an external goal objective update", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "old goal", null);
				yield* goal.markAgentStart("session-1", 0);
				const prepared = yield* goal.prepareExternalMutation("session-1", 2_500);
				const replacement = yield* goal.create("session-1", "new goal", null, null, {
					startActiveAccountingAtMs: 2_500,
				});
				const nextTurn = yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(10, false),
					4_000,
				);
				return { prepared, replacement, nextTurn };
			}),
		);

		expect(result.prepared.snapshot?.objective).toBe("old goal");
		expect(result.prepared.snapshot?.timeUsedSeconds).toBe(2);
		expect(result.replacement.objective).toBe("new goal");
		expect(result.replacement.timeUsedSeconds).toBe(2);
		expect(result.nextTurn.snapshot?.objective).toBe("new goal");
		expect(result.nextTurn.snapshot?.tokensUsed).toBe(10);
		expect(result.nextTurn.snapshot?.timeUsedSeconds).toBe(3);
	});

	it("accounts aborted assistant messages without changing goal status", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.markAgentStart("session-1", 0);
				return yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(25, false, "aborted"),
					1_000,
				);
			}),
		);

		expect(result.snapshot?.status).toBe("active");
		expect(result.snapshot?.tokensUsed).toBe(25);
		expect(result.snapshot?.timeUsedSeconds).toBe(1);
	});

	it("accounts usage-limit error progress before marking usage-limited", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", null);
				yield* goal.markAgentStart("session-1", 0);
				const limited = yield* goal.markUsageLimited(
					"session-1",
					makeAssistantMessage(23, false, "error"),
					1_500,
				);
				const laterTurn = yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(50, false),
					3_000,
				);
				const snapshot = yield* goal.get("session-1");
				return { limited, laterTurn, snapshot };
			}),
		);

		expect(result.limited?.status).toBe("usage_limited");
		expect(result.limited?.tokensUsed).toBe(23);
		expect(result.limited?.timeUsedSeconds).toBe(1);
		expect(result.laterTurn.snapshot).toBeNull();
		expect(result.snapshot?.tokensUsed).toBe(23);
	});

	it("accounts budget-limited wrap-up progress before marking usage-limited", async () => {
		const harness = makeGoalRuntime();
		runtimes.push(harness);

		const result = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.create("session-1", "finish", 25);
				yield* goal.markAgentStart("session-1", 0);
				const budgetLimited = yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(30, true, "toolUse"),
					1_000,
				);
				const usageLimited = yield* goal.markUsageLimited(
					"session-1",
					makeAssistantMessage(5, false, "error"),
					1_500,
				);
				const laterTurn = yield* goal.accountTurnEnd(
					"session-1",
					makeAssistantMessage(50, false),
					3_000,
				);
				const snapshot = yield* goal.get("session-1");
				return { budgetLimited, usageLimited, laterTurn, snapshot };
			}),
		);

		expect(result.budgetLimited.snapshot?.status).toBe("budget_limited");
		expect(result.budgetLimited.snapshot?.tokensUsed).toBe(30);
		expect(result.usageLimited?.status).toBe("usage_limited");
		expect(result.usageLimited?.tokensUsed).toBe(35);
		expect(result.laterTurn.snapshot).toBeNull();
		expect(result.snapshot?.tokensUsed).toBe(35);
	});

});
