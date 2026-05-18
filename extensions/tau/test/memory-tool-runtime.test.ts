import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRegistry,
	ToolDefinition,
	ToolResultEvent,
	BeforeAgentStartEvent,
	ContextEvent,
} from "@earendil-works/pi-coding-agent";

import { PiAPILive } from "../src/effect/pi.js";
import { runTau } from "../src/app.js";
import { parseMemoryEntries } from "../src/memory/format.js";
import initMemory from "../src/memory/index.js";
import type { MemoriesMessageDetails } from "../src/memory/renderer.js";
import initNudge from "../src/nudge/index.js";
import initWorkedFor from "../src/worked-for/index.js";
import { CuratedMemory, CuratedMemoryLive } from "../src/services/curated-memory.js";

function globalMemoryPath(homeDir: string): string {
	return path.join(homeDir, ".pi", "agent", "tau", "memories", "MEMORY.jsonl");
}

function projectMemoryPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".pi", "tau", "memories", "PROJECT.jsonl");
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

interface MemoryToolExecutionResult {
	readonly content: { readonly type: "text"; readonly text: string }[];
	readonly details: {
		readonly entry?: {
			readonly id: string;
			readonly content: string;
		};
	};
}

interface RegisteredCommand {
	readonly description?: string;
	readonly handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

interface SentMessage {
	readonly customType?: string;
	readonly details?: unknown;
	readonly content?: string;
	readonly display?: boolean;
}

function hook(label: string): string {
	return `${label} hook`;
}

async function waitFor<T>(load: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const value = await load();
		if (ready(value)) {
			return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	return load();
}

function makePiStub(): {
	readonly pi: ExtensionAPI;
	readonly tools: ToolDefinition[];
	readonly commands: Map<string, RegisteredCommand>;
	readonly sentMessages: SentMessage[];
	readonly fire: (
		event: string,
		payload: unknown,
		ctx?: ExtensionContext,
	) => Promise<readonly unknown[]>;
} {
	const eventHandlers = new Map<string, EventHandler[]>();
	const tools: ToolDefinition[] = [];
	const commands = new Map<string, RegisteredCommand>();
	const sentMessages: SentMessage[] = [];

	const base = {
		on: (event: string, handler: EventHandler) => {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		getActiveTools: () => ["memory"],
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		registerCommand: (name: string, command: RegisteredCommand) => {
			commands.set(name, command);
		},
		registerShortcut: () => undefined,
		registerMessageRenderer: () => undefined,
		registerFlag: () => undefined,
		sendMessage: (message: SentMessage) => {
			sentMessages.push(message);
		},
		appendEntry: () => undefined,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		getFlag: () => undefined,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		events: {
			emit: () => undefined,
			on: () => () => undefined,
		},
	};

	const pi = new Proxy(base, {
		get(target, prop, receiver) {
			if (Reflect.has(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			return () => undefined;
		},
	}) as unknown as ExtensionAPI;

	return {
		pi,
		tools,
		commands,
		sentMessages,
		fire: async (event, payload, ctx) => {
			const handlers = eventHandlers.get(event) ?? [];
			const context =
				ctx ??
				({
					cwd: process.cwd(),
					hasUI: false,
					ui: {
						setWidget: () => undefined,
						notify: () => undefined,
					},
				} as unknown as ExtensionContext);
			return Promise.all(handlers.map((handler) => handler(payload, context)));
		},
	};
}

function makeContext(cwd: string): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => "test-session",
		},
		modelRegistry: {
			find: () => ({ provider: "anthropic", id: "claude-sonnet-4-5" }),
		} as unknown as ModelRegistry,
		ui: {
			setWidget: () => undefined,
			setFooter: () => () => undefined,
			setEditorComponent: () => undefined,
			notify: () => undefined,
			setStatus: () => undefined,
		},
	} as unknown as ExtensionContext;
}

function makeRunTauStub(): {
	readonly pi: ExtensionAPI;
	readonly tools: ToolDefinition[];
	readonly fire: (
		event: string,
		payload: unknown,
		ctx?: ExtensionContext,
	) => Promise<readonly unknown[]>;
} {
	const eventHandlers = new Map<string, EventHandler[]>();
	const tools: ToolDefinition[] = [];

	const base = {
		on: (event: string, handler: EventHandler) => {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
		getActiveTools: () => tools.map((tool) => tool.name),
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		registerCommand: () => undefined,
		registerShortcut: () => undefined,
		registerMessageRenderer: () => undefined,
		registerFlag: () => undefined,
		sendMessage: () => undefined,
		appendEntry: () => undefined,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		setModel: async () => true,
		getFlag: () => undefined,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		events: {
			emit: () => undefined,
			on: () => () => undefined,
		},
	};

	const pi = new Proxy(base, {
		get(target, prop, receiver) {
			if (Reflect.has(target, prop)) {
				return Reflect.get(target, prop, receiver);
			}
			return () => undefined;
		},
	}) as unknown as ExtensionAPI;

	return {
		pi,
		tools,
		fire: async (event, payload, ctx) => {
			const handlers = eventHandlers.get(event) ?? [];
			const context = ctx ?? makeContext(process.cwd());
			return Promise.all(handlers.map((handler) => handler(payload, context)));
		},
	};
}

describe("memory tool runtime", () => {
	let tempHome: string;
	let originalHome: string | undefined;
	let originalTauMemoryDir: string | undefined;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "tau-memory-tool-runtime-"));
		await fs.mkdir(path.join(tempHome, ".git"), { recursive: true });
		await fs.mkdir(path.join(tempHome, ".pi", "agent"), { recursive: true });
		await fs.writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						smart: { models: [{ model: "inherit", thinking: "inherit" }] },
						deep: { models: [{ model: "inherit", thinking: "inherit" }] },
						rush: { models: [{ model: "inherit", thinking: "inherit" }] },
					},
				},
				null,
				2,
			),
			"utf8",
		);
		originalHome = process.env["HOME"];
		process.env["HOME"] = tempHome;
		originalTauMemoryDir = process.env["TAU_MEMORY_DIR"];
		process.env["TAU_MEMORY_DIR"] = path.join(tempHome, ".pi", "agent", "tau", "memories");
	});

	afterEach(async () => {
		if (originalHome === undefined) {
			delete process.env["HOME"];
		} else {
			process.env["HOME"] = originalHome;
		}
		if (originalTauMemoryDir === undefined) {
			delete process.env["TAU_MEMORY_DIR"];
		} else {
			process.env["TAU_MEMORY_DIR"] = originalTauMemoryDir;
		}
		await fs.rm(tempHome, { recursive: true, force: true });
	});

	it("returns promptly even after tool_result handlers run during an active agent", async () => {
		const { pi, tools, fire } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));
		const runEffect = <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) =>
			runtime.runPromise(effect);
		const cwd = path.join(tempHome, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "settings.json"), "{}", "utf8");

		try {
			const memory = await runEffect(
				Effect.gen(function* () {
					return yield* CuratedMemory;
				}),
			);
			await runtime.runPromise(Effect.scoped(memory.setup));

			initMemory(pi, runEffect);
			initNudge(pi);
			initWorkedFor(pi, {
				getSnapshot: () => ({}),
				update: () => undefined,
			});

			const memoryTool = tools.find((tool) => tool.name === "memory");
			expect(memoryTool).toBeDefined();

			const ctx = makeContext(cwd);
			await fire(
				"before_agent_start",
				{
					type: "before_agent_start",
					prompt: "save memory",
					systemPrompt: "base",
				systemPromptOptions: { cwd: "/tmp" },
				} satisfies BeforeAgentStartEvent,
				ctx,
			);

			const result = (await Promise.race([
				memoryTool!.execute(
					"call-1",
					{
						action: "add",
						target: "global",
						summary: hook("tau-memory-runtime-hang-repro"),
						content: "tau-memory-runtime-hang-repro",
					},
					undefined,
					undefined,
					ctx,
				),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("memory execute timed out")), 1000),
				),
			])) as MemoryToolExecutionResult;

			const firstContent = result.content[0];
			expect(firstContent?.type).toBe("text");
			if (firstContent?.type !== "text") {
				throw new Error("memory tool did not return text content");
			}
			expect(firstContent.text).toContain("Added entry to global memory.");
			expect(firstContent.text).toContain("id:");
			expect(firstContent.text).not.toContain("<memory_snapshot>");
			expect(result.details.entry).toBeDefined();
			expect(result.details.entry?.content).toBe("tau-memory-runtime-hang-repro");
			expect(
				parseMemoryEntries(await fs.readFile(globalMemoryPath(tempHome), "utf8")).map(
					(entry) => entry.content,
				),
			).toEqual(["tau-memory-runtime-hang-repro"]);

			await expect(
				Promise.race([
					fire(
						"tool_result",
						{
							type: "tool_result",
							toolName: "memory",
							toolCallId: "call-1",
							input: {
								action: "add",
								target: "global",
								summary: hook("tau-memory-runtime-hang-repro"),
								content: "tau-memory-runtime-hang-repro",
							},
							content: result.content,
							details: result.details,
							isError: false,
						} satisfies ToolResultEvent,
						ctx,
					),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("tool_result handlers timed out")), 1000),
					),
				]),
			).resolves.toBeDefined();
		} finally {
			await runtime.dispose();
		}
	});

	it("updates and removes memory entries by id through the tool interface", async () => {
		const { pi, tools } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));
		const runEffect = <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) =>
			runtime.runPromise(effect);
		const cwd = path.join(tempHome, "workspace-id-api");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "settings.json"), "{}", "utf8");

		try {
			const memory = await runEffect(
				Effect.gen(function* () {
					return yield* CuratedMemory;
				}),
			);
			await runtime.runPromise(Effect.scoped(memory.setup));

			initMemory(pi, runEffect);

			const memoryTool = tools.find((tool) => tool.name === "memory");
			expect(memoryTool).toBeDefined();

			const ctx = makeContext(cwd);
			const added = (await memoryTool!.execute(
				"call-id-add",
				{
					action: "add",
					target: "global",
					summary: hook("id-addressed-entry"),
					content: "id-addressed-entry",
				},
				undefined,
				undefined,
				ctx,
			)) as MemoryToolExecutionResult;

			const entryId = added.details.entry?.id;
			if (!entryId) {
				throw new Error("memory tool did not return an entry id");
			}

			const updated = (await memoryTool!.execute(
				"call-id-update",
				{
					action: "update",
					target: "global",
					id: entryId,
					summary: hook("updated entry"),
					content: "updated entry",
				},
				undefined,
				undefined,
				ctx,
			)) as MemoryToolExecutionResult;

			expect(updated.details.entry?.id).toBe(entryId);
			expect(updated.details.entry?.content).toBe("updated entry");

			const removed = (await memoryTool!.execute(
				"call-id-remove",
				{
					action: "remove",
					target: "global",
					id: entryId,
				},
				undefined,
				undefined,
				ctx,
			)) as MemoryToolExecutionResult;

			expect(removed.details.entry?.id).toBe(entryId);
			expect(removed.content[0]).toEqual({
				type: "text",
				text: expect.stringContaining("Removed entry from global memory."),
			});
			expect(
				parseMemoryEntries(await fs.readFile(globalMemoryPath(tempHome), "utf8")),
			).toEqual([]);
		} finally {
			await runtime.dispose();
		}
	});

	it("requires summary hooks and rejects summary/content duplication through the tool interface", async () => {
		const { pi, tools } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));
		const runEffect = <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) =>
			runtime.runPromise(effect);
		const cwd = path.join(tempHome, "workspace-tool-contract");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "settings.json"), "{}", "utf8");

		try {
			const memory = await runEffect(
				Effect.gen(function* () {
					return yield* CuratedMemory;
				}),
			);
			await runtime.runPromise(Effect.scoped(memory.setup));

			initMemory(pi, runEffect);

			const memoryTool = tools.find((tool) => tool.name === "memory");
			expect(memoryTool).toBeDefined();

			const missingSummary = (await memoryTool!.execute(
				"call-missing-summary",
				{ action: "add", target: "global", content: "alpha" },
				undefined,
				undefined,
				makeContext(cwd),
			)) as MemoryToolExecutionResult;

			expect(missingSummary.content[0]).toEqual({
				type: "text",
				text: "summary is required for 'add' action.",
			});

			const duplicated = (await memoryTool!.execute(
				"call-duplicated-summary",
				{
					action: "add",
					target: "global",
					summary: "alpha beta",
					content: "alpha\nbeta",
				},
				undefined,
				undefined,
				makeContext(cwd),
			)) as MemoryToolExecutionResult;

			expect(duplicated.content[0]).toEqual({
				type: "text",
				text: "Summary must be a short hook distinct from the full content body.",
			});
		} finally {
			await runtime.dispose();
		}
	});

	it("keeps newly saved memory out of the active-session system prompt until session_start", async () => {
		const { pi, tools, fire } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));
		const runEffect = <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) =>
			runtime.runPromise(effect);
		const cwd = path.join(tempHome, "workspace-fresh-memory");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "settings.json"), "{}", "utf8");

		try {
			const memory = await runEffect(
				Effect.gen(function* () {
					return yield* CuratedMemory;
				}),
			);
			await runtime.runPromise(Effect.scoped(memory.setup));

			initMemory(pi, runEffect);

			const memoryTool = tools.find((tool) => tool.name === "memory");
			expect(memoryTool).toBeDefined();

			const ctx = makeContext(cwd);
			const firstStart = await fire(
				"before_agent_start",
				{
					type: "before_agent_start",
					prompt: "save memory",
					systemPrompt: "base",
				systemPromptOptions: { cwd: "/tmp" },
				} satisfies BeforeAgentStartEvent,
				ctx,
			);
			expect(firstStart[0]).toEqual({ systemPrompt: "base" });

			const summary = "next agent memory hook";
			await memoryTool!.execute(
				"call-3",
				{
					action: "add",
					target: "project",
					summary,
					content: "tau-project-memory-next-agent-start",
				},
				undefined,
				undefined,
				ctx,
			);
			expect(
				parseMemoryEntries(await fs.readFile(projectMemoryPath(cwd), "utf8")).map(
					(entry) => entry.content,
				),
			).toEqual(["tau-project-memory-next-agent-start"]);

			const nextStart = await fire(
				"before_agent_start",
				{
					type: "before_agent_start",
					prompt: "save memory",
					systemPrompt: "base",
				systemPromptOptions: { cwd: "/tmp" },
				} satisfies BeforeAgentStartEvent,
				ctx,
			);

			expect(nextStart[0]).toEqual({ systemPrompt: "base" });

			await fire("session_start", { type: "session_start" }, ctx);
			await new Promise((resolve) => setTimeout(resolve, 50));

			const reloadedStart = await waitFor(
				() =>
					fire(
						"before_agent_start",
						{
							type: "before_agent_start",
							prompt: "save memory",
							systemPrompt: "base",
				systemPromptOptions: { cwd: "/tmp" },
						} satisfies BeforeAgentStartEvent,
						ctx,
					),
				(result) => {
					const first = result[0];
					return (
						typeof first === "object" &&
						first !== null &&
						"systemPrompt" in first &&
						typeof first.systemPrompt === "string" &&
						first.systemPrompt !== "base"
					);
				},
			);

			expect(reloadedStart[0]).not.toEqual({ systemPrompt: "base" });
			expect(reloadedStart[0]).toEqual({
				systemPrompt: expect.not.stringContaining("tau-project-memory-next-agent-start"),
			});
		} finally {
			await runtime.dispose();
		}
	});

	it("does not stall when full tau context recomputation runs after memory succeeds", async () => {
		const { pi, tools, fire } = makeRunTauStub();
		const fiber = runTau(pi);
		const cwd = path.join(tempHome, "workspace-full-runtime");
		await fs.mkdir(cwd, { recursive: true });
		const ctx = makeContext(cwd);

		try {
			for (
				let attempts = 0;
				attempts < 50 && !tools.some((tool) => tool.name === "memory");
				attempts++
			) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			const memoryTool = tools.find((tool) => tool.name === "memory");
			expect(memoryTool).toBeDefined();

			await fire("session_start", { type: "session_start" }, ctx);
			await fire(
				"before_agent_start",
				{
					type: "before_agent_start",
					prompt: "save this durable fact",
					systemPrompt: "base",
				systemPromptOptions: { cwd: "/tmp" },
				} satisfies BeforeAgentStartEvent,
				ctx,
			);

			const result = await Promise.race([
				memoryTool!.execute(
					"call-2",
					{
						action: "add",
						target: "global",
						summary: hook("tau-memory-full-runtime-repro"),
						content: "tau-memory-full-runtime-repro",
					},
					undefined,
					undefined,
					ctx,
				),
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error("full runtime memory execute timed out")),
						1500,
					),
				),
			]);

			await Promise.race([
				fire(
					"tool_result",
					{
						type: "tool_result",
						toolName: "memory",
						toolCallId: "call-2",
						input: {
							action: "add",
							target: "global",
							summary: hook("tau-memory-full-runtime-repro"),
							content: "tau-memory-full-runtime-repro",
						},
						content: result.content,
						details: result.details,
						isError: false,
					} satisfies ToolResultEvent,
					ctx,
				),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("full runtime tool_result timed out")), 1500),
				),
			]);

			await expect(
				Promise.race([
					fire(
						"context",
						{
							type: "context",
							messages: [
								{
									role: "user",
									content: [{ type: "text", text: "continue" }],
									timestamp: Date.now(),
								},
							],
						} satisfies ContextEvent,
						ctx,
					),
					new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error("full runtime context timed out")), 1500),
					),
				]),
			).resolves.toBeDefined();
		} finally {
			await Effect.runPromise(Fiber.interrupt(fiber));
		}
	});

	it("registers /memories and sends all scopes in one view payload", async () => {
		const { pi, commands, sentMessages } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));
		const runEffect = <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) =>
			runtime.runPromise(effect);
		const cwd = path.join(tempHome, "workspace-memories-command");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "settings.json"), "{}", "utf8");

		try {
			const memory = await runEffect(
				Effect.gen(function* () {
					return yield* CuratedMemory;
				}),
			);
			await runtime.runPromise(Effect.scoped(memory.setup));
			await runEffect(
				memory.add(
					"project",
					hook("project memory preview"),
					"project memory preview",
					cwd,
				),
			);
			await runEffect(
				memory.add("global", hook("global memory preview"), "global memory preview", cwd),
			);
			await runEffect(
				memory.add("user", hook("user memory preview"), "user memory preview", cwd),
			);

			initMemory(pi, runEffect);

			const command = commands.get("memories");
			expect(command).toBeDefined();

			await command!.handler("", makeContext(cwd));

			expect(sentMessages).toHaveLength(1);
			const [message] = sentMessages;
			expect(message?.customType).toBe("memories");

			const details = message?.details as MemoriesMessageDetails | undefined;
			expect(details?.snapshot.project.entries.map((entry) => entry.content)).toEqual([
				"project memory preview",
			]);
			expect(details?.snapshot.global.entries.map((entry) => entry.content)).toEqual([
				"global memory preview",
			]);
			expect(details?.snapshot.user.entries.map((entry) => entry.content)).toEqual([
				"user memory preview",
			]);
			expect(details?.snapshot.project.entries[0]?.id).toHaveLength(12);
		} finally {
			await runtime.dispose();
		}
	});

	it("surfaces persisted entries that still need summary repair in /memories payload", async () => {
		const { pi, commands, sentMessages } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));
		const runEffect = <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) =>
			runtime.runPromise(effect);
		const cwd = path.join(tempHome, "workspace-memories-repair");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "settings.json"), "{}", "utf8");
		await fs.mkdir(path.dirname(globalMemoryPath(tempHome)), { recursive: true });
		await fs.writeFile(
			globalMemoryPath(tempHome),
			JSON.stringify({
				id: "repair123456",
				scope: "global",
				type: "fact",
				summary: "needs repair body",
				content: "needs repair body",
				createdAt: "2024-01-02T03:04:05.000Z",
				updatedAt: "2024-01-02T03:04:05.000Z",
			}),
			"utf8",
		);

		try {
			const memory = await runEffect(
				Effect.gen(function* () {
					return yield* CuratedMemory;
				}),
			);
			await runtime.runPromise(Effect.scoped(memory.setup));

			initMemory(pi, runEffect);

			const command = commands.get("memories");
			expect(command).toBeDefined();

			await command!.handler("", makeContext(cwd));

			const details = sentMessages[0]?.details as MemoriesMessageDetails | undefined;
			expect(details?.issues).toEqual([
				{
					id: "repair123456",
					scope: "global",
					summary: "needs repair body",
					content: "needs repair body",
					reason: "summary_matches_content",
				},
			]);
		} finally {
			await runtime.dispose();
		}
	});

	it("surfaces descriptive /memories errors when a memory file is invalid", async () => {
		const { pi, commands } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));
		const runEffect = <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) =>
			runtime.runPromise(effect);
		const cwd = path.join(tempHome, "workspace-memories-invalid");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "settings.json"), "{}", "utf8");
		await fs.mkdir(path.dirname(globalMemoryPath(tempHome)), { recursive: true });
		await fs.writeFile(
			globalMemoryPath(tempHome),
			JSON.stringify({
				id: "bad",
				content: "broken memory entry",
				createdAt: "2024-01-02T03:04:05.000Z",
				updatedAt: "2024-01-02T03:04:05.000Z",
			}),
			"utf8",
		);

		const notifications: Array<{ readonly message: string; readonly level: string }> = [];

		try {
			const memory = await runEffect(
				Effect.gen(function* () {
					return yield* CuratedMemory;
				}),
			);
			await runtime.runPromise(Effect.scoped(memory.setup));

			initMemory(pi, runEffect);

			const command = commands.get("memories");
			expect(command).toBeDefined();

			await command!.handler("", {
				...makeContext(cwd),
				ui: {
					setWidget: () => undefined,
					setFooter: () => () => undefined,
					setEditorComponent: () => undefined,
					notify: (message: string, level: string) => {
						notifications.push({ message, level });
					},
					setStatus: () => undefined,
				},
			} as unknown as ExtensionContext);

			expect(notifications).toEqual([
				{
					message: expect.stringContaining("expected a nanoid"),
					level: "error",
				},
			]);
		} finally {
			await runtime.dispose();
		}
	});

	it("returns a clear model-facing error when a memory scope would overflow", async () => {
		const { pi, tools } = makePiStub();
		const runtime = ManagedRuntime.make(CuratedMemoryLive.pipe(Layer.provide(PiAPILive(pi))));
		const runEffect = <A, E>(effect: Effect.Effect<A, E, CuratedMemory>) =>
			runtime.runPromise(effect);
		const cwd = path.join(tempHome, "workspace-memory-overflow");
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".pi", "settings.json"), "{}", "utf8");

		try {
			const memory = await runEffect(
				Effect.gen(function* () {
					return yield* CuratedMemory;
				}),
			);
			await runtime.runPromise(Effect.scoped(memory.setup));
			await runEffect(memory.add("user", "overflow setup", "u".repeat(24_000), cwd));

			initMemory(pi, runEffect);

			const memoryTool = tools.find((tool) => tool.name === "memory");
			expect(memoryTool).toBeDefined();

			const result = (await memoryTool!.execute(
				"call-overflow",
				{
					action: "add",
					target: "user",
					summary: "overflow attempt",
					content: "v".repeat(2_000),
				},
				undefined,
				undefined,
				makeContext(cwd),
			)) as MemoryToolExecutionResult;

			expect(result.content[0]).toEqual({
				type: "text",
				text: [
					"user memory limit exceeded.",
					"Current total: 24000/25000 chars.",
					"Projected total after this change: 26003/25000 chars.",
					"Next step: shorten this content, remove or shorten existing user memories, or use project/global memory.",
				].join("\n"),
			});
		} finally {
			await runtime.dispose();
		}
	});
});
