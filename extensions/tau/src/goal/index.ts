import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	Theme,
	TurnEndEvent,
} from "@mariozechner/pi-coding-agent";
import { isContextOverflow, type AssistantMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, type Component, type TUI } from "@mariozechner/pi-tui";
import { Effect, Fiber } from "effect";

import { Goal, type GoalService } from "../services/goal.js";
import { defineDecodedTool, textToolResult } from "../shared/decoded-tool.js";
import { formatDuration } from "../shared/format-duration.js";
import { formatTokenCount } from "../shared/format-tokens.js";
import { GoalConflictError, GoalValidationError } from "./errors.js";
import {
	budgetLimitPrompt,
	continuationPrompt,
	errorRecoveryPrompt,
	goalSystemPrompt,
	objectiveUpdatedPrompt,
} from "./prompts.js";
import type { GoalSnapshot, GoalStatus } from "./schema.js";

export type GoalRuntime = {
	readonly runPromise: <A, E>(effect: Effect.Effect<A, E, Goal>) => Promise<A>;
	readonly runFork: <A, E>(effect: Effect.Effect<A, E, Goal>) => Fiber.Fiber<A, E>;
};

const GOAL_CONTINUATION_MESSAGE_TYPE = "tau:goal-continuation";
const GOAL_OBJECTIVE_UPDATED_MESSAGE_TYPE = "tau:goal-objective-updated";
const GOAL_BUDGET_MESSAGE_TYPE = "tau:goal-budget-limit";
const GOAL_ERROR_RETRY_MESSAGE_TYPE = "tau:goal-error-retry";
const MAX_CONSECUTIVE_GOAL_ERRORS = 3;
const GOAL_ERROR_RETRY_BASE_DELAY_MS = 5_000;
const GOAL_ERROR_RETRY_MAX_DELAY_MS = 30_000;
const GOAL_ERROR_RETRY_JITTER_MS = 1_000;
const GOAL_ERROR_RETRY_BUSY_DELAY_MS = 1_000;

type GoalToolDetails = {
	readonly snapshot: GoalSnapshot | null;
	readonly goal: GoalSnapshot | null;
	readonly remainingTokens: number | null;
	readonly completionBudgetReport: string | null;
};

type CreateGoalParams = {
	readonly objective: string;
	readonly token_budget?: number;
};

type UpdateGoalParams = {
	readonly status: "complete" | "blocked";
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeNoParams(raw: unknown): Record<string, never> {
	if (!isRecord(raw)) {
		throw new Error("expected an object");
	}
	return {};
}

function decodeCreateGoalParams(raw: unknown): CreateGoalParams {
	if (!isRecord(raw)) {
		throw new Error("expected an object");
	}
	const objective = raw["objective"];
	if (typeof objective !== "string" || objective.trim().length === 0) {
		throw new Error("objective must be a non-empty string");
	}
	const tokenBudget = raw["token_budget"];
	if (raw["time_budget_seconds"] !== undefined) {
		throw new Error("time_budget_seconds is not supported by create_goal");
	}
	if (
		tokenBudget !== undefined &&
		(typeof tokenBudget !== "number" || !Number.isInteger(tokenBudget) || tokenBudget <= 0)
	) {
		throw new Error("token_budget must be a positive integer");
	}
	const parsedTokenBudget = typeof tokenBudget === "number" ? tokenBudget : undefined;
	if (tokenBudget === undefined) {
		return { objective };
	}
	if (parsedTokenBudget !== undefined) {
		return { objective, token_budget: parsedTokenBudget };
	}
	throw new Error("invalid goal budget");
}

function decodeUpdateGoalParams(raw: unknown): UpdateGoalParams {
	if (!isRecord(raw)) {
		throw new Error("expected an object");
	}
	if (raw["status"] !== "complete" && raw["status"] !== "blocked") {
		throw new Error('status must be "complete" or "blocked"');
	}
	return { status: raw["status"] };
}

function sessionIdFromContext(ctx: Pick<ExtensionContext, "sessionManager">): string {
	return ctx.sessionManager.getSessionId();
}

function isStaleExtensionContextError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("This extension ctx is stale after session replacement or reload");
}

function isRuntimeShutdownError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("ManagedRuntime disposed") ||
		message.includes("All fibers interrupted without error")
	);
}

function sessionIdFromContextIfLive(
	ctx: Pick<ExtensionContext, "sessionManager">,
): string | undefined {
	try {
		return sessionIdFromContext(ctx);
	} catch (error) {
		if (isStaleExtensionContextError(error)) {
			return undefined;
		}
		throw error;
	}
}

function branchFromContext(
	ctx: Pick<ExtensionContext, "sessionManager">,
): ReadonlyArray<SessionEntry> {
	return ctx.sessionManager.getBranch();
}

