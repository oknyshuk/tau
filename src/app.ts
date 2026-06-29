import { Cause, Effect, Layer, ManagedRuntime } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";

import { PiAPILive } from "./effect/pi.js";
import { PiLoggerLive } from "./effect/logger.js";
import { Sandbox, SandboxLive } from "./services/sandbox.js";
import { Shell, ShellLive } from "./services/shell.js";
import { SandboxStateLive } from "./services/state.js";
import { Footer, FooterLive } from "./services/footer.js";
import { Persistence, PersistenceLive } from "./services/persistence.js";
import { ExecutionState, ExecutionStateLive } from "./services/execution-state.js";
import { ExecutionRuntime, ExecutionRuntimeLive } from "./services/execution-runtime.js";
import { Ralph, RalphLive } from "./services/ralph.js";
import { Goal, GoalLive } from "./services/goal.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import initExa from "./exa/index.js";
import initTerminalPrompt from "./terminal-prompt/index.js";
import initWorkedFor from "./worked-for/index.js";
import { initStatus } from "./status/index.js";
import initEditor from "./editor/index.js";
import initAgent from "./agent/index.js";
import initRequestUserInput from "./request-user-input/index.js";
import initRalph from "./ralph/index.js";
import initGoal from "./goal/index.js";
import initAgentsMenu from "./agents-menu/index.js";
import { AgentConfig, AgentControl } from "./agent/services.js";
import { AgentControlLive } from "./agent/control.js";
import { AgentManagerLive } from "./agent/manager.js";
import { AgentRuntimeBridgeLive, type AgentRuntimeBridgeService } from "./agent/runtime.js";
import { AgentRegistry } from "./agent/agent-registry.js";
import { validateResolvedAgentConfiguration } from "./agent/startup-validation.js";
import { buildToolDescription } from "./agent/tool.js";
import { isRecord } from "./shared/json.js";
import { RalphRepoLive } from "./ralph/repo.js";
import { LoopRepoLive } from "./loops/repo.js";
import { LoopEngine, LoopEngineLive } from "./services/loop-engine.js";

const PersistenceLayer = PersistenceLive;
const ShellLayer = ShellLive;
const SandboxLayer = SandboxLive.pipe(
	Layer.provide(ShellLayer),
	Layer.provide(SandboxStateLive),
	Layer.provide(PersistenceLayer),
);
const FooterLayer = FooterLive.pipe(
	Layer.provide(NodeFileSystem.layer),
	Layer.provide(PersistenceLayer),
	Layer.provide(SandboxLayer),
);
const ExecutionStateLayer = ExecutionStateLive.pipe(Layer.provide(PersistenceLayer));
const ExecutionRuntimeLayer = ExecutionRuntimeLive.pipe(Layer.provide(ExecutionStateLayer));
const AgentConfigLive = Layer.succeed(
	AgentConfig,
	AgentConfig.of({
		maxThreads: 12,
		maxDepth: 3,
	}),
);

const createMainLayer = (agentRuntimeBridge: AgentRuntimeBridgeService) => {
	const AgentLayer = AgentControlLive.pipe(
		Layer.provide(AgentManagerLive),
		Layer.provide(AgentConfigLive),
		Layer.provide(
			AgentRuntimeBridgeLive(agentRuntimeBridge.runPromise, agentRuntimeBridge.runFork),
		),
		Layer.provide(SandboxLayer),
	);

	const hasActiveSubagents = (): Effect.Effect<boolean, never, never> =>
		Effect.promise(() =>
			agentRuntimeBridge.runPromise(
				Effect.gen(function* () {
					const control = yield* AgentControl;
					return yield* control.list;
				}),
			),
		).pipe(
			Effect.map((agents) =>
				agents.some(
					(agent) => agent.status.state === "pending" || agent.status.state === "running",
				),
			),
			Effect.catch((error) =>
				Effect.gen(function* () {
					yield* Effect.logWarning("hasActiveSubagents failed, assuming true (deferring mutations)", error);
					return true;
				})
			),
		);

	const RalphLayer = RalphLive({
		hasActiveSubagents,
	}).pipe(
		Layer.provideMerge(RalphRepoLive),
		Layer.provideMerge(LoopEngineLive.pipe(Layer.provideMerge(LoopRepoLive))),
		Layer.provide(NodeFileSystem.layer),
	);

	return Layer.mergeAll(
		PersistenceLayer,
		ShellLayer,
		ExecutionStateLayer,
		ExecutionRuntimeLayer,
		SandboxLayer,
		FooterLayer,
		AgentLayer,
		RalphLayer,
		GoalLive,
	).pipe(Layer.provide(PiLoggerLive));
};

type TauRuntime = ManagedRuntime.ManagedRuntime<
	| Persistence
	| ExecutionState
	| ExecutionRuntime
	| Shell
	| Sandbox
	| Footer
	| AgentControl
	| Ralph
	| Goal
	| LoopEngine,
	never
>;

export const runTau = (pi: ExtensionAPI) => {
	return startTau(pi).fiber;
};

