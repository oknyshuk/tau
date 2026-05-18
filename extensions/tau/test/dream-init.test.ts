import { Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import initDream, { _describeDreamError } from "../src/dream/init.js";
import {
	DreamConfigDecodeError,
	DreamConfigInvalidThreshold,
	DreamLockHeld,
	DreamSubagentSpawnFailed,
} from "../src/dream/errors.js";
import type { DreamTaskState } from "../src/dream/domain.js";

type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<void> | void;

type RegisteredCommand = {
	readonly description?: string;
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

type NotifyCall = {
	readonly message: string;
	readonly level: string;
};

type StatusCall = {
	readonly key: string;
	readonly value: string | undefined;
};

function makePiHarness(): {
	readonly pi: ExtensionAPI;
	readonly commands: Map<string, RegisteredCommand>;
	readonly handlers: Map<string, EventHandler[]>;
	readonly userMessages: string[];
	readonly getActiveTools: () => ReadonlyArray<string>;
} {
	const commands = new Map<string, RegisteredCommand>();
	const handlers = new Map<string, EventHandler[]>();
	const userMessages: string[] = [];
	let activeTools: string[] = [];

	const pi = {
		on: (event: string, handler: EventHandler) => {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerCommand: (name: string, options: RegisteredCommand) => {
			commands.set(name, options);
		},
		registerTool: (tool: { readonly name: string }) => {
			if (!activeTools.includes(tool.name)) {
				activeTools = [...activeTools, tool.name];
			}
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (nextTools: ReadonlyArray<string>) => {
			activeTools = [...nextTools];
		},
		sendUserMessage: (message: string) => {
			userMessages.push(message);
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		commands,
		handlers,
		userMessages,
		getActiveTools: () => [...activeTools],
	};
}

function makeCommandContext(): {
	readonly ctx: ExtensionCommandContext;
	readonly notifyCalls: NotifyCall[];
	readonly statusCalls: StatusCall[];
} {
	const notifyCalls: NotifyCall[] = [];
	const statusCalls: StatusCall[] = [];

	const ctx = {
		cwd: "/workspace",
		hasUI: true,
		model: undefined,
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
		},
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => "session-1",
			getSessionFile: () => "/workspace/.pi/sessions/session-1.json",
		},
		ui: {
			notify: (message: string, level: string) => {
				notifyCalls.push({ message, level });
			},
			setStatus: (key: string, value: string | undefined) => {
				statusCalls.push({ key, value });
			},
			setWidget: () => undefined,
			setFooter: () => () => undefined,
			setEditorComponent: () => undefined,
			getEditorText: () => "",
			theme: {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => undefined,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		waitForIdle: async () => undefined,
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => undefined,
	} as unknown as ExtensionCommandContext;

	return { ctx, notifyCalls, statusCalls };
}

function makeState(overrides: Partial<DreamTaskState> = {}): DreamTaskState {
	return {
		id: "dream-task-1",
		type: "dream",
		mode: "manual",
		status: "running",
		phase: "queued",
		startedAt: 1,
		sessionsDiscovered: 0,
		sessionsReviewed: 0,
		memoryMutations: 0,
		cancellable: true,
		...overrides,
	};
}

describe("initDream", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers the dream command and auto-run hooks", () => {
		const { pi, commands, handlers } = makePiHarness();
		const runEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.runPromise(effect as Effect.Effect<A, E, never>);

		initDream(pi, runEffect, {
			pollMs: 1,
			maxPolls: 1,
			sleep: () => Promise.resolve(),
			runner: {
				spawnManual: () => Effect.die("unused"),
				maybeSpawnAuto: () => Effect.succeed(Option.none()),
				runOnce: () => Effect.die("unused"),
			},
			registry: {
				create: () => Effect.die("unused"),
				attach: () => Effect.die("unused"),
				report: () => Effect.die("unused"),
				complete: () => Effect.die("unused"),
				fail: () => Effect.die("unused"),
				cancel: () => Effect.die("unused"),
				get: () => Effect.die("unused"),
				watch: () => Effect.die("unused") as never,
			},
		});

		expect(commands.has("dream")).toBe(true);
		expect(handlers.get("session_start")).toHaveLength(1);
		expect(handlers.get("before_agent_start")).toHaveLength(1);
		expect(handlers.get("agent_end")).toHaveLength(1);
		expect(handlers.get("session_shutdown")).toHaveLength(1);
	});

	it("keeps dream-scoped tools inactive when no foreground run is active", async () => {
		const { pi, handlers, getActiveTools } = makePiHarness();
		const { ctx } = makeCommandContext();
		const runEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.runPromise(effect as Effect.Effect<A, E, never>);

		initDream(pi, runEffect, {
			pollMs: 1,
			maxPolls: 1,
			sleep: () => Promise.resolve(),
			runner: {
				spawnManual: () => Effect.die("unused"),
				maybeSpawnAuto: () => Effect.succeed(Option.none()),
				runOnce: () => Effect.die("unused"),
			},
			registry: {
				create: () => Effect.die("unused"),
				attach: () => Effect.die("unused"),
				report: () => Effect.die("unused"),
				complete: () => Effect.die("unused"),
				fail: () => Effect.die("unused"),
				cancel: () => Effect.die("unused"),
				get: () => Effect.die("unused"),
				watch: () => Effect.die("unused") as never,
			},
		});

		expect(getActiveTools()).toContain("dream_finish");
		await handlers.get("session_start")?.[0]?.({ type: "session_start" }, ctx);
		expect(getActiveTools()).not.toContain("dream_finish");
	});

	it("starts a manual dream run and tracks progress in the UI", async () => {
		vi.useFakeTimers();
		const { pi, commands } = makePiHarness();
		const { ctx, notifyCalls, statusCalls } = makeCommandContext();
		const spawnedRequests: unknown[] = [];
		let getCount = 0;

		const runEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.runPromise(effect as Effect.Effect<A, E, never>);

		initDream(pi, runEffect, {
			pollMs: 5,
			maxPolls: 3,
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			runner: {
				spawnManual: (request) => {
					spawnedRequests.push(request);
					return Effect.succeed({ taskId: "dream-task-1" });
				},
				maybeSpawnAuto: () => Effect.succeed(Option.none()),
				runOnce: () => Effect.die("unused"),
			},
			registry: {
				create: () => Effect.die("unused"),
				attach: () => Effect.die("unused"),
				report: () => Effect.die("unused"),
				complete: () => Effect.die("unused"),
				fail: () => Effect.die("unused"),
				cancel: () => Effect.die("unused"),
				get: () => {
					getCount += 1;
					return Effect.succeed(
						getCount === 1
							? makeState({ phase: "gather", memoryMutations: 1 })
							: makeState({
									status: "completed",
									phase: "done",
									memoryMutations: 2,
									sessionsReviewed: 3,
									finishedAt: 2,
									cancellable: false,
								}),
					);
				},
				watch: () => Effect.die("unused") as never,
			},
		});

		const command = commands.get("dream");
		expect(command).toBeDefined();

		const running = command?.handler("", ctx);
		await vi.advanceTimersByTimeAsync(20);
		await running;

		expect(spawnedRequests).toEqual([
			{
				cwd: "/workspace",
				mode: "manual",
				currentSessionId: "session-1",
				requestedBy: "user",
			},
		]);
		expect(notifyCalls[0]).toMatchObject({
			level: "info",
			message: expect.stringContaining("Dream started (task dream-task-1)"),
		});
		expect(notifyCalls).toContainEqual({
			level: "info",
			message: "Dream phase: gather",
		});
		expect(statusCalls).toContainEqual({ key: "dream", value: "dream: gather (1 mutations)" });
		expect(notifyCalls.at(-1)).toMatchObject({
			level: "info",
			message: "Dream complete: reviewed 3 session(s), 2 memory mutation(s).",
		});
		expect(statusCalls.at(-1)).toEqual({ key: "dream", value: undefined });
	});

	it("waits for shutdown-triggered auto-dream completion before returning", async () => {
		const { pi, handlers } = makePiHarness();
		const { ctx, notifyCalls } = makeCommandContext();
		let getCount = 0;
		const runEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.runPromise(effect as Effect.Effect<A, E, never>);

		initDream(pi, runEffect, {
			pollMs: 1,
			maxPolls: 3,
			sleep: () => Promise.resolve(),
			runner: {
				spawnManual: () => Effect.die("unused"),
				maybeSpawnAuto: () => Effect.succeed(Option.some({ taskId: "dream-task-1" })),
				runOnce: () => Effect.die("unused"),
			},
			registry: {
				create: () => Effect.die("unused"),
				attach: () => Effect.die("unused"),
				report: () => Effect.die("unused"),
				complete: () => Effect.die("unused"),
				fail: () => Effect.die("unused"),
				cancel: () => Effect.die("unused"),
				get: () => {
					getCount += 1;
					return Effect.succeed(
						makeState({
							mode: "auto",
							status: "completed",
							phase: "done",
							memoryMutations: 1,
							sessionsReviewed: 2,
							finishedAt: 3,
							cancellable: false,
						}),
					);
				},
				watch: () => Effect.die("unused") as never,
			},
		});

		const handler = handlers.get("session_shutdown")?.[0];
		expect(handler).toBeDefined();

		await handler?.({ type: "session_shutdown" }, ctx);

		expect(getCount).toBeGreaterThan(0);
		expect(notifyCalls).toContainEqual({
			level: "info",
			message: "Dream complete: reviewed 2 session(s), 1 memory mutation(s).",
		});
	});

	it("swallows auto gate closures without notifying the user", async () => {
		const { pi, handlers } = makePiHarness();
		const { ctx, notifyCalls } = makeCommandContext();
		const runEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.runPromise(effect as Effect.Effect<A, E, never>);

		initDream(pi, runEffect, {
			pollMs: 1,
			maxPolls: 1,
			sleep: () => Promise.resolve(),
			runner: {
				spawnManual: () => Effect.die("unused"),
				maybeSpawnAuto: () => Effect.fail(new DreamLockHeld({ path: "/workspace/.pi/tau/dream.lock" })),
				runOnce: () => Effect.die("unused"),
			},
			registry: {
				create: () => Effect.die("unused"),
				attach: () => Effect.die("unused"),
				report: () => Effect.die("unused"),
				complete: () => Effect.die("unused"),
				fail: () => Effect.die("unused"),
				cancel: () => Effect.die("unused"),
				get: () => Effect.die("unused"),
				watch: () => Effect.die("unused") as never,
			},
		});

		const handler = handlers.get("session_start")?.[0];
		expect(handler).toBeDefined();

		await handler?.({ type: "session_start" }, ctx);

		expect(notifyCalls).toEqual([]);
	});

	describe("describeError", () => {
		it("shows missing config fields clearly", () => {
			const err = new DreamConfigDecodeError({
				reason: "Missing required dream config fields: tau.dream.enabled, tau.dream.subagent.model",
			});
			expect(_describeDreamError(err)).toBe(
				"Dream configuration error: Missing required dream config fields: tau.dream.enabled, tau.dream.subagent.model",
			);
		});

		it("shows invalid threshold details", () => {
			const err = new DreamConfigInvalidThreshold({
				field: "subagent.maxTurns",
				value: 0,
			});
			expect(_describeDreamError(err)).toBe(
				"Dream configuration error: invalid value for subagent.maxTurns (0)",
			);
		});

		it("surfaces the reason from DreamSubagentSpawnFailed", () => {
			const err = new DreamSubagentSpawnFailed({ reason: "exceeded maxTurns=8" });
			expect(_describeDreamError(err)).toBe("Dream failed: exceeded maxTurns=8");
		});

		it("shows DreamLockHeld as a human message", () => {
			const err = new DreamLockHeld({ path: "/tmp/lock" });
			expect(_describeDreamError(err)).toBe("Another dream run is already in progress.");
		});

		it("handles plain errors", () => {
			expect(_describeDreamError(new TypeError("boom"))).toBe("Dream failed: TypeError: boom");
		});
	});
});
