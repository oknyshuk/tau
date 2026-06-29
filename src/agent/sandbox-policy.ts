import type {
	SandboxConfig,
	ResolvedSandboxConfig,
	SandboxPreset,
} from "../sandbox/config.js";
import { resolvePreset } from "../shared/policy.js";

const PRESET_RANK: Record<SandboxPreset, number> = {
	"read-only": 0,
	"workspace-write": 1,
	"full-access": 2,
};

/**
 * Compute a worker sandbox config that:
 * - inherits missing fields from the parent
 * - clamps requested preset so the worker is never more permissive than the parent
 */
export function computeClampedWorkerSandboxConfig(options: {
	parent: ResolvedSandboxConfig;
	requested?: SandboxConfig;
}): ResolvedSandboxConfig {
	const requestedPreset = options.requested?.preset ?? options.parent.preset;

	// Clamp: worker gets min of parent and requested
	const clampedPreset =
		PRESET_RANK[requestedPreset] <= PRESET_RANK[options.parent.preset]
			? requestedPreset
			: options.parent.preset;

	const resolved = resolvePreset(clampedPreset);

	// Subagent mode: if parent is subagent, worker must be subagent.
	// Otherwise worker defaults to subagent mode unless explicitly disabled.
	const subagent = options.parent.subagent || (options.requested?.subagent ?? true);

	return {
		preset: clampedPreset,
		filesystemMode: resolved.filesystemMode,
		networkMode: resolved.networkMode,
		approvalPolicy: resolved.approvalPolicy,
		approvalTimeoutSeconds:
			options.requested?.approvalTimeoutSeconds ?? options.parent.approvalTimeoutSeconds,
		subagent,
	};
}
