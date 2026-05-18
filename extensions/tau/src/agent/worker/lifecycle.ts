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
		const resolvedModel =
			spec.model === "inherit"
				? parentModel
				: resolveModelPattern(spec.model, modelRegistry.getAll());

		if (resolvedModel === undefined) {
			return yield* Effect.fail(
				new AgentError({
					message:
						spec.model === "inherit"
							? "Agent model inherits from parent, but the parent session has no active model"
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
		if (thinkingLevel && thinkingLevel !== "inherit") {
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