function describeGoal(goal: GoalSnapshot | null): string {
	if (goal === null) {
		return "No active thread goal.";
	}
	const budget =
		goal.tokenBudget === null
			? "no budget"
			: `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)} tokens`;
	const timeBudget =
		goal.timeBudgetSeconds === null
			? formatDuration(goal.timeUsedSeconds * 1_000)
			: `${formatDuration(goal.timeUsedSeconds * 1_000)}/${formatDuration(goal.timeBudgetSeconds * 1_000)}`;
	return [
		`Goal: ${goal.objective}`,
		`Status: ${goal.status}`,
		`Usage: ${budget}, ${timeBudget}`,
	].join("\n");
}

function describeGoalInline(goal: GoalSnapshot): string {
	const budget =
		goal.tokenBudget === null
			? formatTokenCount(goal.tokensUsed)
			: `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`;
	const timeBudget =
		goal.timeBudgetSeconds === null
			? formatDuration(goal.timeUsedSeconds * 1_000)
			: `${formatDuration(goal.timeUsedSeconds * 1_000)}/${formatDuration(goal.timeBudgetSeconds * 1_000)}`;
	return `goal ${goal.status} ${budget} ${timeBudget}`;
}

function shouldAutoContinue(
	goal: GoalSnapshot | null,
	ctx: ExtensionContext,
): goal is GoalSnapshot {
	return (
		goal !== null &&
		goal.status === "active" &&
		!goal.continuationSuppressed &&
		ctx.isIdle() &&
		!ctx.hasPendingMessages()
	);
}

function wasInterruptedByPi(ctx: ExtensionContext): boolean {
	return signalFromContext(ctx)?.aborted === true;
}

function signalFromContext(ctx: ExtensionContext): AbortSignal | undefined {
	if (!("signal" in ctx)) {
		return undefined;
	}
	const signalHolder = ctx as ExtensionContext & { readonly signal: unknown };
	return signalHolder.signal instanceof AbortSignal ? signalHolder.signal : undefined;
}

class GoalWidget implements Component {
	private snapshot: GoalSnapshot;

	constructor(snapshot: GoalSnapshot) {
		this.snapshot = snapshot;
	}

	setSnapshot(snapshot: GoalSnapshot): void {
		this.snapshot = snapshot;
		this.invalidate();
	}

	render(width: number): string[] {
		const goal = this.snapshot;
		const maxWidth = Math.max(0, width);
		const lines = [
			` Goal: ${goal.objective}`,
			` Status: ${goal.status}`,
			` Usage: ${formatTokenCount(goal.tokensUsed)} tokens`,
			` Time: ${formatDuration(goal.timeUsedSeconds * 1_000)}${goal.timeBudgetSeconds === null ? "" : `/${formatDuration(goal.timeBudgetSeconds * 1_000)}`}`,
		];
		return maxWidth === 0 ? lines.map(() => "") : lines.map((line) => truncateToWidth(line, maxWidth));
	}

	invalidate(): void {
		return;
	}
}

type GoalUiState = {
	mounted: boolean;
	component: GoalWidget | undefined;
	tui: TUI | undefined;
	context: ExtensionContext | undefined;
};

type GoalInterruptListener = {
	readonly signal: AbortSignal;
	readonly onAbort: () => void;
};

type GoalErrorRetryState = {
	readonly consecutiveErrors: number;
	readonly fingerprint: string;
	readonly generation: number;
	readonly errorMessage: string;
	readonly timeout: ReturnType<typeof setTimeout> | undefined;
};

function latestAssistantMessage(event: AgentEndEvent): AssistantMessage | undefined {
	let latest: AssistantMessage | undefined;
	for (const message of event.messages) {
		if (message.role === "assistant") {
			latest = message as AssistantMessage;
		}
	}
	return latest;
}

function assistantErrorMessage(message: AssistantMessage): string {
	if (typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0) {
		return message.errorMessage.trim();
	}
	const text: string[] = [];
	for (const content of message.content) {
		if (content.type === "text" && content.text.trim().length > 0) {
			text.push(content.text.trim());
		}
	}
	return text.length === 0 ? "assistant request failed" : text.join("\n");
}

function fingerprintGoalError(errorMessage: string): string {
	return errorMessage.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 500);
}

function isRetryableGoalError(errorMessage: string): boolean {
	return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i.test(
		errorMessage,
	);
}

function isRateLimitGoalError(errorMessage: string): boolean {
	return /rate.?limit|too many requests|\b429\b/i.test(errorMessage);
}

function isUsageLimitGoalError(errorMessage: string): boolean {
	return /usage.?limit|usage.?quota|quota.?exceeded|exceeded.?quota|insufficient.?quota|billing.?hard.?limit|credit.?balance|monthly.?limit|free.?quota/i.test(
		errorMessage,
	);
}

