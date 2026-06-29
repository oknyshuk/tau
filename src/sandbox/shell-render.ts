import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { ShellRunResult } from "../services/shell.js";
import { isRecord } from "../shared/json.js";

export type ShellToolDetails = ShellRunResult & {
	readonly kind: "exec_command" | "write_stdin";
	readonly command?: string;
	readonly sessionId?: number;
	readonly writtenChars?: number;
	readonly writtenText?: string;
};

const COMPACT_OUTPUT_LINES = 8;
const COMPACT_OUTPUT_LINE_CHARS = 200;
const EXPANDED_OUTPUT_LINES = 200;
const MAX_COMMAND_CHARS = 120;
const ANSI_ESCAPE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");


function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function numberField(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function readTextContent(result: unknown): string | undefined {
	if (!isRecord(result)) return undefined;
	const content = result["content"];
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const item of content) {
		if (!isRecord(item)) continue;
		if (item["type"] === "text" && typeof item["text"] === "string") {
			parts.push(item["text"]);
		}
	}
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function readDetails(result: unknown): ShellToolDetails | undefined {
	if (!isRecord(result)) return undefined;
	const details = result["details"];
	if (!isRecord(details)) return undefined;
	const kind = details["kind"];
	if (kind !== "exec_command" && kind !== "write_stdin") return undefined;
	const output = stringField(details, "output") ?? readTextContent(result) ?? "";
	const sessionId = numberField(details, "sessionId");
	const exitCode = numberField(details, "exitCode");
	const command = stringField(details, "command");
	const writtenChars = numberField(details, "writtenChars");
	const writtenText = stringField(details, "writtenText");
	return {
		kind,
		output,
		...(sessionId === undefined ? {} : { sessionId }),
		...(exitCode === undefined ? {} : { exitCode }),
		...(command === undefined ? {} : { command }),
		...(writtenChars === undefined ? {} : { writtenChars }),
		...(writtenText === undefined ? {} : { writtenText }),
	};
}

function tailLines(output: string, maxLines: number): { readonly lines: readonly string[]; readonly omitted: number } {
	const lines = output.length === 0 ? [] : output.replace(/\n$/, "").split(/\r?\n/);
	if (lines.length <= maxLines) return { lines, omitted: 0 };
	return { lines: lines.slice(-maxLines), omitted: lines.length - maxLines };
}

function stripAnsi(value: string): string {
	return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function normalizeTerminalOutput(value: string): string {
	return stripAnsi(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripWrittenEcho(output: string, writtenText: string | undefined): string {
	if (writtenText === undefined || writtenText.length === 0) return output;
	const command = writtenText.replace(/\r/g, "\n").trim();
	if (command.length === 0) return output;
	const lines = output.split(/\n/);
	while (lines.length > 0 && lines[0]?.trim() === "") {
		lines.shift();
	}
	if (lines[0]?.trim() === command) {
		lines.shift();
	}
	return lines.join("\n").trimStart();
}

function isPoll(details: ShellToolDetails): boolean {
	return details.kind === "write_stdin" && (details.writtenChars ?? 0) === 0;
}

function statusParts(details: ShellToolDetails): { readonly mark: string; readonly ok: boolean | undefined } {
	if (details.sessionId !== undefined) {
		return { mark: "↪", ok: undefined };
	}
	if (details.exitCode === 0) {
		return { mark: "✓", ok: true };
	}
	if (details.exitCode !== undefined) {
		return { mark: "✗", ok: false };
	}
	return { mark: "✓", ok: true };
}

function renderOutput(
	output: string,
	expanded: boolean,
	theme: Theme,
	options?: { readonly writtenText?: string | undefined; readonly poll?: boolean | undefined },
): string {
	const cleaned = stripWrittenEcho(normalizeTerminalOutput(output), options?.writtenText).trimEnd();
	if (cleaned.length === 0) {
		return theme.fg("dim", options?.poll === true ? "  (still running; no new output)" : "  (no output)");
	}
	const maxLines = expanded ? EXPANDED_OUTPUT_LINES : COMPACT_OUTPUT_LINES;
	const { lines, omitted } = tailLines(cleaned, maxLines);
	let rendered = "";
	if (omitted > 0) {
		rendered += `${theme.fg("muted", `  … ${omitted} earlier lines (Ctrl+O expands)`)}\n`;
	}
	const outputLines = expanded ? lines : lines.map((line) => truncate(line, COMPACT_OUTPUT_LINE_CHARS));
	rendered += outputLines.map((line) => theme.fg("toolOutput", `  ${line}`)).join("\n");
	return rendered;
}

function renderCallLine(theme: Theme, title: string, inline: string, status: string): string {
	return (
		`${theme.fg("accent", "⋯")} ${theme.fg("toolTitle", title)} ` +
		`${theme.fg("muted", "·")} ${theme.fg("toolOutput", inline)}` +
		`${theme.fg("dim", `  (${status})`)}`
	);
}

export function renderShellCall(
	args: unknown,
	theme: Theme,
	context?: { readonly isPartial: boolean },
): Text {
	// Once the final result is in, the result renderer carries the command and
	// status, so rendering the call too would duplicate it. While the call is
	// still in flight (isPartial), render a progress line so long-running commands
	// and polls don't make pi look like it has hung with nothing on screen.
	if (context?.isPartial === false) {
		return new Text("", 0, 0);
	}
	const record = isRecord(args) ? args : {};
	const cmd = stringField(record, "cmd");
	if (cmd !== undefined) {
		const inline = truncate(oneLine(cmd), MAX_COMMAND_CHARS);
		return new Text(renderCallLine(theme, "exec_command", inline, "running…"), 0, 0);
	}
	const sessionId = numberField(record, "session_id");
	const chars = stringField(record, "chars");
	if (chars === undefined || chars.length === 0) {
		const inline = sessionId !== undefined ? `session ${sessionId}` : "no input";
		return new Text(renderCallLine(theme, "poll", inline, "waiting for output…"), 0, 0);
	}
	const inline = truncate(oneLine(chars), MAX_COMMAND_CHARS);
	return new Text(renderCallLine(theme, "stdin", inline, "running…"), 0, 0);
}

function renderShellCallInline(details: ShellToolDetails, expanded: boolean): string {
	if (details.kind === "exec_command") {
		return truncate(oneLine(details.command ?? "exec_command"), expanded ? 400 : MAX_COMMAND_CHARS);
	}

	if (isPoll(details)) {
		if (details.sessionId !== undefined) {
			return `session ${details.sessionId}`;
		}
		return "no input";
	}

	const written = details.writtenText?.trim();
	if (written !== undefined && written.length > 0) {
		return truncate(oneLine(written), expanded ? 400 : MAX_COMMAND_CHARS);
	}
	if (details.sessionId !== undefined) {
		return `session ${details.sessionId}`;
	}
	return "stdin";
}

function renderShellMetadata(details: ShellToolDetails, theme: Theme): string {
	const lines: string[] = [];
	if (details.exitCode !== undefined) {
		lines.push(`  ${theme.fg("muted", "exit:")} ${theme.fg(details.exitCode === 0 ? "success" : "error", String(details.exitCode))}`);
	}
	if (details.sessionId !== undefined) {
		lines.push(`  ${theme.fg("muted", "session:")} ${theme.fg("accent", String(details.sessionId))}`);
	}
	if (details.kind === "write_stdin" && details.writtenChars !== undefined && !isPoll(details)) {
		lines.push(`  ${theme.fg("muted", "wrote:")} ${theme.fg("dim", `${details.writtenChars} chars`)}`);
	}
	return lines.join("\n");
}

export function renderShellResult(result: unknown, options: ToolRenderResultOptions, theme: Theme): Text {
	if (options.isPartial) {
		return new Text(theme.fg("warning", "shell running…"), 0, 0);
	}

	const details = readDetails(result);
	if (!details) {
		return new Text(theme.fg("dim", readTextContent(result) ?? "(no shell details)"), 0, 0);
	}

	const poll = isPoll(details);
	const title = details.kind === "exec_command" ? "exec_command" : poll ? "poll" : "stdin";
	const status = statusParts(details);
	const mark =
		status.ok === true
			? theme.fg("success", status.mark)
			: status.ok === false
				? theme.fg("error", status.mark)
				: theme.fg("accent", status.mark);
	const inline = renderShellCallInline(details, options.expanded);
	const metadata = renderShellMetadata(details, theme);
	let output = `${mark} ${theme.fg("toolTitle", title)} ${theme.fg("muted", "·")} ${theme.fg("toolOutput", inline)}`;
	if (metadata.length > 0) {
		output += `\n${metadata}`;
	}
	output += `\n\n${renderOutput(details.output, options.expanded, theme, { writtenText: details.writtenText, poll })}`;
	return new Text(output, 0, 0);
}
