import { Text } from "@earendil-works/pi-tui";
import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { Option } from "effect";

import type { RunDetails, BenchmarkProgress } from "../services/autoresearch.js";
import { EXPERIMENT_MAX_BYTES, formatNum } from "./helpers.js";

const PREVIEW_LINES = 5;
const EXPANDED_PARTIAL_LINES = 20;

type RenderableResult = {
	readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
	readonly details?: unknown;
};

export function renderRunExperimentResult(
	result: RenderableResult,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
): Text {
	if (isPartial) {
		return new Text(renderPartialResult(result, expanded, theme), 0, 0);
	}

	return new Text(renderFinalResult(result, expanded, theme), 0, 0);
}

function renderPartialResult(result: RenderableResult, expanded: boolean, theme: Theme): string {
	const details = result.details as BenchmarkProgress | undefined;
	const elapsed = details?.elapsed ?? "";
	const outputText = result.content[0]?.type === "text" ? result.content[0].text : "";

	let text = theme.fg("warning", `Running${elapsed ? ` ${elapsed}` : ""}...`);
	if (!outputText) return text;

	const lines = outputText.split("\n");
	const maxLines = expanded ? EXPANDED_PARTIAL_LINES : PREVIEW_LINES;
	const tail = lines.slice(-maxLines).join("\n");
	if (tail.trim()) {
		text += "\n" + theme.fg("dim", tail);
	}
	return text;
}

function renderFinalResult(result: RenderableResult, expanded: boolean, theme: Theme): string {
	const details = result.details as RunDetails | undefined;
	if (!details) {
		const message = result.content[0];
		return message?.type === "text" ? (message.text ?? "") : "";
	}

	const parsedSuffix =
		details.parsedPrimary !== null
			? theme.fg("accent", `, ${details.metricName}: ${formatNum(details.parsedPrimary, details.metricUnit)}`)
			: "";

	if (details.timedOut) {
		return appendOutput(
			theme.fg("error", `TIMEOUT ${details.durationSeconds.toFixed(1)}s`),
			details.tailOutput,
			expanded,
			theme,
		);
	}

	if (details.checksTimedOut) {
		let text =
			theme.fg("success", `wall: ${details.durationSeconds.toFixed(1)}s`) +
			parsedSuffix +
			theme.fg("error", ` checks timeout ${details.checksDuration.toFixed(1)}s`);
		text = appendOutput(text, details.checksOutput, expanded, theme);
		return text;
	}

	if (details.checksPass === false) {
		let text =
			theme.fg("success", `wall: ${details.durationSeconds.toFixed(1)}s`) +
			parsedSuffix +
			theme.fg("error", ` checks failed ${details.checksDuration.toFixed(1)}s`);
		text = appendOutput(text, details.tailOutput, expanded, theme);
		if (details.checksOutput) {
			text += "\n" + theme.fg("dim", details.checksOutput);
		}
		text = appendTruncationNotice(text, details, expanded, theme);
		return text;
	}

	if (details.crashed) {
		let text =
			theme.fg("error", `FAIL exit=${details.exitCode} ${details.durationSeconds.toFixed(1)}s`) + parsedSuffix;
		text = appendOutput(text, details.tailOutput, expanded, theme);
		text = appendTruncationNotice(text, details, expanded, theme);
		return text;
	}

	const parts = [`wall: ${details.durationSeconds.toFixed(1)}s`];
	if (details.parsedPrimary !== null) {
		parts.push(`${details.metricName}: ${formatNum(details.parsedPrimary, details.metricUnit)}`);
	}

	let text = theme.fg("accent", parts.join(", "));
	if (details.checksPass === true) {
		text += theme.fg("success", ` checks ${details.checksDuration.toFixed(1)}s`);
	}
	if (details.truncation !== null && Option.isSome(details.fullOutputPath)) {
		text += theme.fg("warning", " (truncated)");
	}

	text = appendOutput(text, details.tailOutput, expanded, theme);
	text = appendTruncationNotice(text, details, expanded, theme);
	return text;
}

function appendOutput(text: string, output: string, expanded: boolean, theme: Theme): string {
	if (!output) return text;
	const lines = output.split("\n");
	if (expanded) {
		return `${text}\n${theme.fg("dim", output)}`;
	}

	const tail = lines.slice(-PREVIEW_LINES).join("\n");
	if (!tail.trim()) return text;

	const hidden = lines.length - PREVIEW_LINES;
	if (hidden > 0) {
		text += "\n" + theme.fg("muted", `... ${hidden} more lines`);
	}
	text += "\n" + theme.fg("dim", tail);
	return text;
}

function appendTruncationNotice(
	text: string,
	details: RunDetails,
	expanded: boolean,
	theme: Theme,
): string {
	if (details.truncation === null || Option.isNone(details.fullOutputPath)) {
		return text;
	}

	if (!expanded) {
		return text;
	}

	if (details.truncation.truncatedBy === "lines") {
		return (
			text +
			"\n" +
			theme.fg(
				"warning",
				`[Truncated: showing ${details.truncation.outputLines} of ${details.truncation.totalLines} lines. Full output: ${details.fullOutputPath.value}]`,
			)
		);
	}

	return (
		text +
		"\n" +
		theme.fg(
			"warning",
			`[Truncated: ${details.truncation.outputLines} lines shown (${formatSize(EXPERIMENT_MAX_BYTES)} limit). Full output: ${details.fullOutputPath.value}]`,
		)
	);
}
