import {
	createAgentSession,
	type AgentSession,
	SessionManager,
	SettingsManager,
	AuthStorage,
	ModelRegistry,
	DefaultResourceLoader,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { Effect } from "effect";

import type { ApprovalBroker } from "../approval-broker.js";
import { setWorkerApprovalBroker } from "../approval-broker.js";
import { isExecutionThinkingLevel } from "../model-spec.js";
import { AgentError } from "../services.js";
import { applyAgentToolAllowlist } from "../tool-allowlist.js";
import type { AgentDefinition, ModelSpec } from "../types.js";
import type { ResolvedSandboxConfig } from "../../sandbox/config.js";
import type {
	ExecutionPolicy,
	ExecutionProfile,
	ExecutionSessionState,
} from "../../execution/schema.js";
import { makeExecutionProfile } from "../../execution/schema.js";
import { readModelId } from "../../prompt/profile.js";
import { TAU_PERSISTED_STATE_TYPE, loadPersistedState } from "../../shared/state.js";
import { withWorkerSandboxOverride } from "../worker-sandbox.js";
import { resolveModelPattern } from "./model-runner.js";

export interface SessionInfra {
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly settingsManager: SettingsManager;
	readonly resourceLoader: DefaultResourceLoader;
	readonly customTools: ToolDefinition[];
	readonly sandboxConfig: ResolvedSandboxConfig;
	readonly appendPrompts: string[];
	readonly cwd: string;
	readonly approvalBroker: ApprovalBroker | undefined;
	readonly definition: AgentDefinition;
	readonly resultSchema: unknown | undefined;
	readonly executionPolicy: ExecutionPolicy;
	/**
	 * Optional override for the parent model used to resolve `model: inherit`
	 * specs in agent definitions. When set (via `tau.subagentDefaults.model` in
	 * settings.json), all bundled subagents that inherit pick up this model
	 * instead of the orchestrator's model.
	 */
	readonly subagentInheritModel: Model<Api> | undefined;
	/**
	 * Optional override for the thinking level used to resolve `thinking: inherit`
	 * in agent definitions (paired with `subagentInheritModel`).
	 */
	readonly subagentInheritThinking: ThinkingLevel | undefined;
}

export function syncExecutionProfileToSession(
	profile: ExecutionProfile,
	session: AgentSession,
): ExecutionProfile {
	const modelId = readModelId(session.model);
	if (modelId === undefined) {
		return profile;
	}

	const thinking = isExecutionThinkingLevel(session.thinkingLevel)
		? session.thinkingLevel
		: profile.thinking;

	return makeExecutionProfile({
		model: modelId,
		thinking,
		policy: profile.policy,
	});
}

export function createSessionForModel(
	infra: SessionInfra,
	spec: ModelSpec,
	parentModel: Model<Api> | undefined,
	modelRegistry: ModelRegistry,
): Effect.Effect<AgentSession, AgentError> {
	return Effect.gen(function* () {
		const inheritBaseModel = infra.subagentInheritModel ?? parentModel;
		const resolvedModel =
			spec.model === "inherit"
				? inheritBaseModel
				: resolveModelPattern(spec.model, modelRegistry.getAll());

		if (resolvedModel === undefined) {
			return yield* Effect.fail(
				new AgentError({
					message:
						spec.model === "inherit"
							? "Agent model inherits from parent, but neither tau.subagentDefaults.model nor an active parent session model is available"
							: `Agent model "${spec.model}" is not available`,
				}),
			);
		}

		const sessionOpts = {
			cwd: infra.cwd,
			authStorage: infra.authStorage,
			modelRegistry,
			sessionManager: SessionManager.inMemory(infra.cwd),
			settingsManager: infra.settingsManager,
			resourceLoader: infra.resourceLoader,
			customTools: infra.customTools,
			model: resolvedModel,
		};
		const { session } = yield* Effect.promise(() => createAgentSession(sessionOpts));

		yield* applyAgentToolAllowlist(
			session,
			infra.definition,
			infra.resultSchema,
			infra.executionPolicy,
		);

		const thinkingLevel = spec.thinking;
		if (thinkingLevel === "inherit") {
			if (infra.subagentInheritThinking !== undefined) {
				session.setThinkingLevel(infra.subagentInheritThinking);
			}
		} else if (thinkingLevel) {
			session.setThinkingLevel(thinkingLevel as ThinkingLevel);
		}

		return session;
	});
}

export function wireSession(
	session: AgentSession,
	sandboxConfig: ResolvedSandboxConfig,
	approvalBroker: ApprovalBroker | undefined,
	executionState: ExecutionSessionState,
): void {
	const persisted = loadPersistedState({
		sessionManager: session.sessionManager,
	});
	const next = withWorkerSandboxOverride(persisted, sandboxConfig, executionState);
	session.sessionManager.appendCustomEntry(TAU_PERSISTED_STATE_TYPE, next);
	setWorkerApprovalBroker(session.sessionId, approvalBroker);
}
