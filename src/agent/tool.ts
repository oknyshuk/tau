import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { Effect, Stream, Cause } from "effect";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
	AgentControl,
	AgentLimitReached,
	AgentDepthExceeded,
	AgentNotFound,
	AgentAccessDenied,
	AgentSpawnRestricted,
	AgentError,
	type ControlSpawnOptions,
	type ParentExecutionContext,
	type WaitResult,
} from "./services.js";
import type { AgentId } from "./types.js";
import { renderAgentCall, renderAgentResult } from "./render.js";
import type { ApprovalBroker } from "./approval-broker.js";
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS } from "./control.js";
import { defineDecodedTool, textToolResult } from "../shared/decoded-tool.js";

/**
 * Convert an AbortSignal to an Effect that completes when the signal aborts.
 */
function abortSignalEffect(signal: AbortSignal | undefined): Effect.Effect<void> {
	if (!signal) {
		return Effect.never;
	}
	if (signal.aborted) {
		return Effect.void;
	}
	return Effect.promise(
		() =>
			new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			}),
	);
}

export const AgentParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("spawn"),
			Type.Literal("send"),
			Type.Literal("wait"),
			Type.Literal("close"),
			Type.Literal("list"),
		],
		{
			description:
				"Action: spawn (create), send (message existing), wait (block until done), close (terminate), list (show all)",
		},
	),
	// spawn
	agent: Type.Optional(
		Type.String({
			description:
				"Agent name to spawn (e.g., oracle, finder, smart, deep, rush, review, painter, librarian)",
		}),
	),
	message: Type.Optional(Type.String({ description: "Task instructions for the agent" })),
	// send/close
	id: Type.Optional(Type.String({ description: "Target agent ID" })),
	interrupt: Type.Optional(
		Type.Boolean({
			description: "If true, abort agent's current work before sending new message",
		}),
	),
	// wait
	ids: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Agent IDs to wait for (required for wait action). Returns when all finish (completed/failed/shutdown)",
		}),
	),
	timeout_ms: Type.Optional(
		Type.Number({
			description:
				"Max wait time in ms. Default/minimum 1200000 (20 min), max 14400000 (4 hours). Omit unless you need longer. Returns timedOut:true if exceeded",
		}),
	),
});

type DecodedAgentParams = Static<typeof AgentParams>;

function decodeAgentParams(rawParams: unknown): DecodedAgentParams {
	return Value.Parse(AgentParams, rawParams);
}

export function buildToolDescription(
	registry: {
		list: () => ReadonlyArray<{ readonly name: string; readonly description: string }>;
	},
	spawns?: readonly string[] | "*" | undefined,
	isDisabled?: (name: string) => boolean,
): string {
	const allAgents = registry.list();
	const scopedAgents =
		spawns === undefined || spawns === "*"
			? allAgents
			: allAgents.filter((a) => spawns.includes(a.name));

	const enabledAgents = isDisabled
		? scopedAgents.filter((a) => !isDisabled(a.name))
		: scopedAgents;

	const lines: string[] = [];
	lines.push("Manage non-blocking agent tasks. Actions: spawn, send, wait, close, list.");
	lines.push("");
	lines.push("## Workflow");
	lines.push("1. spawn: starts agent in background, returns agent_id immediately");
	lines.push("2. wait: blocks until agent(s) complete, returns their output");
	lines.push("3. Result is in: status.{agent_id}.message");
	lines.push("");
	lines.push("You can spawn multiple agents and wait for all at once.");
	lines.push(
		`Wait defaults to ${DEFAULT_WAIT_TIMEOUT_MS} ms (${Math.floor(DEFAULT_WAIT_TIMEOUT_MS / 60000)} min) and uses that as the minimum timeout. Pass timeout_ms only when you need longer, up to ${MAX_WAIT_TIMEOUT_MS} ms.`,
	);
	lines.push("");
	lines.push("## Available agents");
	for (const a of enabledAgents) {
		const shortDesc = a.description.replace(/\s+/g, " ").trim();
		lines.push(`- ${a.name}: ${shortDesc}`);
	}

	return lines.join("\n").trim();
}

