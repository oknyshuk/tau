import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { Message } from "@earendil-works/pi-ai";

import { formatDuration } from "../shared/format-duration.js";
import type { TauPersistedState } from "../shared/state.js";

const WORKED_FOR_MESSAGE_TYPE = "tau:worked-for";

type WorkedForDetails = {
	elapsedMs: number;
};

type WorkedForState = {
	enabled?: boolean;
	toolsEnabled?: boolean;
};

class WorkedForSeparator implements Component {
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(
		private durationText: string,
		private theme: Theme,
	) {}

	setDurationText(durationText: string): void {
		if (durationText === this.durationText) return;
		this.durationText = durationText;
		this.invalidate();
	}

	render(width: number): string[] {
		if (width <= 0) return [""];
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;

		const label = ` Worked for ${this.durationText} `;
		let line = `─${label}`;

		const remaining = width - visibleWidth(line);
		if (remaining > 0) {
			line += "─".repeat(remaining);
		} else if (visibleWidth(line) > width) {
			// Safe because label uses ASCII digits/spaces.
			line = line.slice(0, width);
		}

		this.cachedWidth = width;
		this.cachedLines = [this.theme.fg("dim", line)];
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}
}

class WorkedForWidget implements Component {
	private separator: WorkedForSeparator;

	constructor(durationText: string, theme: Theme) {
		this.separator = new WorkedForSeparator(durationText, theme);
	}

	setDurationText(durationText: string): void {
		this.separator.setDurationText(durationText);
	}

	render(width: number): string[] {
		// Add one empty row of padding below the separator to visually separate it from the editor.
		return [...this.separator.render(width), ""];
	}

	invalidate(): void {
		this.separator.invalidate();
	}
}

function parseToggleArg(mode: string, current: boolean): boolean | undefined {
	if (mode === "on") return true;
	if (mode === "off") return false;
	if (mode === "toggle") return !current;
	return undefined;
}

interface PersistedAccess {
	readonly getSnapshot: () => TauPersistedState;
	readonly update: (patch: Partial<TauPersistedState>) => void;
}

