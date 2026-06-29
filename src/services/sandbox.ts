import { Effect, Exit, Layer, Queue, Schema, Scope, Context, Stream, SubscriptionRef } from "effect";

import { PiAPI } from "../effect/pi.js";
import { SandboxConfigRequired } from "../schemas/config.js";
import { SandboxState } from "./state.js";
import { Persistence } from "./persistence.js";
import { Shell } from "./shell.js";
import initSandbox from "../sandbox/index.js";

const decodeSandboxConfigRequired = Schema.decodeUnknownExit(SandboxConfigRequired);

export interface Sandbox {
	readonly getConfig: Effect.Effect<SandboxConfigRequired>;
	readonly changes: Stream.Stream<SandboxConfigRequired>;
	readonly setup: Effect.Effect<void, never, Scope.Scope>;
}

export const Sandbox = Context.Service<Sandbox>("Sandbox");

export const SandboxLive = Layer.effect(
	Sandbox,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const state = yield* SandboxState;
		const persistence = yield* Persistence;
		const shell = yield* Shell;
		const syncQueue = yield* Queue.sliding<SandboxConfigRequired>(1);

		const publishConfig = (next: SandboxConfigRequired): void => {
			Queue.offerUnsafe(syncQueue, next);
		};

		const drainSyncQueue = Queue.take(syncQueue).pipe(
			Effect.flatMap((next) => SubscriptionRef.set(state, next)),
			Effect.forever,
		);

		return Sandbox.of({
			getConfig: SubscriptionRef.get(state),
			changes: SubscriptionRef.changes(state),
			setup: Effect.gen(function* () {
				yield* Effect.forkScoped(drainSyncQueue);

				yield* Effect.sync(() => {
					initSandbox(pi, shell, {
						getSnapshot: persistence.getSnapshot,
						update: persistence.update,
					});

					pi.events.on("tau:sandbox:changed", (config: unknown) => {
						const decoded = decodeSandboxConfigRequired(config);
						if (Exit.isSuccess(decoded)) {
							publishConfig(decoded.value);
						}
					});
				});
			}),
		});
	}),
);
