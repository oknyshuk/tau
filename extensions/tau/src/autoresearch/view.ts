import type { Option } from "effect";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";

import type { ASIData, ExperimentResult, MetricDirection, NumericMetricMap } from "./schema.js";

export interface RunDetails {
	readonly runNumber: number;
	readonly runDirectory: string;
	readonly benchmarkLogPath: string;
	readonly checksLogPath: Option.Option<string>;
	readonly command: string;
	readonly exitCode: number | null;
	readonly durationSeconds: number;
	readonly passed: boolean;
	readonly crashed: boolean;
	readonly timedOut: boolean;
	readonly tailOutput: string;
	readonly llmTailOutput: string;
	readonly checksPass: boolean | null;
	readonly checksTimedOut: boolean;
	readonly checksOutput: string;
	readonly checksDuration: number;
	readonly parsedMetrics: NumericMetricMap | null;
	readonly parsedPrimary: number | null;
	readonly parsedAsi: ASIData | null;
	readonly metricName: string;
	readonly metricUnit: string;
	readonly fullOutputPath: Option.Option<string>;
	readonly truncation: TruncationResult | null;
}

export interface BenchmarkProgress {
	readonly phase: "running";
	readonly elapsed: string;
	readonly tailOutput: string;
}

export interface ExecuteBenchmarkInput {
	readonly workDir: string;
	readonly runDirectory: string;
	readonly benchmarkLogPath: string;
	readonly checksLogPath: Option.Option<string>;
	readonly command: string;
	readonly timeoutSeconds: number;
	readonly checksTimeoutSeconds: number;
	readonly metricName: string;
	readonly metricUnit: string;
	readonly signal?: AbortSignal | undefined;
}

interface RunningExperiment {
	readonly startedAt: number;
	readonly command: string;
	readonly runDirectory: string;
	readonly runNumber: number;
}

export interface AutoresearchViewData {
	readonly autoresearchMode: boolean;
	readonly name: string | null;
	readonly metricName: string;
	readonly metricUnit: string;
	readonly bestMetric: number | null;
	readonly bestDirection: MetricDirection;
	readonly currentSegment: number;
	readonly currentSegmentRunCount: number;
	readonly totalRunCount: number;
	readonly currentSegmentKeptCount: number;
	readonly currentSegmentCrashedCount: number;
	readonly currentSegmentChecksFailedCount: number;
	readonly bestPrimaryMetric: number | null;
	readonly bestRunNumber: number | null;
	readonly confidence: number | null;
	readonly secondaryMetrics: { name: string; unit: string }[];
	readonly runningExperiment: RunningExperiment | null;
	readonly results: readonly ExperimentResult[];
	readonly maxExperiments: number | null;
}
