import { Schema } from "effect";

/**
 * Versioned capability contract for Ralph loops.
 *
 * This contract is the source of truth for what tools and agents a Ralph loop
 * is allowed to use. It is captured at loop start and reapplied to every
 * owned session so ambient Pi state changes cannot leak into Ralph execution.
 *
 * - No skills are stored here (skills are excluded from Ralph contracts).
 * - ralph_continue and ralph_finish are system-managed; they are NOT in
 *   tools.activeNames, but the applier always injects them for child sessions.
 * - Fingerprints are informational unless a task explicitly requires hard
 *   enforcement.
 */

const CAPABILITY_CONTRACT_VERSION = "1" as const;

const ToolMetadataFingerprintSchema = Schema.Struct({
	name: Schema.NonEmptyString,
	label: Schema.String,
	description: Schema.String,
});
export type ToolMetadataFingerprint = Schema.Schema.Type<
	typeof ToolMetadataFingerprintSchema
>;

const AgentMetadataFingerprintSchema = Schema.Struct({
	name: Schema.NonEmptyString,
	description: Schema.String,
});
export type AgentMetadataFingerprint = Schema.Schema.Type<
	typeof AgentMetadataFingerprintSchema
>;

const RalphToolContractSchema = Schema.Struct({
	/** User-configurable active tool names (ralph_continue / ralph_finish excluded). */
	activeNames: Schema.Array(Schema.NonEmptyString),
	/** Snapshot of available tools at capture time for informational display. */
	availableSnapshot: Schema.Array(ToolMetadataFingerprintSchema),
});
type RalphToolContract = Schema.Schema.Type<typeof RalphToolContractSchema>;

const RalphAgentContractSchema = Schema.Struct({
	/** Enabled agent names for this loop. */
	enabledNames: Schema.Array(Schema.NonEmptyString),
	/** Snapshot of agent registry at capture time for informational display. */
	registrySnapshot: Schema.Array(AgentMetadataFingerprintSchema),
});
type RalphAgentContract = Schema.Schema.Type<typeof RalphAgentContractSchema>;

export const RalphCapabilityContractSchema = Schema.Struct({
	version: Schema.Literal(CAPABILITY_CONTRACT_VERSION),
	tools: RalphToolContractSchema,
	agents: RalphAgentContractSchema,
});
export type RalphCapabilityContract = Schema.Schema.Type<
	typeof RalphCapabilityContractSchema
>;

export function makeEmptyCapabilityContract(): RalphCapabilityContract {
	return {
		version: CAPABILITY_CONTRACT_VERSION,
		tools: {
			activeNames: [],
			availableSnapshot: [],
		},
		agents: {
			enabledNames: [],
			registrySnapshot: [],
		},
	};
}

export function makeCapabilityContract(input: {
	readonly toolsActiveNames: ReadonlyArray<string>;
	readonly toolsAvailableSnapshot: ReadonlyArray<ToolMetadataFingerprint>;
	readonly agentsEnabledNames: ReadonlyArray<string>;
	readonly agentsRegistrySnapshot: ReadonlyArray<AgentMetadataFingerprint>;
}): RalphCapabilityContract {
	return {
		version: CAPABILITY_CONTRACT_VERSION,
		tools: {
			activeNames: [...input.toolsActiveNames],
			availableSnapshot: [...input.toolsAvailableSnapshot],
		},
		agents: {
			enabledNames: [...input.agentsEnabledNames],
			registrySnapshot: [...input.agentsRegistrySnapshot],
		},
	};
}

const RALPH_SYSTEM_CONTROL_TOOLS = new Set(["ralph_continue", "ralph_finish"]);

/**
 * Returns true if the tool name is a system-managed Ralph control tool
 * that should never appear in the user-configurable activeNames list.
 */
export function isRalphSystemControlTool(name: string): boolean {
	return RALPH_SYSTEM_CONTROL_TOOLS.has(name);
}

/**
 * Filter out system-managed Ralph control tools from a list of tool names.
 */
export function excludeRalphSystemControlTools(
	names: ReadonlyArray<string>,
): ReadonlyArray<string> {
	return names.filter((name) => !isRalphSystemControlTool(name));
}

/**
 * Ensure system-managed Ralph control tools are present in a tool names list.
 */
export function ensureRalphSystemControlTools(
	names: ReadonlyArray<string>,
): ReadonlyArray<string> {
	const result = new Set(names);
	for (const tool of RALPH_SYSTEM_CONTROL_TOOLS) {
		result.add(tool);
	}
	return [...result];
}
