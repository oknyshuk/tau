import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime, Option } from "effect";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import initRalph from "../src/ralph/index.js";
import { RalphRepoLive } from "../src/ralph/repo.js";
import {
	decodeLoopPersistedStateJsonSync,
	encodeLoopPersistedStateJsonSync,
} from "../src/loops/schema.js";
import { LoopRepoLive } from "../src/loops/repo.js";
import { LoopEngineLive } from "../src/services/loop-engine.js";
import { ExecutionRuntime } from "../src/services/execution-runtime.js";
import { Ralph, RalphLive } from "../src/services/ralph.js";
import {
	makeExecutionProfile,
	makeExecutionRuntimeStubLayer,
	makeSandboxProfile,
	makeRalphMetrics,
	makeCapabilityContract,
} from "./ralph-test-helpers.js";
import { capturePreRalphActiveTools } from "../src/ralph/session-capabilities.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type RegisteredCommand = {
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type ToolExecutionResult = {
	readonly content: readonly { readonly type: "text"; readonly text: string }[];
	readonly details: Record<string, unknown>;
	readonly isError?: boolean;
};

type SentUserMessage = {
	readonly content: string | readonly { readonly type: string; readonly text?: string }[];
	readonly options?: {
		readonly deliverAs?: "steer" | "followUp";
	};
};

type Notifications = Array<{ readonly message: string; readonly level: string }>;
type WidgetUpdates = Array<readonly string[] | undefined>;
type StatusUpdates = Array<string | undefined>;

type ContextHarness = {
	readonly ctx: ExtensionCommandContext;
	readonly notifications: Notifications;
	readonly widgetUpdates: WidgetUpdates;
	readonly statusUpdates: StatusUpdates;
	readonly newSessionCalls: ReadonlyArray<unknown>;
	readonly switchSessionCalls: readonly string[];
	readonly setSessionFile: (next: string) => void;
	readonly getSessionFile: () => string;
	readonly setActiveTools: (next: ReadonlyArray<string>) => void;
	readonly getActiveTools: () => ReadonlyArray<string>;
};

type NewSessionPlan = {
	readonly cancelled: boolean;
	readonly sessionFile?: string;
};

type RalphRuntimeHarness = {
	readonly run: <A, E>(effect: Effect.Effect<A, E, Ralph | ExecutionRuntime>) => Promise<A>;
	readonly dispose: () => Promise<void>;
};

type PiHarness = {
	readonly pi: ExtensionAPI;
	readonly commands: Map<string, RegisteredCommand>;
	readonly tools: Map<string, ToolDefinition>;
	readonly sentUserMessages: SentUserMessage[];
	readonly fire: (
		event: string,
		payload: unknown,
		ctx: ExtensionContext,
	) => Promise<readonly unknown[]>;
};

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-ralph-adapter-"));
}

function loopStatePath(cwd: string, loopName: string): string {
	return path.join(cwd, ".pi", "loops", "state", `${loopName}.json`);
}

function lifecycleToStatus(
	lifecycle: "draft" | "active" | "paused" | "completed" | "archived",
): "active" | "paused" | "completed" {
	if (lifecycle === "active") {
		return "active";
	}
	if (lifecycle === "paused" || lifecycle === "draft") {
		return "paused";
	}
	return "completed";
}

function readLoopState(cwd: string, loopName: string) {
	const state = decodeLoopPersistedStateJsonSync(
		fs.readFileSync(loopStatePath(cwd, loopName), "utf-8"),
	);
	if (state.kind !== "ralph") {
		throw new Error(`Expected ralph state for ${loopName}, got ${state.kind}`);
	}
	return {
		name: state.taskId,
		taskFile: state.taskFile,
		iteration: state.ralph.iteration,
		maxIterations: state.ralph.maxIterations,
		itemsPerIteration: state.ralph.itemsPerIteration,
		reflectEvery: state.ralph.reflectEvery,
		reflectInstructions: state.ralph.reflectInstructions,
		status: lifecycleToStatus(state.lifecycle),
		startedAt: Option.getOrElse(state.startedAt, () => state.createdAt),
		completedAt: state.completedAt,
		lastReflectionAt: state.ralph.lastReflectionAt,
		controllerSessionFile: Option.map(
			state.ownership.controller,
			(controller) => controller.sessionFile,
		),
		activeIterationSessionFile: Option.map(state.ownership.child, (child) => child.sessionFile),
		pendingDecision: state.ralph.pendingDecision,
		executionProfile: state.ralph.pinnedExecutionProfile,
	};
}

