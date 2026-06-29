import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	Text,
	SettingsList,
	SelectList,
	Container,
	Spacer,
	Input,
	truncateToWidth,
	type SelectItem,
	type SettingItem,
} from "@earendil-works/pi-tui";
import { Effect, Option } from "effect";

import type { ExecutionProfile } from "../execution/schema.js";
import { ExecutionRuntime } from "../services/execution-runtime.js";
import {
	Ralph,
	type RalphCommandBoundary,
	type RalphStopLoopResult,
	type RalphService,
} from "../services/ralph.js";
import { RalphContractValidationError } from "./errors.js";
import { RALPH_TASKS_DIR } from "./paths.js";
import { sanitizeLoopName, type LoopState, type LoopStatus } from "./schema.js";
import { setToolEnabled } from "../shared/tool-activation.js";
import { formatTokenCount } from "../shared/format-tokens.js";
import { loadPersistedState, TAU_PERSISTED_STATE_TYPE } from "../shared/state.js";
import {
	cwdFromContextIfLive,
	isIgnorableSessionContextError,
	isManagedRuntimeDisposedError,
	isStaleExtensionContextError,
	sessionFileFromContextIfLive,
} from "../shared/extension-context.js";
import { captureCapabilityContract, effectiveToolNames } from "./resolver.js";
import {
	excludeRalphSystemControlTools,
	isRalphSystemControlTool,
	type RalphCapabilityContract,
} from "./contract.js";
import type { RalphConfigMutation } from "./config-service.js";
import { AgentRegistry } from "../agent/agent-registry.js";
import {
	computeEffectiveConfig,
	type ResolvedSandboxConfig,
	type SandboxConfig,
	type SandboxPreset,
} from "../sandbox/config.js";
import { discoverWorkspaceRoot } from "../sandbox/workspace-root.js";
import { resolvePreset, SANDBOX_PRESET_NAMES } from "../shared/policy.js";
import { clearRalphOwnedSessionCacheEntry } from "../agents-menu/state.js";
import { capturePreRalphActiveTools, restorePreRalphActiveTools } from "./session-capabilities.js";

const INVALID_STATE_HINT =
	"Ralph state is invalid and could not be decoded. Repair or remove invalid files under .pi/loops (or reset with /ralph nuke --yes).";

const DEFAULT_TEMPLATE = `# Task

Describe your task here.

## Goals
- Goal 1
- Goal 2

## Checklist
- [ ] Item 1
- [ ] Item 2

## Verification
- Add commands, outputs, or file paths that prove the work is done

## Notes
(Update this as you work)
`;

const DEFAULT_REFLECT_INSTRUCTIONS = `REFLECTION CHECKPOINT

Pause and reflect on your progress:
1. What has been accomplished so far?
2. What's working well?
3. What's not working or blocking progress?
4. Should the approach be adjusted?
5. What are the next priorities?

Update the task file with your reflection, then continue working.`;

const STATUS_ICONS: Record<LoopStatus, string> = {
	active: "▶",
	paused: "⏸",
	completed: "✓",
};

const SETTINGS_SUBMENU_MAX_VISIBLE = 10;

const isUnsafeTuiControlCode = (code: number): boolean =>
	(code >= 0x00 && code <= 0x08) ||
	code === 0x0b ||
	code === 0x0c ||
	(code >= 0x0e && code <= 0x1f) ||
	(code >= 0x7f && code <= 0x9f);

const stripUnsafeTuiControlCharacters = (value: string): string => {
	let result = "";
	for (const char of value) {
		if (!isUnsafeTuiControlCode(char.charCodeAt(0))) {
			result += char;
		}
	}
	return result;
};

const normalizeDisplayLine = (value: string): string =>
	stripUnsafeTuiControlCharacters(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const formatDisplayPreview = (value: string, maxWidth: number): string => {
	const normalized = normalizeDisplayLine(value);
	return truncateToWidth(normalized.length > 0 ? normalized : "(empty)", maxWidth, "…");
};

const formatNameList = (names: ReadonlyArray<string>): string => {
	const normalized = names.map(normalizeDisplayLine).filter((name) => name.length > 0);
	return normalized.join(", ") || "none";
};

const sandboxProfileForPreset = (
	preset: SandboxPreset,
	current: ResolvedSandboxConfig,
): ResolvedSandboxConfig => {
	const resolved = resolvePreset(preset);
	return {
		preset,
		filesystemMode: resolved.filesystemMode,
		networkMode: resolved.networkMode,
		approvalPolicy: resolved.approvalPolicy,
		approvalTimeoutSeconds: current.approvalTimeoutSeconds,
		subagent: current.subagent,
	};
};

const sameStringSet = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
	if (left.size !== right.size) {
		return false;
	}
	for (const value of left) {
		if (!right.has(value)) {
			return false;
		}
	}
	return true;
};

class NumericInputSubmenu extends Container {
	private readonly input: Input;

