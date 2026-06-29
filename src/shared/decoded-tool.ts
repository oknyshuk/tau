import type { TSchema } from "typebox";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

interface ToolExecuteContext<TDetails> {
	readonly toolCallId: string;
	readonly signal: AbortSignal | undefined;
	readonly onUpdate: AgentToolUpdateCallback<TDetails> | undefined;
	readonly ctx: ExtensionContext;
}

interface DefineDecodedToolOptions<TParamsSchema extends TSchema, TParams, TDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TParamsSchema;
	readonly decodeParams: (rawParams: unknown) => TParams;
	readonly promptSnippet?: string;
	readonly promptGuidelines?: readonly string[];
	readonly renderCall?: ToolDefinition["renderCall"];
	readonly renderResult?: ToolDefinition["renderResult"];
	readonly formatInvalidParamsResult: (message: string) => AgentToolResult<TDetails>;
	readonly formatExecuteErrorResult?: (
		error: unknown,
		params: TParams,
	) => AgentToolResult<TDetails>;
	readonly execute: (
		params: TParams,
		context: ToolExecuteContext<TDetails>,
	) => Promise<AgentToolResult<TDetails>> | AgentToolResult<TDetails>;
}

export function textToolResult<TDetails>(
	text: string,
	details: TDetails,
	options?: { readonly isError?: boolean },
): AgentToolResult<TDetails> {
	return {
		...(options?.isError === true ? { isError: true } : {}),
		content: [{ type: "text", text }],
		details,
	};
}

export function defineDecodedTool<TParamsSchema extends TSchema, TParams, TDetails>(
	options: DefineDecodedToolOptions<TParamsSchema, TParams, TDetails>,
): ToolDefinition {
	return {
		name: options.name,
		label: options.label,
		description: options.description,
		...(options.promptSnippet === undefined ? {} : { promptSnippet: options.promptSnippet }),
		...(options.promptGuidelines === undefined
			? {}
			: { promptGuidelines: [...options.promptGuidelines] }),
		parameters: options.parameters,
		...(options.renderCall === undefined ? {} : { renderCall: options.renderCall }),
		...(options.renderResult === undefined ? {} : { renderResult: options.renderResult }),
		async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
			let params: TParams;
			try {
				params = options.decodeParams(rawParams);
			} catch (cause: unknown) {
				return options.formatInvalidParamsResult(
					`Invalid ${options.name} params: ${cause instanceof Error ? cause.message : String(cause)}`,
				);
			}

			try {
				return await options.execute(params, { toolCallId, signal, onUpdate, ctx });
			} catch (cause: unknown) {
				if (options.formatExecuteErrorResult !== undefined) {
					return options.formatExecuteErrorResult(cause, params);
				}
				throw cause;
			}
		},
	};
}
