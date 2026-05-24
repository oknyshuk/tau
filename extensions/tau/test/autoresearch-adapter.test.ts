import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import initAutoresearch from "../src/autoresearch/index.js";
import { LoopRepoLive } from "../src/loops/repo.js";
import { LoopEngine } from "../src/services/loop-engine.js";
import { LoopEngineLive } from "../src/services/loop-engine.js";
import { ExecutionRuntime } from "../src/services/execution-runtime.js";
import { Sandbox } from "../src/services/sandbox.js";
import {
	AutoresearchLoopRunner,
	AutoresearchLoopRunnerLive,
} from "../src/services/autoresearch-loop-runner.js";
import { makeExecutionRuntimeStubLayer } from "./ralph-test-helpers.js";
import {
	type FakeCommandContext,
	type NewSessionPlan,
	makeFakeCommandContext,
} from "./fake-command-context.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type RegisteredCommand = {
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type SentUserMessage = {
	readonly content: string | readonly { readonly type: string; readonly text?: string }[];
	readonly options?: {
		readonly deliverAs?: "steer" | "followUp";
	};
};

type ContextHarness = FakeCommandContext;

type PiHarness = {
	readonly pi: ExtensionAPI;
	readonly commands: Map<string, RegisteredCommand>;
	readonly shortcuts: Map<string, (ctx: ExtensionContext) => void | Promise<void>>;
	readonly sentUserMessages: SentUserMessage[];
	readonly fire: (
		event: string,
		payload: unknown,
		ctx: ExtensionContext,
	) => Promise<readonly unknown[]>;
};

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function renderWidgetUpdate(update: unknown): string {
	if (Array.isArray(update)) {
		return update.join("\n");
	}
	if (typeof update === "function") {
		const rendered = update(undefined, plainTheme);
		if (rendered instanceof Text) {
			return rendered.render(240).join("\n");
		}
	}
	return "";
}

type RuntimeHarness = {
	readonly run: <A, E>(
		effect: Effect.Effect<A, E, LoopEngine | Sandbox | ExecutionRuntime | AutoresearchLoopRunner>,
	) => Promise<A>;
	readonly dispose: () => Promise<void>;
};


function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-autoresearch-adapter-"));
}

function sessionIdFromFile(sessionFile: string): string {
	return path.basename(sessionFile, path.extname(sessionFile));
}

function makeRuntime(): RuntimeHarness {
	const sandboxLayer = Layer.succeed(
		Sandbox,
		Sandbox.of({
			getConfig: Effect.succeed({
				preset: "workspace-write",
				filesystemMode: "workspace-write",
				networkMode: "deny",
				approvalPolicy: "on-request",
				approvalTimeoutSeconds: 30,
				subagent: false,
			}),
			changes: Stream.empty,
			setup: Effect.void,
		}),
	);

	const layer = LoopEngineLive.pipe(
		Layer.provideMerge(LoopRepoLive),
		Layer.provideMerge(makeExecutionRuntimeStubLayer()),
		Layer.provideMerge(sandboxLayer),
		Layer.provideMerge(AutoresearchLoopRunnerLive),
		Layer.provide(NodeFileSystem.layer),
	);
	const runtime = ManagedRuntime.make(layer);
	return {
		run: (effect) => runtime.runPromise(effect),
		dispose: () => runtime.dispose(),
	};
}

function makeContext(
	cwd: string,
	newSessionPlan: readonly NewSessionPlan[] = [{ cancelled: false }],
): ContextHarness {
	return makeFakeCommandContext({
		cwd,
		newSessionPlan,
		resolveSessionId: sessionIdFromFile,
	});
}

