import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getHomeDir } from "../shared/home.js";

import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createEditTool,
	createWriteTool,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Effect } from "effect";

import {
	checkBashApproval,
	checkFilesystemApproval,
	looksLikePolicyViolation,
	requestApprovalAfterFailure,
} from "./approval.js";
import { classifySandboxFailure } from "./sandbox-diagnostics.js";
import {
	buildSandboxChangeNoticeText,
	buildSandboxStateNoticeText,
	computeSandboxConfigHash,
	injectSandboxNoticeIntoMessages,
} from "./sandbox-change.js";
import type { ResolvedSandboxConfig, SandboxConfig, SandboxPreset } from "./config.js";
import { DEFAULT_SANDBOX_CONFIG, computeEffectiveConfig, ensureUserDefaults } from "./config.js";
import { checkWriteAllowed } from "./fs-policy.js";
import { wrapCommandWithSandbox, isAsrtAvailable, getAsrtLoadError } from "./bash.js";
import type { ShellInvocation } from "./bash.js";
import { detectMissingSandboxDeps, formatMissingDepsMessage } from "./sandbox-prereqs.js";
import { discoverWorkspaceRoot } from "./workspace-root.js";
import { renderShellCall, renderShellResult, type ShellToolDetails } from "./shell-render.js";
import { rewriteShellToolNames } from "./mutation-tools.js";

import { isRecord } from "../shared/json.js";
import type { TauPersistedState } from "../shared/state.js";
import { loadPersistedState } from "../shared/state.js";
import { setToolActivationTransform } from "../shared/tool-activation.js";
import { type ApprovalBroker, getWorkerApprovalBroker } from "../agent/approval-broker.js";
import { SANDBOX_PRESET_NAMES } from "../shared/policy.js";
import {
	EXEC_DEFAULT_YIELD_TIME_MS,
	WRITE_STDIN_DEFAULT_YIELD_TIME_MS,
	type ShellRunResult,
	type ShellService,
} from "../services/shell.js";

type SandboxStateInternal = {
	createSandboxedBashOperations?:
		| ((ctx: ExtensionContext, escalate: boolean) => BashOperations)
		| undefined;
	workspaceRoot?: string | undefined;
	effectiveConfig?: ResolvedSandboxConfig | undefined;
	approvalBroker?: ApprovalBroker | undefined;
};

let runtimeState: SandboxStateInternal = {};

function getSandboxRuntimeState(): SandboxStateInternal {
	return runtimeState;
}

function updateSandboxRuntimeState(patch: Partial<SandboxStateInternal>): void {
	runtimeState = { ...runtimeState, ...patch };
}

/**
 * Kill a process and all its children.
 */
function killProcessTree(pid: number): void {
	try {
		// On Unix, kill the process group
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			// Fallback: kill just the process
			process.kill(pid, "SIGTERM");
		} catch {
			// Already dead
		}
	}
}

const SANDBOX_CHANGE_MESSAGE_TYPE = "sandbox:change";
const SANDBOX_MUTATION_TOOLS_KEY = "sandbox.mutation-tools";

const PRESET_VALUES: readonly SandboxPreset[] = SANDBOX_PRESET_NAMES;

export const EXEC_COMMAND_TOOL_DESCRIPTION =
	"Runs a command in a PTY, returning output or a session ID for ongoing interaction. Commands run sandboxed by default.";
export const EXEC_COMMAND_TTY_PARAMETER_DESCRIPTION =
	"Whether to allocate a TTY for the command. Defaults to false (plain pipes); set to true to open a PTY and access TTY process.";
export const WRITE_STDIN_TOOL_DESCRIPTION =
	"Writes characters to an existing unified exec session and returns recent output.";
export const WRITE_STDIN_CHARS_PARAMETER_DESCRIPTION =
	"Bytes to write to stdin (may be empty to poll).";

export function formatShellResult(result: ShellRunResult): string {
	const parts: string[] = [];
	if (result.wallTimeMs !== undefined) {
		parts.push(`Wall time: ${(result.wallTimeMs / 1_000).toFixed(4)} seconds`);
	}
	if (result.exitCode !== undefined) {
		parts.push(`Process exited with code ${result.exitCode}`);
	}
	if (result.sessionId !== undefined) {
		parts.push(`Process running with session ID ${result.sessionId}`);
	}
	parts.push("Output:");
	parts.push(result.output);
	return parts.join("\n");
}

const PRESET_LABELS: Record<SandboxPreset, string> = {
	"read-only": "Read Only",
	"workspace-write": "Workspace Write",
	"full-access": "Full Access",
};

type SessionState = {
	/**
	 * When ASRT is unavailable due to missing deps, we prompt once per session.
	 * This caches the user's choice.
	 */
	sandboxUnavailableDecision?: "allow" | "deny" | undefined;

	/**
	 * Session-local sandbox overrides set via the sandbox settings UI.
	 * These are stored in the session history (tau:state) and do not touch project files.
	 */
	sessionOverride?: SandboxConfig | undefined;

	/**
	 * True once we have injected sandbox *semantics* into the system prompt
	 * on the first model turn.
	 */
	systemPromptInjected?: boolean | undefined;

	/** Hash of the sandbox config last communicated to the model. */
	lastCommunicatedHash?: string | undefined;

	/** Pending SANDBOX_CHANGE notice to inject into the next user message as content[0]. */
	pendingSandboxNotice?: { hash: string; text: string } | undefined;
};

function readSessionOverride(value: unknown): SandboxConfig | undefined {
	if (!isRecord(value)) return undefined;
	const next: SandboxConfig = {};

	const preset = value["preset"];
	if (preset === "read-only" || preset === "workspace-write" || preset === "full-access") {
		next.preset = preset;
	}

	const subagent = value["subagent"];
	if (typeof subagent === "boolean") {
		next.subagent = subagent;
	}

	return next;
}

