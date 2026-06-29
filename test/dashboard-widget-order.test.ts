import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime } from "effect";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolResultEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import { PiAPILive } from "../src/effect/pi.js";
import initGoal from "../src/goal/index.js";
import { Goal, GoalLive } from "../src/services/goal.js";
import initWorkedFor from "../src/worked-for/index.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type WidgetContent = string[] | WidgetFactory | undefined;

type WidgetUpdate = {
	readonly key: string;
	readonly content: WidgetContent;
};

type MountedWidget = Component | string[];

type WidgetHarness = {
	readonly keys: () => readonly string[];
	readonly updates: readonly WidgetUpdate[];
	readonly renderRequests: () => number;
	readonly renderLines: (key: string, width: number) => readonly string[];
	readonly setWidget: (key: string, content: WidgetContent) => void;
};

type Harness = {
	readonly ctx: ExtensionContext;
	readonly fire: (name: string, event: unknown) => Promise<void>;
	readonly run: <A, E>(effect: Effect.Effect<A, E, Goal>) => Promise<A>;
	readonly widgets: WidgetHarness;
	readonly dispose: () => Promise<void>;
};

function makeAssistantMessage(tokens: number): AssistantMessage {
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
		stopReason: "stop",
		timestamp: 0,
	};
}

function makeWidgetHarness(): WidgetHarness {
	const widgets = new Map<string, MountedWidget>();
	const updates: WidgetUpdate[] = [];
	let renderRequestCount = 0;
	const tui = {
		requestRender: () => {
			renderRequestCount += 1;
		},
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	return {
		keys: () => Array.from(widgets.keys()),
		updates,
		renderRequests: () => renderRequestCount,
		renderLines: (key, width) => {
			const widget = widgets.get(key);
			if (widget === undefined) {
				throw new Error(`widget ${key} is not mounted`);
			}
			return Array.isArray(widget) ? widget : widget.render(width);
		},
		setWidget: (key, content) => {
			updates.push({ key, content });
			widgets.delete(key);
			if (content === undefined) return;
			widgets.set(key, typeof content === "function" ? content(tui, theme) : content);
		},
	};
}

function makeHarness(): Harness {
	const events = new Map<string, EventHandler[]>();
	const widgets = makeWidgetHarness();
	const piBase = {
		on: (name: string, handler: EventHandler) => {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerTool: () => undefined,
		registerCommand: () => undefined,
		registerMessageRenderer: () => undefined,
		sendMessage: () => undefined,
		appendEntry: () => undefined,
	} as unknown as ExtensionAPI;
	const runtime = ManagedRuntime.make(GoalLive.pipe(Layer.provide(PiAPILive(piBase))));

	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => [],
		},
		ui: {
			setStatus: () => undefined,
			setWidget: widgets.setWidget,
			notify: () => undefined,
			confirm: async () => true,
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;

	initWorkedFor(piBase, {
		getSnapshot: () => ({}),
		update: () => undefined,
	});
	initGoal(piBase, {
		runPromise: (effect) => runtime.runPromise(effect),
		runFork: (effect) => runtime.runFork(effect),
	});

	return {
		ctx,
		widgets,
		fire: async (name, event) => {
			for (const handler of events.get(name) ?? []) {
				await handler(event, ctx);
			}
		},
		run: (effect) => runtime.runPromise(effect),
		dispose: () => runtime.dispose(),
	};
}

function definedWidgetUpdateCount(harness: WidgetHarness, key: string): number {
	return harness.updates.filter((update) => update.key === key && update.content !== undefined)
		.length;
}

describe("dashboard widget order", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps goal and worked-for widgets in stable insertion order during live updates", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const harness = makeHarness();

		try {
			await harness.run(
				Effect.gen(function* () {
					const goal = yield* Goal;
					return yield* goal.create("session-1", "ship stable dashboard", null);
				}),
			);

			await harness.fire("before_agent_start", {
				type: "before_agent_start",
				prompt: "go",
				systemPrompt: "base",
				systemPromptOptions: { cwd: "/tmp" },
			} satisfies BeforeAgentStartEvent);

			expect(harness.widgets.keys()).toEqual(["worked-for-separator", "goal"]);
			expect(definedWidgetUpdateCount(harness.widgets, "worked-for-separator")).toBe(1);
			expect(definedWidgetUpdateCount(harness.widgets, "goal")).toBe(1);

			vi.setSystemTime(1_500);
			await harness.fire("turn_end", {
				type: "turn_end",
				turnIndex: 0,
				message: makeAssistantMessage(42),
				toolResults: [],
			} satisfies TurnEndEvent);

			expect(harness.widgets.keys()).toEqual(["worked-for-separator", "goal"]);
			expect(definedWidgetUpdateCount(harness.widgets, "worked-for-separator")).toBe(1);
			expect(definedWidgetUpdateCount(harness.widgets, "goal")).toBe(1);

			vi.setSystemTime(2_500);
			await harness.fire("tool_result", {
				type: "tool_result",
				toolName: "bash",
				toolCallId: "call-1",
				input: {},
				content: [{ type: "text", text: "ok" }],
				isError: false,
				details: undefined,
			} satisfies ToolResultEvent);

			expect(harness.widgets.keys()).toEqual(["worked-for-separator", "goal"]);
			expect(definedWidgetUpdateCount(harness.widgets, "worked-for-separator")).toBe(1);
			expect(definedWidgetUpdateCount(harness.widgets, "goal")).toBe(1);
			expect(harness.widgets.renderRequests()).toBeGreaterThan(0);
		} finally {
			await harness.fire("agent_end", {
				type: "agent_end",
				messages: [],
			} satisfies AgentEndEvent);
			await harness.dispose();
		}
	});

	it("keeps goal widget lines within terminal width", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const harness = makeHarness();
		const objective =
			"effect-pie-b43 - Implement the epic and all the tasks under it, related to this epic, the children of this epic. Don't rush. We are not in a hurry. Make it right. Follow the plan. Trust the plan.";

		try {
			await harness.run(
				Effect.gen(function* () {
					const goal = yield* Goal;
					return yield* goal.create("session-1", objective, null);
				}),
			);

			await harness.fire("before_agent_start", {
				type: "before_agent_start",
				prompt: "go",
				systemPrompt: "base",
				systemPromptOptions: { cwd: "/tmp" },
			} satisfies BeforeAgentStartEvent);

			for (const width of [0, 1, 2, 3, 89]) {
				const lines = harness.widgets.renderLines("goal", width);
				expect(lines.length).toBeGreaterThan(0);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			}
		} finally {
			await harness.fire("agent_end", {
				type: "agent_end",
				messages: [],
			} satisfies AgentEndEvent);
			await harness.dispose();
		}
	});
});
