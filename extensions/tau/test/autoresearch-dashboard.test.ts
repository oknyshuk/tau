import { describe, expect, it } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";

import { renderWidget } from "../src/autoresearch/dashboard.js";
import { renderDashboardLines } from "../src/autoresearch/dashboard.js";
import type { AutoresearchViewData } from "../src/autoresearch/view.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function makeViewData(overrides: Partial<AutoresearchViewData> = {}): AutoresearchViewData {
	const base: AutoresearchViewData = {
		autoresearchMode: true,
		name: "Improve local PDP web vitals",
		metricName: "lcp_ms",
		metricUnit: "ms",
		bestMetric: 3725,
		bestDirection: "lower",
		currentSegment: 0,
		currentSegmentRunCount: 2,
		totalRunCount: 2,
		currentSegmentKeptCount: 2,
		currentSegmentCrashedCount: 0,
		currentSegmentChecksFailedCount: 0,
		bestPrimaryMetric: 3652,
		bestRunNumber: 2,
		confidence: 2.1,
		secondaryMetrics: [{ name: "ttfb_ms", unit: "ms" }],
		runningExperiment: null,
		results: [
			{
				runNumber: 1,
				commit: "abc1234",
				metric: 3725,
				metrics: { ttfb_ms: 500 },
				status: "keep",
				description: "baseline",
				timestamp: 1,
				segment: 0,
				confidence: null,
				asi: { hypothesis: "baseline" },
			},
			{
				runNumber: 2,
				commit: "def5678",
				metric: 3652,
				metrics: { ttfb_ms: 510 },
				status: "keep",
				description: "improve render path",
				timestamp: 2,
				segment: 0,
				confidence: 2.1,
				asi: { hypothesis: "reduce render-blocking work" },
			},
		],
		maxExperiments: null,
	};

	return { ...base, ...overrides };
}

describe("autoresearch widget rendering", () => {
	it("renders compact widget parity details from the original UI", () => {
		const rendered = renderWidget(makeViewData(), 240, plainTheme, false);

		expect(rendered).toContain("autoresearch 2 runs 2 kept");
		expect(rendered).toContain("★ lcp_ms: 3,652ms #2");
		expect(rendered).toContain("(-2.0%)");
		expect(rendered).toContain("conf: 2.1x");
		expect(rendered).toContain("ttfb_ms: 510ms +2.0%");
		expect(rendered).toContain("Improve local PDP web vitals");
		expect(rendered).toContain("ctrl+alt+x expand");
		expect(rendered).toContain("ctrl+alt+shift+x fullscreen");
	});

	it("keeps the compact summary visible while a later run is active", () => {
		const rendered = renderWidget(
			makeViewData({
				runningExperiment: {
					startedAt: Date.now(),
					command: "bash autoresearch.sh",
					runDirectory: "/tmp/run-0003",
					runNumber: 3,
				},
			}),
			240,
			plainTheme,
			false,
		);

		expect(rendered).toContain("★ lcp_ms: 3,652ms #2");
		expect(rendered).not.toContain("waiting for first logged result");
	});

	it("shows the original waiting message when the first run is still in flight", () => {
		const rendered = renderWidget(
			makeViewData({
				currentSegmentRunCount: 0,
				totalRunCount: 0,
				currentSegmentKeptCount: 0,
				bestMetric: null,
				bestPrimaryMetric: null,
				bestRunNumber: null,
				confidence: null,
				results: [],
				runningExperiment: {
					startedAt: Date.now(),
					command: "bash autoresearch.sh",
					runDirectory: "/tmp/run-0001",
					runNumber: 1,
				},
			}),
			240,
			plainTheme,
			false,
		);

		expect(rendered).toContain("autoresearch running...");
		expect(rendered).toContain("bash autoresearch.sh");
		expect(rendered).toContain("waiting for first logged result");
	});

	it("shows commit hashes only for kept rows", () => {
		const lines = renderDashboardLines(
			makeViewData({
				results: [
					{
						runNumber: 1,
						commit: "keep111",
						metric: 3652,
						metrics: { ttfb_ms: 500 },
						status: "keep",
						description: "baseline",
						timestamp: 1,
						segment: 0,
						confidence: null,
						asi: { hypothesis: "baseline" },
					},
					{
						runNumber: 2,
						commit: "base222",
						metric: 3900,
						metrics: { ttfb_ms: 520 },
						status: "discard",
						description: "regression",
						timestamp: 2,
						segment: 0,
						confidence: null,
						asi: {
							hypothesis: "try cache",
							rollback_reason: "regressed",
							next_action_hint: "revert",
						},
					},
				],
			}),
			240,
			plainTheme,
			8,
		);

		const table = lines.join("\n");
		expect(table).toContain("keep111");
		expect(table).toContain("discard");
		expect(table).not.toContain("base222");
	});

	it("keeps earlier-segment rows visible in the expanded dashboard", () => {
		const lines = renderDashboardLines(
			makeViewData({
				currentSegment: 1,
				currentSegmentRunCount: 1,
				totalRunCount: 3,
				currentSegmentKeptCount: 1,
				bestMetric: 3500,
				bestPrimaryMetric: 3500,
				bestRunNumber: 3,
				results: [
					{
						runNumber: 1,
						commit: "old1111",
						metric: 3725,
						metrics: { ttfb_ms: 500 },
						status: "keep",
						description: "old baseline",
						timestamp: 1,
						segment: 0,
						confidence: null,
						asi: { hypothesis: "baseline" },
					},
					{
						runNumber: 2,
						commit: "old2222",
						metric: 3652,
						metrics: { ttfb_ms: 510 },
						status: "discard",
						description: "old regression",
						timestamp: 2,
						segment: 0,
						confidence: null,
						asi: {
							hypothesis: "old attempt",
							rollback_reason: "regressed",
							next_action_hint: "revert",
						},
					},
					{
						runNumber: 3,
						commit: "new3333",
						metric: 3500,
						metrics: { ttfb_ms: 490 },
						status: "keep",
						description: "new baseline",
						timestamp: 3,
						segment: 1,
						confidence: null,
						asi: { hypothesis: "new baseline" },
					},
				],
			}),
			240,
			plainTheme,
			8,
		);

		const table = lines.join("\n");
		expect(table).toContain("Archived from earlier segments: 2 runs");
		expect(table).toContain("(old)");
		expect(table).toContain("old baseline");
		expect(table).toContain("old regression");
		expect(table).toContain("new3333");
		expect(table).not.toContain("old1111");
	});
});