function sessionStateToPersisted(state: SessionState): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (state.sandboxUnavailableDecision)
		out["sandboxUnavailableDecision"] = state.sandboxUnavailableDecision;
	if (state.sessionOverride) out["sessionOverride"] = { ...state.sessionOverride };
	if (typeof state.systemPromptInjected === "boolean")
		out["systemPromptInjected"] = state.systemPromptInjected;
	if (typeof state.lastCommunicatedHash === "string")
		out["lastCommunicatedHash"] = state.lastCommunicatedHash;
	if (state.pendingSandboxNotice) {
		out["pendingSandboxNotice"] = {
			hash: state.pendingSandboxNotice.hash,
			text: state.pendingSandboxNotice.text,
		};
	}
	return out;
}

function loadSessionState(persisted: TauPersistedState | undefined): SessionState | undefined {
	const raw = persisted?.sandbox;
	if (!isRecord(raw)) return undefined;

	const result: SessionState = {};

	const sandboxUnavailableDecision = raw["sandboxUnavailableDecision"];
	if (sandboxUnavailableDecision === "allow" || sandboxUnavailableDecision === "deny") {
		result.sandboxUnavailableDecision = sandboxUnavailableDecision;
	}

	const sessionOverride = readSessionOverride(raw["sessionOverride"]);
	if (sessionOverride) {
		result.sessionOverride = sessionOverride;
	}

	const systemPromptInjected = raw["systemPromptInjected"];
	if (typeof systemPromptInjected === "boolean") {
		result.systemPromptInjected = systemPromptInjected;
	}

	const lastCommunicatedHash = raw["lastCommunicatedHash"];
	if (typeof lastCommunicatedHash === "string" && lastCommunicatedHash.length > 0) {
		result.lastCommunicatedHash = lastCommunicatedHash;
	}

	const pending = raw["pendingSandboxNotice"];
	if (isRecord(pending)) {
		const hash = pending["hash"];
		const text = pending["text"];
		if (typeof hash === "string" && typeof text === "string" && !text.includes("allowlist")) {
			result.pendingSandboxNotice = { hash, text };
		}
	}

	return result;
}

function buildSourceHint(): string {
	return "applies to this session";
}

interface SandboxPersistedAccess {
	readonly getSnapshot: () => TauPersistedState;
	readonly update: (patch: Partial<TauPersistedState>) => void;
}

export function getSandboxedBashOperations(
	ctx: ExtensionContext,
	escalate: boolean,
): BashOperations | undefined {
	return getSandboxRuntimeState().createSandboxedBashOperations?.(ctx, escalate);
}

