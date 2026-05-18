import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import initAgent from "../src/agent/index.js";
import { AgentControl, type ControlSpawnOptions } from "../src/agent/services.js";
import { type RunAgentControlFork, type RunAgentControlPromise } from "../src/agent/runtime.js";
import { CuratedMemory } from "../src/services/curated-memory.js";
import {
	ExecutionState,
	type ExecutionState as ExecutionStateService,
} from "../src/services/execution-state.js";

type RegisteredTool = {
	readonly name: string;
	readonly execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: {
			readonly cwd: unknown;
			readonly hasUI: boolean;
			readonly model: Model<Api>;
			readonly modelRegistry: object;
			readonly sessionManager: {
				getCwd: () => unknown;
				getSessionId: () => string;
				getSessionFile: () => string | undefined;
			};
		},
	) => Promise<{
		readonly details: object;
	}>;
};

function makeExecutionStateStub(): ExecutionStateService {
	const snapshot = {
		policy: {
			tools: {
				kind: "inherit",
			},
		},
	} as const;

	return {
		getSnapshot: () => snapshot,
		refreshFromPersistence: () => undefined,
		transient: () => undefined,
		hydrate: () => undefined,
		update: () => undefined,
		changes: Stream.empty,
		setup: Effect.void,
	};
}

function makeCuratedMemoryStub() {
	return {
		getSnapshot: () => Effect.die("unused"),
		getEntriesSnapshot: () => Effect.die("unused"),
		reloadFrozenSnapshot: () => Effect.die("unused"),
		getFrozenPromptBlock: Effect.succeed(""),
		add: () => Effect.die("unused"),
		update: () => Effect.die("unused"),
		remove: () => Effect.die("unused"),
		read: () => Effect.die("unused"),
		setup: Effect.void,
	};
}

