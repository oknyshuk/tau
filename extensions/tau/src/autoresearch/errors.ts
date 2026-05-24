import { Schema } from "effect";

export class AutoresearchContractValidationError extends Schema.TaggedErrorClass<AutoresearchContractValidationError>()(
	"AutoresearchContractValidationError",
	{
		reason: Schema.String,
		entity: Schema.String,
	},
) {}

export class AutoresearchNoPendingRunError extends Schema.TaggedErrorClass<AutoresearchNoPendingRunError>()(
	"AutoresearchNoPendingRunError",
	{
		reason: Schema.String,
	},
) {}

export class AutoresearchFingerprintMismatchError extends Schema.TaggedErrorClass<AutoresearchFingerprintMismatchError>()(
	"AutoresearchFingerprintMismatchError",
	{
		reason: Schema.String,
	},
) {}

export class AutoresearchBenchmarkCommandMismatchError extends Schema.TaggedErrorClass<AutoresearchBenchmarkCommandMismatchError>()(
	"AutoresearchBenchmarkCommandMismatchError",
	{
		expected: Schema.String,
		received: Schema.String,
	},
) {}

export class AutoresearchMaxExperimentsReachedError extends Schema.TaggedErrorClass<AutoresearchMaxExperimentsReachedError>()(
	"AutoresearchMaxExperimentsReachedError",
	{
		maxExperiments: Schema.Number,
	},
) {}

export class AutoresearchValidationError extends Schema.TaggedErrorClass<AutoresearchValidationError>()(
	"AutoresearchValidationError",
	{
		reason: Schema.String,
	},
) {}

export class AutoresearchGitError extends Schema.TaggedErrorClass<AutoresearchGitError>()(
	"AutoresearchGitError",
	{
		reason: Schema.String,
	},
) {}

type AutoresearchError =
	| AutoresearchContractValidationError
	| AutoresearchNoPendingRunError
	| AutoresearchFingerprintMismatchError
	| AutoresearchBenchmarkCommandMismatchError
	| AutoresearchMaxExperimentsReachedError
	| AutoresearchValidationError
	| AutoresearchGitError;