export default function initSandbox(
	pi: ExtensionAPI,
	shellRuntime: ShellService,
	persistence: SandboxPersistedAccess,
) {
	// Register CLI flags
	pi.registerFlag("sandbox-mode", {
		description: "Sandbox preset (read-only, workspace-write, full-access)",
		type: "string",
	});
	pi.registerFlag("no-sandbox", {
		description: "Completely disable bubblewrap sandbox wrapper (escape hatch)",
		type: "boolean",
	});

	// Track if sandbox is completely disabled via --no-sandbox flag
	let sandboxDisabled = false;

	// First-run: ensure sandbox defaults are written into ~/.pi/agent/settings.json (only fills missing keys).
	ensureUserDefaults();

	let workspaceRoot = "";
	let sessionState: SessionState = {};
	let effectiveConfig = DEFAULT_SANDBOX_CONFIG;
	let cliOverride: SandboxConfig | undefined;

	function refreshConfig(ctx: ExtensionContext) {
		workspaceRoot = discoverWorkspaceRoot(ctx.cwd);
		const persisted = loadPersistedState(ctx);
		sessionState = loadSessionState(persisted) ?? {};

		// Session overrides come from tau:state; CLI flags override both session and file-based settings.
		const mergedOverride: SandboxConfig = {
			...sessionState.sessionOverride,
			...cliOverride,
		};

		effectiveConfig = computeEffectiveConfig({
			workspaceRoot,
			sessionOverride: mergedOverride,
		});

		const sessionId = ctx.sessionManager.getSessionId();

		updateSandboxRuntimeState({
			workspaceRoot,
			effectiveConfig,
			approvalBroker: getWorkerApprovalBroker(sessionId),
		});

		pi.events.emit("tau:sandbox:changed", effectiveConfig);
	}

	function persistState() {
		persistence.update({ sandbox: sessionStateToPersisted(sessionState) });
	}

	function installShellToolActivationTransform(): void {
		setToolActivationTransform(pi, SANDBOX_MUTATION_TOOLS_KEY, (toolNames) =>
			rewriteShellToolNames(toolNames),
		);
	}

	function sendSandboxChangeHistoryEntry(text: string): void {
		// UI-only history entry. Must not trigger a new turn.
		pi.sendMessage(
			{
				customType: SANDBOX_CHANGE_MESSAGE_TYPE,
				content: text,
				display: true,
				details: undefined,
			},
			{ triggerTurn: false },
		);
	}

	function queueSandboxChangeNotice(prevHash: string, nextHash: string) {
		// If the effective config didn't change, don't emit anything.
		if (prevHash === nextHash) return;

		// We only emit SANDBOX_CHANGE after we've established initial sandbox state
		// via a first-turn system prompt injection.
		if (!sessionState.systemPromptInjected) return;

		// If we don't know what we last communicated, treat current as baseline.
		if (!sessionState.lastCommunicatedHash) {
			sessionState.lastCommunicatedHash = prevHash;
		}

		// Full circle: back to baseline -> clear pending notice.
		if (nextHash === sessionState.lastCommunicatedHash) {
			sessionState.pendingSandboxNotice = undefined;
			return;
		}

		// Overwrite any previous pending notice: we only want the latest.
		sessionState.pendingSandboxNotice = {
			hash: nextHash,
			text: buildSandboxChangeNoticeText(effectiveConfig),
		};
	}

	function setPreset(preset: SandboxPreset) {
		const prevHash = computeSandboxConfigHash(effectiveConfig);

		sessionState.sessionOverride = { ...sessionState.sessionOverride, preset };
		persistState();

		const mergedOverride: SandboxConfig = {
			...sessionState.sessionOverride,
			...cliOverride,
		};
		effectiveConfig = computeEffectiveConfig({
			workspaceRoot,
			sessionOverride: mergedOverride,
		});

		const nextHash = computeSandboxConfigHash(effectiveConfig);
		queueSandboxChangeNotice(prevHash, nextHash);

		pi.events.emit("tau:sandbox:changed", effectiveConfig);
	}

	function buildSandboxSummary(): string {
		const lines = [
			"Sandbox configuration:",
			`Preset: ${PRESET_LABELS[effectiveConfig.preset]}`,
			`Filesystem: ${effectiveConfig.filesystemMode}`,
			`Network: ${effectiveConfig.networkMode}`,
			`Approval: ${effectiveConfig.approvalPolicy}`,
			`Subagent: ${effectiveConfig.subagent}`,
		];
		return lines.join("\n");
	}

	async function showSandboxSettings(ctx: ExtensionContext) {
		const baselineHash = computeSandboxConfigHash(effectiveConfig);

		if (!ctx.hasUI) {
			pi.sendMessage(
				{
					customType: "sandbox:info",
					content: buildSandboxSummary(),
					display: true,
					details: undefined,
				},
				{ triggerTurn: false },
			);
			return;
		}

		await ctx.ui.custom((tui, theme, _kb, done) => {
			const items: SettingItem[] = [
				{
					id: "preset",
					label: "Sandbox mode",
					currentValue: effectiveConfig.preset,
					values: [...PRESET_VALUES],
					description: buildSourceHint(),
				},
			];

			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Sandbox settings")), 1, 1));

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				getSettingsListTheme(),
				(id, newValue) => {
					if (id === "preset") {
						setPreset(newValue as SandboxPreset);
					}

					settingsList.updateValue("preset", effectiveConfig.preset);
				},
				() => done(undefined),
			);
			container.addChild(settingsList);

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		});

		const finalHash = computeSandboxConfigHash(effectiveConfig);
		if (finalHash !== baselineHash) {
			// Visible to the user in session history (but filtered out of LLM context).
			sendSandboxChangeHistoryEntry(buildSandboxChangeNoticeText(effectiveConfig));
		}
	}

	const registrationToolCwd = getHomeDir();
	const baseEditTool = createEditTool(registrationToolCwd);
	const baseWriteTool = createWriteTool(registrationToolCwd);

	function singleLine(str: string): string {
		return (str ?? "")
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	function envRecord(extra?: Readonly<Record<string, string>>): Record<string, string> {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (typeof value === "string") env[key] = value;
		}
		if (extra) {
			for (const [key, value] of Object.entries(extra)) {
				env[key] = value;
			}
		}
		return env;
	}

	function normalizeExecYieldTimeMs(value: number | undefined): number {
		if (value === undefined || !Number.isFinite(value) || value < 0) {
			return EXEC_DEFAULT_YIELD_TIME_MS;
		}
		return Math.round(value);
	}

	function normalizeWriteStdinYieldTimeMs(value: number | undefined): number {
		if (value === undefined || !Number.isFinite(value) || value < 0) {
			return WRITE_STDIN_DEFAULT_YIELD_TIME_MS;
		}
		return Math.min(Math.round(value), 600_000);
	}

	function normalizeMaxOutputTokens(value: number | undefined): number {
		if (value === undefined || !Number.isFinite(value) || value <= 0) return 10_000;
		return Math.min(Math.round(value), 250_000);
	}

	function resolveShellInvocation(opts: {
		command: string;
		shell?: string | undefined;
		login?: boolean | undefined;
	}): ShellInvocation {
		const shellFile = opts.shell?.trim() || "bash";
		const login = opts.login ?? true;
		return {
			file: shellFile,
			args: [login ? "-lc" : "-c", opts.command],
		};
	}

	function shellToolResult(result: ShellRunResult, details: Omit<ShellToolDetails, keyof ShellRunResult>) {
		return {
			content: [{ type: "text" as const, text: formatShellResult(result) }],
			details: { ...result, ...details },
		};
	}

	function shellToolError(message: string) {
		return {
			isError: true,
			content: [{ type: "text" as const, text: message }],
			details: { error: message },
		};
	}

	function appendSandboxDiagnostic(
		result: ShellRunResult,
		currentConfig: ResolvedSandboxConfig,
	): ShellRunResult {
		if (result.exitCode === undefined || result.exitCode === 0) return result;
		const classification = classifySandboxFailure(result.output);
		const gatedByConfig =
			classification.kind !== "unknown" &&
			(classification.kind !== "network" || currentConfig.networkMode !== "allow-all") &&
			(classification.kind !== "filesystem" ||
				currentConfig.filesystemMode !== "danger-full-access");
		if (!gatedByConfig) return result;

		const type =
			classification.kind === "network"
				? `network/${classification.subtype}`
				: classification.kind === "filesystem"
					? `filesystem/${classification.subtype}`
					: "unknown";
		const evidence = singleLine(classification.evidence);
		const diagnostic = {
			usingSandbox: true,
			preset: currentConfig.preset,
			filesystemMode: currentConfig.filesystemMode,
			networkMode: currentConfig.networkMode,
			classification,
		};
		const suffix =
			`\n[sandbox] Command failed likely due to sandbox restrictions (${type}). ` +
			`(preset=${currentConfig.preset}). Evidence: "${evidence}". ` +
			"If this failure is caused by sandbox restrictions, retry the same command with sandbox_permissions=\"require_escalated\".\n" +
			`SANDBOX_DIAGNOSTIC=${JSON.stringify(diagnostic)}`;
		return { ...result, output: `${result.output}${suffix}\n` };
	}

	async function ensureUnsandboxedAllowedOnSandboxUnavailable(
		ctx: ExtensionContext,
		reason: string,
		timeoutSeconds: number,
	): Promise<boolean> {
		// Cached per-session decision
		if (sessionState.sandboxUnavailableDecision === "allow") return true;
		if (sessionState.sandboxUnavailableDecision === "deny") return false;

		const broker = getSandboxRuntimeState().approvalBroker;
		if (!ctx.hasUI && !broker) {
			// Headless: default deny.
			sessionState.sandboxUnavailableDecision = "deny";
			persistState();
			return false;
		}

		const title = "Sandbox unavailable";
		const message =
			`Sandboxed shell is unavailable.\n\nReason: ${reason}\n\n` +
			"Run shell commands without sandbox for this session?";
		const timeoutMs = timeoutSeconds * 1000;

		const approved = ctx.hasUI
			? await ctx.ui.confirm(title, message, { timeout: timeoutMs })
			: await broker!.confirm(title, message, { timeoutMs });

		sessionState.sandboxUnavailableDecision = approved ? "allow" : "deny";
		persistState();
		return approved;
	}

	// Factory to create sandboxed bash operations with captured context (avoids global state race conditions)
	function createSandboxedBashOperationsInternal(
		ctx: ExtensionContext,
		escalate: boolean,
	): BashOperations {
		return {
			async exec(command, cwd, { onData, signal, timeout }) {
				// If sandbox is completely disabled, run commands directly
				if (sandboxDisabled) {
					return runCommandDirect(command, cwd, process.env as Record<string, string>, {
						onData,
						signal,
						timeout,
					});
				}

				// Subagent mode: VCS commands (git, jj) are blocked — orchestrator owns VCS
				if (effectiveConfig.subagent && /^(?:git|jj)\s/.test(command.trim())) {
					const errorMsg =
						"[sandbox] VCS commands (git, jj) are blocked in subagent mode. The orchestrator handles all VCS operations.\n";
					onData(Buffer.from(errorMsg));
					return { exitCode: 1 };
				}

				const currentConfig = effectiveConfig;
				const currentWorkspace = workspaceRoot;
				const approvalTimeout = currentConfig.approvalTimeoutSeconds;
				const broker = getSandboxRuntimeState().approvalBroker;

				// Check approval based on policy (using captured ctx)
				const approval = await checkBashApproval(
					ctx,
					currentConfig.approvalPolicy,
					command,
					escalate,
					{ timeoutSeconds: approvalTimeout },
					broker,
				);

				if (!approval.approved) {
					const errorMsg = `Sandbox: command blocked (${approval.reason})\n`;
					onData(Buffer.from(errorMsg));
					return { exitCode: 1 };
				}

				// If approval says run unsandboxed, do that
				if (approval.runUnsandboxed) {
					ctx.ui?.notify?.("Running without sandbox...", "info");
					onData(
						Buffer.from(
							"[sandbox] Running without sandbox restrictions (escalate approved).\n",
						),
					);
					return runCommandDirect(command, cwd, process.env as Record<string, string>, {
						onData,
						signal,
						timeout,
					});
				}

				// Ensure sandbox prerequisites exist. If we can't enforce the sandbox,
				// prompt once per session before falling back to unsandboxed execution.
				const prereqs = detectMissingSandboxDeps({ platform: os.platform() });
				const asrtAvailable = await isAsrtAvailable();

				if (!asrtAvailable || prereqs.missingRequired.length > 0) {
					const parts: string[] = [];
					if (!asrtAvailable) {
						parts.push(getAsrtLoadError() ?? "ASRT module failed to load");
					}
					const depsMsg = formatMissingDepsMessage(prereqs);
					if (depsMsg) parts.push(depsMsg);
					const reason = parts.join("; ");

					const allowUnsandboxed = await ensureUnsandboxedAllowedOnSandboxUnavailable(
						ctx,
						reason,
						approvalTimeout,
					);
					if (!allowUnsandboxed) {
						onData(
							Buffer.from(
								`[sandbox] Sandboxed shell unavailable (${reason}). Refusing to run without sandbox.\n`,
							),
						);
						return { exitCode: 1 };
					}

					onData(
						Buffer.from(
							`[sandbox] Sandboxed shell unavailable (${reason}). Running without sandbox for this session.\n`,
						),
					);
					return runCommandDirect(command, cwd, process.env as Record<string, string>, {
						onData,
						signal,
						timeout,
					});
				}

				// Try to wrap with bwrap
				const wrapResult = await wrapCommandWithSandbox({
					command,
					workspaceRoot: currentWorkspace,
					filesystemMode: currentConfig.filesystemMode,
					networkMode: currentConfig.networkMode,
				});

				if (!wrapResult.success) {
					const reason = singleLine(wrapResult.error);
					const allowUnsandboxed = await ensureUnsandboxedAllowedOnSandboxUnavailable(
						ctx,
						reason,
						approvalTimeout,
					);

					if (!allowUnsandboxed) {
						onData(
							Buffer.from(
								`[sandbox] Failed to start sandbox (${reason}). Refusing to run without sandbox.\n`,
							),
						);
						return { exitCode: 1 };
					}

					onData(
						Buffer.from(
							`[sandbox] Failed to start sandbox (${reason}). Running without sandbox for this session.\n`,
						),
					);
					return runCommandDirect(command, cwd, process.env as Record<string, string>, {
						onData,
						signal,
						timeout,
					});
				}

				const env = { ...process.env, HOME: wrapResult.home };
				const usingSandbox = true;

				// Run the command (sandboxed)
				const result = await runCommandCapture(
					wrapResult.file,
					wrapResult.args,
					cwd,
					env as Record<string, string>,
					{ onData, signal, timeout },
				);

				// Emit a best-effort diagnostic when a sandboxed command fails. This helps the model
				// distinguish between genuine command failures and sandbox restrictions.
				if (usingSandbox && result.exitCode !== 0) {
					const classification = classifySandboxFailure(result.output);

					const gatedByConfig =
						classification.kind !== "unknown" &&
						(classification.kind !== "network" ||
							currentConfig.networkMode !== "allow-all") &&
						(classification.kind !== "filesystem" ||
							currentConfig.filesystemMode !== "danger-full-access");

					if (gatedByConfig) {
						const type =
							classification.kind === "network"
								? `network/${classification.subtype}`
								: classification.kind === "filesystem"
									? `filesystem/${classification.subtype}`
									: "unknown";

						const evidence = singleLine(classification.evidence);

						const hint =
							classification.kind === "network"
								? "Network access is blocked by the sandbox. If this command needs network access, retry with escalate=true."
								: classification.kind === "filesystem" &&
									  classification.subtype === "read"
									? "This path may be inside an ephemeral /tmp mount (read-only preset) or outside the allowed workspace. If the file should be readable across calls, retry with escalate=true."
									: classification.kind === "filesystem"
										? "Filesystem write is blocked by the sandbox. If this command needs to write outside the workspace, retry with escalate=true."
										: "";

						onData(
							Buffer.from(
								`[sandbox] Command failed likely due to sandbox restrictions (${type}). (preset=${currentConfig.preset}). Evidence: "${evidence}". ${hint}\n`,
							),
						);

						const diagnostic = {
							usingSandbox: true,
							preset: currentConfig.preset,
							filesystemMode: currentConfig.filesystemMode,
							networkMode: currentConfig.networkMode,
							classification,
						};

						onData(
							Buffer.from(
								`SANDBOX_DIAGNOSTIC=${JSON.stringify(diagnostic)}\n[sandbox] If this failure is caused by sandbox restrictions, retry the same command with escalate=true.\n`,
							),
						);
					}
				}

				// Check if we should offer retry on failure (for "on-failure" policy)
				if (
					result.exitCode !== 0 &&
					usingSandbox &&
					currentConfig.approvalPolicy === "on-failure" &&
					looksLikePolicyViolation(result.output)
				) {
					try {
						const broker = getSandboxRuntimeState().approvalBroker;
						const retryApproval = await requestApprovalAfterFailure(
							ctx,
							command,
							result.output,
							{ timeoutSeconds: approvalTimeout },
							broker,
						);

						if (retryApproval.approved && retryApproval.runUnsandboxed) {
							ctx.ui?.notify?.("Retrying without sandbox...", "info");
							onData(
								Buffer.from(
									"\n[sandbox] User approved retry without sandbox restrictions. Re-running command...\n\n",
								),
							);
							const retryResult = await runCommandDirect(
								command,
								cwd,
								process.env as Record<string, string>,
								{ onData, signal, timeout },
							);
							return { exitCode: retryResult.exitCode };
						}
					} catch (error) {
						Effect.runSync(Effect.logWarning("Retry approval failed", error));
					}
				}

				return { exitCode: result.exitCode };
			},
		};
	}

	updateSandboxRuntimeState({
		createSandboxedBashOperations: createSandboxedBashOperationsInternal,
	});

	// Run command and capture output for policy violation detection
	type SpawnedCommandResult =
		| { readonly exitCode: number; readonly timedOut: false; readonly output?: string }
		| { readonly exitCode: null; readonly timedOut: true; readonly output?: string };

	function runSpawnedCommand(
		file: string,
		args: string[],
		cwd: string,
		env: Record<string, string>,
		options: { readonly captureOutput: boolean },
		opts: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal | undefined;
			timeout?: number | undefined;
		},
	): Promise<SpawnedCommandResult> {
		return new Promise((resolve, reject) => {
			if (!existsSync(cwd)) {
				reject(new Error(`Working directory does not exist: ${cwd}`));
				return;
			}

			let outputBuffer = "";
			const { onData, signal, timeout } = opts;

			const child = spawn(file, args, {
				cwd,
				env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;

			if (timeout !== undefined && timeout > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					if (child.pid) {
						killProcessTree(child.pid);
					}
				}, timeout * 1000);
			}

			if (child.stdout) {
				child.stdout.on("data", (data) => {
					if (options.captureOutput) {
						outputBuffer += data.toString();
					}
					onData(data);
				});
			}
			if (child.stderr) {
				child.stderr.on("data", (data) => {
					if (options.captureOutput) {
						outputBuffer += data.toString();
					}
					onData(data);
				});
			}

			child.on("error", (err) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				reject(err);
			});

			const onAbort = () => {
				if (child.pid) {
					killProcessTree(child.pid);
				}
			};

			if (signal) {
				signal.addEventListener("abort", onAbort);
			}

			child.on("close", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);

				if (timedOut) {
					resolve(
						options.captureOutput
							? { exitCode: null, timedOut: true, output: outputBuffer }
							: { exitCode: null, timedOut: true },
					);
					return;
				}

				const exitCode = code ?? 1;
				resolve(
					options.captureOutput
						? { exitCode, timedOut: false, output: outputBuffer }
						: { exitCode, timedOut: false },
				);
			});
		});
	}

	function runCommandCapture(
		file: string,
		args: string[],
		cwd: string,
		env: Record<string, string>,
		opts: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal | undefined;
			timeout?: number | undefined;
		},
	): Promise<{ exitCode: number; output: string }> {
		return runSpawnedCommand(file, args, cwd, env, { captureOutput: true }, opts).then(
			(result) => {
				if (result.timedOut) {
					opts.onData(
						Buffer.from(`[sandbox] Command timed out after ${opts.timeout ?? "?"}s\n`),
					);
					return { exitCode: 124, output: result.output ?? "" };
				}
				return { exitCode: result.exitCode, output: result.output ?? "" };
			},
		);
	}

	// Run command directly without output capture (for approved/retry runs)
	function runCommandDirect(
		cmd: string,
		cwd: string,
		env: Record<string, string>,
		opts: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal | undefined;
			timeout?: number | undefined;
		},
	): Promise<{ exitCode: number }> {
		return runSpawnedCommand("bash", ["-lc", cmd], cwd, env, { captureOutput: false }, opts).then(
			(result) => {
				if (result.timedOut) {
					opts.onData(
						Buffer.from(`[sandbox] Command timed out after ${opts.timeout ?? "?"}s\n`),
					);
					return { exitCode: 124 };
				}
				return { exitCode: result.exitCode };
			},
		);
	}

	type ExecCommandParams = {
		readonly cmd: string;
		readonly workdir?: string;
		readonly yield_time_ms?: number;
		readonly max_output_tokens?: number;
		readonly tty?: boolean;
		readonly login?: boolean;
		readonly shell?: string;
		readonly sandbox_permissions?: "require_escalated";
		readonly justification?: string;
		readonly prefix_rule?: readonly string[];
	};

	async function executeShellCommand(
		ctx: ExtensionContext,
		params: ExecCommandParams,
		abortSignal?: AbortSignal,
	): Promise<ShellRunResult> {
		const command = params.cmd;
		const currentConfig = effectiveConfig;
		const currentWorkspace = workspaceRoot;
		const approvalTimeout = currentConfig.approvalTimeoutSeconds;
		const broker = getSandboxRuntimeState().approvalBroker;
		const cwd = params.workdir
			? path.isAbsolute(params.workdir)
				? params.workdir
				: path.resolve(ctx.cwd, params.workdir)
			: ctx.cwd;
		const invocation = resolveShellInvocation({
			command,
			shell: params.shell,
			login: params.login,
		});
		const baseRequest = {
			cwd,
			tty: params.tty ?? false,
			ownerId: ctx.sessionManager.getSessionId(),
			yieldTimeMs: normalizeExecYieldTimeMs(params.yield_time_ms),
			maxOutputTokens: normalizeMaxOutputTokens(params.max_output_tokens),
			...(abortSignal !== undefined ? { abortSignal } : {}),
		};

		if (sandboxDisabled) {
			return Effect.runPromise(
				shellRuntime.exec({
					...baseRequest,
					file: invocation.file,
					args: invocation.args,
					env: envRecord(),
				}),
			);
		}

		if (currentConfig.subagent && /^(?:git|jj)\s/.test(command.trim())) {
			return {
				output:
					"[sandbox] VCS commands (git, jj) are blocked in subagent mode. The orchestrator handles all VCS operations.\n",
				exitCode: 1,
			};
		}

		const approval = await checkBashApproval(
			ctx,
			currentConfig.approvalPolicy,
			command,
			params.sandbox_permissions === "require_escalated",
			{
				timeoutSeconds: approvalTimeout,
				...(params.justification !== undefined
					? { justification: params.justification }
					: {}),
				...(params.prefix_rule !== undefined ? { prefixRule: params.prefix_rule } : {}),
			},
			broker,
		);

		if (!approval.approved) {
			return { output: `Sandbox: command blocked (${approval.reason})\n`, exitCode: 1 };
		}

		if (approval.runUnsandboxed) {
			ctx.ui?.notify?.("Running without sandbox...", "info");
			const result = await Effect.runPromise(
				shellRuntime.exec({
					...baseRequest,
					file: invocation.file,
					args: invocation.args,
					env: envRecord(),
				}),
			);
			return {
				...result,
				output:
					`[sandbox] Running without sandbox restrictions (escalation approved).\n${result.output}`,
			};
		}

		const prereqs = detectMissingSandboxDeps({ platform: os.platform() });
		const asrtAvailable = await isAsrtAvailable();
		if (!asrtAvailable || prereqs.missingRequired.length > 0) {
			const parts: string[] = [];
			if (!asrtAvailable) {
				parts.push(getAsrtLoadError() ?? "ASRT module failed to load");
			}
			const depsMsg = formatMissingDepsMessage(prereqs);
			if (depsMsg) parts.push(depsMsg);
			const reason = parts.join("; ");
			const allowUnsandboxed = await ensureUnsandboxedAllowedOnSandboxUnavailable(
				ctx,
				reason,
				approvalTimeout,
			);
			if (!allowUnsandboxed) {
				return {
					output: `[sandbox] Sandboxed shell unavailable (${reason}). Refusing to run without sandbox.\n`,
					exitCode: 1,
				};
			}
			const result = await Effect.runPromise(
				shellRuntime.exec({
					...baseRequest,
					file: invocation.file,
					args: invocation.args,
					env: envRecord(),
				}),
			);
			return {
				...result,
				output:
					`[sandbox] Sandboxed shell unavailable (${reason}). Running without sandbox for this session.\n${result.output}`,
			};
		}

		const wrapResult = await wrapCommandWithSandbox({
			command,
			invocation,
			workspaceRoot: currentWorkspace,
			filesystemMode: currentConfig.filesystemMode,
			networkMode: currentConfig.networkMode,
		});

		if (!wrapResult.success) {
			const reason = singleLine(wrapResult.error);
			const allowUnsandboxed = await ensureUnsandboxedAllowedOnSandboxUnavailable(
				ctx,
				reason,
				approvalTimeout,
			);
			if (!allowUnsandboxed) {
				return {
					output: `[sandbox] Failed to start sandbox (${reason}). Refusing to run without sandbox.\n`,
					exitCode: 1,
				};
			}
			const result = await Effect.runPromise(
				shellRuntime.exec({
					...baseRequest,
					file: invocation.file,
					args: invocation.args,
					env: envRecord(),
				}),
			);
			return {
				...result,
				output:
					`[sandbox] Failed to start sandbox (${reason}). Running without sandbox for this session.\n${result.output}`,
			};
		}

		const result = await Effect.runPromise(
			shellRuntime.exec({
				...baseRequest,
				file: wrapResult.file,
				args: wrapResult.args,
				env: envRecord({ HOME: wrapResult.home }),
			}),
		);
		const decorated = appendSandboxDiagnostic(result, currentConfig);

		if (
			decorated.exitCode !== undefined &&
			decorated.exitCode !== 0 &&
			currentConfig.approvalPolicy === "on-failure" &&
			looksLikePolicyViolation(decorated.output)
		) {
			const retryApproval = await requestApprovalAfterFailure(
				ctx,
				command,
				decorated.output,
				{ timeoutSeconds: approvalTimeout },
				broker,
			);
			if (retryApproval.approved && retryApproval.runUnsandboxed) {
				ctx.ui?.notify?.("Retrying without sandbox...", "info");
				const retryResult = await Effect.runPromise(
					shellRuntime.exec({
						...baseRequest,
						file: invocation.file,
						args: invocation.args,
						env: envRecord(),
					}),
				);
				return {
					...retryResult,
					output:
						"\n[sandbox] User approved retry without sandbox restrictions. Re-running command...\n\n" +
						retryResult.output,
				};
			}
		}

		return decorated;
	}

	pi.registerTool({
		name: "exec_command",
		label: "exec_command",
		description: EXEC_COMMAND_TOOL_DESCRIPTION,
		promptSnippet:
			"Run shell commands, returning output or a session ID for ongoing interaction.",
		promptGuidelines: [
			"Use exec_command for file operations like ls, rg, find, builds, tests, and development commands.",
			"Use tty=true for interactive commands or commands that need terminal behavior, then use write_stdin to send input.",
			"Use write_stdin with empty chars to poll or wait for an active session.",
		],
		parameters: Type.Object({
			cmd: Type.String({ description: "Shell command to execute." }),
			workdir: Type.Optional(
				Type.String({
					description:
						"Optional working directory to run the command in; defaults to the turn cwd.",
				}),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: "How long to wait (in milliseconds) for output before yielding.",
				}),
			),
			max_output_tokens: Type.Optional(
				Type.Number({
					description: "Maximum number of tokens to return. Excess output will be truncated.",
				}),
			),
			tty: Type.Optional(
				Type.Boolean({
					description: EXEC_COMMAND_TTY_PARAMETER_DESCRIPTION,
				}),
			),
			login: Type.Optional(
				Type.Boolean({
					description: "Whether to run the shell with -l/-i semantics. Defaults to true.",
				}),
			),
			shell: Type.Optional(
				Type.String({
					description: "Shell binary to launch. Defaults to the user's default shell.",
				}),
			),
			sandbox_permissions: Type.Optional(Type.Literal("require_escalated")),
			justification: Type.Optional(
				Type.String({ description: "Reason shown to the user when requesting escalation" }),
			),
			prefix_rule: Type.Optional(
				Type.Array(Type.String({ description: "Suggested command prefix rule" })),
			),
		}),
		renderCall(args, theme, context) {
			return renderShellCall(args, theme, context);
		},
		renderResult(result, options, theme) {
			return renderShellResult(result, options, theme);
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			refreshConfig(ctx);
			const typedParams = params as ExecCommandParams;
			try {
				const result = await executeShellCommand(ctx, typedParams, signal);
				return shellToolResult(result, { kind: "exec_command", command: typedParams.cmd });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return shellToolError(message);
			}
		},
	});

	pi.registerTool({
		name: "write_stdin",
		label: "write_stdin",
		description: WRITE_STDIN_TOOL_DESCRIPTION,
		promptSnippet: "Send input to or poll an active shell session.",
		parameters: Type.Object({
			session_id: Type.Number({
				description: "Identifier of the running unified exec session.",
			}),
			chars: Type.Optional(
				Type.String({ description: WRITE_STDIN_CHARS_PARAMETER_DESCRIPTION }),
			),
			yield_time_ms: Type.Optional(
				Type.Number({
					description: "How long to wait (in milliseconds) for output before yielding.",
				}),
			),
			max_output_tokens: Type.Optional(
				Type.Number({
					description: "Maximum number of tokens to return. Excess output will be truncated.",
				}),
			),
		}),
		renderCall(args, theme, context) {
			return renderShellCall(args, theme, context);
		},
		renderResult(result, options, theme) {
			return renderShellResult(result, options, theme);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			refreshConfig(ctx);
			const typedParams = params as {
				session_id: number;
				chars?: string;
				yield_time_ms?: number;
				max_output_tokens?: number;
			};
			try {
				const result = await Effect.runPromise(
					shellRuntime.write({
						sessionId: typedParams.session_id,
						ownerId: ctx.sessionManager.getSessionId(),
						chars: typedParams.chars ?? "",
						yieldTimeMs: normalizeWriteStdinYieldTimeMs(typedParams.yield_time_ms),
						maxOutputTokens: normalizeMaxOutputTokens(typedParams.max_output_tokens),
					}),
				);
				return shellToolResult(result, {
					kind: "write_stdin",
					writtenChars: typedParams.chars?.length ?? 0,
					writtenText: typedParams.chars ?? "",
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return shellToolError(message);
			}
		},
	});

	pi.registerTool({
		...baseEditTool,
		label: "edit",
		promptSnippet: "Make surgical edits to files (find exact text and replace)",
		promptGuidelines: ["Use edit for precise changes (old text must match exactly)"],
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			refreshConfig(ctx);
			const targetPath = (params as { path?: string }).path;
			if (targetPath) {
				const check = checkWriteAllowed({
					targetPath,
					cwd: ctx.cwd,
					workspaceRoot,
					filesystemMode: effectiveConfig.filesystemMode,
				});
				if (!check.allowed) {
					const broker = getSandboxRuntimeState().approvalBroker;
					const approval = await checkFilesystemApproval(
						ctx,
						effectiveConfig.approvalPolicy,
						targetPath,
						"edit",
						{ timeoutSeconds: effectiveConfig.approvalTimeoutSeconds },
						broker,
					);

					if (!approval.approved) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${check.reason} (${approval.reason})`,
								},
							],
							details: undefined,
						};
					}

					ctx.ui.notify(`Approved: edit ${targetPath}`, "info");
				}
			}
			const tool = createEditTool(ctx.cwd);
			return tool.execute(toolCallId, params, signal);
		},
	});

	pi.registerTool({
		...baseWriteTool,
		label: "write",
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites"],
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			refreshConfig(ctx);
			const targetPath = (params as { path?: string }).path;
			if (targetPath) {
				const check = checkWriteAllowed({
					targetPath,
					cwd: ctx.cwd,
					workspaceRoot,
					filesystemMode: effectiveConfig.filesystemMode,
				});
				if (!check.allowed) {
					const broker = getSandboxRuntimeState().approvalBroker;
					const approval = await checkFilesystemApproval(
						ctx,
						effectiveConfig.approvalPolicy,
						targetPath,
						"write",
						{ timeoutSeconds: effectiveConfig.approvalTimeoutSeconds },
						broker,
					);

					if (!approval.approved) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Error: ${check.reason} (${approval.reason})`,
								},
							],
							details: undefined,
						};
					}

					ctx.ui.notify(`Approved: write ${targetPath}`, "info");
				}
			}
			const tool = createWriteTool(ctx.cwd);
			return tool.execute(toolCallId, params, signal);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		installShellToolActivationTransform();
		// Check for --no-sandbox escape hatch first
		const noSandbox = pi.getFlag("no-sandbox") as boolean | undefined;
		if (noSandbox) {
			sandboxDisabled = true;
			ctx.ui.notify("Sandbox DISABLED via --no-sandbox flag", "warning");
			refreshConfig(ctx);
			return;
		}

		// Apply CLI flag
		const sandboxMode = pi.getFlag("sandbox-mode") as string | undefined;

		if (sandboxMode) {
			const modeMap: Record<string, SandboxPreset> = {
				"read-only": "read-only",
				readonly: "read-only",
				"workspace-write": "workspace-write",
				agent: "workspace-write",
				"full-access": "full-access",
				full: "full-access",
			};
			const mapped = modeMap[sandboxMode.toLowerCase()];
			if (mapped) {
				cliOverride = { preset: mapped };
				ctx.ui.notify(`Sandbox mode: ${PRESET_LABELS[mapped]}`, "info");
			} else {
				ctx.ui.notify(
					`Invalid --sandbox-mode value: ${sandboxMode}. Use: read-only, workspace-write, full-access`,
					"warning",
				);
			}
		}

		refreshConfig(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshConfig(ctx);
		installShellToolActivationTransform();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await Effect.runPromise(shellRuntime.shutdownOwner(ctx.sessionManager.getSessionId()));
	});

	// First turn only: inject initial sandbox state into the system prompt.
	// Subsequent sandbox changes are injected into the user message as content[0]
	// (see context handler below) to preserve provider prompt caching.
	pi.on("before_agent_start", async (event, ctx) => {
		refreshConfig(ctx);

		if (sessionState.systemPromptInjected) return;

		sessionState.systemPromptInjected = true;
		// Don't set lastCommunicatedHash here - let the context hook do it
		// so that SANDBOX_STATE gets injected into the first user message.
		sessionState.pendingSandboxNotice = undefined;
		persistState();

		const injected =
			"<sandbox>\n" +
			"Tool calls run in a bubblewrap sandbox; don't try to bypass it. The active preset, network policy, and approval mode are in SANDBOX_STATE at the start of the user message (SANDBOX_CHANGE when it changes mid-session).\n" +
			"\n" +
			"If a command fails because of the sandbox (e.g. \"Operation not permitted\" or \"Permission denied\" outside the workspace, or the network is unreachable), immediately retry the same command with sandbox_permissions: \"require_escalated\" and a short justification — don't ask first. For failures unrelated to the sandbox (bad arguments, a real test failure, a missing workspace file), fix the cause instead; don't escalate.\n" +
			"\n" +
			"VCS (jj/git) is the orchestrator's job; as a subagent you cannot run VCS commands.\n" +
			"</sandbox>";

		return {
			systemPrompt: `${event.systemPrompt}\n\n${injected}`,
		};
	});

	// Inject sandbox state/change notice into the last user message as content[0].
	// Also filter out UI-only sandbox change messages so they never reach the model.
	pi.on("context", async (event, ctx) => {
		refreshConfig(ctx);

		const filtered = event.messages.filter(
			(m) => !(m?.role === "custom" && m?.customType === SANDBOX_CHANGE_MESSAGE_TYPE),
		);

		const currentHash = computeSandboxConfigHash(effectiveConfig);
		const previousHash = sessionState.lastCommunicatedHash;
		const shouldInjectInitialState = !previousHash;
		const hasChangedSinceLastCommunication = Boolean(
			previousHash && previousHash !== currentHash,
		);
		const hasUserMessage = filtered.some((m) => m?.role === "user");

		let nextMessages = filtered;

		if (hasUserMessage && shouldInjectInitialState) {
			nextMessages = injectSandboxNoticeIntoMessages(
				filtered,
				buildSandboxStateNoticeText(effectiveConfig),
			);
		} else if (hasUserMessage && hasChangedSinceLastCommunication) {
			nextMessages = injectSandboxNoticeIntoMessages(
				filtered,
				buildSandboxChangeNoticeText(effectiveConfig),
			);
		}

		if (
			hasUserMessage &&
			(shouldInjectInitialState ||
				hasChangedSinceLastCommunication ||
				sessionState.pendingSandboxNotice)
		) {
			sessionState.lastCommunicatedHash = currentHash;
			sessionState.pendingSandboxNotice = undefined;
			persistState();
		}

		return { messages: nextMessages };
	});

	pi.registerCommand("approval", {
		description: "Configure sandbox preset",
		handler: async (_args, ctx) => {
			refreshConfig(ctx);
			await showSandboxSettings(ctx);
		},
	});
}