	constructor(
		title: string,
		description: string,
		currentValue: number,
		onSubmit: (value: number) => void,
		onCancel: () => void,
	) {
		super();
		this.addChild(new Text(title, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(description, 0, 0));
		this.addChild(new Spacer(1));
		this.input = new Input();
		this.input.setValue(String(currentValue));
		this.input.onSubmit = (value) => {
			const parsed = Number.parseInt(value, 10);
			if (Number.isInteger(parsed) && parsed >= 0 && String(parsed) === value.trim()) {
				onSubmit(parsed);
			}
		};
		this.input.onEscape = onCancel;
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(new Text("Enter to save · Esc to go back", 0, 0));
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

class ToggleSettingsSubmenu extends Container {
	private readonly settingsList: SettingsList;

	constructor(
		title: string,
		description: string,
		available: ReadonlyArray<{ readonly name: string; readonly description: string }>,
		activeNames: ReadonlySet<string>,
		onDone: (nextNames: ReadonlyArray<string>, changed: boolean) => void,
	) {
		super();
		const selected = new Set(activeNames);
		this.addChild(new Text(title, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(description, 0, 0));
		this.addChild(new Spacer(1));

		const items: SettingItem[] = available.map((item) => ({
			id: item.name,
			label: item.name,
			description: normalizeDisplayLine(item.description),
			currentValue: selected.has(item.name) ? "enabled" : "disabled",
			values: ["enabled", "disabled"],
		}));

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, SETTINGS_SUBMENU_MAX_VISIBLE),
			getSettingsListTheme(),
			(id, newValue) => {
				if (newValue === "enabled") {
					selected.add(id);
				} else {
					selected.delete(id);
				}
			},
			() => {
				const changed = !sameStringSet(activeNames, selected);
				onDone(Array.from(selected).sort(), changed);
			},
			{ enableSearch: true },
		);
		this.addChild(this.settingsList);
		this.addChild(new Spacer(1));
		this.addChild(new Text("Enter toggles · type to search · Esc saves and returns", 0, 0));
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

class ActionSelectSubmenu extends Container {
	private readonly selectList: SelectList;

	constructor(
		title: string,
		description: string,
		items: ReadonlyArray<SelectItem>,
		onSelect: (value: string) => void,
		onCancel: () => void,
	) {
		super();
		this.addChild(new Text(title, 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(description, 0, 0));
		this.addChild(new Spacer(1));
		this.selectList = new SelectList(
			[...items],
			Math.min(items.length + 2, SETTINGS_SUBMENU_MAX_VISIBLE),
			getSelectListTheme(),
		);
		this.selectList.onSelect = (item) => onSelect(item.value);
		this.selectList.onCancel = onCancel;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text("Enter to select · Esc to go back", 0, 0));
	}

	handleInput(data: string): void {
		this.selectList.handleInput(data);
	}
}

type RalphPromptDispatcher = (prompt: string) => void;

type RalphExecutionProfileApplyResult = {
	readonly applied: boolean;
	readonly reason?: string;
};

type RalphExecutionProfileApplier = (
	profile: ExecutionProfile,
) => Promise<RalphExecutionProfileApplyResult>;

type RalphCapabilityContractApplyResult = {
	readonly applied: boolean;
	readonly reason?: string;
};

type RalphCapabilityContractApplier = (
	contract: RalphCapabilityContract,
	target: "controller" | "child",
) => Promise<RalphCapabilityContractApplyResult>;

type ReplacementSessionContext = ExtensionCommandContext & {
	readonly sendUserMessage: (
		content: Parameters<ExtensionAPI["sendUserMessage"]>[0],
		options?: Parameters<ExtensionAPI["sendUserMessage"]>[1],
	) => Promise<void>;
};

type NewSessionSetup = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["setup"];

type SessionReplacementCommandContext = Omit<
	ExtensionCommandContext,
	"newSession" | "switchSession"
> & {
	readonly newSession: (options?: {
		readonly parentSession?: string;
		readonly setup?: NewSessionSetup;
		readonly withSession?: (ctx: ReplacementSessionContext) => Promise<void>;
	}) => Promise<{ readonly cancelled: boolean }>;
	readonly switchSession: (
		sessionPath: string,
		options?: { readonly withSession?: (ctx: ReplacementSessionContext) => Promise<void> },
	) => Promise<{ readonly cancelled: boolean }>;
};

type RalphSessionContext = ExtensionCommandContext | ReplacementSessionContext;

type RalphToolActivationContext = {
	readonly setActiveTools: ExtensionAPI["setActiveTools"];
};

function hasRalphToolActivationContext(
	ctx: RalphSessionContext,
): ctx is RalphSessionContext & RalphToolActivationContext {
	const candidate = ctx as { readonly setActiveTools?: unknown };
	return typeof candidate.setActiveTools === "function";
}

type RalphCommandBoundaryHandle = RalphCommandBoundary & {
	readonly getActiveContext: () => RalphSessionContext;
};

const RALPH_PROMPT_DISPATCHERS_GLOBAL = "__tau_ralph_prompt_dispatchers";
const RALPH_EXECUTION_PROFILE_APPLIERS_GLOBAL = "__tau_ralph_execution_profile_appliers";
const RALPH_CAPABILITY_CONTRACT_APPLIERS_GLOBAL = "__tau_ralph_capability_contract_appliers";

type RalphGlobalState = typeof globalThis & {
	[RALPH_PROMPT_DISPATCHERS_GLOBAL]?: Map<string, RalphPromptDispatcher>;
	[RALPH_EXECUTION_PROFILE_APPLIERS_GLOBAL]?: Map<string, RalphExecutionProfileApplier>;
	[RALPH_CAPABILITY_CONTRACT_APPLIERS_GLOBAL]?: Map<string, RalphCapabilityContractApplier>;
};

function getRalphPromptDispatchers(): Map<string, RalphPromptDispatcher> {
	const globalState = globalThis as RalphGlobalState;
	const existing = globalState[RALPH_PROMPT_DISPATCHERS_GLOBAL];
	if (existing) {
		return existing;
	}
	const registry = new Map<string, RalphPromptDispatcher>();
	globalState[RALPH_PROMPT_DISPATCHERS_GLOBAL] = registry;
	return registry;
}

function registerRalphPromptDispatcher(
	sessionFile: string | undefined,
	dispatcher: RalphPromptDispatcher,
): void {
	if (sessionFile === undefined) {
		return;
	}
	getRalphPromptDispatchers().set(sessionFile, dispatcher);
}

function unregisterRalphPromptDispatcher(sessionFile: string | undefined): void {
	if (sessionFile === undefined) {
		return;
	}
	getRalphPromptDispatchers().delete(sessionFile);
}

function getRalphExecutionProfileAppliers(): Map<string, RalphExecutionProfileApplier> {
	const globalState = globalThis as RalphGlobalState;
	const existing = globalState[RALPH_EXECUTION_PROFILE_APPLIERS_GLOBAL];
	if (existing) {
		return existing;
	}
	const registry = new Map<string, RalphExecutionProfileApplier>();
	globalState[RALPH_EXECUTION_PROFILE_APPLIERS_GLOBAL] = registry;
	return registry;
}

function registerRalphExecutionProfileApplier(
	sessionFile: string | undefined,
	applier: RalphExecutionProfileApplier,
): void {
	if (sessionFile === undefined) {
		return;
	}
	getRalphExecutionProfileAppliers().set(sessionFile, applier);
}

function unregisterRalphExecutionProfileApplier(sessionFile: string | undefined): void {
	if (sessionFile === undefined) {
		return;
	}
	getRalphExecutionProfileAppliers().delete(sessionFile);
}

function getRalphCapabilityContractAppliers(): Map<string, RalphCapabilityContractApplier> {
	const globalState = globalThis as RalphGlobalState;
	const existing = globalState[RALPH_CAPABILITY_CONTRACT_APPLIERS_GLOBAL];
	if (existing) {
		return existing;
	}
	const registry = new Map<string, RalphCapabilityContractApplier>();
	globalState[RALPH_CAPABILITY_CONTRACT_APPLIERS_GLOBAL] = registry;
	return registry;
}

function registerRalphCapabilityContractApplier(
	sessionFile: string | undefined,
	applier: RalphCapabilityContractApplier,
): void {
	if (sessionFile === undefined) {
		return;
	}
	getRalphCapabilityContractAppliers().set(sessionFile, applier);
}

function unregisterRalphCapabilityContractApplier(sessionFile: string | undefined): void {
	if (sessionFile === undefined) {
		return;
	}
	getRalphCapabilityContractAppliers().delete(sessionFile);
}

function isMaxIterationsReached(
	loop: Pick<LoopState, "status" | "iteration" | "maxIterations">,
): boolean {
	return (
		loop.status === "paused" && loop.maxIterations > 0 && loop.iteration >= loop.maxIterations
	);
}

function describeLoopStatus(loop: Pick<LoopState, "status" | "iteration" | "maxIterations">): {
	readonly icon: string;
	readonly label: string;
} {
	if (isMaxIterationsReached(loop)) {
		return {
			icon: "⚠",
			label: "max iterations reached",
		};
	}
	return {
		icon: STATUS_ICONS[loop.status],
		label: loop.status,
	};
}

function persistedStateFailureMessage(error: RalphContractValidationError): string {
	return `${INVALID_STATE_HINT} (${error.entity})\nProblem: ${error.reason}`;
}

function handlePersistedStateFailure(
	error: unknown,
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
): Option.Option<string> {
	if (!(error instanceof RalphContractValidationError)) {
		return Option.none();
	}
	const knownEntities = [
		"ralph.loop_state",
		"ralph.loop_state.json",
		"ralph.legacy_layout",
		"loops.state",
		"loops.state.json",
	];
	if (!knownEntities.includes(error.entity)) {
		return Option.none();
	}
	const message =
		error.entity === "ralph.legacy_layout" ? error.reason : persistedStateFailureMessage(error);
	if (ctx.hasUI) {
		ctx.ui.notify(message, "error");
	}
	return Option.some(message);
}

function hasReplacementSender(ctx: RalphSessionContext): ctx is ReplacementSessionContext {
	return "sendUserMessage" in ctx && typeof ctx.sendUserMessage === "function";
}

function notifySafely(
	ctx: Pick<ExtensionContext, "hasUI" | "ui">,
	message: string,
	level: "error" | "info" | "warning" | undefined,
): void {
	try {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.notify(message, level);
	} catch (error) {
		if (!isIgnorableSessionContextError(error)) {
			throw error;
		}
	}
}

function formatCommandBoundaryError(error: unknown): string {
	if (error instanceof Error && error.message.length > 0) {
		return error.message;
	}
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string" &&
		error.message.length > 0
	) {
		return error.message;
	}
	if (typeof error === "string" && error.length > 0) {
		return error;
	}
	try {
		const json = JSON.stringify(error);
		if (typeof json === "string" && json.length > 0 && json !== "{}") {
			return json;
		}
	} catch {
		// Fall through to String(error).
	}
	return String(error);
}

function sessionFileFromContext(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
	return typeof ctx.sessionManager.getSessionFile === "function"
		? ctx.sessionManager.getSessionFile()
		: undefined;
}

function readSandboxSessionOverride(
	ctx: Pick<ExtensionContext, "sessionManager">,
): SandboxConfig | undefined {
	const sandbox = loadPersistedState(ctx).sandbox;
	if (typeof sandbox !== "object" || sandbox === null) {
		return undefined;
	}

	const sessionOverride = sandbox["sessionOverride"];
	if (typeof sessionOverride !== "object" || sessionOverride === null) {
		return undefined;
	}
	const sessionOverrideRecord = sessionOverride as Record<string, unknown>;

	const nextSessionOverride: SandboxConfig = {};
	const preset = sessionOverrideRecord["preset"];
	if (preset === "read-only" || preset === "workspace-write" || preset === "full-access") {
		nextSessionOverride.preset = preset;
	}

	const subagent = sessionOverrideRecord["subagent"];
	if (typeof subagent === "boolean") {
		nextSessionOverride.subagent = subagent;
	}

	const approvalTimeoutSeconds = sessionOverrideRecord["approvalTimeoutSeconds"];
	if (
		typeof approvalTimeoutSeconds === "number" &&
		Number.isFinite(approvalTimeoutSeconds) &&
		Number.isInteger(approvalTimeoutSeconds) &&
		approvalTimeoutSeconds > 0
	) {
		nextSessionOverride.approvalTimeoutSeconds = approvalTimeoutSeconds;
	}

	if (Object.keys(nextSessionOverride).length === 0) {
		return undefined;
	}

	return nextSessionOverride;
}

function readCliSandboxOverride(pi: ExtensionAPI): SandboxConfig | undefined {
	const sandboxMode = pi.getFlag("sandbox-mode");
	if (typeof sandboxMode !== "string") {
		return undefined;
	}

	const modeMap: Record<string, SandboxPreset> = {
		"read-only": "read-only",
		readonly: "read-only",
		"workspace-write": "workspace-write",
		agent: "workspace-write",
		"full-access": "full-access",
		full: "full-access",
	};
	const preset = modeMap[sandboxMode.toLowerCase()];
	return preset === undefined ? undefined : { preset };
}

function captureSandboxProfile(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): ResolvedSandboxConfig {
	const sessionOverride = readSandboxSessionOverride(ctx);
	const cliOverride = readCliSandboxOverride(pi);
	return computeEffectiveConfig({
		workspaceRoot: discoverWorkspaceRoot(ctx.cwd),
		sessionOverride: { ...sessionOverride, ...cliOverride },
	});
}

function sandboxSessionStateFromProfile(profile: ResolvedSandboxConfig): {
	readonly sandbox: { readonly sessionOverride: SandboxConfig };
} {
	return {
		sandbox: {
			sessionOverride: {
				preset: profile.preset,
				subagent: profile.subagent,
				approvalTimeoutSeconds: profile.approvalTimeoutSeconds,
			},
		},
	};
}

function formatLoop(loop: LoopState): string {
	const status = describeLoopStatus(loop);
	const iter =
		loop.maxIterations > 0 ? `${loop.iteration}/${loop.maxIterations}` : `${loop.iteration}`;
	return `${loop.name}: ${status.icon} ${status.label} (iteration ${iter})`;
}

function formatCostUsd(cost: number): string {
	return `$${cost.toFixed(cost >= 1 ? 2 : 4)}`;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(ms / 1_000);
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

function activeRuntimeMs(state: LoopState, nowMs: number): number {
	const activeStartedAt = Option.getOrUndefined(state.metrics.activeStartedAt);
	if (activeStartedAt === undefined) {
		return state.metrics.activeDurationMs;
	}
	const startedMs = Date.parse(activeStartedAt);
	if (!Number.isFinite(startedMs)) {
		return state.metrics.activeDurationMs;
	}
	return state.metrics.activeDurationMs + Math.max(0, nowMs - startedMs);
}

type ArgsParseFailure = {
	readonly ok: false;
	readonly error: string;
};

type RalphStartArgs = {
	readonly name: string;
	readonly maxIterations: number;
	readonly itemsPerIteration: number;
	readonly reflectEvery: number;
	readonly reflectInstructions: string;
	readonly overrides: {
		readonly maxIterations: boolean;
		readonly itemsPerIteration: boolean;
		readonly reflectEvery: boolean;
		readonly reflectInstructions: boolean;
	};
};

type RalphStartArgsParseResult =
	| {
			readonly ok: true;
			readonly value: RalphStartArgs;
	  }
	| ArgsParseFailure;

type RalphResumeArgs = {
	readonly name: string;
	readonly maxIterations: Option.Option<number>;
};

type RalphResumeArgsParseResult =
	| {
			readonly ok: true;
			readonly value: RalphResumeArgs;
	  }
	| ArgsParseFailure;

function parseNonNegativeIntegerOption(
	option: string,
	rawValue: string,
): ArgsParseFailure | number {
	const value = Number.parseInt(rawValue, 10);
	if (!Number.isInteger(value) || value < 0) {
		return {
			ok: false,
			error: `${option} expects a non-negative integer, got "${rawValue}"`,
		};
	}
	return value;
}

function parseArgs(argsStr: string): RalphStartArgsParseResult {
	const tokens = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
	const result = {
		name: "",
		maxIterations: 50,
		itemsPerIteration: 0,
		reflectEvery: 0,
		reflectInstructions: DEFAULT_REFLECT_INSTRUCTIONS,
		overrides: {
			maxIterations: false,
			itemsPerIteration: false,
			reflectEvery: false,
			reflectInstructions: false,
		},
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.startsWith("--")) {
			const equalsIndex = token.indexOf("=");
			const option = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
			const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
			const next = tokens[i + 1];
			const rawValue = inlineValue ?? next;
			if (rawValue === undefined) {
				return {
					ok: false,
					error: `missing value for ${option}`,
				};
			}

			if (option === "--max-iterations") {
				const parsed = parseNonNegativeIntegerOption(option, rawValue);
				if (typeof parsed !== "number") {
					return parsed;
				}
				result.maxIterations = parsed;
				result.overrides.maxIterations = true;
			} else if (option === "--items-per-iteration") {
				const parsed = parseNonNegativeIntegerOption(option, rawValue);
				if (typeof parsed !== "number") {
					return parsed;
				}
				result.itemsPerIteration = parsed;
				result.overrides.itemsPerIteration = true;
			} else if (option === "--reflect-every") {
				const parsed = parseNonNegativeIntegerOption(option, rawValue);
				if (typeof parsed !== "number") {
					return parsed;
				}
				result.reflectEvery = parsed;
				result.overrides.reflectEvery = true;
			} else if (option === "--reflect-instructions") {
				result.reflectInstructions = rawValue.replace(/^"|"$/g, "");
				result.overrides.reflectInstructions = true;
			} else {
				return {
					ok: false,
					error: `unknown option "${option}"`,
				};
			}

			if (inlineValue === undefined) {
				i++;
			}
			continue;
		}

		const positional = token.replace(/^"|"$/g, "");
		if (!result.name) {
			result.name = positional;
		} else {
			return {
				ok: false,
				error: `unexpected extra argument "${positional}"`,
			};
		}
	}

	return {
		ok: true,
		value: result,
	};
}

function parseResumeArgs(argsStr: string): RalphResumeArgsParseResult {
	const tokens = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
	const result: {
		name: string;
		maxIterations: Option.Option<number>;
	} = {
		name: "",
		maxIterations: Option.none(),
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.startsWith("--")) {
			const equalsIndex = token.indexOf("=");
			const option = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
			const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
			const next = tokens[i + 1];
			const rawValue = inlineValue ?? next;
			if (rawValue === undefined) {
				return {
					ok: false,
					error: `missing value for ${option}`,
				};
			}

			if (option !== "--max-iterations") {
				return {
					ok: false,
					error: `unknown option "${option}"`,
				};
			}

			const parsed = parseNonNegativeIntegerOption(option, rawValue);
			if (typeof parsed !== "number") {
				return parsed;
			}
			result.maxIterations = Option.some(parsed);

			if (inlineValue === undefined) {
				i++;
			}
			continue;
		}

		const positional = token.replace(/^"|"$/g, "");
		if (!result.name) {
			result.name = positional;
		} else {
			return {
				ok: false,
				error: `unexpected extra argument "${positional}"`,
			};
		}
	}

	if (!result.name) {
		return {
			ok: false,
			error: "missing loop name",
		};
	}

	return {
		ok: true,
		value: result,
	};
}

function stripSurroundingQuotes(value: string): string {
	return value.replace(/^"|"$/g, "");
}

function formatCommandArgument(value: string): string {
	return /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

type ResolvedLoopTarget = {
	readonly loopName: string;
	readonly taskStem: string;
	readonly taskFile: string;
	readonly recommendedStartTarget: string;
	readonly isPath: boolean;
};

type ConfigureTarget = {
	readonly loopName: string;
	readonly taskFile: string;
	readonly loop: LoopState | undefined;
};

function resolveLoopTarget(target: string): ResolvedLoopTarget {
	const trimmed = stripSurroundingQuotes(target.trim());
	const isPath = trimmed.includes("/") || trimmed.includes("\\") || trimmed.endsWith(".md");
	const sourceLoopName = isPath ? path.basename(trimmed, path.extname(trimmed)) : trimmed;
	const loopName = sanitizeLoopName(sourceLoopName);
	const taskStem = sourceLoopName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_+/g, "_");
	const taskFile = isPath ? trimmed : path.join(RALPH_TASKS_DIR, `${taskStem}.md`);
	return {
		loopName,
		taskStem,
		taskFile,
		recommendedStartTarget: formatCommandArgument(isPath ? taskFile : trimmed),
		isPath,
	};
}

function isNodeNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code: unknown }).code === "ENOENT"
	);
}

