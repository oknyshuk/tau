import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { Effect, Option } from "effect";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { defineDecodedTool, textToolResult } from "../shared/decoded-tool.js";
import { ThreadAmbiguousError, ThreadNotFoundError } from "./errors.js";
import {
	renderFindThreadCall,
	renderFindThreadResult,
	renderReadThreadCall,
	renderReadThreadResult,
} from "./renderer.js";
import { findThreads, readThread } from "./service.js";
import type { FindThreadResult, ReadThreadResult } from "./types.js";

const FindThreadParamsSchema = Type.Object({
	query: Type.String({
		description: "Search query to find threads by ID, title, or content.",
		minLength: 1,
		maxLength: 500,
	}),
});

const ReadThreadParamsSchema = Type.Object({
	threadID: Type.String({
		description: "The thread ID to read (exact ID or unique prefix).",
		minLength: 1,
	}),
	goal: Type.Optional(
		Type.String({
			description: "Optional goal to focus the transcript on relevant sections.",
			maxLength: 500,
		}),
	),
});

type FindThreadParams = Static<typeof FindThreadParamsSchema>;
type ReadThreadParams = Static<typeof ReadThreadParamsSchema>;

function decodeFindThreadParams(rawParams: unknown): FindThreadParams {
	return Value.Parse(FindThreadParamsSchema, rawParams);
}

function decodeReadThreadParams(rawParams: unknown): ReadThreadParams {
	return Value.Parse(ReadThreadParamsSchema, rawParams);
}

function readDetails<T>(result: unknown): T | undefined {
	if (typeof result !== "object" || result === null || !Object.hasOwn(result, "details")) {
		return undefined;
	}
	const details = Reflect.get(result, "details");
	return details as T | undefined;
}

export function createThreadToolDefinitions(): readonly ToolDefinition[] {
	return [
		defineDecodedTool<typeof FindThreadParamsSchema, FindThreadParams, FindThreadResult | undefined>({
			name: "find_thread",
			label: "find_thread",
			description:
				"Search for threads/sessions by query. Finds threads by ID, title, or content. Searches current workspace first, then globally. Returns thread metadata including ID, title, message count, and timestamps.",
			promptSnippet: "Search for threads by query",
			parameters: FindThreadParamsSchema,
			decodeParams: decodeFindThreadParams,
			formatInvalidParamsResult: (message) => textToolResult(message, undefined, { isError: true }),
			renderCall(args, theme) {
				return new Text(renderFindThreadCall(args, theme), 0, 0);
			},
			renderResult(result, options, theme) {
				if (options.isPartial) {
					return new Text(theme.fg("warning", "Searching threads…"), 0, 0);
				}

				const details = readDetails<FindThreadResult>(result);
				if (!details) {
					return new Text(theme.fg("dim", "(no results)"), 0, 0);
				}

				return new Text(renderFindThreadResult(details, options.expanded, theme), 0, 0);
			},
			async execute(params, { onUpdate, ctx }) {
				onUpdate?.({
					content: [{ type: "text", text: "Searching threads…" }],
					details: undefined,
				});

				const result = await Effect.runPromise(findThreads(params.query, ctx.cwd));
				const textContent = result.threads
					.map(
						(thread, index) =>
							`[${index + 1}] ${thread.title}\n` +
							`ID: ${thread.id}\n` +
							`CWD: ${thread.cwd}\n` +
							`Messages: ${thread.messageCount} · Updated: ${thread.updatedAt}\n` +
							`Preview: ${thread.preview}`,
					)
					.join("\n\n");

				return {
					content: [{ type: "text" as const, text: textContent || "No threads found matching the query." }],
					details: result,
				};
			},
		}),
		defineDecodedTool<typeof ReadThreadParamsSchema, ReadThreadParams, ReadThreadResult | undefined>({
			name: "read_thread",
			label: "read_thread",
			description:
				"Read the full transcript of a thread by ID. Returns a formatted markdown transcript including user messages, assistant responses, and tool results. Use 'goal' to focus on specific content. Respects branch context and compaction summaries.",
			promptSnippet: "Read a thread transcript by ID",
			parameters: ReadThreadParamsSchema,
			decodeParams: decodeReadThreadParams,
			formatInvalidParamsResult: (message) => textToolResult(message, undefined, { isError: true }),
			renderCall(args, theme) {
				return new Text(renderReadThreadCall(args, theme), 0, 0);
			},
			renderResult(result, options, theme) {
				if (options.isPartial) {
					return new Text(theme.fg("warning", "Reading thread…"), 0, 0);
				}

				const details = readDetails<ReadThreadResult>(result);
				if (!details) {
					return new Text(theme.fg("dim", "(no content)"), 0, 0);
				}

				return new Text(renderReadThreadResult(details, options.expanded, theme), 0, 0);
			},
			async execute(params, { onUpdate, ctx }) {
				onUpdate?.({
					content: [{ type: "text", text: "Reading thread…" }],
					details: undefined,
				});

				const goal = params.goal ? Option.some(params.goal) : Option.none();
				const result = await Effect.runPromise(
					readThread(params.threadID, goal, ctx.cwd).pipe(
						Effect.catch((error) => {
							if (error instanceof ThreadNotFoundError) {
								return Effect.succeed({
									ok: true as const,
									threadID: params.threadID,
									resolvedPath: "",
									title: "Not Found",
									cwd: ctx.cwd,
									createdAt: new Date().toISOString(),
									updatedAt: new Date().toISOString(),
									parentThreadId: undefined,
									totalMessages: 0,
									includedMessages: 0,
									truncated: false,
									content: `Thread "${params.threadID}" not found.`,
								});
							}
							if (error instanceof ThreadAmbiguousError) {
								return Effect.succeed({
									ok: true as const,
									threadID: params.threadID,
									resolvedPath: "",
									title: "Ambiguous Match",
									cwd: ctx.cwd,
									createdAt: new Date().toISOString(),
									updatedAt: new Date().toISOString(),
									parentThreadId: undefined,
									totalMessages: 0,
									includedMessages: 0,
									truncated: false,
									content:
										`Thread ID "${params.threadID}" is ambiguous. ` +
										`Multiple sessions match:\n` +
										error.matches.map((match) => `  - ${match.id} (${match.path})`).join("\n"),
								});
							}
							throw error;
						}),
					),
				);

				return {
					content: [{ type: "text" as const, text: result.content }],
					details: result,
				};
			},
		}),
	];
}

export default function initThreadTools(pi: ExtensionAPI): void {
	for (const tool of createThreadToolDefinitions()) {
		pi.registerTool(tool);
	}
}
