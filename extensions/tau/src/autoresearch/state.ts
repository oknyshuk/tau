import { Schema } from "effect";

import {
	ExecutionProfileSchema,
	type ExecutionProfile,
} from "../execution/schema.js";
import type {
	ASIData,
	ExperimentResult,
	ExperimentState,
	MetricDirection,
	NumericMetricMap,
	MetricDef,
} from "./schema.js";
import { inferMetricUnitFromName, isBetter } from "./helpers.js";

export function createExperimentState(): ExperimentState {
	return {
		results: [],
		bestMetric: null,
		bestDirection: "lower",
		metricName: "metric",
		metricUnit: "",
		secondaryMetrics: [],
		name: null,
		currentSegment: 0,
		maxExperiments: null,
		confidence: null,
		benchmarkCommand: null,
		scopePaths: [],
		offLimits: [],
		constraints: [],
		segmentFingerprint: null,
		executionProfile: null,
	};
}

export function cloneExperimentState(state: ExperimentState): ExperimentState {
	return {
		...state,
		results: state.results.map((result) => ({
			...result,
			metrics: { ...result.metrics } as NumericMetricMap,
			asi: result.asi ? structuredClone(result.asi) : undefined,
		})),
		secondaryMetrics: state.secondaryMetrics.map((metric) => ({ ...metric })),
		scopePaths: [...state.scopePaths],
		offLimits: [...state.offLimits],
		constraints: [...state.constraints],
		executionProfile:
			state.executionProfile === null ? null : structuredClone(state.executionProfile),
	};
}

export function currentResults(results: readonly ExperimentResult[], segment: number): ExperimentResult[] {
	return results.filter((result) => result.segment === segment);
}

function findBaselineResult(results: readonly ExperimentResult[], segment: number): ExperimentResult | null {
	return currentResults(results, segment).find((result) => result.status === "keep") ?? null;
}

export function findBaselineMetric(results: readonly ExperimentResult[], segment: number): number | null {
	const baseline = findBaselineResult(results, segment);
	return baseline ? baseline.metric : null;
}

export function findBaselineRunNumber(results: readonly ExperimentResult[], segment: number): number | null {
	const baseline = findBaselineResult(results, segment);
	return baseline?.runNumber ?? null;
}

export function findBaselineSecondary(
	results: readonly ExperimentResult[],
	segment: number,
	secondaryMetrics: readonly MetricDef[],
): Record<string, number> {
	const baseline = findBaselineResult(results, segment);
	const out: Record<string, number> = {};
	if (!baseline) return out;
	for (const metric of secondaryMetrics) {
		const value = baseline.metrics[metric.name];
		if (typeof value === "number") {
			out[metric.name] = value;
		}
	}
	return out;
}

export function findBestKeptMetric(
	results: readonly ExperimentResult[],
	segment: number,
	direction: MetricDirection,
): number | null {
	let best: number | null = null;
	for (const result of currentResults(results, segment)) {
		if (result.status !== "keep") continue;
		if (best === null || isBetter(result.metric, best, direction)) {
			best = result.metric;
		}
	}
	return best;
}

export function findBestResult(
	results: readonly ExperimentResult[],
	segment: number,
	direction: MetricDirection,
): { index: number; result: ExperimentResult } | null {
	let best: { index: number; result: ExperimentResult } | null = null;
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		if (!result || result.segment !== segment || result.status !== "keep" || result.metric <= 0) continue;
		if (!best || isBetter(result.metric, best.result.metric, direction)) {
			best = { index: i, result };
		}
	}
	return best;
}

function sortedMedian(values: readonly number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const midpoint = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return (sorted[midpoint - 1]! + sorted[midpoint]!) / 2;
	}
	return sorted[midpoint]!;
}

export function computeConfidence(
	results: readonly ExperimentResult[],
	segment: number,
	direction: MetricDirection,
): number | null {
	const current = currentResults(results, segment).filter((result) => result.metric > 0);
	if (current.length < 3) return null;

	const values = current.map((result) => result.metric);
	const median = sortedMedian(values);
	const mad = sortedMedian(values.map((value) => Math.abs(value - median)));
	if (mad === 0) return null;

	const baseline = findBaselineMetric(results, segment);
	if (baseline === null) return null;

	let bestKept: number | null = null;
	for (const result of current) {
		if (result.status !== "keep" || result.metric <= 0) continue;
		if (bestKept === null || isBetter(result.metric, bestKept, direction)) {
			bestKept = result.metric;
		}
	}
	if (bestKept === null || bestKept === baseline) return null;

	return Math.abs(bestKept - baseline) / mad;
}

interface ReconstructedExperimentData {
	hasLog: boolean;
	state: ExperimentState;
}

function isConfigEntry(value: unknown): value is { type: "config" } {
	if (typeof value !== "object" || value === null) return false;
	return (value as { type?: unknown }).type === "config";
}

function isRunEntry(value: unknown): value is { type?: "run" | undefined } {
	if (typeof value !== "object" || value === null) return false;
	const t = (value as { type?: unknown }).type;
	return t === undefined || t === "run";
}

