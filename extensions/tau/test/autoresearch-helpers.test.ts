import { describe, expect, it } from "vitest";

import {
	parseMetricLines,
	parseAsiLines,
	isBetter,
	inferMetricUnitFromName,
} from "../src/autoresearch/helpers.js";

describe("autoresearch helpers", () => {
	describe("parseMetricLines", () => {
		it("extracts METRIC lines from output", () => {
			const output = `Starting benchmark...\nMETRIC total_µs=15200\nMETRICT should be ignored\nMETRIC bundle_kb=42\nDone`;
			const metrics = parseMetricLines(output);
			expect(metrics.get("total_µs")).toBe(15200);
			expect(metrics.get("bundle_kb")).toBe(42);
			expect(metrics.has("should")).toBe(false);
		});

		it("ignores non-finite values", () => {
			const output = `METRIC a=1\nMETRIC b=Infinity\nMETRIC c=NaN`;
			const metrics = parseMetricLines(output);
			expect(metrics.get("a")).toBe(1);
			expect(metrics.has("b")).toBe(false);
			expect(metrics.has("c")).toBe(false);
		});

		it("ignores denied keys", () => {
			const output = `METRIC __proto__=1\nMETRIC constructor=2\nMETRIC prototype=3\nMETRIC safe=4`;
			const metrics = parseMetricLines(output);
			expect(metrics.has("__proto__")).toBe(false);
			expect(metrics.has("constructor")).toBe(false);
			expect(metrics.has("prototype")).toBe(false);
			expect(metrics.get("safe")).toBe(4);
		});
	});

	describe("parseAsiLines", () => {
		it("extracts ASI key-value pairs", () => {
			const output = `ASI hypothesis=vectorized loop\nASI rollback_reason=regression`;
			const asi = parseAsiLines(output);
			expect(asi).toEqual({
				hypothesis: "vectorized loop",
				rollback_reason: "regression",
			});
		});

		it("parses typed ASI values", () => {
			const output = `ASI flag=true\nASI count=42\nASI ratio=3.14\nASI obj={"a":1}\nASI list=[1,2]`;
			const asi = parseAsiLines(output);
			expect(asi).toEqual({
				flag: true,
				count: 42,
				ratio: 3.14,
				obj: { a: 1 },
				list: [1, 2],
			});
		});

		it("returns null when empty", () => {
			expect(parseAsiLines("no asi here")).toBeNull();
		});
	});

	describe("isBetter", () => {
		it("chooses lower when direction is lower", () => {
			expect(isBetter(5, 10, "lower")).toBe(true);
			expect(isBetter(10, 5, "lower")).toBe(false);
		});

		it("chooses higher when direction is higher", () => {
			expect(isBetter(10, 5, "higher")).toBe(true);
			expect(isBetter(5, 10, "higher")).toBe(false);
		});
	});

	describe("inferMetricUnitFromName", () => {
		it("infers common units", () => {
			expect(inferMetricUnitFromName("total_µs")).toBe("µs");
			expect(inferMetricUnitFromName("duration_ms")).toBe("ms");
			expect(inferMetricUnitFromName("elapsed_s")).toBe("s");
			expect(inferMetricUnitFromName("size_kb")).toBe("kb");
			expect(inferMetricUnitFromName("memory_mb")).toBe("mb");
			expect(inferMetricUnitFromName("score")).toBe("");
		});
	});
});
