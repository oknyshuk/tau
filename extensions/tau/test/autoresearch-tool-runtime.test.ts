import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { Option } from "effect";
import { Text } from "@mariozechner/pi-tui";

import type {
	BashOperations,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import { LoopRepoLive } from "../src/loops/repo.js";
import { LoopEngine } from "../src/services/loop-engine.js";
import { LoopEngineLive } from "../src/services/loop-engine.js";
import { ExecutionRuntime } from "../src/services/execution-runtime.js";
import { Sandbox } from "../src/services/sandbox.js";
import {
	AutoresearchLoopRunner,
	AutoresearchLoopRunnerLive,
} from "../src/services/autoresearch-loop-runner.js";
import {
	makeExecutionProfile,
	makeExecutionRuntimeStubLayer,
} from "./ralph-test-helpers.js";

const getSandboxedBashOperationsMock =
	vi.fn<(ctx: ExtensionContext, escalate: boolean) => BashOperations | undefined>();

vi.mock("../src/sandbox/index.js", () => ({
	getSandboxedBashOperations: (ctx: ExtensionContext, escalate: boolean) =>
		getSandboxedBashOperationsMock(ctx, escalate),
}));

import initAutoresearch from "../src/autoresearch/index.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type RegisteredCommand = {
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type NewSessionPlan = {
	readonly cancelled: boolean;
	readonly sessionFile?: string;
};

type ReplacementSessionOptions = {
	readonly withSession?: (ctx: ExtensionCommandContext) => Promise<void> | void;
};

type ContextHarness = {
	readonly ctx: ExtensionCommandContext;
	readonly newSessionCalls: ReadonlyArray<unknown>;
	readonly setSessionFile: (next: string) => void;
};

type PiHarness = {
	readonly pi: ExtensionAPI;
	readonly commands: Map<string, RegisteredCommand>;
	readonly tools: Map<string, ToolDefinition>;
	readonly activeTools: () => readonly string[];
	readonly fire: (
		event: string,
		payload: unknown,
		ctx: ExtensionContext,
	) => Promise<readonly unknown[]>;
};

type RuntimeHarness = {
	readonly run: <A, E>(
		effect: Effect.Effect<
			A,
			E,
			LoopEngine | Sandbox | ExecutionRuntime | AutoresearchLoopRunner
		>,
	) => Promise<A>;
	readonly dispose: () => Promise<void>;
};

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-autoresearch-tool-runtime-"));
}

function sessionIdFromFile(sessionFile: string): string {
	return path.basename(sessionFile, path.extname(sessionFile));
}

function makeRuntime(
	executionRuntimeLayer = makeExecutionRuntimeStubLayer(),
): RuntimeHarness {
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
		Layer.provideMerge(executionRuntimeLayer),
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
	const newSessionCalls: unknown[] = [];
	let sessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
	let sessionId = sessionIdFromFile(sessionFile);
	let newSessionCounter = 0;

	const setSessionFile = (next: string): void => {
		sessionFile = next;
		sessionId = sessionIdFromFile(next);
	};

	const ctx = {
		cwd,
		hasUI: true,
		model: undefined,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			getAll: () => [],
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => projectSessionId ?? sessionId,
			getSessionFile: () => sessionFile,
		},
		ui: {
			setStatus: () => undefined,
			setWidget: () => undefined,
			setFooter: () => () => undefined,
			setEditorComponent: () => undefined,
			notify: () => undefined,
			confirm: async () => true,
			getEditorText: () => "",
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
		isIdle: () => true,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		waitForIdle: async () => undefined,
		newSession: async (options?: unknown) => {
			newSessionCalls.push(options);
			const plan = newSessionPlan[newSessionCounter] ?? { cancelled: false };
			newSessionCounter += 1;
			if (!plan.cancelled) {
				const nextSessionFile =
					plan.sessionFile ??
					path.join(cwd, ".pi", "sessions", `child-${newSessionCounter}.session.json`);
				setSessionFile(nextSessionFile);
				if (
					typeof options === "object" &&
					options !== null &&
					"withSession" in options &&
					typeof options.withSession === "function"
				) {
					await (options as ReplacementSessionOptions).withSession?.(
						ctx as unknown as ExtensionCommandContext,
					);
				}
			}
			return { cancelled: plan.cancelled };
		},
		switchSession: async (target: string, options?: ReplacementSessionOptions) => {
			setSessionFile(target);
			await options?.withSession?.(ctx as unknown as ExtensionCommandContext);
			return { cancelled: false };
		},
	};

	return {
		ctx: ctx as unknown as ExtensionCommandContext,
		newSessionCalls,
		setSessionFile,
	};
}

