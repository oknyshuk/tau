export type FilesystemMode = "read-only" | "workspace-write" | "danger-full-access";
export type NetworkMode = "deny" | "allow-all";
export type ApprovalPolicy = "never" | "on-failure" | "on-request" | "unless-trusted";

export type SandboxPreset = "read-only" | "workspace-write" | "full-access";

const SANDBOX_PRESETS: Record<
	SandboxPreset,
	{ filesystemMode: FilesystemMode; networkMode: NetworkMode; approvalPolicy: ApprovalPolicy }
> = {
	"read-only": { filesystemMode: "read-only", networkMode: "deny", approvalPolicy: "on-request" },
	"workspace-write": {
		filesystemMode: "workspace-write",
		networkMode: "deny",
		approvalPolicy: "on-request",
	},
	"full-access": {
		filesystemMode: "danger-full-access",
		networkMode: "allow-all",
		approvalPolicy: "never",
	},
};

export const SANDBOX_PRESET_NAMES: readonly SandboxPreset[] = [
	"read-only",
	"workspace-write",
	"full-access",
] as const;

const FILESYSTEM_MODES: readonly FilesystemMode[] = [
	"read-only",
	"workspace-write",
	"danger-full-access",
] as const;
const NETWORK_MODES: readonly NetworkMode[] = ["deny", "allow-all"] as const;
const APPROVAL_POLICIES: readonly ApprovalPolicy[] = [
	"never",
	"on-failure",
	"on-request",
	"unless-trusted",
] as const;

/**
 * Resolve a SandboxPreset to its constituent individual modes.
 */
export function resolvePreset(preset: SandboxPreset): {
	filesystemMode: FilesystemMode;
	networkMode: NetworkMode;
	approvalPolicy: ApprovalPolicy;
} {
	return SANDBOX_PRESETS[preset];
}

/**
 * Map legacy individual modes to the nearest preset.
 * Used for migrating old-style config files.
 */
export function inferPresetFromModes(opts: {
	filesystemMode?: FilesystemMode | undefined;
	networkMode?: NetworkMode | undefined;
	approvalPolicy?: ApprovalPolicy | undefined;
}): SandboxPreset {
	const fs = opts.filesystemMode ?? "workspace-write";
	if (fs === "danger-full-access") return "full-access";
	if (fs === "read-only") return "read-only";
	return "workspace-write";
}
