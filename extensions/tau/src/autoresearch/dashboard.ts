import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ExperimentResult } from "./schema.js";
import type { AutoresearchViewData } from "./view.js";
import { formatNum, formatElapsed } from "./helpers.js";
import {
	currentResults,
	findBaselineMetric,
	findBaselineRunNumber,
	findBaselineSecondary,
	findBestResult,
} from "./state.js";

export function renderExpandedHeader(
	viewData: AutoresearchViewData,
	width: number,
	theme: Theme,
): string {
	const label = viewData.name ? ` autoresearch: ${viewData.name} ` : " autoresearch ";
	const status = viewData.autoresearchMode
		? viewData.totalRunCount === 0
			? "baseline pending"
			: "mode on"
		: viewData.currentSegmentRunCount > 0 &&
			  viewData.maxExperiments != null &&
			  viewData.currentSegmentRunCount >= viewData.maxExperiments
			? "segment complete"
			: "mode off";
	const hint = theme.fg(
		"dim",
		` ctrl+alt+x collapse  ctrl+alt+shift+x overlay${status ? `  ${status}` : ""} `,
	);
	const fillWidth = Math.max(0, width - visibleWidth(label) - visibleWidth(hint));
	return truncateToWidth(
		theme.fg("accent", label) + theme.fg("dim", "-".repeat(fillWidth)) + hint,
		width,
	);
}

function renderCompactRunningLine(
	viewData: AutoresearchViewData,
	width: number,
	theme: Theme,
): string {
	const parts = [theme.fg("accent", "autoresearch"), theme.fg("warning", " running...")];

	if (viewData.name) {
		parts.push(theme.fg("dim", ` | ${viewData.name}`));
	}

	if (viewData.runningExperiment) {
		parts.push(theme.fg("dim", ` | ${viewData.runningExperiment.command}`));
	}

	parts.push(theme.fg("dim", "  (waiting for first logged result)"));
	return truncateToWidth(parts.join(""), width);
}

function renderCompactSummary(
	viewData: AutoresearchViewData,
	width: number,
	theme: Theme,
): string {
	const current = currentResults(viewData.results, viewData.currentSegment);
	const discarded = current.filter((result) => result.status === "discard").length;
	const baseline = findBaselineMetric(viewData.results, viewData.currentSegment);
	const baselineSecondary = findBaselineSecondary(
		viewData.results,
		viewData.currentSegment,
		viewData.secondaryMetrics,
	);
	const best = findBestResult(viewData.results, viewData.currentSegment, viewData.bestDirection);
	const displayVal = viewData.bestPrimaryMetric ?? viewData.bestMetric;

	const parts = [
		theme.fg("accent", "autoresearch"),
		theme.fg("muted", ` ${viewData.totalRunCount} runs`),
		theme.fg("success", ` ${viewData.currentSegmentKeptCount} kept`),
	];

	if (discarded > 0) {
		parts.push(theme.fg("warning", ` ${discarded} discarded`));
	}
	if (viewData.currentSegmentCrashedCount > 0) {
		parts.push(theme.fg("error", ` ${viewData.currentSegmentCrashedCount} crashed`));
	}
	if (viewData.currentSegmentChecksFailedCount > 0) {
		parts.push(theme.fg("error", ` ${viewData.currentSegmentChecksFailedCount} checks failed`));
	}

	if (displayVal !== null) {
		parts.push(theme.fg("dim", " | "));
		parts.push(
			theme.fg(
				"warning",
				theme.bold(
					`★ ${viewData.metricName}: ${formatNum(displayVal, viewData.metricUnit)}`,
				),
			),
		);
		if (viewData.bestRunNumber !== null) {
			parts.push(theme.fg("dim", ` #${viewData.bestRunNumber}`));
		}
	}

	if (
		baseline !== null &&
		viewData.bestPrimaryMetric !== null &&
		baseline !== 0 &&
		viewData.bestPrimaryMetric !== baseline
	) {
		const pct = ((viewData.bestPrimaryMetric - baseline) / baseline) * 100;
		const sign = pct > 0 ? "+" : "";
		const color = isImprovement(viewData.bestPrimaryMetric, baseline, viewData.bestDirection)
			? "success"
			: "error";
		parts.push(theme.fg(color, ` (${sign}${pct.toFixed(1)}%)`));
	}

	if (viewData.confidence !== null) {
		const confColor =
			viewData.confidence >= 2.0
				? "success"
				: viewData.confidence >= 1.0
					? "warning"
					: "error";
		parts.push(theme.fg("dim", " | "));
		parts.push(theme.fg(confColor, `conf: ${viewData.confidence.toFixed(1)}x`));
	}

	if (best && viewData.secondaryMetrics.length > 0) {
		for (const metric of viewData.secondaryMetrics) {
			const summary = renderCompactSecondarySummary(
				metric.name,
				best.result.metrics[metric.name],
				baselineSecondary[metric.name],
				metric.unit,
			);
			if (!summary) continue;
			parts.push(theme.fg("dim", "  "));
			parts.push(theme.fg("muted", summary));
		}
	}

	if (viewData.name) {
		parts.push(theme.fg("dim", ` | ${viewData.name}`));
	}

	parts.push(theme.fg("dim", "  (ctrl+alt+x expand • ctrl+alt+shift+x fullscreen)"));
	return truncateToWidth(parts.join(""), width);
}