function goalErrorRetryDelayMs(consecutiveErrors: number): number {
	const exponential = Math.min(
		GOAL_ERROR_RETRY_MAX_DELAY_MS,
		GOAL_ERROR_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, consecutiveErrors - 1),
	);
	return exponential + Math.floor(Math.random() * GOAL_ERROR_RETRY_JITTER_MS);
}

function clearGoalUi(ctx: ExtensionContext, state: GoalUiState): void {
	state.mounted = false;
	state.component = undefined;
	state.tui = undefined;
	state.context = undefined;
	if (!ctx.hasUI) {
		return;
	}
	ctx.ui.setStatus("goal", undefined);
	ctx.ui.setWidget("goal", undefined);
}

function renderGoalUi(ctx: ExtensionContext, goal: GoalSnapshot | null, state: GoalUiState): void {
	if (!ctx.hasUI) {
		return;
	}
	if (goal === null || goal.status === "complete") {
		clearGoalUi(ctx, state);
		return;
	}
	ctx.ui.setStatus("goal", describeGoalInline(goal));
	if (state.mounted && state.context === ctx) {
		state.component?.setSnapshot(goal);
		state.tui?.requestRender();
		return;
	}
	ctx.ui.setWidget("goal", (tui: TUI, _theme: Theme) => {
		state.tui = tui;
		state.component = new GoalWidget(goal);
		return state.component;
	});
	state.context = ctx;
	state.mounted = true;
}

function errorText(error: unknown): string {
	if (error instanceof GoalConflictError || error instanceof GoalValidationError) {
		return error.reason;
	}
	return error instanceof Error ? error.message : String(error);
}

function goalToolResult(
	text: string,
	snapshot: GoalSnapshot | null,
	options?: { readonly isError?: boolean; readonly includeCompletionBudgetReport?: boolean },
) {
	const remainingTokens =
		snapshot?.tokenBudget === null || snapshot === null
			? null
			: Math.max(0, snapshot.tokenBudget - snapshot.tokensUsed);
	const completionBudgetReport =
		options?.includeCompletionBudgetReport === true &&
		snapshot !== null &&
		snapshot.status === "complete" &&
		(snapshot.tokenBudget !== null || snapshot.timeUsedSeconds > 0)
			? "Goal achieved. Report final usage from this tool result's structured goal fields. If `goal.tokenBudget` is present, include token usage from `goal.tokensUsed` and `goal.tokenBudget`. If `goal.timeUsedSeconds` is greater than 0, summarize elapsed time in a concise, human-friendly form appropriate to the response language."
			: null;
	return textToolResult<GoalToolDetails>(
		text,
		{ snapshot, goal: snapshot, remainingTokens, completionBudgetReport },
		options,
	);
}

function parseGoalCommand(args: string): {
	readonly command: "show" | "clear" | "pause" | "resume" | "complete" | "set";
	readonly objective?: string;
	readonly tokenBudget?: number | null;
	readonly timeBudgetSeconds?: number | null;
} {
	const trimmed = args.trim();
	if (trimmed.length === 0) {
		return { command: "show" };
	}
	const [first] = trimmed.split(/\s+/, 1);
	switch (first) {
		case "clear":
		case "pause":
		case "resume":
		case "complete":
			return { command: first };
		default:
			break;
	}

	const parts = trimmed.split(/\s+/);
	let tokenBudget: number | null = null;
	let timeBudgetSeconds: number | null = null;
	let index = 0;
	while (index < parts.length) {
		const part = parts[index];
		if (part !== "--budget" && part !== "--time-budget") {
			break;
		}
		const value = parts[index + 1];
		if (value === undefined) {
			throw new GoalConflictError({
				reason: "Usage: /goal [--budget <tokens>] [--time-budget <duration>] <objective>",
			});
		}
		if (part === "--budget") {
			const budget = Number.parseInt(value, 10);
			if (!Number.isInteger(budget) || budget <= 0 || String(budget) !== value) {
				throw new GoalConflictError({ reason: "budget must be a positive integer" });
			}
			tokenBudget = budget;
		} else {
			timeBudgetSeconds = parseTimeBudgetSeconds(value);
		}
		index += 2;
	}
	if (index > 0) {
		const objective = parts.slice(index).join(" ").trim();
		if (objective.length === 0) {
			throw new GoalConflictError({ reason: "objective must be non-empty" });
		}
		return { command: "set", objective, tokenBudget, timeBudgetSeconds };
	}

	return { command: "set", objective: trimmed, tokenBudget: null, timeBudgetSeconds: null };
}

