import type { AgentEndEvent } from "@mariozechner/pi-coding-agent";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Context, Effect, Layer, Ref } from "effect";

import { PiAPI } from "../effect/pi.js";
import { GoalConflictError, type GoalError } from "../goal/errors.js";
import {
	GOAL_ENTRY_TYPE,
	goalFromBranch,
	makeGoalSnapshot,
	type GoalSnapshot,
	type GoalStatus,
} from "../goal/schema.js";

type GoalRuntime = {
	readonly snapshot: GoalSnapshot | null;
	readonly activeTurnStartedAtMs: number | null;
	readonly continuationInFlight: boolean;
	readonly terminalTurnAccountingPending: boolean;
	readonly skipNextTurnAccounting: boolean;
};

type GoalAgentEndResult = {
	readonly snapshot: GoalSnapshot | null;
	readonly budgetLimitReached: boolean;
};

export interface GoalService {
	readonly rehydrate: (
		sessionId: string,
		entries: ReadonlyArray<SessionEntry>,
	) => Effect.Effect<GoalSnapshot | null, GoalError, never>;
	readonly get: (sessionId: string) => Effect.Effect<GoalSnapshot | null, never, never>;
	readonly liveSnapshot: (
		sessionId: string,
		nowMs: number,
	) => Effect.Effect<GoalSnapshot | null, never, never>;
	readonly create: (
		sessionId: string,
		objective: string,
		tokenBudget: number | null,
		timeBudgetSeconds?: number | null,
		options?: {
			readonly failIfExists?: boolean;
			readonly accountFromNextTurn?: boolean;
			readonly startActiveAccountingAtMs?: number;
		},
	) => Effect.Effect<GoalSnapshot, GoalError, never>;
	readonly setStatus: (
		sessionId: string,
		status: GoalStatus,
		options?: {
			readonly accountCurrentTurn?: boolean;
			readonly startActiveAccountingAtMs?: number;
		},
	) => Effect.Effect<GoalSnapshot | null, GoalError, never>;
	readonly prepareExternalMutation: (
		sessionId: string,
		nowMs: number,
	) => Effect.Effect<GoalAgentEndResult, never, never>;
	readonly markUsageLimited: (
		sessionId: string,
		message: AgentMessage,
		nowMs: number,
	) => Effect.Effect<GoalSnapshot | null, GoalError, never>;
	readonly restoreAfterResume: (
		sessionId: string,
		nowMs: number,
	) => Effect.Effect<GoalSnapshot | null, never, never>;
	readonly clear: (sessionId: string) => Effect.Effect<void, never, never>;
	readonly markAgentStart: (
		sessionId: string,
		nowMs: number,
	) => Effect.Effect<void, never, never>;
	readonly accountAgentEnd: (
		sessionId: string,
		event: AgentEndEvent,
		nowMs: number,
	) => Effect.Effect<GoalAgentEndResult, never, never>;
	readonly accountTurnEnd: (
		sessionId: string,
		message: AgentMessage,
		nowMs: number,
	) => Effect.Effect<GoalAgentEndResult, never, never>;
	readonly markContinuationDispatched: (
		sessionId: string,
	) => Effect.Effect<GoalSnapshot | null, never, never>;
	readonly markBudgetLimitPromptSent: (
		sessionId: string,
	) => Effect.Effect<GoalSnapshot | null, never, never>;
	readonly clearContinuationSuppression: (
		sessionId: string,
	) => Effect.Effect<GoalSnapshot | null, never, never>;
}

export class Goal extends Context.Service<Goal, GoalService>()("Goal") {}

const emptyRuntime: GoalRuntime = {
	snapshot: null,
	activeTurnStartedAtMs: null,
	continuationInFlight: false,
	terminalTurnAccountingPending: false,
	skipNextTurnAccounting: false,
};

