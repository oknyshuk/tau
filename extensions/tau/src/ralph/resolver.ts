import { Effect, Layer, Option, Context } from "effect";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRegistry } from "../agent/agent-registry.js";
import type { ExecutionProfile } from "../execution/schema.js";
import { ExecutionRuntime } from "../services/execution-runtime.js";
import { PiAPI } from "../effect/pi.js";
import { LoopRepo } from "../loops/repo.js";
import type { RalphLoopPersistedState } from "../loops/schema.js";
import type { ResolvedSandboxConfig } from "../sandbox/config.js";
import { parseProviderModel } from "../shared/model-id.js";
import { RalphContractValidationError } from "../ralph/errors.js";
import {
	ensureRalphSystemControlTools,
	isRalphSystemControlTool,
	makeCapabilityContract,
	type RalphCapabilityContract,
	type ToolMetadataFingerprint,
	type AgentMetadataFingerprint,
} from "../ralph/contract.js";

// ─── Pure types ─────────────────────────────────────────────────────────────

type ContractCaptureInput = {
	readonly activeTools: ReadonlyArray<string>;
	readonly allTools: ReadonlyArray<{ readonly name: string; readonly description: string }>;
	readonly agentRegistry: AgentRegistry;
	readonly enabledAgents: ReadonlyArray<string>;
	readonly useApplyPatchForMutationTools?: boolean;
};

type ContractApplyTarget = "controller" | "child";

type ContractValidationIssue =
	| { readonly kind: "missing_control_tools"; readonly missing: ReadonlyArray<string> }
	| { readonly kind: "missing_pinned_tools"; readonly missing: ReadonlyArray<string> }
	| { readonly kind: "missing_enabled_agents"; readonly missing: ReadonlyArray<string> }
	| { readonly kind: "missing_ralph_control_tools"; readonly missing: ReadonlyArray<string> }
	| { readonly kind: "empty_tool_contract"; readonly message: string }
	| { readonly kind: "empty_agent_contract"; readonly message: string }
	| { readonly kind: "invalid_version"; readonly expected: string; readonly actual: string }
	| { readonly kind: "invalid_model_id"; readonly model: string }
	| { readonly kind: "missing_model"; readonly model: string }
	| { readonly kind: "missing_model_auth"; readonly model: string }
	| { readonly kind: "unsupported_thinking"; readonly model: string; readonly thinking: string }
	| { readonly kind: "missing_sandbox_profile"; readonly message: string };

type ContractValidationResult =
	| { readonly valid: true }
	| { readonly valid: false; readonly issues: ReadonlyArray<ContractValidationIssue> };

// ─── Pure capture helpers ───────────────────────────────────────────────────

/**
 * Capture Ralph's initial tool contract from current Pi runtime state.
 * System-managed Ralph control tools are excluded from activeNames
 * but included in the available snapshot for display.
 */
export function captureToolContract(
	input: Pick<ContractCaptureInput, "activeTools" | "allTools" | "useApplyPatchForMutationTools">,
): RalphCapabilityContract["tools"] {
	const availableToolNames = new Set(input.allTools.map((tool) => tool.name));
	const userActiveNames = input.activeTools
		.filter(
			(name) =>
				availableToolNames.has(name) &&
				!isRalphSystemControlTool(name),
		)
		.filter((name, index, names) => names.indexOf(name) === index);
	const availableSnapshot: ToolMetadataFingerprint[] = input.allTools.map((tool) => ({
		name: tool.name,
		label: tool.name,
		description: tool.description,
	}));
	return {
		activeNames: [...userActiveNames],
		availableSnapshot,
	};
}

/**
 * Capture Ralph's initial agent contract from current runtime state.
 * The registry snapshot preserves every configurable agent.
 */
export function captureAgentContract(
	input: Pick<ContractCaptureInput, "agentRegistry" | "enabledAgents">,
): RalphCapabilityContract["agents"] {
	const registrySnapshot: AgentMetadataFingerprint[] = input.agentRegistry.list().map((agent) => ({
		name: agent.name,
		description: agent.description,
	}));
	const registryNames = new Set(registrySnapshot.map((agent) => agent.name));
	return {
		enabledNames: input.enabledAgents
			.filter((name) => registryNames.has(name))
			.filter((name, index, names) => names.indexOf(name) === index),
		registrySnapshot,
	};
}

/**
 * Build a full capability contract from current runtime state.
 */
export function captureCapabilityContract(input: ContractCaptureInput): RalphCapabilityContract {
	return makeCapabilityContract({
		toolsActiveNames: captureToolContract(input).activeNames,
		toolsAvailableSnapshot: captureToolContract(input).availableSnapshot,
		agentsEnabledNames: captureAgentContract(input).enabledNames,
		agentsRegistrySnapshot: captureAgentContract(input).registrySnapshot,
	});
}

// ─── Pure validation helpers ────────────────────────────────────────────────

/**
 * Validate that no system-managed control tools appear in the user-configurable
 * activeNames list. This is a hygiene check, not a fatal error.
 */
