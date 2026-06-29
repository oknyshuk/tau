import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolRenderResultOptions, Theme } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "./status.js";

// Minimal type for render context - only what we need
interface RenderContext {
	readonly cwd: string;
}

function oneLine(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/**
 * Convert absolute paths to relative paths for display.
 * Replaces paths starting with cwd with "." or relative paths.
 */
function makePathsRelative(s: string, cwd: string | undefined): string {
	if (!cwd || !s) return s;
	// Match common path patterns: /home/user/... or just absolute paths
	// This handles paths embedded in args strings
	return s.replace(
		new RegExp(`\\b${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/[^\\s]*)?`, "g"),
		(match, subpath) => subpath ? `.${subpath}` : "."
	);
}

function statusMark(state: string, theme: Theme): string {
	if (state === "completed" || state === "shutdown") return theme.fg("success", "✔");
	if (state === "failed") return theme.fg("error", "✘");
	if (state === "running") {
		return theme.fg("accent", "·");
	}
	return theme.fg("dim", "◦");
}

export function renderAgentCall(args: unknown, theme: Theme) {
	const params = args as Record<string, unknown>;
	const action = params["action"] as string;

	switch (action) {
		case "spawn": {
			const agent = (params["agent"] as string) || "?";
			const msg = (params["message"] as string) || "";
			const preview = truncate(oneLine(msg), 60);
			return new Text(
				`${theme.fg("dim", "⌬")} ${theme.fg("accent", `spawn:${agent}`)} ${theme.fg("dim", `"${preview}"`)}`,
				0,
				0,
			);
		}
		case "wait": {
			const ids = (params["ids"] as string[]) || [];
			const header =
				ids.length === 0
					? "waiting"
					: ids.length === 1
						? "waiting for 1 agent"
						: `waiting for ${ids.length} agents`;
			return new Text(`${theme.fg("dim", "◷")} ${theme.fg("accent", header)}`, 0, 0);
		}
		case "send": {
			const id = (params["id"] as string) || "?";
			const msg = (params["message"] as string) || "";
			const preview = truncate(oneLine(msg), 40);
			return new Text(
				`${theme.fg("dim", "➜")} ${theme.fg("accent", `send:${id}`)} ${theme.fg("dim", `"${preview}"`)}`,
				0,
				0,
			);
		}
		case "close": {
			const id = (params["id"] as string) || "?";
			return new Text(
				`${theme.fg("dim", "✕")} ${theme.fg("accent", `close:${id}`)}`,
				0,
				0,
			);
		}
		case "list": {
			return new Text(`${theme.fg("dim", "≣")} ${theme.fg("accent", "list")}`, 0, 0);
		}
		default:
			return new Text(`${theme.fg("dim", "⋯")} agent:${action || "?"}`, 0, 0);
	}
}

export function renderAgentResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context?: RenderContext,
) {
	if (typeof result === "object" && result !== null && "isError" in result && result.isError) {
		const first = result.content?.[0];
		const text = first && first.type === "text" ? first.text : "(error)";
		return new Text(theme.fg("error", `✘ error: ${text}`), 0, 0);
	}

	const data = (result.details || result) as Record<string, unknown>;
	const cwd = context?.cwd;

	// Helper to render tool history
	const renderTools = (
		tools: Array<{ name: string; args?: string; result?: string; isError?: boolean }>,
	) => {
		if (tools.length === 0) return "";
		const lines = tools.map((t) => {
			const mark = t.isError ? theme.fg("error", "✘") : theme.fg("dim", "·");
			const name = theme.fg("accent", t.name);
			// Convert absolute paths to relative for display
			const relativeArgs = t.args ? makePathsRelative(t.args, cwd) : undefined;
			// Account for left indentation: 6 spaces + mark + space + name + space
			const prefixLength = 6 + 1 + 1 + t.name.length + 1;
			const args = relativeArgs
				? theme.fg("dim", ` ${truncate(relativeArgs, Math.max(20, 80 - prefixLength)).replace(/ /g, "\u00A0")}`)
				: "";
			return `      ${mark} ${name}${args}`;
		});
		return "\n" + lines.join("\n");
	};

	// Helper to render a single agent status line
	const renderAgentLine = (
		id: string,
		type: string,
		status: Record<string, unknown>,
		expanded: boolean,
	) => {
		const state = (status["state"] as string) || "unknown";
		const workedMs = status["workedMs"] as number | undefined;
		const activeTurnStartedAtMs = status["activeTurnStartedAtMs"] as number | undefined;
		const turns = status["turns"] as number | undefined;
		const toolCalls = status["toolCalls"] as number | undefined;
		const tools = status["tools"] as
			| Array<{ name: string; args?: string; result?: string; isError?: boolean }>
			| undefined;
		const idStr = id;
		const typeStr = type ? `  ${theme.fg("accent", type)}` : "";
		const showLiveTimer = !expanded && state === "running";
		const shownWorkedMs =
			showLiveTimer && activeTurnStartedAtMs !== undefined
				? (workedMs ?? 0) + Math.max(0, Date.now() - activeTurnStartedAtMs)
				: (workedMs ?? 0);
		const workedStr =
			shownWorkedMs > 0
				? `  ${theme.fg("accent", "·")} ${theme.fg("dim", `work:${formatDuration(shownWorkedMs)}`)}`
				: "";
		const countsStr = `  ${theme.fg("dim", `t:${turns ?? 0} • c:${toolCalls ?? 0}`)}`;

		let line = `  ${statusMark(state, theme)} ${theme.fg("accent", idStr)}${typeStr}${countsStr}${workedStr}`;

		if (status["reason"]) {
			line += `\n    ${theme.fg("error", `✘ ${status["reason"]}`)}`;
		}
		// Show tool history when expanded
		if (expanded && tools && tools.length > 0) {
			line += `\n    ${theme.fg("dim", `${tools.length} tools:`)}${renderTools(tools)}`;
		}
		// Show message summary last (it's the agent's final message)
		if (expanded && status["message"]) {
			line += `\n    ${theme.fg("dim", "↩ ")}${theme.fg("toolOutput", truncate(oneLine(status["message"] as string), 140))}`;
		}
		return line;
	};

	// spawn
	if (data["agent_id"] && data["status"] === "running") {
		const idStr = data["agent_id"] as string;
		const msg = data["message"] as string | undefined;
		if (options.expanded && msg) {
			return new Text(
				`${theme.fg("success", "✔")} ${theme.fg("accent", idStr)} ${theme.fg("dim", "(running)")}\n${theme.fg("dim", "task:")} ${msg}`,
				0,
				0,
			);
		}
		return new Text(
			`${theme.fg("success", "✔")} ${theme.fg("accent", idStr)} ${theme.fg("dim", "(running)")}`,
			0,
			0,
		);
	}

	// send
	if (data["submission_id"]) {
		const submissionId = data["submission_id"] as string;
		const agentId =
			typeof data["agent_id"] === "string" ? (data["agent_id"] as string) : undefined;
		const message =
			typeof data["message"] === "string" ? (data["message"] as string) : undefined;
		if (options.expanded && message) {
			const targetLine = agentId
				? `\n${theme.fg("dim", "to:")} ${theme.fg("accent", agentId)}`
				: "";
			return new Text(
				`${theme.fg("success", "✔")} submission: ${theme.fg("dim", submissionId)}${targetLine}\n${theme.fg("dim", "message:")} ${theme.fg("toolOutput", message)}`,
				0,
				0,
			);
		}
		return new Text(
			`${theme.fg("success", "✔")} submission: ${theme.fg("dim", submissionId)}`,
			0,
			0,
		);
	}

	// close
	if (data["status"] === "closed") {
		return new Text(`${theme.fg("success", "✔")} shutdown`, 0, 0);
	}

	// list
	if (Array.isArray(data["agents"])) {
		const agents = data["agents"] as Array<{
			id: string;
			type: string;
			status: Record<string, unknown>;
		}>;
		// Sort: running agents at the bottom, then by id for stability
		const sortedAgents = [...agents].sort((a, b) => {
			const aRunning = a.status["state"] === "running" ? 1 : 0;
			const bRunning = b.status["state"] === "running" ? 1 : 0;
			if (aRunning !== bRunning) return aRunning - bRunning;
			return a.id.localeCompare(b.id);
		});
		const lines = [];
		for (const a of sortedAgents) {
			lines.push(renderAgentLine(a.id, a.type, a.status, options.expanded));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	// wait
	if (data["status"] && typeof data["status"] === "object") {
		const statusMap = data["status"] as Record<string, Record<string, unknown>>;
		const agentTypes = data["agentTypes"] as Record<string, string> | undefined;
		const ids = Object.keys(statusMap);
		const timedOut = data["timedOut"] as boolean | undefined;
		const interrupted = data["interrupted"] as boolean | undefined;
		const timeoutMs =
			typeof data["timeoutMs"] === "number" ? (data["timeoutMs"] as number) : undefined;
		const waitElapsedMs =
			typeof data["waitElapsedMs"] === "number"
				? (data["waitElapsedMs"] as number)
				: undefined;
		const lines: string[] = [];

		// Show message for no agents
		if (ids.length === 0) {
			return new Text(
				theme.fg(
					"dim",
					"No active agents to wait for. Use 'spawn' to create agents first, or 'list' to see existing agents.",
				),
				0,
				0,
			);
		}

		// Show interruption warning if applicable
		if (interrupted) {
			const waitedSuffix =
				waitElapsedMs !== undefined ? ` after ${formatDuration(waitElapsedMs)}` : "";
			lines.push(
				theme.fg(
					"warning",
					`⚠ Interrupted${waitedSuffix} (agents still running in background)`,
				),
			);
		}

		// Show timeout warning if applicable
		if (timedOut) {
			const timeoutSuffix = timeoutMs !== undefined ? ` after ${formatDuration(timeoutMs)}` : "";
			const waitedSuffix =
				waitElapsedMs !== undefined && (timeoutMs === undefined || waitElapsedMs !== timeoutMs)
					? ` (waited ${formatDuration(waitElapsedMs)})`
					: "";
			lines.push(
				theme.fg("warning", `⚠ Timed out waiting for agents${timeoutSuffix}${waitedSuffix}`),
			);
		}

		// Sort: running agents at the bottom, then by id for stability
		const sortedIds = [...ids].sort((a, b) => {
			const aRunning = statusMap[a]!["state"] === "running" ? 1 : 0;
			const bRunning = statusMap[b]!["state"] === "running" ? 1 : 0;
			if (aRunning !== bRunning) return aRunning - bRunning;
			return a.localeCompare(b);
		});

		for (const id of sortedIds) {
			const type = agentTypes?.[id] ?? "";
			lines.push(renderAgentLine(id, type, statusMap[id]!, options.expanded));
		}
		return new Text(lines.join("\n"), 0, 0);
	}

	return new Text(JSON.stringify(data, null, 2), 0, 0);
}
