import { Exit, Schema } from "effect";
import * as path from "node:path";
import { SandboxConfig as SandboxConfigSchema } from "../schemas/config.js";
import { readJsonObjectFileOrThrow, writeJsonFile } from "../shared/fs.js";
import { getUserSettingsPath } from "../shared/discovery.js";
import { deepMerge, isRecord, type AnyRecord } from "../shared/json.js";
import {
	type ApprovalPolicy,
	type FilesystemMode,
	type NetworkMode,
	type SandboxPreset,
	resolvePreset,
	inferPresetFromModes,
} from "../shared/policy.js";

export type { ApprovalPolicy, FilesystemMode, NetworkMode, SandboxPreset };

export type SandboxConfig = {
	preset?: SandboxPreset;
	/** If true, agent is running in subagent mode (blocks VCS commands like git/jj, restricted operations) */
	subagent?: boolean;
	approvalTimeoutSeconds?: number;
};

/** Fully resolved internal config - all fields expanded from preset */
export type ResolvedSandboxConfig = {
	preset: SandboxPreset;
	filesystemMode: FilesystemMode;
	networkMode: NetworkMode;
	approvalPolicy: ApprovalPolicy;
	approvalTimeoutSeconds: number;
	subagent: boolean;
};

export const DEFAULT_SANDBOX_CONFIG: ResolvedSandboxConfig = {
	preset: "workspace-write",
	filesystemMode: "workspace-write",
	networkMode: "deny",
	approvalPolicy: "on-request",
	approvalTimeoutSeconds: 60,
	subagent: false,
};

const decodeSandboxConfig = Schema.decodeUnknownExit(SandboxConfigSchema);

function decodeSandboxConfigOrThrow(
	value: unknown,
	source: string,
): SandboxConfig {
	const decoded = decodeSandboxConfig(value);
	if (Exit.isFailure(decoded)) {
		throw new Error(`Invalid sandbox config at ${source}: ${String(decoded.cause)}`);
	}

	const normalized: SandboxConfig = {};

	// If preset is set, use it directly
	if (decoded.value.preset !== undefined) {
		normalized.preset = decoded.value.preset;
	}
	// If legacy fields are present but no preset, migrate to nearest preset
	else if (
		decoded.value.filesystemMode !== undefined ||
		decoded.value.networkMode !== undefined ||
		decoded.value.approvalPolicy !== undefined
	) {
		normalized.preset = inferPresetFromModes({
			filesystemMode: decoded.value.filesystemMode,
			networkMode: decoded.value.networkMode,
			approvalPolicy: decoded.value.approvalPolicy,
		});
	}

	if (decoded.value.subagent !== undefined) normalized.subagent = decoded.value.subagent;
	if (decoded.value.approvalTimeoutSeconds !== undefined) {
		normalized.approvalTimeoutSeconds = decoded.value.approvalTimeoutSeconds;
	}
	return normalized;
}

function applyDefaults(cfg: SandboxConfig | undefined): ResolvedSandboxConfig {
	const preset = cfg?.preset ?? DEFAULT_SANDBOX_CONFIG.preset;
	const resolved = resolvePreset(preset);
	return {
		preset,
		filesystemMode: resolved.filesystemMode,
		networkMode: resolved.networkMode,
		approvalPolicy: resolved.approvalPolicy,
		approvalTimeoutSeconds: cfg?.approvalTimeoutSeconds ?? DEFAULT_SANDBOX_CONFIG.approvalTimeoutSeconds,
		subagent: cfg?.subagent ?? DEFAULT_SANDBOX_CONFIG.subagent,
	};
}

function readSandboxNamespace(settings: AnyRecord, settingsPath: string): SandboxConfig {
	// New namespace: settings.tau.sandbox
	const tau = settings["tau"];
	const tauSandbox = isRecord(tau) ? tau["sandbox"] : undefined;
	if (tauSandbox !== undefined) {
		return decodeSandboxConfigOrThrow(tauSandbox, `${settingsPath}: tau.sandbox`);
	}

	// Back-compat: settings.sandbox
	const legacy = settings["sandbox"];
	if (legacy !== undefined) {
		return decodeSandboxConfigOrThrow(legacy, `${settingsPath}: sandbox`);
	}
	return {};
}

function readSettingsFileOrThrow(settingsPath: string): AnyRecord {
	try {
		return readJsonObjectFileOrThrow(settingsPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("Missing JSON file")) {
			return {};
		}
		throw new Error(message.replace(/^Invalid JSON at /, "Invalid settings JSON at "));
	}
}

function getProjectSettingsPath(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".pi", "settings.json");
}

/**
 * Ensure sandbox defaults exist in user settings file.
 * Does not override existing values; only fills missing keys.
 */
export function ensureUserDefaults(): void {
	const settingsPath = getUserSettingsPath();
	const current = readSettingsFileOrThrow(settingsPath);
	const existing = readSandboxNamespace(current, settingsPath);
	const withDefaults = applyDefaults(existing);

	const currentTau = isRecord(current["tau"]) ? current["tau"] : undefined;
	const needsWrite =
		currentTau?.["sandbox"] === undefined || existing.preset === undefined;

	if (!needsWrite) return;
	// Write only the preset-based fields
	const merged = deepMerge(current, {
		tau: {
			...currentTau,
			sandbox: { preset: withDefaults.preset, subagent: withDefaults.subagent },
		},
	});
	writeJsonFile(settingsPath, merged);
}

export function computeEffectiveConfig(opts: {
	workspaceRoot: string;
	sessionOverride?: SandboxConfig;
}): ResolvedSandboxConfig {
	const userSettingsPath = getUserSettingsPath();
	const projectSettingsPath = getProjectSettingsPath(opts.workspaceRoot);
	const userSettings = readSettingsFileOrThrow(userSettingsPath);
	const projectSettings = readSettingsFileOrThrow(projectSettingsPath);

	const userSandbox = readSandboxNamespace(userSettings, userSettingsPath);
	const projectSandbox = readSandboxNamespace(projectSettings, projectSettingsPath);

	// precedence: session > project > user
	const merged: SandboxConfig = {};
	const mergedPreset =
		opts.sessionOverride?.preset ?? projectSandbox.preset ?? userSandbox.preset;
	const mergedSubagent =
		opts.sessionOverride?.subagent ?? projectSandbox.subagent ?? userSandbox.subagent;
	const mergedApprovalTimeout =
		opts.sessionOverride?.approvalTimeoutSeconds ??
		projectSandbox.approvalTimeoutSeconds ??
		userSandbox.approvalTimeoutSeconds;
	if (mergedPreset !== undefined) merged.preset = mergedPreset;
	if (mergedSubagent !== undefined) merged.subagent = mergedSubagent;
	if (mergedApprovalTimeout !== undefined) merged.approvalTimeoutSeconds = mergedApprovalTimeout;

	return applyDefaults(merged);
}
