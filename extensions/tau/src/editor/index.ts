import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

import type { TauPersistedState } from "../shared/state.js";
import { wrapEditorRender } from "../terminal-prompt/index.js";

interface EditorDeps {
	readonly getSnapshot: () => TauPersistedState;
}

class TauEditor extends CustomEditor {
	private readonly deps: EditorDeps;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, deps: EditorDeps) {
		super(tui, theme, keybindings);
		this.deps = deps;
	}

	override render(width: number): string[] {
		return wrapEditorRender(this.deps.getSnapshot, width, (w: number) => super.render(w));
	}
}

export default function initEditor(pi: ExtensionAPI, deps: EditorDeps) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setTimeout(() => {
			ctx.ui.setEditorComponent(
				(tui, theme, keybindings) => new TauEditor(tui, theme, keybindings, deps),
			);
		}, 1);
	});
}
