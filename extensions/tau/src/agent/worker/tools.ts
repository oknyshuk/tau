import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { AgentDefinition } from "../types.js";
import { createApplyPatchToolDefinition } from "../../sandbox/apply-patch.js";
import { createBacklogToolDefinition } from "../../backlog/tool.js";
import { createExaToolDefinitions } from "../../exa/index.js";
import { createMemoryToolDefinition } from "../../memory/index.js";
import type { RunAgentControlPromise } from "../runtime.js";

export const WORKER_DELEGATION_PROMPT = `## Worker Agent Instructions

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
	runEffect: RunAgentControlPromise,
): ToolDefinition[] {
	return [
		agentTool,
		createApplyPatchToolDefinition(),
		createBacklogToolDefinition(),
		createMemoryToolDefinition(runEffect),
		...createExaToolDefinitions(),
	];
}

export function buildWorkerAppendPrompts(options: {
	definition: AgentDefinition;
	resultSchema?: unknown;
}): string[] {
	const prompts: string[] = [];

	prompts.push(WORKER_DELEGATION_PROMPT);

	if (options.definition.systemPrompt) {
		prompts.push(options.definition.systemPrompt);
	}

	if (options.resultSchema) {
		prompts.push(
			`## Structured Output\n- You must call submit_result exactly once with JSON matching the provided schema.\n- Do not respond with free text.\n- Stop immediately after calling submit_result.\n\nSchema:\n\n\`\`\`json\n${JSON.stringify(options.resultSchema, null, 2)}\n\`\`\``,
		);
	}

	return prompts;
}
