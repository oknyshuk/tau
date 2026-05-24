const BASH_TOOL_NAME = "bash";
const EXEC_COMMAND_TOOL_NAME = "exec_command";
const WRITE_STDIN_TOOL_NAME = "write_stdin";

/**
 * Rewrite tool activation lists to substitute pi's built-in `bash` tool with
 * tau's split `exec_command` + `write_stdin` shell tools. This keeps the
 * "two-tool shell" model that tau's bash sandbox layer expects, regardless of
 * what the caller asked for.
 */
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