function writeLoopState(
	cwd: string,
	loopName: string,
	input: {
		readonly controllerSessionFile: string;
		readonly activeIterationSessionFile?: string;
		readonly status?: "active" | "paused" | "completed";
		readonly iteration?: number;
		readonly metrics?: ReturnType<typeof makeRalphMetrics>;
	},
): void {
	const filePath = loopStatePath(cwd, loopName);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const status = input.status ?? "active";
	const lifecycle = status === "active" ? "active" : status === "paused" ? "paused" : "completed";
	const taskFile = path.join(".pi", "loops", "tasks", `${loopName}.md`);
	fs.mkdirSync(path.join(cwd, path.dirname(taskFile)), { recursive: true });
	fs.writeFileSync(path.join(cwd, taskFile), "# Task\n", "utf-8");
	fs.writeFileSync(
		filePath,
		encodeLoopPersistedStateJsonSync({
			taskId: loopName,
			title: loopName,
			taskFile,
			kind: "ralph",
			lifecycle,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			startedAt: Option.some("2026-01-01T00:00:00.000Z"),
			completedAt:
				status === "completed" ? Option.some("2026-01-01T01:00:00.000Z") : Option.none(),
			archivedAt: Option.none(),
			ownership: {
				controller: Option.some({
					sessionId: input.controllerSessionFile,
					sessionFile: input.controllerSessionFile,
				}),
				child:
					input.activeIterationSessionFile === undefined
						? Option.none()
						: Option.some({
								sessionId: input.activeIterationSessionFile,
								sessionFile: input.activeIterationSessionFile,
							}),
			},
			ralph: {
				iteration: input.iteration ?? 1,
				maxIterations: 50,
				itemsPerIteration: 0,
				reflectEvery: 0,
				reflectInstructions: "reflect",
				lastReflectionAt: 0,
				pendingDecision: Option.none(),
				pinnedExecutionProfile: makeExecutionProfile(),
				sandboxProfile: Option.some(makeSandboxProfile()),
				metrics: input.metrics ?? makeRalphMetrics(),
				capabilityContract: makeCapabilityContract(),
				deferredConfigMutations: [],
			},
		}),
		"utf-8",
	);
}

function makeRalphRuntime(activeSubagents = false): RalphRuntimeHarness {
	const layer = RalphLive({
		hasActiveSubagents: () => Effect.succeed(activeSubagents),
	}).pipe(
		Layer.provideMerge(RalphRepoLive),
		Layer.provideMerge(LoopEngineLive.pipe(Layer.provideMerge(LoopRepoLive))),
		Layer.provideMerge(makeExecutionRuntimeStubLayer()),
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
	const notifications: Notifications = [];
	const widgetUpdates: WidgetUpdates = [];
	const statusUpdates: StatusUpdates = [];
	const newSessionCalls: unknown[] = [];
	const switchSessionCalls: string[] = [];
	let sessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
	let newSessionCounter = 0;
	let activeTools: ReadonlyArray<string> = [];

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
			getSessionId: () => "test-session",
			getSessionFile: () => sessionFile,
		},
		ui: {
			setStatus: (_key: string, text: string | undefined) => {
				statusUpdates.push(text);
			},
			setWidget: (_key: string, content: string[] | undefined) => {
				widgetUpdates.push(content);
			},
			setFooter: () => () => undefined,
			setEditorComponent: () => undefined,
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
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
		getActiveTools: () => [...activeTools],
		setActiveTools: (nextTools: ReadonlyArray<string>) => {
			activeTools = [...nextTools];
		},
		getAllTools: () => [],
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		waitForIdle: async () => undefined,
		newSession: async (options?: unknown) => {
			newSessionCalls.push(options);
			const plan = newSessionPlan[newSessionCounter] ?? { cancelled: false };
			newSessionCounter += 1;
			if (!plan.cancelled) {
				sessionFile =
					plan.sessionFile ??
					path.join(cwd, ".pi", "sessions", `child-${newSessionCounter}.session.json`);
			}
			return { cancelled: plan.cancelled };
		},
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async (target: string) => {
			switchSessionCalls.push(target);
			sessionFile = target;
			return { cancelled: false };
		},
		reload: async () => undefined,
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		notifications,
		widgetUpdates,
		statusUpdates,
		newSessionCalls,
		switchSessionCalls,
		setSessionFile: (next) => {
			sessionFile = next;
		},
		getSessionFile: () => sessionFile,
		setActiveTools: (next) => {
			activeTools = [...next];
		},
		getActiveTools: () => [...activeTools],
	};
}

