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
	SessionManager,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import initRalph from "../src/ralph/index.js";
import { RalphRepoLive } from "../src/ralph/repo.js";
import type { LoopState } from "../src/ralph/schema.js";
import { TAU_PERSISTED_STATE_TYPE } from "../src/shared/state.js";
import { DEFAULT_SANDBOX_CONFIG, type ResolvedSandboxConfig } from "../src/sandbox/config.js";
import {
	decodeLoopPersistedStateJsonSync,
	encodeLoopPersistedStateJsonSync,
} from "../src/loops/schema.js";
import { LoopRepoLive } from "../src/loops/repo.js";
import { LoopEngineLive } from "../src/services/loop-engine.js";
import { ExecutionRuntime } from "../src/services/execution-runtime.js";
import {
	Ralph,
	RalphLive,
	resetRalphIterationSignalBridgeForTests,
} from "../src/services/ralph.js";
import {
	makeExecutionProfile,
	makeExecutionRuntimeStubLayer,
	makeRalphMetrics,
	makeCapabilityContract,
} from "./ralph-test-helpers.js";
import {
	STALE_EXTENSION_CONTEXT_MESSAGE,
	type FakeCommandContext as ContextHarness,
	type NewSessionPlan,
	makeFakeCommandContext,
} from "./fake-command-context.js";
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

type RalphRuntimeHarness = {
	readonly run: <A, E>(effect: Effect.Effect<A, E, Ralph | ExecutionRuntime>) => Promise<A>;
	readonly dispose: () => Promise<void>;
};

type PiHarness = {
	readonly pi: ExtensionAPI;
	readonly commands: Map<string, RegisteredCommand>;
	readonly tools: Map<string, ToolDefinition>;
	readonly sentUserMessages: SentUserMessage[];
	readonly fire: (event: string, payload: unknown, ctx: ExtensionContext) => Promise<void>;
};

type PiHarnessOptions = {
	readonly setActiveTools?: (tools: string[]) => void;
};

type LoopStatus = "active" | "paused" | "completed";

function makeRalphRuntime(
	activeSubagents: boolean,
	executionRuntimeLayer: Layer.Layer<ExecutionRuntime, never, never> = makeExecutionRuntimeStubLayer(),
): RalphRuntimeHarness {
	const layer = RalphLive({
		hasActiveSubagents: () => Effect.succeed(activeSubagents),
	}).pipe(
		Layer.provideMerge(RalphRepoLive),
		Layer.provideMerge(LoopEngineLive.pipe(Layer.provideMerge(LoopRepoLive))),
		Layer.provideMerge(executionRuntimeLayer),
		Layer.provide(NodeFileSystem.layer),
	);
	const runtime = ManagedRuntime.make(layer);
	return {
		run: (effect) => runtime.runPromise(effect),
		dispose: () => runtime.dispose(),
	};
}

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-ralph-service-"));
}

function loopStatePath(cwd: string, loopName: string): string {
	return path.join(cwd, ".pi", "loops", "state", `${loopName}.json`);
}

function lifecycleToStatus(
	lifecycle: "draft" | "active" | "paused" | "completed" | "archived",
): LoopStatus {
	switch (lifecycle) {
		case "active":
			return "active";
		case "draft":
		case "paused":
			return "paused";
		case "completed":
		case "archived":
			return "completed";
	}
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
		sandboxProfile: state.ralph.sandboxProfile,
		capabilityContract: state.ralph.capabilityContract,
		deferredConfigMutations: state.ralph.deferredConfigMutations,
	};
}

const FULL_ACCESS_SANDBOX_PROFILE: ResolvedSandboxConfig = {
	...DEFAULT_SANDBOX_CONFIG,
	preset: "full-access",
	filesystemMode: "danger-full-access",
	networkMode: "allow-all",
	approvalPolicy: "never",
};

const READ_ONLY_SANDBOX_PROFILE: ResolvedSandboxConfig = {
	...DEFAULT_SANDBOX_CONFIG,
	preset: "read-only",
	filesystemMode: "read-only",
	networkMode: "deny",
	approvalPolicy: "on-request",
};

function writeLoopState(
	cwd: string,
	loopName: string,
	input: {
		readonly status?: LoopStatus;
		readonly iteration?: number;
		readonly controllerSessionFile: string;
		readonly activeIterationSessionFile?: string;
		readonly sandboxProfile?: ResolvedSandboxConfig;
		readonly pendingDecision?:
			| {
					readonly kind: "continue";
					readonly requestedAt: string;
			  }
			| {
					readonly kind: "finish";
					readonly requestedAt: string;
					readonly message: string;
			  };
		readonly deferredConfigMutations?: LoopState["deferredConfigMutations"];
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
				pendingDecision:
					input.pendingDecision === undefined
						? Option.none()
						: Option.some(input.pendingDecision),
				pinnedExecutionProfile: makeExecutionProfile(),
				sandboxProfile: Option.some(input.sandboxProfile ?? DEFAULT_SANDBOX_CONFIG),
				metrics: makeRalphMetrics(),
				capabilityContract: makeCapabilityContract(),
				deferredConfigMutations: input.deferredConfigMutations ?? [],
			},
		}),
		"utf-8",
	);
}