function makePiStub(registeredTools: RegisteredTool[]): ExtensionAPI {
	const base = {
		on: () => undefined,
		registerTool: (tool: RegisteredTool) => {
			registeredTools.push(tool);
		},
		getThinkingLevel: () => "medium" as const,
	} as const;

	return new Proxy(base, {
		get(target, prop, receiver) {
			if (Reflect.has(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			return () => undefined;
		},
	}) as unknown as ExtensionAPI;
}

function makeRuntimeWithSpawnCalls(spawnCalls: ControlSpawnOptions[]): {
	readonly runPromise: RunAgentControlPromise;
	readonly runFork: RunAgentControlFork;
	readonly closeAll: () => Promise<undefined>;
} {
	const runPromise: RunAgentControlPromise = <
		A,
		E,
		R extends AgentControl | CuratedMemory | ExecutionState,
	>(
		effect: Effect.Effect<A, E, R>,
	) => {
		const provided = effect.pipe(
			Effect.provide(
				Layer.mergeAll(
					Layer.succeed(
						AgentControl,
						AgentControl.of({
							spawn: (opts) =>
								Effect.sync(() => {
									spawnCalls.push(opts);
									return "agent-1";
								}),
							send: () => Effect.succeed("submission-1"),
							wait: () => Effect.succeed({ status: {}, timedOut: false }),
							waitStream: () => Stream.empty,
							close: () => Effect.succeed([]),
							closeAll: Effect.void,
							list: Effect.succeed([]),
						}),
					),
					Layer.succeed(ExecutionState, makeExecutionStateStub()),
					Layer.succeed(CuratedMemory, makeCuratedMemoryStub()),
				),
			),
		) as Effect.Effect<A, E, never>;
		return Effect.runPromise(provided);
	};

	const runFork: RunAgentControlFork = <
		A,
		E,
		R extends AgentControl | CuratedMemory | ExecutionState,
	>(
		effect: Effect.Effect<A, E, R>,
	) => {
		const provided = effect.pipe(
			Effect.provide(
				Layer.mergeAll(
					Layer.succeed(
						AgentControl,
						AgentControl.of({
							spawn: () => Effect.die("unused"),
							send: () => Effect.die("unused"),
							wait: () => Effect.die("unused"),
							waitStream: () => Stream.empty,
							close: () => Effect.die("unused"),
							closeAll: Effect.void,
							list: Effect.succeed([]),
						}),
					),
					Layer.succeed(ExecutionState, makeExecutionStateStub()),
					Layer.succeed(CuratedMemory, makeCuratedMemoryStub()),
				),
			),
		) as Effect.Effect<A, E, never>;
		return Effect.runFork(provided);
	};

	return {
		runPromise,
		runFork,
		closeAll: async () => undefined,
	};
}

const TEST_MODEL: Model<Api> = {
	id: "gpt-5.4",
	name: "gpt-5.4",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
};

describe("initAgent", () => {
	it("uses the session file for spawn context so Ralph gating sees owned sessions", async () => {
		const registeredTools: RegisteredTool[] = [];
		const spawnCalls: ControlSpawnOptions[] = [];
		const runtime = makeRuntimeWithSpawnCalls(spawnCalls);

		const pi = makePiStub(registeredTools);
		initAgent(pi, runtime, "agent tool");

		expect(registeredTools).toHaveLength(1);
		const tool = registeredTools[0];
		expect(tool).toBeDefined();

		await tool?.execute(
			"tool-call-1",
			{ action: "spawn", agent: "review", message: "review this" },
			undefined,
			undefined,
			{
				cwd: "/workspace",
				hasUI: false,
				model: TEST_MODEL,
				modelRegistry: {},
				sessionManager: {
					getCwd: () => "/workspace",
					getSessionId: () => "session-uuid",
					getSessionFile: () => "/workspace/.pi/sessions/ralph-child.jsonl",
				},
			},
		);

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.parentSessionFile).toBe("/workspace/.pi/sessions/ralph-child.jsonl");
	});

	it("uses the session manager cwd for spawned agent context", async () => {
		const registeredTools: RegisteredTool[] = [];
		const spawnCalls: ControlSpawnOptions[] = [];
		const runtime = makeRuntimeWithSpawnCalls(spawnCalls);

		const pi = makePiStub(registeredTools);
		initAgent(pi, runtime, "agent tool");

		const tool = registeredTools[0];
		expect(tool).toBeDefined();

		await tool?.execute(
			"tool-call-1",
			{ action: "spawn", agent: "librarian", message: "hi" },
			undefined,
			undefined,
			{
				cwd: "/stale-context-cwd",
				hasUI: false,
				model: TEST_MODEL,
				modelRegistry: {},
				sessionManager: {
					getCwd: () => "/session-manager-cwd",
					getSessionId: () => "session-uuid",
					getSessionFile: () => "/session-manager-cwd/.pi/sessions/main.jsonl",
				},
			},
		);

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cwd).toBe("/session-manager-cwd");
	});

	it("uses the process cwd when the harness context has no cwd", async () => {
		const registeredTools: RegisteredTool[] = [];
		const spawnCalls: ControlSpawnOptions[] = [];
		const runtime = makeRuntimeWithSpawnCalls(spawnCalls);

		const pi = makePiStub(registeredTools);
		initAgent(pi, runtime, "agent tool");

		const tool = registeredTools[0];
		expect(tool).toBeDefined();

		await tool?.execute(
			"tool-call-1",
			{ action: "spawn", agent: "librarian", message: "hi" },
			undefined,
			undefined,
			{
				cwd: undefined,
				hasUI: false,
				model: TEST_MODEL,
				modelRegistry: {},
				sessionManager: {
					getCwd: () => undefined,
					getSessionId: () => "session-uuid",
					getSessionFile: () => undefined,
				},
			},
		);

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cwd).toBe(process.cwd());
	});

	it("does not call unsafe path-based session getters in cwd-less harness contexts", async () => {
		const registeredTools: RegisteredTool[] = [];
		const spawnCalls: ControlSpawnOptions[] = [];
		const runtime = makeRuntimeWithSpawnCalls(spawnCalls);

		const pi = makePiStub(registeredTools);
		initAgent(pi, runtime, "agent tool");

		const tool = registeredTools[0];
		expect(tool).toBeDefined();

		await tool?.execute(
			"tool-call-1",
			{ action: "spawn", agent: "librarian", message: "hi" },
			undefined,
			undefined,
			{
				cwd: undefined,
				hasUI: false,
				model: TEST_MODEL,
				modelRegistry: {},
				sessionManager: {
					getCwd: () => {
						throw new TypeError(
							'The "path" argument must be of type string. Received undefined',
						);
					},
					getSessionId: () => "session-uuid",
					getSessionFile: () => {
						throw new TypeError(
							'The "path" argument must be of type string. Received undefined',
						);
					},
				},
			},
		);

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cwd).toBe(process.cwd());
		expect(spawnCalls[0]?.parentSessionFile).toBeUndefined();
	});

	it("guards throwing harness context property accessors", async () => {
		const registeredTools: RegisteredTool[] = [];
		const spawnCalls: ControlSpawnOptions[] = [];
		const runtime = makeRuntimeWithSpawnCalls(spawnCalls);

		const pi = makePiStub(registeredTools);
		initAgent(pi, runtime, "agent tool");

		const tool = registeredTools[0];
		expect(tool).toBeDefined();

		const context: Parameters<RegisteredTool["execute"]>[4] = {
			get cwd(): unknown {
				throw new TypeError(
					'The "path" argument must be of type string. Received undefined',
				);
			},
			hasUI: false,
			model: TEST_MODEL,
			modelRegistry: {},
			get sessionManager(): Parameters<RegisteredTool["execute"]>[4]["sessionManager"] {
				throw new TypeError(
					'The "path" argument must be of type string. Received undefined',
				);
			},
		};

		await tool?.execute(
			"tool-call-1",
			{ action: "spawn", agent: "librarian", message: "hi" },
			undefined,
			undefined,
			context,
		);

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cwd).toBe(process.cwd());
		expect(spawnCalls[0]?.parentSessionFile).toBeUndefined();
	});
});