export function renderWidget(
	viewData: AutoresearchViewData,
	width: number,
	theme: Theme,
	expanded: boolean,
): string {
	if (expanded) {
		return [
			renderExpandedHeader(viewData, width, theme),
			...renderDashboardLines(viewData, width, theme, 8),
		].join("\n");
	}

	if (viewData.runningExperiment && viewData.totalRunCount === 0) {
		return renderCompactRunningLine(viewData, width, theme);
	}

	return renderCompactSummary(viewData, width, theme);
}

export function renderDashboardLines(
	viewData: AutoresearchViewData,
	width: number,
	theme: Theme,
	maxRows: number,
): string[] {
	const results = viewData.results;
	if (results.length === 0) {
		if (viewData.runningExperiment) {
			return [truncateToWidth(`Running: ${viewData.runningExperiment.command}`, width)];
		}
		if (viewData.autoresearchMode) {
			return [
				truncateToWidth("Current segment: 0 runs", width),
				truncateToWidth("Baseline: pending", width),
				truncateToWidth("Next action: run and log the baseline experiment.", width),
			];
		}
		return [theme.fg("dim", "No experiments logged yet.")];
	}

	const current = currentResults(results, viewData.currentSegment);
	const kept = current.filter((r) => r.status === "keep").length;
	const discarded = current.filter((r) => r.status === "discard").length;
	const crashed = current.filter((r) => r.status === "crash").length;
	const checksFailed = current.filter((r) => r.status === "checks_failed").length;
	const baseline = findBaselineMetric(results, viewData.currentSegment);
	const baselineRunNumber = findBaselineRunNumber(results, viewData.currentSegment);
	const baselineSecondary = findBaselineSecondary(
		results,
		viewData.currentSegment,
		viewData.secondaryMetrics,
	);
	const best = findBestResult(results, viewData.currentSegment, viewData.bestDirection);

	const lines = [
		truncateToWidth(
			`Current segment: ${current.length} runs  ${kept} kept  ${discarded} discarded  ${crashed} crashed  ${checksFailed} checks_failed`,
			width,
		),
		truncateToWidth(
			`Baseline: ${formatNum(baseline, viewData.metricUnit)}${baselineRunNumber ? ` (#${baselineRunNumber})` : ""}`,
			width,
		),
	];
	if (results.length > current.length) {
		lines.push(
			truncateToWidth(
				`Archived from earlier segments: ${results.length - current.length} runs`,
				width,
			),
		);
	}
	if (viewData.runningExperiment) {
		lines.push(
			truncateToWidth(
				`Pending run: #${viewData.runningExperiment.runNumber} — running`,
				width,
			),
		);
	}
	if (!viewData.autoresearchMode) {
		const status = viewData.autoresearchMode
			? viewData.totalRunCount === 0
				? "baseline pending"
				: "mode on"
			: viewData.currentSegmentRunCount > 0 &&
				  viewData.maxExperiments != null &&
				  viewData.currentSegmentRunCount >= viewData.maxExperiments
				? "segment complete"
				: "mode off";
		lines.push(truncateToWidth(`Mode: ${status}`, width));
	}
	if (best) {
		const bestRunNumber = best.result.runNumber ?? best.index + 1;
		let progress = `Best: ${formatNum(best.result.metric, viewData.metricUnit)} (#${bestRunNumber})`;
		if (baseline !== null && baseline !== 0 && best.result.metric !== baseline) {
			const delta = ((best.result.metric - baseline) / baseline) * 100;
			const sign = delta > 0 ? "+" : "";
			progress += ` ${sign}${delta.toFixed(1)}%`;
		}
		if (viewData.confidence !== null) {
			progress += `  conf ${viewData.confidence.toFixed(1)}x`;
		}
		lines.push(truncateToWidth(progress, width));
		if (viewData.secondaryMetrics.length > 0) {
			const details = viewData.secondaryMetrics
				.map((metric) =>
					renderSecondarySummary(
						metric.name,
						best.result.metrics[metric.name],
						baselineSecondary[metric.name],
						metric.unit,
					),
				)
				.filter((value): value is string => Boolean(value));
			if (details.length > 0) {
				lines.push(truncateToWidth(`Secondary: ${details.join("  ")}`, width));
			}
		}
	}
	lines.push("");
	lines.push(renderTableHeader(viewData, width, theme));
	lines.push(theme.fg("dim", "-".repeat(Math.max(0, width - 1))));

	const visible = maxRows > 0 ? results.slice(-maxRows) : results;
	if (visible.length < results.length) {
		lines.push(
			theme.fg("dim", `... ${results.length - visible.length} earlier runs hidden ...`),
		);
	}
	for (const result of visible) {
		lines.push(renderResultRow(result, viewData, baselineSecondary, width, theme));
	}
	return lines;
}

function renderTableHeader(viewData: AutoresearchViewData, width: number, theme: Theme): string {
	const secondaryHeader = viewData.secondaryMetrics
		.map((metric) => truncateToWidth(metric.name, 10))
		.join(" ");
	return truncateToWidth(
		`${theme.fg("muted", "#".padEnd(4))}${theme.fg("muted", "commit".padEnd(10))}${theme.fg("warning", viewData.metricName.padEnd(12))}${secondaryHeader ? `${theme.fg("muted", secondaryHeader)} ` : ""}${theme.fg("muted", "status".padEnd(14))}${theme.fg("muted", "description")}`,
		width,
	);
}

function renderResultRow(
	result: ExperimentResult,
	viewData: AutoresearchViewData,
	baselineSecondary: Record<string, number>,
	width: number,
	theme: Theme,
): string {
	const runNumber = result.runNumber ?? viewData.results.indexOf(result) + 1;
	const isOld = result.segment !== viewData.currentSegment;
	const commitValue = isOld ? "(old)" : result.status === "keep" ? result.commit || "-" : "-";
	const secondary = viewData.secondaryMetrics
		.map((metric) =>
			truncateToWidth(
				renderSecondaryCell(
					result.metrics[metric.name],
					metric.unit,
					isOld ? undefined : baselineSecondary[metric.name],
				),
				10,
			).padEnd(11),
		)
		.join("");
	const statusColor = isOld
		? "dim"
		: result.status === "keep"
			? "success"
			: result.status === "discard"
				? "warning"
				: "error";
	const line =
		`${theme.fg("dim", String(runNumber).padEnd(4))}` +
		`${theme.fg(isOld ? "dim" : "accent", commitValue.padEnd(10))}` +
		`${theme.fg(statusColor, formatNum(result.metric, viewData.metricUnit).padEnd(12))}` +
		`${secondary}` +
		`${theme.fg(statusColor, result.status.padEnd(14))}` +
		`${theme.fg(isOld ? "dim" : "muted", result.description)}`;
	return truncateToWidth(line, width);
}

function renderSecondaryCell(
	value: number | undefined,
	unit: string,
	baseline: number | undefined,
): string {
	if (value === undefined) return "-";
	const formatted = formatNum(value, unit);
	if (baseline === undefined || baseline === 0 || baseline === value) return formatted;
	const delta = ((value - baseline) / baseline) * 100;
	const sign = delta > 0 ? "+" : "";
	return `${formatted} ${sign}${delta.toFixed(1)}%`;
}

function renderSecondarySummary(
	name: string,
	value: number | undefined,
	baseline: number | undefined,
	unit: string,
): string | null {
	if (value === undefined) return null;
	if (baseline === undefined || baseline === 0 || baseline === value) {
		return `${name} ${formatNum(value, unit)}`;
	}
	const delta = ((value - baseline) / baseline) * 100;
	const sign = delta > 0 ? "+" : "";
	return `${name} ${formatNum(value, unit)} ${sign}${delta.toFixed(1)}%`;
}

function renderCompactSecondarySummary(
	name: string,
	value: number | undefined,
	baseline: number | undefined,
	unit: string,
): string | null {
	if (value === undefined) return null;
	if (baseline === undefined || baseline === 0 || baseline === value) {
		return `${name}: ${formatNum(value, unit)}`;
	}
	const delta = ((value - baseline) / baseline) * 100;
	const sign = delta > 0 ? "+" : "";
	return `${name}: ${formatNum(value, unit)} ${sign}${delta.toFixed(1)}%`;
}

export function renderOverlayRunningLine(
	viewData: AutoresearchViewData,
	theme: Theme,
	width: number,
	spinnerFrame: number,
): string {
	const spinner = ["|", "/", "-", "\\"][spinnerFrame % 4] ?? "*";
	const elapsed = viewData.runningExperiment
		? formatElapsed(Date.now() - viewData.runningExperiment.startedAt)
		: "0s";
	return truncateToWidth(
		theme.fg(
			"warning",
			`${spinner} running ${elapsed} ${viewData.runningExperiment?.command ?? ""}`,
		),
		width,
	);
}

export function renderOverlayFooter(
	width: number,
	scrollOffset: number,
	viewportRows: number,
	totalRows: number,
	theme: Theme,
): string {
	const position =
		totalRows > viewportRows
			? ` ${scrollOffset + 1}-${Math.min(totalRows, scrollOffset + viewportRows)}/${totalRows}`
			: "";
	const hint = theme.fg("dim", ` j/k u/d g/G esc/q${position} `);
	const fill = Math.max(0, width - visibleWidth(hint));
	return theme.fg("dim", "-".repeat(fill)) + hint;
}

function isImprovement(current: number, baseline: number, direction: "lower" | "higher"): boolean {
	return direction === "lower" ? current < baseline : current > baseline;
}
