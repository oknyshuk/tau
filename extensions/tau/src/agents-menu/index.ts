import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { AgentRegistry } from "../agent/agent-registry.js";
import { validateResolvedAgentConfiguration } from "../agent/startup-validation.js";
import { buildToolDescription } from "../agent/tool.js";
import type { AgentToolHandle } from "../agent/index.js";
import { Data, Effect } from "effect";
import {
	AgentSelectionStore,
	clearRalphOwnedSessionCache,
	getAgentSettingsPath,
	getRalphLoopMetadata,
	isRalphOwnedSession,
	preloadRalphOwnedSessionCache,
	setRalphLoopMetadata,
} from "./state.js";
import { setToolActivationTransform } from "../shared/tool-activation.js";

const AGENT_TOOL_ACTIVATION_KEY = "agents-menu.agent-tool";

function getSessionFileFromContext(ctx: { readonly sessionManager?: unknown }): string | undefined {
	const sessionManager = ctx.sessionManager;
	if (typeof sessionManager !== "object" || sessionManager === null) {
		return undefined;
	}
	if (!("getSessionFile" in sessionManager)) {
		return undefined;
	}
	const getSessionFile = sessionManager.getSessionFile;
	if (typeof getSessionFile !== "function") {
		return undefined;
	}
	const result = getSessionFile.call(sessionManager);
	return typeof result === "string" ? result : undefined;
}

/**
	 * Session-scoped agent enable/disable state with optional project persistence.
	 * Unsaved changes stay in memory for the current runtime. Ctrl+S saves them to project settings.
 */
const agentSelections = new AgentSelectionStore();

export function isAgentDisabledForCwd(cwd: string, name: string): boolean {
	return agentSelections.isDisabledForCwd(cwd, name);
}

export function isAgentDisabledForSession(
	cwd: string,
	sessionFile: string | undefined,
	name: string,
): boolean {
	return agentSelections.isDisabledForSession(cwd, sessionFile, name);
}

export function resolveEnabledAgentsForSessionAuthoritative(
	cwd: string,
	sessionFile: string | undefined,
	availableAgents: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
	return agentSelections.resolveEnabledAgentsForSession(cwd, sessionFile, availableAgents);
}

export function setAgentEnabledForCwd(cwd: string, name: string, enabled: boolean): void {
	agentSelections.setEnabledForCwd(cwd, name, enabled);
}

function loadRegistry(cwd: string): Effect.Effect<AgentRegistry, AgentMenuRegistryLoadError> {
	return AgentRegistry.load(cwd).pipe(
		Effect.tap(validateResolvedAgentConfiguration),
		Effect.catch((error) =>
			Effect.fail(
				new AgentMenuRegistryLoadError({
					cwd,
					reason: summarizeRegistryLoadError(error),
				}),
			),
		),
	);
}

const summarizeRegistryLoadError = (error: unknown): string => {
	if (error instanceof Error) {
		const message = error.message.trim();
		if (message.length > 0) {
			return message;
		}
	}

	return "Unexpected internal error while loading agent registry.";
};

class AgentMenuRegistryLoadError extends Data.TaggedError("AgentMenuRegistryLoadError")<{
	readonly cwd: string;
	readonly reason: string;
}> {}

const formatRegistryLoadError = (error: unknown): string => {
	if (error instanceof AgentMenuRegistryLoadError) {
		return `Failed to load or validate agent registry in ${error.cwd}: ${error.reason}`;
	}

	if (error instanceof Error && error.message.length > 0) {
		return error.message;
	}

	return "Failed to load or validate agent registry.";
};

const loadRegistrySafe = async (
	cwd: string,
	notify?: (message: string) => void,
): Promise<AgentRegistry | null> => {
	try {
		return await Effect.runPromise(loadRegistry(cwd));
	} catch (error) {
		notify?.(formatRegistryLoadError(error));
		return null;
	}
};

function refreshToolDescription(
	agentTool: AgentToolHandle,
	registry: AgentRegistry,
	cwd: string,
	sessionFile: string | undefined,
): void {
	const description = buildToolDescription(
		registry,
		undefined,
		(name) => isAgentDisabledForSession(cwd, sessionFile, name),
	);
	agentTool.refresh(description);
}

