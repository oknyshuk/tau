// DreamSubagent -- forked agent session that curates memory through the
// existing memory tool and signals completion via dream_finish.

import { Effect, Layer, Context } from "effect";

import {
	createAgentSession,
	readOnlyTools,
	SessionManager,
	SettingsManager,
	DefaultResourceLoader,
	type ModelRegistry,
	type AgentSession,
	type AgentSessionEvent,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type {
	AssistantMessage,
	ThinkingLevel,
} from "@mariozechner/pi-ai";

import type { DreamProgressEvent } from "./domain.js";
import {
	DreamSubagentSpawnFailed,
	type DreamSubagentError,
} from "./errors.js";
import { readMemoryToolAction, shouldCountMemoryMutation } from "./memory-mutations.js";
import { buildDreamPrompt } from "./prompt.js";
import { resolveModelPattern } from "../agent/worker.js";
import type { MemoryEntriesSnapshot } from "../memory/format.js";

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface DreamSubagentContext {
	readonly modelRegistry: ModelRegistry;
}

export interface DreamSubagentRunRequest {
	readonly cwd: string;
	readonly runId: string;
	readonly mode: "manual" | "auto";
	readonly model: {
		readonly model: string;
		readonly thinking: "low" | "medium" | "high" | "xhigh";
		readonly maxTurns: number;
	};
	readonly memorySnapshot: MemoryEntriesSnapshot;
	readonly nowIso: string;
}

/** Session execution result. Finish params are captured externally by the
 *  dream_finish tool closure that the runner passes as a custom tool. */
export interface DreamSubagentResult {
	readonly memoryMutations: number;
}

export interface DreamSubagentApi {
	readonly run: (
		request: DreamSubagentRunRequest,
		context: DreamSubagentContext,
		customTools: ReadonlyArray<ToolDefinition>,
		onEvent: (event: DreamProgressEvent) => Effect.Effect<void>,
	) => Effect.Effect<DreamSubagentResult, DreamSubagentError>;
}

export class DreamSubagent extends Context.Service<DreamSubagent, DreamSubagentApi>()(
	"DreamSubagent",
) {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapThinking(level: "low" | "medium" | "high" | "xhigh"): ThinkingLevel {
	return level;
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function isAssistantMessage(msg: unknown): msg is AssistantMessage {
	if (typeof msg !== "object" || msg === null) return false;
	const candidate = msg as Record<string, unknown>;
	return (
		candidate["role"] === "assistant" &&
		Array.isArray(candidate["content"])
	);
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function summarizeUnknown(value: unknown, maxChars: number): string {
	try {
		const rendered = typeof value === "string" ? value : JSON.stringify(value);
		if (rendered === undefined) {
			return "(unserializable)";
		}
		return truncate(rendered, maxChars);
	} catch {
		return "(unserializable)";
	}
}

function hasTextPartShape(part: unknown): part is { readonly type: "text"; readonly text: string } {
	if (typeof part !== "object" || part === null) return false;
	const candidate = part as Record<string, unknown>;
	return candidate["type"] === "text" && typeof candidate["text"] === "string";
}

function summarizeToolResult(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const candidate = result as Record<string, unknown>;
	if (!Array.isArray(candidate["content"])) return undefined;

	const textParts = candidate["content"]
		.filter(hasTextPartShape)
		.map((part) => part.text)
		.join("\n")
		.trim();

	if (textParts.length === 0) {
		return undefined;
	}

	return truncate(textParts, 200);
}

function summarizeSubagentEvent(event: AgentSessionEvent): string | undefined {
	if (event.type === "turn_start") {
		return "Subagent started a new turn";
	}

	if (event.type === "tool_execution_start") {
		const args = summarizeUnknown(event.args, 180);
		return `Subagent tool start: ${event.toolName} ${args}`;
	}

	if (event.type === "tool_execution_end") {
		const resultText = summarizeToolResult(event.result);
		if (resultText !== undefined) {
			return `Subagent tool done: ${event.toolName}${event.isError ? " (error)" : ""} -> ${resultText}`;
		}
		return `Subagent tool done: ${event.toolName}${event.isError ? " (error)" : ""}`;
	}

	if (event.type === "message_end" && isAssistantMessage(event.message)) {
		const text = extractAssistantText(event.message);
		if (text.length === 0) {
			return undefined;
		}
		return `Subagent response: ${truncate(text, 200)}`;
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

interface SessionSuccess {
	readonly ok: true;
}

interface SessionFailure {
	readonly ok: false;
	readonly reason: string;
}

interface TurnLimitExceeded {
	readonly _tag: "turn_limit_exceeded";
	readonly maxTurns: number;
}

interface PromptFailed {
	readonly _tag: "prompt_failed";
	readonly error: unknown;
}

type SessionOutcome = SessionSuccess | SessionFailure | TurnLimitExceeded | PromptFailed;

type TurnLimitSession = Pick<AgentSession, "abort"> & {
	readonly agent: {
		subscribe: AgentSession["agent"]["subscribe"];
	};
};

function waitForSessionEnd(session: AgentSession): Effect.Effect<SessionSuccess | SessionFailure> {
	return Effect.callback<SessionSuccess | SessionFailure>((resume) => {
		let settled = false;

		const settle = (result: SessionSuccess | SessionFailure): void => {
			if (settled) {
				return;
			}
			settled = true;
			unsubscribe();
			resume(Effect.succeed(result));
		};

		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "agent_end") {
				return;
			}

			const messages: unknown[] = "messages" in event ? (event.messages as unknown[]) : [];
			const lastAssistant = [...messages].reverse().find(isAssistantMessage);

			if (!lastAssistant) {
				settle({ ok: false, reason: "No assistant response from dream subagent" });
				return;
			}

			if (lastAssistant.stopReason === "error") {
				const errorReason =
					lastAssistant.errorMessage ??
					extractAssistantText(lastAssistant) ??
					"Agent ended with error";
				settle({ ok: false, reason: errorReason });
				return;
			}

			if (lastAssistant.stopReason === "aborted") {
				settle({ ok: false, reason: "Dream subagent was aborted" });
				return;
			}

			settle({ ok: true });
		});

		return Effect.sync(() => {
			if (!settled) {
				settled = true;
			}
			unsubscribe();
		});
	});
}

function createTurnLimitGuard(
	session: TurnLimitSession,
	maxTurns: number,
): Effect.Effect<TurnLimitExceeded> {
	return Effect.callback<TurnLimitExceeded>((resume) => {
		let settled = false;
		let turns = 0;

		const settle = (result: TurnLimitExceeded): void => {
			if (settled) {
				return;
			}
			settled = true;
			unsubscribe();
			resume(Effect.succeed(result));
		};

		const unsubscribe = session.agent.subscribe((event) => {
			if (settled || event.type !== "turn_start") {
				return;
			}

			turns += 1;
			if (turns <= maxTurns) {
				return;
			}

			settle({ _tag: "turn_limit_exceeded", maxTurns });
			void session.abort();
		});

		return Effect.sync(() => {
			if (!settled) {
				settled = true;
			}
			unsubscribe();
		});
	});
}

function waitForPromptFailure(promptPromise: Promise<void>): Effect.Effect<PromptFailed> {
	return Effect.callback<PromptFailed>((resume) => {
		let settled = false;

		void promptPromise.catch((error) => {
			if (settled) {
				return;
			}
			settled = true;
			resume(Effect.succeed({ _tag: "prompt_failed", error }));
		});

		return Effect.sync(() => {
			settled = true;
		});
	});
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

function runImpl(
	request: DreamSubagentRunRequest,
	context: DreamSubagentContext,
	customTools: ReadonlyArray<ToolDefinition>,
	onEvent: (event: DreamProgressEvent) => Effect.Effect<void>,
): Effect.Effect<DreamSubagentResult, DreamSubagentError> {
	return Effect.gen(function* () {
		// ── Resolve model ────────────────────────────────────────────
		const allModels = context.modelRegistry.getAll();
		const resolvedModel = resolveModelPattern(request.model.model, allModels);

		if (!resolvedModel) {
			return yield* new DreamSubagentSpawnFailed({
				reason: `Could not resolve dream model: "${request.model.model}". Available: ${allModels.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
			});
		}

		// ── Build prompt ─────────────────────────────────────────────
		yield* onEvent({ _tag: "PhaseChanged", phase: "orient", message: "Building dream prompt" });

		const systemPrompt = buildDreamPrompt({
			runId: request.runId,
			mode: request.mode,
			nowIso: request.nowIso,
			memorySnapshot: request.memorySnapshot,
		});

		// ── Create agent session ─────────────────────────────────────
		yield* onEvent({ _tag: "PhaseChanged", phase: "gather", message: "Spawning dream subagent" });

		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: request.cwd,
			settingsManager,
			appendSystemPromptOverride: () => [systemPrompt],
		});

		yield* Effect.tryPromise({
			try: () => resourceLoader.reload(),
			catch: (error) =>
				new DreamSubagentSpawnFailed({
					reason: `Failed to reload resource loader: ${String(error)}`,
				}),
		});

		const sessionResult = yield* Effect.tryPromise({
			try: () =>
				createAgentSession({
					cwd: request.cwd,
					model: resolvedModel,
					thinkingLevel: mapThinking(request.model.thinking),
					tools: readOnlyTools,
					customTools: [...customTools],
					modelRegistry: context.modelRegistry,
					sessionManager: SessionManager.inMemory(request.cwd),
					settingsManager,
					resourceLoader,
				}),
			catch: (error) =>
				new DreamSubagentSpawnFailed({
					reason: `Failed to create dream agent session: ${String(error)}`,
				}),
		});

		const session = sessionResult.session;
		const turnLimitGuard = createTurnLimitGuard(session, request.model.maxTurns);

		// Track memory mutations by watching tool_execution_start args
		// (tool_execution_end doesn't carry args)
		const pendingMemoryActions = new Map<string, string>();
		let observedMemoryMutations = 0;

		const unsubscribeActivity = session.subscribe((event) => {
			// Capture memory tool action from start event
			if (
				event.type === "tool_execution_start" &&
				event.toolName === "memory"
			) {
				const action = readMemoryToolAction(event.args);
				if (action !== undefined) {
					pendingMemoryActions.set(event.toolCallId, action);
				}
			}

			// Count successful memory mutations
			if (
				event.type === "tool_execution_end" &&
				event.toolName === "memory" &&
				!event.isError
			) {
				const action = pendingMemoryActions.get(event.toolCallId);
				pendingMemoryActions.delete(event.toolCallId);
				if (shouldCountMemoryMutation(action, event.result)) {
					observedMemoryMutations += 1;
				}
			}

			const summary = summarizeSubagentEvent(event);
			if (summary === undefined) {
				return;
			}

			void Effect.runPromise(
				onEvent({ _tag: "Note", text: summary }).pipe(
					Effect.catch((error) => Effect.logWarning("Dream event reporting failed", error)),
				),
			);
		});

		// ── Prompt and wait ──────────────────────────────────────────
		yield* onEvent({
			_tag: "PhaseChanged",
			phase: "consolidate",
			message: `Running dream with ${resolvedModel.provider}/${resolvedModel.id}`,
		});

		const promptPromise = session.prompt(
			"Begin the 4-phase memory curation. Use only the memory tool to inspect and mutate memory entries, correct scope mistakes, then finish with dream_finish.",
			{ source: "extension" },
		);

		const outcome: SessionOutcome = yield* Effect.race(
			Effect.race(waitForSessionEnd(session), turnLimitGuard),
			waitForPromptFailure(promptPromise),
		).pipe(
			Effect.flatMap((raceResult): Effect.Effect<SessionOutcome, DreamSubagentSpawnFailed> => {
				if ("_tag" in raceResult && raceResult._tag === "prompt_failed") {
					return Effect.fail(
						new DreamSubagentSpawnFailed({
							reason: `Failed to prompt dream subagent: ${String(raceResult.error)}`,
						}),
					);
				}

				if ("_tag" in raceResult && raceResult._tag === "turn_limit_exceeded") {
					return Effect.promise(() =>
						promptPromise.catch((error) => {
							console.warn("Dream prompt promise failed after turn limit exceeded:", error);
						}),
					).pipe(
						Effect.as(raceResult),
					);
				}

				return Effect.tryPromise({
					try: async (): Promise<SessionSuccess | SessionFailure> => {
						await promptPromise;
						return raceResult;
					},
					catch: (error) =>
						new DreamSubagentSpawnFailed({
							reason: `Failed to prompt dream subagent: ${String(error)}`,
						}),
				});
			}),
			Effect.ensuring(
				Effect.sync(() => {
					unsubscribeActivity();
				}),
			),
		);

		if ("_tag" in outcome && outcome._tag === "turn_limit_exceeded") {
			return yield* new DreamSubagentSpawnFailed({
				reason: `Dream subagent exceeded maxTurns=${outcome.maxTurns}`,
			});
		}

		if ("ok" in outcome && !outcome.ok) {
			return yield* new DreamSubagentSpawnFailed({ reason: outcome.reason });
		}

		return { memoryMutations: observedMemoryMutations };
	});
}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const DreamSubagentLive = Layer.succeed(
	DreamSubagent,
	DreamSubagent.of({
		run: runImpl,
	}),
);

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export { createTurnLimitGuard as _createTurnLimitGuard };
export { isAssistantMessage as _isAssistantMessage };
