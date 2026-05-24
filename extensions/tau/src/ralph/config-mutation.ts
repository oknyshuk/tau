import { Schema } from "effect";

import { ExecutionProfileSchema } from "../execution/schema.js";
import { SandboxConfigRequired as SandboxProfileSchema } from "../schemas/config.js";

const RalphMaxIterationsMutationSchema = Schema.Struct({
	kind: Schema.Literal("maxIterations"),
	value: Schema.Number,
});

const RalphItemsPerIterationMutationSchema = Schema.Struct({
	kind: Schema.Literal("itemsPerIteration"),
	value: Schema.Number,
});

const RalphReflectEveryMutationSchema = Schema.Struct({
	kind: Schema.Literal("reflectEvery"),
	value: Schema.Number,
});

const RalphReflectInstructionsMutationSchema = Schema.Struct({
	kind: Schema.Literal("reflectInstructions"),
	value: Schema.String,
});

const RalphCapabilityContractToolsMutationSchema = Schema.Struct({
	kind: Schema.Literal("capabilityContractTools"),
	activeNames: Schema.Array(Schema.NonEmptyString),
});

const RalphCapabilityContractAgentsMutationSchema = Schema.Struct({
	kind: Schema.Literal("capabilityContractAgents"),
	enabledNames: Schema.Array(Schema.NonEmptyString),
});

const RalphExecutionProfileMutationSchema = Schema.Struct({
	kind: Schema.Literal("executionProfile"),
	profile: ExecutionProfileSchema,
});

const RalphSandboxProfileMutationSchema = Schema.Struct({
	kind: Schema.Literal("sandboxProfile"),
	profile: SandboxProfileSchema,
});

const RalphConfigMutationSchema = Schema.Union([
	RalphMaxIterationsMutationSchema,
	RalphItemsPerIterationMutationSchema,
	RalphReflectEveryMutationSchema,
	RalphReflectInstructionsMutationSchema,
	RalphCapabilityContractToolsMutationSchema,
	RalphCapabilityContractAgentsMutationSchema,
	RalphExecutionProfileMutationSchema,
	RalphSandboxProfileMutationSchema,
]);

export type RalphConfigMutation = Schema.Schema.Type<typeof RalphConfigMutationSchema>;

export const RalphConfigMutationListSchema = Schema.Array(RalphConfigMutationSchema);