export const startTau = (pi: ExtensionAPI) => {
	let runtime: TauRuntime | undefined;
	let readySettled = false;
	let resolveReady!: () => void;
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	const agentRuntimeBridge: AgentRuntimeBridgeService = {
		runPromise: (effect) => {
			if (!runtime) {
				return Promise.reject(new Error("tau runtime not initialized"));
			}
			return runtime.runPromise(effect);
		},
		runFork: (effect) => {
			if (!runtime) {
				throw new Error("tau runtime not initialized");
			}
			return runtime.runFork(effect);
		},
		closeAll: () =>
			agentRuntimeBridge
				.runPromise(
					Effect.gen(function* () {
						const control = yield* AgentControl;
						yield* control.closeAll;
					}),
				)
				.then(() => undefined),
	};

	const layer = createMainLayer(agentRuntimeBridge).pipe(Layer.provide(PiAPILive(pi)));
	const currentRuntime = ManagedRuntime.make(layer);
	runtime = currentRuntime;
	const runRalph = <A, E>(effect: Effect.Effect<A, E, Ralph | ExecutionRuntime>) =>
		currentRuntime.runPromise(effect);
	const goalRuntime = {
		runPromise: <A, E>(effect: Effect.Effect<A, E, Goal>) => currentRuntime.runPromise(effect),
		runFork: <A, E>(effect: Effect.Effect<A, E, Goal>) => currentRuntime.runFork(effect),
	};

	const startup = Effect.gen(function* () {
		const { default: initBacklog } = yield* Effect.promise(() => import("./backlog/tool.js"));
		const persistence = yield* Persistence;
		const executionState = yield* ExecutionState;
		const executionRuntime = yield* ExecutionRuntime;
		const sandbox = yield* Sandbox;
		const footer = yield* Footer;
		const persistedAccess = {
			getSnapshot: persistence.getSnapshot,
			update: persistence.update,
		};

		yield* persistence.setup;
		yield* executionState.setup;
		yield* executionRuntime.setup;
		yield* sandbox.setup;
		yield* footer.setup;
		yield* Effect.sync(() => {
			initBacklog(pi);
			initExa(pi);
			initTerminalPrompt(pi, persistedAccess);
			initWorkedFor(pi, persistedAccess);
			initStatus(pi, persistedAccess);
			initEditor(pi, {
				getSnapshot: persistence.getSnapshot,
			});
			initRequestUserInput(pi);
			initRalph(pi, runRalph);
			// Autoresearch is owned by the external pi-autoresearch extension.
			initGoal(pi, goalRuntime);
		});

		// AWS SSO refresh loads lazily and only when AWS_PROFILE is set, so non-AWS
		// sessions never transpile/evaluate it. Forked as a daemon so it never
		// blocks startup; before_provider_request (the operative refresh trigger)
		// only fires once the user invokes the model, well after this import
		// resolves.
		const awsProfile = process.env["AWS_PROFILE"];
		if (awsProfile !== undefined && awsProfile.length > 0) {
			yield* Effect.tryPromise(() => import("./sso/index.js")).pipe(
				Effect.flatMap(({ default: initSso }) => Effect.sync(() => initSso(pi))),
				Effect.catch((error) =>
					Effect.logWarning("Failed to initialize AWS SSO refresh", error),
				),
				Effect.forkDetach,
			);
		}

		const agentRegistry = yield* AgentRegistry.load(process.cwd());
		yield* validateResolvedAgentConfiguration(agentRegistry);
		const agentToolDescription = buildToolDescription(agentRegistry);
		yield* Effect.sync(() => {
			const agentToolHandle = initAgent(pi, agentRuntimeBridge, agentToolDescription);
			const configureRalphAgents: import("./agents-menu/index.js").RalphAgentConfigRunner =
				async (cwd, loopName, enabledNames) => {
					try {
						const result = await runRalph(
							Effect.gen(function* () {
								const ralph = yield* Ralph;
								return yield* ralph.configureLoopMany(cwd, loopName, [
									{ kind: "capabilityContractAgents", enabledNames },
								]);
							}),
						);
						return { ok: true as const, status: result.status };
					} catch (error) {
						return { ok: false as const, reason: String(error) };
					}
				};
			initAgentsMenu(pi, agentToolHandle, configureRalphAgents);

			// The tau ManagedRuntime is created once per process in the extension
			// factory and lives for the entire process lifetime. It backs every
			// tau session (including sessions created mid-run via /new, /fork,
			// switchSession, and the Ralph iteration boundary).
			//
			// pi emits `session_shutdown` on every session teardown — not just
			// process exit — so disposing the runtime on that event would break
			// any tool call running on the old session that still has pending
			// effects. For example, `/ralph start` runs `ralph.runLoop` which
			// itself calls `ctx.newSession(...)`; pi reacts by tearing down the
			// current session and firing `session_shutdown` while the ralph
			// effect is still awaiting results from the runtime.
			//
			// Per-session cleanup still happens through each module's own
			// `session_shutdown` handler (e.g. ralph loop state persistence).
			// Process-level cleanup only runs on the terminal quit shutdown.
			pi.on("session_shutdown", async (event: unknown) => {
				if (!isRecord(event) || event["reason"] !== "quit") {
					return;
				}
				await agentRuntimeBridge.closeAll();
				await currentRuntime.dispose();
			});
		});
	});

	const program = Effect.scoped(
		Effect.matchCauseEffect(startup, {
			onSuccess: () =>
				Effect.sync(() => {
					if (readySettled) return;
					readySettled = true;
					resolveReady();
				}),
			onFailure: (cause) =>
				Effect.sync(() => {
					if (readySettled) return;
					readySettled = true;
					rejectReady(Cause.squash(cause));
				}).pipe(Effect.andThen(Effect.failCause(cause))),
		}).pipe(Effect.andThen(Effect.never)),
	);

	const rootFiber = currentRuntime.runFork(program);

	return { fiber: rootFiber, ready };
};
