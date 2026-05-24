import { Schema } from "effect";

export class BacklogContractValidationError extends Schema.TaggedErrorClass<BacklogContractValidationError>()(
	"BacklogContractValidationError",
	{
		reason: Schema.String,
		entity: Schema.String,
	},
) {}

export class BacklogIssueNotFoundError extends Schema.TaggedErrorClass<BacklogIssueNotFoundError>()(
	"BacklogIssueNotFoundError",
	{
		issueId: Schema.String,
	},
) {}

export class BacklogDependencyCycleError extends Schema.TaggedErrorClass<BacklogDependencyCycleError>()(
	"BacklogDependencyCycleError",
	{
		issueId: Schema.String,
		dependsOnId: Schema.String,
		dependencyType: Schema.String,
	},
) {}

export class BacklogIdGenerationError extends Schema.TaggedErrorClass<BacklogIdGenerationError>()(
	"BacklogIdGenerationError",
	{
		prefix: Schema.String,
		reason: Schema.String,
	},
) {}

export class BacklogStorageError extends Schema.TaggedErrorClass<BacklogStorageError>()(
	"BacklogStorageError",
	{
		operation: Schema.String,
		path: Schema.String,
		reason: Schema.String,
		cause: Schema.Defect,
	},
) {}

export class BacklogCacheError extends Schema.TaggedErrorClass<BacklogCacheError>()(
	"BacklogCacheError",
	{
		operation: Schema.String,
		path: Schema.String,
		reason: Schema.String,
		cause: Schema.Defect,
	},
) {}

export class BacklogLockError extends Schema.TaggedErrorClass<BacklogLockError>()(
	"BacklogLockError",
	{
		lockPath: Schema.String,
		reason: Schema.String,
		reclaimAttempted: Schema.Boolean,
		cause: Schema.Defect,
	},
) {}

export class BacklogCommandUsageError extends Schema.TaggedErrorClass<BacklogCommandUsageError>()(
	"BacklogCommandUsageError",
	{
		command: Schema.String,
		usage: Schema.String,
		reason: Schema.String,
	},
) {}

type BacklogError =
	| BacklogContractValidationError
	| BacklogIssueNotFoundError
	| BacklogDependencyCycleError
	| BacklogIdGenerationError
	| BacklogStorageError
	| BacklogCacheError
	| BacklogLockError
	| BacklogCommandUsageError;

