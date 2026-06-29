import { Schema } from "effect";

import { StorageError } from "../shared/atomic-write.js";

export class LoopContractValidationError extends Schema.TaggedErrorClass<LoopContractValidationError>()(
	"LoopContractValidationError",
	{
		reason: Schema.String,
		entity: Schema.String,
	},
) {}

export class LoopTaskNotFoundError extends Schema.TaggedErrorClass<LoopTaskNotFoundError>()(
	"LoopTaskNotFoundError",
	{
		taskId: Schema.String,
	},
) {}

export class LoopTaskAlreadyExistsError extends Schema.TaggedErrorClass<LoopTaskAlreadyExistsError>()(
	"LoopTaskAlreadyExistsError",
	{
		taskId: Schema.String,
	},
) {}

export class LoopLifecycleConflictError extends Schema.TaggedErrorClass<LoopLifecycleConflictError>()(
	"LoopLifecycleConflictError",
	{
		taskId: Schema.String,
		expected: Schema.String,
		actual: Schema.String,
	},
) {}

export class LoopOwnershipValidationError extends Schema.TaggedErrorClass<LoopOwnershipValidationError>()(
	"LoopOwnershipValidationError",
	{
		taskId: Schema.String,
		reason: Schema.String,
	},
) {}

export class LoopAmbiguousOwnershipError extends Schema.TaggedErrorClass<LoopAmbiguousOwnershipError>()(
	"LoopAmbiguousOwnershipError",
	{
		sessionId: Schema.String,
		sessionFile: Schema.String,
		matchingTaskIds: Schema.Array(Schema.String),
	},
) {}

export type LoopEngineError =
	| LoopContractValidationError
	| LoopTaskNotFoundError
	| LoopTaskAlreadyExistsError
	| LoopLifecycleConflictError
	| LoopOwnershipValidationError
	| LoopAmbiguousOwnershipError
	| StorageError;
