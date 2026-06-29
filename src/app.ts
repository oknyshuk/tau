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
import initEditor from "./editor/index.js";
import initAgent from "./agent/index.js";
import initRequestUserInput from "./request-user-input/index.js";
import initRalph from "./ralph/index.js";
import initGoal from "./goal/index.js";
import { AgentConfig, AgentControl } from "./agent/services.js";
import { AgentControlLive } from "./agent/control.js";
import { AgentManagerLive } from "./agent/manager.js";
import { AgentRuntimeBridgeLive, type AgentRuntimeBridgeService } from "./agent/runtime.js";
import { AgentRegistry } from "./agent/agent-registry.js";
import { validateResolvedAgentConfiguration } from "./agent/startup-validation.js";
import { buildToolDescription } from "./agent/tool.js";
import { isRecord } from "./shared/json.js";
import {
	disposeAllTauRuntimes,
	registerTauRuntime,
	sweepTauRuntimes,
	trackRunPromise,
	type RuntimeEntry,
} from "./effect/runtime-registry.js";
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
	let runtimeEntry: RuntimeEntry | undefined;
	let readySettled = false;
	let resolveReady!: () => void;
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});

	const agentRuntimeBridge: AgentRuntimeBridgeService = {
		runPromise: (effect) => {
			const rt = runtime;
			const entry = runtimeEntry;
			if (!rt || !entry) {
				return Promise.reject(new Error("tau runtime not initialized"));
			}
			return trackRunPromise(entry, () => rt.runPromise(effect));
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
	const entry = registerTauRuntime(currentRuntime);
	runtimeEntry = entry;
	const runRalph = <A, E>(effect: Effect.Effect<A, E, Ralph | ExecutionRuntime>) =>
		trackRunPromise(entry, () => currentRuntime.runPromise(effect));
	const goalRuntime = {
		runPromise: <A, E>(effect: Effect.Effect<A, E, Goal>) =>
			trackRunPromise(entry, () => currentRuntime.runPromise(effect)),
		runFork: <A, E>(effect: Effect.Effect<A, E, Goal>) => currentRuntime.runFork(effect),
	};

	const startup = Effect.gen(function* () {
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

		// backlog is dynamically imported to keep it off app.ts's static graph, but
		// awaited and registered before `ready` (its `backlog` tool/command are core
		// planning surfaces expected to exist from session start).
		const { default: initBacklog } = yield* Effect.promise(() => import("./backlog/tool.js"));

		// Eager features: those whose session_start{reason:"startup"} behavior is
		// load-bearing (goal restore, ralph loop resume), those that shape the first
		// rendered frame (editor + its terminal-prompt render wrap), and those that
		// register model-callable tools (backlog, exa, request_user_input) which a
		// non-interactive `pi -p`/RPC turn could need immediately. pi awaits this
		// factory before firing session_start, so all of these register before `ready`.
		yield* Effect.sync(() => {
			initBacklog(pi);
			initExa(pi);
			initTerminalPrompt(pi, persistedAccess);
			initRequestUserInput(pi);
			initEditor(pi, {
				getSnapshot: persistence.getSnapshot,
			});
			initRalph(pi, runRalph);
			// Autoresearch is owned by the external pi-autoresearch extension.
			initGoal(pi, goalRuntime);
		});

		const agentRegistry = yield* AgentRegistry.load(process.cwd());
		yield* validateResolvedAgentConfiguration(agentRegistry);
		const agentToolDescription = buildToolDescription(agentRegistry);
		const agentToolHandle = yield* Effect.sync(() => {
			const handle = initAgent(pi, agentRuntimeBridge, agentToolDescription);

			// The tau ManagedRuntime is created per session instance: pi re-runs
			// this factory on every session replacement (/new, /resume, /fork,
			// switchSession, /reload), building a fresh runtime bound to the new
			// session's `pi`. Runtimes are tracked in a process-global registry
			// (see ./effect/runtime-registry).
			//
			// pi emits `session_shutdown` on every teardown, not just process exit.
			// We must NOT dispose a runtime that still has in-flight `runPromise`
			// work: `/ralph start` runs `ralph.runLoop` as a single runPromise that
			// itself calls `ctx.newSession(...)`, so pi fires `session_shutdown`
			// (reason "new") while the Ralph effect is still pending on this runtime
			// and drives later sessions through it. The registry tracks in-flight
			// runPromise work and only reaps idle, non-current runtimes.
			//
			// - quit: close subagents and dispose every runtime (process exit).
			// - replacement: sweep — dispose idle, non-current runtimes orphaned by
			//   the factory re-run; a runtime with a running Ralph loop is left for a
			//   later sweep once it goes idle.
			//
			// Per-session cleanup still happens through each module's own
			// `session_shutdown` handler (e.g. ralph loop state persistence).
			pi.on("session_shutdown", async (event: unknown) => {
				if (isRecord(event) && event["reason"] === "quit") {
					await agentRuntimeBridge.closeAll();
					disposeAllTauRuntimes();
					return;
				}
				sweepTauRuntimes();
			});

			return handle;
		});

		const configureRalphAgents: import("./agents-menu/index.js").RalphAgentConfigRunner = async (
			cwd,
			loopName,
			enabledNames,
		) => {
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

		// Deferred features: these register no model-callable tools and carry no
		// load-bearing session_start{reason:"startup"} work. Their commands, message
		// renderers, and turn/context handlers are picked up live after registration
		// (the runner reads its command/handler maps per invocation/emit), and a
		// detached fiber resolves these imports within milliseconds — before the
		// first user turn in interactive use. Loading them off the critical path
		// keeps their (HTTP-client + schema) module evaluation out of `ready`.
		const loadDeferredFeatures = Effect.gen(function* () {
			const [workedFor, status, agentsMenu] = yield* Effect.all(
				[
					Effect.promise(() => import("./worked-for/index.js")),
					Effect.promise(() => import("./status/index.js")),
					Effect.promise(() => import("./agents-menu/index.js")),
				],
				{ concurrency: "unbounded" },
			);
			yield* Effect.sync(() => {
				workedFor.default(pi, persistedAccess);
				status.initStatus(pi, persistedAccess);
				agentsMenu.default(pi, agentToolHandle, configureRalphAgents);
			});
		});
		yield* loadDeferredFeatures.pipe(
			Effect.tapCause((cause) =>
				Effect.logWarning("Failed to load deferred tau features", cause),
			),
			Effect.forkDetach,
		);

		// AWS SSO refresh is gated on AWS_PROFILE, so non-AWS sessions never import
		// it. When enabled it is awaited (its deps are only node builtins, so it is
		// ~free pre-`ready`) which registers its before_provider_request handler
		// ahead of the first turn (incl. non-interactive `pi -p`/RPC). The refresh
		// itself is non-blocking unless the token is already expired — see ./sso.
		const awsProfile = process.env["AWS_PROFILE"];
		if (awsProfile !== undefined && awsProfile.length > 0) {
			yield* Effect.tryPromise(() => import("./sso/index.js")).pipe(
				Effect.flatMap(({ default: initSso }) => Effect.sync(() => initSso(pi))),
				Effect.catch((error) =>
					Effect.logWarning("Failed to initialize AWS SSO refresh", error),
				),
			);
		}
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

	return { fiber: rootFiber, ready, bridge: agentRuntimeBridge };
};
