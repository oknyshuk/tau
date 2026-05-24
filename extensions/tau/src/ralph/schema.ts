import { Effect, Option, Schema } from "effect";

import { ExecutionProfileSchema } from "../execution/schema.js";
import { SandboxConfigRequired as SandboxProfileSchema } from "../schemas/config.js";
import { RalphCapabilityContractSchema } from "./contract.js";
import { RalphConfigMutationListSchema } from "./config-mutation.js";
import { RalphContractValidationError } from "./errors.js";
import {
	OptionalRalphPendingDecisionSchema,
	RalphLoopMetricsSchema,
	RalphPendingDecisionSchema,
	type RalphLoopMetrics,
	type RalphPendingDecision,
} from "./state-primitives.js";

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const OptionalStringSchema = Schema.OptionFromNullOr(Schema.String);

export type { RalphPendingDecision, RalphLoopMetrics };

export function sanitizeLoopName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/_+/g, "_");
}

function toContractValidationError(entity: string, error: unknown): RalphContractValidationError {
	return new RalphContractValidationError({
		reason: String(error),
		entity,
	});
}

const LoopStatusSchema = Schema.Literals(["active", "paused", "completed"]);
export type LoopStatus = Schema.Schema.Type<typeof LoopStatusSchema>;

export const LoopNameSchema = Schema.NonEmptyString.check(Schema.isMaxLength(120)).check(
	Schema.makeFilter(
		(value) => value === sanitizeLoopName(value) || "expected a sanitized ralph loop name",
	),
);
type LoopName = Schema.Schema.Type<typeof LoopNameSchema>;

const LoopStateSharedFields = {
	name: LoopNameSchema,
	taskFile: Schema.NonEmptyString,
	iteration: Schema.mutableKey(NonNegativeIntSchema),
	maxIterations: NonNegativeIntSchema,
	itemsPerIteration: NonNegativeIntSchema,
	reflectEvery: NonNegativeIntSchema,
	reflectInstructions: Schema.String,
	status: Schema.mutableKey(LoopStatusSchema),
	startedAt: Schema.String,
	completedAt: Schema.mutableKey(OptionalStringSchema),
	lastReflectionAt: Schema.mutableKey(NonNegativeIntSchema),
	controllerSessionFile: Schema.mutableKey(OptionalStringSchema),
	activeIterationSessionFile: Schema.mutableKey(OptionalStringSchema),
	pendingDecision: Schema.mutableKey(OptionalRalphPendingDecisionSchema),
} as const;

const LoopStateSchema = Schema.Struct({
	...LoopStateSharedFields,
	executionProfile: Schema.mutableKey(ExecutionProfileSchema),
	sandboxProfile: Schema.mutableKey(Schema.OptionFromNullOr(SandboxProfileSchema)),
	metrics: Schema.mutableKey(RalphLoopMetricsSchema),
	capabilityContract: Schema.mutableKey(RalphCapabilityContractSchema),
	deferredConfigMutations: Schema.mutableKey(RalphConfigMutationListSchema),
});
export type LoopState = Schema.Schema.Type<typeof LoopStateSchema>;
export type EncodedLoopState = Schema.Codec.Encoded<typeof LoopStateSchema>;

const StartLoopInputSchema = Schema.Struct({
	name: LoopNameSchema,
	maxIterations: NonNegativeIntSchema,
	itemsPerIteration: NonNegativeIntSchema,
	reflectEvery: NonNegativeIntSchema,
	reflectInstructions: Schema.String,
});
type StartLoopInput = Schema.Schema.Type<typeof StartLoopInputSchema>;

const ResumeLoopInputSchema = Schema.Struct({
	name: LoopNameSchema,
});
type ResumeLoopInput = Schema.Schema.Type<typeof ResumeLoopInputSchema>;

const ArchiveLoopInputSchema = Schema.Struct({
	name: LoopNameSchema,
});
type ArchiveLoopInput = Schema.Schema.Type<typeof ArchiveLoopInputSchema>;

const LoopSummarySchema = Schema.Struct({
	name: LoopNameSchema,
	status: LoopStatusSchema,
	iteration: NonNegativeIntSchema,
	maxIterations: NonNegativeIntSchema,
	taskFile: Schema.NonEmptyString,
});
type LoopSummary = Schema.Schema.Type<typeof LoopSummarySchema>;

const encodeLoopStateSchema = Schema.encodeUnknownEffect(LoopStateSchema);
const decodeLoopStateSchemaSync = Schema.decodeUnknownSync(LoopStateSchema);

const parseJsonUnknown = (
	input: string,
): Effect.Effect<unknown, RalphContractValidationError, never> =>
	Effect.try({
		try: () => JSON.parse(input) as unknown,
		catch: (error) => toContractValidationError("ralph.loop_state.json", error),
	});

export function emptyRalphLoopMetrics(): RalphLoopMetrics {
	return {
		totalTokens: 0,
		totalCostUsd: 0,
		activeDurationMs: 0,
		activeStartedAt: Option.none(),
	};
}

function decodeLoopStateCompatSync(value: unknown): LoopState {
	try {
		return decodeLoopStateSchemaSync(value);
	} catch (canonicalError) {
		throw toContractValidationError("ralph.loop_state", canonicalError);
	}
}

export const decodeLoopState = (
	value: unknown,
): Effect.Effect<LoopState, RalphContractValidationError, never> =>
	Effect.try({
		try: () => decodeLoopStateCompatSync(value),
		catch: (error) =>
			error instanceof RalphContractValidationError
				? error
				: toContractValidationError("ralph.loop_state", error),
	});

export const encodeLoopState = (
	state: LoopState,
): Effect.Effect<EncodedLoopState, RalphContractValidationError, never> =>
	encodeLoopStateSchema(state).pipe(
		Effect.mapError((error) => toContractValidationError("ralph.loop_state", error)),
	);

export const decodeLoopStateJson = (
	input: string,
): Effect.Effect<LoopState, RalphContractValidationError, never> =>
	parseJsonUnknown(input).pipe(Effect.flatMap(decodeLoopState));

export const encodeLoopStateJson = (
	state: LoopState,
): Effect.Effect<string, RalphContractValidationError, never> =>
	encodeLoopState(state).pipe(Effect.map((encoded) => JSON.stringify(encoded, null, 2)));

export function decodeLoopStateSync(value: unknown): LoopState {
	return decodeLoopStateCompatSync(value);
}
