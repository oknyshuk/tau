import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { Option } from "effect";
import { Text } from "@earendil-works/pi-tui";

import type {
	BashOperations,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

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

const getSandboxedBashOperationsMock = vi.fn<
	(ctx: ExtensionContext, escalate: boolean) => BashOperations | undefined
>();

vi.mock("../src/sandbox/index.js", () => ({
	getSandboxedBashOperations: (ctx: ExtensionContext, escalate: boolean) =>
		getSandboxedBashOperationsMock(ctx, escalate),
}));

import initAutoresearch from "../src/autoresearch/index.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type RegisteredCommand = {
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type ContextHarness = FakeCommandContext;

type PiHarness = {
	readonly pi: ExtensionAPI;
	readonly commands: Map<string, RegisteredCommand>;
	readonly tools: Map<string, ToolDefinition>;
	readonly activeTools: () => readonly string[];
	readonly fire: (event: string, payload: unknown, ctx: ExtensionContext) => Promise<readonly unknown[]>;
};

type RuntimeHarness = {
	readonly run: <A, E>(
		effect: Effect.Effect<A, E, LoopEngine | Sandbox | ExecutionRuntime | AutoresearchLoopRunner>,
	) => Promise<A>;
	readonly dispose: () => Promise<void>;
};

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-autoresearch-tool-runtime-"));
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
	projectSessionId?: string,
): ContextHarness {
	return makeFakeCommandContext({
		cwd,
		newSessionPlan,
		resolveSessionId:
			projectSessionId === undefined ? sessionIdFromFile : () => projectSessionId,
	});
}

