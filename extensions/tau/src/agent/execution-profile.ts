import { Effect } from "effect";

import {
	type ExecutionPolicy,
	type ExecutionProfile,
	type ExecutionSessionState,
	makeExecutionProfile,
} from "../execution/schema.js";
import {
	type ExecutionThinkingLevel,
	isFullyQualifiedModelId,
	isExecutionThinkingLevel,
} from "./model-spec.js";
import { AgentError } from "./services.js";
import type { AgentDefinition, ModelSpec } from "./types.js";

type ResolvedAgentExecution = {
	readonly definition: AgentDefinition;
	readonly executionState: ExecutionSessionState;
	readonly executionProfile: ExecutionProfile;
};

type ResolveAgentExecutionInput = {
	readonly definition: AgentDefinition;
	readonly cwd: string;
	readonly parentExecutionState: ExecutionSessionState;
	readonly parentExecutionProfile: ExecutionProfile;
};

function resolveExecutionPolicy(
	definition: AgentDefinition,
	parentExecutionState: ExecutionSessionState,
): Effect.Effect<ExecutionPolicy, AgentError> {
	if (definition.tools === undefined) {
		return Effect.succeed(parentExecutionState.policy);
	}

	if (definition.tools.length === 0) {
		return Effect.fail(
			new AgentError({
				message: `Agent "${definition.name}" has an empty tool allowlist`,
			}),
		);
	}

	const tools = [...definition.tools];
	const [firstTool, ...restTools] = tools;
	if (firstTool === undefined) {
		return Effect.fail(
			new AgentError({
				message: `Agent "${definition.name}" has an empty tool allowlist`,
			}),
		);
	}

	return Effect.succeed({
		tools: {
			kind: "allowlist",
			tools: [firstTool, ...restTools],
		},
	});
}

function resolveConcreteModelSpec(
	definition: AgentDefinition,
	spec: ModelSpec,
	index: number,
	parentExecutionProfile: ExecutionProfile,
): Effect.Effect<{ readonly model: string; readonly thinking: ExecutionThinkingLevel }, AgentError> {
	const model =
		spec.model === "inherit"
			? parentExecutionProfile.model
			: spec.model;

	if (!isFullyQualifiedModelId(model)) {
		return Effect.fail(
			new AgentError({
				message:
					`Agent "${definition.name}" model at index ${index} resolved to invalid model id: ${model}. ` +
					"Expected provider/model-id.",
			}),
		);
	}

	const thinking =
		spec.thinking === undefined || spec.thinking === "inherit"
			? parentExecutionProfile.thinking
			: spec.thinking;

	if (!isExecutionThinkingLevel(thinking)) {
		return Effect.fail(
			new AgentError({
				message:
					`Agent "${definition.name}" thinking at index ${index} resolved to invalid value: ${thinking}. ` +
					"Expected one of off|minimal|low|medium|high|xhigh.",
			}),
		);
	}

	return Effect.succeed({
		model,
		thinking,
	});
}

function resolveConcreteModelSpecs(
	definition: AgentDefinition,
	parentExecutionProfile: ExecutionProfile,
): Effect.Effect<readonly { readonly model: string; readonly thinking: ExecutionThinkingLevel }[], AgentError> {
	if (definition.models.length === 0) {
		return Effect.fail(
			new AgentError({
				message: `Agent "${definition.name}" has no models configured`,
			}),
		);
	}

	return Effect.forEach(definition.models, (spec, index) =>
		resolveConcreteModelSpec(
			definition,
			spec,
			index,
			parentExecutionProfile,
		),
	);
}

function resolveDefaultAgentExecution(
	input: ResolveAgentExecutionInput,
): Effect.Effect<ResolvedAgentExecution, AgentError> {
	return Effect.gen(function* () {
		const resolvedModels = yield* resolveConcreteModelSpecs(
			input.definition,
			input.parentExecutionProfile,
		);
		const firstModel = resolvedModels[0];
		if (firstModel === undefined) {
			return yield* Effect.fail(
				new AgentError({
					message: `Agent "${input.definition.name}" has no concrete execution model`,
				}),
			);
		}

		const executionPolicy = yield* resolveExecutionPolicy(
			input.definition,
			input.parentExecutionState,
		);

		const resolvedDefinition: AgentDefinition = {
			...input.definition,
			models: resolvedModels,
		};

		const executionProfile = makeExecutionProfile({
			model: firstModel.model,
			thinking: firstModel.thinking,
			policy: executionPolicy,
		});

		const executionState: ExecutionSessionState = {
			policy: executionPolicy,
		};

		return {
			definition: resolvedDefinition,
			executionProfile,
			executionState,
		};
	});
}

export function resolveAgentExecutionAtSpawn(
	input: ResolveAgentExecutionInput,
): Effect.Effect<ResolvedAgentExecution, AgentError> {
	return resolveDefaultAgentExecution(input);
}
