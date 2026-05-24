import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

import { LoopRepo, LoopRepoLive } from "../src/loops/repo.js";
import { LoopEngine, LoopEngineLive } from "../src/services/loop-engine.js";
import { RalphContractResolver, RalphContractResolverLive } from "../src/ralph/resolver.js";
import {
	captureCapabilityContract,
	captureToolContract,
	captureAgentContract,
	validateCapabilityContract,
	validateExecutionContract,
	effectiveToolNames,
	checkControlToolsExcluded,
} from "../src/ralph/resolver.js";
import {
	makeEmptyCapabilityContract,
	makeCapabilityContract,
} from "../src/ralph/contract.js";
import { PiAPI } from "../src/effect/pi.js";
import { ExecutionRuntime } from "../src/services/execution-runtime.js";
import { DEFAULT_EXECUTION_POLICY, type ExecutionProfile } from "../src/execution/schema.js";
import { DEFAULT_SANDBOX_CONFIG } from "../src/sandbox/config.js";

const concreteProfile = (overrides?: Partial<ExecutionProfile>): ExecutionProfile => ({
	model: "test-provider/reasoning-model",
	thinking: "medium",
	policy: DEFAULT_EXECUTION_POLICY,
	...overrides,
});

const modelRegistry = {
	find: (provider: string, modelId: string) =>
		provider === "test-provider" && modelId === "reasoning-model"
			? {
				id: "reasoning-model",
				provider: "test-provider",
				reasoning: true,
			}
			: provider === "test-provider" && modelId === "plain-model"
				? {
					id: "plain-model",
					provider: "test-provider",
					reasoning: false,
				  }
				: undefined,
	getApiKey: (model: { readonly id: string }) =>
		Promise.resolve(model.id === "reasoning-model" || model.id === "plain-model" ? "key" : undefined),
};

const unauthenticatedModelRegistry = {
	...modelRegistry,
	getApiKey: () => Promise.resolve(undefined),
};

const piStub = {
	getActiveTools: () => [] as string[],
	getAllTools: () => [] as { name: string; description: string }[],
	setActiveTools: () => undefined,
} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

const piLayer = Layer.succeed(PiAPI, piStub);

const executionRuntimeStub = ExecutionRuntime.of({
	setup: Effect.void,
	captureCurrentExecutionProfile: () => Effect.succeed(null),
	applyExecutionProfile: (profile) => Effect.succeed({ applied: true as const, profile }),
});

const executionRuntimeLayer = Layer.succeed(ExecutionRuntime, executionRuntimeStub);

const resolverLayer = RalphContractResolverLive.pipe(
	Layer.provide(LoopRepoLive),
	Layer.provide(piLayer),
	Layer.provide(executionRuntimeLayer),
	Layer.provide(NodeFileSystem.layer),
);

