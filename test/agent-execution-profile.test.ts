import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { resolveAgentExecutionAtSpawn } from "../src/agent/execution-profile.js";
import type { AgentDefinition } from "../src/agent/types.js";
import type { ExecutionProfile, ExecutionSessionState } from "../src/execution/schema.js";

const parentExecutionState: ExecutionSessionState = {
	policy: {
		tools: {
			kind: "inherit",
		},
	},
};

const parentExecutionProfile: ExecutionProfile = {
	model: "anthropic/claude-opus-4-5",
	thinking: "high",
	policy: {
		tools: {
			kind: "inherit",
		},
	},
};

describe("resolveAgentExecutionAtSpawn", () => {
	it("resolves smart as an ordinary agent using its definition model", async () => {
		const definition: AgentDefinition = {
			name: "smart",
			description: "Smart agent",
			models: [{ model: "anthropic/claude-opus-4-5", thinking: "medium" }],
			tools: ["read", "exec_command"],
			spawns: "*",
			sandbox: { preset: "workspace-write" },
			systemPrompt: "smart",
		};

		const resolved = await Effect.runPromise(
			resolveAgentExecutionAtSpawn({
				definition,
				cwd: process.cwd(),
				parentExecutionState,
				parentExecutionProfile,
			}),
		);

		expect(resolved.definition.models[0]).toEqual({
			model: "anthropic/claude-opus-4-5",
			thinking: "medium",
		});
		expect(resolved.executionProfile).toMatchObject({
			model: "anthropic/claude-opus-4-5",
			thinking: "medium",
		});
		expect(resolved.executionState.policy.tools.kind).toBe("allowlist");
	});

	it("resolves inherit model specs against the parent execution profile", async () => {
		const definition: AgentDefinition = {
			name: "oracle",
			description: "Oracle",
			models: [
				{ model: "inherit", thinking: "inherit" },
				{ model: "openai-codex/gpt-5.4", thinking: "low" },
			],
			tools: ["read", "exec_command", "agent"],
			sandbox: { preset: "workspace-write" },
			systemPrompt: "oracle",
		};

		const resolved = await Effect.runPromise(
			resolveAgentExecutionAtSpawn({
				definition,
				cwd: process.cwd(),
				parentExecutionState,
				parentExecutionProfile,
			}),
		);

		expect(resolved.definition.models[0]).toEqual({
			model: "anthropic/claude-opus-4-5",
			thinking: "high",
		});
		expect(resolved.executionProfile).toMatchObject({
			model: "anthropic/claude-opus-4-5",
			thinking: "high",
		});
		expect(resolved.executionState.policy).toEqual({
			tools: {
				kind: "allowlist",
				tools: ["read", "exec_command", "agent"],
			},
		});
	});

	it("inherits parent execution policy when agent definition has no tools", async () => {
		const definition: AgentDefinition = {
			name: "review",
			description: "Review",
			models: [{ model: "openai-codex/gpt-5.4", thinking: "low" }],
			sandbox: { preset: "workspace-write" },
			systemPrompt: "review",
		};

		const requiredToolsParentState: ExecutionSessionState = {
			...parentExecutionState,
			policy: {
				tools: {
					kind: "require",
					tools: ["read", "exec_command"],
				},
			},
		};
		const requiredToolsParentProfile: ExecutionProfile = {
			...parentExecutionProfile,
			policy: requiredToolsParentState.policy,
		};

		const resolved = await Effect.runPromise(
			resolveAgentExecutionAtSpawn({
				definition,
				cwd: process.cwd(),
				parentExecutionState: requiredToolsParentState,
				parentExecutionProfile: requiredToolsParentProfile,
			}),
		);

		expect(resolved.executionState.policy).toEqual(requiredToolsParentState.policy);
		expect(resolved.executionProfile.policy).toEqual(requiredToolsParentState.policy);
	});
});