function makePiHarness(): PiHarness {
	const eventHandlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, RegisteredCommand>();
	const shortcuts = new Map<string, (ctx: ExtensionContext) => void | Promise<void>>();
	const sentUserMessages: SentUserMessage[] = [];

	const base = {
		on: (event: string, handler: EventHandler) => {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		registerCommand: (name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		},
		registerTool: (_tool: ToolDefinition) => undefined,
		registerShortcut: (
			shortcut: string,
			options: { readonly handler?: (ctx: ExtensionContext) => void | Promise<void> },
		) => {
			if (typeof options.handler === "function") {
				shortcuts.set(shortcut, options.handler);
			}
		},
		registerFlag: () => undefined,
		registerMessageRenderer: () => undefined,
		sendUserMessage: (
			content: string | readonly { readonly type: string; readonly text?: string }[],
			options?: { readonly deliverAs?: "steer" | "followUp" },
		) => {
			sentUserMessages.push(options === undefined ? { content } : { content, options });
		},
		sendMessage: () => undefined,
		appendEntry: () => undefined,
		getActiveTools: () => [],
		setActiveTools: () => undefined,
		getAllTools: () => [],
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		events: {
			emit: () => undefined,
			on: (event: string, handler: EventHandler) => {
				base.on(event, handler);
				return () => undefined;
			},
		},
	};

	return {
		pi: new Proxy(base, {
			get(target, prop, receiver) {
				if (Reflect.has(target, prop)) {
					return Reflect.get(target, prop, receiver);
				}
				return () => undefined;
			},
		}) as unknown as ExtensionAPI,
		commands,
		shortcuts,
		sentUserMessages,
		fire: async (event, payload, ctx) => {
			const results: unknown[] = [];
			for (const handler of eventHandlers.get(event) ?? []) {
				results.push(await Promise.resolve(handler(payload, ctx)));
			}
			return results;
		},
	};
}

describe("autoresearch adapter", () => {
	const tempDirs: string[] = [];
	const runtimes: RuntimeHarness[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		for (const runtime of runtimes.splice(0)) {
			await runtime.dispose();
		}
	});

	it("queues a follow-up prompt when /autoresearch start opens a child session", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const controllerSession = context.getSessionFile();
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const command = piHarness.commands.get("autoresearch");
		expect(command).toBeDefined();

		await command?.handler("create improve-local-pdp-web-vitals", context.ctx);
		await command?.handler("start improve-local-pdp-web-vitals", context.ctx);

		expect(context.newSessionCalls).toHaveLength(1);
		const followUp = piHarness.sentUserMessages.at(-1);
		expect(followUp?.options?.deliverAs).toBe("followUp");

		expect(followUp).toBeDefined();
		expect(typeof followUp?.content).toBe("string");
		expect((followUp?.content as string).length).toBeGreaterThan(0);
		expect(context.statusUpdates.at(-1)).toContain(
			"autoresearch: improve-local-pdp-web-vitals",
		);
		expect(renderWidgetUpdate(context.widgetUpdates.at(-1))).toContain("autoresearch 0 runs");
		context.setSessionFile(controllerSession);
		await command?.handler("stop improve-local-pdp-web-vitals", context.ctx);
	});

	it("queues a follow-up prompt when /autoresearch resume relaunches the next child session", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const controllerSession = context.getSessionFile();
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const command = piHarness.commands.get("autoresearch");
		expect(command).toBeDefined();

		await command?.handler("create improve-local-pdp-web-vitals", context.ctx);
		await command?.handler("start improve-local-pdp-web-vitals", context.ctx);
		await command?.handler("pause improve-local-pdp-web-vitals", context.ctx);

		piHarness.sentUserMessages.length = 0;
		context.setSessionFile(controllerSession);
		await command?.handler("resume improve-local-pdp-web-vitals", context.ctx);

		expect(context.newSessionCalls).toHaveLength(2);
		const followUp = piHarness.sentUserMessages.at(-1);
		expect(followUp?.options?.deliverAs).toBe("followUp");

		expect(followUp).toBeDefined();
		expect(typeof followUp?.content).toBe("string");
		expect((followUp?.content as string).length).toBeGreaterThan(0);
		expect(context.statusUpdates.at(-1)).toContain(
			"autoresearch: improve-local-pdp-web-vitals",
		);
		expect(renderWidgetUpdate(context.widgetUpdates.at(-1))).toContain("autoresearch 0 runs");
		await command?.handler("stop improve-local-pdp-web-vitals", context.ctx);
	});

	it("restores the autoresearch widget on session switch for an owned child session", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const controllerSession = context.getSessionFile();
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const command = piHarness.commands.get("autoresearch");
		expect(command).toBeDefined();

		await command?.handler("create improve-local-pdp-web-vitals", context.ctx);
		await command?.handler("start improve-local-pdp-web-vitals", context.ctx);

		context.widgetUpdates.length = 0;
		context.statusUpdates.length = 0;

		await piHarness.fire("session_start", { type: "session_start", reason: "new" }, context.ctx);

		expect(context.statusUpdates.at(-1)).toContain(
			"autoresearch: improve-local-pdp-web-vitals",
		);
		expect(renderWidgetUpdate(context.widgetUpdates.at(-1))).toContain("ctrl+alt+x expand");
		context.setSessionFile(controllerSession);
		await command?.handler("stop improve-local-pdp-web-vitals", context.ctx);
	});

	it("registers autoresearch dashboard shortcuts", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const controllerSession = context.getSessionFile();
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		expect(piHarness.shortcuts.has("ctrl+alt+x")).toBe(true);
		expect(piHarness.shortcuts.has("ctrl+alt+shift+x")).toBe(true);

		const command = piHarness.commands.get("autoresearch");
		expect(command).toBeDefined();
		await command?.handler("create improve-local-pdp-web-vitals", context.ctx);
		await command?.handler("start improve-local-pdp-web-vitals", context.ctx);

		const toggle = piHarness.shortcuts.get("ctrl+alt+x");
		expect(toggle).toBeDefined();
		await toggle?.(context.ctx);

		expect(renderWidgetUpdate(context.widgetUpdates.at(-1))).toContain("Current segment:");
		context.setSessionFile(controllerSession);
		await command?.handler("stop improve-local-pdp-web-vitals", context.ctx);
	});
});
