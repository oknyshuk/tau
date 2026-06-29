import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { TauPersistedState } from "../shared/state.js";
import { stripAnsi } from "../shared/strip-ansi.js";

// Codex-style composer look:
// - bold "›" prompt
// - 1 empty row above + below (Y padding)
// - dim background for input area
const BG = "\x1b[48;5;236m";

function isHorizontalBorderLine(line: string): boolean {
	const plain = stripAnsi(line);
	return plain.length > 0 && /^[─]+$/.test(plain);
}

function withBg(line: string, width: number): string {
	const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	// Re-apply BG after any full reset emitted by the underlying editor (cursor uses \x1b[0m).
	const patched = padded.replaceAll("\x1b[0m", `\x1b[0m${BG}`);
	return `${BG}${patched}\x1b[0m`;
}

function renderTerminalPrompt(width: number, next: (w: number) => string[]): string[] {
	const promptPrefix = "\x1b[1m›\x1b[0m ";
	const continuationPrefix = "  ";
	const prefixWidth = 2; // visible width of "› "

	if (width <= prefixWidth) return next(width);
	const contentWidth = Math.max(1, width - prefixWidth);

	// Let the built-in editor do all the hard stuff (layout, cursor, autocomplete),
	// then remove its borders and add our prompt prefix.
	const base = next(contentWidth);
	if (base.length < 2) return base;

	// base format: [topBorder, ...contentLines, bottomBorder, ...autocomplete]
	const bottomBorderIndex = (() => {
		for (let i = base.length - 1; i >= 1; i--) {
			if (isHorizontalBorderLine(base[i]!)) return i;
		}
		return -1;
	})();

	if (bottomBorderIndex === -1) {
		// Unexpected, but don't crash; just prefix everything.
		return base.map((line, i) =>
			withBg(`${i === 0 ? promptPrefix : continuationPrefix}${line}`, width),
		);
	}

	const contentLines = base.slice(1, bottomBorderIndex);
	const autocompleteLines = base.slice(bottomBorderIndex + 1);

	const result: string[] = [];

	// Top Y padding
	result.push(withBg("", width));

	for (let i = 0; i < contentLines.length; i++) {
		const line = contentLines[i] ?? "";
		const prefix = i === 0 ? promptPrefix : continuationPrefix;
		// Content lines are already padded to contentWidth by Editor.render().
		result.push(withBg(prefix + line, width));
	}

	// Bottom Y padding
	result.push(withBg("", width));

	// Keep autocomplete outside of the "input area" background (more Codex-like popup).
	for (const line of autocompleteLines) {
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(line)));
		result.push(continuationPrefix + line + padding);
	}

	return result;
}

export function wrapEditorRender(
	getSnapshot: () => TauPersistedState,
	width: number,
	next: (w: number) => string[],
): string[] {
	const enabled = getSnapshot().terminalPrompt?.enabled ?? true;
	return enabled ? renderTerminalPrompt(width, next) : next(width);
}

interface PersistedAccess {
	readonly getSnapshot: () => TauPersistedState;
	readonly update: (patch: Partial<TauPersistedState>) => void;
}

export default function initTerminalPrompt(pi: ExtensionAPI, persistence: PersistedAccess) {
	pi.registerCommand("tau", {
		description: "Tau settings: /tau prompt on|off|toggle",
		handler: async (args, ctx) => {
			let enabled = persistence.getSnapshot().terminalPrompt?.enabled ?? true;
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/).filter(Boolean);

			if (parts.length === 0) {
				ctx.ui.notify(
					`Tau prompt: ${enabled ? "on" : "off"}. Usage: /tau prompt on|off|toggle`,
					"info",
				);
				return;
			}

			if (parts[0] !== "prompt") {
				ctx.ui.notify("Usage: /tau prompt on|off|toggle", "info");
				return;
			}

			const mode = parts[1] ?? "toggle";
			if (mode === "on") enabled = true;
			else if (mode === "off") enabled = false;
			else if (mode === "toggle") enabled = !enabled;
			else {
				ctx.ui.notify("Usage: /tau prompt on|off|toggle", "info");
				return;
			}

			persistence.update({ terminalPrompt: { enabled } });
			ctx.ui.notify(`Tau prompt: ${enabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
	});
}