export interface AgentToolContext {
	parentSessionFile: string | undefined;
	parentAgentId?: AgentId | undefined;
	parentModel: Model<Api> | undefined;
	resolveParentExecution: () => Promise<ParentExecutionContext>;
	modelRegistry: ModelRegistry | undefined;
	cwd: string;
	approvalBroker: ApprovalBroker | undefined;
}

type ToolResult = {
	isError?: boolean;
	content: Array<{ type: "text"; text: string }>;
	details: object;
};

/**
 * Execute wait action with streaming updates via onUpdate callback.
 * If no ids provided, waits for all active agents.
 * Handles abort signals for interruption.
 */
async function executeWaitWithUpdates(
	runEffect: <A, E>(effect: Effect.Effect<A, E, AgentControl>) => Promise<A>,
	p: DecodedAgentParams,
	onUpdate: AgentToolUpdateCallback<object> | undefined,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	try {
		let latestResult: WaitResult | null = null;

		const program = Effect.gen(function* () {
			const control = yield* AgentControl;

			const ids = p.ids as AgentId[] | undefined;
			if (!ids || ids.length === 0) {
				return yield* Effect.fail(
					new Error("wait requires 'ids' with at least one agent ID"),
				);
			}

			const stream = control.waitStream(ids, p.timeout_ms, 1000);

			// Create abort effect that completes when signal triggers
			const abortEffect = abortSignalEffect(signal).pipe(
				Effect.as({ _tag: "aborted" as const }),
			);

			const streamEffect = stream.pipe(
				Stream.tap((result) =>
					Effect.sync(() => {
						latestResult = result;
						if (onUpdate) {
							onUpdate({
								content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
								details: result,
							});
						}
					}),
				),
				Stream.runDrain,
				Effect.as({ _tag: "completed" as const }),
			);

			const outcome = yield* Effect.race(streamEffect, abortEffect);

			if (outcome._tag === "aborted") {
				return latestResult
					? { ...latestResult, interrupted: true }
					: { status: {}, timedOut: false, interrupted: true };
			}

			return latestResult ?? { status: {}, timedOut: false };
		});

		const result = await runEffect(
			program.pipe(
				Effect.catchCause((cause) =>
					Effect.gen(function* () {
						// Check if this was an interruption (from abort signal)
						if (Cause.hasInterrupts(cause)) {
							if (latestResult) {
								return { ...latestResult, interrupted: true };
							}
						}
						// Re-throw real errors
						return yield* Effect.failCause(cause);
					}),
				),
				Effect.catch((err: unknown) =>
					Effect.fail(err instanceof Error ? err : new Error(String(err))),
				),
			),
		);

		return {
			content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			details: result,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			isError: true,
			content: [{ type: "text", text: message }],
			details: { error: message },
		};
	}
}

export type AgentToolDef = ToolDefinition;

/**
 * Create an agent tool that uses the provided runtime to execute commands.
 * This allows both the main extension and worker sessions to use the same
 * underlying AgentManager.
 */
