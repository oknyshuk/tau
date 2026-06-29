import { Schema } from "effect";

export { formatDuration } from "../shared/format-duration.js";

const NonNegativeFiniteInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ToolRecord = Schema.Struct({
	name: Schema.String,
	args: Schema.optional(Schema.String), // truncated args preview
	result: Schema.optional(Schema.String), // truncated result preview
	isError: Schema.optional(Schema.Boolean),
});

export type ToolRecord = Schema.Schema.Type<typeof ToolRecord>;

export const Status = Schema.Union([
	Schema.Struct({ state: Schema.Literal("pending") }),
	Schema.Struct({
		state: Schema.Literal("running"),
		turns: Schema.optional(NonNegativeFiniteInt),
		toolCalls: Schema.optional(NonNegativeFiniteInt),
		workedMs: Schema.optional(NonNegativeFiniteInt),
		activeTurnStartedAtMs: Schema.optional(NonNegativeFiniteInt),
		tools: Schema.optional(Schema.Array(ToolRecord)),
	}),
	Schema.Struct({
		state: Schema.Literal("completed"),
		message: Schema.optional(Schema.String),
		turns: Schema.optional(NonNegativeFiniteInt),
		toolCalls: Schema.optional(NonNegativeFiniteInt),
		workedMs: Schema.optional(NonNegativeFiniteInt),
		tools: Schema.optional(Schema.Array(ToolRecord)),
	}),
	Schema.Struct({
		state: Schema.Literal("failed"),
		reason: Schema.String,
		turns: Schema.optional(NonNegativeFiniteInt),
		toolCalls: Schema.optional(NonNegativeFiniteInt),
		workedMs: Schema.optional(NonNegativeFiniteInt),
		tools: Schema.optional(Schema.Array(ToolRecord)),
	}),
	Schema.Struct({ state: Schema.Literal("shutdown") }),
]);

export type Status = Schema.Schema.Type<typeof Status>;

export const isFinal = (status: Status): boolean =>
	status.state === "completed" || status.state === "failed" || status.state === "shutdown";

