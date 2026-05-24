import { Effect, Schema } from "effect";

import type { ExecutionProfile } from "../execution/schema.js";

import { AutoresearchContractValidationError } from "./errors.js";

const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

function toContractValidationError(entity: string, error: unknown): AutoresearchContractValidationError {
	return new AutoresearchContractValidationError({
		reason: String(error),
		entity,
	});
}

const MetricDirectionSchema = Schema.Literals(["lower", "higher"]);
export type MetricDirection = "lower" | "higher";

const ExperimentStatusSchema = Schema.Literals(["keep", "discard", "crash", "checks_failed"]);
type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";

const ASIValueSchema: Schema.Schema<unknown> = Schema.suspend((): Schema.Schema<unknown> =>
	Schema.Union([
		Schema.String,
		Schema.Number,
		Schema.Boolean,
		Schema.Null,
		Schema.Array(ASIValueSchema),
		Schema.Record(Schema.String, ASIValueSchema),
	]),
);

export type ASIData = Record<string, unknown>;

export type NumericMetricMap = Record<string, number>;

export type MetricDef = { name: string; unit: string };

export type ExperimentResult = {
	runNumber: number | null;
	commit: string;
	metric: number;
	metrics: NumericMetricMap;
	status: ExperimentStatus;
	description: string;
	timestamp: number;
	segment: number;
	confidence: number | null;
	asi: ASIData | undefined;
};

export type ExperimentState = {
	results: ExperimentResult[];
	bestMetric: number | null;
	bestDirection: MetricDirection;
	metricName: string;
	metricUnit: string;
	secondaryMetrics: MetricDef[];
	name: string | null;
	currentSegment: number;
	maxExperiments: number | null;
	confidence: number | null;
	benchmarkCommand: string | null;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	segmentFingerprint: string | null;
	executionProfile: ExecutionProfile | null;
};

const AutoresearchConfigSchema = Schema.Struct({
	maxIterations: Schema.optional(Schema.Number),
	workingDir: Schema.optional(Schema.String),
});
type AutoresearchConfig = {
	maxIterations?: number | undefined;
	workingDir?: string | undefined;
};

export type AutoresearchJsonConfigEntry = {
	type: "config";
	name?: string | undefined;
	metricName?: string | undefined;
	metricUnit?: string | undefined;
	bestDirection?: MetricDirection | undefined;
	benchmarkCommand?: string | undefined;
	secondaryMetrics?: string[] | undefined;
	scopePaths?: string[] | undefined;
	offLimits?: string[] | undefined;
	constraints?: string[] | undefined;
	segmentFingerprint?: string | undefined;
	executionProfile?: ExecutionProfile | undefined;
};

type AutoresearchJsonRunEntry = {
	type?: "run" | undefined;
	run?: number | undefined;
	commit: string;
	metric: number;
	metrics?: NumericMetricMap | undefined;
	status: ExperimentStatus;
	description: string;
	timestamp?: number | undefined;
	confidence: number | null;
	asi?: ASIData | undefined;
};

type AutoresearchJsonlLine = AutoresearchJsonConfigEntry | AutoresearchJsonRunEntry;

const parseJsonUnknown = (input: string): Effect.Effect<unknown, AutoresearchContractValidationError, never> =>
	Effect.try({
		try: () => JSON.parse(input) as unknown,
		catch: (error) => toContractValidationError("autoresearch.jsonl.json", error),
	});

export const decodeExperimentState = (
	value: unknown,
): Effect.Effect<ExperimentState, AutoresearchContractValidationError, never> =>
	Effect.fail(toContractValidationError("autoresearch.experiment_state", "not implemented"));

const decodeAutoresearchJsonlLineFromString = (
	input: string,
): Effect.Effect<AutoresearchJsonlLine, AutoresearchContractValidationError, never> =>
	parseJsonUnknown(input).pipe(
		Effect.map((raw) => {
			if (typeof raw !== "object" || raw === null) {
				throw toContractValidationError("autoresearch.jsonl.line", "expected object");
			}
			const typed = raw as { type?: unknown };
			if (typed.type === "config") {
				return raw as AutoresearchJsonConfigEntry;
			}
			return raw as AutoresearchJsonRunEntry;
		}),
		Effect.catch((error: unknown) => Effect.fail(toContractValidationError("autoresearch.jsonl.line", error))),
	);
