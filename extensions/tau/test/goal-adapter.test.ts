import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";

import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import { PiAPILive } from "../src/effect/pi.js";
import initGoal from "../src/goal/index.js";
import { GOAL_ENTRY_TYPE, makeGoalSnapshot } from "../src/goal/schema.js";
import { Goal, GoalLive } from "../src/services/goal.js";

type RegisteredCommand = {
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type SentMessage = {
	readonly message: {
		readonly customType: string;
		readonly content: unknown;
		readonly display: boolean;
		readonly details?: unknown;
	};
	readonly options?: {
		readonly triggerTurn?: boolean;
		readonly deliverAs?: "steer" | "followUp" | "nextTurn";
	};
};

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

type GoalAdapterHarness = {
	readonly commands: Map<string, RegisteredCommand>;
	readonly tools: Map<string, ToolDefinition>;
	readonly events: Map<string, EventHandler[]>;
	readonly sentMessages: SentMessage[];
	readonly notifications: ReadonlyArray<{ readonly message: string; readonly type: string }>;
	readonly confirmations: ReadonlyArray<{ readonly title: string; readonly message: string }>;
	readonly ctx: ExtensionCommandContext;
	readonly run: <A, E>(effect: Effect.Effect<A, E, Goal>) => Promise<A>;
	readonly dispose: () => Promise<void>;
};

function makeGoalAdapterHarness(): GoalAdapterHarness {
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, ToolDefinition>();
	const events = new Map<string, EventHandler[]>();
	const sentMessages: SentMessage[] = [];
	const notifications: Array<{ readonly message: string; readonly type: string }> = [];
	const confirmations: Array<{ readonly title: string; readonly message: string }> = [];
	const piBase = {
		on: (name: string, handler: EventHandler) => {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		registerCommand: (name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		},
		sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
			sentMessages.push(options === undefined ? { message } : { message, options });
		},
		appendEntry: () => undefined,
	} as unknown as ExtensionAPI;
	const runtime = ManagedRuntime.make(GoalLive.pipe(Layer.provide(PiAPILive(piBase))));
	initGoal(piBase, {
		runPromise: (effect) => runtime.runPromise(effect),
		runFork: (effect) => runtime.runFork(effect),
	});

	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [],
		},
		ui: {
			notify: (message: string, type: string) => {
				notifications.push({ message, type });
			},
			confirm: async (title: string, message: string) => {
				confirmations.push({ title, message });
				return true;
			},
			setStatus: () => undefined,
			setWidget: () => undefined,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionCommandContext;

	return {
		commands,
		tools,
		events,
		sentMessages,
		notifications,
		confirmations,
		ctx,
		run: (effect) => runtime.runPromise(effect),
		dispose: () => runtime.dispose(),
	};
}

function makeAssistantMessage(
	tokens: number,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		content: [{ type: "text", text: "done" }],
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

function makeAssistantToolCallMessage(tokens = 0): AssistantMessage {
	return {
		...makeAssistantMessage(tokens),
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
		stopReason: "toolUse",
	};
}

function makeErrorAssistantMessage(errorMessage: string, tokens = 0): AssistantMessage {
	return {
		...makeAssistantMessage(tokens, "error"),
		content: [{ type: "text", text: errorMessage }],
		errorMessage,
	};
}

function makeAbortedPiContext(ctx: ExtensionContext): ExtensionContext {
	const controller = new AbortController();
	controller.abort();
	return {
		...ctx,
		signal: controller.signal,
	} as ExtensionContext;
}

function makePiSignalContext(
	ctx: ExtensionContext,
	controller: AbortController,
): ExtensionContext {
	return {
		...ctx,
		signal: controller.signal,
	} as ExtensionContext;
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

function flushPromises(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function fireEvent(
	harness: GoalAdapterHarness,
	name: string,
	event: unknown,
	ctx: ExtensionContext = harness.ctx,
): Promise<unknown[]> {
	const results: unknown[] = [];
	for (const handler of harness.events.get(name) ?? []) {
		results.push(await handler(event, ctx));
	}
	return results;
}

async function runGoalCommand(
	harness: GoalAdapterHarness,
	args: string,
	ctx: ExtensionCommandContext = harness.ctx,
): Promise<void> {
	const command = harness.commands.get("goal");
	if (command === undefined) {
		throw new Error("goal command was not registered");
	}
	await command.handler(args, ctx);
}

function parseToolJsonResult(result: {
	readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}): unknown {
	const item = result.content[0];
	if (item?.type !== "text" || item.text === undefined) {
		throw new Error("expected tool to return text JSON content");
	}
	return JSON.parse(item.text) as unknown;
}

function expectClosedSchema(value: unknown): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected parameter schema object");
	}
	expect((value as { readonly additionalProperties?: unknown }).additionalProperties).toBe(
		false,
	);
}

function expectTextResultContains(
	result: { readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }> },
	expected: string,
): void {
	const item = result.content[0];
	if (item?.type !== "text") {
		throw new Error("expected tool to return text content");
	}
	expect(item.text).toContain(expected);
}

describe("goal adapter", () => {
	const harnesses: GoalAdapterHarness[] = [];

	afterEach(async () => {
		vi.useRealTimers();
		for (const harness of harnesses.splice(0)) {
			await harness.dispose();
		}
	});

	it("starts an idle agent turn after setting a goal from /goal", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "ship the feature");

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-continuation");
		expect(harness.sentMessages[0]?.message.display).toBe(false);
		expect(harness.sentMessages[0]?.message.content).toContain("ship the feature");
		expect(harness.sentMessages[0]?.options).toEqual({
			triggerTurn: true,
			deliverAs: "followUp",
		});
	});

	it("sets a time budget from /goal", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "--time-budget 5m ship the feature");

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.objective).toBe("ship the feature");
		expect(snapshot?.timeBudgetSeconds).toBe(300);
	});

	it("uses codex-style closed schemas for goal tool parameters", () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		for (const name of ["get_goal", "create_goal", "update_goal"]) {
			const tool = harness.tools.get(name);
			if (tool === undefined) {
				throw new Error(name + " tool was not registered");
			}
			expectClosedSchema(tool.parameters);
		}
	});

	it("rejects unknown model-facing goal tool parameters", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const getGoal = harness.tools.get("get_goal");
		const createGoal = harness.tools.get("create_goal");
		const updateGoal = harness.tools.get("update_goal");
		if (getGoal === undefined || createGoal === undefined || updateGoal === undefined) {
			throw new Error("goal tools were not registered");
		}

		const getResult = await getGoal.execute(
			"call-get-goal",
			{ extra: true },
			undefined,
			undefined,
			harness.ctx,
		);
		const createResult = await createGoal.execute(
			"call-create-goal",
			{ objective: "ship the feature", extra: true },
			undefined,
			undefined,
			harness.ctx,
		);
		const updateResult = await updateGoal.execute(
			"call-update-goal",
			{ status: "blocked", reason: "waiting" },
			undefined,
			undefined,
			harness.ctx,
		);

		expect("isError" in getResult && getResult.isError === true).toBe(true);
		expect("isError" in createResult && createResult.isError === true).toBe(true);
		expect("isError" in updateResult && updateResult.isError === true).toBe(true);
		expectTextResultContains(getResult, "unknown parameter: extra");
		expectTextResultContains(createResult, "unknown parameter: extra");
		expectTextResultContains(updateResult, "unknown parameter: reason");
	});

	it("rejects time budgets from the model-facing create_goal tool", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const tool = harness.tools.get("create_goal");
		if (tool === undefined) {
			throw new Error("create_goal tool was not registered");
		}

		const result = await tool.execute(
			"call-create-goal",
			{
				objective: "ship the feature",
				time_budget_seconds: 300,
			},
			undefined,
			undefined,
			harness.ctx,
		);

		expect("isError" in result && result.isError === true).toBe(true);
		const item = result.content[0];
		if (item?.type !== "text") {
			throw new Error("expected create_goal to return text content");
		}
		expect(item.text).toContain("time_budget_seconds is not supported by create_goal");
	});

	it("starts model-created goal accounting after the create_goal caller turn", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const tool = harness.tools.get("create_goal");
		if (tool === undefined) {
			throw new Error("create_goal tool was not registered");
		}

		await tool.execute(
			"call-create-goal",
			{ objective: "ship the feature" },
			undefined,
			undefined,
			harness.ctx,
		);
		await fireEvent(harness, "turn_end", {
			type: "turn_end",
			message: makeAssistantToolCallMessage(100),
		});
		await fireEvent(harness, "turn_end", {
			type: "turn_end",
			message: makeAssistantMessage(25),
		});

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("active");
		expect(snapshot?.tokensUsed).toBe(25);
	});

	it("sends the budget-limit prompt when the time budget is reached", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "--time-budget 1 finish");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "system",
		});
		vi.setSystemTime(1_000);
		await fireEvent(harness, "agent_end", {
			type: "agent_end",
			messages: [makeAssistantMessage(0)],
		});

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-budget-limit");
		expect(harness.sentMessages[0]?.message.content).toContain("reached its token budget");
		expect(harness.sentMessages[0]?.options).toEqual({
			triggerTurn: true,
			deliverAs: "followUp",
		});
	});

	it("steers the budget-limit prompt during an active turn", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const runningCtx = {
			...harness.ctx,
			isIdle: () => false,
		} as ExtensionContext;

		await runGoalCommand(harness, "--budget 100 finish");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "system",
		});
		await fireEvent(
			harness,
			"turn_end",
			{
				type: "turn_end",
				message: makeAssistantMessage(150),
			},
			runningCtx,
		);

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-budget-limit");
		expect(harness.sentMessages[0]?.message.content).toContain("reached its token budget");
		expect(harness.sentMessages[0]?.options).toEqual({ deliverAs: "steer" });
	});

	it("steers the active turn when setting a new command goal while running", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const ctx = {
			...harness.ctx,
			isIdle: () => false,
		} as ExtensionCommandContext;

		await runGoalCommand(harness, "ship the feature", ctx);

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-continuation");
		expect(harness.sentMessages[0]?.message.content).toContain("ship the feature");
		expect(harness.sentMessages[0]?.options).toEqual({ deliverAs: "steer" });
	});

	it("starts an idle agent turn after /goal resume", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await runGoalCommand(harness, "pause");
		await runGoalCommand(harness, "resume");

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-continuation");
	});

	it("steers the active turn after /goal resume while running", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const runningCtx = {
			...harness.ctx,
			isIdle: () => false,
		} as ExtensionCommandContext;

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await runGoalCommand(harness, "pause");
		await runGoalCommand(harness, "resume", runningCtx);

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-continuation");
		expect(harness.sentMessages[0]?.message.content).toContain("ship the feature");
		expect(harness.sentMessages[0]?.options).toEqual({ deliverAs: "steer" });
	});

	it("restores idle accounting for an active goal on session start", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const restored = makeGoalSnapshot(
			"ship the feature",
			null,
			null,
			"2026-05-01T00:00:00.000Z",
		);
		const ctx = {
			...harness.ctx,
			sessionManager: {
				...harness.ctx.sessionManager,
				getBranch: () => [
					makeCustomEntry("goal", { version: 2, snapshot: restored }),
				],
			},
		} as ExtensionCommandContext;

		await fireEvent(harness, "session_start", { type: "session_start" }, ctx);
		vi.setSystemTime(2_000);
		await fireEvent(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "system",
		}, ctx);
		vi.setSystemTime(3_500);
		await fireEvent(harness, "turn_end", {
			type: "turn_end",
			message: makeAssistantMessage(10),
		}, ctx);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.tokensUsed).toBe(10);
		expect(snapshot?.timeUsedSeconds).toBe(2);
	});

	it("sets a new command goal without replacement confirmation after completion", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "first goal");
		await runGoalCommand(harness, "complete");
		harness.sentMessages.length = 0;
		await runGoalCommand(harness, "second goal");

		expect(harness.confirmations).toHaveLength(0);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.content).toContain("second goal");
	});

	it("starts normal continuation when replacing an active command goal while idle", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "first goal");
		harness.sentMessages.length = 0;
		await runGoalCommand(harness, "second goal");

		expect(harness.confirmations).toHaveLength(1);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-continuation");
		expect(harness.sentMessages[0]?.message.content).toContain("second goal");
		expect(harness.sentMessages[0]?.options).toEqual({
			triggerTurn: true,
			deliverAs: "followUp",
		});
	});

	it("steers the active turn when replacing an active command goal while running", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const runningCtx = {
			...harness.ctx,
			isIdle: () => false,
		} as ExtensionCommandContext;

		await runGoalCommand(harness, "first goal");
		harness.sentMessages.length = 0;
		await runGoalCommand(harness, "second goal", runningCtx);

		expect(harness.confirmations).toHaveLength(1);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-objective-updated");
		expect(harness.sentMessages[0]?.message.content).toContain(
			"The active thread goal objective was edited by the user.",
		);
		expect(harness.sentMessages[0]?.message.content).toContain("second goal");
		expect(harness.sentMessages[0]?.options).toEqual({ deliverAs: "steer" });
	});

	it("starts replacement goal accounting from the command time while running", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const runningCtx = {
			...harness.ctx,
			isIdle: () => false,
		} as ExtensionCommandContext;

		await runGoalCommand(harness, "first goal");
		await fireEvent(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "system",
		});
		vi.setSystemTime(2_500);
		await runGoalCommand(harness, "second goal", runningCtx);
		vi.setSystemTime(4_000);
		await fireEvent(harness, "turn_end", {
			type: "turn_end",
			message: makeAssistantMessage(10),
		});

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.objective).toBe("second goal");
		expect(snapshot?.tokensUsed).toBe(10);
		expect(snapshot?.timeUsedSeconds).toBe(1);
	});

	it("accounts assistant token usage on turn_end", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "ship the feature");
		await fireEvent(harness, "turn_end", {
			type: "turn_end",
			message: makeAssistantMessage(120),
		});

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.tokensUsed).toBe(120);
	});

	it("injects active goal context into the system prompt", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "ship the feature");
		const results = await fireEvent(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "base prompt",
		});

		expect(results).toHaveLength(1);
		const result = results[0];
		expect(result).toMatchObject({
			systemPrompt: expect.stringContaining("base prompt"),
		});
		expect(result).toMatchObject({
			systemPrompt: expect.stringContaining("Active thread goal context."),
		});
		expect(result).toMatchObject({
			systemPrompt: expect.stringContaining("<objective>\nship the feature"),
		});
	});

	it("allows the model to mark a goal blocked through update_goal", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "ship the feature");
		const tool = harness.tools.get("update_goal");
		if (tool === undefined) {
			throw new Error("update_goal tool was not registered");
		}
		const result = await tool.execute(
			"call-update-goal",
			{ status: "blocked" },
			undefined,
			undefined,
			harness.ctx,
		);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("blocked");
		expect(result.details).toMatchObject({
			displayText: "Goal blocked.",
			remainingTokens: null,
			completionBudgetReport: null,
		});
		expect(parseToolJsonResult(result)).toMatchObject({
			goal: {
				threadId: "session-1",
				objective: "ship the feature",
				status: "blocked",
				tokensUsed: 0,
				timeUsedSeconds: 0,
			},
			remainingTokens: null,
			completionBudgetReport: null,
		});
	});

	it("accounts the update_goal caller turn after marking the goal blocked", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "ship the feature");
		await fireEvent(harness, "before_agent_start", {
			type: "before_agent_start",
			systemPrompt: "system",
		});
		const tool = harness.tools.get("update_goal");
		if (tool === undefined) {
			throw new Error("update_goal tool was not registered");
		}
		await tool.execute(
			"call-update-goal",
			{ status: "blocked" },
			undefined,
			undefined,
			harness.ctx,
		);
		await fireEvent(harness, "turn_end", {
			type: "turn_end",
			message: makeAssistantMessage(23),
		});

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("blocked");
		expect(snapshot?.tokensUsed).toBe(23);
	});

	it("returns codex-style completion budget details from update_goal", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);

		await runGoalCommand(harness, "--budget 100 ship the feature");
		await fireEvent(harness, "turn_end", {
			type: "turn_end",
			message: makeAssistantMessage(25),
		});
		const tool = harness.tools.get("update_goal");
		if (tool === undefined) {
			throw new Error("update_goal tool was not registered");
		}
		const result = await tool.execute(
			"call-update-goal",
			{ status: "complete" },
			undefined,
			undefined,
			harness.ctx,
		);

		expect(result.details).toMatchObject({
			remainingTokens: 75,
			completionBudgetReport: expect.stringContaining("Goal achieved."),
			goal: {
				threadId: "session-1",
				status: "complete",
				tokenBudget: 100,
				tokensUsed: 25,
			},
		});
		expect(parseToolJsonResult(result)).toMatchObject({
			remainingTokens: 75,
			completionBudgetReport: expect.stringContaining("Goal achieved."),
			goal: {
				threadId: "session-1",
				status: "complete",
				tokenBudget: 100,
				tokensUsed: 25,
			},
		});
	});

	it("pauses the goal when pi reports an interrupted turn", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const interruptedCtx = makeAbortedPiContext(harness.ctx);

		await runGoalCommand(harness, "ship the feature");
		await fireEvent(
			harness,
			"turn_end",
			{
				type: "turn_end",
				message: makeAssistantMessage(0),
			},
			interruptedCtx,
		);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("paused");
	});

	it("pauses the goal from the pi interrupt signal before completion events", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const controller = new AbortController();
		const signalCtx = makePiSignalContext(harness.ctx, controller);

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(
			harness,
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: "system" },
			signalCtx,
		);
		controller.abort();
		await flushPromises();

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("paused");

		await fireEvent(
			harness,
			"agent_end",
			{ type: "agent_end", messages: [makeAssistantToolCallMessage()] },
			signalCtx,
		);

		expect(harness.sentMessages).toHaveLength(0);
	});

	it("does not continue the goal when pi reports an interrupted agent end after tool work", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const interruptedCtx = makeAbortedPiContext(harness.ctx);
		const agentEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [makeAssistantToolCallMessage()],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", agentEnd, interruptedCtx);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("paused");
		expect(harness.sentMessages).toHaveLength(0);
	});

	it("does not continue when pi clears the signal before agent end handling", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const controller = new AbortController();
		const signalCtx = makePiSignalContext(harness.ctx, controller);

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(
			harness,
			"before_agent_start",
			{ type: "before_agent_start", systemPrompt: "system" },
			signalCtx,
		);
		controller.abort();
		await fireEvent(harness, "agent_end", {
			type: "agent_end",
			messages: [makeAssistantToolCallMessage()],
		});

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("paused");
		expect(harness.sentMessages).toHaveLength(0);
	});

	it("does not pause the goal from an aborted assistant event without a pi interrupt signal", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const agentEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [makeAssistantToolCallMessage(), makeAssistantMessage(0, "aborted")],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", agentEnd);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("active");
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-continuation");
	});

	it("does not dispatch a normal continuation after an assistant error following tool work", async () => {
		vi.useFakeTimers();
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const agentEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [
				makeAssistantToolCallMessage(),
				makeErrorAssistantMessage("provider returned error: 503"),
			],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", agentEnd);

		expect(harness.sentMessages).toHaveLength(0);
	});

	it("leaves the goal active for pi-owned context overflow compaction", async () => {
		for (const errorMessage of [
			"invalid_request_error: context_length_exceeded",
			"provider returned error: invalid_request_error: context_length_exceeded",
			"Invalid request: Your request exceeded model token limit: 262144 (requested: 429515)",
		]) {
			const harness = makeGoalAdapterHarness();
			harnesses.push(harness);
			const agentEnd: AgentEndEvent = {
				type: "agent_end",
				messages: [makeErrorAssistantMessage(errorMessage)],
			};

			await runGoalCommand(harness, "ship the feature");
			harness.sentMessages.length = 0;
			const notificationCount = harness.notifications.length;
			await fireEvent(harness, "agent_end", agentEnd);

			const snapshot = await harness.run(
				Effect.gen(function* () {
					const goal = yield* Goal;
					return yield* goal.get("session-1");
				}),
			);

			expect(snapshot?.status).toBe("active");
			expect(snapshot?.continuationSuppressed).toBe(false);
			expect(harness.sentMessages).toHaveLength(0);
			expect(harness.notifications).toHaveLength(notificationCount);
		}
	});

	it("pauses non-recoverable assistant request errors", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const agentEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [makeErrorAssistantMessage("invalid_request_error: malformed tool schema")],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", agentEnd);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("paused");
		expect(harness.sentMessages).toHaveLength(0);
		expect(harness.notifications.at(-1)?.message).toContain("malformed tool schema");
	});

	it("keeps bounded retries for retryable token rate-limit errors", async () => {
		vi.useFakeTimers();
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const agentEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [makeErrorAssistantMessage("rate limit: token limit exceeded")],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", agentEnd);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-error-retry");
	});

	it("marks the goal usage-limited for account quota errors", async () => {
		vi.useFakeTimers();
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const agentEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [
				makeErrorAssistantMessage(
					"insufficient_quota: monthly usage limit reached",
					37,
				),
			],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", agentEnd);
		await vi.advanceTimersByTimeAsync(60_000);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("usage_limited");
		expect(snapshot?.tokensUsed).toBe(37);
		expect(harness.sentMessages).toHaveLength(0);
		expect(harness.notifications.at(-1)?.message).toContain("usage limited");
	});

	it("can mark a budget-limited goal usage-limited after a quota error", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const agentEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [makeErrorAssistantMessage("quota exceeded for this account")],
		};

		await runGoalCommand(harness, "ship the feature");
		await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				yield* goal.setStatus("session-1", "budget_limited");
			}),
		);
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", agentEnd);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("usage_limited");
		expect(harness.sentMessages).toHaveLength(0);
	});

	it("pauses after three consecutive retryable assistant errors", async () => {
		vi.useFakeTimers();
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const agentEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [
				makeAssistantToolCallMessage(),
				makeErrorAssistantMessage("provider returned error: 503"),
			],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", agentEnd);
		await fireEvent(harness, "agent_end", agentEnd);
		await fireEvent(harness, "agent_end", agentEnd);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("paused");
		expect(harness.sentMessages).toHaveLength(0);
		expect(harness.notifications.at(-1)?.message).toContain("3 consecutive errors");
	});

	it("sends a delayed recovery retry for a retryable assistant error", async () => {
		vi.useFakeTimers();
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const agentEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [
				makeAssistantToolCallMessage(),
				makeErrorAssistantMessage("provider returned error: 503"),
			],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", agentEnd);

		expect(harness.sentMessages).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-error-retry");
		expect(harness.sentMessages[0]?.message.content).toContain("provider returned error: 503");
	});

	it("sends a delayed recovery retry when an assistant error happens before tool work", async () => {
		vi.useFakeTimers();
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const agentEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [makeErrorAssistantMessage("provider returned error: 503")],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", agentEnd);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-error-retry");
	});

	it("reschedules a delayed recovery retry while the agent is still running", async () => {
		vi.useFakeTimers();
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		let idle = false;
		const busyCtx = {
			...harness.ctx,
			isIdle: () => idle,
		} as ExtensionContext;
		const agentEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [
				makeAssistantToolCallMessage(),
				makeErrorAssistantMessage("provider returned error: 503"),
			],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", agentEnd, busyCtx);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(harness.sentMessages).toHaveLength(0);

		idle = true;
		await vi.advanceTimersByTimeAsync(60_000);

		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0]?.message.customType).toBe("tau:goal-error-retry");
	});

	it("clears retry error state when a delayed recovery retry cannot dispatch", async () => {
		vi.useFakeTimers();
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const blockedCtx = {
			...harness.ctx,
			hasPendingMessages: () => true,
		} as ExtensionContext;
		const errorEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [
				makeAssistantToolCallMessage(),
				makeErrorAssistantMessage("provider returned error: 503"),
			],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", errorEnd, blockedCtx);
		await vi.advanceTimersByTimeAsync(60_000);
		await fireEvent(harness, "agent_end", errorEnd);
		await fireEvent(harness, "agent_end", errorEnd);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("active");
		expect(harness.sentMessages).toHaveLength(0);
	});

	it("keeps retry error state when a delayed recovery retry is blocked by a running agent", async () => {
		vi.useFakeTimers();
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const busyCtx = {
			...harness.ctx,
			isIdle: () => false,
		} as ExtensionContext;
		const errorEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [
				makeAssistantToolCallMessage(),
				makeErrorAssistantMessage("provider returned error: 503"),
			],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", errorEnd, busyCtx);
		await vi.advanceTimersByTimeAsync(60_000);
		await fireEvent(harness, "agent_end", errorEnd);
		await fireEvent(harness, "agent_end", errorEnd);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("paused");
		expect(harness.sentMessages).toHaveLength(0);
	});

	it("resets consecutive assistant errors after a successful assistant turn", async () => {
		vi.useFakeTimers();
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const errorEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [
				makeAssistantToolCallMessage(),
				makeErrorAssistantMessage("provider returned error: 503"),
			],
		};
		const successEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [makeAssistantToolCallMessage(), makeAssistantMessage(0)],
		};

		await runGoalCommand(harness, "ship the feature");
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", errorEnd);
		await fireEvent(harness, "agent_end", errorEnd);
		await fireEvent(harness, "agent_end", successEnd);
		harness.sentMessages.length = 0;
		await fireEvent(harness, "agent_end", errorEnd);
		await fireEvent(harness, "agent_end", errorEnd);

		const snapshot = await harness.run(
			Effect.gen(function* () {
				const goal = yield* Goal;
				return yield* goal.get("session-1");
			}),
		);

		expect(snapshot?.status).toBe("active");
		expect(harness.sentMessages).toHaveLength(0);
	});
});
