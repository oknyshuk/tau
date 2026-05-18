import { describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ToolResultEvent,
	ContextEvent,
	BeforeAgentStartEvent,
} from "@earendil-works/pi-coding-agent";

import initNudge from "../src/nudge/index.js";

type EventHandler = (event: unknown, ctx: unknown) => unknown;

interface ContentItem {
	type: string;
	text: string;
}

interface MessageLike {
	role: string;
	content: ContentItem[];
}

interface NudgeContextResult {
	messages: MessageLike[];
}

interface NudgeBaselineResult {
	systemPrompt: string;
}

function makePiStub(activeTools: string[] = ["memory", "skill_manage"]): {
	readonly pi: ExtensionAPI;
	readonly fire: (event: string, payload: unknown) => Promise<unknown>;
	setActiveTools: (tools: string[]) => void;
} {
	const eventHandlers = new Map<string, EventHandler[]>();
	let currentActiveTools = activeTools;

	const base = {
		on: (event: string, handler: EventHandler) => {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		getActiveTools: () => currentActiveTools,
		registerTool: () => undefined,
		registerCommand: () => undefined,
		registerShortcut: () => undefined,
		registerMessageRenderer: () => undefined,
		registerFlag: () => undefined,
		sendMessage: () => undefined,
		appendEntry: () => undefined,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		getFlag: () => undefined,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		events: {
			emit: () => undefined,
			on: () => () => undefined,
		},
	};

	const pi = new Proxy(base, {
		get(target, prop, receiver) {
			if (Reflect.has(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			return () => undefined;
		},
	}) as unknown as ExtensionAPI;

	return {
		pi,
		fire: async (event, payload) => {
			const handlers = eventHandlers.get(event) ?? [];
			let lastResult: unknown;
			for (const handler of handlers) {
				lastResult = await handler(payload, {});
			}
			return lastResult;
		},
		setActiveTools: (tools: string[]) => {
			currentActiveTools = tools;
		},
	};
}

function makeContextEvent(text = "test message"): ContextEvent {
	return {
		type: "context",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			},
		],
	};
}

function makeToolResultEvent(toolName: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolName,
		toolCallId: "test-call-id",
		input: {},
		content: [{ type: "text", text: "result" }],
		isError: false,
	} as ToolResultEvent;
}

function makeTurnEndEvent(index: number): unknown {
	return {
		type: "turn_end",
		turnIndex: index,
		timestamp: Date.now(),
		message: { role: "assistant" as const, content: [{ type: "text" as const, text: "" }] },
		toolResults: [],
	};
}

async function advanceTurns(
	fire: (event: string, payload: unknown) => Promise<unknown>,
	count: number,
): Promise<void> {
	for (let i = 0; i < count; i++) {
		await fire("turn_end", makeTurnEndEvent(i));
	}
}

function getLastUserMessageContent(result: unknown): ContentItem[] {
	const ctx = result as NudgeContextResult;
	for (let i = ctx.messages.length - 1; i >= 0; i--) {
		const message = ctx.messages[i];
		if (message?.role === "user") {
			return message.content;
		}
	}
	return [];
}

function getFirstUserText(result: unknown): ContentItem {
	const [first] = getLastUserMessageContent(result);
	if (first === undefined) {
		throw new Error("expected injected user text");
	}
	return first;
}