export function checkControlToolsExcluded(
	contract: RalphCapabilityContract,
): ReadonlyArray<string> {
	return contract.tools.activeNames.filter((name) => isRalphSystemControlTool(name));
}

/**
 * Validate a capability contract. Returns issues, not effects, so callers
 * can decide whether to fail fast, warn, or auto-correct.
 *
 * Note: ralph_continue and ralph_finish are intentionally excluded from
 * tools.activeNames (they are system-managed). The validation does NOT
 * require them to be present in activeNames.
 */
export function validateCapabilityContract(
	contract: RalphCapabilityContract,
): ContractValidationResult {
	const issues: ContractValidationIssue[] = [];

	if (contract.version !== "1") {
		issues.push({
			kind: "invalid_version",
			expected: "1",
			actual: contract.version,
		});
	}

	// Note: empty activeNames is allowed (loop may intentionally have no tools)
	// but we warn if the available snapshot is also empty, which suggests
	// capture happened before tools were initialized.
	if (contract.tools.availableSnapshot.length === 0) {
		issues.push({
			kind: "empty_tool_contract",
			message: "Tool contract has no available-tool snapshot; was capture called before Pi tool initialization?",
		});
	}

	if (contract.agents.registrySnapshot.length === 0) {
		issues.push({
			kind: "empty_agent_contract",
			message: "Agent contract has no registry snapshot; was capture called before agent registry load?",
		});
	}

	// Internal consistency: every active tool name must have a fingerprint in the snapshot.
	const availableToolNames = new Set(contract.tools.availableSnapshot.map((t) => t.name));
	const missingPinnedTools = contract.tools.activeNames.filter(
		(name) => !availableToolNames.has(name),
	);
	if (missingPinnedTools.length > 0) {
		issues.push({
			kind: "missing_pinned_tools",
			missing: missingPinnedTools,
		});
	}

	// Internal consistency: every enabled agent must have a fingerprint in the registry snapshot.
	const availableAgentNames = new Set(contract.agents.registrySnapshot.map((a) => a.name));
	const missingEnabledAgents = contract.agents.enabledNames.filter(
		(name) => !availableAgentNames.has(name),
	);
	if (missingEnabledAgents.length > 0) {
		issues.push({
			kind: "missing_enabled_agents",
			missing: missingEnabledAgents,
		});
	}

	// System-managed control tools should be present in the available snapshot
	// so the applier can verify they exist before injecting them.
	const missingControlTools = ["ralph_continue", "ralph_finish"].filter(
		(name) => !availableToolNames.has(name),
	);
	if (missingControlTools.length > 0) {
		issues.push({
			kind: "missing_ralph_control_tools",
			missing: missingControlTools,
		});
	}

	if (issues.length > 0) {
		return { valid: false, issues };
	}

	return { valid: true };
}

type ExecutionModel = {
	readonly id: string;
	readonly provider: string;
	readonly reasoning: boolean;
};

type ExecutionModelRegistry = {
	readonly find: (provider: string, modelId: string) => ExecutionModel | undefined;
	readonly getApiKey: (model: ExecutionModel) => Promise<string | undefined>;
};

export async function validateExecutionContract(input: {
	readonly profile: ExecutionProfile;
	readonly sandboxProfile: ResolvedSandboxConfig | undefined;
	readonly modelRegistry: ExecutionModelRegistry;
}): Promise<ContractValidationResult> {
	const issues: ContractValidationIssue[] = [];
	const parsed = parseProviderModel(input.profile.model);
	if (parsed === undefined) {
		issues.push({ kind: "invalid_model_id", model: input.profile.model });
	} else {
		const model = input.modelRegistry.find(parsed.provider, parsed.modelId);
		if (model === undefined) {
			issues.push({ kind: "missing_model", model: input.profile.model });
		} else {
			const apiKey = await input.modelRegistry.getApiKey(model);
			if (apiKey === undefined) {
				issues.push({ kind: "missing_model_auth", model: input.profile.model });
			}

			if (input.profile.thinking !== "off" && !model.reasoning) {
				issues.push({
					kind: "unsupported_thinking",
					model: input.profile.model,
					thinking: input.profile.thinking,
				});
			}
		}
	}

	if (input.sandboxProfile === undefined) {
		issues.push({
			kind: "missing_sandbox_profile",
			message: "Ralph execution contract has no pinned sandbox profile",
		});
	}

	if (issues.length > 0) {
		return { valid: false, issues };
	}

	return { valid: true };
}

// ─── Pure contract application helpers ──────────────────────────────────────

/**
 * Compute the effective tool names for a given contract and session role.
 * - Controller sessions get pinned user tools only.
 * - Child sessions get pinned user tools plus system Ralph control tools.
 */
export function effectiveToolNames(
	contract: RalphCapabilityContract,
	target: ContractApplyTarget,
): ReadonlyArray<string> {
	if (target === "controller") {
		return contract.tools.activeNames;
	}
	return ensureRalphSystemControlTools(contract.tools.activeNames);
}

// ─── Effect service: resolver / applier ─────────────────────────────────────