export function createAgentToolDef(
	runEffect: <A, E>(effect: Effect.Effect<A, E, AgentControl>) => Promise<A>,
	getContext: () => AgentToolContext,
	description: string,
): AgentToolDef {
	return defineDecodedTool<typeof AgentParams, DecodedAgentParams, object>({
		name: "agent",
		label: "agent",
		description,
		parameters: AgentParams,
		decodeParams: decodeAgentParams,
		formatInvalidParamsResult: (message) =>
			textToolResult(message, { error: message }, { isError: true }),
		renderCall: renderAgentCall,
		renderResult: renderAgentResult,
		async execute(p, { signal, onUpdate }) {
			const context = getContext();

			// Special case for wait: use streaming with onUpdate and abort handling
			if (p.action === "wait") {
				const typedOnUpdate = onUpdate as AgentToolUpdateCallback<object> | undefined;
				return executeWaitWithUpdates(runEffect, p, typedOnUpdate, signal);
			}

			const program: Effect.Effect<
				object,
				| AgentLimitReached
				| AgentDepthExceeded
				| AgentNotFound
				| AgentAccessDenied
				| AgentSpawnRestricted
				| AgentError
				| Error,
				AgentControl
			> = Effect.gen(function* () {
				const control = yield* AgentControl;

				switch (p.action) {
					case "spawn": {
						if (!p.agent || !p.message) {
							return yield* Effect.fail(
								new Error("spawn requires 'agent' and 'message'"),
							);
						}
						const parentExecution = yield* Effect.tryPromise({
							try: () => context.resolveParentExecution(),
							catch: (cause) =>
								new AgentError({
									message: cause instanceof Error ? cause.message : String(cause),
								}),
						});
						const id = yield* control.spawn({
							agent: p.agent,
							message: p.message,
							approvalBroker: context.approvalBroker,
							parentSessionFile: context.parentSessionFile,
							parentExecution,
							parentAgentId: context.parentAgentId,
							parentModel: context.parentModel,
							modelRegistry: context.modelRegistry,
							cwd: context.cwd,
						} satisfies ControlSpawnOptions as ControlSpawnOptions);
						return {
							agent_id: id,
							status: "running",
							message: p.message,
							note: "Agent started. Call wait with this id to get result when done.",
						};
					}
					case "send": {
						if (!p.id || !p.message) {
							return yield* Effect.fail(
								new Error("send requires 'id' and 'message'"),
							);
						}
						const submission_id = yield* control.send(
							p.id as AgentId,
							p.message,
							p.interrupt,
							context.parentAgentId,
						);
						return {
							submission_id,
							agent_id: p.id,
							message: p.message,
						};
					}
					case "close": {
						if (!p.id) {
							return yield* Effect.fail(new Error("close requires 'id'"));
						}
						const ids = yield* control.close(p.id as AgentId, context.parentAgentId);
						return { status: "closed", closedIds: ids };
					}
					case "list": {
						const agents = yield* control.list;
						const summary = agents.map((a) => {
							const { state } = a.status;
							const base: Record<string, unknown> = { id: a.id, type: a.type, state };
							const s = a.status as Record<string, unknown>;
							if (a.parentAgentId !== undefined)
								base["parentAgentId"] = a.parentAgentId;
							if ("turns" in s && s["turns"] !== undefined)
								base["turns"] = s["turns"];
							if ("toolCalls" in s && s["toolCalls"] !== undefined)
								base["toolCalls"] = s["toolCalls"];
							if ("workedMs" in s && s["workedMs"] !== undefined)
								base["workedMs"] = s["workedMs"];
							if (state === "failed" && "reason" in s) base["reason"] = s["reason"];
							return base;
						});
						return { agents: summary };
					}
					default:
						return yield* Effect.fail(new Error(`Unknown action: ${p.action}`));
				}
			});

			try {
				const result = await runEffect(
					program.pipe(
						Effect.catchTags({
							AgentLimitReached: (err: AgentLimitReached) =>
								Effect.fail(
									new Error(
										`Agent limit reached (max: ${err.max}). Close completed agents (agent close <id>) or wait for running agents to finish.`,
									),
								),
							AgentDepthExceeded: (err: AgentDepthExceeded) =>
								Effect.fail(
									new Error(
										`Agent depth exceeded (max: ${err.max}). Deeply nested agent spawns are restricted.`,
									),
								),
							AgentNotFound: (err: AgentNotFound) =>
								Effect.fail(new Error(`Agent not found: ${err.id}`)),
							AgentAccessDenied: (err: AgentAccessDenied) =>
								Effect.fail(
									new Error(
										`Access denied for agent ${err.requesterId}: cannot mutate ${err.id} (parent: ${err.parentId}).`,
									),
								),
							AgentSpawnRestricted: (err: AgentSpawnRestricted) =>
								Effect.fail(
									new Error(
										`Agent ${err.parentType} cannot spawn "${err.requestedAgent}". Allowed spawns: ${err.allowedSpawns.length === 0 ? "none" : err.allowedSpawns.join(", ")}.`,
									),
								),
							AgentError: (err: AgentError) => Effect.fail(new Error(err.message)),
						}),
						Effect.catch((err: unknown) =>
							Effect.fail(err instanceof Error ? err : new Error(String(err))),
						),
					),
				);
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result as object,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					isError: true,
					content: [{ type: "text", text: message }],
					details: { error: message } as object,
				};
			}
		},
	});
}
