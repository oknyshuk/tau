import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Type } from "typebox";
import { Effect } from "effect";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { applyAgentToolAllowlist } from "../src/agent/tool-allowlist.js";
import { AgentError } from "../src/agent/services.js";
import type { AgentDefinition } from "../src/agent/types.js";
import type { ExecutionPolicy } from "../src/execution/schema.js";

async function withTempDir<A>(fn: (dir: string) => Promise<A>): Promise<A> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-tool-allowlist-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const agentToolDefinition: ToolDefinition = {
	name: "agent",
	label: "agent",
	description: "Manage worker agents",
	parameters: Type.Object({}),
	async execute() {
		return {
			content: [{ type: "text" as const, text: "ok" }],
			details: { ok: true },
		};
	},
};

const submitResultToolDefinition: ToolDefinition = {
	name: "submit_result",
	label: "submit_result",
	description: "Submit structured result",
	parameters: Type.Object({}),
	async execute() {
		return {
			content: [{ type: "text" as const, text: "submitted" }],
			details: { ok: true },
		};
	},
};

const applyPatchToolDefinition: ToolDefinition = {
	name: "apply_patch",
	label: "apply_patch",
	description: "Apply Codex-style patches",
	parameters: Type.Object({ input: Type.String() }),
	async execute() {
		return {
			content: [{ type: "text" as const, text: "patched" }],
			details: { ok: true },
		};
	},
};

const execCommandToolDefinition: ToolDefinition = {
	name: "exec_command",
	label: "exec_command",
	description: "Run shell commands",
	parameters: Type.Object({ cmd: Type.String() }),
	async execute() {
		return {
			content: [{ type: "text" as const, text: "ok" }],
			details: { ok: true },
		};
	},
};

const writeStdinToolDefinition: ToolDefinition = {
	name: "write_stdin",
	label: "write_stdin",
	description: "Send input to a running shell session",
	parameters: Type.Object({ session_id: Type.Number(), chars: Type.String() }),
	async execute() {
		return {
			content: [{ type: "text" as const, text: "ok" }],
			details: { ok: true },
		};
	},
};

function buildDefinition(tools: readonly string[] | undefined): AgentDefinition {
	return {
		name: "test-agent",
		description: "test agent",
		models: [{ model: "inherit", thinking: "inherit" }],
		...(tools !== undefined ? { tools } : {}),
		sandbox: { preset: "read-only" },
		systemPrompt: "Test prompt",
	};
}

function requireToolsPolicy(tools: readonly string[]): ExecutionPolicy {
	const [firstTool, ...restTools] = tools;
	if (firstTool === undefined) {
		throw new Error("requireToolsPolicy requires at least one tool");
	}

	return {
		tools: {
			kind: "require",
			tools: [firstTool, ...restTools],
		},
	};
}

function allowlistPolicy(tools: readonly string[]): ExecutionPolicy {
	const [firstTool, ...restTools] = tools;
	if (firstTool === undefined) {
		throw new Error("allowlistPolicy requires at least one tool");
	}

	return {
		tools: {
			kind: "allowlist",
			tools: [firstTool, ...restTools],
		},
	};
}