async function readExistingTaskFile(cwd: string, taskFile: string): Promise<string | undefined> {
	try {
		return await fs.readFile(path.resolve(cwd, taskFile), "utf-8");
	} catch (error) {
		if (isNodeNotFoundError(error)) {
			return undefined;
		}
		throw error;
	}
}

async function listTaskOnlyConfigureTargets(
	cwd: string,
	loops: ReadonlyArray<LoopState>,
): Promise<ReadonlyArray<ConfigureTarget>> {
	const loopNames = new Set(loops.map((loop) => loop.name));
	let entries: ReadonlyArray<string>;
	try {
		entries = await fs.readdir(path.resolve(cwd, RALPH_TASKS_DIR));
	} catch (error) {
		if (isNodeNotFoundError(error)) {
			return [];
		}
		throw error;
	}

	return entries
		.filter((entry) => entry.endsWith(".md"))
		.map((entry) => {
			const stem = path.basename(entry, ".md");
			return {
				loopName: sanitizeLoopName(stem),
				taskFile: path.join(RALPH_TASKS_DIR, entry),
				loop: undefined,
			} satisfies ConfigureTarget;
		})
		.filter((target) => !loopNames.has(target.loopName))
		.sort((left, right) => left.loopName.localeCompare(right.loopName));
}

const HELP = `Ralph Wiggum - Long-running development loops

Commands:
  /ralph create <name|id> [desc]      Draft a task file with the model, then review
  /ralph start <name|path> [options]  Start a new loop
  /ralph pause                        Pause current loop
  /ralph stop                         End active loop (idle only)
  /ralph resume <name> [options]      Resume a paused or completed loop
  /ralph status                       Show all loops
  /ralph cancel <name>                Delete loop state
  /ralph archive <name>               Move loop to archive
  /ralph clean [--all]                Clean completed loops
  /ralph list --archived              Show archived loops
  /ralph configure [name]             Interactive configuration for a Ralph loop
  /ralph nuke [--yes]                 Delete all Ralph loop data under .pi/loops

Options:
  --items-per-iteration N  Suggest N items per turn (prompt hint)
  --reflect-every N        Reflect every N iterations
  --max-iterations N       Stop after N iterations (default 50). On resume, raise the cap in place.

To pause: press ESC or run /ralph pause
To stop: press ESC to interrupt, then run /ralph stop when idle

Examples:
  /ralph create my-feature
  /ralph create tau-1234 wire up the new config service
  /ralph start my-feature
  /ralph start review --items-per-iteration 5 --reflect-every 10
  /ralph resume review --max-iterations 100`;

const RALPH_CONTINUE_TOOL_NAME = "ralph_continue";
const RALPH_FINISH_TOOL_NAME = "ralph_finish";

type RalphUiContext = Pick<ExtensionContext, "hasUI" | "ui" | "sessionManager">;