function parseTimeBudgetSeconds(input: string): number {
	const match = /^(\d+)([smh]?)$/.exec(input);
	if (match === null) {
		throw new GoalConflictError({ reason: "time budget must be a positive duration like 300, 5m, or 1h" });
	}
	const amountText = match[1];
	const unit = match[2];
	if (amountText === undefined || unit === undefined) {
		throw new GoalConflictError({
			reason: "time budget must be a positive duration like 300, 5m, or 1h",
		});
	}
	const amount = Number.parseInt(amountText, 10);
	if (!Number.isInteger(amount) || amount <= 0 || String(amount) !== amountText) {
		throw new GoalConflictError({
			reason: "time budget must be a positive duration like 300, 5m, or 1h",
		});
	}
	if (unit === "h") {
		return amount * 3_600;
	}
	if (unit === "m") {
		return amount * 60;
	}
	return amount;
}

async function withGoal<A>(
	runtime: GoalRuntime,
	effect: (goal: GoalService) => Effect.Effect<A, unknown, never>,
): Promise<A> {
	return runtime.runPromise(
		Effect.gen(function* () {
			const goal = yield* Goal;
			return yield* effect(goal);
		}),
	);
}

async function rehydrateAndUpdate(
	runtime: GoalRuntime,
	ctx: ExtensionContext,
	uiState: GoalUiState,
): Promise<GoalSnapshot | null> {
	const snapshot = await withGoal(runtime, (goal) =>
		goal.rehydrate(sessionIdFromContext(ctx), branchFromContext(ctx)),
	);
	renderGoalUi(ctx, snapshot, uiState);
	return snapshot;
}

