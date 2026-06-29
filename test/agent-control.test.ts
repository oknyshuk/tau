import { describe, expect, it } from "vitest";

import {
	buildDisabledAgentMessage,
	clampAgentDefinitionToolsToParentTools,
	DEFAULT_WAIT_TIMEOUT_MS,
	MAX_WAIT_TIMEOUT_MS,
	normalizeWaitTimeoutMs,
} from "../src/agent/control.js";
import type { AgentDefinition } from "../src/agent/types.js";

function makeDefinition(tools?: readonly string[]): AgentDefinition {
	return {
		name: "finder",
		description: "Find things",
		models: [{ model: "inherit" }],
		...(tools === undefined ? {} : { tools }),
		sandbox: { preset: "read-only" },
		systemPrompt: "Find things.",
	};
}

describe("agent wait timeout normalization", () => {
	it("uses the default timeout when none is provided", () => {
		expect(normalizeWaitTimeoutMs(undefined)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
	});

	it("rounds smaller requested timeouts up to the default", () => {
		expect(normalizeWaitTimeoutMs(120_000)).toBe(DEFAULT_WAIT_TIMEOUT_MS);
	});

	it("keeps larger requested timeouts up to the max", () => {
		expect(normalizeWaitTimeoutMs(1_800_000)).toBe(1_800_000);
	});

	it("caps requested timeouts at the maximum", () => {
		expect(normalizeWaitTimeoutMs(MAX_WAIT_TIMEOUT_MS + 1)).toBe(MAX_WAIT_TIMEOUT_MS);
	});
});

describe("disabled agent message", () => {
	it("does not instruct the assistant to use slash commands", () => {
		const message = buildDisabledAgentMessage("review", ["finder", "librarian"]);
		expect(message).toContain('Agent "review" is disabled for this session.');
		expect(message).toContain("Enabled agents: finder, librarian.");
		expect(message).toContain("ask the user to enable it for this session");
		expect(message).not.toContain("/agents");
	});

	it("renders an explicit none state when no agents are enabled", () => {
		const message = buildDisabledAgentMessage("review", []);
		expect(message).toContain("Enabled agents: (none).");
	});
});

describe("agent tool contract clamping", () => {
	it("pins inherited agent tools to the Ralph parent tool contract", () => {
		const clamped = clampAgentDefinitionToolsToParentTools(makeDefinition(), ["read"]);
		expect(clamped.tools).toEqual(["read"]);
	});

	it("intersects agent tool allowlists with the Ralph parent tool contract", () => {
		const clamped = clampAgentDefinitionToolsToParentTools(
			makeDefinition(["read", "exec_command", "write"]),
			["read", "write"],
		);
		expect(clamped.tools).toEqual(["read", "write"]);
	});

	it("leaves non-Ralph agent definitions unchanged", () => {
		const definition = makeDefinition(["read", "exec_command"]);
		const clamped = clampAgentDefinitionToolsToParentTools(definition, undefined);
		expect(clamped).toBe(definition);
	});
});
