import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentDefinition } from "../types.js";
import { createBacklogToolDefinition } from "../../backlog/tool.js";
import { createExaToolDefinitions } from "../../exa/index.js";

const WORKER_DELEGATION_PROMPT = `## Worker Agent Instructions

You are a worker agent spawned by an orchestrator. Follow these rules:

1. **Execute only what was requested** - Focus on the specific task in your instructions.
2. **Read spec from backlog** - If given a task ID, run \`backlog show <id>\` for context.
3. **Orchestrator owns git** - Do not commit, rebase, push, or change git state.
4. **Orchestrator owns review** - Do not spawn review agents.
5. **Orchestrator owns backlog state** - Do not create, close, or update backlog tasks unless explicitly asked. Only read with \`backlog show\` by default.
6. **Stay on task** - If you discover unrelated bugs, report them in your final message. Do not fix them and do not create follow-up backlog items unless explicitly asked. The orchestrator handles follow-up.
7. **Other agents may work simultaneously** - Ignore changes you didn't make.
8. **Only your final message is returned** - Make it a clear summary.
`;

export function createWorkerCustomTools(
	agentTool: ToolDefinition,
): ToolDefinition[] {
	return [
		agentTool,
		createBacklogToolDefinition(),
		...createExaToolDefinitions(),
	];
}

export function buildWorkerAppendPrompts(options: {
	definition: AgentDefinition;
}): string[] {
	const prompts: string[] = [];

	prompts.push(WORKER_DELEGATION_PROMPT);

	if (options.definition.systemPrompt) {
		prompts.push(options.definition.systemPrompt);
	}

	return prompts;
}
