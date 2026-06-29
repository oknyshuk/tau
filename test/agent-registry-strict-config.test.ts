import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";

import { AgentRegistry, AgentRegistryConfigError } from "../src/agent/agent-registry.js";

function mkdtemp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function validAgentMarkdown(name: string): string {
	return `---
name: ${name}
description: test agent
models:
  - model: inherit
    thinking: inherit
sandbox: read-only
approval_timeout: 60
---

You are ${name}.
`;
}

describe("agent-registry strict validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("fails when a discovered agent file is invalid", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			`---
name: oracle
description: broken
models:
  - model: inherit
    thinking: ultra
sandbox: read-only
approval_timeout: 60
---

broken
`,
		);

		vi.stubEnv("HOME", tempHome);

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/Invalid agent definition/,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/oracle\.md/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails when user agent settings are malformed", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							models: "not-an-array",
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/agents\.oracle\.models must be an array/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts model shorthand in user agent settings", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							model: "anthropic/claude-sonnet-4",
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("oracle");
		expect(resolved?.models).toEqual([{ model: "anthropic/claude-sonnet-4" }]);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts inherit model shorthand in user agent settings", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							model: "inherit",
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("oracle");
		expect(resolved?.models).toEqual([{ model: "inherit", thinking: "inherit" }]);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts inherit thinking in user agent settings", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							model: "inherit",
							thinking: "inherit",
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("oracle");
		expect(resolved?.models).toEqual([{ model: "inherit", thinking: "inherit" }]);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts xhigh in user agent settings", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							models: [
								{
									model: "openai-codex/gpt-5.3-codex",
									thinking: "xhigh",
								},
							],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("oracle");
		expect(resolved?.models[0]).toEqual({
			model: "openai-codex/gpt-5.3-codex",
			thinking: "xhigh",
		});

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts model shorthand in project agent settings", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(path.join(tempProject, ".pi", "agents", "oracle.md"), validAgentMarkdown("oracle"));
		writeFile(
			path.join(tempProject, ".pi", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							model: "openai/gpt-5",
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("oracle");
		expect(resolved?.models).toEqual([{ model: "openai/gpt-5" }]);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts tool allowlist overrides in user settings", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							tools: ["read", "exec_command"],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("oracle");
		expect(resolved?.tools).toEqual(["read", "exec_command"]);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts spawn restrictions in user settings", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							spawns: ["finder", "review"],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("oracle");
		expect(resolved?.spawns).toEqual(["finder", "review"]);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails when tool allowlist overrides are malformed", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							tools: ["read", "read"],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/agents\.oracle\.tools\[1\] duplicates "read"/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails when spawn restrictions are malformed", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							spawns: ["finder", 42],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/agents\.oracle\.spawns must be "\*" or an array of strings/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails when both model and models are specified on the same agent", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							model: "anthropic/claude-sonnet-4",
							models: [{ model: "openai/gpt-5" }],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/cannot specify both 'model' and 'models'/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("rejects complexity in agent settings", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						oracle: {
							complexity: {
								low: {
									models: [{ model: "openai/gpt-5" }],
								},
							},
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/complexity is not supported \(allowed keys: model, thinking, models, tools, spawns\)/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails even when invalid lower-priority agent is overridden", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			`---
name: oracle
description: broken
models:
  - model: inherit
    thinking: ultra
sandbox: read-only
approval_timeout: 60
---

broken
`,
		);

		writeFile(
			path.join(tempProject, ".pi", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/Invalid agent definition/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts tool allowlist overrides for bundled agents", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						smart: {
							tools: ["read", "exec_command"],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("smart");
		expect(resolved?.tools).toEqual(["read", "exec_command"]);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts spawn restrictions for bundled smart agent", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						smart: {
							spawns: [],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("smart");
		expect(resolved?.spawns).toEqual([]);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("accepts model overrides for bundled smart agent", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						smart: {
							models: [
								{
									model: "inherit",
									thinking: "inherit",
								},
							],
						},
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		const resolved = registry.resolve("smart");
		expect(resolved?.models).toEqual([{ model: "inherit", thinking: "inherit" }]);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("allows smart to be defined as a markdown agent", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "smart.md"),
			validAgentMarkdown("smart"),
		);

		vi.stubEnv("HOME", tempHome);

		const registry = await Effect.runPromise(AgentRegistry.load(tempProject));
		expect(registry.resolve("smart")?.systemPrompt).toBe("You are smart.");

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails when default is defined as a markdown agent", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "default.md"),
			validAgentMarkdown("default"),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrowError(
			AgentRegistryConfigError,
		);
		await expect(Effect.runPromise(AgentRegistry.load(tempProject))).rejects.toThrow(
			/default is not a spawnable agent/,
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});
});
