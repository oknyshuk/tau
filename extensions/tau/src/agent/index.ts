import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { renderAgentCall, renderAgentResult } from "./render.js";
import { createUiApprovalBroker } from "./approval-broker.js";
import type { AgentRuntimeBridgeService } from "./runtime.js";
import { AgentParams, createAgentToolDef } from "./tool.js";
import { ExecutionState } from "../services/execution-state.js";
import { makeExecutionProfile } from "../execution/schema.js";
import { readModelId } from "../prompt/profile.js";
import { isExecutionThinkingLevel } from "./model-spec.js";

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readContextValue<T>(getter: () => T): T | undefined {
	try {
		return getter();
	} catch {
		return undefined;
	}
}

type SessionManagerContext = {
	readonly getCwd: () => string;
	readonly getSessionFile: () => string | undefined;
};

function readSessionString(
	ctx: { readonly sessionManager: SessionManagerContext },
	read: (sessionManager: SessionManagerContext) => string | undefined,
): string | undefined {
	const sessionManager = readContextValue(() => ctx.sessionManager);
	if (sessionManager === undefined) {
		return undefined;
	}

	return nonEmptyString(readContextValue(() => read(sessionManager)));
}

function resolveAgentContextCwd(ctx: {
	readonly cwd: unknown;
	readonly sessionManager: SessionManagerContext;
}): string {
	return (
		readSessionString(ctx, (sessionManager) => sessionManager.getCwd()) ??
		nonEmptyString(readContextValue(() => ctx.cwd)) ??
		process.cwd()
	);
}

function resolveParentSessionFile(ctx: {
	readonly sessionManager: SessionManagerContext;
}): string | undefined {
	return readSessionString(ctx, (sessionManager) => sessionManager.getSessionFile());
}

function readContextModel(ctx: { readonly model: Model<Api> | undefined }): Model<Api> | undefined {
	return readContextValue(() => ctx.model);
}

export interface AgentToolHandle {
	/** Re-register the agent tool with an updated description. */
	refresh(description: string): void;
}

export default function initAgent(
	pi: ExtensionAPI,
	runtime: AgentRuntimeBridgeService,
	description: string,
): AgentToolHandle {
	// Close all agents when switching to a different session (/new, /resume, fork).
	// Skip startup (no agents yet) and reload (in-process state preserved).
	pi.on("session_start", async (event) => {
		if (event.reason === "startup" || event.reason === "reload") return;
		await runtime.closeAll();
	});

	let currentDescription = description;

	const registerAgentTool = (desc: string) => {
		currentDescription = desc;
		pi.registerTool({
			name: "agent",
			label: "agent",
			description: desc,
			promptSnippet: "Manage non-blocking agent tasks (spawn, send, wait, close, list)",
			promptGuidelines: [
				"Use all the tools available to you.",
				"For complex tasks requiring deep analysis, planning, or debugging across multiple files, use an expert reasoning subagent and then validate findings with your own investigation.",
			],
			parameters: AgentParams,

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const maybeUi = readContextValue(() => ctx.ui);
				const approvalBroker =
					readContextValue(() => ctx.hasUI) === true &&
					maybeUi !== undefined &&
					typeof maybeUi.confirm === "function"
						? createUiApprovalBroker(maybeUi)
						: undefined;

				const resolveParentExecution = () =>
					runtime.runPromise(
						Effect.gen(function* () {
							const executionState = yield* ExecutionState;
							const state = executionState.getSnapshot();
							const parentModel = readContextModel(ctx);
							const model = readModelId(parentModel);
							if (model === undefined) {
								throw new Error(
									"Cannot spawn agent: current session has no active model",
								);
							}

							const thinking = pi.getThinkingLevel();
							if (!isExecutionThinkingLevel(thinking)) {
								throw new Error(
									"Cannot spawn agent: current session has no supported thinking level",
								);
							}

							return {
								state,
								profile: makeExecutionProfile({
									model,
									thinking,
									policy: state.policy,
								}),
							};
						}),
					);

				const toolDef = createAgentToolDef(
					(effect) => runtime.runPromise(effect),
					() => ({
						parentSessionFile: resolveParentSessionFile(ctx),
						parentAgentId: undefined,
						parentModel: readContextModel(ctx),
						resolveParentExecution,
						modelRegistry: readContextValue(() => ctx.modelRegistry),
						cwd: resolveAgentContextCwd(ctx),
						approvalBroker,
					}),
					currentDescription,
				);

				return toolDef.execute(toolCallId, params, signal, onUpdate, ctx);
			},

			renderCall(args, theme) {
				return renderAgentCall(args, theme);
			},
			renderResult(result, options, theme) {
				return renderAgentResult(result, options, theme);
			},
		});
	};

	registerAgentTool(description);

	return {
		refresh: registerAgentTool,
	};
}
