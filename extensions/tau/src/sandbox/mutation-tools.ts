const EDIT_TOOL_NAME = "edit";
const WRITE_TOOL_NAME = "write";
export const APPLY_PATCH_TOOL_NAME = "apply_patch";
const BASH_TOOL_NAME = "bash";
const EXEC_COMMAND_TOOL_NAME = "exec_command";
const WRITE_STDIN_TOOL_NAME = "write_stdin";

export type LegacyMutationToolName = typeof EDIT_TOOL_NAME | typeof WRITE_TOOL_NAME;
type MutationToolName = LegacyMutationToolName | typeof APPLY_PATCH_TOOL_NAME;

const OPENAI_APPLY_PATCH_PROVIDERS = new Set(["openai", "openai-codex"]);

export function shouldUseApplyPatchForProvider(
	provider: string | null | undefined,
): boolean {
	if (!provider) return false;
	return OPENAI_APPLY_PATCH_PROVIDERS.has(provider);
}

function isMutationToolName(name: string): name is MutationToolName {
	return name === EDIT_TOOL_NAME || name === WRITE_TOOL_NAME || name === APPLY_PATCH_TOOL_NAME;
}

export function getLegacyMutationToolSelection(
	toolNames: readonly string[],
): LegacyMutationToolName[] {
	const selected: LegacyMutationToolName[] = [];
	for (const toolName of toolNames) {
		if (toolName === EDIT_TOOL_NAME || toolName === WRITE_TOOL_NAME) {
			selected.push(toolName);
		}
	}
	return selected;
}

export function rewriteMutationToolNames(
	toolNames: readonly string[],
	options: {
		readonly useApplyPatch: boolean;
		readonly legacySelection?: readonly LegacyMutationToolName[] | undefined;
	},
): string[] {
	if (!toolNames.some((toolName) => isMutationToolName(toolName))) {
		return [...toolNames];
	}

	const replacement = options.useApplyPatch
		? [APPLY_PATCH_TOOL_NAME]
		: [...(options.legacySelection ?? [EDIT_TOOL_NAME, WRITE_TOOL_NAME])];

	const nextToolNames: string[] = [];
	let insertedReplacement = false;

	for (const toolName of toolNames) {
		if (isMutationToolName(toolName)) {
			if (!insertedReplacement) {
				nextToolNames.push(...replacement);
				insertedReplacement = true;
			}
			continue;
		}
		nextToolNames.push(toolName);
	}

	return nextToolNames;
}

export function rewriteShellToolNames(toolNames: readonly string[]): string[] {
	const nextToolNames: string[] = [];
	let shellToolsInserted = false;

	const pushUnique = (toolName: string): void => {
		if (!nextToolNames.includes(toolName)) {
			nextToolNames.push(toolName);
		}
	};

	for (const toolName of toolNames) {
		if (toolName === BASH_TOOL_NAME) {
			if (!shellToolsInserted) {
				pushUnique(EXEC_COMMAND_TOOL_NAME);
				pushUnique(WRITE_STDIN_TOOL_NAME);
				shellToolsInserted = true;
			}
			continue;
		}
		pushUnique(toolName);
		if (toolName === EXEC_COMMAND_TOOL_NAME && !shellToolsInserted) {
			pushUnique(WRITE_STDIN_TOOL_NAME);
			shellToolsInserted = true;
		}
	}

	return nextToolNames;
}
