import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { Effect, Schema } from "effect";

import { GoalValidationError } from "./errors.js";

export const GOAL_ENTRY_TYPE = "tau:goal";

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThan(0));

export const GoalStatusSchema = Schema.Literals(["active", "paused", "budget_limited", "complete"]);
export type GoalStatus = Schema.Schema.Type<typeof GoalStatusSchema>;

export const GoalSnapshotSchema = Schema.Struct({
	objective: Schema.NonEmptyString.check(Schema.isMaxLength(4_000)),
	status: GoalStatusSchema,
	tokenBudget: Schema.NullOr(PositiveIntSchema),
	timeBudgetSeconds: Schema.NullOr(PositiveIntSchema),
	tokensUsed: NonNegativeIntSchema,
	timeUsedSeconds: NonNegativeIntSchema,
	createdAt: Schema.String,
	updatedAt: Schema.String,
	continuationSuppressed: Schema.Boolean,
	budgetLimitPromptSent: Schema.Boolean,
});
export type GoalSnapshot = Schema.Schema.Type<typeof GoalSnapshotSchema>;

export const GoalEntrySchema = Schema.Struct({
	version: Schema.Literal(2),
	snapshot: Schema.NullOr(GoalSnapshotSchema),
});
export type GoalEntry = Schema.Schema.Type<typeof GoalEntrySchema>;

const decodeGoalEntry = Schema.decodeUnknownEffect(GoalEntrySchema);

const toValidationError = (entity: string, error: unknown): GoalValidationError =>
	new GoalValidationError({
		entity,
		reason: String(error),
	});

function entryVersion(value: unknown): number | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const version = (value as { readonly version?: unknown }).version;
	return typeof version === "number" ? version : null;
}

export const decodeGoalEntryData = (
	value: unknown,
): Effect.Effect<GoalEntry, GoalValidationError, never> =>
	Effect.gen(function* () {
		const version = entryVersion(value);
		if (version !== 2) {
			return yield* Effect.fail(
				new GoalValidationError({
					entity: "goal.entry",
					reason: `unsupported goal entry version ${version === null ? "unknown" : version.toString()}`,
				}),
			);
		}
		return yield* decodeGoalEntry(value).pipe(
			Effect.mapError((error) => toValidationError("goal.entry", error)),
		);
	});

export const goalFromBranch = (
	entries: ReadonlyArray<SessionEntry>,
): Effect.Effect<GoalSnapshot | null, GoalValidationError, never> =>
	Effect.gen(function* () {
		let snapshot: GoalSnapshot | null = null;
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== GOAL_ENTRY_TYPE) {
				continue;
			}
			const decoded = yield* decodeGoalEntryData(entry.data);
			snapshot = decoded.snapshot;
		}
		return snapshot;
	});

export const makeGoalSnapshot = (
	objective: string,
	tokenBudget: number | null,
	timeBudgetSeconds: number | null,
	nowIso: string,
): GoalSnapshot => ({
	objective,
	status: "active",
	tokenBudget,
	timeBudgetSeconds,
	tokensUsed: 0,
	timeUsedSeconds: 0,
	createdAt: nowIso,
	updatedAt: nowIso,
	continuationSuppressed: false,
	budgetLimitPromptSent: false,
});
