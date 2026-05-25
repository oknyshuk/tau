type ExperimentStatus = "keep" | "discard" | "crash" | "checks_failed";

export type MetricDirection = "lower" | "higher";

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