function runtimeWithSnapshot(snapshot: GoalSnapshot | null): GoalRuntime {
	return {
		snapshot,
		activeTurnStartedAtMs: null,
		continuationInFlight: false,
		terminalTurnAccountingPending: false,
		skipNextTurnAccounting: false,
	};
}

function appendSnapshot(
	pi: { appendEntry: (customType: string, data?: unknown) => void },
	snapshot: GoalSnapshot | null,
): void {
	pi.appendEntry(GOAL_ENTRY_TYPE, {
		version: 2,
		snapshot,
	});
}

function withRuntime(
	runtimes: Map<string, GoalRuntime>,
	sessionId: string,
	update: (runtime: GoalRuntime) => GoalRuntime,
): Map<string, GoalRuntime> {
	const current = runtimes.get(sessionId) ?? emptyRuntime;
	const next = update(current);
	const copy = new Map(runtimes);
	copy.set(sessionId, next);
	return copy;
}

function normalizeObjective(objective: string): string {
	return objective.replace(/\s+/g, " ").trim();
}

function validateTokenBudget(
	tokenBudget: number | null,
): Effect.Effect<number | null, GoalConflictError, never> {
	if (tokenBudget === null) {
		return Effect.succeed(null);
	}
	if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
		return Effect.fail(
			new GoalConflictError({ reason: "token_budget must be a positive integer" }),
		);
	}
	return Effect.succeed(tokenBudget);
}

function validateTimeBudgetSeconds(
	timeBudgetSeconds: number | null,
): Effect.Effect<number | null, GoalConflictError, never> {
	if (timeBudgetSeconds === null) {
		return Effect.succeed(null);
	}
	if (!Number.isInteger(timeBudgetSeconds) || timeBudgetSeconds <= 0) {
		return Effect.fail(
			new GoalConflictError({ reason: "time_budget_seconds must be a positive integer" }),
		);
	}
	return Effect.succeed(timeBudgetSeconds);
}

function assistantUsageTokens(message: AgentMessage): number {
	if (message.role !== "assistant") {
		return 0;
	}
	const { usage } = message;
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function assistantMessageUsageTokens(message: AgentMessage): number {
	if (message.role === "assistant" && message.stopReason === "error") {
		return 0;
	}
	return assistantUsageTokens(message);
}

function hasAssistantToolCall(event: AgentEndEvent): boolean {
	for (const message of event.messages) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const content of message.content) {
			if (content.type === "toolCall") {
				return true;
			}
		}
	}
	return false;
}

function hasAssistantError(event: AgentEndEvent): boolean {
	for (const message of event.messages) {
		if (message.role === "assistant" && message.stopReason === "error") {
			return true;
		}
	}
	return false;
}

function runtimeCanAccountActiveTurn(runtime: GoalRuntime): boolean {
	const status = runtime.snapshot?.status;
	return (
		status === "active" ||
		status === "budget_limited" ||
		((status === "complete" || status === "blocked") &&
			runtime.terminalTurnAccountingPending)
	);
}

function statusStopsActiveTurn(status: GoalStatus): boolean {
	return status === "complete" || status === "blocked";
}

function elapsedSeconds(runtime: GoalRuntime, nowMs: number): number {
	if (runtime.activeTurnStartedAtMs === null) {
		return 0;
	}
	return Math.max(0, Math.floor((nowMs - runtime.activeTurnStartedAtMs) / 1_000));
}

function liveRuntimeSnapshot(runtime: GoalRuntime, nowMs: number): GoalSnapshot | null {
	if (runtime.snapshot === null) {
		return null;
	}
	if (runtime.snapshot.status !== "active" && runtime.snapshot.status !== "budget_limited") {
		return runtime.snapshot;
	}
	return {
		...runtime.snapshot,
		timeUsedSeconds: runtime.snapshot.timeUsedSeconds + elapsedSeconds(runtime, nowMs),
	};
}

