import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";

import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import { PiAPILive } from "../src/effect/pi.js";
import initGoal from "../src/goal/index.js";
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
		registerTool: () => undefined,
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

function makeAssistantToolCallMessage(): AssistantMessage {
	return {
		...makeAssistantMessage(0),
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
		stopReason: "toolUse",
	};
}

function makeErrorAssistantMessage(errorMessage: string): AssistantMessage {
	return {
		...makeAssistantMessage(0, "error"),
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
		expect(harness.sentMessages[0]?.message.content).toContain("reached its budget");
	});

	it("does not start a turn when the session is not idle", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const ctx = {
			...harness.ctx,
			isIdle: () => false,
		} as ExtensionCommandContext;

		await runGoalCommand(harness, "ship the feature", ctx);

		expect(harness.sentMessages).toHaveLength(0);
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
			systemPrompt: expect.stringContaining("<untrusted_objective>\nship the feature"),
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

	it("pauses instead of retrying context length errors", async () => {
		const harness = makeGoalAdapterHarness();
		harnesses.push(harness);
		const agentEnd: AgentEndEvent = {
			type: "agent_end",
			messages: [
				makeAssistantToolCallMessage(),
				makeErrorAssistantMessage("invalid_request_error: context_length_exceeded"),
			],
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
		expect(harness.notifications.at(-1)?.message).toContain("context_length_exceeded");
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
