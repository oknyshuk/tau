import { Effect, Schema } from "effect";

import type { DreamConfigError } from "./errors.js";

const DreamThinking = Schema.Literals(["low", "medium", "high", "xhigh"]);
type DreamThinking = typeof DreamThinking.Type;

const DreamModelConfigInput = Schema.Struct({
	model: Schema.String,
	thinking: DreamThinking,
	maxTurns: Schema.Number,
});

const ManualDreamConfigInput = Schema.Struct({
	enabled: Schema.Boolean,
});

const AutoDreamConfigInput = Schema.Struct({
	enabled: Schema.Boolean,
	minHoursSinceLastRun: Schema.Number,
	minSessionsSinceLastRun: Schema.Number,
	scanThrottleMinutes: Schema.Number,
});

export const DreamConfigInput = Schema.Struct({
	enabled: Schema.Boolean,
	manual: ManualDreamConfigInput,
	auto: AutoDreamConfigInput,
	subagent: DreamModelConfigInput,
});
export type DreamConfigInput = typeof DreamConfigInput.Type;

const TauSettingsWithDreamInput = Schema.Struct({
	tau: Schema.Struct({
		dream: Schema.optional(DreamConfigInput),
	}),
});

interface DreamModelConfig {
	readonly model: string;
	readonly thinking: DreamThinking;
	readonly maxTurns: number;
}

interface AutoDreamConfig {
	readonly enabled: boolean;
	readonly minHoursSinceLastRun: number;
	readonly minSessionsSinceLastRun: number;
	readonly scanThrottleMinutes: number;
}

export interface DreamConfig {
	readonly enabled: boolean;
	readonly manual: {
		readonly enabled: boolean;
	};
	readonly auto: AutoDreamConfig;
	readonly subagent: DreamModelConfig;
}

interface DreamConfigLoader {
	readonly load: (settingsJson: unknown) => Effect.Effect<DreamConfig, DreamConfigError>;
}