describe("nudge module", () => {
	it("does NOT nudge before memory threshold (8 turns)", async () => {
		const { pi, fire } = makePiStub();
		initNudge(pi);

		await advanceTurns(fire, 7);
		const result = await fire("context", makeContextEvent());

		expect(result).toBeUndefined();
	});

	it("nudges for memory after 8 turns", async () => {
		const { pi, fire } = makePiStub(["memory"]);
		initNudge(pi);

		await advanceTurns(fire, 8);
		const result = await fire("context", makeContextEvent());

		expect(result).toBeDefined();
		const content = getFirstUserText(result);
		expect(content.type).toBe("text");
		expect(content.text.length).toBeGreaterThan(0);
	});

	it("resets memory counter when memory tool is used (via tool_result)", async () => {
		const { pi, fire } = makePiStub(["memory"]);
		initNudge(pi);

		await advanceTurns(fire, 5);
		await fire("tool_result", makeToolResultEvent("memory"));
		await advanceTurns(fire, 5);

		const result = await fire("context", makeContextEvent());
		expect(result).toBeUndefined();

		// But after 8 more turns from last use, it should nudge again
		await advanceTurns(fire, 3);
		const result2 = await fire("context", makeContextEvent());
		expect(result2).toBeDefined();
		const content = getFirstUserText(result2);
		expect(content.type).toBe("text");
	});

	it("respects cooldown — after nudging, no re-nudge for another 8 turns even if overdue", async () => {
		const { pi, fire } = makePiStub(["memory"]);
		initNudge(pi);

		// Trigger first nudge at turn 8
		await advanceTurns(fire, 8);
		const firstNudge = await fire("context", makeContextEvent());
		expect(firstNudge).toBeDefined();

		// Advance 5 more turns (turn 13). memory is still overdue (lastUsedTurn=0,
		// sinceLast=13>=8) but cooldown blocks (lastNudgedTurn=8, sinceNudge=5<8).
		// Do NOT reset via tool_result — this isolates the cooldown path.
		await advanceTurns(fire, 5);
		const result = await fire("context", makeContextEvent());
		expect(result).toBeUndefined();

		// After cooldown passes (turn 16, sinceNudge=8), should nudge again
		await advanceTurns(fire, 3);
		const result2 = await fire("context", makeContextEvent());
		expect(result2).toBeDefined();
	});

	it("suppresses nudge when tracked tools are not active (but other tools are)", async () => {
		const { pi, fire } = makePiStub(["exec_command", "read", "edit"]);
		initNudge(pi);

		await advanceTurns(fire, 15);
		const result = await fire("context", makeContextEvent());
		expect(result).toBeUndefined();
	});

	it("resets full state on session_start — re-nudges after threshold in new session", async () => {
		const { pi, fire } = makePiStub(["memory"]);
		initNudge(pi);

		// Trigger nudge, building up lastNudgedTurn and lastUsedTurn state
		await advanceTurns(fire, 8);
		const nudge1 = await fire("context", makeContextEvent());
		expect(nudge1).toBeDefined();

		// Reset via session_start
		await fire("session_start", { type: "session_start" });

		// In the fresh session, 7 turns should not nudge
		await advanceTurns(fire, 7);
		const result7 = await fire("context", makeContextEvent());
		expect(result7).toBeUndefined();

		// But 8 turns should nudge (proves lastNudgedTurn was also cleared)
		await advanceTurns(fire, 1);
		const result8 = await fire("context", makeContextEvent());
		expect(result8).toBeDefined();
	});

	it("resets full state on session_switch — re-nudges after threshold in new session", async () => {
		const { pi, fire } = makePiStub(["memory"]);
		initNudge(pi);

		await advanceTurns(fire, 8);
		const nudge1 = await fire("context", makeContextEvent());
		expect(nudge1).toBeDefined();

		await fire("session_switch", { type: "session_switch" });

		await advanceTurns(fire, 7);
		const result7 = await fire("context", makeContextEvent());
		expect(result7).toBeUndefined();

		await advanceTurns(fire, 1);
		const result8 = await fire("context", makeContextEvent());
		expect(result8).toBeDefined();
	});

	it("appends baseline to system prompt preserving the original prompt", async () => {
		const { pi, fire } = makePiStub(["memory"]);
		initNudge(pi);

		const result = (await fire("before_agent_start", {
			type: "before_agent_start",
			prompt: "test",
			systemPrompt: "base prompt",
		} as BeforeAgentStartEvent)) as NudgeBaselineResult | undefined;

		expect(result).toBeDefined();
		expect(result!.systemPrompt.startsWith("base prompt")).toBe(true);
		expect(result!.systemPrompt.length).toBeGreaterThan("base prompt".length);
	});

	it("omits baseline when no tracked tools are active (other tools present)", async () => {
		const { pi, fire } = makePiStub(["exec_command", "read"]);
		initNudge(pi);

		const result = await fire("before_agent_start", {
			type: "before_agent_start",
			prompt: "test",
			systemPrompt: "base prompt",
		} as BeforeAgentStartEvent);

		expect(result).toBeUndefined();
	});

	it("nudges for skill_manage after 12 turns", async () => {
		const { pi, fire } = makePiStub(["skill_manage"]);
		initNudge(pi);

		await advanceTurns(fire, 12);
		const result = await fire("context", makeContextEvent());

		expect(result).toBeDefined();
		const content = getFirstUserText(result);
		expect(content.type).toBe("text");
	});

	it("does NOT nudge for skill_manage before 12 turns", async () => {
		const { pi, fire } = makePiStub(["skill_manage"]);
		initNudge(pi);

		await advanceTurns(fire, 11);
		const result = await fire("context", makeContextEvent());
		expect(result).toBeUndefined();
	});

	it("skill nudge triggers at 12 turns but not before, while memory stays silent when recently used", async () => {
		const { pi, fire } = makePiStub(["skill_manage", "memory"]);
		initNudge(pi);

		// At turn 10: memory threshold (8) exceeded, skill threshold (12) not yet
		await advanceTurns(fire, 10);
		// Reset memory so only skill is relevant
		await fire("tool_result", makeToolResultEvent("memory"));

		const result10 = await fire("context", makeContextEvent());
		// Memory was just used, skill not yet at threshold — should not nudge
		expect(result10).toBeUndefined();

		// Advance to turn 12
		await advanceTurns(fire, 2);
		const result12 = await fire("context", makeContextEvent());
		expect(result12).toBeDefined();
	});

	it("resets skill counter on skill_manage tool use", async () => {
		const { pi, fire } = makePiStub(["skill_manage"]);
		initNudge(pi);

		await advanceTurns(fire, 11);
		// Use skill_manage at turn 11 (before threshold of 12)
		await fire("tool_result", makeToolResultEvent("skill_manage"));

		// 7 more turns (turn 18) — skill sinceLast=7 < 12, should not nudge
		await advanceTurns(fire, 7);
		const result = await fire("context", makeContextEvent());
		expect(result).toBeUndefined();

		// 5 more turns (turn 23) — skill sinceLast=12 >= 12, should nudge
		await advanceTurns(fire, 5);
		const result2 = await fire("context", makeContextEvent());
		expect(result2).toBeDefined();
	});

	it("nudges for both tracked tools when both thresholds exceeded simultaneously", async () => {
		const { pi, fire } = makePiStub(["memory", "skill_manage"]);
		initNudge(pi);

		await advanceTurns(fire, 12);
		const result = await fire("context", makeContextEvent());

		expect(result).toBeDefined();
		const content = getFirstUserText(result);
		expect(content.type).toBe("text");
	});
});