function isExperimentStatus(value: unknown): value is ExperimentResult["status"] {
	return value === "keep" || value === "discard" || value === "crash" || value === "checks_failed";
}

function cloneNumericMetrics(value: unknown): NumericMetricMap {
	if (typeof value !== "object" || value === null) return {};
	const metrics = value as { [key: string]: unknown };
	const clone: NumericMetricMap = {};
	for (const [key, entryValue] of Object.entries(metrics)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		if (typeof entryValue === "number" && Number.isFinite(entryValue)) {
			clone[key] = entryValue;
		}
	}
	return clone;
}

function hydrateMetricDefs(metricNames: string[] | undefined): MetricDef[] {
	if (!metricNames) return [];
	return metricNames.map((name) => ({
		name,
		unit: inferMetricUnitFromName(name),
	}));
}

function cloneAsi(value: unknown): ExperimentResult["asi"] {
	if (typeof value !== "object" || value === null) return undefined;
	const clone: { [key: string]: unknown } = {};
	for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		clone[key] = structuredClone(entryValue);
	}
	return clone as ExperimentResult["asi"];
}

function normalizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

const decodeExecutionProfileSync = Schema.decodeUnknownSync(ExecutionProfileSchema);

function decodeExecutionProfile(value: unknown): ExecutionProfile | null {
	try {
		return decodeExecutionProfileSync(value);
	} catch {
		return null;
	}
}

function registerSecondaryMetrics(metrics: MetricDef[], values: NumericMetricMap): void {
	for (const name of Object.keys(values)) {
		if (metrics.some((metric) => metric.name === name)) continue;
		metrics.push({
			name,
			unit: inferMetricUnitFromName(name),
		});
	}
}

export function reconstructStateFromJsonl(content: string): ReconstructedExperimentData {
	const state = createExperimentState();
	const lines = content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	let segment = 0;
	let sawConfig = false;
	for (const line of lines) {
		let rawParsed: unknown;
		try {
			rawParsed = JSON.parse(line) as unknown;
		} catch {
			continue;
		}

		if (isConfigEntry(rawParsed)) {
			if (sawConfig || state.results.length > 0) {
				segment += 1;
			}
			sawConfig = true;
			state.currentSegment = segment;
			const candidate = rawParsed as {
				name?: unknown;
				metricName?: unknown;
				metricUnit?: unknown;
				bestDirection?: unknown;
				benchmarkCommand?: unknown;
				secondaryMetrics?: unknown;
				scopePaths?: unknown;
				offLimits?: unknown;
				constraints?: unknown;
				segmentFingerprint?: unknown;
				executionProfile?: unknown;
			};
			if (typeof candidate.name === "string") state.name = candidate.name;
			if (typeof candidate.metricName === "string") state.metricName = candidate.metricName;
			if (typeof candidate.metricUnit === "string") state.metricUnit = candidate.metricUnit;
			if (candidate.bestDirection === "lower" || candidate.bestDirection === "higher") {
				state.bestDirection = candidate.bestDirection;
			}
			if (typeof candidate.benchmarkCommand === "string") {
				state.benchmarkCommand = candidate.benchmarkCommand;
			}
			state.scopePaths = normalizeStringList(candidate.scopePaths);
			state.offLimits = normalizeStringList(candidate.offLimits);
			state.constraints = normalizeStringList(candidate.constraints);
			state.segmentFingerprint =
				typeof candidate.segmentFingerprint === "string" ? candidate.segmentFingerprint : null;
			state.executionProfile = decodeExecutionProfile(candidate.executionProfile);
			state.secondaryMetrics = hydrateMetricDefs(
				normalizeStringList(candidate.secondaryMetrics),
			);
			continue;
		}

		if (!isRunEntry(rawParsed)) continue;
		const runCandidate = rawParsed as {
			run?: unknown;
			commit?: unknown;
			metric?: unknown;
			metrics?: unknown;
			status?: unknown;
			description?: unknown;
			timestamp?: unknown;
			confidence?: unknown;
			asi?: unknown;
		};
		const result: ExperimentResult = {
			runNumber: typeof runCandidate.run === "number" && Number.isFinite(runCandidate.run) ? runCandidate.run : null,
			commit: typeof runCandidate.commit === "string" ? runCandidate.commit : "",
			metric: typeof runCandidate.metric === "number" && Number.isFinite(runCandidate.metric) ? runCandidate.metric : 0,
			metrics: cloneNumericMetrics(runCandidate.metrics),
			status: isExperimentStatus(runCandidate.status) ? runCandidate.status : "keep",
			description: typeof runCandidate.description === "string" ? runCandidate.description : "",
			timestamp: typeof runCandidate.timestamp === "number" && Number.isFinite(runCandidate.timestamp) ? runCandidate.timestamp : 0,
			segment,
			confidence:
				typeof runCandidate.confidence === "number" && Number.isFinite(runCandidate.confidence)
					? runCandidate.confidence
					: null,
			asi: cloneAsi(runCandidate.asi),
		};
		state.results.push(result);
		if (segment !== state.currentSegment) continue;
		registerSecondaryMetrics(state.secondaryMetrics, result.metrics);
	}

	state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
	state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
	return { hasLog: lines.length > 0, state };
}
