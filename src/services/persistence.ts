import { Effect, Layer, Queue, Scope, Context, Stream, SubscriptionRef } from "effect";

import { PiAPI } from "../effect/pi.js";
import {
	TAU_PERSISTED_STATE_TYPE,
	loadPersistedState,
	mergePersistedState,
	type TauPersistedState,
} from "../shared/state.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function sanitizePersistedStateForSession(
	state: TauPersistedState,
	options?: { readonly persistExecution?: boolean },
): TauPersistedState {
	const { execution, ...rest } = state;
	if (options?.persistExecution === false) {
		return rest;
	}

	return {
		...rest,
		...(execution === undefined ? {} : { execution }),
	};
}

export class Persistence extends Context.Service<
	Persistence,
	{
		readonly getSnapshot: () => TauPersistedState;
		readonly setSnapshot: (next: TauPersistedState) => void;
		readonly hydrate: (patch: Partial<TauPersistedState>) => void;
		readonly update: (patch: Partial<TauPersistedState>) => void;
		readonly getSnapshotEffect: Effect.Effect<TauPersistedState>;
		readonly setSnapshotEffect: (next: TauPersistedState) => Effect.Effect<void>;
		readonly updateEffect: (patch: Partial<TauPersistedState>) => Effect.Effect<TauPersistedState>;
		readonly changes: Stream.Stream<TauPersistedState>;
		readonly setup: Effect.Effect<void, never, Scope.Scope>;
	}
>()("Persistence") {}

export const PersistenceLive = Layer.effect(
	Persistence,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const ref = yield* SubscriptionRef.make<TauPersistedState>({});
		const syncQueue = yield* Queue.sliding<TauPersistedState>(1);
		let snapshot: TauPersistedState = {};
		let persistExecutionForCurrentSession = true;

		const publishSnapshot = (next: TauPersistedState): TauPersistedState => {
			snapshot = next;
			Queue.offerUnsafe(syncQueue, next);
			return next;
		};

		const setSnapshot = (next: TauPersistedState): void => {
			publishSnapshot(next);
		};

		const hydrateSnapshot = (patch: Partial<TauPersistedState>): TauPersistedState => {
			return publishSnapshot(mergePersistedState(snapshot, patch));
		};

		const updateSnapshot = (patch: Partial<TauPersistedState>): TauPersistedState => {
			const next = hydrateSnapshot(patch);
			pi.appendEntry(
				TAU_PERSISTED_STATE_TYPE,
				sanitizePersistedStateForSession(next, {
					persistExecution: persistExecutionForCurrentSession,
				}),
			);
			return next;
		};

		const drainSyncQueue = Queue.take(syncQueue).pipe(
			Effect.flatMap((next) => SubscriptionRef.set(ref, next)),
			Effect.forever,
		);

		return Persistence.of({
			getSnapshot: () => snapshot,
			setSnapshot,
			hydrate: (patch) => {
				hydrateSnapshot(patch);
			},
			update: (patch) => {
				updateSnapshot(patch);
			},
			getSnapshotEffect: Effect.sync(() => snapshot),
			setSnapshotEffect: (next) =>
				Effect.sync(() => {
					setSnapshot(next);
				}),
			updateEffect: (patch) => Effect.sync(() => updateSnapshot(patch)),
			changes: SubscriptionRef.changes(ref),
			setup: Effect.gen(function* () {
				yield* Effect.forkScoped(drainSyncQueue);

				const mergePersistedFromContext = (_event: unknown, ctx: ExtensionContext) => {
					persistExecutionForCurrentSession = ctx.hasUI === true;
					hydrateSnapshot(loadPersistedState(ctx));
				};

				yield* Effect.sync(() => {
					pi.on("session_start", mergePersistedFromContext);
				});
			}),
		});
	}),
);
