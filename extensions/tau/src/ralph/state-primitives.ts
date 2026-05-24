import { Schema } from "effect";

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const FiniteNumber = Schema.Number.check(Schema.isFinite());
const OptionalStringSchema = Schema.OptionFromNullOr(Schema.String);

/**
 * Shared ralph state primitives reused by the legacy flat ralph schema
 * (src/ralph/schema.ts) and the canonical wrapped loop schema
 * (src/loops/schema.ts).
 *
 * These two schema universes target the same data; the migration to a single
 * canonical shape is tracked under the tau-quin "unified loop engine" epic.
 * Until that completes, this module deduplicates the underlying primitives so
 * a change to (for example) a ralph "continue"/"finish" decision payload only
 * has to be made in one place.
 */

const RalphContinueDecisionSchema = Schema.Struct({
	kind: Schema.Literal("continue"),
	requestedAt: Schema.String,
});

const RalphFinishDecisionSchema = Schema.Struct({
	kind: Schema.Literal("finish"),
	requestedAt: Schema.String,
	message: Schema.NonEmptyString,
});

export const RalphPendingDecisionSchema = Schema.Union([
	RalphContinueDecisionSchema,
	RalphFinishDecisionSchema,
]);
export type RalphPendingDecision = Schema.Schema.Type<typeof RalphPendingDecisionSchema>;

export const OptionalRalphPendingDecisionSchema = Schema.OptionFromNullOr(
	RalphPendingDecisionSchema,
);

export const RalphLoopMetricsSchema = Schema.Struct({
	totalTokens: NonNegativeIntSchema,
	totalCostUsd: FiniteNumber.check(Schema.isGreaterThanOrEqualTo(0)),
	activeDurationMs: NonNegativeIntSchema,
	activeStartedAt: OptionalStringSchema,
});
export type RalphLoopMetrics = Schema.Schema.Type<typeof RalphLoopMetricsSchema>;
