import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Scope, Context } from "effect";

type WaitForAutoresearchAgentEndResult =
	| {
		readonly _tag: "completed";
		readonly event: unknown;
	}
	| {
		readonly _tag: "timed_out";
	}
	| {
		readonly _tag: "cancelled";
	};

export interface AutoresearchLoopRunnerService {
	readonly ensureLoopRunning: (
		loopKey: string,
		program: Effect.Effect<void, never, never>,
	) => Effect.Effect<void, never, never>;
	readonly cancelLoop: (loopKey: string) => Effect.Effect<void, never, never>;
	readonly waitForAgentEnd: (
		sessionFile: string,
	) => Effect.Effect<WaitForAutoresearchAgentEndResult, never, never>;
	readonly resolveAgentEnd: (
		sessionFile: string,
		event: unknown,
	) => Effect.Effect<void, never, never>;
}

export class AutoresearchLoopRunner extends Context.Service<
	AutoresearchLoopRunner,
	AutoresearchLoopRunnerService
>()("AutoresearchLoopRunner") {}

const AUTORESEARCH_AGENT_END_WAIT_TIMEOUT = "30 minutes";
const AUTORESEARCH_AGENT_END_EVENT_TTL_MS = 30 * 60 * 1000;

type QueuedAgentEnd = {
	readonly event: unknown;
	readonly timeout: ReturnType<typeof setTimeout>;
};

type ActiveLoopEntry =
	| {
			readonly _tag: "starting";
	  }
	| {
			readonly _tag: "running";
			readonly fiber: Fiber.Fiber<void, never>;
	  };

export const AutoresearchLoopRunnerLive = Layer.effect(
	AutoresearchLoopRunner,
	Effect.gen(function* () {
		const serviceScope = yield* Effect.scope;
		const backgroundScope = yield* Scope.make();
		yield* Scope.addFinalizer(serviceScope, Scope.close(backgroundScope, Exit.void));

		const activeLoops = new Map<string, ActiveLoopEntry>();
		const waitingAgentEnds = new Map<string, Deferred.Deferred<unknown>>();
		const queuedAgentEnds = new Map<string, QueuedAgentEnd>();
		yield* Scope.addFinalizer(
			serviceScope,
			Effect.sync(() => {
				for (const queued of queuedAgentEnds.values()) {
					clearTimeout(queued.timeout);
				}
				queuedAgentEnds.clear();
			}),
		);

		const ensureLoopRunning: AutoresearchLoopRunnerService["ensureLoopRunning"] = Effect.fn(
			"AutoresearchLoopRunner.ensureLoopRunning",
		)(function* (loopKey, program) {
			if (activeLoops.has(loopKey)) {
				return;
			}
			activeLoops.set(loopKey, { _tag: "starting" });
			let startedFiber: Fiber.Fiber<void, never> | undefined;

			const fiber = yield* program.pipe(
				Effect.ensuring(
					Effect.sync(() => {
						const active = activeLoops.get(loopKey);
						if (active?._tag !== "running" || active.fiber === startedFiber) {
							activeLoops.delete(loopKey);
						}
					}),
				),
				Effect.forkIn(backgroundScope, { startImmediately: true }),
			);
			startedFiber = fiber;

			const active = activeLoops.get(loopKey);
			if (active?._tag === "starting") {
				activeLoops.set(loopKey, { _tag: "running", fiber });
				return;
			}
			yield* Fiber.interrupt(fiber).pipe(
				Effect.tapError((error) => Effect.logWarning("Autoresearch loop fiber interrupt failed", error)),
				Effect.catch(() => Effect.void),
			);
		});

		const cancelLoop: AutoresearchLoopRunnerService["cancelLoop"] = Effect.fn(
			"AutoresearchLoopRunner.cancelLoop",
		)(function* (loopKey) {
			const active = activeLoops.get(loopKey);
			if (active === undefined) {
				return;
			}
			if (active._tag === "starting") {
				activeLoops.delete(loopKey);
				return;
			}

			yield* Fiber.interrupt(active.fiber).pipe(
				Effect.tapError((error) => Effect.logWarning("Autoresearch loop fiber interrupt failed", error)),
				Effect.catch(() => Effect.void),
			);
			activeLoops.delete(loopKey);
		});

		const waitForAgentEnd: AutoresearchLoopRunnerService["waitForAgentEnd"] = Effect.fn(
			"AutoresearchLoopRunner.waitForAgentEnd",
		)(function* (sessionFile) {
			const queued = queuedAgentEnds.get(sessionFile);
			if (queued !== undefined) {
				clearTimeout(queued.timeout);
				queuedAgentEnds.delete(sessionFile);
				return {
					_tag: "completed",
					event: queued.event,
				} satisfies WaitForAutoresearchAgentEndResult;
			}

			const deferred = yield* Deferred.make<unknown>();
			waitingAgentEnds.set(sessionFile, deferred);

			const waitForResult = Deferred.await(deferred).pipe(
				Effect.timeoutOption(AUTORESEARCH_AGENT_END_WAIT_TIMEOUT),
				Effect.map((eventOption): WaitForAutoresearchAgentEndResult =>
					Option.match(eventOption, {
						onNone: () => ({ _tag: "timed_out" }),
						onSome: (event) => ({ _tag: "completed", event }),
					}),
				),
				Effect.catchCause((cause) =>
					Cause.hasInterrupts(cause)
						? Effect.succeed<WaitForAutoresearchAgentEndResult>({ _tag: "cancelled" })
						: Effect.failCause(cause),
				),
				Effect.ensuring(
					Effect.sync(() => {
						const waiting = waitingAgentEnds.get(sessionFile);
						if (waiting === deferred) {
							waitingAgentEnds.delete(sessionFile);
						}
					}),
				),
			);

			return yield* waitForResult;
		});

		const resolveAgentEnd: AutoresearchLoopRunnerService["resolveAgentEnd"] = Effect.fn(
			"AutoresearchLoopRunner.resolveAgentEnd",
		)(function* (sessionFile, event) {
			const deferred = waitingAgentEnds.get(sessionFile);
			if (deferred === undefined) {
				const existing = queuedAgentEnds.get(sessionFile);
				if (existing !== undefined) {
					clearTimeout(existing.timeout);
				}
				const timeout = setTimeout(() => {
					const queued = queuedAgentEnds.get(sessionFile);
					if (queued?.timeout === timeout) {
						queuedAgentEnds.delete(sessionFile);
					}
				}, AUTORESEARCH_AGENT_END_EVENT_TTL_MS);
				queuedAgentEnds.set(sessionFile, { event, timeout });
				return;
			}

			waitingAgentEnds.delete(sessionFile);
			yield* Deferred.succeed(deferred, event).pipe(
				Effect.tapError((error) => Effect.logWarning("Autoresearch agent end deferred succeed failed", error)),
				Effect.catch(() => Effect.void),
			);
		});

		return AutoresearchLoopRunner.of({
			ensureLoopRunning,
			cancelLoop,
			waitForAgentEnd,
			resolveAgentEnd,
		});
	}),
);