function makeContext(
	cwd: string,
	newSessionPlan: readonly NewSessionPlan[] = [{ cancelled: false }],
	initialEntries: readonly unknown[] = [],
	replacementEntries: readonly unknown[] = initialEntries,
): ContextHarness {
	return makeFakeCommandContext({
		cwd,
		newSessionPlan,
		initialEntries,
		replacementEntries,
		staleAfterSwitchSession: true,
	});
}

function makePiHarness(options: PiHarnessOptions = {}): PiHarness {
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
		setActiveTools: options.setActiveTools ?? (() => undefined),
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
			for (const handler of eventHandlers.get(event) ?? []) {
				await Promise.resolve(handler(payload, ctx));
			}
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
	errorMessage?: string,
) {
	return {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
				...(stopReason === undefined ? {} : { stopReason }),
				...(errorMessage === undefined ? {} : { errorMessage }),
			},
		],
	};
}

function agentEndPayloadWithoutAssistant() {
	return {
		type: "agent_end",
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "no assistant reply arrived" }],
			},
		],
	};
}

describe("ralph service behavior freeze", () => {
	const tempDirs: string[] = [];
	const runtimes: RalphRuntimeHarness[] = [];

	afterEach(async () => {
		resetRalphIterationSignalBridgeForTests();
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		for (const runtime of runtimes.splice(0)) {
			await runtime.dispose();
		}
	});

	it("keeps iteration ownership across handled child-session ends until ralph_continue", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const childHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		const childRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime, childRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);
		initRalph(childHarness.pi, childRuntime.run);

		const command = piHarness.commands.get("ralph");
		const doneTool = piHarness.tools.get("ralph_continue");
		expect(command).toBeDefined();
		expect(doneTool).toBeDefined();

		const context = makeContext(cwd, [{ cancelled: false }]);

		let startResolved = false;
		const startPromise = Promise.resolve(
			command?.handler("start handled-error-loop --max-iterations 1", context.ctx),
		).then(() => {
			startResolved = true;
		});
		await waitFor(() => piHarness.sentUserMessages.length === 1);

		await piHarness.fire("agent_end", agentEndPayload("apply_patch failed once"), context.ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(startResolved).toBe(false);

		const afterFirstIteration = readLoopState(cwd, "handled-error-loop");
		expect(afterFirstIteration.status).toBe("active");
		expect(afterFirstIteration.iteration).toBe(1);
		expect(Option.isNone(afterFirstIteration.pendingDecision)).toBe(true);
		expect(Option.getOrUndefined(afterFirstIteration.activeIterationSessionFile)).toBe(
			context.getSessionFile(),
		);

		const doneResult = (await doneTool?.execute(
			"call-1",
			{},
			undefined,
			undefined,
			context.ctx,
		)) as ToolExecutionResult;

		expect(doneResult.content[0]?.text).toContain("Iteration 1 complete. Continue recorded.");

		const afterDone = readLoopState(cwd, "handled-error-loop");
		expect(afterDone.status).toBe("active");
		expect(Option.isSome(afterDone.pendingDecision)).toBe(true);
		if (Option.isSome(afterDone.pendingDecision)) {
			expect(afterDone.pendingDecision.value.kind).toBe("continue");
		}
		expect(Option.getOrUndefined(afterDone.activeIterationSessionFile)).toBe(
			context.getSessionFile(),
		);

		await piHarness.fire("agent_end", agentEndPayload("patched successfully"), context.ctx);
		await startPromise;

		const finalState = readLoopState(cwd, "handled-error-loop");
		expect(finalState.status).toBe("paused");
		expect(finalState.iteration).toBe(1);
		expect(Option.isNone(finalState.pendingDecision)).toBe(true);
		expect(Option.isNone(finalState.completedAt)).toBe(true);
		expect(context.newSessionCalls).toHaveLength(1);
	});

	it("pauses the loop when the owned iteration session shuts down before a Ralph handshake tool", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const childHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		const childRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime, childRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);
		initRalph(childHarness.pi, childRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const context = makeContext(cwd, [{ cancelled: false }]);
		const startPromise = command.handler("start shutdown-loop", context.ctx);
		await waitFor(() => piHarness.sentUserMessages.length === 1);

		await piHarness.fire("session_shutdown", { type: "session_shutdown" }, context.ctx);
		await startPromise;

		const state = readLoopState(cwd, "shutdown-loop");
		expect(state.status).toBe("paused");
		expect(state.iteration).toBe(1);
		expect(Option.isNone(state.pendingDecision)).toBe(true);
		expect(Option.isNone(state.activeIterationSessionFile)).toBe(true);
	});

	it("exits cleanly when the iteration session shuts down after the command context is disposed", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const context = makeContext(cwd, [{ cancelled: false }]);
		const startPromise = Promise.resolve(
			command.handler("start disposed-shutdown-loop", context.ctx),
		);
		await waitFor(() => piHarness.sentUserMessages.length === 1);

		context.disposeCommandContext();
		await piHarness.fire("session_shutdown", { type: "session_shutdown" }, context.ctx);

		await expect(startPromise).resolves.toBeUndefined();

		const state = readLoopState(cwd, "disposed-shutdown-loop");
		expect(state.status).toBe("paused");
		expect(state.iteration).toBe(1);
		expect(Option.isNone(state.pendingDecision)).toBe(true);
		expect(Option.isNone(state.activeIterationSessionFile)).toBe(true);
	});

	it("pauses /ralph start when applying the execution profile defects", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const executionProfile = makeExecutionProfile();
		const failingExecutionRuntimeLayer = Layer.succeed(
			ExecutionRuntime,
			ExecutionRuntime.of({
				setup: Effect.void,
				captureCurrentExecutionProfile: () => Effect.succeed(executionProfile),
				applyExecutionProfile: () =>
					Effect.die(new Error("command context disposed during applyExecutionProfile")),
			}),
		);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false, failingExecutionRuntimeLayer);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const context = makeContext(cwd, [{ cancelled: false }]);
		await expect(
			command.handler("start apply-profile-defect", context.ctx),
		).resolves.toBeUndefined();
		await waitFor(() => readLoopState(cwd, "apply-profile-defect").status === "paused");
		await waitFor(() =>
			context.notifications.some((entry) =>
				entry.message.includes("Could not apply Ralph execution profile"),
			),
		);

		const state = readLoopState(cwd, "apply-profile-defect");
		expect(state.status).toBe("paused");
		expect(state.iteration).toBe(1);
		expect(Option.isNone(state.pendingDecision)).toBe(true);
		expect(Option.isNone(state.activeIterationSessionFile)).toBe(true);
		const hasFailureNotification = context.notifications.some((entry) =>
			entry.message.includes("Could not apply Ralph execution profile"),
		);
		expect(hasFailureNotification).toBe(true);
	});

	it("dispatches Ralph prompts through the active child-session runtime after newSession", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const controllerHarness = makePiHarness();
		const childHarness = makePiHarness();
		const executionProfile = makeExecutionProfile();
		const controllerExecutionRuntimeLayer = Layer.succeed(
			ExecutionRuntime,
			ExecutionRuntime.of({
				setup: Effect.void,
				captureCurrentExecutionProfile: () => Effect.succeed(executionProfile),
				applyExecutionProfile: () => Effect.die(new Error("stale controller pi")),
			}),
		);
		const childExecutionRuntimeLayer = Layer.succeed(
			ExecutionRuntime,
			ExecutionRuntime.of({
				setup: Effect.void,
				captureCurrentExecutionProfile: () => Effect.succeed(executionProfile),
				applyExecutionProfile: (nextProfile, ctx) =>
					Effect.sync(() => {
						ctx.modelRegistry.getAll();
						return { applied: true as const, profile: nextProfile };
					}),
			}),
		);
		const controllerRuntime = makeRalphRuntime(false, controllerExecutionRuntimeLayer);
		const childRuntime = makeRalphRuntime(false, childExecutionRuntimeLayer);
		runtimes.push(controllerRuntime, childRuntime);
		initRalph(controllerHarness.pi, controllerRuntime.run);
		initRalph(childHarness.pi, childRuntime.run);

		const command = controllerHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const childSessionFile = path.join(cwd, ".pi", "sessions", "captured-child.session.json");
		const childContext = makeContext(cwd);
		childContext.setSessionFile(childSessionFile);
		await childHarness.fire("session_start", { type: "session_start" }, childContext.ctx);

		const context = makeContext(cwd, [
			{
				cancelled: false,
				sessionFile: childSessionFile,
				updateContextSessionFile: false,
			},
		]);

		const startPromise = Promise.resolve(
			command.handler("start captured-child-loop", context.ctx),
		);
		await waitFor(() => childHarness.sentUserMessages.length === 1);
		expect(controllerHarness.sentUserMessages).toHaveLength(0);

		const activeState = readLoopState(cwd, "captured-child-loop");
		expect(Option.getOrUndefined(activeState.activeIterationSessionFile)).toBe(
			childSessionFile,
		);

		await childHarness.fire("session_shutdown", { type: "session_shutdown" }, childContext.ctx);
		await startPromise;

		const finalState = readLoopState(cwd, "captured-child-loop");
		expect(finalState.status).toBe("paused");
		expect(Option.isNone(finalState.activeIterationSessionFile)).toBe(true);
	});

	it("restores active tools after the waiting Ralph loop completes from ralph_finish", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const controllerHarness = makePiHarness();
		const childHarness = makePiHarness();
		const controllerRuntime = makeRalphRuntime(false);
		const childRuntime = makeRalphRuntime(false);
		runtimes.push(controllerRuntime, childRuntime);
		initRalph(controllerHarness.pi, controllerRuntime.run);
		initRalph(childHarness.pi, childRuntime.run);

		const command = controllerHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const childSessionFile = path.join(cwd, ".pi", "sessions", "finish-child.session.json");
		const childContext = makeContext(cwd);
		childContext.setSessionFile(childSessionFile);
		await childHarness.fire("session_start", { type: "session_start" }, childContext.ctx);

		const context = makeContext(cwd, [
			{
				cancelled: false,
				sessionFile: childSessionFile,
				updateContextSessionFile: false,
			},
		]);

		const startPromise = Promise.resolve(command.handler("start finish-loop", context.ctx));
		await waitFor(() => childHarness.sentUserMessages.length === 1);

		const finishTool = childHarness.tools.get("ralph_finish");
		expect(finishTool).toBeDefined();
		await finishTool?.execute(
			"finish-waiting-loop",
			{ message: "All done." },
			undefined,
			undefined,
			childContext.ctx,
		);
		await childHarness.fire("agent_end", agentEndPayload("final response"), childContext.ctx);
		await startPromise;

		const finalState = readLoopState(cwd, "finish-loop");
		expect(finalState.status).toBe("completed");
		expect(context.activeToolCalls.at(-1)).toEqual([]);
	});

	it("keeps Ralph start work on the replacement session context after newSession", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const controllerHarness = makePiHarness({
			setActiveTools: () => {
				throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
			},
		});
		const childHarness = makePiHarness();
		const executionProfile = makeExecutionProfile();
		const controllerExecutionRuntimeLayer = Layer.succeed(
			ExecutionRuntime,
			ExecutionRuntime.of({
				setup: Effect.void,
				captureCurrentExecutionProfile: () => Effect.succeed(executionProfile),
				applyExecutionProfile: () => Effect.die(new Error("stale controller pi")),
			}),
		);
		const childExecutionRuntimeLayer = Layer.succeed(
			ExecutionRuntime,
			ExecutionRuntime.of({
				setup: Effect.void,
				captureCurrentExecutionProfile: () => Effect.succeed(executionProfile),
				applyExecutionProfile: (nextProfile, ctx) =>
					Effect.sync(() => {
						ctx.modelRegistry.getAll();
						return { applied: true as const, profile: nextProfile };
					}),
			}),
		);
		const controllerRuntime = makeRalphRuntime(false, controllerExecutionRuntimeLayer);
		const childRuntime = makeRalphRuntime(false, childExecutionRuntimeLayer);
		runtimes.push(controllerRuntime, childRuntime);
		initRalph(controllerHarness.pi, controllerRuntime.run);
		initRalph(childHarness.pi, childRuntime.run);

		const command = controllerHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const childSessionFile = path.join(
			cwd,
			".pi",
			"sessions",
			"stale-guard-child.session.json",
		);
		const childContext = makeContext(cwd);
		childContext.setSessionFile(childSessionFile);
		await childHarness.fire("session_start", { type: "session_start" }, childContext.ctx);

		const context = makeContext(cwd, [
			{
				cancelled: false,
				sessionFile: childSessionFile,
				updateContextSessionFile: false,
				staleContextAfterReplacement: true,
			},
		]);

		const startPromise = Promise.resolve(
			command.handler("start stale-guard-loop", context.ctx),
		);
		await waitFor(() => childHarness.sentUserMessages.length === 1);
		expect(controllerHarness.sentUserMessages).toHaveLength(0);

		await childHarness.fire("session_shutdown", { type: "session_shutdown" }, childContext.ctx);
		await expect(startPromise).resolves.toBeUndefined();

		const finalState = readLoopState(cwd, "stale-guard-loop");
		expect(finalState.status).toBe("paused");
		expect(Option.isNone(finalState.activeIterationSessionFile)).toBe(true);
	});

	it("stores the start sandbox profile and copies it into Ralph iteration sessions", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const context = makeContext(
			cwd,
			[{ cancelled: false }],
			[
				{
					type: "custom",
					customType: TAU_PERSISTED_STATE_TYPE,
					data: {
						sandbox: {
							sessionOverride: {
								preset: "full-access",
								subagent: false,
								approvalTimeoutSeconds: 60,
							},
							systemPromptInjected: true,
							lastCommunicatedHash: "old-hash",
						},
					},
				},
			],
		);

		const startPromise = Promise.resolve(
			command.handler("start sandbox-copy-loop", context.ctx),
		);
		await waitFor(() => context.appendedCustomEntries.length === 1);

		expect(context.appendedCustomEntries[0]).toEqual({
			customType: TAU_PERSISTED_STATE_TYPE,
			data: {
				sandbox: {
					sessionOverride: {
						preset: "full-access",
						subagent: false,
						approvalTimeoutSeconds: 60,
					},
				},
			},
		});

		const state = readLoopState(cwd, "sandbox-copy-loop");
		expect(Option.getOrUndefined(state.sandboxProfile)).toEqual(FULL_ACCESS_SANDBOX_PROFILE);

		await piHarness.fire("session_shutdown", { type: "session_shutdown" }, context.ctx);
		await expect(startPromise).resolves.toBeUndefined();
	});

	it("rejects legacy loops without sandbox profiles", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const childHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		const childRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime, childRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);
		initRalph(childHarness.pi, childRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const controllerSessionFile = path.join(
			cwd,
			".pi",
			"sessions",
			"legacy-controller.session.json",
		);
		const childSessionFile = path.join(cwd, ".pi", "sessions", "legacy-child.session.json");
		const childContext = makeContext(cwd);
		childContext.setSessionFile(childSessionFile);
		await childHarness.fire("session_start", { type: "session_start" }, childContext.ctx);
		writeLoopState(cwd, "legacy-sandbox-loop", {
			controllerSessionFile,
			iteration: 2,
			status: "paused",
		});

		const stateFile = loopStatePath(cwd, "legacy-sandbox-loop");
		const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as unknown;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			throw new Error("expected legacy loop state object");
		}
		const rawState = raw as { readonly ralph?: unknown };
		if (
			typeof rawState.ralph !== "object" ||
			rawState.ralph === null ||
			Array.isArray(rawState.ralph)
		) {
			throw new Error("expected legacy ralph details object");
		}
		const { sandboxProfile: _sandboxProfile, ...legacyRalph } = rawState.ralph as Record<
			string,
			unknown
		>;
		fs.writeFileSync(
			stateFile,
			JSON.stringify({ ...raw, ralph: legacyRalph }, null, 2),
			"utf-8",
		);

		const context = makeContext(
			cwd,
			[
				{
					cancelled: false,
					sessionFile: childSessionFile,
					updateContextSessionFile: false,
				},
			],
			[
				{
					type: "custom",
					customType: TAU_PERSISTED_STATE_TYPE,
					data: {
						sandbox: {
							sessionOverride: { preset: "read-only" },
						},
					},
				},
			],
			[
				{
					type: "custom",
					customType: TAU_PERSISTED_STATE_TYPE,
					data: {
						sandbox: {
							sessionOverride: { preset: "full-access" },
						},
					},
				},
			],
		);
		context.setSessionFile(path.join(cwd, ".pi", "sessions", "other.session.json"));

		await command.handler("resume legacy-sandbox-loop", context.ctx);

		expect(context.appendedCustomEntries).toHaveLength(0);
		expect(
			context.notifications.some((entry) =>
				entry.message.includes("Missing key") && entry.message.includes("sandboxProfile"),
			),
		).toBe(true);
	});

	it("creates the resumed iteration session through the controller replacement context", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const controllerHarness = makePiHarness({
			setActiveTools: () => {
				throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
			},
		});
		const childHarness = makePiHarness();
		const executionProfile = makeExecutionProfile();
		const controllerExecutionRuntimeLayer = Layer.succeed(
			ExecutionRuntime,
			ExecutionRuntime.of({
				setup: Effect.void,
				captureCurrentExecutionProfile: () => Effect.succeed(executionProfile),
				applyExecutionProfile: () => Effect.die(new Error("stale controller pi")),
			}),
		);
		const childExecutionRuntimeLayer = Layer.succeed(
			ExecutionRuntime,
			ExecutionRuntime.of({
				setup: Effect.void,
				captureCurrentExecutionProfile: () => Effect.succeed(executionProfile),
				applyExecutionProfile: (nextProfile, ctx) =>
					Effect.sync(() => {
						ctx.modelRegistry.getAll();
						return { applied: true as const, profile: nextProfile };
					}),
			}),
		);
		const controllerRuntime = makeRalphRuntime(false, controllerExecutionRuntimeLayer);
		const childRuntime = makeRalphRuntime(false, childExecutionRuntimeLayer);
		runtimes.push(controllerRuntime, childRuntime);
		initRalph(controllerHarness.pi, controllerRuntime.run);
		initRalph(childHarness.pi, childRuntime.run);

		const command = controllerHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const controllerSessionFile = path.join(
			cwd,
			".pi",
			"sessions",
			"resume-controller.session.json",
		);
		const childSessionFile = path.join(cwd, ".pi", "sessions", "resume-child.session.json");
		const childContext = makeContext(cwd);
		childContext.setSessionFile(childSessionFile);
		await childHarness.fire("session_start", { type: "session_start" }, childContext.ctx);

		writeLoopState(cwd, "resume-after-switch", {
			controllerSessionFile,
			iteration: 3,
			status: "paused",
			sandboxProfile: FULL_ACCESS_SANDBOX_PROFILE,
		});

		const context = makeContext(
			cwd,
			[
				{
					cancelled: false,
					sessionFile: childSessionFile,
					updateContextSessionFile: false,
				},
			],
			[
				{
					type: "custom",
					customType: TAU_PERSISTED_STATE_TYPE,
					data: {
						sandbox: {
							sessionOverride: { preset: "read-only" },
						},
					},
				},
			],
		);
		context.setSessionFile(path.join(cwd, ".pi", "sessions", "other.session.json"));

		const resumePromise = Promise.resolve(
			command.handler("resume resume-after-switch", context.ctx),
		);
		await waitFor(() => context.switchSessionCalls.includes(controllerSessionFile));
		await waitFor(() => childHarness.sentUserMessages.length === 1);
		expect(context.appendedCustomEntries).toContainEqual({
			customType: TAU_PERSISTED_STATE_TYPE,
			data: {
				sandbox: {
					sessionOverride: {
						preset: "full-access",
						subagent: false,
						approvalTimeoutSeconds: 60,
					},
				},
			},
		});
		expect(controllerHarness.sentUserMessages).toHaveLength(0);

		await childHarness.fire("session_shutdown", { type: "session_shutdown" }, childContext.ctx);
		await expect(resumePromise).resolves.toBeUndefined();

		const finalState = readLoopState(cwd, "resume-after-switch");
		expect(finalState.status).toBe("paused");
		expect(finalState.iteration).toBe(4);
		expect(Option.isNone(finalState.activeIterationSessionFile)).toBe(true);
	});

	it("applies deferred config before creating the next resumed iteration", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const childHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		const childRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime, childRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);
		initRalph(childHarness.pi, childRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const controllerSessionFile = path.join(
			cwd,
			".pi",
			"sessions",
			"deferred-controller.session.json",
		);
		const childSessionFile = path.join(cwd, ".pi", "sessions", "deferred-child.session.json");
		const childContext = makeContext(cwd);
		childContext.setSessionFile(childSessionFile);
		await childHarness.fire("session_start", { type: "session_start" }, childContext.ctx);

		writeLoopState(cwd, "deferred-resume", {
			controllerSessionFile,
			activeIterationSessionFile: path.join(cwd, ".pi", "sessions", "old-child.session.json"),
			iteration: 1,
			status: "paused",
			pendingDecision: {
				kind: "continue",
				requestedAt: "2026-01-01T00:00:00.000Z",
			},
			deferredConfigMutations: [
				{ kind: "capabilityContractTools", activeNames: ["read", "exec_command"] },
			],
		});

		const context = makeContext(cwd, [
			{
				cancelled: false,
				sessionFile: childSessionFile,
				updateContextSessionFile: false,
			},
		]);
		context.setSessionFile(controllerSessionFile);

		const resumePromise = Promise.resolve(command.handler("resume deferred-resume", context.ctx));
		await waitFor(() => childHarness.sentUserMessages.length === 1);
		await childHarness.fire("session_shutdown", { type: "session_shutdown" }, childContext.ctx);
		await expect(resumePromise).resolves.toBeUndefined();

		const finalState = readLoopState(cwd, "deferred-resume");
		expect(finalState.capabilityContract.tools.activeNames).toEqual(["read", "exec_command"]);
		expect(finalState.deferredConfigMutations).toEqual([]);
		expect(finalState.iteration).toBe(2);
	});

	it("pauses /ralph start when subagents are active before creating the next iteration", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(true);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();

		const context = makeContext(cwd, [{ cancelled: false }]);
		await command?.handler("start blocked-on-start", context.ctx);

		const state = readLoopState(cwd, "blocked-on-start");
		expect(state.status).toBe("paused");
		expect(state.iteration).toBe(0);
		expect(Option.isNone(state.pendingDecision)).toBe(true);
		expect(context.newSessionCalls).toHaveLength(0);
		await waitFor(() =>
			context.notifications.some((entry) =>
				entry.message.includes("subagents became active"),
			),
		);
		expect(
			context.notifications.some((entry) =>
				entry.message.includes("subagents became active"),
			),
		).toBe(true);
	});

	it("pauses /ralph resume when a Ralph decision is pending and subagents are still active", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [{ cancelled: false }]);
		const staleIterationSession = path.join(
			cwd,
			".pi",
			"sessions",
			"stale-iteration.session.json",
		);
		writeLoopState(cwd, "blocked-on-resume", {
			controllerSessionFile: context.getSessionFile(),
			activeIterationSessionFile: staleIterationSession,
			iteration: 6,
			status: "paused",
			pendingDecision: {
				kind: "continue",
				requestedAt: "2026-01-01T00:00:00.000Z",
			},
		});

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(true);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();

		await command?.handler("resume blocked-on-resume", context.ctx);

		const state = readLoopState(cwd, "blocked-on-resume");
		expect(state.status).toBe("paused");
		expect(state.iteration).toBe(6);
		expect(Option.isSome(state.pendingDecision)).toBe(true);
		expect(Option.isNone(state.activeIterationSessionFile)).toBe(true);
		expect(context.newSessionCalls).toHaveLength(0);
		expect(context.switchSessionCalls).toHaveLength(0);
		await waitFor(() =>
			context.notifications.some((entry) =>
				entry.message.includes("subagents are still active"),
			),
		);
		expect(
			context.notifications.some((entry) =>
				entry.message.includes("subagents are still active"),
			),
		).toBe(true);
	});

	it("blocks ralph_continue advancement while subagents are active", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const context = makeContext(cwd, [{ cancelled: false }]);
		writeLoopState(cwd, "blocked-loop", {
			controllerSessionFile: context.getSessionFile(),
			activeIterationSessionFile: context.getSessionFile(),
			iteration: 4,
			status: "active",
		});

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(true);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const doneTool = piHarness.tools.get("ralph_continue");
		expect(doneTool).toBeDefined();

		const result = (await doneTool?.execute(
			"call-2",
			{},
			undefined,
			undefined,
			context.ctx,
		)) as ToolExecutionResult;

		expect(result.content[0]?.text).toContain("Subagents are still active");

		const state = readLoopState(cwd, "blocked-loop");
		expect(state.status).toBe("paused");
		expect(Option.isSome(state.pendingDecision)).toBe(true);
		if (Option.isSome(state.pendingDecision)) {
			expect(state.pendingDecision.value.kind).toBe("continue");
		}
		expect(Option.isNone(state.activeIterationSessionFile)).toBe(true);
	});

	it("marks the loop completed when ralph_finish is called before agent_end", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);
		const command = piHarness.commands.get("ralph");
		const finishTool = piHarness.tools.get("ralph_finish");
		expect(command).toBeDefined();
		expect(finishTool).toBeDefined();

		const context = makeContext(cwd, [{ cancelled: false }]);
		const startPromise = command?.handler("start complete-loop", context.ctx);
		await waitFor(() => piHarness.sentUserMessages.length === 1);

		const finishResult = (await finishTool?.execute(
			"call-finish",
			{ message: "All checklist items are done." },
			undefined,
			undefined,
			context.ctx,
		)) as ToolExecutionResult;
		expect(finishResult.content[0]?.text).toContain("Finish recorded");

		await piHarness.fire("agent_end", agentEndPayload("done now"), context.ctx);
		await startPromise;
		await waitFor(() =>
			context.notifications.some(
				(entry) =>
					entry.message.includes("RALPH LOOP COMPLETE") &&
					entry.message.includes("All checklist items are done."),
			),
		);

		const state = readLoopState(cwd, "complete-loop");
		expect(state.status).toBe("completed");
		expect(Option.isSome(state.completedAt)).toBe(true);
		expect(
			context.notifications.some(
				(entry) =>
					entry.message.includes("RALPH LOOP COMPLETE") &&
					entry.message.includes("All checklist items are done."),
			),
		).toBe(true);
	});

	it("nudges once when an iteration ends without a Ralph handshake tool, then pauses on the second miss", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const context = makeContext(cwd, [{ cancelled: false }]);
		let startResolved = false;
		const startPromise = Promise.resolve(
			command.handler("start nudge-loop --max-iterations 1", context.ctx),
		).then(() => {
			startResolved = true;
		});
		await waitFor(() => piHarness.sentUserMessages.length === 1);

		await piHarness.fire("agent_end", agentEndPayload("stopped without tool"), context.ctx);
		await waitFor(() => piHarness.sentUserMessages.length === 2);
		expect(startResolved).toBe(false);
		const nudge = piHarness.sentUserMessages[1];
		expect(typeof nudge?.content === "string" ? nudge.content : "").toContain(
			"ended without a Ralph loop tool",
		);

		await piHarness.fire("agent_end", agentEndPayload("missed again"), context.ctx);
		await startPromise;
		await waitFor(() =>
			context.notifications.some(
				(entry) =>
					entry.message.includes("ended twice without calling") ||
					entry.message.includes("Ralph paused"),
			),
		);

		const state = readLoopState(cwd, "nudge-loop");
		expect(state.status).toBe("paused");
		expect(Option.isNone(state.pendingDecision)).toBe(true);
		expect(
			context.notifications.some(
				(entry) =>
					entry.message.includes("ended twice without calling") ||
					entry.message.includes("Ralph paused"),
			),
		).toBe(true);
	});

	it("waits through an automatically recoverable assistant error instead of nudging or pausing", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const context = makeContext(cwd, [{ cancelled: false }]);
		let startResolved = false;
		const startPromise = Promise.resolve(
			command.handler("start recoverable-error-loop --max-iterations 1", context.ctx),
		).then(() => {
			startResolved = true;
		});
		await waitFor(() => piHarness.sentUserMessages.length === 1);

		await piHarness.fire(
			"agent_end",
			agentEndPayload(
				"provider returned error, retrying",
				"error",
				"Provider returned error: 503 service unavailable",
			),
			context.ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(startResolved).toBe(false);
		expect(piHarness.sentUserMessages).toHaveLength(1);

		const afterError = readLoopState(cwd, "recoverable-error-loop");
		expect(afterError.status).toBe("active");
		expect(Option.isNone(afterError.pendingDecision)).toBe(true);

		const doneTool = piHarness.tools.get("ralph_continue");
		expect(doneTool).toBeDefined();
		await doneTool?.execute("call-after-error", {}, undefined, undefined, context.ctx);
		await piHarness.fire(
			"agent_end",
			agentEndPayload("apply_patch retry succeeded"),
			context.ctx,
		);
		await startPromise;

		const finalState = readLoopState(cwd, "recoverable-error-loop");
		expect(finalState.status).toBe("paused");
		expect(Option.isNone(finalState.pendingDecision)).toBe(true);
		expect(
			context.notifications.some((entry) => entry.message.includes("stop reason error")),
		).toBe(false);
	});

	it("pauses on a non-retryable assistant error", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const context = makeContext(cwd, [{ cancelled: false }]);
		const startPromise = Promise.resolve(
			command.handler("start terminal-error-loop --max-iterations 1", context.ctx),
		);
		await waitFor(() => piHarness.sentUserMessages.length === 1);

		await piHarness.fire(
			"agent_end",
			agentEndPayload(
				"content filter blocked",
				"error",
				"Provider finish_reason: content_filter",
			),
			context.ctx,
		);
		await startPromise;

		const state = readLoopState(cwd, "terminal-error-loop");
		expect(state.status).toBe("paused");
		expect(piHarness.sentUserMessages).toHaveLength(1);
		expect(
			context.notifications.some((entry) => entry.message.includes("stop reason error")),
		).toBe(true);
	});

	it("nudges when stopReason is missing before pausing on a repeated missed Ralph decision", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const context = makeContext(cwd, [{ cancelled: false }]);
		let startResolved = false;
		const startPromise = Promise.resolve(
			command.handler("start missing-stop-reason --max-iterations 1", context.ctx),
		).then(() => {
			startResolved = true;
		});
		await waitFor(() => piHarness.sentUserMessages.length === 1);

		await piHarness.fire(
			"agent_end",
			agentEndPayload("stopped without tool", undefined),
			context.ctx,
		);
		await waitFor(() => piHarness.sentUserMessages.length === 2);
		expect(startResolved).toBe(false);

		await piHarness.fire("agent_end", agentEndPayload("missed again", undefined), context.ctx);
		await startPromise;
		await waitFor(() =>
			context.notifications.some(
				(entry) =>
					entry.message.includes("ended twice without calling") ||
					entry.message.includes("Ralph paused"),
			),
		);

		const state = readLoopState(cwd, "missing-stop-reason");
		expect(state.status).toBe("paused");
		expect(Option.isNone(state.pendingDecision)).toBe(true);
		expect(
			context.notifications.some(
				(entry) =>
					entry.message.includes("ended twice without calling") ||
					entry.message.includes("Ralph paused"),
			),
		).toBe(true);
	});

	it("pauses immediately when agent_end has no usable assistant message", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const piHarness = makePiHarness();
		const ralphRuntime = makeRalphRuntime(false);
		runtimes.push(ralphRuntime);
		initRalph(piHarness.pi, ralphRuntime.run);

		const command = piHarness.commands.get("ralph");
		expect(command).toBeDefined();
		if (!command) {
			throw new Error("missing ralph command");
		}

		const context = makeContext(cwd, [{ cancelled: false }]);
		let startResolved = false;
		const startPromise = Promise.resolve(
			command.handler("start malformed-agent-end --max-iterations 1", context.ctx),
		).then(() => {
			startResolved = true;
		});
		await waitFor(() => piHarness.sentUserMessages.length === 1);

		await piHarness.fire("agent_end", agentEndPayloadWithoutAssistant(), context.ctx);
		await startPromise;
		await waitFor(() =>
			context.notifications.some(
				(entry) =>
					entry.message.includes("without a usable Ralph decision") ||
					entry.message.includes("Ralph paused"),
			),
		);

		const state = readLoopState(cwd, "malformed-agent-end");
		expect(startResolved).toBe(true);
		expect(piHarness.sentUserMessages).toHaveLength(1);
		expect(state.status).toBe("paused");
		expect(Option.isNone(state.pendingDecision)).toBe(true);
		expect(
			context.notifications.some(
				(entry) =>
					entry.message.includes("without a usable Ralph decision") ||
					entry.message.includes("Ralph paused"),
			),
		).toBe(true);
	});
});
