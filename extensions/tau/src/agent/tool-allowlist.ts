import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { Effect } from "effect";
import { AgentError } from "./services.js";
import type { AgentDefinition } from "./types.js";
import type { ExecutionPolicy } from "../execution/schema.js";
import {
	getLegacyMutationToolSelection,
	rewriteMutationToolNames,
	shouldUseApplyPatchForProvider,
} from "../sandbox/mutation-tools.js";

export function parseConfiguredToolNames(
	value: unknown,
	keyPath: string,
): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(`${keyPath} must be an array`);
	}

	const seen = new Set<string>();
	const toolNames: string[] = [];
	for (const [index, entry] of value.entries()) {
		const entryPath = `${keyPath}[${index}]`;
		if (typeof entry !== "string") {
			throw new Error(`${entryPath} must be a string`);
		}
		if (entry.trim().length === 0) {
			throw new Error(`${entryPath} must not be empty`);
		}
		if (entry.trim() !== entry) {
			throw new Error(`${entryPath} must not contain leading or trailing whitespace`);
		}
		if (seen.has(entry)) {
			throw new Error(`${entryPath} duplicates "${entry}"`);
		}
		seen.add(entry);
		toolNames.push(entry);
	}

	return toolNames;
}

function sameToolNames(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (const [index, value] of left.entries()) {
		if (right[index] !== value) return false;
	}
	return true;
}

function appendMissingTools(
	base: readonly string[],
	required: readonly string[],
): readonly string[] {
	const seen = new Set<string>(base);
	const merged = [...base];
	for (const tool of required) {
		if (!seen.has(tool)) {
			seen.add(tool);
			merged.push(tool);
		}
	}
	return merged;
}

function resolveConfiguredTools(options: {
	readonly definitionTools: readonly string[] | undefined;
	readonly sessionTools: readonly string[];
	readonly executionPolicy: ExecutionPolicy | undefined;
}): readonly string[] | undefined {
	const policy = options.executionPolicy?.tools;
	if (policy?.kind === "allowlist") {
		return policy.tools;
	}

	if (policy?.kind === "require") {
		if (options.definitionTools !== undefined) {
			return appendMissingTools(options.definitionTools, policy.tools);
		}
		return appendMissingTools(options.sessionTools, policy.tools);
	}

	return options.definitionTools;
}

function getActiveToolNames(options: {
	agentName: string;
	configuredTools: readonly string[] | undefined;
	availableToolNames: readonly string[];
}): readonly string[] | undefined {
	if (options.configuredTools === undefined) {
		return undefined;
	}

	const available = new Set(options.availableToolNames);
	const unknownToolNames = options.configuredTools.filter((name) => !available.has(name));
	if (unknownToolNames.length > 0) {
		const availableList = [...available].sort().join(", ");
		throw new AgentError({
			message:
				`Invalid tools for agent "${options.agentName}": ${unknownToolNames.join(", ")}. ` +
				`Available tools: ${availableList}`,
		});
	}

	return options.configuredTools;
}

export function applyAgentToolAllowlist(
	session: AgentSession,
	definition: AgentDefinition,
	executionPolicy?: ExecutionPolicy,
): Effect.Effect<void, AgentError> {
	return Effect.try({
		try: () => {
			const availableToolNames = session.getAllTools().map((tool) => tool.name);
			const sessionToolNames = session.getActiveToolNames();
			const configuredTools = resolveConfiguredTools({
				definitionTools: definition.tools,
				sessionTools: sessionToolNames,
				executionPolicy,
			});
			const configuredActiveToolNames = getActiveToolNames({
				agentName: definition.name,
				configuredTools,
				availableToolNames,
			});
			const baseToolNames = configuredActiveToolNames ?? sessionToolNames;
			const routedToolNames = rewriteMutationToolNames(baseToolNames, {
				useApplyPatch: shouldUseApplyPatchForProvider(session.model?.provider),
				legacySelection: getLegacyMutationToolSelection(baseToolNames),
			});

			if (
				configuredActiveToolNames !== undefined ||
				!sameToolNames(routedToolNames, baseToolNames)
			) {
				session.setActiveToolsByName(routedToolNames);
			}
		},
		catch: (cause) =>
			cause instanceof AgentError
				? cause
				: new AgentError({
						message: cause instanceof Error ? cause.message : String(cause),
					}),
	});
}