function withUpdatedSnapshot(
	snapshot: GoalSnapshot,
	nowIso: string,
	patch: Partial<GoalSnapshot>,
): GoalSnapshot {
	return {
		...snapshot,
		...patch,
		updatedAt: nowIso,
	};
}

export const GoalLive = Layer.effect(
	Goal,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const runtimes = yield* Ref.make(new Map<string, GoalRuntime>());

		const saveSnapshot = (snapshot: GoalSnapshot | null): Effect.Effect<void, never, never> =>
			Effect.sync(() => appendSnapshot(pi, snapshot));

		const rehydrate: GoalService["rehydrate"] = Effect.fn("Goal.rehydrate")(
			function* (sessionId, entries) {
				const snapshot = yield* goalFromBranch(entries);
				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, () => runtimeWithSnapshot(snapshot)),
				);
				return snapshot;
			},
		);

		const get: GoalService["get"] = (sessionId) =>
			Ref.get(runtimes).pipe(Effect.map((state) => state.get(sessionId)?.snapshot ?? null));

		const liveSnapshot: GoalService["liveSnapshot"] = (sessionId, nowMs) =>
			Ref.get(runtimes).pipe(
				Effect.map((state) =>
					liveRuntimeSnapshot(state.get(sessionId) ?? emptyRuntime, nowMs),
				),
			);

		const create: GoalService["create"] = Effect.fn("Goal.create")(
			function* (sessionId, objectiveInput, tokenBudgetInput, timeBudgetSecondsInput, options) {
				const objective = normalizeObjective(objectiveInput);
				if (objective.length === 0) {
					return yield* Effect.fail(
						new GoalConflictError({ reason: "objective must be non-empty" }),
					);
				}
				if (objective.length > 4_000) {
					return yield* Effect.fail(
						new GoalConflictError({
							reason: "objective must be at most 4000 characters",
						}),
					);
				}
				const tokenBudget = yield* validateTokenBudget(tokenBudgetInput);
				const timeBudgetSeconds = yield* validateTimeBudgetSeconds(
					timeBudgetSecondsInput ?? null,
				);
				const nowIso = new Date().toISOString();
				const snapshot = makeGoalSnapshot(objective, tokenBudget, timeBudgetSeconds, nowIso);
				const failIfExists = options?.failIfExists === true;
				const existing = yield* get(sessionId);
				if (failIfExists && existing !== null) {
					return yield* Effect.fail(
						new GoalConflictError({
							reason:
								"cannot create a new goal because this thread already has a goal; use update_goal only for status",
						}),
					);
				}
				if (
					existing !== null &&
					existing.objective === objective &&
					existing.status !== "complete"
				) {
					const unchangedActiveGoal =
						existing.status === "active" &&
						existing.tokenBudget === tokenBudget &&
						existing.timeBudgetSeconds === timeBudgetSeconds &&
						existing.continuationSuppressed === false &&
						existing.budgetLimitPromptSent === false;
					const nextSnapshot = unchangedActiveGoal
						? existing
						: withUpdatedSnapshot(existing, nowIso, {
								status: "active",
								tokenBudget,
								timeBudgetSeconds,
								continuationSuppressed: false,
								budgetLimitPromptSent: false,
							});
					yield* Ref.update(runtimes, (state) =>
						withRuntime(state, sessionId, () => ({
							...runtimeWithSnapshot(nextSnapshot),
							activeTurnStartedAtMs: options?.startActiveAccountingAtMs ?? null,
							skipNextTurnAccounting: options?.accountFromNextTurn === true,
						})),
					);
					if (!unchangedActiveGoal) {
						yield* saveSnapshot(nextSnapshot);
					}
					return nextSnapshot;
				}
				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, () => ({
						...runtimeWithSnapshot(snapshot),
						activeTurnStartedAtMs: options?.startActiveAccountingAtMs ?? null,
						skipNextTurnAccounting: options?.accountFromNextTurn === true,
					})),
				);
				yield* saveSnapshot(snapshot);
				return snapshot;
			},
		);

		const setStatus: GoalService["setStatus"] = Effect.fn("Goal.setStatus")(
			function* (sessionId, status, options) {
				const existing = yield* get(sessionId);
				if (existing?.status === "complete") {
					if (status === "complete") {
						return existing;
					}
					return yield* Effect.fail(
						new GoalConflictError({ reason: "Thread goal is already complete." }),
					);
				}
				const nowIso = new Date().toISOString();
				let nextSnapshot: GoalSnapshot | null = null;
				let shouldPersist = false;
				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, (runtime) => {
						if (runtime.snapshot === null) {
							return runtime;
						}
						const unchangedActiveStatus =
							status === "active" &&
							runtime.snapshot.status === "active" &&
							runtime.snapshot.continuationSuppressed === false &&
							runtime.snapshot.budgetLimitPromptSent === false;
						if (
							unchangedActiveStatus ||
							(runtime.snapshot.status === status &&
								status !== "active" &&
								status !== "complete")
						) {
							const terminalTurnAccountingPending =
								status === "active"
									? false
									: status === "blocked" && options?.accountCurrentTurn === true
										? true
										: runtime.terminalTurnAccountingPending;
							nextSnapshot = runtime.snapshot;
							return {
								...runtime,
								activeTurnStartedAtMs:
									status === "active"
										? (options?.startActiveAccountingAtMs ?? runtime.activeTurnStartedAtMs)
										: runtime.activeTurnStartedAtMs,
								continuationInFlight:
									status === "active" ? false : runtime.continuationInFlight,
								terminalTurnAccountingPending,
							};
						}
						const patch: Partial<GoalSnapshot> = {
							status,
							...(status === "active"
								? { continuationSuppressed: false, budgetLimitPromptSent: false }
								: {}),
						};
						nextSnapshot = withUpdatedSnapshot(runtime.snapshot, nowIso, patch);
						shouldPersist = true;
						return {
							...runtime,
							snapshot: nextSnapshot,
							activeTurnStartedAtMs:
								status === "active"
									? (options?.startActiveAccountingAtMs ?? runtime.activeTurnStartedAtMs)
									: runtime.activeTurnStartedAtMs,
							continuationInFlight: false,
							terminalTurnAccountingPending:
								(status === "complete" || status === "blocked") &&
								options?.accountCurrentTurn === true,
						};
					}),
				);
				if (shouldPersist) {
					yield* saveSnapshot(nextSnapshot);
				}
				return nextSnapshot;
			},
		);

		const clear: GoalService["clear"] = (sessionId) =>
			Effect.gen(function* () {
				let shouldPersist = false;
				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, (runtime) => {
						shouldPersist = runtime.snapshot !== null;
						return runtimeWithSnapshot(null);
					}),
				);
				if (shouldPersist) {
					yield* saveSnapshot(null);
				}
			});

		const restoreAfterResume: GoalService["restoreAfterResume"] = (sessionId, nowMs) =>
			Ref.modify(runtimes, (state) => {
				let snapshot: GoalSnapshot | null = null;
				const next = withRuntime(state, sessionId, (runtime) => {
					snapshot = runtime.snapshot;
					if (runtime.snapshot?.status !== "active") {
						return { ...runtime, activeTurnStartedAtMs: null };
					}
					return {
						...runtime,
						activeTurnStartedAtMs: runtime.activeTurnStartedAtMs ?? nowMs,
					};
				});
				return [snapshot, next];
			});

		const markAgentStart: GoalService["markAgentStart"] = (sessionId, nowMs) =>
			Ref.update(runtimes, (state) =>
				withRuntime(state, sessionId, (runtime) => {
					if (
						runtime.snapshot?.status !== "active" &&
						runtime.snapshot?.status !== "budget_limited"
					) {
						return runtime;
					}
					return { ...runtime, activeTurnStartedAtMs: runtime.activeTurnStartedAtMs ?? nowMs };
				}),
			);

		const accountUsage = (
			sessionId: string,
			tokens: number,
			nowMs: number,
			options: {
				readonly finishActiveAccounting: boolean;
				readonly continuationHadToolCall: boolean | null;
			},
		): Effect.Effect<GoalAgentEndResult, never, never> =>
			Effect.gen(function* () {
				const nowIso = new Date(nowMs).toISOString();
				let nextSnapshot: GoalSnapshot | null = null;
				let shouldPersist = false;
				let budgetLimitReached = false;

				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, (runtime) => {
						if (runtime.snapshot === null) {
							return {
								...runtime,
								activeTurnStartedAtMs: options.finishActiveAccounting
									? null
									: runtime.activeTurnStartedAtMs,
								continuationInFlight: false,
								terminalTurnAccountingPending: false,
								skipNextTurnAccounting: false,
							};
						}
						if (runtime.skipNextTurnAccounting) {
							nextSnapshot = runtime.snapshot;
							return {
								...runtime,
								activeTurnStartedAtMs: options.finishActiveAccounting ? null : nowMs,
								continuationInFlight: false,
								terminalTurnAccountingPending: false,
								skipNextTurnAccounting: false,
							};
						}
						if (!runtimeCanAccountActiveTurn(runtime)) {
							return {
								...runtime,
								activeTurnStartedAtMs: options.finishActiveAccounting
									? null
									: runtime.activeTurnStartedAtMs,
								continuationInFlight: false,
								terminalTurnAccountingPending: options.finishActiveAccounting
									? false
									: runtime.terminalTurnAccountingPending,
								skipNextTurnAccounting: options.finishActiveAccounting
									? false
									: runtime.skipNextTurnAccounting,
							};
						}

						const seconds = elapsedSeconds(runtime, nowMs);
						let snapshot = withUpdatedSnapshot(runtime.snapshot, nowIso, {
							tokensUsed: runtime.snapshot.tokensUsed + tokens,
							timeUsedSeconds: runtime.snapshot.timeUsedSeconds + seconds,
						});
						if (
							runtime.continuationInFlight &&
							options.continuationHadToolCall === false
						) {
							snapshot = withUpdatedSnapshot(snapshot, nowIso, {
								continuationSuppressed: true,
							});
						}
						const tokenBudgetReached =
							snapshot.tokenBudget !== null && snapshot.tokensUsed >= snapshot.tokenBudget;
						const timeBudgetReached =
							snapshot.timeBudgetSeconds !== null &&
							snapshot.timeUsedSeconds >= snapshot.timeBudgetSeconds;
						if (snapshot.status === "active" && (tokenBudgetReached || timeBudgetReached)) {
							snapshot = withUpdatedSnapshot(snapshot, nowIso, {
								status: "budget_limited",
							});
							budgetLimitReached = !snapshot.budgetLimitPromptSent;
						}
						const stopActiveTurn = statusStopsActiveTurn(snapshot.status);
						nextSnapshot = snapshot;
						shouldPersist =
							tokens > 0 ||
							seconds > 0 ||
							runtime.continuationInFlight ||
							budgetLimitReached;
						return {
							snapshot,
							activeTurnStartedAtMs:
								options.finishActiveAccounting || stopActiveTurn ? null : nowMs,
							continuationInFlight: false,
							terminalTurnAccountingPending: false,
							skipNextTurnAccounting: false,
						};
					}),
				);
				if (shouldPersist) {
					yield* saveSnapshot(nextSnapshot);
				}
				return { snapshot: nextSnapshot, budgetLimitReached };
			});

		const accountTurnEnd: GoalService["accountTurnEnd"] = (sessionId, message, nowMs) =>
			accountUsage(sessionId, assistantMessageUsageTokens(message), nowMs, {
				finishActiveAccounting: false,
				continuationHadToolCall: null,
			});

		const accountAgentEnd: GoalService["accountAgentEnd"] = (sessionId, event, nowMs) =>
			accountUsage(sessionId, 0, nowMs, {
				finishActiveAccounting: true,
				continuationHadToolCall: hasAssistantError(event) ? null : hasAssistantToolCall(event),
			});

		const prepareExternalMutation: GoalService["prepareExternalMutation"] = (
			sessionId,
			nowMs,
		) =>
			accountUsage(sessionId, 0, nowMs, {
				finishActiveAccounting: true,
				continuationHadToolCall: null,
			});

		const markUsageLimited: GoalService["markUsageLimited"] = Effect.fn(
			"Goal.markUsageLimited",
		)(function* (sessionId, message, nowMs) {
			yield* accountUsage(sessionId, assistantUsageTokens(message), nowMs, {
				finishActiveAccounting: true,
				continuationHadToolCall: null,
			});
			return yield* setStatus(sessionId, "usage_limited");
		});

		const markContinuationDispatched: GoalService["markContinuationDispatched"] = (sessionId) =>
			Ref.modify(runtimes, (state) => {
				let snapshot: GoalSnapshot | null = null;
				const next = withRuntime(state, sessionId, (runtime) => {
					snapshot = runtime.snapshot;
					if (runtime.snapshot?.status !== "active") {
						return runtime;
					}
					return { ...runtime, continuationInFlight: true };
				});
				return [snapshot, next];
			});

		const markBudgetLimitPromptSent: GoalService["markBudgetLimitPromptSent"] = (sessionId) =>
			Effect.gen(function* () {
				const nowIso = new Date().toISOString();
				let nextSnapshot: GoalSnapshot | null = null;
				let shouldPersist = false;
				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, (runtime) => {
						if (runtime.snapshot === null) {
							return runtime;
						}
						if (runtime.snapshot.budgetLimitPromptSent) {
							nextSnapshot = runtime.snapshot;
							return runtime;
						}
						nextSnapshot = withUpdatedSnapshot(runtime.snapshot, nowIso, {
							budgetLimitPromptSent: true,
						});
						shouldPersist = true;
						return { ...runtime, snapshot: nextSnapshot };
					}),
				);
				if (shouldPersist) {
					yield* saveSnapshot(nextSnapshot);
				}
				return nextSnapshot;
			});

		const clearContinuationSuppression: GoalService["clearContinuationSuppression"] = (
			sessionId,
		) =>
			Effect.gen(function* () {
				const nowIso = new Date().toISOString();
				let nextSnapshot: GoalSnapshot | null = null;
				let shouldPersist = false;
				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, (runtime) => {
						if (runtime.snapshot?.status !== "active") {
							nextSnapshot = runtime.snapshot ?? null;
							return runtime;
						}
						if (runtime.snapshot.continuationSuppressed === false) {
							nextSnapshot = runtime.snapshot;
							return runtime.continuationInFlight
								? { ...runtime, continuationInFlight: false }
								: runtime;
						}
						nextSnapshot = withUpdatedSnapshot(runtime.snapshot, nowIso, {
							continuationSuppressed: false,
						});
						shouldPersist = true;
						return { ...runtime, snapshot: nextSnapshot, continuationInFlight: false };
					}),
				);
				if (shouldPersist) {
					yield* saveSnapshot(nextSnapshot);
				}
				return nextSnapshot;
			});

		return Goal.of({
			rehydrate,
			get,
			liveSnapshot,
			create,
			setStatus,
			prepareExternalMutation,
			markUsageLimited,
			restoreAfterResume,
			clear,
			markAgentStart,
			accountAgentEnd,
			accountTurnEnd,
			markContinuationDispatched,
			markBudgetLimitPromptSent,
			clearContinuationSuppression,
		});
	}),
);
