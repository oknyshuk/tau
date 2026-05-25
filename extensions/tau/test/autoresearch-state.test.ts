import { describe, expect, it } from "vitest";

import {
	computeConfidence,
	findBaselineMetric,
} from "../src/autoresearch/state.js";
import type { ExperimentResult } from "../src/autoresearch/schema.js";

describe("autoresearch state", () => {
	describe("computeConfidence", () => {
		it("returns null with fewer than 3 results", () => {
			const results: ExperimentResult[] = [
				{ runNumber: 1, commit: "a", metric: 100, metrics: {}, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
				{ runNumber: 2, commit: "b", metric: 90, metrics: {}, status: "discard", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
			];
			expect(computeConfidence(results, 0, "lower")).toBeNull();
		});

		it("computes confidence for a clear improvement", () => {
			// Baseline at 100, three noisy discards around 100, one clear keep at 50.
			const results: ExperimentResult[] = [
				{ runNumber: 1, commit: "a", metric: 100, metrics: {}, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
				{ runNumber: 2, commit: "b", metric: 101, metrics: {}, status: "discard", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
				{ runNumber: 3, commit: "c", metric: 99, metrics: {}, status: "discard", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
				{ runNumber: 4, commit: "d", metric: 102, metrics: {}, status: "discard", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
				{ runNumber: 5, commit: "e", metric: 50, metrics: {}, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
			];
			const confidence = computeConfidence(results, 0, "lower");
			expect(confidence).not.toBeNull();
			expect(confidence!).toBeGreaterThan(0);
		});
	});

	describe("findBaselineMetric", () => {
		it("finds the first keep as baseline", () => {
			const results: ExperimentResult[] = [
				{ runNumber: 1, commit: "a", metric: 100, metrics: {}, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
				{ runNumber: 2, commit: "b", metric: 90, metrics: {}, status: "keep", description: "", timestamp: 0, segment: 0, confidence: null, asi: undefined },
			];
			expect(findBaselineMetric(results, 0)).toBe(100);
		});
	});
});
