import { Schema } from "effect";

export class DreamLockHeld extends Schema.TaggedErrorClass<DreamLockHeld>()(
	"DreamLockHeld",
	{
		path: Schema.String,
		holderPid: Schema.optional(Schema.Number),
	},
) {}

export class DreamLockCorrupt extends Schema.TaggedErrorClass<DreamLockCorrupt>()(
	"DreamLockCorrupt",
	{
		path: Schema.String,
		reason: Schema.String,
	},
) {}

export class DreamLockIoError extends Schema.TaggedErrorClass<DreamLockIoError>()(
	"DreamLockIoError",
	{
		path: Schema.String,
		operation: Schema.String,
		reason: Schema.String,
	},
) {}

export type DreamLockError = DreamLockHeld | DreamLockCorrupt | DreamLockIoError;

export class DreamDisabled extends Schema.TaggedErrorClass<DreamDisabled>()(
	"DreamDisabled",
	{
		mode: Schema.Literals(["manual", "auto"]),
	},
) {}

export class DreamTooSoon extends Schema.TaggedErrorClass<DreamTooSoon>()(
	"DreamTooSoon",
	{
		lastCompletedAtMs: Schema.Number,
		hoursSinceLastRun: Schema.Number,
		minHoursSinceLastRun: Schema.Number,
	},
) {}

export class DreamNotEnoughSessions extends Schema.TaggedErrorClass<DreamNotEnoughSessions>()(
	"DreamNotEnoughSessions",
	{
		found: Schema.Number,
		required: Schema.Number,
	},
) {}

export class DreamSessionScanThrottled extends Schema.TaggedErrorClass<DreamSessionScanThrottled>()(
	"DreamSessionScanThrottled",
	{
		lastScanAtMs: Schema.Number,
		scanThrottleMinutes: Schema.Number,
	},
) {}

export type DreamGateError =
	| DreamDisabled
	| DreamTooSoon
	| DreamNotEnoughSessions
	| DreamSessionScanThrottled;

export class DreamSubagentSpawnFailed extends Schema.TaggedErrorClass<DreamSubagentSpawnFailed>()(
	"DreamSubagentSpawnFailed",
	{
		reason: Schema.String,
	},
) {}

class DreamSubagentAborted extends Schema.TaggedErrorClass<DreamSubagentAborted>()(
	"DreamSubagentAborted",
	{},
) {}

export class DreamSubagentNoFinish extends Schema.TaggedErrorClass<DreamSubagentNoFinish>()(
	"DreamSubagentNoFinish",
	{
		reason: Schema.String,
	},
) {}

export type DreamSubagentError =
	| DreamSubagentSpawnFailed
	| DreamSubagentAborted
	| DreamSubagentNoFinish;

export class DreamConfigDecodeError extends Schema.TaggedErrorClass<DreamConfigDecodeError>()(
	"DreamConfigDecodeError",
	{
		reason: Schema.String,
	},
) {}

class DreamConfigMissingModel extends Schema.TaggedErrorClass<DreamConfigMissingModel>()(
	"DreamConfigMissingModel",
	{
		path: Schema.String,
	},
) {}

export class DreamConfigInvalidThreshold extends Schema.TaggedErrorClass<DreamConfigInvalidThreshold>()(
	"DreamConfigInvalidThreshold",
	{
		field: Schema.String,
		value: Schema.Number,
	},
) {}

export type DreamConfigError =
	| DreamConfigDecodeError
	| DreamConfigMissingModel
	| DreamConfigInvalidThreshold;
