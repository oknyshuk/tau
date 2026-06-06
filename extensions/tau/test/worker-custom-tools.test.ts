import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import type { AgentDefinition } from "../src/agent/types.js";
import { BASELINE_NUDGE } from "../src/nudge/index.js";
import { createWorkerCustomTools } from "../src/agent/worker.js";
import { buildWorkerAppendPrompts } from "../src/agent/worker/tools.js";

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

describe("createWorkerCustomTools", () => {
	it("includes the shared worker-only tool definitions", () => {
		const tools = createWorkerCustomTools(agentToolDefinition);

		expect(tools.map((tool) => tool.name)).toEqual([
			"agent",
			"apply_patch",
			"backlog",
			"web_search_exa",
			"crawling_exa",
			"get_code_context_exa",
		]);
	});

	it("wires the backlog tool into the worker allowlist with a working execute", () => {
		const tools = createWorkerCustomTools(agentToolDefinition);
		const backlog = tools.find((t) => t.name === "backlog");
		expect(backlog).toBeDefined();
		expect(typeof backlog?.execute).toBe("function");
		expect(backlog?.parameters).toBeDefined();
		expect(backlog?.parameters["type"]).toBe("object");
	});
});

describe("buildWorkerAppendPrompts", () => {
	const baseDefinition = {
		name: "worker",
		description: "Worker",
		models: [{ model: "inherit" }],
		sandbox: { preset: "workspace-write" },
		systemPrompt: "Worker prompt.",
	} satisfies AgentDefinition;

	it("adds the nudge baseline for workers that can use memory tools", () => {
		const prompts = buildWorkerAppendPrompts({
			definition: {
				...baseDefinition,
				tools: ["read", "memory"],
			},
		});

		expect(prompts).toContain(BASELINE_NUDGE);
	});

	it("adds the nudge baseline for workers that can manage skills", () => {
		const prompts = buildWorkerAppendPrompts({
			definition: {
				...baseDefinition,
				tools: ["read", "skill_manage"],
			},
		});

		expect(prompts).toContain(BASELINE_NUDGE);
	});

	it("keeps the worker prompt unchanged when tracked tools are unavailable", () => {
		const prompts = buildWorkerAppendPrompts({
			definition: {
				...baseDefinition,
				tools: ["read", "exec_command"],
			},
		});

		expect(prompts).not.toContain(BASELINE_NUDGE);
	});
});
