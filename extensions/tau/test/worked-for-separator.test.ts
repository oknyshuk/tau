import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import initWorkedFor from "../src/worked-for/index.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function makeHarness(opts?: { isIdle?: () => boolean }) {
	const events = new Map<string, EventHandler[]>();
	const sendMessage = vi.fn();
	const piBase = {
		on: (name: string, handler: EventHandler) => {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerTool: () => undefined,
		registerCommand: () => undefined,
		registerMessageRenderer: () => undefined,
		sendMessage,
		appendEntry: () => undefined,
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		ui: {
			setWidget: () => undefined,
			notify: () => undefined,
		},
		isIdle: opts?.isIdle ?? (() => true),
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;

	initWorkedFor(piBase, {
		getSnapshot: () => ({}),
		update: () => undefined,
	});

	return {
		sendMessage,
		fire: async (name: string, event: unknown) => {
			for (const handler of events.get(name) ?? []) {
				await handler(event, ctx);
			}
		},
	};
}

const beforeAgentStart: BeforeAgentStartEvent = {
	type: "before_agent_start",
	prompt: "go",
	systemPrompt: "base",
	systemPromptOptions: { cwd: "/tmp" },
} as BeforeAgentStartEvent;

const agentEnd: AgentEndEvent = {
	type: "agent_end",
	messages: [],
} as AgentEndEvent;

describe("worked-for separator", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("defers the separator until the run is idle so it is appended, not steered mid-stream", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const harness = makeHarness();

		await harness.fire("before_agent_start", beforeAgentStart);
		vi.setSystemTime(1_500);
		await harness.fire("agent_end", agentEnd);

		// During agent_end the agent loop is still streaming; emitting here would be
		// steered into the queue and trigger a spurious continuation turn. The
		// separator must therefore NOT be sent synchronously from the handler.
		expect(harness.sendMessage).not.toHaveBeenCalled();

		// Once the run settles (next macrotask, isStreaming === false) it is appended
		// exactly once and must not trigger a turn.
		await vi.runAllTimersAsync();
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
		const [message, options] = harness.sendMessage.mock.calls[0] as [
			{ customType: string; display: boolean; details: { elapsedMs: number } },
			{ triggerTurn: boolean },
		];
		expect(message.customType).toBe("tau:worked-for");
		expect(message.display).toBe(true);
		expect(message.details.elapsedMs).toBe(1_500);
		expect(options).toEqual({ triggerTurn: false });
	});

	it("skips the now-stale separator when a new run has already started", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const harness = makeHarness({ isIdle: () => false });

		await harness.fire("before_agent_start", beforeAgentStart);
		await harness.fire("agent_end", agentEnd);
		await vi.runAllTimersAsync();

		expect(harness.sendMessage).not.toHaveBeenCalled();
	});
});