function makePiHarness(): PiHarness {
	const eventHandlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Map<string, ToolDefinition>();
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
		registerTool: (tool: ToolDefinition) => {
			tools.set(tool.name, tool);
		},
		registerShortcut: () => undefined,
		registerFlag: () => undefined,
		registerMessageRenderer: () => undefined,
		sendUserMessage: (
			content: string | readonly { readonly type: string; readonly text?: string }[],
			options?: { readonly deliverAs?: "steer" | "followUp" },
		) => {
			if (options === undefined) {
				sentUserMessages.push({ content });
				return;
			}
			sentUserMessages.push({ content, options });
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
			on: () => () => undefined,
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

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("timed out waiting for condition");
}

function agentEndPayload(
	text: string,
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | undefined = "stop",
) {
	return {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
				...(stopReason === undefined ? {} : { stopReason }),
			},
		],
	};
}

describe("ralph adapter boundary freeze", () => {
	const tempDirs: string[] = [];
	const runtimes: RalphRuntimeHarness[] = [];

	afterEach(async () => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		for (const runtime of runtimes.splice(0)) {
			await runtime.dispose();
		}
	});

	it("resolves loop ownership from session file for before_agent_start and ralph_continue", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [{ cancelled: false }]);
		const iterationSession = path.join(cwd, ".pi", "sessions", "iteration-owned.session.json");
		context.setSessionFile(iterationSession);

		writeLoopState(cwd, "owned-loop", {
			controllerSessionFile: path.join(
				cwd,
				".pi",
				"sessions",
				"controller-owned.session.json",
			),
			activeIterationSessionFile: iterationSession,
			iteration: 3,
			status: "active",
		});

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const beforeStartResults = await piHarness.fire(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "continue",
				systemPrompt: "base",
			},
			context.ctx,
		);

		const beforeStartResult = beforeStartResults[0];
		if (
			typeof beforeStartResult !== "object" ||
			beforeStartResult === null ||
			!("systemPrompt" in beforeStartResult) ||
			typeof beforeStartResult.systemPrompt !== "string"
		) {
			throw new Error("expected Ralph before_agent_start prompt result");
		}

		const doneTool = piHarness.tools.get("ralph_continue");
		expect(doneTool).toBeDefined();
		const doneResult = (await doneTool?.execute(
			"call-owned",
			{},
			undefined,
			undefined,
			context.ctx,
		)) as ToolExecutionResult;

		expect(doneResult.content[0]?.text).toContain("Iteration 3 complete. Continue recorded.");
		const state = readLoopState(cwd, "owned-loop");
		expect(Option.isSome(state.pendingDecision)).toBe(true);
		if (Option.isSome(state.pendingDecision)) {
			expect(state.pendingDecision.value.kind).toBe("continue");
		}
	});

	it("closes an active owned loop when ralph_finish was called before agent_end", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [{ cancelled: false }]);
		const iterationSession = path.join(cwd, ".pi", "sessions", "iteration-done.session.json");
		context.setSessionFile(iterationSession);

		writeLoopState(cwd, "close-loop", {
			controllerSessionFile: path.join(
				cwd,
				".pi",
				"sessions",
				"controller-close.session.json",
			),
			activeIterationSessionFile: iterationSession,
			iteration: 5,
			status: "active",
		});

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);
		const finishTool = piHarness.tools.get("ralph_finish");
		expect(finishTool).toBeDefined();
		await finishTool?.execute(
			"call-finish",
			{ message: "All done." },
			undefined,
			undefined,
			context.ctx,
		);

		await piHarness.fire("agent_end", agentEndPayload("final response"), context.ctx);

		const state = readLoopState(cwd, "close-loop");
		expect(state.status).toBe("completed");
		expect(Option.isSome(state.completedAt)).toBe(true);
	});

	it("restores pre-Ralph active tools when agent_end completes the owned loop", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [{ cancelled: false }]);
		const iterationSession = path.join(cwd, ".pi", "sessions", "iteration-tools.session.json");
		context.setSessionFile(iterationSession);
		context.setActiveTools(["read", "exec_command", "agent", "memory"]);
		capturePreRalphActiveTools(iterationSession, context.ctx);
		context.setActiveTools(["read", "ralph_continue", "ralph_finish"]);

		writeLoopState(cwd, "restore-tools-loop", {
			controllerSessionFile: path.join(
				cwd,
				".pi",
				"sessions",
				"controller-tools.session.json",
			),
			activeIterationSessionFile: iterationSession,
			iteration: 2,
			status: "active",
		});

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);
		const finishTool = piHarness.tools.get("ralph_finish");
		expect(finishTool).toBeDefined();
		await finishTool?.execute(
			"call-finish-restore-tools",
			{ message: "All done." },
			undefined,
			undefined,
			context.ctx,
		);

		await piHarness.fire("agent_end", agentEndPayload("final response"), context.ctx);

		expect(context.getActiveTools()).toEqual(["read", "exec_command", "agent", "memory"]);
	});

	it("completes cleanly without UI when a finish banner is emitted on agent_end", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [{ cancelled: false }]);
		context.ctx.hasUI = false;
		context.ctx.ui.notify = () => {
			throw new Error("notify should not be called without UI");
		};
		const iterationSession = path.join(
			cwd,
			".pi",
			"sessions",
			"iteration-headless.session.json",
		);
		context.setSessionFile(iterationSession);

		writeLoopState(cwd, "headless-finish-loop", {
			controllerSessionFile: path.join(
				cwd,
				".pi",
				"sessions",
				"controller-headless.session.json",
			),
			activeIterationSessionFile: iterationSession,
			iteration: 2,
			status: "active",
		});

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);
		const finishTool = piHarness.tools.get("ralph_finish");
		expect(finishTool).toBeDefined();
		await finishTool?.execute(
			"call-finish-headless",
			{ message: "Finished without UI." },
			undefined,
			undefined,
			context.ctx,
		);

		await expect(
			piHarness.fire("agent_end", agentEndPayload("final response"), context.ctx),
		).resolves.toBeDefined();

		const state = readLoopState(cwd, "headless-finish-loop");
		expect(state.status).toBe("completed");
		expect(Option.isSome(state.completedAt)).toBe(true);
	});

	it("reports persisted-state decode failures during session events instead of throwing", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const invalidStatePath = loopStatePath(cwd, "broken-loop");
		fs.mkdirSync(path.dirname(invalidStatePath), { recursive: true });
		fs.writeFileSync(
			invalidStatePath,
			JSON.stringify(
				{
					name: "broken-loop",
					taskFile: ".pi/loops/tasks/broken-loop.md",
					iteration: 1,
					maxIterations: 10,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					status: "invalid-status",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: null,
					lastReflectionAt: 0,
					controllerSessionFile: null,
					activeIterationSessionFile: null,
					pendingDecision: null,
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
				},
				null,
				2,
			),
			"utf-8",
		);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		await expect(
			piHarness.fire("session_start", { type: "session_start" }, context.ctx),
		).resolves.toBeDefined();
		const message =
			context.notifications.find((entry) => entry.message.includes("Ralph state is invalid"))
				?.message ?? "";
		expect(message).toContain("Ralph state is invalid");
		expect(message).toContain(".pi/loops/state/broken-loop.json");
		expect(message).toContain("invalid-status");
	});

	it("keeps the Ralph widget visible on session_start while a current loop is active", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd);
		const controllerSession = context.getSessionFile();
		const unrelatedSession = path.join(cwd, ".pi", "sessions", "other.session.json");
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);

		writeLoopState(cwd, "ui-loop", {
			controllerSessionFile: controllerSession,
			metrics: {
				totalTokens: 1_500,
				totalCostUsd: 1.25,
				activeDurationMs: 120_000,
				activeStartedAt: Option.none(),
			},
		});

		context.setSessionFile(unrelatedSession);
		const piHarness = makePiHarness();
		initRalph(piHarness.pi, ralphRuntime.run);

		await piHarness.fire("session_start", { type: "session_start" }, context.ctx);

		expect(context.widgetUpdates.at(-1)).toEqual(
			expect.arrayContaining([
				"Ralph Wiggum",
				"Loop: ui-loop",
				"Runtime: 2m 0s",
				"Usage: 1.5k tokens · $1.25",
			]),
		);
		expect(context.statusUpdates.at(-1)).toContain("ui-loop");
	});

	it("keeps session actions command-owned: tools/events do not call newSession or switchSession", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [{ cancelled: true }, { cancelled: true }]);
		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime();
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const doneTool = piHarness.tools.get("ralph_continue");
		const command = piHarness.commands.get("ralph");
		expect(doneTool).toBeDefined();
		expect(command).toBeDefined();

		const activeOwnedSession = context.getSessionFile();
		writeLoopState(cwd, "tool-owned-loop", {
			controllerSessionFile: path.join(
				cwd,
				".pi",
				"sessions",
				"controller-tool-owned.session.json",
			),
			activeIterationSessionFile: activeOwnedSession,
			iteration: 7,
			status: "active",
		});

		const doneResult = (await doneTool?.execute(
			"call-done",
			{},
			undefined,
			undefined,
			context.ctx,
		)) as ToolExecutionResult;
		expect(doneResult.content[0]?.text).toContain("Iteration 7 complete. Continue recorded.");

		const activeDoneState = readLoopState(cwd, "tool-owned-loop");
		expect(activeDoneState.status).toBe("active");
		expect(Option.isSome(activeDoneState.pendingDecision)).toBe(true);
		if (Option.isSome(activeDoneState.pendingDecision)) {
			expect(activeDoneState.pendingDecision.value.kind).toBe("continue");
		}

		await piHarness.fire(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "test",
				systemPrompt: "base",
			},
			context.ctx,
		);

		await piHarness.fire("session_start", { type: "session_start" }, context.ctx);
		await piHarness.fire("session_switch", { type: "session_switch" }, context.ctx);
		await piHarness.fire("session_shutdown", { type: "session_shutdown" }, context.ctx);
		writeLoopState(cwd, "tool-owned-loop", {
			controllerSessionFile: path.join(
				cwd,
				".pi",
				"sessions",
				"controller-tool-owned.session.json",
			),
			iteration: 7,
			status: "paused",
		});

		expect(context.newSessionCalls).toHaveLength(0);
		expect(context.switchSessionCalls).toHaveLength(0);

		await command?.handler("start command-loop", context.ctx);
		await waitFor(() => context.newSessionCalls.length === 1);
		expect(context.newSessionCalls).toHaveLength(1);

		const controllerSession = Option.getOrUndefined(
			readLoopState(cwd, "command-loop").controllerSessionFile,
		);
		if (!controllerSession) {
			throw new Error("missing controller session");
		}
		context.setSessionFile(path.join(cwd, ".pi", "sessions", "other.session.json"));

		await command?.handler("resume command-loop", context.ctx);
		await waitFor(() => context.switchSessionCalls.includes(controllerSession));
		expect(context.switchSessionCalls).toContain(controllerSession);
	});

});
