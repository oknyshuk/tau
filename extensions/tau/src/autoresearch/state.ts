import type {
	ExperimentResult,
	MetricDef,
	MetricDirection,
} from "./schema.js";
import { isBetter } from "./helpers.js";

export function currentResults(
	results: readonly ExperimentResult[],
	segment: number,
): ExperimentResult[] {
	return results.filter((result) => result.segment === segment);
}

function findBaselineResult(
	results: readonly ExperimentResult[],
	segment: number,
): ExperimentResult | null {
	return currentResults(results, segment).find((result) => result.status === "keep") ?? null;
}

export function findBaselineMetric(
	results: readonly ExperimentResult[],
	segment: number,
): number | null {
	const baseline = findBaselineResult(results, segment);
	return baseline ? baseline.metric : null;
}

export function findBaselineRunNumber(
	results: readonly ExperimentResult[],
	segment: number,
): number | null {
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

export function findBestResult(
	results: readonly ExperimentResult[],
	segment: number,
	direction: MetricDirection,
): { index: number; result: ExperimentResult } | null {
	let best: { index: number; result: ExperimentResult } | null = null;
	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		if (!result || result.segment !== segment || result.status !== "keep" || result.metric <= 0)
			continue;
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