describe("ralph contract resolver pure helpers", () => {
	it("captures tool contract excluding system control tools", () => {
		const contract = captureToolContract({
			activeTools: ["read", "ralph_continue", "exec_command", "ralph_finish"],
			allTools: [
				{ name: "read", description: "Read files" },
				{ name: "exec_command", description: "Run commands" },
				{ name: "ralph_continue", description: "Continue" },
			],
		});
		expect(contract.activeNames).toEqual(["read", "exec_command"]);
		expect(contract.availableSnapshot).toHaveLength(3);
		expect(contract.availableSnapshot[0]?.label).toBe("read");
	});

	it("captures active tools from the current runtime state", () => {
		const contract = captureToolContract({
			activeTools: ["read", "exec_command", "todo_write", "thread", "unknown_custom_tool"],
			allTools: [
				{ name: "read", description: "Read files" },
				{ name: "exec_command", description: "Run commands" },
				{ name: "backlog", description: "Backlog" },
				{ name: "web_search_exa", description: "Search" },
				{ name: "crawling_exa", description: "Crawl" },
				{ name: "get_code_context_exa", description: "Code context" },
				{ name: "agent", description: "Spawn agents" },
				{ name: "memory", description: "Memory" },
				{ name: "todo_write", description: "Todo" },
				{ name: "thread", description: "Thread" },
				{ name: "ralph_continue", description: "Continue" },
				{ name: "ralph_finish", description: "Finish" },
			],
		});

		expect(contract.activeNames).toEqual(["read", "exec_command", "todo_write", "thread"]);
	});

	it("does not invent mutation tools that are inactive in the current runtime", () => {
		const allTools = [
			{ name: "read", description: "Read files" },
			{ name: "edit", description: "Edit files" },
			{ name: "write", description: "Write files" },
			{ name: "exec_command", description: "Run commands" },
		];
		const contract = captureToolContract({
			activeTools: ["read"],
			allTools,
		});

		expect(contract.activeNames).toEqual(["read"]);
	});

	it("captures agent registry snapshot with currently enabled agents", () => {
		const registry = {
			list: () => [
				{ name: "finder", description: "Find code" },
				{ name: "oracle", description: "Deep reasoning" },
			],
		};
		const contract = captureAgentContract({
			agentRegistry: registry as unknown as import("../src/agent/agent-registry.js").AgentRegistry,
			enabledAgents: ["finder", "oracle"],
		});
		expect(contract.enabledNames).toEqual(["finder", "oracle"]);
		expect(contract.registrySnapshot).toHaveLength(2);
	});

	it("captures all currently enabled Ralph agents that exist in the registry", () => {
		const registry = {
			list: () => [
				{ name: "deep", description: "Deep" },
				{ name: "finder", description: "Find code" },
				{ name: "librarian", description: "Analyze code" },
				{ name: "oracle", description: "Reason" },
				{ name: "painter", description: "Frontend" },
				{ name: "plan", description: "Plan" },
				{ name: "review", description: "Review" },
				{ name: "rush", description: "Rush" },
				{ name: "smart", description: "Smart" },
			],
		};
		const contract = captureAgentContract({
			agentRegistry: registry as unknown as import("../src/agent/agent-registry.js").AgentRegistry,
			enabledAgents: ["deep", "finder", "librarian", "oracle", "painter", "plan", "review", "rush", "smart"],
		});

		expect(contract.enabledNames).toEqual(["deep", "finder", "librarian", "oracle", "painter", "plan", "review", "rush", "smart"]);
		expect(contract.registrySnapshot.map((agent) => agent.name)).toEqual([
			"deep",
			"finder",
			"librarian",
			"oracle",
			"painter",
			"plan",
			"review",
			"rush",
			"smart",
		]);
	});

	it("validates a correct contract", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read", "exec_command"],
			toolsAvailableSnapshot: [
				{ name: "read", label: "Read", description: "Read files" },
				{ name: "exec_command", label: "Bash", description: "Run commands" },
				{ name: "ralph_continue", label: "Continue", description: "Continue" },
				{ name: "ralph_finish", label: "Finish", description: "Finish" },
			],
			agentsEnabledNames: ["finder"],
			agentsRegistrySnapshot: [{ name: "finder", description: "Find code" }],
		});
		const result = validateCapabilityContract(contract);
		expect(result.valid).toBe(true);
	});

	it("rejects system control tools in user-configurable activeNames", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read", "ralph_continue", "exec_command"],
			toolsAvailableSnapshot: [{ name: "read", label: "Read", description: "Read files" }],
			agentsEnabledNames: [],
			agentsRegistrySnapshot: [],
		});
		const violations = checkControlToolsExcluded(contract);
		expect(violations).toContain("ralph_continue");
		expect(violations).not.toContain("ralph_finish");
	});

	it("reports empty snapshots in validation", () => {
		const contract = makeEmptyCapabilityContract();
		const result = validateCapabilityContract(contract);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.issues.some((i) => i.kind === "empty_tool_contract")).toBe(true);
			expect(result.issues.some((i) => i.kind === "empty_agent_contract")).toBe(true);
		}
	});

	it("reports missing pinned tools not in available snapshot", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read", "missing_tool"],
			toolsAvailableSnapshot: [{ name: "read", label: "Read", description: "Read files" }],
			agentsEnabledNames: [],
			agentsRegistrySnapshot: [],
		});
		const result = validateCapabilityContract(contract);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			const issue = result.issues.find((i) => i.kind === "missing_pinned_tools");
			expect(issue).toBeDefined();
			if (issue?.kind === "missing_pinned_tools") {
				expect(issue.missing).toContain("missing_tool");
			}
		}
	});

	it("reports missing enabled agents not in registry snapshot", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: [],
			toolsAvailableSnapshot: [{ name: "read", label: "Read", description: "Read files" }],
			agentsEnabledNames: ["finder", "missing_agent"],
			agentsRegistrySnapshot: [{ name: "finder", description: "Find code" }],
		});
		const result = validateCapabilityContract(contract);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			const issue = result.issues.find((i) => i.kind === "missing_enabled_agents");
			expect(issue).toBeDefined();
			if (issue?.kind === "missing_enabled_agents") {
				expect(issue.missing).toContain("missing_agent");
			}
		}
	});

	it("reports missing ralph control tools in available snapshot", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read"],
			toolsAvailableSnapshot: [{ name: "read", label: "Read", description: "Read files" }],
			agentsEnabledNames: [],
			agentsRegistrySnapshot: [],
		});
		const result = validateCapabilityContract(contract);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			const issue = result.issues.find((i) => i.kind === "missing_ralph_control_tools");
			expect(issue).toBeDefined();
			if (issue?.kind === "missing_ralph_control_tools") {
				expect(issue.missing).toContain("ralph_continue");
				expect(issue.missing).toContain("ralph_finish");
			}
		}
	});

	it("passes validation when all consistency checks are satisfied", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read"],
			toolsAvailableSnapshot: [
				{ name: "read", label: "Read", description: "Read files" },
				{ name: "ralph_continue", label: "Continue", description: "Continue" },
				{ name: "ralph_finish", label: "Finish", description: "Finish" },
			],
			agentsEnabledNames: ["finder"],
			agentsRegistrySnapshot: [{ name: "finder", description: "Find code" }],
		});
		const result = validateCapabilityContract(contract);
		expect(result.valid).toBe(true);
	});

	it("validates concrete execution model availability and auth", async () => {
		const missingModel = await validateExecutionContract({
			profile: concreteProfile({ model: "test-provider/missing-model" }),
			sandboxProfile: DEFAULT_SANDBOX_CONFIG,
			modelRegistry,
		});
		expect(missingModel.valid).toBe(false);
		if (!missingModel.valid) {
			expect(missingModel.issues.some((issue) => issue.kind === "missing_model")).toBe(true);
		}

		const missingAuth = await validateExecutionContract({
			profile: concreteProfile(),
			sandboxProfile: DEFAULT_SANDBOX_CONFIG,
			modelRegistry: unauthenticatedModelRegistry,
		});
		expect(missingAuth.valid).toBe(false);
		if (!missingAuth.valid) {
			expect(missingAuth.issues.some((issue) => issue.kind === "missing_model_auth")).toBe(true);
		}
	});

	it("validates thinking support and sandbox presence", async () => {
		const unsupportedThinking = await validateExecutionContract({
			profile: concreteProfile({ model: "test-provider/plain-model", thinking: "high" }),
			sandboxProfile: DEFAULT_SANDBOX_CONFIG,
			modelRegistry,
		});
		expect(unsupportedThinking.valid).toBe(false);
		if (!unsupportedThinking.valid) {
			expect(unsupportedThinking.issues.some((issue) => issue.kind === "unsupported_thinking")).toBe(true);
		}

		const missingSandbox = await validateExecutionContract({
			profile: concreteProfile(),
			sandboxProfile: undefined,
			modelRegistry,
		});
		expect(missingSandbox.valid).toBe(false);
		if (!missingSandbox.valid) {
			expect(missingSandbox.issues.some((issue) => issue.kind === "missing_sandbox_profile")).toBe(true);
		}
	});

	it("computes controller effective tools without system controls", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read", "exec_command"],
			toolsAvailableSnapshot: [],
			agentsEnabledNames: [],
			agentsRegistrySnapshot: [],
		});
		expect(effectiveToolNames(contract, "controller")).toEqual(["read", "exec_command"]);
	});

	it("computes child effective tools with system controls injected", () => {
		const contract = makeCapabilityContract({
			toolsActiveNames: ["read", "exec_command"],
			toolsAvailableSnapshot: [],
			agentsEnabledNames: [],
			agentsRegistrySnapshot: [],
		});
		const tools = effectiveToolNames(contract, "child");
		expect(tools).toContain("read");
		expect(tools).toContain("exec_command");
		expect(tools).toContain("ralph_continue");
		expect(tools).toContain("ralph_finish");
	});
});

describe("ralph contract resolver service", () => {
	it("resolves no loop for undefined session file", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const resolver = yield* RalphContractResolver;
				return yield* resolver.resolveOwnedLoop("/tmp", undefined);
			}).pipe(Effect.provide(resolverLayer)),
		);
		expect(Option.isNone(result)).toBe(true);
	});

	it("captures a full capability contract from runtime", async () => {
		const registry = {
			list: () => [{ name: "finder", description: "Find code" }],
		};
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const resolver = yield* RalphContractResolver;
				return yield* resolver.captureFromRuntime(
					registry as unknown as import("../src/agent/agent-registry.js").AgentRegistry,
					["finder"],
				);
			}).pipe(Effect.provide(resolverLayer)),
		);
		expect(result.version).toBe("1");
		expect(result.tools.activeNames).toEqual([]); // pi stub has no active tools
		expect(result.agents.enabledNames).toEqual(["finder"]);
	});

	it("validates a contract through the service", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const resolver = yield* RalphContractResolver;
				return yield* resolver.validate(makeEmptyCapabilityContract());
			}).pipe(Effect.provide(resolverLayer)),
		);
		expect(result.valid).toBe(false);
	});
});
