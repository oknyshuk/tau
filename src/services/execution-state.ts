import {
	Effect,
	Layer,
	MutableRef,
	Option,
	Queue,
	Scope,
	Context,
	Stream,
	SubscriptionRef,
} from "effect";
import {
	mergeExecutionSessionState,
	normalizeExecutionState,
	type ExecutionPersistedState,
	type ExecutionSessionState,
} from "../execution/schema.js";
import { Persistence } from "./persistence.js";
import type { TauPersistedState } from "../shared/state.js";

export interface ExecutionState {
	readonly getSnapshot: () => ExecutionSessionState;
	readonly refreshFromPersistence: () => void;
	readonly transient: (patch: Partial<ExecutionPersistedState>) => void;
	readonly hydrate: (patch: Partial<ExecutionPersistedState>) => void;
	readonly update: (patch: Partial<ExecutionPersistedState>) => void;
	readonly changes: Stream.Stream<ExecutionSessionState>;
	readonly setup: Effect.Effect<void, never, Scope.Scope>;
}

export const ExecutionState = Context.Service<ExecutionState>("ExecutionState");

export const ExecutionStateLive = Layer.effect(
	ExecutionState,
	Effect.gen(function* () {
		const persistence = yield* Persistence;
		const initialSnapshot = normalizeExecutionState(persistence.getSnapshot().execution);
		const snapshotRef = yield* SubscriptionRef.make<ExecutionSessionState>(initialSnapshot);
		const runtimeSnapshotRef = MutableRef.make(initialSnapshot);
		const transientSnapshotRef = MutableRef.make<Option.Option<ExecutionSessionState>>(Option.none());
		const syncQueue = yield* Queue.sliding<ExecutionSessionState>(1);

		const publishSnapshot = (next: ExecutionSessionState): ExecutionSessionState => {
			MutableRef.set(runtimeSnapshotRef, next);
			Queue.offerUnsafe(syncQueue, next);
			return next;
		};

		const syncFromPersistence = (state: TauPersistedState): void => {
			const persisted = normalizeExecutionState(state.execution);
			const transient = Option.getOrUndefined(MutableRef.get(transientSnapshotRef));
			publishSnapshot(transient ?? persisted);
		};

		const hydrateSnapshot = (
			patch: Partial<ExecutionPersistedState>,
		): ExecutionSessionState => {
			const next = mergeExecutionSessionState(MutableRef.get(runtimeSnapshotRef), patch);
			MutableRef.set(transientSnapshotRef, Option.none());
			publishSnapshot(next);
			persistence.hydrate({ execution: next });
			return next;
		};

		const transientSnapshot = (
			patch: Partial<ExecutionPersistedState>,
		): ExecutionSessionState => {
			const next = mergeExecutionSessionState(MutableRef.get(runtimeSnapshotRef), patch);
			MutableRef.set(transientSnapshotRef, Option.some(next));
			publishSnapshot(next);
			return next;
		};

		const updateSnapshot = (
			patch: Partial<ExecutionPersistedState>,
		): ExecutionSessionState => {
			const next = mergeExecutionSessionState(MutableRef.get(runtimeSnapshotRef), patch);
			MutableRef.set(transientSnapshotRef, Option.none());
			publishSnapshot(next);
			persistence.update({ execution: next });
			return next;
		};

		const drainSyncQueue = Queue.take(syncQueue).pipe(
			Effect.flatMap((next) => SubscriptionRef.set(snapshotRef, next)),
			Effect.forever,
		);

		const syncFromPersistenceChanges = persistence.changes.pipe(
			Stream.runForEach((persisted) =>
				Effect.sync(() => {
					syncFromPersistence(persisted);
				}),
			),
		);

		return ExecutionState.of({
			getSnapshot: () => MutableRef.get(runtimeSnapshotRef),
			refreshFromPersistence: () => {
				MutableRef.set(transientSnapshotRef, Option.none());
				syncFromPersistence(persistence.getSnapshot());
			},
			transient: (patch) => {
				transientSnapshot(patch);
			},
			hydrate: (patch) => {
				hydrateSnapshot(patch);
			},
			update: (patch) => {
				updateSnapshot(patch);
			},
			changes: SubscriptionRef.changes(snapshotRef),
			setup: Effect.gen(function* () {
				yield* Effect.forkScoped(drainSyncQueue);
				yield* Effect.forkScoped(syncFromPersistenceChanges);

				yield* Effect.sync(() => {
					syncFromPersistence(persistence.getSnapshot());
				});
			}),
		});
	}),
);