async function dispatchGoalContinuation(
	pi: ExtensionAPI,
	runtime: GoalRuntime,
	ctx: ExtensionContext,
	snapshot: GoalSnapshot | null,
): Promise<void> {
	if (!shouldAutoContinue(snapshot, ctx)) {
		return;
	}
	await withGoal(runtime, (goal) => goal.markContinuationDispatched(sessionIdFromContext(ctx)));
	pi.sendMessage(
		{
			customType: GOAL_CONTINUATION_MESSAGE_TYPE,
			content: continuationPrompt(snapshot),
			display: false,
			details: { objective: snapshot.objective },
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

async function dispatchGoalObjectiveUpdated(
	pi: ExtensionAPI,
	runtime: GoalRuntime,
	ctx: ExtensionContext,
	snapshot: GoalSnapshot | null,
): Promise<void> {
	if (snapshot === null || snapshot.status !== "active") {
		return;
	}
	if (ctx.isIdle()) {
		await dispatchGoalContinuation(pi, runtime, ctx, snapshot);
		return;
	}
	pi.sendMessage(
		{
			customType: GOAL_OBJECTIVE_UPDATED_MESSAGE_TYPE,
			content: objectiveUpdatedPrompt(snapshot),
			display: false,
			details: { objective: snapshot.objective },
		},
		{ deliverAs: "steer" },
	);
}

async function dispatchGoalBudgetLimit(
	pi: ExtensionAPI,
	runtime: GoalRuntime,
	ctx: ExtensionContext,
	snapshot: GoalSnapshot,
	options: { readonly activeTurn: boolean },
): Promise<void> {
	await withGoal(runtime, (goal) => goal.markBudgetLimitPromptSent(sessionIdFromContext(ctx)));
	pi.sendMessage(
		{
			customType: GOAL_BUDGET_MESSAGE_TYPE,
			content: budgetLimitPrompt(snapshot),
			display: false,
			details: { objective: snapshot.objective },
		},
		options.activeTurn ? { deliverAs: "steer" } : { triggerTurn: true, deliverAs: "followUp" },
	);
}

export default function initGoal(pi: ExtensionAPI, runtime: GoalRuntime): void {
	let tickerFiber: Fiber.Fiber<void, never> | undefined;
	let tickerCtx: ExtensionContext | undefined;
	const interruptedSessions = new Set<string>();
	const interruptListeners = new Map<string, GoalInterruptListener>();
	const errorRetryStates = new Map<string, GoalErrorRetryState>();
	const goalUiState: GoalUiState = {
		mounted: false,
		component: undefined,
		tui: undefined,
		context: undefined,
	};

	const stopGoalTicker = (): void => {
		if (tickerFiber !== undefined) {
			const fiber = tickerFiber;
			tickerFiber = undefined;
			void runtime.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid));
		}
		tickerCtx = undefined;
	};

	const clearGoalErrorRetry = (sessionId: string): void => {
		const state = errorRetryStates.get(sessionId);
		if (state?.timeout !== undefined) {
			clearTimeout(state.timeout);
		}
		errorRetryStates.delete(sessionId);
	};

	const clearAllGoalErrorRetries = (): void => {
		for (const sessionId of errorRetryStates.keys()) {
			clearGoalErrorRetry(sessionId);
		}
	};

	const currentGoalErrorRetry = (
		sessionId: string,
		generation: number,
	): GoalErrorRetryState | undefined => {
		const state = errorRetryStates.get(sessionId);
		return state?.generation === generation ? state : undefined;
	};

	const pauseGoalFromInterrupt = async (ctx: ExtensionContext): Promise<void> => {
		const sessionId = sessionIdFromContext(ctx);
		await withGoal(runtime, (goal) => goal.setStatus(sessionId, "paused"));
		await updateGoalUi(ctx);
	};

	const clearGoalInterruptListener = (sessionId: string): void => {
		const listener = interruptListeners.get(sessionId);
		if (listener === undefined) {
			return;
		}
		listener.signal.removeEventListener("abort", listener.onAbort);
		interruptListeners.delete(sessionId);
	};

	const clearAllGoalInterruptListeners = (): void => {
		for (const sessionId of interruptListeners.keys()) {
			clearGoalInterruptListener(sessionId);
		}
		interruptedSessions.clear();
	};

	const observeGoalInterrupt = (ctx: ExtensionContext): void => {
		const signal = signalFromContext(ctx);
		if (signal === undefined) {
			return;
		}
		const sessionId = sessionIdFromContext(ctx);
		const current = interruptListeners.get(sessionId);
		if (current?.signal === signal) {
			return;
		}
		clearGoalInterruptListener(sessionId);
		const onAbort = (): void => {
			interruptedSessions.add(sessionId);
			void pauseGoalFromInterrupt(ctx);
		};
		interruptListeners.set(sessionId, { signal, onAbort });
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
	};

	const updateGoalUi = async (ctx: ExtensionContext): Promise<GoalSnapshot | null> => {
		const snapshot = await withGoal(runtime, (goal) =>
			goal.liveSnapshot(sessionIdFromContext(ctx), Date.now()),
		);
		renderGoalUi(ctx, snapshot, goalUiState);
		if (snapshot?.status === "active" || snapshot?.status === "budget_limited") {
			startGoalTicker(ctx);
		} else {
			stopGoalTicker();
		}
		return snapshot;
	};

	const pauseGoalFromError = async (
		ctx: ExtensionContext,
		errorMessage: string,
		reason: string,
	): Promise<void> => {
		const sessionId = sessionIdFromContext(ctx);
		clearGoalErrorRetry(sessionId);
		await withGoal(runtime, (goal) => goal.setStatus(sessionId, "paused"));
		await updateGoalUi(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(`${reason}\nLast error: ${errorMessage}`, "warning");
		}
	};

	const usageLimitGoalFromError = async (
		ctx: ExtensionContext,
		message: AssistantMessage,
		errorMessage: string,
	): Promise<void> => {
		const sessionId = sessionIdFromContext(ctx);
		clearGoalErrorRetry(sessionId);
		await withGoal(runtime, (goal) =>
			goal.markUsageLimited(sessionId, message, Date.now()),
		);
		await updateGoalUi(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(
				"Goal usage limited because the assistant request hit an account or quota limit.\nLast error: " +
					errorMessage,
				"warning",
			);
		}
	};

	const dispatchGoalErrorRetry = async (
		ctx: ExtensionContext,
		generation: number,
		attempt: number,
	): Promise<void> => {
		const sessionId = sessionIdFromContext(ctx);
		const state = currentGoalErrorRetry(sessionId, generation);
		if (state === undefined) {
			return;
		}
		const snapshot = await withGoal(runtime, (goal) => goal.get(sessionId));
		const current = currentGoalErrorRetry(sessionId, generation);
		if (current === undefined) {
			return;
		}
		if (
			snapshot === null ||
			snapshot.status !== "active" ||
			ctx.hasPendingMessages()
		) {
			clearGoalErrorRetry(sessionId);
			return;
		}
		if (!ctx.isIdle()) {
			const timeout = setTimeout(() => {
				void dispatchGoalErrorRetry(ctx, generation, attempt);
			}, GOAL_ERROR_RETRY_BUSY_DELAY_MS);
			errorRetryStates.set(sessionId, { ...current, timeout });
			return;
		}
		const ready = currentGoalErrorRetry(sessionId, generation);
		if (ready === undefined) {
			return;
		}
		errorRetryStates.set(sessionId, { ...ready, timeout: undefined });
		pi.sendMessage(
			{
				customType: GOAL_ERROR_RETRY_MESSAGE_TYPE,
				content: errorRecoveryPrompt(
					snapshot,
					ready.errorMessage,
					attempt,
					MAX_CONSECUTIVE_GOAL_ERRORS - 1,
				),
				display: false,
					details: {
					objective: snapshot.objective,
					error: ready.errorMessage,
					attempt,
				},
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		await withGoal(runtime, (goal) => goal.markContinuationDispatched(sessionId));
	};

	const handleGoalAssistantError = async (
		ctx: ExtensionContext,
		snapshot: GoalSnapshot | null,
		message: AssistantMessage,
	): Promise<void> => {
		const sessionId = sessionIdFromContext(ctx);
		const errorMessage = assistantErrorMessage(message);
		if (snapshot?.status !== "active" && snapshot?.status !== "budget_limited") {
			clearGoalErrorRetry(sessionId);
			return;
		}
		if (isUsageLimitGoalError(errorMessage)) {
			await usageLimitGoalFromError(ctx, message, errorMessage);
			return;
		}
		if (snapshot.status === "budget_limited") {
			clearGoalErrorRetry(sessionId);
			return;
		}
		const retryable = isRetryableGoalError(errorMessage);
		if (isContextOverflow(message) && !isRateLimitGoalError(errorMessage)) {
			clearGoalErrorRetry(sessionId);
			return;
		}
		if (!retryable) {
			await pauseGoalFromError(
				ctx,
				errorMessage,
				"Paused goal because the assistant request failed with a non-retryable error.",
			);
			return;
		}

		const fingerprint = fingerprintGoalError(errorMessage);
		const previous = errorRetryStates.get(sessionId);
		if (previous?.timeout !== undefined) {
			clearTimeout(previous.timeout);
		}
		const consecutiveErrors = previous === undefined ? 1 : previous.consecutiveErrors + 1;
		const generation = (previous?.generation ?? 0) + 1;
		if (consecutiveErrors >= MAX_CONSECUTIVE_GOAL_ERRORS) {
			await pauseGoalFromError(
				ctx,
				errorMessage,
				`Paused goal after ${MAX_CONSECUTIVE_GOAL_ERRORS} consecutive errors to avoid an automatic retry loop.`,
			);
			return;
		}

		const attempt = consecutiveErrors;
		const timeout = setTimeout(() => {
			void dispatchGoalErrorRetry(ctx, generation, attempt);
		}, goalErrorRetryDelayMs(consecutiveErrors));
		errorRetryStates.set(sessionId, {
			consecutiveErrors,
			fingerprint,
			generation,
			errorMessage,
			timeout,
		});
	};

	const startGoalTicker = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) {
			return;
		}
		tickerCtx = ctx;
		if (tickerFiber !== undefined) {
			return;
		}
		tickerFiber = runtime.runFork(
			Effect.gen(function* () {
				while (true) {
					yield* Effect.sleep("1 second");
					const ctx = tickerCtx;
					if (ctx !== undefined) {
						yield* Effect.promise(() => updateGoalUi(ctx)).pipe(
							Effect.tapError((error) => Effect.logWarning("Goal UI update failed", error)),
							Effect.catch(() => Effect.void),
						);
					}
				}
			}),
		);
	};

	pi.registerTool(
		defineDecodedTool({
			name: "get_goal",
			label: "get goal",
			description: "Get the current thread goal, including status, budgets, and usage.",
			parameters: Type.Object({}),
			decodeParams: decodeNoParams,
			formatInvalidParamsResult: (message) =>
				goalToolResult(message, null, { isError: true }),
			execute: async (_params, { ctx }) => {
				const snapshot = await withGoal(runtime, (goal) =>
					goal.get(sessionIdFromContext(ctx)),
				);
				return goalToolResult(describeGoal(snapshot), snapshot);
			},
			renderCall: (_args, theme) =>
				new Text(theme.fg("toolTitle", theme.bold("get_goal")), 0, 0),
			renderResult: (result, _options, theme) => {
				const item = result.content[0];
				const text = item?.type === "text" ? item.text : "";
				return new Text(theme.fg("muted", text), 0, 0);
			},
		}),
	);

	pi.registerTool(
		defineDecodedTool({
			name: "create_goal",
			label: "create goal",
			description:
				"Create a thread goal. Use only when the user explicitly asks to start or track a goal. Fails if a goal already exists.",
			promptGuidelines: [
				"Use create_goal only when the user explicitly requests a thread goal.",
				"Do not replace an existing goal with create_goal; report the existing goal instead.",
			],
			parameters: Type.Object({
				objective: Type.String({ description: "Concrete objective for this thread." }),
				token_budget: Type.Optional(
					Type.Integer({ description: "Optional positive token budget.", minimum: 1 }),
				),
			}),
			decodeParams: decodeCreateGoalParams,
			formatInvalidParamsResult: (message) =>
				goalToolResult(message, null, { isError: true }),
			formatExecuteErrorResult: (error) =>
				goalToolResult(errorText(error), null, { isError: true }),
			execute: async (params, { ctx }) => {
				const snapshot = await withGoal(runtime, (goal) =>
					goal.create(
						sessionIdFromContext(ctx),
						params.objective,
						params.token_budget ?? null,
						null,
						{
							failIfExists: true,
							accountFromNextTurn: true,
						},
					),
				);
				await updateGoalUi(ctx);
				return goalToolResult(`Created thread goal.\n${describeGoal(snapshot)}`, snapshot);
			},
			renderCall: (_args, theme) =>
				new Text(theme.fg("toolTitle", theme.bold("create_goal")), 0, 0),
			renderResult: (result, _options, theme) => {
				const item = result.content[0];
				const text = item?.type === "text" ? item.text : "";
				return new Text(theme.fg("muted", text), 0, 0);
			},
		}),
	);

	pi.registerTool(
		defineDecodedTool({
			name: "update_goal",
			label: "update goal",
			description:
				"Update the current thread goal. Use only to mark the goal complete or blocked.",
			promptGuidelines: [
				"Call update_goal with status complete only when the objective is actually achieved.",
				"Call update_goal with status blocked only when the strict blocked audit is satisfied.",
				"Do not use update_goal to pause, resume, clear, or budget-limit a goal.",
			],
			parameters: Type.Object({
				status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
			}),
			decodeParams: decodeUpdateGoalParams,
			formatInvalidParamsResult: (message) =>
				goalToolResult(message, null, { isError: true }),
			formatExecuteErrorResult: (error) =>
				goalToolResult(errorText(error), null, { isError: true }),
			execute: async (params, { ctx }) => {
				const snapshot = await withGoal(runtime, (goal) =>
					goal.setStatus(sessionIdFromContext(ctx), params.status, {
						accountCurrentTurn: true,
					}),
				);
				if (snapshot === null) {
					return goalToolResult("No thread goal is set.", snapshot, { isError: true });
				}
				await updateGoalUi(ctx);
				if (params.status === "blocked") {
					return goalToolResult("Goal blocked.", snapshot);
				}
				return goalToolResult(
					`Goal complete. Final usage: ${formatTokenCount(snapshot.tokensUsed)} tokens, ${formatDuration(snapshot.timeUsedSeconds * 1_000)}.`,
					snapshot,
					{ includeCompletionBudgetReport: true },
				);
			},
			renderCall: (_args, theme) =>
				new Text(theme.fg("toolTitle", theme.bold("update_goal")), 0, 0),
			renderResult: (result, _options, theme) => {
				const item = result.content[0];
				const text = item?.type === "text" ? item.text : "";
				return new Text(theme.fg("muted", text), 0, 0);
			},
		}),
	);

	pi.registerCommand("goal", {
		description: "View or manage the current thread goal",
		handler: async (args, ctx) => {
			try {
				const parsed = parseGoalCommand(args);
				const sessionId = sessionIdFromContext(ctx);
				if (parsed.command === "show") {
					const snapshot = await rehydrateAndUpdate(runtime, ctx, goalUiState);
					ctx.ui.notify(describeGoal(snapshot), "info");
					return;
				}
				if (parsed.command === "clear") {
					await withGoal(runtime, (goal) =>
						goal.prepareExternalMutation(sessionId, Date.now()),
					);
					await withGoal(runtime, (goal) => goal.clear(sessionId));
					clearGoalUi(ctx, goalUiState);
					stopGoalTicker();
					ctx.ui.notify("Cleared thread goal.", "info");
					return;
				}
				if (
					parsed.command === "pause" ||
					parsed.command === "resume" ||
					parsed.command === "complete"
				) {
					const nowMs = Date.now();
					const status: GoalStatus =
						parsed.command === "resume"
							? "active"
							: parsed.command === "pause"
								? "paused"
								: "complete";
					await withGoal(runtime, (goal) =>
						goal.prepareExternalMutation(sessionId, nowMs),
					);
					const snapshot = await withGoal(runtime, (goal) =>
						goal.setStatus(sessionId, status, {
							...(status === "active" && !ctx.isIdle()
								? { startActiveAccountingAtMs: nowMs }
								: {}),
						}),
					);
					await updateGoalUi(ctx);
					ctx.ui.notify(describeGoal(snapshot), "info");
					if (status === "active") {
						await dispatchGoalContinuation(pi, runtime, ctx, snapshot);
					}
					return;
				}

				const objective = parsed.objective ?? "";
				const existing = await withGoal(runtime, (goal) => goal.get(sessionId));
				const replacesActiveGoal = existing !== null && existing.status !== "complete";
				if (replacesActiveGoal) {
					const confirmed = await ctx.ui.confirm(
						"Replace thread goal?",
						`Current: ${existing.objective}\n\nNew: ${objective}`,
					);
					if (!confirmed) {
						return;
					}
				}
				const nowMs = Date.now();
				await withGoal(runtime, (goal) =>
					goal.prepareExternalMutation(sessionId, nowMs),
				);
				const snapshot = await withGoal(runtime, (goal) =>
					goal.create(
						sessionId,
						objective,
						parsed.tokenBudget ?? null,
						parsed.timeBudgetSeconds ?? null,
						ctx.isIdle() ? undefined : { startActiveAccountingAtMs: nowMs },
					),
				);
				await updateGoalUi(ctx);
				ctx.ui.notify(`Set thread goal.\n${describeGoal(snapshot)}`, "info");
				if (replacesActiveGoal) {
					await dispatchGoalObjectiveUpdated(pi, runtime, ctx, snapshot);
				} else {
					await dispatchGoalContinuation(pi, runtime, ctx, snapshot);
				}
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
			}
		},
	});

	const onSessionReady = async (_event: unknown, ctx: ExtensionContext) => {
		try {
			clearAllGoalErrorRetries();
			await rehydrateAndUpdate(runtime, ctx, goalUiState);
			await withGoal(runtime, (goal) =>
				goal.restoreAfterResume(sessionIdFromContext(ctx), Date.now()),
			);
			await updateGoalUi(ctx);
		} catch (error) {
			ctx.ui.notify(errorText(error), "error");
		}
	};

	pi.on("session_start", onSessionReady);
	pi.on("session_switch", onSessionReady);
	pi.on("session_fork", onSessionReady);
	pi.on("session_tree", onSessionReady);

	pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
		const snapshot = await withGoal(runtime, (goal) =>
			goal
				.markAgentStart(sessionIdFromContext(ctx), Date.now())
				.pipe(Effect.andThen(goal.get(sessionIdFromContext(ctx)))),
		);
		await updateGoalUi(ctx);
		if (snapshot?.status !== "active" && snapshot?.status !== "budget_limited") {
			return;
		}
		observeGoalInterrupt(ctx);
		return {
			systemPrompt: `${event.systemPrompt}\n\n${goalSystemPrompt(snapshot)}`,
		};
	});

	pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
		const sessionId = sessionIdFromContext(ctx);
		const result = await withGoal(runtime, (goal) =>
			goal.accountTurnEnd(sessionId, event.message, Date.now()),
		);
		if (wasInterruptedByPi(ctx) || interruptedSessions.has(sessionId)) {
			await withGoal(runtime, (goal) => goal.setStatus(sessionId, "paused"));
			await updateGoalUi(ctx);
			return;
		}
		await updateGoalUi(ctx);
		if (result.budgetLimitReached && result.snapshot !== null) {
			await dispatchGoalBudgetLimit(pi, runtime, ctx, result.snapshot, {
				activeTurn: !ctx.isIdle(),
			});
		}
	});

	pi.on("agent_end", async (event: AgentEndEvent, ctx) => {
		try {
			const sessionId = sessionIdFromContextIfLive(ctx);
			if (sessionId === undefined) {
				return;
			}
			const result = await withGoal(runtime, (goal) =>
				goal.accountAgentEnd(sessionId, event, Date.now()),
			);
			const latestAssistant = latestAssistantMessage(event);
			const interrupted = wasInterruptedByPi(ctx) || interruptedSessions.has(sessionId);
			clearGoalInterruptListener(sessionId);
			interruptedSessions.delete(sessionId);
			if (interrupted) {
				clearGoalErrorRetry(sessionId);
				await withGoal(runtime, (goal) => goal.setStatus(sessionId, "paused"));
				await updateGoalUi(ctx);
				return;
			}
			await updateGoalUi(ctx);

			if (latestAssistant?.stopReason === "error") {
				await handleGoalAssistantError(ctx, result.snapshot, latestAssistant);
				return;
			}
			clearGoalErrorRetry(sessionId);

			if (result.budgetLimitReached && result.snapshot !== null) {
				await dispatchGoalBudgetLimit(pi, runtime, ctx, result.snapshot, {
					activeTurn: false,
				});
				return;
			}

			if (!shouldAutoContinue(result.snapshot, ctx)) {
				return;
			}
			await dispatchGoalContinuation(pi, runtime, ctx, result.snapshot);
		} catch (error) {
			if (isRuntimeShutdownError(error) || isStaleExtensionContextError(error)) {
				return;
			}
			throw error;
		}
	});

	pi.on("session_shutdown", () => {
		stopGoalTicker();
		clearAllGoalInterruptListeners();
		clearAllGoalErrorRetries();
	});
}
