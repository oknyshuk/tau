import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";

import type {
	MemoryBucketEntriesSnapshot,
	MemoryBucketSnapshot,
	MemoryEntriesSnapshot,
	MemoryEntry,
	MemoryRepairIssue,
	MemoryScope,
} from "./format.js";

export type MemoryToolAction = "add" | "update" | "remove" | "read";

export type MemoryToolDetails = {
	readonly success: boolean;
	readonly action?: MemoryToolAction;
	readonly scope?: MemoryScope;
	readonly entry?: MemoryEntry;
	readonly bucket?: MemoryBucketSnapshot;
	readonly requestedId?: string;
	readonly submittedSummary?: string;
	readonly submittedContent?: string;
};

export type MemoriesMessageDetails = {
	readonly snapshot: MemoryEntriesSnapshot;
	readonly issues?: readonly MemoryRepairIssue[];
};

type MemoryToolResult = {
	readonly content?: readonly { readonly type: string; readonly text?: string }[];
	readonly details?: unknown;
};

const SEPARATOR =
	"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

function firstTextContent(result: MemoryToolResult): string {
	const text = result.content?.find((item) => item.type === "text");
	return text?.text ?? "";
}

function previewContent(value: string, maxChars = 96): string {
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function renderContentBlock(value: string, theme: Theme): string {
	const lines = value.replace(/\r\n?/gu, "\n").split("\n");
	return [`${theme.fg("muted", "content:")}`, ...lines.map((line) => `  ${theme.fg("toolOutput", line)}`)].join("\n");
}

function renderProgressBar(percent: number | undefined, width: number, theme: Theme): string {
	if (typeof percent !== "number") {
		return `${theme.fg("muted", "[")}${theme.fg("dim", "?".repeat(width))}${theme.fg("muted", "]")}`;
	}

	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * width);
	const empty = Math.max(0, width - filled);
	const tone = clamped >= 90 ? "error" : clamped >= 75 ? "warning" : "success";

	return [
		theme.fg("muted", "["),
		theme.fg(tone, "█".repeat(filled)),
		theme.fg("dim", "░".repeat(empty)),
		theme.fg("muted", "]"),
	].join("");
}

function actionLabel(action: MemoryToolAction | undefined): string {
	switch (action) {
		case "add":
			return "memory add";
		case "update":
			return "memory update";
		case "remove":
			return "memory remove";
		case "read":
			return "memory read";
		default:
			return "memory";
	}
}

function scopeText(scope: MemoryScope | undefined, theme: Theme): string {
	if (!scope) {
		return theme.fg("dim", "unknown");
	}

	const tone = scope === "user" ? "warning" : scope === "global" ? "success" : "accent";
	return theme.fg(tone, scope);
}

function scopeColumn(scope: MemoryScope, theme: Theme): string {
	if (scope === "user") {
		return theme.fg("warning", scope.padEnd(7));
	}
	if (scope === "global") {
		return theme.fg("success", scope.padEnd(7));
	}
	return theme.fg("accent", scope.padEnd(7));
}

interface MemoriesSummaryWidths {
	readonly entries: number;
	readonly chars: number;
}

function computeSummaryWidths(snapshot: MemoryEntriesSnapshot): MemoriesSummaryWidths {
	const buckets = [snapshot.project, snapshot.global, snapshot.user] as const;
	return {
		entries: Math.max(...buckets.map((bucket) => `${bucket.entries.length} entries`.length)),
		chars: Math.max(...buckets.map((bucket) => `${bucket.chars}/${bucket.limitChars} chars`.length)),
	};
}

function renderBucketSummary(
	bucket: MemoryBucketEntriesSnapshot,
	widths: MemoriesSummaryWidths,
	theme: Theme,
): string {
	const entriesSummary = `${bucket.entries.length} entries`.padStart(widths.entries);
	const charsSummary = `${bucket.chars}/${bucket.limitChars} chars`.padStart(widths.chars);

	return [
		`  ${theme.fg("muted", `${bucket.bucket.padEnd(8)}:`)}`,
		renderProgressBar(bucket.usagePercent, 14, theme),
		theme.fg("toolOutput", entriesSummary),
		theme.fg("dim", `· ${charsSummary}`),
	].join(" ");
}

function flattenEntries(snapshot: MemoryEntriesSnapshot): ReadonlyArray<{
	readonly scope: MemoryScope;
	readonly entry: MemoryEntry;
}> {
	return [snapshot.project, snapshot.global, snapshot.user].flatMap((bucket) =>
		bucket.entries.map((entry) => ({ scope: bucket.bucket, entry })),
	);
}

