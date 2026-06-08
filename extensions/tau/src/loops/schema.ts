import { Effect, Option, Schema } from "effect";

import type { ExecutionProfile } from "../execution/schema.js";
import { ExecutionProfileSchema } from "../execution/schema.js";
import { SandboxConfigRequired as SandboxProfileSchema } from "../schemas/config.js";
import { RalphCapabilityContractSchema } from "../ralph/contract.js";
import { RalphConfigMutationListSchema } from "../ralph/config-mutation.js";
import {
	OptionalRalphPendingDecisionSchema,
	RalphLoopMetricsSchema,
	RalphPendingDecisionSchema,
} from "../ralph/state-primitives.js";
import { LoopContractValidationError, LoopOwnershipValidationError } from "./errors.js";

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const OptionalStringSchema = Schema.OptionFromNullOr(Schema.String);

type RalphPendingDecision = Schema.Schema.Type<typeof RalphPendingDecisionSchema>;

function toContractValidationError(entity: string, error: unknown): LoopContractValidationError {
	return new LoopContractValidationError({
		reason: String(error),
		entity,
	});
}

function parseJsonUnknownSync(input: string): unknown {
	try {
		return JSON.parse(input) as unknown;
	} catch (error) {
		throw toContractValidationError("loops.state.json", error);
	}
}

const parseJsonUnknown = (
	input: string,
	entity: string,
): Effect.Effect<unknown, LoopContractValidationError, never> =>
	Effect.try({
		try: () => JSON.parse(input) as unknown,
		catch: (error) => toContractValidationError(entity, error),
	});

function sanitizeLoopTaskId(value: string): string {
	return value
		.trim()
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+/, "")
		.replace(/-+$/, "");
}

const LoopTaskIdSchema = Schema.NonEmptyString.check(Schema.isMaxLength(120)).check(
	Schema.makeFilter(
		(value) => value === sanitizeLoopTaskId(value) || "expected a sanitized loop task id",
	),
);
type LoopTaskId = Schema.Schema.Type<typeof LoopTaskIdSchema>;

const LoopKindSchema = Schema.Literals(["ralph", "blocked_manual_resolution"]);
type LoopKind = Schema.Schema.Type<typeof LoopKindSchema>;

const LoopLifecycleSchema = Schema.Literals([
	"draft",
	"active",
	"paused",
	"completed",
	"archived",
]);
type LoopLifecycle = Schema.Schema.Type<typeof LoopLifecycleSchema>;

const LoopSessionRefSchema = Schema.Struct({
	sessionId: Schema.NonEmptyString,
	sessionFile: Schema.NonEmptyString,
});
export type LoopSessionRef = Schema.Schema.Type<typeof LoopSessionRefSchema>;

const OptionalSessionSchema = Schema.OptionFromNullOr(LoopSessionRefSchema);

const LoopOwnershipSchema = Schema.Struct({
	controller: OptionalSessionSchema,
	child: OptionalSessionSchema,
});
type LoopOwnership = Schema.Schema.Type<typeof LoopOwnershipSchema>;

const LoopStateSharedFields = {
	taskId: LoopTaskIdSchema,
	title: Schema.NonEmptyString,
	taskFile: Schema.NonEmptyString,
	lifecycle: LoopLifecycleSchema,
	createdAt: Schema.String,
	updatedAt: Schema.String,
	startedAt: OptionalStringSchema,
	completedAt: OptionalStringSchema,
	archivedAt: OptionalStringSchema,
	ownership: LoopOwnershipSchema,
} as const;

const RalphLoopStateDetailsSchema = Schema.Struct({
	iteration: NonNegativeIntSchema,
	maxIterations: NonNegativeIntSchema,
	itemsPerIteration: NonNegativeIntSchema,
	reflectEvery: NonNegativeIntSchema,
	reflectInstructions: Schema.String,
	lastReflectionAt: NonNegativeIntSchema,
	pendingDecision: OptionalRalphPendingDecisionSchema,
	pinnedExecutionProfile: ExecutionProfileSchema,
	sandboxProfile: Schema.OptionFromNullOr(SandboxProfileSchema),
	metrics: RalphLoopMetricsSchema,
	capabilityContract: RalphCapabilityContractSchema,
	deferredConfigMutations: RalphConfigMutationListSchema,
});
export type RalphLoopStateDetails = Schema.Schema.Type<typeof RalphLoopStateDetailsSchema>;

const ManualResolutionStateSchema = Schema.Struct({
	reasonCode: Schema.NonEmptyString,
	message: Schema.NonEmptyString,
	blockedAt: Schema.String,
	recoveryActions: Schema.Array(Schema.NonEmptyString),
	recoveryNotes: Schema.Array(Schema.String),
});
type ManualResolutionState = Schema.Schema.Type<typeof ManualResolutionStateSchema>;

const RalphLoopPersistedStateSchema = Schema.Struct({
	...LoopStateSharedFields,
	kind: Schema.Literal("ralph"),
	ralph: RalphLoopStateDetailsSchema,
});
export type RalphLoopPersistedState = Schema.Schema.Type<typeof RalphLoopPersistedStateSchema>;

