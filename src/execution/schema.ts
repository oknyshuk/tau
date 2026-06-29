import { Schema } from "effect";

import { EXECUTION_THINKING_LEVELS, type ExecutionThinkingLevel } from "../agent/model-spec.js";
import { deepMerge } from "../shared/json.js";

const ExecutionToolsPolicySchema = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("inherit"),
	}),
	Schema.Struct({
		kind: Schema.Literal("require"),
		tools: Schema.NonEmptyArray(Schema.NonEmptyString),
	}),
	Schema.Struct({
		kind: Schema.Literal("allowlist"),
		tools: Schema.NonEmptyArray(Schema.NonEmptyString),
	}),
]);
type ExecutionToolsPolicy = Schema.Schema.Type<typeof ExecutionToolsPolicySchema>;

const ExecutionPolicySchema = Schema.Struct({
	tools: ExecutionToolsPolicySchema,
});
export type ExecutionPolicy = Schema.Schema.Type<typeof ExecutionPolicySchema>;

export const ExecutionPersistedStateSchema = Schema.Struct({
	policy: Schema.optional(ExecutionPolicySchema),
});
export type ExecutionPersistedState = Schema.Schema.Type<typeof ExecutionPersistedStateSchema>;

const ExecutionSessionStateSchema = Schema.Struct({
	policy: ExecutionPolicySchema,
});
export type ExecutionSessionState = Schema.Schema.Type<typeof ExecutionSessionStateSchema>;

export const ExecutionProfileSchema = Schema.Struct({
	model: Schema.NonEmptyString,
	thinking: Schema.Literals([...EXECUTION_THINKING_LEVELS]),
	policy: ExecutionPolicySchema,
});
export type ExecutionProfile = Schema.Schema.Type<typeof ExecutionProfileSchema>;

const decodeExecutionSessionStateSync = Schema.decodeUnknownSync(ExecutionSessionStateSchema);

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
	tools: {
		kind: "inherit",
	},
};

export function normalizeExecutionState(
	state: ExecutionPersistedState | undefined,
): ExecutionSessionState {
	const next: ExecutionSessionState = {
		policy: state?.policy ?? DEFAULT_EXECUTION_POLICY,
	};
	return decodeExecutionSessionStateSync(next);
}

export function mergeExecutionSessionState(
	base: ExecutionSessionState,
	patch: Partial<ExecutionPersistedState>,
): ExecutionSessionState {
	const merged = deepMerge(base, patch);
	return normalizeExecutionState(merged);
}

export function makeExecutionProfile(input: {
	readonly model: string;
	readonly thinking: ExecutionThinkingLevel;
	readonly policy: ExecutionPolicy;
}): ExecutionProfile {
	return {
		model: input.model,
		thinking: input.thinking,
		policy: input.policy,
	};
}
