import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Context, Effect, Layer, Ref } from "effect";

import { PiAPI } from "../effect/pi.js";
import { GoalConflictError, type GoalError } from "../goal/errors.js";
import {
	GOAL_ENTRY_TYPE,
	MAX_GOAL_OBJECTIVE_CHARS,
	goalFromBranch,
	goalObjectiveCharCount,
	makeGoalSnapshot,
	type GoalSnapshot,
	type GoalStatus,
} from "../goal/schema.js";

type GoalRuntime = {
	readonly snapshot: GoalSnapshot | null;
	readonly activeTurnStartedAtMs: number | null;
	readonly terminalTurnAccountingPending: boolean;
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
			readonly startActiveAccountingAtMs?: number;
		},
	) => Effect.Effect<GoalSnapshot, GoalError, never>;
	readonly edit: (
		sessionId: string,
		objective: string,
		status: GoalStatus,
		tokenBudget: number | null,
		timeBudgetSeconds: number | null,
		options?: {
			readonly startActiveAccountingAtMs?: number;
		},
	) => Effect.Effect<GoalSnapshot | null, GoalError, never>;
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
	readonly markBudgetLimitPromptSent: (
		sessionId: string,
	) => Effect.Effect<GoalSnapshot | null, never, never>;
}

export class Goal extends Context.Service<Goal, GoalService>()("Goal") {}

const emptyRuntime: GoalRuntime = {
	snapshot: null,
	activeTurnStartedAtMs: null,
	terminalTurnAccountingPending: false,
};