export interface RalphContractResolver {
	/**
	 * Resolve the Ralph loop that owns a session by reading canonical loop
	 * state from disk. Does NOT rely on process-global currentLoopRef.
	 */
	readonly resolveOwnedLoop: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<Option.Option<RalphLoopPersistedState>, RalphContractValidationError, never>;

	/**
	 * Capture a capability contract from the current Pi runtime.
	 */
	readonly captureFromRuntime: (
		agentRegistry: AgentRegistry,
		enabledAgents: ReadonlyArray<string>,
	) => Effect.Effect<RalphCapabilityContract, never, never>;

	/**
	 * Validate a contract and return a structured result.
	 */
	readonly validate: (
		contract: RalphCapabilityContract,
	) => Effect.Effect<ContractValidationResult, never, never>;

	/**
	 * Validate concrete model/thinking/sandbox availability for the pinned contract.
	 */
	readonly validateExecution: (input: {
		readonly profile: ExecutionProfile;
		readonly sandboxProfile: ResolvedSandboxConfig | undefined;
		readonly modelRegistry: ExecutionModelRegistry;
	}) => Effect.Effect<ContractValidationResult, never, never>;

	/**
	 * Apply a capability contract to the current Pi session.
	 * Controller sessions get pinned user tools; child sessions get pinned
	 * user tools plus system Ralph control tools.
	 */
	readonly applyToSession: (
		contract: RalphCapabilityContract,
		target: ContractApplyTarget,
	) => Effect.Effect<void, never, never>;

	/**
	 * Apply the pinned execution profile from loop state to the current session.
	 */
	readonly applyExecutionProfile: (
		profile: ExecutionProfile,
		profileContext: Pick<ExtensionContext, "model" | "modelRegistry" | "ui">,
	) => Effect.Effect<void, never, never>;
}

export const RalphContractResolver = Context.Service<RalphContractResolver>("RalphContractResolver");

export const RalphContractResolverLive = Layer.effect(
	RalphContractResolver,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const loopRepo = yield* LoopRepo;
		const executionRuntime = yield* ExecutionRuntime;

		const resolveOwnedLoop: RalphContractResolver["resolveOwnedLoop"] = (cwd, sessionFile) =>
			Effect.gen(function* () {
				if (sessionFile === undefined) {
					return Option.none<RalphLoopPersistedState>();
				}

				const states = yield* loopRepo.listStates(cwd, false).pipe(
					Effect.mapError(
						(error) =>
							new RalphContractValidationError({
								entity: "ralph.contract_resolver",
								reason: String(error),
							}),
					),
				);
				const candidates = states.filter(
					(state): state is RalphLoopPersistedState =>
						state.kind === "ralph" &&
						state.lifecycle !== "completed" &&
						state.lifecycle !== "archived",
				);

				const matches = candidates.filter((state) => {
					const controllerMatch = Option.match(state.ownership.controller, {
						onNone: () => false,
						onSome: (c) => c.sessionFile === sessionFile,
					});
					const childMatch = Option.match(state.ownership.child, {
						onNone: () => false,
						onSome: (c) => c.sessionFile === sessionFile,
					});
					return controllerMatch || childMatch;
				});

				if (matches.length === 0) {
					return Option.none<RalphLoopPersistedState>();
				}

				if (matches.length > 1) {
					return yield* Effect.fail(
						new RalphContractValidationError({
							entity: "ralph.contract_resolver",
							reason: `session ${sessionFile} matches multiple loops: ${matches.map((s) => s.taskId).join(", ")}`,
						}),
					);
				}

				const match = matches[0];
				return match === undefined
					? Option.none<RalphLoopPersistedState>()
					: Option.some(match);
			});

		const captureFromRuntime: RalphContractResolver["captureFromRuntime"] = (
			agentRegistry,
			enabledAgents,
		) =>
			Effect.sync(() =>
				captureCapabilityContract({
					activeTools: pi.getActiveTools(),
					allTools: pi.getAllTools(),
					agentRegistry,
					enabledAgents,
				}),
			);

		const validate: RalphContractResolver["validate"] = (contract) =>
			Effect.sync(() => validateCapabilityContract(contract));

		const validateExecution: RalphContractResolver["validateExecution"] = (input) =>
			Effect.promise(() => validateExecutionContract(input));

		const applyToSession: RalphContractResolver["applyToSession"] = (contract, target) =>
			Effect.sync(() => {
				const tools = effectiveToolNames(contract, target);
				pi.setActiveTools([...tools]);
			});

		const applyExecutionProfile: RalphContractResolver["applyExecutionProfile"] = (
			profile,
			profileContext,
		) =>
			executionRuntime
				.applyExecutionProfile(profile, profileContext, {
					notifyOnSuccess: false,
					persist: false,
					ephemeral: true,
				})
				.pipe(Effect.map(() => undefined));

		return RalphContractResolver.of({
			resolveOwnedLoop,
			captureFromRuntime,
			validate,
			validateExecution,
			applyToSession,
			applyExecutionProfile,
		});
	}),
);