interface AgentItem {
	name: string;
	description: string;
}

const AGENT_DESCRIPTION_MAX_CHARS = 72;

function truncateWithEllipsis(text: string, maxChars: number): string {
	const normalized = text.trim();
	if (normalized.length <= maxChars) return normalized;
	if (maxChars <= 1) return "…";
	return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function syncAgentToolAvailability(
	pi: ExtensionAPI,
	agentTool: AgentToolHandle,
	registry: AgentRegistry,
	cwd: string,
	sessionFile: string | undefined,
): void {
	refreshToolDescription(agentTool, registry, cwd, sessionFile);

	const enabledCount = registry.names().filter((name) => !isAgentDisabledForSession(cwd, sessionFile, name)).length;
	setToolActivationTransform(pi, AGENT_TOOL_ACTIVATION_KEY, (toolNames) => {
		const hasAgentTool = toolNames.includes("agent");
		const ralphMeta = getRalphLoopMetadata(cwd, sessionFile);
		const ralphDisablesAgentTool =
			ralphMeta !== undefined && !ralphMeta.activeTools.includes("agent");
		if (ralphDisablesAgentTool) {
			return hasAgentTool ? toolNames.filter((name) => name !== "agent") : toolNames;
		}
		if (enabledCount === 0) {
			return hasAgentTool ? toolNames.filter((name) => name !== "agent") : toolNames;
		}
		return hasAgentTool ? toolNames : [...toolNames, "agent"];
	});
}

function failClosedAgentToolAvailability(pi: ExtensionAPI, agentTool: AgentToolHandle): void {
	agentTool.refresh(
		buildToolDescription({
			list: () => [],
		}),
	);
	setToolActivationTransform(pi, AGENT_TOOL_ACTIVATION_KEY, (toolNames) =>
		toolNames.filter((name) => name !== "agent"),
	);
}

/**
 * TUI component for toggling agents on/off. Stays open until Escape.
 */
class AgentsSelectorComponent extends Container implements Focusable {
	private items: AgentItem[] = [];
	private selectedIndex = 0;
	private searchInput: Input;
	private filteredItems: AgentItem[] = [];
	private listContainer: Container;
	private footerText: Text;
	private doneFn: () => void;
	private cwd: string;
	private sessionFile: string | undefined;
	private onToggle: (name: string, enabled: boolean) => void;
	private onPersist: () => void;
	private onStateChange: () => void;
	private theme: Theme;
	private isDirty: boolean;
	private ralphPolicyActive: boolean;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		allNames: string[],
		registry: AgentRegistry,
		cwd: string,
		sessionFile: string | undefined,
		theme: Theme,
		isDirty: boolean,
		done: () => void,
		onToggle: (name: string, enabled: boolean) => void,
		onPersist: () => void,
		onStateChange: () => void,
	) {
		super();
		this.cwd = cwd;
		this.sessionFile = sessionFile;
		this.theme = theme;
		this.isDirty = isDirty;
		this.ralphPolicyActive = isRalphOwnedSession(cwd, sessionFile);
		this.doneFn = done;
		this.onToggle = onToggle;
		this.onPersist = onPersist;
		this.onStateChange = onStateChange;

		this.items = allNames.map((name) => {
			const def = registry.get(name);
			const desc = def?.description.split("\n")[0]?.trim() ?? "";
			return { name, description: desc };
		});
		this.filteredItems = [...this.items];

		// Search input
		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// List
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		// Footer
		this.addChild(new Spacer(1));
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);

		this.updateList();
	}

	private isEnabled(name: string): boolean {
		return !isAgentDisabledForSession(this.cwd, this.sessionFile, name);
	}

	private getFooterText(): string {
		const enabled = this.items.filter((i) => this.isEnabled(i.name)).length;
		const total = this.items.length;
		const base = `  Enter toggle · Ctrl+T toggle all · Ctrl+S save · Esc close · ${enabled}/${total} enabled${this.ralphPolicyActive ? " · Ralph policy active" : ""}`;
		return this.isDirty
			? this.theme.fg("dim", `${base} `) + this.theme.fg("warning", "(unsaved)")
			: this.theme.fg("dim", base);
	}

	private toggleAll(): void {
		const nextEnabled = this.items.some((item) => !this.isEnabled(item.name));
		for (const item of this.items) {
			if (this.isEnabled(item.name) === nextEnabled) continue;
			this.onToggle(item.name, nextEnabled);
		}
		this.isDirty = true;
		this.refresh();
		this.onStateChange();
	}

	private refresh(): void {
		const query = this.searchInput.getValue().toLowerCase();
		this.filteredItems = query
			? this.items.filter((i) => i.name.toLowerCase().includes(query) || i.description.toLowerCase().includes(query))
			: [...this.items];
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	refreshView(): void {
		this.refresh();
	}

	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching agents"), 0, 0));
			return;
		}

		for (let i = 0; i < this.filteredItems.length; i++) {
			const item = this.filteredItems[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.fg("accent", "> ") : "  ";
			const marker = this.isEnabled(item.name) ? this.theme.fg("success", "✔") : this.theme.fg("dim", "✗");
			const nameText = isSelected ? this.theme.fg("accent", item.name) : item.name;
			const shortDescription = truncateWithEllipsis(item.description, AGENT_DESCRIPTION_MAX_CHARS);
			const desc = shortDescription.length > 0 ? this.theme.fg("dim", ` ${shortDescription}`) : "";
			this.listContainer.addChild(new Text(`${prefix}${marker} ${nameText}${desc}`, 0, 0));
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}

		// Toggle on Enter
		if (matchesKey(data, Key.enter)) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				this.onToggle(item.name, !this.isEnabled(item.name));
				this.isDirty = true;
				this.refresh();
				this.onStateChange();
			}
			return;
		}

		if (matchesKey(data, Key.ctrl("t"))) {
			this.toggleAll();
			return;
		}

		if (matchesKey(data, Key.ctrl("s"))) {
			this.onPersist();
			this.isDirty = false;
			this.footerText.setText(this.getFooterText());
			return;
		}

		// Close on Escape
		if (matchesKey(data, Key.escape)) {
			this.doneFn();
			return;
		}

		// Ctrl+C: clear search or close
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.doneFn();
			}
			return;
		}

		// Pass to search input
		this.searchInput.handleInput(data);
		this.refresh();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}