export default function initWorkedFor(pi: ExtensionAPI, persistence: PersistedAccess) {
	function isEnabled(): boolean {
		return persistence.getSnapshot().workedFor?.enabled ?? true;
	}

	function areToolsEnabled(): boolean {
		return persistence.getSnapshot().workedFor?.toolsEnabled ?? true;
	}

	// Start time for the current user prompt (one agent run).
	// This must NOT reset per internal turn/tool call.
	let promptStartTimestamp: number | undefined;
	let agentRunning = false;
	let lastRenderedDurationText: string | undefined;

	let tickInterval: ReturnType<typeof setInterval> | undefined;
	let tickCtx: ExtensionContext | undefined;
	let widgetMounted = false;
	let widgetComponent: WorkedForWidget | undefined;
	let widgetTui: TUI | undefined;

	function clearWorkedForWidget(ctx: ExtensionContext): void {
		widgetMounted = false;
		widgetComponent = undefined;
		widgetTui = undefined;
		if (ctx.hasUI) ctx.ui.setWidget("worked-for-separator", undefined);
	}

	function stopTick(): void {
		if (tickInterval) clearInterval(tickInterval);
		tickInterval = undefined;
		tickCtx = undefined;
	}

	function renderWorkedForWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!isEnabled()) return;
		if (promptStartTimestamp === undefined) return;
		const elapsedMs = Math.max(0, Date.now() - promptStartTimestamp);
		const durationText = formatDuration(elapsedMs);
		if (durationText === lastRenderedDurationText && widgetMounted) return;
		lastRenderedDurationText = durationText;

		if (widgetMounted) {
			widgetComponent?.setDurationText(durationText);
			widgetTui?.requestRender();
			return;
		}

		// Widgets do not participate in LLM context and won't enqueue follow-ups.
		ctx.ui.setWidget("worked-for-separator", (tui, theme) => {
			widgetTui = tui;
			widgetComponent = new WorkedForWidget(durationText, theme);
			return widgetComponent;
		});
		widgetMounted = true;
	}

	function startTick(ctx: ExtensionContext): void {
		stopTick();
		tickCtx = ctx;
		// Update like the "Working..." indicator: periodically re-render while the agent is running.
		// formatDuration() only changes once per second, so this is cheap.
		tickInterval = setInterval(() => {
			if (!agentRunning || !tickCtx) return;
			renderWorkedForWidget(tickCtx);
		}, 250);
	}

	function sendWorkedForSeparator(ctx: ExtensionContext): void {
		if (!isEnabled()) return;
		if (promptStartTimestamp === undefined) return;
		const elapsedMs = Math.max(0, Date.now() - promptStartTimestamp);

		// UI-only history entry (Codex-like). Must not trigger a new turn.
		pi.sendMessage(
			{
				customType: WORKED_FOR_MESSAGE_TYPE,
				content: "",
				display: true,
				details: { elapsedMs } satisfies WorkedForDetails,
			},
			{ triggerTurn: false },
		);

		clearWorkedForWidget(ctx);
	}

	pi.registerMessageRenderer<WorkedForDetails>(
		WORKED_FOR_MESSAGE_TYPE,
		(message, _options, theme) => {
			const elapsedMs =
				typeof message.details?.elapsedMs === "number" ? message.details.elapsedMs : 0;
			return new WorkedForSeparator(formatDuration(elapsedMs), theme);
		},
	);

	pi.on("context", async (event) => {
		// Never send UI-only worked-for separators to the model (old sessions may contain them).
		const filtered = event.messages.filter((m) => {
			if (m && "customType" in m && m.customType === WORKED_FOR_MESSAGE_TYPE) return false;
			return true;
		});
		return { messages: filtered };
	});

	pi.registerCommand("worked", {
		description:
			"Show elapsed work time separators: /worked on|off|toggle | /worked tools on|off|toggle",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);

			if (parts.length === 0) {
				ctx.ui.notify(
					`Worked-for: ${isEnabled() ? "on" : "off"}, tools: ${areToolsEnabled() ? "on" : "off"}. Usage: /worked on|off|toggle | /worked tools on|off|toggle`,
					"info",
				);
				return;
			}

			if (parts[0] === "tools") {
				const next = parseToggleArg(parts[1] ?? "toggle", areToolsEnabled());
				if (typeof next !== "boolean") {
					ctx.ui.notify("Usage: /worked tools on|off|toggle", "info");
					return;
				}
				persistence.update({
					workedFor: {
						enabled: isEnabled(),
						toolsEnabled: next,
					} satisfies WorkedForState,
				});

				if (agentRunning && isEnabled()) {
					renderWorkedForWidget(ctx);
				}

				ctx.ui.notify(`Worked-for tools: ${next ? "on" : "off"}`, "info");
				return;
			}

			const next = parseToggleArg(parts[0] ?? "toggle", isEnabled());
			if (typeof next !== "boolean") {
				ctx.ui.notify("Usage: /worked on|off|toggle | /worked tools on|off|toggle", "info");
				return;
			}

			persistence.update({
				workedFor: { enabled: next, toolsEnabled: areToolsEnabled() },
			});

			if (!next) {
				stopTick();
				clearWorkedForWidget(ctx);
			} else {
				renderWorkedForWidget(ctx);
				if (agentRunning && ctx.hasUI) startTick(ctx);
			}

			ctx.ui.notify(`Worked-for: ${next ? "on" : "off"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		promptStartTimestamp = undefined;
		agentRunning = false;
		lastRenderedDurationText = undefined;
		stopTick();

		clearWorkedForWidget(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		// This is the right "start" moment: user has submitted a prompt and
		// we're about to start the agent loop. This stays stable across tool calls
		// and internal turns until agent_end.
		promptStartTimestamp = Date.now();
		agentRunning = true;
		lastRenderedDurationText = undefined;

		clearWorkedForWidget(ctx);
		renderWorkedForWidget(ctx);
		if (isEnabled() && ctx.hasUI) startTick(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		agentRunning = false;
		stopTick();
		sendWorkedForSeparator(ctx);
		promptStartTimestamp = undefined;
		lastRenderedDurationText = undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!isEnabled() || !areToolsEnabled()) return;
		if (!agentRunning) return;

		// Avoid spamming on frequent "read" calls.
		if (event.toolName === "read") return;

		renderWorkedForWidget(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!isEnabled()) return;
		if (!agentRunning) return;

		// Only update the widget after assistant output.
		const role = (event.message as Message)?.role;
		if (role !== "assistant") return;

		renderWorkedForWidget(ctx);
	});
}
