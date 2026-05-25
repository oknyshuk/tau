import { Schema } from "effect";

export class AutoresearchValidationError extends Schema.TaggedErrorClass<AutoresearchValidationError>()(
	"AutoresearchValidationError",
	{
		reason: Schema.String,
	},
) {}
