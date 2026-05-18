import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Effect, Option } from "effect";
import { parseAgentDefinition, loadAgentDefinition } from "../src/agent/parser.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("agent-parser", () => {
	it("should parse valid agent definition with models array", async () => {
		const content = `---
name: oracle
description: The oracle agent
models:
  - model: claude-3-5-sonnet-latest
    thinking: high
  - model: groq/llama-4-scout
    thinking: medium
sandbox: workspace-write
approval_timeout: 45
---
You are the oracle.`;

		const def = await Effect.runPromise(parseAgentDefinition(content));
		expect(def.name).toBe("oracle");
		expect(def.description).toBe("The oracle agent");
		expect(def.models).toHaveLength(2);
		expect(def.models[0]).toEqual({ model: "claude-3-5-sonnet-latest", thinking: "high" });
		expect(def.models[1]).toEqual({ model: "groq/llama-4-scout", thinking: "medium" });
		expect(def.sandbox.preset).toBe("workspace-write");
		expect(def.systemPrompt).toBe("You are the oracle.");
	});

	it("should parse xhigh thinking level", async () => {
		const content = `---
name: oracle
description: The oracle agent
models:
  - model: openai-codex/gpt-5.3-codex
    thinking: xhigh
sandbox: read-only
approval_timeout: 60
---
Deep reasoning.`;

		const def = await Effect.runPromise(parseAgentDefinition(content));
		expect(def.models).toHaveLength(1);
		expect(def.models[0]).toEqual({ model: "openai-codex/gpt-5.3-codex", thinking: "xhigh" });
	});

	it("should parse inherit model", async () => {
		const content = `---
name: finder
description: Finder agent
models:
  - model: inherit
    thinking: inherit
sandbox: read-only
approval_timeout: 60
---
Find stuff.`;

		const def = await Effect.runPromise(parseAgentDefinition(content));
		expect(def.models).toHaveLength(1);
		expect(def.models[0]).toEqual({ model: "inherit", thinking: "inherit" });
	});

	it("should parse models without thinking", async () => {
		const content = `---
name: rush
description: Fast agent
models:
  - model: groq/llama-4-scout
  - model: anthropic/claude-haiku-4-5
sandbox: workspace-write
approval_timeout: 60
---
Go fast.`;

		const def = await Effect.runPromise(parseAgentDefinition(content));
		expect(def.models).toHaveLength(2);
		expect(def.models[0]).toEqual({ model: "groq/llama-4-scout" });
		expect(def.models[1]).toEqual({ model: "anthropic/claude-haiku-4-5" });
	});

	it("should parse tool allowlist", async () => {
		const content = `---
name: finder
description: Finder agent
models:
  - model: inherit
    thinking: inherit
tools:
  - read
  - exec_command
  - write_stdin
sandbox: read-only
approval_timeout: 60
---
Find stuff.`;

		const def = await Effect.runPromise(parseAgentDefinition(content));
		expect(def.tools).toEqual(["read", "exec_command", "write_stdin"]);
	});

	it("should parse spawn restrictions", async () => {
		const content = `---
name: reviewer
description: Review agent
models:
  - model: inherit
    thinking: inherit
spawns:
  - finder
  - oracle
sandbox: read-only
approval_timeout: 60
---
Review stuff.`;

		const def = await Effect.runPromise(parseAgentDefinition(content));
		expect(def.spawns).toEqual(["finder", "oracle"]);
	});

	it("should parse folded multiline yaml descriptions", async () => {
		const content = `---
name: review
description: >-
  Code review agent (read-only). Reviews diffs for bugs, security issues,
  improvements. Returns prioritized findings (P0-P3).
models:
  - model: inherit
    thinking: inherit
sandbox: read-only
approval_timeout: 60
---
Review stuff.`;

		const def = await Effect.runPromise(parseAgentDefinition(content));
		expect(def.description).toBe(
			"Code review agent (read-only). Reviews diffs for bugs, security issues, improvements. Returns prioritized findings (P0-P3).",
		);
	});

	it("should throw on unknown frontmatter keys", async () => {
		const content = `---
name: finder
description: Finder agent
models:
  - model: inherit
    thinking: inherit
sandbox_fs: read-only
sandbox_net: allow-all
approval_policy: never
approval_timeout: 60
---
Find stuff.`;

		await expect(Effect.runPromise(parseAgentDefinition(content))).rejects.toThrow(
			/unknown keys: approval_policy, sandbox_fs, sandbox_net/,
		);
	});

	it("should parse missing models as unresolved", async () => {
		const content = `---
name: oracle
description: The oracle agent
sandbox: workspace-write
approval_timeout: 60
---
Prompt`;

		await expect(Effect.runPromise(parseAgentDefinition(content))).resolves.toMatchObject({
			models: [],
		});
	});

	it("should throw on duplicate tools", async () => {
		const content = `---
name: oracle
description: The oracle agent
models:
  - model: inherit
    thinking: inherit
tools:
  - read
  - read
sandbox: read-only
approval_timeout: 60
---
Prompt`;

		await expect(Effect.runPromise(parseAgentDefinition(content))).rejects.toThrow(
			/tools\[1\] duplicates "read"/,
		);
	});

	it("should parse empty models array as unresolved", async () => {
		const content = `---
name: oracle
description: The oracle agent
models: []
sandbox: workspace-write
approval_timeout: 60
---
Prompt`;

		await expect(Effect.runPromise(parseAgentDefinition(content))).resolves.toMatchObject({
			models: [],
		});
	});

	it("should throw on missing frontmatter", async () => {
		const content = "No frontmatter here";
		await expect(Effect.runPromise(parseAgentDefinition(content))).rejects.toThrow(
			"Missing YAML frontmatter",
		);
	});

	it("should throw on non-positive approval_timeout", async () => {
		const content = `---
name: oracle
description: The oracle agent
models:
  - model: claude-3-5-sonnet-latest
sandbox: workspace-write
approval_timeout: 0
---
Prompt`;
		await expect(Effect.runPromise(parseAgentDefinition(content))).rejects.toThrow();
	});

	it("should throw on fractional approval_timeout", async () => {
		const content = `---
name: oracle
description: The oracle agent
models:
  - model: claude-3-5-sonnet-latest
sandbox: workspace-write
approval_timeout: 1.5
---
Prompt`;
		await expect(Effect.runPromise(parseAgentDefinition(content))).rejects.toThrow();
	});

	it("should throw on invalid frontmatter", async () => {
		const content = `---
invalid
--- 
Prompt`;
		await expect(Effect.runPromise(parseAgentDefinition(content))).rejects.toThrow();
	});

	it("should throw on missing required fields", async () => {
		const content = `---
name: only-name
---
Prompt`;
		await expect(Effect.runPromise(parseAgentDefinition(content))).rejects.toThrow(
			/\["description"\]/,
		);
	});

	describe("loadAgentDefinition", () => {
		const tempDir = path.join(
			os.tmpdir(),
			"tau-agent-test-" + Math.random().toString(36).slice(2),
		);
		const agentsDir = path.join(tempDir, ".pi", "agents");

		beforeAll(() => {
			fs.mkdirSync(agentsDir, { recursive: true });
			fs.writeFileSync(
				path.join(agentsDir, "test-agent.md"),
				`---
name: test-agent
description: A test agent
models:
  - model: inherit
    thinking: low
sandbox: read-only
approval_timeout: 60
---
Test prompt`,
			);
		});

		afterAll(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it("should load agent from project .pi/agents", async () => {
			const def = await Effect.runPromise(loadAgentDefinition("test-agent", tempDir));
			expect(Option.isSome(def)).toBe(true);
			if (Option.isSome(def)) {
				expect(def.value.name).toBe("test-agent");
				expect(def.value.description).toBe("A test agent");
				expect(def.value.models).toHaveLength(1);
				expect(def.value.models[0]).toEqual({ model: "inherit", thinking: "low" });
			}
		});

		it("should return none if agent not found", async () => {
			const def = await Effect.runPromise(loadAgentDefinition("non-existent", tempDir));
			expect(Option.isNone(def)).toBe(true);
		});

		it("should reject invalid agent names", async () => {
			await expect(Effect.runPromise(loadAgentDefinition("../etc/passwd", tempDir))).rejects.toThrow(
				/Invalid agent name/,
			);
			await expect(Effect.runPromise(loadAgentDefinition("foo/bar", tempDir))).rejects.toThrow(
				/Invalid agent name/,
			);
			await expect(Effect.runPromise(loadAgentDefinition("-starts-with-dash", tempDir))).rejects.toThrow(
				/Invalid agent name/,
			);
		});
	});
});
