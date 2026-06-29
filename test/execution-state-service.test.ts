import { describe, expect, it } from "vitest";

import { Effect, Layer, SubscriptionRef } from "effect";

import type { TauPersistedState } from "../src/shared/state.js";
import { mergePersistedState } from "../src/shared/state.js";
import { Persistence } from "../src/services/persistence.js";
import { ExecutionState, ExecutionStateLive } from "../src/services/execution-state.js";

async function makeExecutionState(initial: TauPersistedState) {
	const stateRef = await Effect.runPromise(SubscriptionRef.make<TauPersistedState>(initial));

	const persistenceLayer = Layer.succeed(Persistence, {
		getSnapshot: () => Effect.runSync(SubscriptionRef.get(stateRef)),
		setSnapshot: (next: TauPersistedState) => {
			Effect.runSync(SubscriptionRef.set(stateRef, next));
		},
		hydrate: (patch: Partial<TauPersistedState>) => {
			Effect.runSync(
				SubscriptionRef.update(stateRef, (current) => mergePersistedState(current, patch)),
			);
		},
		update: (patch: Partial<TauPersistedState>) => {
			Effect.runSync(
				SubscriptionRef.update(stateRef, (current) => mergePersistedState(current, patch)),
			);
		},
		getSnapshotEffect: SubscriptionRef.get(stateRef),
		setSnapshotEffect: (next: TauPersistedState) => SubscriptionRef.set(stateRef, next),
		updateEffect: (patch: Partial<TauPersistedState>) =>
			SubscriptionRef.updateAndGet(stateRef, (current) => mergePersistedState(current, patch)),
		changes: SubscriptionRef.changes(stateRef),
		setup: Effect.void,
	});

	const program = Effect.gen(function* () {
		const service = yield* ExecutionState;
		return service;
	});

	const layer = ExecutionStateLive.pipe(Layer.provide(persistenceLayer));
	const service = await Effect.runPromise(program.pipe(Effect.provide(layer)));

	return {
		service,
		getPersisted: () => Effect.runSync(SubscriptionRef.get(stateRef)),
		mutatePersisted: (patch: Partial<TauPersistedState>) => {
			Effect.runSync(
				SubscriptionRef.update(stateRef, (current) => mergePersistedState(current, patch)),
			);
		},
	};
}

describe("execution-state service", () => {
	it("hydrates canonical policy from execution state", async () => {
		const { service } = await makeExecutionState({
			execution: {
				policy: { tools: { kind: "allowlist", tools: ["read"] } },
			},
		});

		await Effect.runPromise(Effect.scoped(service.setup));

		expect(service.getSnapshot().policy).toEqual({
			tools: { kind: "allowlist", tools: ["read"] },
		});
	});

	it("persists canonical execution updates", async () => {
		const { service, getPersisted } = await makeExecutionState({});

		await Effect.runPromise(Effect.scoped(service.setup));
		service.update({
			policy: { tools: { kind: "allowlist", tools: ["exec_command"] } },
		});

		expect(getPersisted().execution?.policy).toEqual({
			tools: { kind: "allowlist", tools: ["exec_command"] },
		});
	});

	it("applies transient execution updates without mutating persisted snapshot", async () => {
		const { service, getPersisted } = await makeExecutionState({
			execution: {
				policy: { tools: { kind: "inherit" } },
			},
		});

		await Effect.runPromise(Effect.scoped(service.setup));
		service.transient({
			policy: {
				tools: {
					kind: "allowlist",
					tools: ["read"],
				},
			},
		});

		expect(service.getSnapshot().policy.tools.kind).toBe("allowlist");
		expect(getPersisted().execution?.policy?.tools.kind ?? "inherit").toBe("inherit");
	});

	it("keeps transient execution override across unrelated persistence updates", async () => {
		const { service, mutatePersisted } = await makeExecutionState({
			execution: {
				policy: { tools: { kind: "inherit" } },
			},
		});

		await Effect.runPromise(Effect.scoped(service.setup));
		service.transient({
			policy: { tools: { kind: "allowlist", tools: ["read"] } },
		});

		mutatePersisted({
			terminalPrompt: {
				enabled: true,
			},
		});

		await Effect.runPromise(Effect.sleep("10 millis"));
		expect(service.getSnapshot().policy.tools.kind).toBe("allowlist");

		service.refreshFromPersistence();
		expect(service.getSnapshot().policy.tools.kind).toBe("inherit");
	});
});