const STALE_CONTEXT_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

function makeStaleInvalidatingContext(
	cwd: string,
	onReplacementSession?: (ctx: ExtensionCommandContext) => Promise<void>,
): ContextHarness {
	const newSessionCalls: unknown[] = [];
	const staleContexts = new WeakSet<object>();
	let newSessionCounter = 0;
	let latestSessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");

	const assertLive = (ctx: object): void => {
		if (staleContexts.has(ctx)) {
			throw new Error(STALE_CONTEXT_MESSAGE);
		}
	};

	const makeLiveContext = (initialSessionFile: string): ExtensionCommandContext => {
		let sessionFile = initialSessionFile;
		const ctx = {
			get cwd() {
				assertLive(ctx);
				return cwd;
			},
			get hasUI() {
				assertLive(ctx);
				return true;
			},
			get model() {
				assertLive(ctx);
				return undefined;
			},
			modelRegistry: {
				find: (provider: string, id: string) => ({ provider, id }),
				getAll: () => [],
			},
			sessionManager: {
				getEntries: () => [],
				getBranch: () => [],
				getSessionId: () => sessionIdFromFile(sessionFile),
				getSessionFile: () => sessionFile,
			},
			ui: {
				setStatus: () => undefined,
				setWidget: () => undefined,
				setFooter: () => () => undefined,
				setEditorComponent: () => undefined,
				notify: () => undefined,
				confirm: async () => true,
				getEditorText: () => "",
				theme: {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				},
			},
			isIdle: () => true,
			abort: () => undefined,
			hasPendingMessages: () => false,
			shutdown: () => undefined,
			getContextUsage: () => undefined,
			compact: () => undefined,
			getSystemPrompt: () => "",
			waitForIdle: async () => undefined,
			newSession: async (options?: unknown) => {
				assertLive(ctx);
				newSessionCalls.push(options);
				newSessionCounter += 1;
				const nextSessionFile = path.join(
					cwd,
					".pi",
					"sessions",
					`child-${newSessionCounter}.session.json`,
				);
				latestSessionFile = nextSessionFile;
				sessionFile = nextSessionFile;
				const replacementContext = makeLiveContext(nextSessionFile);
				await onReplacementSession?.(replacementContext);
				if (
					typeof options === "object" &&
					options !== null &&
					"withSession" in options &&
					typeof options.withSession === "function"
				) {
					await (options as ReplacementSessionOptions).withSession?.(replacementContext);
				}
				staleContexts.add(ctx);
				return { cancelled: false };
			},
			switchSession: async (target: string, options?: ReplacementSessionOptions) => {
				assertLive(ctx);
				latestSessionFile = target;
				sessionFile = target;
				const replacementContext = makeLiveContext(target);
				await onReplacementSession?.(replacementContext);
				await options?.withSession?.(replacementContext);
				staleContexts.add(ctx);
				return { cancelled: false };
			},
		};

		return ctx as unknown as ExtensionCommandContext;
	};

	return {
		ctx: makeLiveContext(latestSessionFile),
		newSessionCalls,
		setSessionFile: (next) => {
			latestSessionFile = next;
		},
	};
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

	it("does not use the command context after creating the child session", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeStaleInvalidatingContext(cwd);
		const piHarness = makePiHarness();
		const runtime = makeRuntime();
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const command = piHarness.commands.get("autoresearch");
		if (command === undefined) {
			throw new Error("autoresearch command was not registered");
		}

		await command.handler("create stale-command-context", context.ctx);
		await expect(
			command.handler("start stale-command-context", context.ctx),
		).resolves.toBeUndefined();

		expect(context.newSessionCalls).toHaveLength(1);
	});

	it("applies the child execution profile through the replacement session extension", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		let staleApplyCalls = 0;
		let replacementApplyCalls = 0;
		let replacementBootstrapped = false;
		const piHarness = makePiHarness();
		const profile = makeExecutionProfile();
		const staleExecutionRuntimeLayer = Layer.succeed(
			ExecutionRuntime,
			ExecutionRuntime.of({
				setup: Effect.void,
				captureCurrentExecutionProfile: () => Effect.succeed(profile),
				applyExecutionProfile: () =>
					Effect.sync(() => {
						staleApplyCalls += 1;
						throw new Error(STALE_CONTEXT_MESSAGE);
					}),
			}),
		);
		const replacementExecutionRuntimeLayer = Layer.succeed(
			ExecutionRuntime,
			ExecutionRuntime.of({
				setup: Effect.void,
				captureCurrentExecutionProfile: () => Effect.succeed(profile),
				applyExecutionProfile: (nextProfile) =>
					Effect.succeed({
						applied: true as const,
						profile: nextProfile,
					}).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								replacementApplyCalls += 1;
							}),
						),
					),
			}),
		);
		const context = makeStaleInvalidatingContext(cwd, async (replacementContext) => {
			if (replacementBootstrapped) {
				return;
			}
			replacementBootstrapped = true;
			const replacementRuntime = makeRuntime(replacementExecutionRuntimeLayer);
			runtimes.push(replacementRuntime);
			initAutoresearch(piHarness.pi, replacementRuntime.run);
			await piHarness.fire(
				"session_start",
				{ type: "session_start", reason: "new" },
				replacementContext,
			);
		});
		const runtime = makeRuntime(staleExecutionRuntimeLayer);
		runtimes.push(runtime);
		initAutoresearch(piHarness.pi, runtime.run);

		const command = piHarness.commands.get("autoresearch");
		if (command === undefined) {
			throw new Error("autoresearch command was not registered");
		}

		await command.handler("create replacement-profile-applier", context.ctx);
		await expect(
			command.handler("start replacement-profile-applier", context.ctx),
		).resolves.toBeUndefined();

		const state = await runtime.run(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;
				const loops = yield* engine.listLoops(cwd, false);
				return loops.find((loop) => loop.taskId === "replacement-profile-applier");
			}),
		);
		expect(replacementBootstrapped).toBe(true);
		expect(staleApplyCalls).toBe(0);
		expect(replacementApplyCalls).toBe(1);
		expect(state?.kind).toBe("autoresearch");
		expect(Option.isSome(state?.ownership.child ?? Option.none())).toBe(true);
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
					options.onData?.(
						Buffer.from('METRIC metric=123\nASI hypothesis="workspace"\n'),
					);
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
					options.onData?.(
						Buffer.from('METRIC metric=123\nASI hypothesis="workspace"\n'),
					);
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

		await runTool.execute(
			"tool-call-1",
			{},
			new AbortController().signal,
			undefined,
			context.ctx,
		);
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
					options.onData?.(
						Buffer.from('METRIC metric=123\nASI hypothesis="workspace"\n'),
					);
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

		await runTool.execute(
			"tool-call-1",
			{},
			new AbortController().signal,
			undefined,
			context.ctx,
		);
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
				tailOutput: [
					"line 1",
					"line 2",
					"line 3",
					"line 4",
					"line 5",
					"line 6",
					"line 7",
				].join("\n"),
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
			theme: {
				readonly fg: (_color: string, text: string) => string;
				readonly bold: (text: string) => string;
			},
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
					options.onData?.(
						Buffer.from('METRIC metric=123\nASI hypothesis="workspace"\n'),
					);
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
		await runTool.execute(
			"tool-call-1",
			{},
			new AbortController().signal,
			undefined,
			context.ctx,
		);
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
