import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createWorkerCustomTools } from "../src/agent/worker.js";

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
		expect((backlog?.parameters as { readonly type?: string }).type).toBe("object");
	});
});
