import { describe, expect, it } from "vitest";

import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Option } from "effect";

import { renderRunExperimentResult } from "../src/autoresearch/run-experiment-render.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

describe("run_experiment renderer", () => {
	it("renders a compact result in collapsed mode", () => {
		const result = renderRunExperimentResult(
			{
				content: [{ type: "text", text: "unused" }],
				details: {
					command: "bash autoresearch.sh",
					exitCode: 0,
					durationSeconds: 12.3,
					passed: true,
					crashed: false,
					timedOut: false,
					tailOutput: ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7"].join("\n"),
					llmTailOutput: "line 6\nline 7",
					checksPass: true,
					checksTimedOut: false,
					checksOutput: "",
					checksDuration: 1.2,
					parsedMetrics: { lcp_ms: 3652 },
					parsedPrimary: 3652,
					parsedAsi: null,
					metricName: "lcp_ms",
					metricUnit: "ms",
					benchmarkLogPath: "/tmp/benchmark.log",
					checksLogPath: Option.none(),
					runDirectory: "/tmp/run-0001",
					runNumber: 1,
					fullOutputPath: Option.some("/tmp/full.log"),
					truncation: {
						content: "line 6\nline 7",
						truncated: true,
						truncatedBy: "lines",
						totalLines: 7,
						totalBytes: 42,
						outputLines: 2,
						outputBytes: 12,
						lastLinePartial: false,
						firstLineExceedsLimit: false,
						maxLines: 2,
						maxBytes: 4096,
					},
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
		);

		const text = result.render(240).join("\n");
		expect(text).toContain("wall: 12.3s, lcp_ms: 3,652ms");
		expect(text).toContain("checks 1.2s");
		expect(text).toContain("more lines");
		expect(text).toContain("line 7");
		expect(text).not.toContain("line 1");
	});

	it("renders the long result in expanded mode", () => {
		const result = renderRunExperimentResult(
			{
				content: [{ type: "text", text: "unused" }],
				details: {
					command: "bash autoresearch.sh",
					exitCode: 0,
					durationSeconds: 12.3,
					passed: true,
					crashed: false,
					timedOut: false,
					tailOutput: ["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7"].join("\n"),
					llmTailOutput: "line 6\nline 7",
					checksPass: false,
					checksTimedOut: false,
					checksOutput: "checks line 1\nchecks line 2",
					checksDuration: 1.2,
					parsedMetrics: { lcp_ms: 3652 },
					parsedPrimary: 3652,
					parsedAsi: null,
					metricName: "lcp_ms",
					metricUnit: "ms",
					benchmarkLogPath: "/tmp/benchmark.log",
					checksLogPath: Option.none(),
					runDirectory: "/tmp/run-0001",
					runNumber: 1,
					fullOutputPath: Option.some("/tmp/full.log"),
					truncation: {
						content: "line 6\nline 7",
						truncated: true,
						truncatedBy: "lines",
						totalLines: 7,
						totalBytes: 42,
						outputLines: 2,
						outputBytes: 12,
						lastLinePartial: false,
						firstLineExceedsLimit: false,
						maxLines: 2,
						maxBytes: 4096,
					},
				},
			},
			{ expanded: true, isPartial: false },
			plainTheme,
		);

		const text = result.render(240).join("\n");
		expect(text).toContain("checks failed 1.2s");
		expect(text).toContain("line 1");
		expect(text).toContain("line 7");
		expect(text).toContain("Full output: /tmp/full.log");
		expect(text).toContain("checks line 1");
	});

	it("renders partial output with a shorter collapsed preview and a longer expanded preview", () => {
		const partial = {
			content: [{ type: "text" as const, text: ["p1", "p2", "p3", "p4", "p5", "p6"].join("\n") }],
			details: {
				phase: "running",
				elapsed: "7s",
				tailOutput: ["p1", "p2", "p3", "p4", "p5", "p6"].join("\n"),
			},
		};

		const collapsed = renderRunExperimentResult(
			partial,
			{ expanded: false, isPartial: true } as ToolRenderResultOptions,
			plainTheme,
		)
			.render(240)
			.join("\n");
		const expanded = renderRunExperimentResult(
			partial,
			{ expanded: true, isPartial: true } as ToolRenderResultOptions,
			plainTheme,
		)
			.render(240)
			.join("\n");

		expect(collapsed).toContain("Running 7s");
		expect(collapsed).toContain("p6");
		expect(collapsed).not.toContain("p1");
		expect(expanded).toContain("p1");
		expect(expanded).toContain("p6");
	});
});