describe("agent tool allowlist", () => {
	it("activates exactly the configured tool set", async () => {
		await withTempDir(async (cwd) => {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const { session } = await createAgentSession({
				cwd,
				authStorage: AuthStorage.create(),
				modelRegistry: ModelRegistry.create(AuthStorage.create()),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [agentToolDefinition, submitResultToolDefinition, applyPatchToolDefinition],
			});

			await Effect.runPromise(
				applyAgentToolAllowlist(session, buildDefinition(["read", "agent"]), undefined),
			);

			expect(session.getActiveToolNames()).toEqual(["read", "agent"]);
		});
	});

	it("auto-enables submit_result when structured output is required", async () => {
		await withTempDir(async (cwd) => {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const { session } = await createAgentSession({
				cwd,
				authStorage: AuthStorage.create(),
				modelRegistry: ModelRegistry.create(AuthStorage.create()),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [agentToolDefinition, submitResultToolDefinition, applyPatchToolDefinition],
			});

			await Effect.runPromise(
				applyAgentToolAllowlist(
					session,
					buildDefinition(["read"]),
					Type.Object({ ok: Type.Boolean() }),
				),
			);

			expect(session.getActiveToolNames()).toEqual(["read", "submit_result"]);
		});
	});

	it("routes edit/write to apply_patch for openai-family agent sessions", async () => {
		await withTempDir(async (cwd) => {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const modelRegistry = ModelRegistry.create(AuthStorage.create());
			const model = modelRegistry.find("openai", "gpt-5");
			expect(model).toBeDefined();

			const { session } = await createAgentSession({
				cwd,
				authStorage: AuthStorage.create(),
				modelRegistry,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [agentToolDefinition, applyPatchToolDefinition, execCommandToolDefinition],
				...(model ? { model } : {}),
			});

			await Effect.runPromise(
				applyAgentToolAllowlist(
					session,
					buildDefinition(["read", "edit", "write", "apply_patch"]),
					undefined,
				),
			);

			expect(session.getActiveToolNames()).toEqual(["read", "apply_patch"]);
		});
	});

	it("keeps edit/write for non-openai agent sessions", async () => {
		await withTempDir(async (cwd) => {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const modelRegistry = ModelRegistry.create(AuthStorage.create());
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();

			const { session } = await createAgentSession({
				cwd,
				authStorage: AuthStorage.create(),
				modelRegistry,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [agentToolDefinition, applyPatchToolDefinition, execCommandToolDefinition],
				...(model ? { model } : {}),
			});

			await Effect.runPromise(
				applyAgentToolAllowlist(
					session,
					buildDefinition(["read", "edit", "write", "apply_patch"]),
					undefined,
				),
			);

			expect(session.getActiveToolNames()).toEqual(["read", "edit", "write"]);
		});
	});

	it("routes default worker tools when an agent definition omits tools", async () => {
		await withTempDir(async (cwd) => {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const modelRegistry = ModelRegistry.create(AuthStorage.create());
			const model = modelRegistry.find("openai-codex", "gpt-5.3-codex");
			expect(model).toBeDefined();

			const { session } = await createAgentSession({
				cwd,
				authStorage: AuthStorage.create(),
				modelRegistry,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [agentToolDefinition, applyPatchToolDefinition, execCommandToolDefinition],
				...(model ? { model } : {}),
			});

			await Effect.runPromise(applyAgentToolAllowlist(session, buildDefinition(undefined), undefined));

			expect(session.getActiveToolNames()).toContain("apply_patch");
			expect(session.getActiveToolNames()).not.toContain("edit");
			expect(session.getActiveToolNames()).not.toContain("write");
		});
	});

	it("removes pi-builtin bash from worker active tools (defense-in-depth for tau-9ka)", async () => {
		await withTempDir(async (cwd) => {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const modelRegistry = ModelRegistry.create(AuthStorage.create());
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();

			const { session } = await createAgentSession({
				cwd,
				authStorage: AuthStorage.create(),
				modelRegistry,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				// pi's createAgentSession installs builtin `read`, `bash`, `edit`, `write`.
				// We pass tau's `exec_command` as a custom tool so the rewrite can route
				// bash -> exec_command + write_stdin (write_stdin would also be a custom
				// tool in production; the rewrite tolerates absence by injecting just
				// what's available).
				customTools: [
					agentToolDefinition,
					applyPatchToolDefinition,
					execCommandToolDefinition,
					writeStdinToolDefinition,
				],
				...(model ? { model } : {}),
			});

			// Sanity: pi's builtin bash is in the available tools and active by default.
			expect(session.getAllTools().map((t) => t.name)).toContain("bash");
			expect(session.getActiveToolNames()).toContain("bash");

			await Effect.runPromise(applyAgentToolAllowlist(session, buildDefinition(undefined), undefined));

			// After the allowlist runs, bash must be gone and the sandboxed pair must replace it.
			expect(session.getActiveToolNames()).not.toContain("bash");
			expect(session.getActiveToolNames()).toContain("exec_command");
			expect(session.getActiveToolNames()).toContain("write_stdin");
		});
	});

	it("removes bash even when an agent definition explicitly lists it (defense-in-depth)", async () => {
		await withTempDir(async (cwd) => {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const modelRegistry = ModelRegistry.create(AuthStorage.create());
			const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
			expect(model).toBeDefined();

			const { session } = await createAgentSession({
				cwd,
				authStorage: AuthStorage.create(),
				modelRegistry,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [
					agentToolDefinition,
					applyPatchToolDefinition,
					execCommandToolDefinition,
					writeStdinToolDefinition,
				],
				...(model ? { model } : {}),
			});

			await Effect.runPromise(
				applyAgentToolAllowlist(session, buildDefinition(["read", "bash"]), undefined),
			);

			expect(session.getActiveToolNames()).not.toContain("bash");
			expect(session.getActiveToolNames()).toContain("exec_command");
			expect(session.getActiveToolNames()).toContain("write_stdin");
		});
	});

	it("uses require policy as additive constraints when definition omits tools", async () => {
		await withTempDir(async (cwd) => {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const { session } = await createAgentSession({
				cwd,
				authStorage: AuthStorage.create(),
				modelRegistry: ModelRegistry.create(AuthStorage.create()),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [agentToolDefinition, applyPatchToolDefinition, execCommandToolDefinition],
			});

			session.setActiveToolsByName(["read"]);

			await Effect.runPromise(
				applyAgentToolAllowlist(
					session,
					buildDefinition(undefined),
					undefined,
					requireToolsPolicy(["exec_command"]),
				),
			);

			expect(session.getActiveToolNames()).toEqual(["read", "exec_command"]);
		});
	});

	it("uses require policy as additive constraints for definition tools", async () => {
		await withTempDir(async (cwd) => {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const { session } = await createAgentSession({
				cwd,
				authStorage: AuthStorage.create(),
				modelRegistry: ModelRegistry.create(AuthStorage.create()),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [agentToolDefinition, applyPatchToolDefinition, execCommandToolDefinition],
			});

			await Effect.runPromise(
				applyAgentToolAllowlist(
					session,
					buildDefinition(["read"]),
					undefined,
					requireToolsPolicy(["exec_command"]),
				),
			);

			expect(session.getActiveToolNames()).toEqual(["read", "exec_command"]);
		});
	});

	it("uses allowlist policy to pin the active tools", async () => {
		await withTempDir(async (cwd) => {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const { session } = await createAgentSession({
				cwd,
				authStorage: AuthStorage.create(),
				modelRegistry: ModelRegistry.create(AuthStorage.create()),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [agentToolDefinition, applyPatchToolDefinition, execCommandToolDefinition],
			});

			await Effect.runPromise(
				applyAgentToolAllowlist(
					session,
					buildDefinition(["read", "exec_command"]),
					undefined,
					allowlistPolicy(["read"]),
				),
			);

			expect(session.getActiveToolNames()).toEqual(["read"]);
		});
	});

	it("fails fast on unknown tools", async () => {
		await withTempDir(async (cwd) => {
			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const { session } = await createAgentSession({
				cwd,
				authStorage: AuthStorage.create(),
				modelRegistry: ModelRegistry.create(AuthStorage.create()),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				customTools: [agentToolDefinition, applyPatchToolDefinition],
			});

			await expect(
				Effect.runPromise(
					applyAgentToolAllowlist(
						session,
						buildDefinition(["read", "not-real"]),
						undefined,
					),
				),
			).rejects.toThrowError(AgentError);
			await expect(
				Effect.runPromise(
					applyAgentToolAllowlist(
						session,
						buildDefinition(["read", "not-real"]),
						undefined,
					),
				),
			).rejects.toThrow(/Invalid tools for agent "test-agent": not-real/);
		});
	});
});