const BlockedManualResolutionLoopStateSchema = Schema.Struct({
	...LoopStateSharedFields,
	kind: Schema.Literal("blocked_manual_resolution"),
	previousKind: Schema.Literal("ralph"),
	blocked: ManualResolutionStateSchema,
});
export type BlockedManualResolutionLoopState = Schema.Schema.Type<
	typeof BlockedManualResolutionLoopStateSchema
>;

const LoopPersistedStateSchema = Schema.Union([
	RalphLoopPersistedStateSchema,
	BlockedManualResolutionLoopStateSchema,
]);
export type LoopPersistedState = Schema.Schema.Type<typeof LoopPersistedStateSchema>;
export type EncodedLoopPersistedState = Schema.Codec.Encoded<typeof LoopPersistedStateSchema>;

interface LoopPersistedStateDecodeResult {
	readonly state: LoopPersistedState;
	readonly migrated: boolean;
}

const decodeLoopPersistedStateSchemaSync = Schema.decodeUnknownSync(LoopPersistedStateSchema);
const encodeLoopPersistedStateSchemaSync = Schema.encodeUnknownSync(LoopPersistedStateSchema);
const encodeLoopPersistedStateSchema = Schema.encodeUnknownEffect(LoopPersistedStateSchema);

const decodeLoopTaskIdSchemaSync = Schema.decodeUnknownSync(LoopTaskIdSchema);

export function decodeLoopTaskIdSync(value: unknown): LoopTaskId {
	try {
		return decodeLoopTaskIdSchemaSync(value);
	} catch (error) {
		throw toContractValidationError("loops.task_id", error);
	}
}

export const decodeLoopPersistedState = (	value: unknown,
): Effect.Effect<LoopPersistedState, LoopContractValidationError, never> =>
	decodeLoopPersistedStateWithMigration(value).pipe(Effect.map((result) => result.state));

export const decodeLoopPersistedStateWithMigration = (
	value: unknown,
): Effect.Effect<LoopPersistedStateDecodeResult, LoopContractValidationError, never> =>
	Effect.try({
		try: () => {
			return {
				state: decodeLoopPersistedStateSchemaSync(value),
				migrated: false,
			};
		},
		catch: (error) => toContractValidationError("loops.state", error),
	});

export const encodeLoopPersistedState = (
	state: LoopPersistedState,
): Effect.Effect<EncodedLoopPersistedState, LoopContractValidationError, never> =>
	encodeLoopPersistedStateSchema(state).pipe(
		Effect.mapError((error) => toContractValidationError("loops.state", error)),
	);

export const decodeLoopPersistedStateJsonWithMigration = (
	input: string,
): Effect.Effect<LoopPersistedStateDecodeResult, LoopContractValidationError, never> =>
	parseJsonUnknown(input, "loops.state.json").pipe(
		Effect.flatMap(decodeLoopPersistedStateWithMigration),
	);

export const encodeLoopPersistedStateJson = (
	state: LoopPersistedState,
): Effect.Effect<string, LoopContractValidationError, never> =>
	encodeLoopPersistedState(state).pipe(Effect.map((encoded) => JSON.stringify(encoded, null, 2)));

export function decodeLoopPersistedStateJsonSync(input: string): LoopPersistedState {
	try {
		return decodeLoopPersistedStateSchemaSync(parseJsonUnknownSync(input));
	} catch (error) {
		throw toContractValidationError("loops.state", error);
	}
}

export function encodeLoopPersistedStateJsonSync(state: LoopPersistedState): string {
	try {
		return JSON.stringify(encodeLoopPersistedStateSchemaSync(state), null, 2);
	} catch (error) {
		throw toContractValidationError("loops.state", error);
	}
}

export const validateLoopOwnership = (
	state: LoopPersistedState,
): Effect.Effect<void, LoopOwnershipValidationError, never> =>
	Effect.gen(function* () {
		if (Option.isSome(state.ownership.child) && Option.isNone(state.ownership.controller)) {
			return yield* Effect.fail(
				new LoopOwnershipValidationError({
					taskId: state.taskId,
					reason: "child session cannot be set when controller ownership is missing",
				}),
			);
		}

		if (
			Option.isSome(state.ownership.child) &&
			Option.isSome(state.ownership.controller) &&
			state.ownership.child.value.sessionFile === state.ownership.controller.value.sessionFile
		) {
			return yield* Effect.fail(
				new LoopOwnershipValidationError({
					taskId: state.taskId,
					reason: "controller and child sessions must be different identities",
				}),
			);
		}

		if (state.kind === "blocked_manual_resolution" && Option.isSome(state.ownership.child)) {
			return yield* Effect.fail(
				new LoopOwnershipValidationError({
					taskId: state.taskId,
					reason: "blocked manual-resolution loops cannot keep an active child session",
				}),
			);
		}

		if (
			(state.lifecycle === "completed" || state.lifecycle === "archived") &&
			Option.isSome(state.ownership.child)
		) {
			return yield* Effect.fail(
				new LoopOwnershipValidationError({
					taskId: state.taskId,
					reason: "completed or archived loops cannot keep an active child session",
				}),
			);
		}

		return yield* Effect.void;
	});

function isLoopStateKind(
	state: LoopPersistedState,
	kind: Exclude<LoopKind, "blocked_manual_resolution">,
): boolean {
	return state.kind === kind;
}