export default function initRalph(
	pi: ExtensionAPI,
	runEffect: <A, E>(effect: Effect.Effect<A, E, Ralph | ExecutionRuntime>) => Promise<A>,
): void {
	const withRalph = <A, E>(
		f: (service: RalphService) => Effect.Effect<A, E, never>,
	): Promise<A> =>
		runEffect(
			Effect.gen(function* () {
				const service = yield* Ralph;
				return yield* f(service);
			}),
		);

	const withExecutionRuntime = <A, E>(
		f: (service: ExecutionRuntime) => Effect.Effect<A, E, never>,
	): Promise<A> =>
		runEffect(
			Effect.gen(function* () {
				const service = yield* ExecutionRuntime;
				return yield* f(service);
			}),
		);

	const listLoops = (cwd: string, archived = false): Promise<ReadonlyArray<LoopState>> =>
		withRalph((ralph) => ralph.listLoops(cwd, archived));

	const captureCurrentExecutionProfile = (
		ctx: Pick<ExtensionContext, "model" | "sessionManager">,
	): Promise<ExecutionProfile | null> =>
		withExecutionRuntime((runtime) => runtime.captureCurrentExecutionProfile(ctx));

	const captureCurrentCapabilityContract = async (
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager" | "model">,
	): Promise<RalphCapabilityContract> => {
		const agentRegistry = await Effect.runPromise(AgentRegistry.load(ctx.cwd));
		return captureCapabilityContract({
			activeTools: pi.getActiveTools(),
			allTools: pi.getAllTools(),
			agentRegistry,
			enabledAgents: [],
		});
	};

	const syncPromptDispatcher = (ctx: Pick<ExtensionContext, "sessionManager">): void => {
		registerRalphPromptDispatcher(sessionFileFromContext(ctx), (prompt) => {
			pi.sendUserMessage(prompt);
		});
	};

	const applyExecutionProfileInContext = (
		profile: ExecutionProfile,
		profileContext: Pick<ExtensionContext, "model" | "modelRegistry" | "ui">,
	): Promise<RalphExecutionProfileApplyResult> =>
		withExecutionRuntime((runtime) =>
			runtime
				.applyExecutionProfile(profile, profileContext, {
					notifyOnSuccess: false,
					persist: false,
					ephemeral: true,
				})
				.pipe(
					Effect.map((applyResult) =>
						applyResult.applied
							? { applied: true as const }
							: { applied: false as const, reason: applyResult.reason },
					),
				),
		).catch((error) => ({
			applied: false as const,
			reason: formatCommandBoundaryError(error),
		}));

	const syncExecutionProfileApplier = (
		ctx: Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry" | "ui">,
	): void => {
		registerRalphExecutionProfileApplier(sessionFileFromContext(ctx), (profile) =>
			applyExecutionProfileInContext(profile, ctx),
		);
	};

	const applyCapabilityContractWithPi = (
		contract: RalphCapabilityContract,
		target: "controller" | "child",
		sessionFile: string | undefined,
	): RalphCapabilityContractApplyResult => {
		try {
			capturePreRalphActiveTools(sessionFile, pi);
			const tools = effectiveToolNames(contract, target);
			pi.setActiveTools([...tools]);
			return { applied: true as const };
		} catch (error) {
			return {
				applied: false as const,
				reason: formatCommandBoundaryError(error),
			};
		}
	};

	const syncCapabilityContractApplier = (ctx: Pick<ExtensionContext, "sessionManager">): void => {
		const registeredSessionFile = sessionFileFromContext(ctx);
		registerRalphCapabilityContractApplier(registeredSessionFile, (contract, target) => {
			const liveSessionFile = sessionFileFromContextIfLive(ctx);
			if (liveSessionFile !== registeredSessionFile) {
				return Promise.resolve({
					applied: false as const,
					reason: `registered capability contract applier is not live for ${registeredSessionFile ?? "the session"}`,
				});
			}
			return Promise.resolve(
				applyCapabilityContractWithPi(contract, target, registeredSessionFile),
			);
		});
	};

	const commandBoundaryFromContext = (
		ctx: ExtensionCommandContext,
	): RalphCommandBoundaryHandle => {
		let currentSessionFile = sessionFileFromContext(ctx);
		let activeContext: RalphSessionContext = ctx;
		let hasReplacedSession = false;
		const initialSandboxProfile = captureSandboxProfile(pi, ctx);
		const sessionControl = (): SessionReplacementCommandContext =>
			activeContext as SessionReplacementCommandContext;

		const bindReplacementContext = (
			replacementCtx: ReplacementSessionContext,
			fallbackSessionFile: string | undefined,
		): void => {
			hasReplacedSession = true;
			activeContext = replacementCtx;
			currentSessionFile =
				sessionFileFromContext(replacementCtx) ?? fallbackSessionFile ?? currentSessionFile;
		};

		const switchSession: RalphCommandBoundary["switchSession"] = Effect.fn(
			"RalphCommandBoundary.switchSession",
		)(function* (targetSessionFile) {
			const result = yield* Effect.tryPromise(() =>
				sessionControl().switchSession(targetSessionFile, {
					withSession: async (replacementCtx) => {
						bindReplacementContext(replacementCtx, targetSessionFile);
					},
				}),
			).pipe(
				Effect.catch((error) =>
					Effect.gen(function* () {
						yield* Effect.logWarning("Ralph switchSession failed", error);
						return { cancelled: true as const };
					}),
				),
			);
			if (!result.cancelled) {
				currentSessionFile = currentSessionFile ?? targetSessionFile;
			}
			return result;
		});

		const newSession: RalphCommandBoundary["newSession"] = Effect.fn(
			"RalphCommandBoundary.newSession",
		)(function* (options) {
			let createdSessionFile: string | undefined;
			const result = yield* Effect.tryPromise(() =>
				sessionControl().newSession({
					parentSession: options.parentSession,
					setup: async (sessionManager) => {
						createdSessionFile = sessionManager.getSessionFile();
						sessionManager.appendCustomEntry(
							TAU_PERSISTED_STATE_TYPE,
							sandboxSessionStateFromProfile(options.sandboxProfile),
						);
					},
					withSession: async (replacementCtx) => {
						bindReplacementContext(replacementCtx, createdSessionFile);
					},
				}),
			).pipe(
				Effect.catch((error) =>
					Effect.gen(function* () {
						yield* Effect.logWarning("Ralph newSession failed", error);
						return { cancelled: true as const };
					}),
				),
			);
			if (!result.cancelled) {
				currentSessionFile = currentSessionFile ?? createdSessionFile;
			}
			return result;
		});

		const applyExecutionProfile: RalphCommandBoundary["applyExecutionProfile"] = Effect.fn(
			"RalphCommandBoundary.applyExecutionProfile",
		)(function* (profile) {
			const targetSessionFile = currentSessionFile;
			if (targetSessionFile !== undefined) {
				const applier = getRalphExecutionProfileAppliers().get(targetSessionFile);
				if (applier) {
					return yield* Effect.promise(() => applier(profile));
				}
			}

			const profileContext = activeContext;
			const liveSessionFile = sessionFileFromContextIfLive(profileContext);
			if (targetSessionFile === undefined || liveSessionFile === targetSessionFile) {
				return yield* Effect.promise(() =>
					applyExecutionProfileInContext(profile, profileContext),
				);
			}

			return {
				applied: false as const,
				reason: `no execution profile applier is registered for ${targetSessionFile}`,
			};
		});

		const applyCapabilityContract: RalphCommandBoundary["applyCapabilityContract"] = Effect.fn(
			"RalphCommandBoundary.applyCapabilityContract",
		)(function* (contract, target) {
			const targetSessionFile = currentSessionFile;
			if (hasReplacedSession && hasRalphToolActivationContext(activeContext)) {
				const toolContext = activeContext;
				return yield* Effect.sync(() => {
					try {
						capturePreRalphActiveTools(targetSessionFile, toolContext);
						const tools = effectiveToolNames(contract, target);
						toolContext.setActiveTools([...tools]);
						return { applied: true as const };
					} catch (error) {
						return {
							applied: false as const,
							reason: formatCommandBoundaryError(error),
						};
					}
				});
			}

			if (targetSessionFile !== undefined) {
				const applier = getRalphCapabilityContractAppliers().get(targetSessionFile);
				if (applier) {
					const result = yield* Effect.promise(() => applier(contract, target));
					if (result.applied) {
						return result;
					}
					const applierIsStale =
						result.reason?.startsWith(
							"registered capability contract applier is not live",
						) === true || isStaleExtensionContextError(result.reason ?? "");
					if (applierIsStale) {
						unregisterRalphCapabilityContractApplier(targetSessionFile);
					}
					if (!applierIsStale) {
						return result;
					}
				}
			}

			if (hasReplacedSession) {
				return target === "controller"
					? { applied: true as const }
					: {
							applied: false as const,
							reason: `no capability contract applier is registered for ${targetSessionFile ?? "the replacement session"}`,
						};
			}

			return yield* Effect.sync(() => {
				const result = applyCapabilityContractWithPi(contract, target, targetSessionFile);
				if (
					target === "controller" &&
					!result.applied &&
					isStaleExtensionContextError(result.reason ?? "")
				) {
					return { applied: true as const };
				}
				return result;
			});
		});

		const captureBoundarySandboxProfile = Effect.succeed(initialSandboxProfile);

		const sendFollowUp: RalphCommandBoundary["sendFollowUp"] = Effect.fn(
			"RalphCommandBoundary.sendFollowUp",
		)(function* (prompt) {
			return yield* Effect.sync(() => {
				const targetSessionFile = currentSessionFile;
				if (targetSessionFile === undefined) {
					return {
						dispatched: false as const,
						reason: "iteration session file is unavailable",
					};
				}

				const dispatcher = getRalphPromptDispatchers().get(targetSessionFile);
				if (dispatcher) {
					dispatcher(prompt);
					return { dispatched: true as const };
				}

				if (sessionFileFromContextIfLive(ctx) === targetSessionFile) {
					pi.sendUserMessage(prompt);
					return { dispatched: true as const };
				}

				const sessionContext = activeContext;
				if (
					hasReplacementSender(sessionContext) &&
					sessionFileFromContextIfLive(sessionContext) === targetSessionFile
				) {
					void sessionContext.sendUserMessage(prompt).catch((error) => {
						Effect.runSync(Effect.logWarning("Ralph sendUserMessage failed", error));
					});
					return { dispatched: true as const };
				}

				return {
					dispatched: false as const,
					reason: `no prompt dispatcher is registered for ${targetSessionFile}`,
				};
			});
		});

		return {
			cwd: ctx.cwd,
			getSessionFile: () => currentSessionFile,
			getActiveContext: () => activeContext,
			switchSession,
			newSession,
			captureSandboxProfile: captureBoundarySandboxProfile,
			applyExecutionProfile,
			applyCapabilityContract,
			sendFollowUp,
		};
	};

	const restoreReleasedRalphSessionCapabilities = async (
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): Promise<void> => {
		const sessionFile = sessionFileFromContext(ctx);
		if (sessionFile === undefined) {
			return;
		}

		const state = await withRalph((ralph) =>
			ralph
				.findLoopBySessionFile(ctx.cwd, sessionFile)
				.pipe(Effect.map(Option.getOrUndefined)),
		);
		const activelyOwned =
			state !== undefined &&
			state.status === "active" &&
			(Option.getOrUndefined(state.controllerSessionFile) === sessionFile ||
				Option.getOrUndefined(state.activeIterationSessionFile) === sessionFile);
		if (activelyOwned) {
			return;
		}

		try {
			if (restorePreRalphActiveTools(sessionFile, ctx)) {
				clearRalphOwnedSessionCacheEntry(ctx.cwd, sessionFile);
				return;
			}
		} catch (error) {
			if (!isIgnorableSessionContextError(error)) {
				throw error;
			}
		}

		restorePreRalphActiveTools(sessionFile, pi);
		clearRalphOwnedSessionCacheEntry(ctx.cwd, sessionFile);
	};

	const syncRalphHandshakeTools = async (
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	): Promise<void> => {
		const sessionFile = sessionFileFromContext(ctx);
		if (sessionFile === undefined) {
			setToolEnabled(pi, RALPH_CONTINUE_TOOL_NAME, false);
			setToolEnabled(pi, RALPH_FINISH_TOOL_NAME, false);
			return;
		}

		const state = await withRalph((ralph) =>
			ralph
				.findLoopBySessionFile(ctx.cwd, sessionFile)
				.pipe(Effect.map(Option.getOrUndefined)),
		);

		const enabled =
			state !== undefined &&
			state.status === "active" &&
			Option.getOrUndefined(state.activeIterationSessionFile) === sessionFile;
		setToolEnabled(pi, RALPH_CONTINUE_TOOL_NAME, enabled);
		setToolEnabled(pi, RALPH_FINISH_TOOL_NAME, enabled);
	};

	const syncRalphHandshakeToolsSafely = async (
		ctx: Pick<ExtensionContext, "cwd" | "sessionManager" | "hasUI" | "ui">,
	): Promise<void> => {
		try {
			await syncRalphHandshakeTools(ctx);
		} catch (error) {
			if (isIgnorableSessionContextError(error)) {
				return;
			}
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			if (isManagedRuntimeDisposedError(error)) {
				return;
			}
			throw error;
		}
	};

	const updateUI = async (cwd: string, ctx: RalphUiContext): Promise<void> => {
		if (!ctx.hasUI) {
			return;
		}
		if (typeof ctx.ui.setStatus !== "function" || typeof ctx.ui.setWidget !== "function") {
			return;
		}

		const hasDir = await withRalph((ralph) => ralph.existsRalphDirectory(cwd));
		if (!hasDir) {
			ctx.ui.setStatus("ralph", undefined);
			ctx.ui.setWidget("ralph", undefined);
			return;
		}

		const state = await withRalph((ralph) =>
			ralph
				.resolveLoopForUi(cwd, sessionFileFromContext(ctx))
				.pipe(Effect.map(Option.getOrUndefined)),
		);

		if (!state) {
			ctx.ui.setStatus("ralph", undefined);
			ctx.ui.setWidget("ralph", undefined);
			return;
		}

		const { theme } = ctx.ui;
		const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
		const status = describeLoopStatus(state);
		const runtimeMs = activeRuntimeMs(state, Date.now());

		ctx.ui.setStatus(
			"ralph",
			theme.fg("accent", `🔄 ${state.name} (${state.iteration}${maxStr})`),
		);

		const lines = [
			theme.fg("accent", theme.bold("Ralph Wiggum")),
			theme.fg("muted", `Loop: ${state.name}`),
			theme.fg("dim", `Status: ${status.icon} ${status.label}`),
			theme.fg("dim", `Iteration: ${state.iteration}${maxStr}`),
			theme.fg("dim", `Runtime: ${formatDuration(runtimeMs)}`),
			theme.fg(
				"dim",
				`Usage: ${formatTokenCount(state.metrics.totalTokens)} tokens · ${formatCostUsd(state.metrics.totalCostUsd)}`,
			),
			theme.fg("dim", `Task: ${state.taskFile}`),
		];

		if (state.reflectEvery > 0) {
			const next = state.reflectEvery - ((state.iteration - 1) % state.reflectEvery);
			lines.push(theme.fg("dim", `Next reflection in: ${next} iterations`));
		}

		lines.push("");
		lines.push(theme.fg("warning", "ESC pauses the assistant"));
		lines.push(theme.fg("warning", "Run /ralph pause to keep the loop resumable"));
		lines.push(theme.fg("warning", "Run /ralph stop to end the loop"));
		ctx.ui.setWidget("ralph", lines);
	};

	const runLoop = async (ctx: ExtensionCommandContext, loopName: string): Promise<void> => {
		const boundary = commandBoundaryFromContext(ctx);
		const result = await withRalph((ralph) => ralph.runLoop(boundary, loopName));
		const resultContext = boundary.getActiveContext();
		if (Option.isSome(result.message)) {
			notifySafely(resultContext, result.message.value, "info");
		}
		if (Option.isSome(result.banner)) {
			notifySafely(resultContext, result.banner.value, "info");
		}
		try {
			await updateUI(resultContext.cwd, resultContext);
		} catch (error) {
			if (!isIgnorableSessionContextError(error)) {
				throw error;
			}
		}
		await restoreReleasedRalphSessionCapabilities(resultContext);
	};

	pi.registerCommand("ralph", {
		description: "Ralph Wiggum - long-running development loops",
		handler: async (args, ctx) => {
			try {
				const [cmd] = args.trim().split(/\s+/);
				const rest = cmd ? args.slice(args.indexOf(cmd) + cmd.length).trim() : "";

				switch (cmd) {
					case "create": {
						const createRest = rest.trim();
						const nameMatch = createRest.match(/^(\S+)(?:\s+([\s\S]*))?$/);
						const rawName = nameMatch?.[1];
						if (rawName === undefined || rawName.startsWith("-")) {
							ctx.ui.notify(
								"Usage: /ralph create <name|backlog-id> [description]",
								"warning",
							);
							return;
						}
						const name = rawName;
						const description = (nameMatch?.[2] ?? "").trim();
						const resolved = resolveLoopTarget(name);
						const taskFileRel = resolved.taskFile;
						const absoluteTaskFile = path.resolve(ctx.cwd, taskFileRel);

						let alreadyExists = false;
						try {
							await fs.access(absoluteTaskFile);
							alreadyExists = true;
						} catch {
							alreadyExists = false;
						}
						if (alreadyExists) {
							ctx.ui.notify(
								`Task file already exists at ${taskFileRel}. Edit it, or run /ralph start ${resolved.recommendedStartTarget}.`,
								"warning",
							);
							return;
						}

						// Delegate task-file authoring to the current model: it follows the
						// ralph-loop-creation skill, reads the backlog when <name> is an id,
						// and writes the file with its own edit tool. The user reviews the
						// draft and then runs /ralph start. sendUserMessage triggers a turn.
						const promptLines = [
							`Author a Ralph loop task file at \`${taskFileRel}\`.`,
							"",
							'Use the "ralph-loop-creation" skill for the required format: a compact prompt with pointers, a short checklist, and an empty Notebook section. Do not paste backlog descriptions, designs, or acceptance criteria — the loop reads the backlog directly.',
							"",
							"Decide the source first:",
							`- Run \`backlog show ${name}\` to check whether "${name}" is a backlog item. If it resolves, treat the backlog item as the source of truth and use the backlog-backed template (also run \`backlog children ${name} --recursive\` if it is an epic).`,
							`- If "${name}" is not a backlog item, use the free-form template.`,
						];
						if (description.length > 0) {
							promptLines.push("", `Intended focus for this loop: ${description}`);
						}
						promptLines.push(
							"",
							`Write the file with your file-editing tool, keep it short, and leave the Notebook empty. When done, tell me to review \`${taskFileRel}\` and run \`/ralph start ${resolved.recommendedStartTarget}\` to begin the loop.`,
						);

						ctx.ui.notify(
							`Drafting Ralph task file for "${resolved.loopName}" — review it, then run /ralph start ${resolved.recommendedStartTarget}.`,
							"info",
						);
						pi.sendUserMessage(promptLines.join("\n"));
						return;
					}

					case "start": {
						const parsed = parseArgs(rest);
						if (!parsed.ok) {
							ctx.ui.notify(
								`Invalid Ralph start arguments: ${parsed.error}`,
								"warning",
							);
							return;
						}
						if (!parsed.value.name) {
							ctx.ui.notify(
								"Usage: /ralph start <name|path> [--items-per-iteration N] [--reflect-every N] [--max-iterations N]",
								"warning",
							);
							return;
						}

						const resolved = resolveLoopTarget(parsed.value.name);
						const loopName = resolved.loopName;
						const taskFile = resolved.taskFile;
						const executionProfile = await captureCurrentExecutionProfile(ctx);
						if (executionProfile === null) {
							ctx.ui.notify(
								"Could not capture the current execution profile for this Ralph loop.",
								"error",
							);
							return;
						}
						const sandboxProfile = captureSandboxProfile(pi, ctx);

						// Capture capability contract from current runtime before the session
						// becomes Ralph-owned, so ambient Pi state is pinned.
						const controllerSessionFile = sessionFileFromContext(ctx);
						const capabilityContract = await captureCurrentCapabilityContract(ctx);

						const start = await withRalph((ralph) =>
							ralph.startLoopState(ctx.cwd, {
								loopName,
								taskFile,
								executionProfile,
								sandboxProfile,
								maxIterations: parsed.value.maxIterations,
								itemsPerIteration: parsed.value.itemsPerIteration,
								reflectEvery: parsed.value.reflectEvery,
								reflectInstructions: parsed.value.reflectInstructions,
								controllerSessionFile:
									controllerSessionFile === undefined
										? Option.none()
										: Option.some(controllerSessionFile),
								defaultTaskTemplate: DEFAULT_TEMPLATE,
								capabilityContract,
								overrides: parsed.value.overrides,
							}),
						);

						if (start.status === "already_active") {
							ctx.ui.notify(
								`Loop "${loopName}" is already active. Use /ralph resume ${loopName}`,
								"warning",
							);
							return;
						}

						if (start.status === "missing_controller_session") {
							ctx.ui.notify(
								"Loop requires a persisted session file (interactive session).",
								"error",
							);
							return;
						}

						if (start.createdTask) {
							ctx.ui.notify(`Created task file: ${start.taskFile}`, "info");
						}
						await updateUI(ctx.cwd, ctx);
						ctx.ui.notify(
							`Started loop "${start.loopName}" (max ${start.maxIterations} iterations)`,
							"info",
						);
						await runLoop(ctx, start.loopName);
						return;
					}

					case "pause": {
						const paused = await withRalph((ralph) => ralph.pauseCurrentLoop(ctx.cwd));
						if (paused.status === "no_active_loop") {
							ctx.ui.notify("No active Ralph loop", "warning");
							return;
						}
						if (paused.status === "paused") {
							await updateUI(ctx.cwd, ctx);
							await restoreReleasedRalphSessionCapabilities(ctx);
							ctx.ui.notify(
								`Paused Ralph loop: ${paused.loopName} (iteration ${paused.iteration})`,
								"info",
							);
						}
						return;
					}

					case "stop": {
						if (!ctx.isIdle()) {
							ctx.ui.notify(
								"Agent is busy. Press ESC to interrupt, then run /ralph stop.",
								"warning",
							);
							return;
						}

						const sessionFile = sessionFileFromContext(ctx);
						let scopedLoop = await withRalph((ralph) =>
							ralph
								.findLoopBySessionFile(ctx.cwd, sessionFile)
								.pipe(Effect.map(Option.getOrUndefined)),
						);
						if (!scopedLoop) {
							const loops = await listLoops(ctx.cwd);
							const pausedLoops = loops.filter((loop) => loop.status === "paused");
							const activeLoops = loops.filter((loop) => loop.status === "active");
							if (activeLoops.length === 0) {
								scopedLoop = pausedLoops.length === 1 ? pausedLoops[0] : undefined;
							}
						}

						let stopped: RalphStopLoopResult;
						if (scopedLoop?.status === "paused") {
							await withRalph((ralph) =>
								ralph.syncCurrentLoopFromSession(ctx.cwd, sessionFile),
							);
							const resumeMaxIterations =
								scopedLoop.maxIterations > 0 &&
								scopedLoop.iteration >= scopedLoop.maxIterations
									? Option.some(scopedLoop.iteration + 1)
									: Option.none<number>();
							const resumed = await withRalph((ralph) =>
								ralph.resumeLoopState(ctx.cwd, {
									loopName: scopedLoop.name,
									maxIterations: resumeMaxIterations,
								}),
							);
							stopped =
								resumed.status === "resumed"
									? await withRalph((ralph) => ralph.stopActiveLoop(ctx.cwd))
									: { status: "no_active_loop" as const };
						} else if (scopedLoop?.status === "active") {
							await withRalph((ralph) =>
								ralph.syncCurrentLoopFromSession(ctx.cwd, sessionFile),
							);
							stopped = await withRalph((ralph) => ralph.stopActiveLoop(ctx.cwd));
						} else {
							stopped = await withRalph((ralph) => ralph.stopActiveLoop(ctx.cwd));
						}
						if (stopped.status === "no_active_loop") {
							ctx.ui.notify("No active Ralph loop", "warning");
							return;
						}

						if (stopped.status === "not_active") {
							ctx.ui.notify(`Loop "${stopped.loopName}" is not active`, "warning");
							return;
						}

						await updateUI(ctx.cwd, ctx);
						await restoreReleasedRalphSessionCapabilities(ctx);
						ctx.ui.notify(
							`Stopped Ralph loop: ${stopped.loopName} (iteration ${stopped.iteration})`,
							"info",
						);
						return;
					}

					case "resume": {
						const parsed = parseResumeArgs(rest);
						if (!parsed.ok) {
							if (parsed.error === "missing loop name") {
								ctx.ui.notify(
									"Usage: /ralph resume <name> [--max-iterations N]",
									"warning",
								);
								return;
							}
							ctx.ui.notify(
								`Invalid Ralph resume arguments: ${parsed.error}`,
								"warning",
							);
							return;
						}

						const loopName = parsed.value.name;
						const resumed = await withRalph((ralph) =>
							ralph.resumeLoopState(ctx.cwd, {
								loopName,
								maxIterations: parsed.value.maxIterations,
							}),
						);
						if (resumed.status === "not_found") {
							ctx.ui.notify(`Loop "${loopName}" not found`, "error");
							return;
						}
						if (resumed.status === "max_iterations_too_low") {
							ctx.ui.notify(
								`Loop "${loopName}" is at iteration ${resumed.iteration}. --max-iterations must be greater than ${resumed.iteration} (got ${resumed.requestedMaxIterations}).`,
								"warning",
							);
							return;
						}
						if (resumed.status === "max_iterations_reached") {
							ctx.ui.notify(
								`Loop "${loopName}" reached max iterations (${resumed.iteration}/${resumed.maxIterations}). Resume with /ralph resume ${loopName} --max-iterations ${resumed.iteration + 1} (or higher).`,
								"warning",
							);
							await updateUI(ctx.cwd, ctx);
							return;
						}

						await updateUI(ctx.cwd, ctx);
						ctx.ui.notify(`Resuming: ${loopName}`, "info");
						await runLoop(ctx, loopName);
						return;
					}

					case "status": {
						const loops = await listLoops(ctx.cwd);
						if (loops.length === 0) {
							ctx.ui.notify("No Ralph loops found.", "info");
							return;
						}
						ctx.ui.notify(
							`Ralph loops:\n${loops.map((loop) => formatLoop(loop)).join("\n")}`,
							"info",
						);
						return;
					}

					case "cancel": {
						const loopName = rest.trim();
						if (!loopName) {
							ctx.ui.notify("Usage: /ralph cancel <name>", "warning");
							return;
						}
						const cancelled = await withRalph((ralph) =>
							ralph.cancelLoop(ctx.cwd, loopName),
						);
						if (cancelled.status === "not_found") {
							ctx.ui.notify(`Loop "${loopName}" not found`, "error");
							return;
						}
						ctx.ui.notify(`Cancelled: ${loopName}`, "info");
						await updateUI(ctx.cwd, ctx);
						return;
					}

					case "archive": {
						const loopName = rest.trim();
						if (!loopName) {
							ctx.ui.notify("Usage: /ralph archive <name>", "warning");
							return;
						}

						const archived = await withRalph((ralph) =>
							ralph.archiveLoopByName(ctx.cwd, loopName),
						);
						if (archived.status === "not_found") {
							ctx.ui.notify(`Loop "${loopName}" not found`, "error");
							return;
						}
						if (archived.status === "active_loop") {
							ctx.ui.notify(
								"Cannot archive active loop. Pause or stop it first.",
								"warning",
							);
							return;
						}

						ctx.ui.notify(`Archived: ${loopName}`, "info");
						await updateUI(ctx.cwd, ctx);
						return;
					}

					case "clean": {
						const all = rest.trim() === "--all";
						const cleaned = await withRalph((ralph) =>
							ralph.cleanCompletedLoops(ctx.cwd, all),
						);
						if (cleaned.cleanedLoops.length === 0) {
							ctx.ui.notify("No completed loops to clean", "info");
							return;
						}

						const suffix = all ? " (all files)" : " (state only)";
						ctx.ui.notify(
							`Cleaned ${cleaned.cleanedLoops.length} loop(s)${suffix}:\n${cleaned.cleanedLoops.map((loopName) => `  • ${loopName}`).join("\n")}`,
							"info",
						);
						await updateUI(ctx.cwd, ctx);
						return;
					}

					case "list": {
						const archived = rest.trim() === "--archived";
						const loops = await listLoops(ctx.cwd, archived);
						if (loops.length === 0) {
							ctx.ui.notify(
								archived
									? "No archived loops"
									: "No loops found. Use /ralph list --archived for archived.",
								"info",
							);
							return;
						}
						const label = archived ? "Archived loops" : "Ralph loops";
						ctx.ui.notify(
							`${label}:\n${loops.map((loop) => formatLoop(loop)).join("\n")}`,
							"info",
						);
						return;
					}

					case "configure": {
						if (!ctx.hasUI) {
							ctx.ui.notify(
								"/ralph configure requires an interactive UI.",
								"warning",
							);
							return;
						}

						const arg = rest.trim();
						const loops = await listLoops(ctx.cwd);
						// listLoops already returns only Ralph loops via RalphRepo.listLoops
						const ralphLoops = loops;
						const stateTargets: ConfigureTarget[] = ralphLoops.map((loop) => ({
							loopName: loop.name,
							taskFile: loop.taskFile,
							loop,
						}));
						const taskOnlyTargets = await listTaskOnlyConfigureTargets(
							ctx.cwd,
							ralphLoops,
						);
						const configureTargets = [...stateTargets, ...taskOnlyTargets];

						let targetLoopName: string | undefined;
						let targetTaskFile: string | undefined;

						if (arg) {
							const resolved = resolveLoopTarget(arg);
							targetLoopName = resolved.loopName;
							targetTaskFile = resolved.taskFile;
						} else {
							// Try current Ralph-owned loop
							const sessionFile = sessionFileFromContext(ctx);
							const owned = await withRalph((ralph) =>
								ralph
									.findLoopBySessionFile(ctx.cwd, sessionFile)
									.pipe(Effect.map(Option.getOrUndefined)),
							);
							if (owned) {
								targetLoopName = owned.name;
								targetTaskFile = owned.taskFile;
							}
						}

						if (!targetLoopName) {
							// Show selector of configurable Ralph loops
							if (configureTargets.length === 0) {
								ctx.ui.notify("No Ralph loops found to configure.", "info");
								return;
							}
							const items: SelectItem[] = configureTargets.map((target) => ({
								value: target.loopName,
								label:
									target.loop === undefined
										? `${target.loopName} (task, no state)`
										: `${target.loopName} (${target.loop.status}, iter ${target.loop.iteration})`,
								description: target.taskFile,
							}));
							await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
								const selector = new SelectList(
									items,
									Math.min(items.length + 2, 10),
									{
										selectedPrefix: (text) => theme.fg("accent", text),
										selectedText: (text) =>
											theme.fg("accent", theme.bold(text)),
										description: (text) => theme.fg("dim", text),
										scrollInfo: (text) => theme.fg("muted", text),
										noMatch: (text) => theme.fg("warning", text),
									},
								);
								selector.onSelect = (item) => {
									targetLoopName = item.value;
									targetTaskFile = configureTargets.find(
										(target) => target.loopName === item.value,
									)?.taskFile;
									done(undefined as unknown as void);
								};
								selector.onCancel = () => done(undefined as unknown as void);
								return selector;
							});
							if (!targetLoopName) return;
						}

						const resolvedTargetLoopName = targetLoopName;
						let loop = ralphLoops.find((l) => l.name === resolvedTargetLoopName);
						if (!loop) {
							const taskFile =
								targetTaskFile ??
								resolveLoopTarget(resolvedTargetLoopName).taskFile;
							const taskContent = await readExistingTaskFile(ctx.cwd, taskFile);
							if (taskContent === undefined) {
								ctx.ui.notify(
									`Loop "${resolvedTargetLoopName}" not found and task file does not exist: ${taskFile}`,
									"error",
								);
								return;
							}
							const executionProfile = await captureCurrentExecutionProfile(ctx);
							if (executionProfile === null) {
								ctx.ui.notify(
									"Could not capture the current execution profile for this Ralph loop.",
									"error",
								);
								return;
							}
							const parsedDefaults = parseArgs(resolvedTargetLoopName);
							if (!parsedDefaults.ok) {
								ctx.ui.notify(
									`Could not prepare default Ralph configuration: ${parsedDefaults.error}`,
									"error",
								);
								return;
							}
							const capabilityContract = await captureCurrentCapabilityContract(ctx);
							const created = await withRalph((ralph) =>
								ralph.createDraftLoopForConfiguration(ctx.cwd, {
									loopName: resolvedTargetLoopName,
									taskFile,
									taskContent,
									executionProfile,
									sandboxProfile: captureSandboxProfile(pi, ctx),
									maxIterations: parsedDefaults.value.maxIterations,
									itemsPerIteration: parsedDefaults.value.itemsPerIteration,
									reflectEvery: parsedDefaults.value.reflectEvery,
									reflectInstructions: parsedDefaults.value.reflectInstructions,
									capabilityContract,
								}),
							);
							loop = created.loop;
							if (created.createdState) {
								ctx.ui.notify(
									`Created configurable Ralph state for "${resolvedTargetLoopName}" from ${taskFile}.`,
									"info",
								);
							}
						}
						const resolvedLoopName = loop.name;

						const state = loop;
						let currentSandboxProfile =
							Option.getOrUndefined(state.sandboxProfile) ??
							captureSandboxProfile(pi, ctx);
						let sandboxStr = currentSandboxProfile.preset;
						let currentMaxIterations = state.maxIterations;
						let currentItemsPerIteration = state.itemsPerIteration;
						let currentReflectEvery = state.reflectEvery;
						let currentReflectInstructions = state.reflectInstructions;
						let executionProfileLabel = `${state.executionProfile.model} / ${state.executionProfile.thinking}`;
						let toolsActive = [
							...excludeRalphSystemControlTools(
								state.capabilityContract.tools.activeNames,
							),
						];
						let agentsEnabled = [...state.capabilityContract.agents.enabledNames];
						let editReflectionInstructions = false;

						const pendingMutations: RalphConfigMutation[] = [];
						let dirty = false;

						const recordMutation = (mutation: RalphConfigMutation): void => {
							const existingIndex = pendingMutations.findIndex(
								(existing) => existing.kind === mutation.kind,
							);
							if (existingIndex === -1) {
								pendingMutations.push(mutation);
							} else {
								pendingMutations.splice(existingIndex, 1, mutation);
							}
							dirty = true;
						};

						await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
							let settingsList: SettingsList;
							const closeConfigure = () => done(undefined as unknown as void);
							const reflectionLabel = (): string =>
								formatDisplayPreview(currentReflectInstructions, 40);
							const items: SettingItem[] = [
								{
									id: "maxIterations",
									label: "Max iterations",
									description: "Stop after N iterations (0 = unlimited)",
									currentValue: String(currentMaxIterations),
									submenu: (_currentValue, submenuDone) =>
										new NumericInputSubmenu(
											"Max iterations",
											"Enter a non-negative integer. Use 0 for unlimited.",
											currentMaxIterations,
											(value) => {
												currentMaxIterations = value;
												recordMutation({ kind: "maxIterations", value });
												submenuDone(String(value));
											},
											() => submenuDone(),
										),
								},
								{
									id: "itemsPerIteration",
									label: "Items per iteration",
									description:
										"Suggested work items per Ralph turn (0 = no hint)",
									currentValue: String(currentItemsPerIteration),
									submenu: (_currentValue, submenuDone) =>
										new NumericInputSubmenu(
											"Items per iteration",
											"Enter a non-negative integer. Use 0 to omit the item-count hint.",
											currentItemsPerIteration,
											(value) => {
												currentItemsPerIteration = value;
												recordMutation({
													kind: "itemsPerIteration",
													value,
												});
												submenuDone(String(value));
											},
											() => submenuDone(),
										),
								},
								{
									id: "reflectEvery",
									label: "Reflect every",
									description:
										"Reflection checkpoint frequency in iterations (0 = off)",
									currentValue: String(currentReflectEvery),
									submenu: (_currentValue, submenuDone) =>
										new NumericInputSubmenu(
											"Reflect every",
											"Enter a non-negative integer. Use 0 to disable reflection checkpoints.",
											currentReflectEvery,
											(value) => {
												currentReflectEvery = value;
												recordMutation({ kind: "reflectEvery", value });
												submenuDone(String(value));
											},
											() => submenuDone(),
										),
								},
								{
									id: "tools",
									label: "Active tools",
									description: `User-configurable tools (${toolsActive.length} active). System-managed: ralph_continue, ralph_finish`,
									currentValue: formatNameList(toolsActive),
									submenu: (_currentValue, submenuDone) =>
										new ToggleSettingsSubmenu(
											"Active tools",
											"Toggle tools captured in this loop contract. Ralph control tools are managed by the loop runtime.",
											state.capabilityContract.tools.availableSnapshot
												.filter(
													(tool) => !isRalphSystemControlTool(tool.name),
												)
												.map((tool) => ({
													name: tool.name,
													description: normalizeDisplayLine(
														tool.description,
													),
												})),
											new Set(toolsActive),
											(next, changed) => {
												toolsActive = [...next];
												if (changed) {
													recordMutation({
														kind: "capabilityContractTools",
														activeNames: next,
													});
												}
												submenuDone(formatNameList(next));
											},
										),
								},
								{
									id: "agents",
									label: "Enabled agents",
									description: `Agents enabled for this loop (${agentsEnabled.length})`,
									currentValue: formatNameList(agentsEnabled),
									submenu: (_currentValue, submenuDone) =>
										new ToggleSettingsSubmenu(
											"Enabled agents",
											"Toggle agents allowed by this loop contract.",
											state.capabilityContract.agents.registrySnapshot.map(
												(agent) => ({
													name: agent.name,
													description: normalizeDisplayLine(
														agent.description,
													),
												}),
											),
											new Set(agentsEnabled),
											(next, changed) => {
												agentsEnabled = [...next];
												if (changed) {
													recordMutation({
														kind: "capabilityContractAgents",
														enabledNames: next,
													});
												}
												submenuDone(formatNameList(next));
											},
										),
								},
								{
									id: "executionProfile",
									label: "Execution profile",
									description: "Pinned model and thinking level",
									currentValue: executionProfileLabel,
									submenu: (_currentValue, submenuDone) =>
										new ActionSelectSubmenu(
											"Execution profile",
											`Current: ${executionProfileLabel}`,
											[
												{
													value: "recapture",
													label: "Recapture current session",
													description:
														"Pin the current model and thinking level to this loop.",
												},
											],
											(value) => {
												if (value !== "recapture") {
													submenuDone();
													return;
												}
												void captureCurrentExecutionProfile(ctx).then(
													(profile) => {
														if (profile === null) {
															ctx.ui.notify(
																"Could not capture current execution profile.",
																"error",
															);
															submenuDone();
															return;
														}
														executionProfileLabel = `${profile.model} / ${profile.thinking}`;
														recordMutation({
															kind: "executionProfile",
															profile,
														});
														ctx.ui.notify(
															"Execution profile recaptured from current session.",
															"info",
														);
														submenuDone(executionProfileLabel);
													},
												);
											},
											() => submenuDone(),
										),
								},
								{
									id: "sandboxProfile",
									label: "Sandbox profile",
									description:
										"Pinned sandbox preset. Enter/Space cycles read-only, workspace-write, and full-access.",
									currentValue: sandboxStr,
									values: [...SANDBOX_PRESET_NAMES],
								},
								{
									id: "sandboxRecapture",
									label: "Recapture sandbox",
									description:
										"Pin the current session sandbox preset and overrides to this loop.",
									currentValue: "current session",
									values: ["current session"],
								},
								{
									id: "reflectInstructions",
									label: "Reflection instructions",
									description: "Custom prompt for reflection checkpoints",
									currentValue: reflectionLabel(),
									submenu: (_currentValue, submenuDone) =>
										new ActionSelectSubmenu(
											"Reflection instructions",
											"Open Pi's editor to edit the full multi-line reflection prompt.",
											[
												{
													value: "edit",
													label: "Edit in editor",
													description:
														"Close this selector and open the full-screen editor.",
												},
											],
											(value) => {
												if (value === "edit") {
													editReflectionInstructions = true;
													submenuDone(reflectionLabel());
													closeConfigure();
													return;
												}
												submenuDone();
											},
											() => submenuDone(),
										),
								},
							];
							settingsList = new SettingsList(
								items,
								Math.min(items.length + 2, 12),
								getSettingsListTheme(),
								(id, newValue) => {
									if (id === "sandboxProfile") {
										const preset = SANDBOX_PRESET_NAMES.find(
											(candidate) => candidate === newValue,
										);
										if (preset === undefined) {
											return;
										}
										currentSandboxProfile = sandboxProfileForPreset(
											preset,
											currentSandboxProfile,
										);
										sandboxStr = currentSandboxProfile.preset;
										recordMutation({
											kind: "sandboxProfile",
											profile: currentSandboxProfile,
										});
										settingsList.updateValue("sandboxProfile", sandboxStr);
									}
									if (id === "sandboxRecapture") {
										currentSandboxProfile = captureSandboxProfile(pi, ctx);
										sandboxStr = currentSandboxProfile.preset;
										recordMutation({
											kind: "sandboxProfile",
											profile: currentSandboxProfile,
										});
										settingsList.updateValue("sandboxProfile", sandboxStr);
										settingsList.updateValue(
											"sandboxRecapture",
											"current session",
										);
										ctx.ui.notify(
											"Sandbox profile recaptured from current session.",
											"info",
										);
									}
								},
								closeConfigure,
								{ enableSearch: true },
							);
							const container = new Container();
							container.addChild(
								new Text(`Configure Ralph loop: ${resolvedLoopName}`, 0, 0),
							);
							container.addChild(new Spacer(1));
							container.addChild(settingsList);
							container.addChild(new Spacer(1));
							container.addChild(
								new Text(
									"Enter/Space edits or cycles · type to search · Esc saves and closes",
									0,
									0,
								),
							);
							return {
								render: (width: number) => container.render(width),
								invalidate: () => container.invalidate(),
								handleInput: (data: string) => settingsList.handleInput(data),
							};
						});

						if (editReflectionInstructions) {
							const value = await ctx.ui.editor(
								"Reflection instructions",
								currentReflectInstructions,
							);
							if (value !== undefined) {
								currentReflectInstructions = value;
								recordMutation({ kind: "reflectInstructions", value });
							}
						}

						if (dirty && pendingMutations.length > 0) {
							const result = await withRalph((ralph) =>
								ralph.configureLoopMany(
									ctx.cwd,
									resolvedLoopName,
									pendingMutations,
								),
							);
							if (result.status === "updated") {
								ctx.ui.notify(
									`Updated loop "${resolvedLoopName}" configuration.`,
									"info",
								);
							} else if (result.status === "deferred") {
								ctx.ui.notify(
									`Queued ${result.count} loop configuration change(s) for the next iteration of "${resolvedLoopName}".`,
									"info",
								);
							}
						}
						return;
					}

					case "nuke": {
						const force = rest.trim() === "--yes";
						const warning =
							"This deletes all Ralph state, task, and archive files under .pi/loops. Non-Ralph loop data is kept.";

						const runNuke = async () => {
							const result = await withRalph((ralph) => ralph.nukeLoops(ctx.cwd));
							if (!result.removed) {
								if (ctx.hasUI) {
									ctx.ui.notify(
										"No Ralph loop data found under .pi/loops.",
										"info",
									);
								}
								return;
							}

							if (ctx.hasUI) {
								ctx.ui.notify("Removed Ralph loop data under .pi/loops.", "info");
							}
							await updateUI(ctx.cwd, ctx);
						};

						if (!force) {
							if (ctx.hasUI) {
								void ctx.ui
									.confirm("Delete all Ralph loop files?", warning)
									.then((confirmed) => {
										if (confirmed) {
											void runNuke();
										}
									});
							} else {
								ctx.ui.notify(
									`Run /ralph nuke --yes to confirm. ${warning}`,
									"warning",
								);
							}
							return;
						}

						if (ctx.hasUI) {
							ctx.ui.notify(warning, "warning");
						}
						await runNuke();
						return;
					}

					default: {
						ctx.ui.notify(HELP, "info");
						return;
					}
				}
			} catch (error) {
				if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
					return;
				}
				throw error;
			} finally {
				await syncRalphHandshakeToolsSafely(ctx);
			}
		},
	});

	pi.registerTool({
		name: "ralph_continue",
		label: "Ralph Continue",
		description:
			"Signal that this Ralph iteration is complete and Ralph should continue to the next iteration.",
		promptSnippet: "Advance an active Ralph loop after completing the current iteration.",
		promptGuidelines: [
			"Call this after making real iteration progress so Ralph can queue the next prompt.",
			"Do not call this if there is no active loop or if a Ralph decision was already recorded for this iteration.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const result = await withRalph((ralph) =>
					ralph.recordContinue(ctx.cwd, sessionFileFromContext(ctx)),
				);
				await updateUI(ctx.cwd, ctx);
				await syncRalphHandshakeToolsSafely(ctx);
				return {
					content: [{ type: "text", text: result.text }],
					details: {},
				};
			} catch (error) {
				const message = handlePersistedStateFailure(error, ctx);
				if (Option.isSome(message)) {
					return {
						content: [{ type: "text", text: message.value }],
						details: {},
						isError: true,
					};
				}
				throw error;
			}
		},

		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("ralph_continue")), 0, 0);
		},

		renderResult(result, _options, theme) {
			const msg = result.content[0];
			const text = msg?.type === "text" ? msg.text : "";
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});

	pi.registerTool({
		name: "ralph_finish",
		label: "Ralph Finish",
		description:
			"Signal that the overall Ralph loop is complete. Provide a short completion message.",
		promptSnippet: "Finish an active Ralph loop with a short completion message.",
		promptGuidelines: [
			"Call this only when the overall Ralph loop is complete.",
			"Provide a short concrete completion message.",
			"Do not call this if there is no active loop or if a Ralph decision was already recorded for this iteration.",
		],
		parameters: Type.Object({
			message: Type.String({
				description: "Short completion message for the finished Ralph loop",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await withRalph((ralph) =>
					ralph.recordFinish(ctx.cwd, sessionFileFromContext(ctx), params.message),
				);
				await updateUI(ctx.cwd, ctx);
				await syncRalphHandshakeToolsSafely(ctx);
				return {
					content: [{ type: "text", text: result.text }],
					details: {},
				};
			} catch (error) {
				const message = handlePersistedStateFailure(error, ctx);
				if (Option.isSome(message)) {
					return {
						content: [{ type: "text", text: message.value }],
						details: {},
						isError: true,
					};
				}
				throw error;
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("ralph_finish "));
			text += theme.fg("accent", String(args.message ?? ""));
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const msg = result.content[0];
			const text = msg?.type === "text" ? msg.text : "";
			return new Text(theme.fg("muted", text), 0, 0);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		try {
			const sessionFile = sessionFileFromContext(ctx);
			const state = await withRalph((ralph) =>
				ralph
					.findLoopBySessionFile(ctx.cwd, sessionFile)
					.pipe(Effect.map(Option.getOrUndefined)),
			);
			const inActiveIteration =
				state !== undefined &&
				state.status === "active" &&
				Option.getOrUndefined(state.activeIterationSessionFile) === sessionFile;
			setToolEnabled(pi, RALPH_CONTINUE_TOOL_NAME, inActiveIteration);
			setToolEnabled(pi, RALPH_FINISH_TOOL_NAME, inActiveIteration);

			if (!inActiveIteration || state === undefined) {
				return;
			}

			const iterStr = `${state.iteration}${state.maxIterations > 0 ? `/${state.maxIterations}` : ""}`;
			let instructions = `Ralph loop task file: ${state.taskFile}\n`;
			instructions += "- Read the task file first\n";
			instructions +=
				"- If the task file references backlog, run the listed backlog commands before implementing\n";
			instructions += "- Treat backlog as the source of truth when backlog is referenced\n";
			instructions += "- Work on the next unchecked task item\n";
			if (state.itemsPerIteration > 0) {
				instructions += `- Target ~${state.itemsPerIteration} item(s) this iteration\n`;
			}
			instructions += "- Update checkboxes and short notebook notes in the task file\n";
			instructions += "- Record verification evidence for completed items\n";
			instructions += "- Call ralph_finish with a short message when the loop is complete\n";
			instructions +=
				"- Call ralph_continue when this iteration is complete and work remains\n";
			instructions += "- Correct recoverable tool failures and continue the iteration\n";
			instructions +=
				"- End with exactly one Ralph loop tool: ralph_continue or ralph_finish";

			return {
				systemPrompt:
					event.systemPrompt +
					`\n[RALPH LOOP - ${state.name} - Iteration ${iterStr}]\n\n${instructions}`,
			};
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});

	pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
		try {
			const cwd = cwdFromContextIfLive(ctx);
			const sessionFile = sessionFileFromContextIfLive(ctx);
			if (cwd === undefined || sessionFile === undefined) {
				return;
			}

			const result = await withRalph((ralph) =>
				ralph.handleAgentEnd(cwd, sessionFile, event),
			);
			if (Option.isSome(result.banner)) {
				notifySafely(ctx, result.banner.value, "info");
				try {
					await updateUI(cwd, ctx);
				} catch (error) {
					if (!isManagedRuntimeDisposedError(error)) {
						throw error;
					}
				}
			}
			await restoreReleasedRalphSessionCapabilities(ctx);
			await syncRalphHandshakeToolsSafely(ctx);
		} catch (error) {
			if (isIgnorableSessionContextError(error)) {
				return;
			}
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			syncPromptDispatcher(ctx);
			syncExecutionProfileApplier(ctx);
			syncCapabilityContractApplier(ctx);
			await withRalph((ralph) =>
				ralph.syncCurrentLoopFromSession(ctx.cwd, sessionFileFromContext(ctx)),
			);
			await restoreReleasedRalphSessionCapabilities(ctx);
			const active = (await listLoops(ctx.cwd)).filter((loop) => loop.status === "active");
			if (active.length > 0 && ctx.hasUI) {
				const lines = active.map(
					(loop) =>
						`  • ${loop.name} (iteration ${loop.iteration}${loop.maxIterations > 0 ? `/${loop.maxIterations}` : ""})`,
				);
				ctx.ui.notify(
					`Active Ralph loops:\n${lines.join("\n")}\n\nUse /ralph resume <name> to continue`,
					"info",
				);
			}
			await updateUI(ctx.cwd, ctx);
			await syncRalphHandshakeToolsSafely(ctx);
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			unregisterRalphPromptDispatcher(sessionFileFromContext(ctx));
			unregisterRalphExecutionProfileApplier(sessionFileFromContext(ctx));
			unregisterRalphCapabilityContractApplier(sessionFileFromContext(ctx));
			await withRalph((ralph) =>
				ralph.persistOwnedLoopOnShutdown(ctx.cwd, sessionFileFromContext(ctx)),
			);
			setToolEnabled(pi, RALPH_CONTINUE_TOOL_NAME, false);
			setToolEnabled(pi, RALPH_FINISH_TOOL_NAME, false);
		} catch (error) {
			if (Option.isSome(handlePersistedStateFailure(error, ctx))) {
				return;
			}
			throw error;
		}
	});
}