function runtimeWithSnapshot(snapshot: GoalSnapshot | null): GoalRuntime {
	return {
		snapshot,
		activeTurnStartedAtMs: null,
		terminalTurnAccountingPending: false,
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
	return objective.trim();
}

type GoalObjectiveValidationResult =
	| { readonly valid: true; readonly objective: string }
	| { readonly valid: false; readonly error: GoalConflictError };

function validateGoalObjectiveResult(objectiveInput: string): GoalObjectiveValidationResult {
	const objective = normalizeObjective(objectiveInput);
	if (objective.length === 0) {
		return {
			valid: false,
			error: new GoalConflictError({ reason: "goal objective must not be empty" }),
		};
	}
	if (goalObjectiveCharCount(objective) > MAX_GOAL_OBJECTIVE_CHARS) {
		return {
			valid: false,
			error: new GoalConflictError({
				reason: "goal objective must be at most 4000 characters",
			}),
		};
	}
	return { valid: true, objective };
}

export function validateGoalObjective(objectiveInput: string): string {
	const result = validateGoalObjectiveResult(objectiveInput);
	if (!result.valid) {
		throw result.error;
	}
	return result.objective;
}

function validateObjective(objectiveInput: string): Effect.Effect<string, GoalConflictError, never> {
	const result = validateGoalObjectiveResult(objectiveInput);
	return result.valid ? Effect.succeed(result.objective) : Effect.fail(result.error);
}

function validateTokenBudget(
	tokenBudget: number | null,
): Effect.Effect<number | null, GoalConflictError, never> {
	if (tokenBudget === null) {
		return Effect.succeed(null);
	}
	if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
		return Effect.fail(
			new GoalConflictError({ reason: "goal budgets must be positive when provided" }),
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
	return usage.input + usage.cacheWrite + usage.output;
}

function assistantMessageUsageTokens(message: AgentMessage): number {
	if (message.role === "assistant" && message.stopReason === "error") {
		return 0;
	}
	return assistantUsageTokens(message);
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

function statusAfterBudgetLimit(snapshot: GoalSnapshot, status: GoalStatus): GoalStatus {
	const tokenBudgetReached =
		snapshot.tokenBudget !== null && snapshot.tokensUsed >= snapshot.tokenBudget;
	const timeBudgetReached =
		snapshot.timeBudgetSeconds !== null &&
		snapshot.timeUsedSeconds >= snapshot.timeBudgetSeconds;
	if (
		(tokenBudgetReached || timeBudgetReached) &&
		(status === "active" || status === "paused" || status === "blocked")
	) {
		return "budget_limited";
	}
	return status;
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

function goalBudgetLimitReached(snapshot: GoalSnapshot): boolean {
	return (
		(snapshot.tokenBudget !== null && snapshot.tokensUsed >= snapshot.tokenBudget) ||
		(snapshot.timeBudgetSeconds !== null &&
			snapshot.timeUsedSeconds >= snapshot.timeBudgetSeconds)
	);
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
				const branchSnapshot = yield* goalFromBranch(entries);
				const snapshot =
					branchSnapshot?.status === "active" && goalBudgetLimitReached(branchSnapshot)
						? withUpdatedSnapshot(branchSnapshot, new Date().toISOString(), {
								status: "budget_limited",
							})
						: branchSnapshot;
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
				const objective = yield* validateObjective(objectiveInput);
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
								"cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete",
						}),
					);
				}
				if (existing !== null) {
					const unchangedActiveGoal =
						existing.status === "active" &&
						existing.objective === objective &&
						existing.tokenBudget === tokenBudget &&
						existing.timeBudgetSeconds === timeBudgetSeconds &&
						existing.budgetLimitPromptSent === false;
					const activeSnapshot = unchangedActiveGoal
						? existing
						: withUpdatedSnapshot(existing, nowIso, {
								objective,
								status: "active",
								tokenBudget,
								timeBudgetSeconds,
								budgetLimitPromptSent: false,
							});
					const budgetLimitStatusChanged =
						activeSnapshot.status === "active" && goalBudgetLimitReached(activeSnapshot);
					const nextSnapshot = budgetLimitStatusChanged
						? withUpdatedSnapshot(activeSnapshot, nowIso, { status: "budget_limited" })
						: activeSnapshot;
					yield* Ref.update(runtimes, (state) =>
						withRuntime(state, sessionId, () => ({
							...runtimeWithSnapshot(nextSnapshot),
							activeTurnStartedAtMs: options?.startActiveAccountingAtMs ?? null,
						})),
					);
					if (!unchangedActiveGoal || budgetLimitStatusChanged) {
						yield* saveSnapshot(nextSnapshot);
					}
					return nextSnapshot;
				}
				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, () => ({
						...runtimeWithSnapshot(snapshot),
						activeTurnStartedAtMs: options?.startActiveAccountingAtMs ?? null,
					})),
				);
				yield* saveSnapshot(snapshot);
				return snapshot;
			},
		);

		const edit: GoalService["edit"] = Effect.fn("Goal.edit")(
			function* (
				sessionId,
				objectiveInput,
				status,
				tokenBudgetInput,
				timeBudgetSecondsInput,
				options,
			) {
				const objective = yield* validateObjective(objectiveInput);
				const tokenBudget = yield* validateTokenBudget(tokenBudgetInput);
				const timeBudgetSeconds = yield* validateTimeBudgetSeconds(timeBudgetSecondsInput);
				const nowIso = new Date().toISOString();
				let nextSnapshot: GoalSnapshot | null = null;
				let shouldPersist = false;
				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, (runtime) => {
						if (runtime.snapshot === null) {
							return runtime;
						}
						nextSnapshot = withUpdatedSnapshot(runtime.snapshot, nowIso, {
							objective,
							status,
							tokenBudget,
							timeBudgetSeconds,
							...(status === "active"
								? { budgetLimitPromptSent: false }
								: {}),
						});
						shouldPersist = true;
						return {
							snapshot: nextSnapshot,
							activeTurnStartedAtMs:
								status === "active"
									? (options?.startActiveAccountingAtMs ??
										(runtime.snapshot.status === "active"
											? runtime.activeTurnStartedAtMs
											: null))
									: null,
							terminalTurnAccountingPending: false,
						};
					}),
				);
				if (shouldPersist) {
					yield* saveSnapshot(nextSnapshot);
				}
				return nextSnapshot;
			},
		);

		const setStatus: GoalService["setStatus"] = Effect.fn("Goal.setStatus")(
			function* (sessionId, status, options) {
				const requestedStatus = status;
				const nowIso = new Date().toISOString();
				let nextSnapshot: GoalSnapshot | null = null;
				let shouldPersist = false;
				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, (runtime) => {
						if (runtime.snapshot === null) {
							return runtime;
						}
						const status = statusAfterBudgetLimit(runtime.snapshot, requestedStatus);
						const unchangedActiveStatus =
							status === "active" &&
							runtime.snapshot.status === "active" &&
							runtime.snapshot.budgetLimitPromptSent === false;
						if (
							unchangedActiveStatus ||
							(runtime.snapshot.status === status &&
								requestedStatus === status &&
								status !== "active" &&
								status !== "complete")
						) {
							const terminalTurnAccountingPending =
								status === "active"
									? false
									: status === "blocked" && options?.accountCurrentTurn === true
										? true
										: runtime.terminalTurnAccountingPending;
							const activeTurnStartedAtMs =
								status === "active"
									? (options?.startActiveAccountingAtMs ?? runtime.activeTurnStartedAtMs)
									: status === "blocked" && options?.accountCurrentTurn === true
										? runtime.activeTurnStartedAtMs
										: null;
							nextSnapshot = runtime.snapshot;
							return {
								...runtime,
								activeTurnStartedAtMs,
								terminalTurnAccountingPending,
							};
						}
						const patch: Partial<GoalSnapshot> = {
							status,
							...(status === "active"
								? { budgetLimitPromptSent: false }
								: {}),
						};
						nextSnapshot = withUpdatedSnapshot(runtime.snapshot, nowIso, patch);
						shouldPersist = true;
						const activeTurnStartedAtMs =
							status === "active"
								? (options?.startActiveAccountingAtMs ??
									(runtime.snapshot.status === "active"
										? runtime.activeTurnStartedAtMs
										: null))
								: (status === "complete" || status === "blocked") &&
										options?.accountCurrentTurn === true
									? runtime.activeTurnStartedAtMs
									: null;
						return {
							...runtime,
							snapshot: nextSnapshot,
							activeTurnStartedAtMs,
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
					return {
						...runtime,
						activeTurnStartedAtMs: runtime.activeTurnStartedAtMs ?? nowMs,
					};
				}),
			);

		const accountUsage = (
			sessionId: string,
			tokens: number,
			nowMs: number,
			options: {
				readonly finishActiveAccounting: boolean;
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
								terminalTurnAccountingPending: false,
							};
						}
						if (!runtimeCanAccountActiveTurn(runtime)) {
							return {
								...runtime,
								activeTurnStartedAtMs: options.finishActiveAccounting
									? null
									: runtime.activeTurnStartedAtMs,
								terminalTurnAccountingPending: options.finishActiveAccounting
									? false
									: runtime.terminalTurnAccountingPending,
							};
						}

						const seconds = elapsedSeconds(runtime, nowMs);
						let snapshot = withUpdatedSnapshot(runtime.snapshot, nowIso, {
							tokensUsed: runtime.snapshot.tokensUsed + tokens,
							timeUsedSeconds: runtime.snapshot.timeUsedSeconds + seconds,
						});
						if (snapshot.status === "active" && goalBudgetLimitReached(snapshot)) {
							snapshot = withUpdatedSnapshot(snapshot, nowIso, {
								status: "budget_limited",
							});
							budgetLimitReached = !snapshot.budgetLimitPromptSent;
						}
						const stopActiveTurn = statusStopsActiveTurn(snapshot.status);
						nextSnapshot = snapshot;
						shouldPersist = tokens > 0 || seconds > 0 || budgetLimitReached;
						return {
							snapshot,
							activeTurnStartedAtMs:
								options.finishActiveAccounting || stopActiveTurn ? null : nowMs,
							terminalTurnAccountingPending: false,
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
			});

		const accountAgentEnd: GoalService["accountAgentEnd"] = (sessionId, _event, nowMs) =>
			accountUsage(sessionId, 0, nowMs, {
				finishActiveAccounting: true,
			});

		const prepareExternalMutation: GoalService["prepareExternalMutation"] = (
			sessionId,
			nowMs,
		) =>
			accountUsage(sessionId, 0, nowMs, {
				finishActiveAccounting: true,
			});

		const markUsageLimited: GoalService["markUsageLimited"] = Effect.fn(
			"Goal.markUsageLimited",
		)(function* (sessionId, message, nowMs) {
			yield* accountUsage(sessionId, assistantUsageTokens(message), nowMs, {
				finishActiveAccounting: true,
			});
			return yield* setStatus(sessionId, "usage_limited");
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

		return Goal.of({
			rehydrate,
			get,
			liveSnapshot,
			create,
			edit,
			setStatus,
			prepareExternalMutation,
			markUsageLimited,
			restoreAfterResume,
			clear,
			markAgentStart,
			accountAgentEnd,
			accountTurnEnd,
			markBudgetLimitPromptSent,
		});
	}),
);