function makePiHarness(): PiHarness {
	const eventHandlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, ToolDefinition>();
	let activeTools = ["autoresearch_run", "autoresearch_done"];

	const base = {
		on: (event: string, handler: EventHandler) => {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		registerCommand: (name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		},
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		registerShortcut: () => undefined,
		registerFlag: () => undefined,
		registerMessageRenderer: () => undefined,
		sendUserMessage: () => undefined,
		sendMessage: () => undefined,
		appendEntry: () => undefined,
		getActiveTools: () => activeTools,
		setActiveTools: (nextTools: string[]) => {
			activeTools = [...nextTools];
		},
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
		tools,
		activeTools: () => activeTools,
		fire: async (event, payload, ctx) => {
			const results: unknown[] = [];
			for (const handler of eventHandlers.get(event) ?? []) {
				results.push(await Promise.resolve(handler(payload, ctx)));
			}
			return results;
		},
	};
}

describe("autoresearch tool runtime", () => {
	const tempDirs: string[] = [];
	const runtimes: RuntimeHarness[] = [];

	afterEach(async () => {
		getSandboxedBashOperationsMock.mockReset();
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		for (const runtime of runtimes.splice(0)) {
			await runtime.dispose();
		}
	});

	it("starts child sessions when terminals share a project session id", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [{ cancelled: false }], "shared-project-session");
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const command = piHarness.commands.get("autoresearch");
		if (command === undefined) {
			throw new Error("autoresearch command was not registered");
		}

		await command.handler("create shared-session-id", context.ctx);
		await command.handler("start shared-session-id", context.ctx);

		const state = await runtime.run(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;
				const owned = yield* engine.resolveOwnedLoop(cwd, {
					sessionId: "shared-project-session",
					sessionFile: context.ctx.sessionManager.getSessionFile() ?? "",
				});
				return Option.getOrUndefined(owned);
			}),
		);

		expect(context.newSessionCalls).toHaveLength(1);
		expect(state?.kind).toBe("autoresearch");
		expect(Option.isSome(state?.ownership.child ?? Option.none())).toBe(true);
		expect(Option.getOrUndefined(state?.ownership.child ?? Option.none())?.sessionFile).toBe(
			context.ctx.sessionManager.getSessionFile(),
		);
	});

	it("hides autoresearch run tools outside the active child session", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		await piHarness.fire("before_agent_start", { type: "before_agent_start" }, context.ctx);

		expect(piHarness.activeTools()).not.toContain("autoresearch_run");
		expect(piHarness.activeTools()).not.toContain("autoresearch_done");
	});

	it("runs the benchmark in the real workspace scope", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const controllerSession = context.ctx.sessionManager.getSessionFile();
		if (controllerSession === undefined) {
			throw new Error("missing controller session file");
		}
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const execCalls: Array<{ readonly command: string; readonly cwd: string }> = [];
		getSandboxedBashOperationsMock.mockReturnValue({
			exec: async (command, commandCwd, options) => {
				execCalls.push({ command, cwd: commandCwd });

				if (command === "bash autoresearch.sh") {
					options.onData?.(Buffer.from('METRIC metric=123\nASI hypothesis="workspace"\n'));
					return { exitCode: 0 };
				}

				throw new Error(`Unexpected command: ${command}`);
			},
		} as BashOperations);

		const command = piHarness.commands.get("autoresearch");
		expect(command).toBeDefined();
		await command?.handler("create improve-local-pdp-web-vitals", context.ctx);
		await command?.handler("start improve-local-pdp-web-vitals", context.ctx);
		expect(context.newSessionCalls).toHaveLength(1);

		const runTool = piHarness.tools.get("autoresearch_run");
		if (runTool === undefined) {
			throw new Error("autoresearch_run tool was not registered");
		}

		await runTool.execute(
			"tool-call-1",
			{},
			new AbortController().signal,
			undefined,
			context.ctx,
		);
		const benchmarkCalls = execCalls.filter((call) => call.command === "bash autoresearch.sh");
		expect(benchmarkCalls).toHaveLength(1);
		expect(benchmarkCalls[0]?.cwd).toBe(cwd);
		context.setSessionFile(controllerSession);
		await command?.handler("stop improve-local-pdp-web-vitals", context.ctx);
	});

	it("finalizes kept runs without mutating the workspace", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const controllerSession = context.ctx.sessionManager.getSessionFile();
		if (controllerSession === undefined) {
			throw new Error("missing controller session file");
		}
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const execCalls: Array<{ readonly command: string; readonly cwd: string }> = [];
		getSandboxedBashOperationsMock.mockReturnValue({
			exec: async (command, commandCwd, options) => {
				execCalls.push({ command, cwd: commandCwd });

				if (command === "bash autoresearch.sh") {
					options.onData?.(Buffer.from('METRIC metric=123\nASI hypothesis="workspace"\n'));
					return { exitCode: 0 };
				}

				throw new Error(`Unexpected command: ${command}`);
			},
		} as BashOperations);

		const command = piHarness.commands.get("autoresearch");
		if (command === undefined) {
			throw new Error("autoresearch command was not registered");
		}
		await command.handler("create improve-local-pdp-web-vitals", context.ctx);
		await command.handler("start improve-local-pdp-web-vitals", context.ctx);

		const runTool = piHarness.tools.get("autoresearch_run");
		const doneTool = piHarness.tools.get("autoresearch_done");
		if (runTool === undefined || doneTool === undefined) {
			throw new Error("autoresearch tools were not registered");
		}

		await runTool.execute("tool-call-1", {}, new AbortController().signal, undefined, context.ctx);
		const doneResult = await doneTool.execute(
			"tool-call-2",
			{ status: "keep", description: "kept improvement", asi: { hypothesis: "workspace" } },
			new AbortController().signal,
			undefined,
			context.ctx,
		);

		expect(execCalls.map((call) => call.command)).toEqual(["bash autoresearch.sh"]);
		expect(doneResult.content[0]?.type).toBe("text");
		if (doneResult.content[0]?.type !== "text") {
			throw new Error("expected text result");
		}
		expect(doneResult.content[0].text).toContain("Workspace changes were left untouched.");
		context.setSessionFile(controllerSession);
		await command.handler("stop improve-local-pdp-web-vitals", context.ctx);
	});

	it("finalizes discarded runs without mutating the workspace", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const controllerSession = context.ctx.sessionManager.getSessionFile();
		if (controllerSession === undefined) {
			throw new Error("missing controller session file");
		}
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const execCalls: Array<{ readonly command: string; readonly cwd: string }> = [];
		getSandboxedBashOperationsMock.mockReturnValue({
			exec: async (command, commandCwd, options) => {
				execCalls.push({ command, cwd: commandCwd });

				if (command === "bash autoresearch.sh") {
					options.onData?.(Buffer.from('METRIC metric=123\nASI hypothesis="workspace"\n'));
					return { exitCode: 0 };
				}

				throw new Error(`Unexpected command: ${command}`);
			},
		} as BashOperations);

		const command = piHarness.commands.get("autoresearch");
		if (command === undefined) {
			throw new Error("autoresearch command was not registered");
		}
		await command.handler("create improve-local-pdp-web-vitals", context.ctx);
		await command.handler("start improve-local-pdp-web-vitals", context.ctx);

		const runTool = piHarness.tools.get("autoresearch_run");
		const doneTool = piHarness.tools.get("autoresearch_done");
		if (runTool === undefined || doneTool === undefined) {
			throw new Error("autoresearch tools were not registered");
		}

		await runTool.execute("tool-call-1", {}, new AbortController().signal, undefined, context.ctx);
		const doneResult = await doneTool.execute(
			"tool-call-2",
			{ status: "discard", description: "discarded idea", asi: { hypothesis: "workspace" } },
			new AbortController().signal,
			undefined,
			context.ctx,
		);

		expect(execCalls.map((call) => call.command)).toEqual(["bash autoresearch.sh"]);
		expect(doneResult.content[0]?.type).toBe("text");
		if (doneResult.content[0]?.type !== "text") {
			throw new Error("expected text result");
		}
		expect(doneResult.content[0].text).toContain("Workspace changes were left untouched.");
		context.setSessionFile(controllerSession);
		await command.handler("stop improve-local-pdp-web-vitals", context.ctx);
	});

	it("renders autoresearch_run results differently in compact and expanded mode", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const runTool = piHarness.tools.get("autoresearch_run");
		if (runTool === undefined) {
			throw new Error("autoresearch_run tool was not registered");
		}

		const toolResult = {
			content: [{ type: "text" as const, text: "unused" }],
			details: {
				command: "bash autoresearch.sh",
				exitCode: 0,
				durationSeconds: 12.3,
				passed: true,
				crashed: false,
				timedOut: false,
				tailOutput: ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7"].join("\n"),
				llmTailOutput: "line 6\nline 7",
				checksPass: true,
				checksTimedOut: false,
				checksOutput: "",
				checksDuration: 1.2,
				parsedMetrics: { lcp_ms: 3652 },
				parsedPrimary: 3652,
				parsedAsi: null,
				metricName: "lcp_ms",
				metricUnit: "ms",
				benchmarkLogPath: "/tmp/benchmark.log",
				checksLogPath: Option.none(),
				runDirectory: "/tmp/run-0001",
				runNumber: 1,
				fullOutputPath: Option.some("/tmp/full.log"),
				truncation: {
					content: "line 6\nline 7",
					truncated: true,
					truncatedBy: "lines" as const,
					totalLines: 7,
					totalBytes: 42,
					outputLines: 2,
					outputBytes: 12,
					lastLinePartial: false,
					firstLineExceedsLimit: false,
					maxLines: 2,
					maxBytes: 4096,
				},
			},
		};

		const renderResult = runTool.renderResult as unknown as (
			result: unknown,
			options: { readonly expanded: boolean; readonly isPartial: boolean },
			theme: { readonly fg: (_color: string, text: string) => string; readonly bold: (text: string) => string },
		) => Text;

		const compact = renderResult(
			toolResult,
			{ expanded: false, isPartial: false },
			{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
		)
			.render(240)
			.join("\n");
		const expanded = renderResult(
			toolResult,
			{ expanded: true, isPartial: false },
			{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
		)
			.render(240)
			.join("\n");

		expect(compact).toContain("line 7");
		expect(compact).not.toContain("line 1");
		expect(expanded).toContain("line 1");
		expect(expanded).toContain("Full output: /tmp/full.log");
	});

	it("starts the next trial automatically after agent_end without manual resume", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const controllerSession = context.ctx.sessionManager.getSessionFile();
		if (controllerSession === undefined) {
			throw new Error("missing controller session file");
		}
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		getSandboxedBashOperationsMock.mockReturnValue({
			exec: async (command, _commandCwd, options) => {
				if (command === "bash autoresearch.sh") {
					options.onData?.(Buffer.from('METRIC metric=123\nASI hypothesis="workspace"\n'));
					return { exitCode: 0 };
				}

				throw new Error(`Unexpected command: ${command}`);
			},
		} as BashOperations);

		const command = piHarness.commands.get("autoresearch");
		const runTool = piHarness.tools.get("autoresearch_run");
		const doneTool = piHarness.tools.get("autoresearch_done");
		if (command === undefined || runTool === undefined || doneTool === undefined) {
			throw new Error("autoresearch command or tools were not registered");
		}

		await command.handler("create improve-local-pdp-web-vitals", context.ctx);
		await command.handler("start improve-local-pdp-web-vitals", context.ctx);
		expect(context.newSessionCalls).toHaveLength(1);

		const firstChildSessionFile = context.ctx.sessionManager.getSessionFile();
		await runTool.execute("tool-call-1", {}, new AbortController().signal, undefined, context.ctx);
		await doneTool.execute(
			"tool-call-2",
			{ status: "discard", description: "discarded idea", asi: { hypothesis: "workspace" } },
			new AbortController().signal,
			undefined,
			context.ctx,
		);

		await piHarness.fire("agent_end", { type: "agent_end" }, context.ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(firstChildSessionFile).not.toBe(context.ctx.sessionManager.getSessionFile());
		expect(context.newSessionCalls).toHaveLength(2);
		context.setSessionFile(controllerSession);
		await command.handler("stop improve-local-pdp-web-vitals", context.ctx);
	});
});
