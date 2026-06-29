import { describe, expect, it } from "vitest";

import { Effect, Layer, SubscriptionRef } from "effect";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PiAPILive } from "../src/effect/pi.js";
import { Persistence } from "../src/services/persistence.js";
import { ExecutionState, ExecutionStateLive } from "../src/services/execution-state.js";
import { ExecutionRuntime, ExecutionRuntimeLive } from "../src/services/execution-runtime.js";
import { mergePersistedState, type TauPersistedState } from "../src/shared/state.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

type ModelRef = {
	readonly provider: string;
	readonly id: string;
};

type PiMock = {
	readonly pi: ExtensionAPI;
	readonly handlers: Map<string, EventHandler[]>;
	readonly commands: Map<string, CommandHandler>;
	readonly setModelCalls: Array<ModelRef>;
	readonly thinkingCalls: string[];
};

function makePiMock(): PiMock {
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, CommandHandler>();
	const setModelCalls: Array<ModelRef> = [];
	const thinkingCalls: string[] = [];
	let currentThinking = "medium";

	const pi = {
		on: (event: string, handler: unknown) => {
			const current = handlers.get(event) ?? [];
			current.push(handler as EventHandler);
			handlers.set(event, current);
		},
		registerCommand: (name: string, options: unknown) => {
			if (
				typeof options === "object" &&
				options !== null &&
				typeof (options as { handler?: unknown }).handler === "function"
			) {
				commands.set(name, (options as { handler: CommandHandler }).handler);
			}
		},
		setModel: async (model: unknown) => {
			if (
				typeof model === "object" &&
				model !== null &&
				typeof (model as { provider?: unknown }).provider === "string" &&
				typeof (model as { id?: unknown }).id === "string"
			) {
				setModelCalls.push({
					provider: (model as { provider: string }).provider,
					id: (model as { id: string }).id,
				});
			}
			return true;
		},
		setThinkingLevel: (level: unknown) => {
			if (typeof level === "string") {
				thinkingCalls.push(level);
				currentThinking = level;
			}
		},
		getThinkingLevel: () => currentThinking,
		events: {
			emit: () => undefined,
			on: () => () => undefined,
		},
	} as unknown as ExtensionAPI;

	return { pi, handlers, commands, setModelCalls, thinkingCalls };
}

function makeContext(model?: ModelRef): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		model,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
		},
		ui: {
			notify: () => undefined,
		},
	} as unknown as ExtensionContext;
}

async function withExecutionRuntime<A>(
	mock: PiMock,
	initialState: TauPersistedState,
	effect: (
		runtime: ExecutionRuntime,
		stateRef: SubscriptionRef.SubscriptionRef<TauPersistedState>,
	) => Effect.Effect<A, never, ExecutionState>,
): Promise<A> {
	const stateRef = await Effect.runPromise(SubscriptionRef.make<TauPersistedState>(initialState));
	const persistenceLayer = Layer.succeed(Persistence, {
		getSnapshot: () => Effect.runSync(SubscriptionRef.get(stateRef)),
		setSnapshot: (next: TauPersistedState) => {
			Effect.runSync(SubscriptionRef.set(stateRef, next));
		},
		hydrate: (patch: Partial<TauPersistedState>) => {
			Effect.runSync(SubscriptionRef.update(stateRef, (current) => mergePersistedState(current, patch)));
		},
		update: (patch: Partial<TauPersistedState>) => {
			Effect.runSync(SubscriptionRef.update(stateRef, (current) => mergePersistedState(current, patch)));
		},
		getSnapshotEffect: SubscriptionRef.get(stateRef),
		setSnapshotEffect: (next: TauPersistedState) => SubscriptionRef.set(stateRef, next),
		updateEffect: (patch: Partial<TauPersistedState>) =>
			SubscriptionRef.updateAndGet(stateRef, (current) => mergePersistedState(current, patch)),
		changes: SubscriptionRef.changes(stateRef),
		setup: Effect.sync(() => undefined),
	});

	const executionStateLayer = ExecutionStateLive.pipe(Layer.provide(persistenceLayer));
	const executionRuntimeLayer = ExecutionRuntimeLive.pipe(Layer.provide(executionStateLayer));
	const layer = Layer.mergeAll(
		persistenceLayer,
		executionStateLayer,
		executionRuntimeLayer,
	).pipe(Layer.provide(PiAPILive(mock.pi)));

	return await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const executionState = yield* ExecutionState;
				yield* executionState.setup;
				const runtime = yield* ExecutionRuntime;
				yield* runtime.setup;
				return yield* effect(runtime, stateRef);
			}).pipe(Effect.provide(layer)),
		),
	);
}

describe("execution runtime", () => {
	it("does not register main-session command or prompt injection hooks", async () => {
		const mock = makePiMock();

		await withExecutionRuntime(mock, {}, () => Effect.void);

		expect(mock.commands.size).toBe(0);
		expect(mock.handlers.has("model_select")).toBe(false);
		expect(mock.handlers.has("before_agent_start")).toBe(false);
	});

	it("captures the current model and thinking without mutating execution state", async () => {
		const mock = makePiMock();

		await withExecutionRuntime(
			mock,
			{ execution: { policy: { tools: { kind: "inherit" } } } },
			(runtime, stateRef) =>
				Effect.gen(function* () {
					const profile = yield* runtime.captureCurrentExecutionProfile(
						makeContext({ provider: "anthropic", id: "claude-opus-4-5" }),
					);
					const persisted = yield* SubscriptionRef.get(stateRef);

					expect(profile).toEqual({
						model: "anthropic/claude-opus-4-5",
						thinking: "medium",
						policy: { tools: { kind: "inherit" } },
					});
					expect(persisted.execution).toEqual({ policy: { tools: { kind: "inherit" } } });
				}),
		);
	});

	it("applies concrete execution profiles for loop-owned sessions", async () => {
		const mock = makePiMock();

		await withExecutionRuntime(mock, {}, (runtime) =>
			Effect.gen(function* () {
				const result = yield* runtime.applyExecutionProfile(
					{
						model: "openai-codex/gpt-5.4",
						thinking: "high",
						policy: { tools: { kind: "inherit" } },
					},
					makeContext({ provider: "anthropic", id: "claude-opus-4-5" }),
					{ persist: false, ephemeral: true },
				);

				expect(result.applied).toBe(true);
				expect(mock.setModelCalls).toEqual([{ provider: "openai-codex", id: "gpt-5.4" }]);
				expect(mock.thinkingCalls).toEqual(["high"]);
			}),
		);
	});

	it("does not leak ephemeral loop policy into main execution state", async () => {
		const mock = makePiMock();

		await withExecutionRuntime(
			mock,
			{ execution: { policy: { tools: { kind: "inherit" } } } },
			(runtime) =>
				Effect.gen(function* () {
					const executionState = yield* ExecutionState;
					const result = yield* runtime.applyExecutionProfile(
						{
							model: "openai-codex/gpt-5.4",
							thinking: "high",
							policy: { tools: { kind: "allowlist", tools: ["read"] } },
						},
						makeContext({ provider: "anthropic", id: "claude-opus-4-5" }),
						{ persist: false, ephemeral: true },
					);

					expect(result.applied).toBe(true);
					expect(executionState.getSnapshot().policy).toEqual({ tools: { kind: "inherit" } });
				}),
		);
	});
});
