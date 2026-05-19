import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";

import { AgentRegistry } from "../src/agent/agent-registry.js";

describe("agent-registry: bundled execution agents", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("loads smart, deep, and rush as ordinary bundled agents with inherit-tier defaults", async () => {
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tau-home-"));
		vi.stubEnv("HOME", tempHome);

		try {
			const registry = await Effect.runPromise(AgentRegistry.load(process.cwd()));

			const smart = registry.resolve("smart");
			const deep = registry.resolve("deep");
			const rush = registry.resolve("rush");
			const plan = registry.resolve("plan");
			const defaultMode = registry.resolve("default");

			// Bundled smart/deep/rush ship with model: inherit + a thinking tier so
			// they work without user configuration. The thinking tier is what
			// distinguishes them.
			expect(smart?.models).toEqual([{ model: "inherit", thinking: "high" }]);
			expect(deep?.models).toEqual([{ model: "inherit", thinking: "xhigh" }]);
			expect(rush?.models).toEqual([{ model: "inherit", thinking: "medium" }]);
			expect(smart?.description).not.toContain("mode");
			expect(smart?.systemPrompt).toContain("powerful AI coding agent");
			expect(deep?.systemPrompt).toContain("maximum reasoning capabilities");
			expect(rush?.systemPrompt).toContain("optimized for speed");
			expect(plan).toBeUndefined();
			expect(defaultMode).toBeUndefined();
			expect(registry.has("default")).toBe(false);
			expect(registry.has("plan")).toBe(false);
			expect(registry.names()).not.toContain("default");
			expect(registry.names()).not.toContain("plan");
		} finally {
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});

	it("allows project smart agent files to override the bundled smart agent", async () => {
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tau-home-"));
		const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "tau-project-"));
		vi.stubEnv("HOME", tempHome);

		try {
			const projectAgentsDir = path.join(tempProject, ".pi", "agents");
			fs.mkdirSync(projectAgentsDir, { recursive: true });
			fs.writeFileSync(
				path.join(projectAgentsDir, "smart.md"),
				`---
name: smart
description: Project smart override
models:
  - model: inherit
    thinking: inherit
sandbox: read-only
---

Project-specific smart prompt.
`,
			);

			const registry = await Effect.runPromise(AgentRegistry.load(tempProject));

			expect(registry.resolve("smart")?.description).toBe("Project smart override");
			expect(registry.resolve("smart")?.systemPrompt).toBe("Project-specific smart prompt.");
		} finally {
			fs.rmSync(tempHome, { recursive: true, force: true });
			fs.rmSync(tempProject, { recursive: true, force: true });
		}
	});

	it("applies ordinary agents settings overrides to smart, deep, and rush", async () => {
		const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tau-home-"));
		vi.stubEnv("HOME", tempHome);

		try {
			const settingsDir = path.join(tempHome, ".pi", "agent");
			fs.mkdirSync(settingsDir, { recursive: true });
			fs.writeFileSync(
				path.join(settingsDir, "settings.json"),
				JSON.stringify({
					agents: {
						smart: { model: "anthropic/claude-sonnet-4-5", thinking: "high" },
						deep: { tools: ["read", "exec_command"], spawns: ["finder"] },
						rush: { models: [{ model: "openai-codex/gpt-5.4", thinking: "minimal" }] },
					},
				}),
			);

			const registry = await Effect.runPromise(AgentRegistry.load(process.cwd()));

			expect(registry.resolve("smart")?.models).toEqual([
				{ model: "anthropic/claude-sonnet-4-5", thinking: "high" },
			]);
			expect(registry.resolve("deep")?.tools).toEqual(["read", "exec_command"]);
			expect(registry.resolve("deep")?.spawns).toEqual(["finder"]);
			expect(registry.resolve("rush")?.models).toEqual([
				{ model: "openai-codex/gpt-5.4", thinking: "minimal" },
			]);
		} finally {
			fs.rmSync(tempHome, { recursive: true, force: true });
		}
	});
});