export function renderMemoriesMessage(details: MemoriesMessageDetails, theme: Theme): Text {
	const buckets = [details.snapshot.project, details.snapshot.global, details.snapshot.user] as const;
	const entries = flattenEntries(details.snapshot);
	const summaryWidths = computeSummaryWidths(details.snapshot);
	const out: string[] = [theme.fg("dim", SEPARATOR)];

	out.push(`\n${theme.fg("toolTitle", theme.bold("memories"))}`);
	for (const bucket of buckets) {
		out.push(`\n${renderBucketSummary(bucket, summaryWidths, theme)}`);
	}

	if ((details.issues?.length ?? 0) > 0) {
		out.push(
			`\n\n  ${theme.fg("warning", "repair".padEnd(8))}: ${theme.fg(
				"toolOutput",
				`${details.issues!.length} entries have summary equal to content. Use memory read + memory update to give each one a distinct summary hook.`,
			)}`,
		);
		for (const issue of details.issues ?? []) {
			out.push(
				`\n  ${theme.fg("warning", issue.id)}  ${scopeColumn(issue.scope, theme)}  ${theme.fg("dim", "summary duplicates content")}`,
			);
		}
	}

	out.push(
		`\n\n  ${theme.fg("dim", "id".padEnd(21))}  ${theme.fg("dim", "size".padStart(9))}  ${theme.fg("dim", "scope".padEnd(7))}  ${theme.fg("dim", "type".padEnd(10))}  ${theme.fg("dim", "summary")}`,
	);

	if (entries.length === 0) {
		out.push(`\n  ${theme.fg("muted", "No saved memories.")}`);
		return new Text(out.join(""), 0, 0);
	}

	for (const { scope, entry } of entries) {
		const size = `${entry.content.length} chars`.padStart(9);
		const typeCol = entry.type.padEnd(10);
		out.push(
			`\n  ${theme.fg("accent", entry.id)}  ${theme.fg("muted", size)}  ${scopeColumn(scope, theme)}  ${theme.fg("muted", typeCol)}  ${theme.fg("toolOutput", previewContent(entry.summary, 72))}`,
		);
	}

	return new Text(out.join(""), 0, 0);
}

function renderSuccess(details: MemoryToolDetails, message: string, theme: Theme): Text {
	const entry = details.entry;
	const bucket = details.bucket;
	const resolvedScope = details.scope ?? entry?.scope;
	const out: string[] = [theme.fg("dim", SEPARATOR)];

	out.push(`\n${theme.fg("success", "✔")} ${theme.fg("toolTitle", theme.bold(actionLabel(details.action)))}`);
	if (message) {
		out.push(`\n${theme.fg("muted", message.split("\n")[0] ?? message)}`);
	}

	if (entry) {
		out.push(`\n  ${theme.fg("muted", "id".padEnd(8))}: ${theme.fg("accent", entry.id)}`);
		out.push(`\n  ${theme.fg("muted", "scope".padEnd(8))}: ${scopeText(resolvedScope, theme)}`);
		out.push(`\n  ${theme.fg("muted", "type".padEnd(8))}: ${theme.fg("toolOutput", entry.type)}`);
		out.push(`\n  ${theme.fg("muted", "summary".padEnd(8))}: ${theme.fg("toolOutput", entry.summary)}`);
		out.push(
			`\n  ${theme.fg("muted", "size".padEnd(8))}: ${theme.fg("toolOutput", `${entry.content.length} chars`)}`,
		);
		out.push(`\n${renderContentBlock(entry.content, theme)}`);
	}

	if (bucket) {
		const percent = typeof bucket.usagePercent === "number" ? bucket.usagePercent : undefined;
		out.push(
			`\n  ${theme.fg("muted", "usage".padEnd(8))}: ${renderProgressBar(percent, 20, theme)} ${theme.fg(
				"toolOutput",
				typeof percent === "number" ? `${percent}%` : "unknown",
			)}`,
		);
		out.push(
			`\n  ${theme.fg("muted", "bucket".padEnd(8))}: ${theme.fg("toolOutput", `${bucket.entries.length} entries`)} ${theme.fg("dim", `· limit ${bucket.limitChars} chars`)}`,
		);
	}

	return new Text(out.join(""), 0, 0);
}

function renderFailure(details: MemoryToolDetails, message: string, theme: Theme): Text {
	let out = theme.fg("dim", SEPARATOR);
	out += `\n${theme.fg("error", "✘")} ${theme.fg("toolTitle", theme.bold(actionLabel(details.action)))}`;
	if (details.scope) {
		out += `\n  ${theme.fg("muted", "scope".padEnd(8))}: ${scopeText(details.scope, theme)}`;
	}
	if (details.requestedId) {
		out += `\n  ${theme.fg("muted", "id".padEnd(8))}: ${theme.fg("accent", details.requestedId)}`;
	}
	if (details.submittedSummary) {
		out += `\n  ${theme.fg("muted", "summary".padEnd(8))}: ${theme.fg("toolOutput", previewContent(details.submittedSummary, 120))}`;
	}
	if (details.submittedContent) {
		out += `\n  ${theme.fg("muted", "chars".padEnd(8))}: ${theme.fg("toolOutput", `${details.submittedContent.length}`)}`;
		out += `\n${renderContentBlock(details.submittedContent, theme)}`;
	}
	out += `\n${theme.fg("error", message || "Memory operation failed")}`;
	return new Text(out, 0, 0);
}

export function renderMemoryCall(args: Record<string, unknown> | undefined, theme: Theme): Text {
	void args;
	void theme;
	return new Text("", 0, 0);
}

export function renderMemoryResult(result: MemoryToolResult, theme: Theme) {
	const details = result.details as MemoryToolDetails | undefined;
	const message = firstTextContent(result);

	if (!details) {
		return new Markdown(message, 0, 0, getMarkdownTheme());
	}

	if (!details.success) {
		return renderFailure(details, message, theme);
	}

	if (!details.entry && !details.bucket) {
		return new Markdown(message, 0, 0, getMarkdownTheme());
	}

	return renderSuccess(details, message, theme);
}
