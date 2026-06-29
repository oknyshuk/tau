import { Schema } from "effect";

export class GoalValidationError extends Schema.TaggedErrorClass<GoalValidationError>()(
	"GoalValidationError",
	{
		reason: Schema.String,
		entity: Schema.String,
	},
) {}

export class GoalConflictError extends Schema.TaggedErrorClass<GoalConflictError>()(
	"GoalConflictError",
	{
		reason: Schema.String,
	},
) {}

export type GoalError = GoalValidationError | GoalConflictError;