export type RalphAgentConfigRunner = (
	cwd: string,
	loopName: string,
	enabledNames: ReadonlyArray<string>,
) => Promise<
	| { readonly ok: true; readonly status: "updated" | "no_change" | "deferred" }
	| { readonly ok: false; readonly reason: string }
>;

export default function initAgentsMenu(
	pi: ExtensionAPI,
	agentTool: AgentToolHandle,
	configureRalphAgents?: RalphAgentConfigRunner,
): void {
	const syncForCwd = async (
		cwd: string,
		sessionFile: string | undefined,
		notify?: (message: string) => void,
	) => {
		const registry = await loadRegistrySafe(cwd, notify);
		if (registry === null) {
			failClosedAgentToolAvailability(pi, agentTool);
			return;
		}
		await agentSelections.activate(cwd, registry.names());
		await preloadRalphOwnedSessionCache(cwd, sessionFile);
		syncAgentToolAvailability(pi, agentTool, registry, cwd, sessionFile);
	};

	pi.on("session_start", async (_event, ctx) => {
		clearRalphOwnedSessionCache(ctx.cwd);
		const registry = await loadRegistrySafe(
			ctx.cwd,
			ctx.hasUI ? (message) => ctx.ui.notify(message, "error") : undefined,
		);
		if (registry === null) {
			failClosedAgentToolAvailability(pi, agentTool);
			return;
		}
		await agentSelections.activate(ctx.cwd, registry.names());
		if (ctx.hasUI) {
			const sessionFile = getSessionFileFromContext(ctx);
			await preloadRalphOwnedSessionCache(ctx.cwd, sessionFile);
			syncAgentToolAvailability(pi, agentTool, registry, ctx.cwd, sessionFile);
		}
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		await syncForCwd(
			ctx.cwd,
			getSessionFileFromContext(ctx),
			ctx.hasUI ? (message) => ctx.ui.notify(message, "error") : undefined,
		);
	});

	pi.registerCommand("agents", {
		description: "Enable/disable agents for this session",
		getArgumentCompletions(prefix: string) {
			const words = prefix.trimStart().split(/\s+/);
			if (words.length <= 1) {
				const sub = words[0] ?? "";
				return ["list", "enable", "disable"]
					.filter((s) => s.startsWith(sub))
					.map((s) => ({ value: s, label: s }));
			}
			return null;
		},
			handler: async (args, ctx) => {
				if (!ctx.hasUI) return;

				const registry = await loadRegistrySafe(ctx.cwd, (message) =>
					ctx.ui.notify(message, "error"),
				);
				if (registry === null) {
					failClosedAgentToolAvailability(pi, agentTool);
					return;
				}
				await agentSelections.activate(ctx.cwd, registry.names());
				const allNames = registry.names();
				const sessionFile = getSessionFileFromContext(ctx);
				await preloadRalphOwnedSessionCache(ctx.cwd, sessionFile);
				syncAgentToolAvailability(pi, agentTool, registry, ctx.cwd, sessionFile);

			const trimmed = (args || "").trim();

			if (trimmed) {
				const parts = trimmed.split(/\s+/);
				const action = parts[0]?.toLowerCase();
				const agentName = parts[1]?.toLowerCase();

				if (action === "list") {
					const lines = allNames.map((name: string) => {
						const enabled = !isAgentDisabledForSession(ctx.cwd, sessionFile, name);
						const def = registry.get(name);
						const desc = truncateWithEllipsis(
							def?.description.split("\n")[0]?.trim() ?? "",
							AGENT_DESCRIPTION_MAX_CHARS,
						);
						const marker = enabled ? "✔" : "✗";
						return `${marker} ${name}: ${desc}`;
					});
					if (isRalphOwnedSession(ctx.cwd, sessionFile)) {
						const meta = getRalphLoopMetadata(ctx.cwd, sessionFile);
						lines.push(
							"",
							meta
								? `Ralph loop "${meta.loopName}" policy active. Agents are managed through /ralph configure.`
								: "Ralph policy active. Configure agents through /ralph configure.",
						);
					}
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				if ((action === "enable" || action === "disable") && agentName) {
					if (!registry.has(agentName)) {
						ctx.ui.notify(
							`Unknown agent: "${agentName}". Available: ${allNames.join(", ")}`,
							"error",
						);
						return;
					}

					const meta = getRalphLoopMetadata(ctx.cwd, sessionFile);
					if (meta !== undefined && configureRalphAgents !== undefined) {
						const next = new Set(meta.deferredEnabledAgents ?? meta.enabledAgents);
						if (action === "enable") next.add(agentName);
						else next.delete(agentName);
						const nextEnabled = Array.from(next);
						const result = await configureRalphAgents(ctx.cwd, meta.loopName, nextEnabled);
						if (result.ok) {
							if (result.status === "deferred") {
								setRalphLoopMetadata(ctx.cwd, sessionFile!, {
									loopName: meta.loopName,
									activeTools: meta.activeTools,
									enabledAgents: meta.enabledAgents,
									deferredEnabledAgents: nextEnabled,
								});
								ctx.ui.notify(
									`Agent "${agentName}" ${action === "enable" ? "enable" : "disable"} queued for the next iteration of Ralph loop "${meta.loopName}".`,
									"info",
								);
							} else {
								setRalphLoopMetadata(ctx.cwd, sessionFile!, {
									loopName: meta.loopName,
									activeTools: meta.activeTools,
									enabledAgents: nextEnabled,
								});
								ctx.ui.notify(
									`Agent "${agentName}" ${action === "enable" ? "enabled" : "disabled"} for Ralph loop "${meta.loopName}".`,
									"info",
								);
							}
						} else {
							ctx.ui.notify(`Failed to update Ralph agents: ${result.reason}`, "error");
						}
						syncAgentToolAvailability(pi, agentTool, registry, ctx.cwd, sessionFile);
						return;
					}

					setAgentEnabledForCwd(ctx.cwd, agentName, action === "enable");
					syncAgentToolAvailability(pi, agentTool, registry, ctx.cwd, sessionFile);
					const state = action === "enable" ? "enabled" : "disabled";
					if (action === "enable" && isAgentDisabledForSession(ctx.cwd, sessionFile, agentName)) {
						ctx.ui.notify(
							`Agent "${agentName}" enabled for this session, but Ralph policy still disables it here. Configure ${getAgentSettingsPath(ctx.cwd)} under tau.ralph.agents.enabled to allow it in Ralph loops.`,
							"info",
						);
						return;
					}
					ctx.ui.notify(`Agent "${agentName}" ${state} for this session. Open /agents and press Ctrl+S to save to project settings.`, "info");
					return;
				}

				ctx.ui.notify(
					"Usage: /agents [list | enable <name> | disable <name>]",
					"info",
				);
				return;
			}

			// Interactive toggle selector using ctx.ui.custom
				const loopMeta = getRalphLoopMetadata(ctx.cwd, sessionFile);
				const isRalph = loopMeta !== undefined;
				await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
					let ralphEnabled = loopMeta?.enabledAgents ?? [];
					let ralphDeferredEnabled = loopMeta?.deferredEnabledAgents;
					let ralphConfigQueue: Promise<void> = Promise.resolve();
					let selector: AgentsSelectorComponent;

					selector = new AgentsSelectorComponent(
						allNames,
						registry,
						ctx.cwd,
						sessionFile,
						theme,
						agentSelections.isDirtyForCwd(ctx.cwd),
						() => done(undefined as unknown as void),
						(name, enabled) => {
							if (isRalph && configureRalphAgents !== undefined && sessionFile !== undefined) {
								const next = new Set(ralphDeferredEnabled ?? ralphEnabled);
								if (enabled) next.add(name);
								else next.delete(name);
								const nextEnabled = Array.from(next);
								const previousDeferredEnabled = ralphDeferredEnabled;
								ralphDeferredEnabled = nextEnabled;
								ralphConfigQueue = ralphConfigQueue.then(async () => {
									const result = await configureRalphAgents(ctx.cwd, loopMeta.loopName, nextEnabled);
									if (!result.ok) {
										ralphDeferredEnabled = previousDeferredEnabled;
										ctx.ui.notify(`Failed to update Ralph agents: ${result.reason}`, "error");
										selector.refreshView();
										return;
									}
									if (result.status === "deferred") {
										setRalphLoopMetadata(ctx.cwd, sessionFile, {
											loopName: loopMeta.loopName,
											activeTools: loopMeta.activeTools,
											enabledAgents: ralphEnabled,
											deferredEnabledAgents: nextEnabled,
										});
										ctx.ui.notify(
											`Agent "${name}" ${enabled ? "enable" : "disable"} queued for the next Ralph iteration.`,
											"info",
										);
										selector.refreshView();
										return;
									}
									ralphEnabled = nextEnabled;
									ralphDeferredEnabled = undefined;
									setRalphLoopMetadata(ctx.cwd, sessionFile, {
										loopName: loopMeta.loopName,
										activeTools: loopMeta.activeTools,
										enabledAgents: ralphEnabled,
									});
									selector.refreshView();
									syncAgentToolAvailability(pi, agentTool, registry, ctx.cwd, sessionFile);
								});
								void ralphConfigQueue;
							} else {
								setAgentEnabledForCwd(ctx.cwd, name, enabled);
							}
						},
						() => {
							if (isRalph) {
								ctx.ui.notify("Ralph loop agents are saved automatically.", "info");
								return;
							}
							void agentSelections.persistForCwd(ctx.cwd, allNames).then(
								(settingsPath) => {
									ctx.ui.notify(`Saved agent selection to ${settingsPath}`, "info");
								},
								(error: unknown) => {
									ctx.ui.notify(String(error), "error");
								},
							);
						},
						() => syncAgentToolAvailability(pi, agentTool, registry, ctx.cwd, sessionFile),
					);
					return selector;
				});
		},
	});
}
