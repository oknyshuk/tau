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
		options?: { readonly failIfExists?: boolean },
	) => Effect.Effect<GoalSnapshot, GoalError, never>;
	readonly setStatus: (
		sessionId: string,
		status: GoalStatus,
	) => Effect.Effect<GoalSnapshot | null, GoalError, never>;
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
}

export class Goal extends Context.Service<Goal, GoalService>()("Goal") {}

const emptyRuntime: GoalRuntime = {
	snapshot: null,
	activeTurnStartedAtMs: null,
	continuationInFlight: false,
};

function runtimeWithSnapshot(snapshot: GoalSnapshot | null): GoalRuntime {
	return {
		snapshot,
		activeTurnStartedAtMs: null,
		continuationInFlight: false,
	};
}

function appendSnapshot(
	pi: { appendEntry: (customType: string, data?: unknown) => void },
	snapshot: GoalSnapshot | null,
): void {
	pi.appendEntry(GOAL_ENTRY_TYPE, {
		version: 1,
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

function assistantMessageUsageTokens(message: AgentMessage): number {
	if (message.role !== "assistant") {
		return 0;
	}
	if (message.stopReason === "aborted" || message.stopReason === "error") {
		return 0;
	}
	const { usage } = message;
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
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
			function* (sessionId, objectiveInput, tokenBudgetInput, options) {
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
				const nowIso = new Date().toISOString();
				const snapshot = makeGoalSnapshot(objective, tokenBudget, nowIso);
				const failIfExists = options?.failIfExists === true;
				const existing = yield* get(sessionId);
				if (failIfExists && existing !== null) {
					return yield* Effect.fail(
						new GoalConflictError({ reason: "a thread goal already exists" }),
					);
				}
				if (
					existing !== null &&
					existing.objective === objective &&
					existing.status !== "complete"
				) {
					const nextSnapshot = withUpdatedSnapshot(existing, nowIso, {
						status: "active",
						tokenBudget,
						continuationSuppressed: false,
						budgetLimitPromptSent: false,
					});
					yield* Ref.update(runtimes, (state) =>
						withRuntime(state, sessionId, () => runtimeWithSnapshot(nextSnapshot)),
					);
					yield* saveSnapshot(nextSnapshot);
					return nextSnapshot;
				}
				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, () => runtimeWithSnapshot(snapshot)),
				);
				yield* saveSnapshot(snapshot);
				return snapshot;
			},
		);

		const setStatus: GoalService["setStatus"] = Effect.fn("Goal.setStatus")(
			function* (sessionId, status) {
				const nowIso = new Date().toISOString();
				let nextSnapshot: GoalSnapshot | null = null;
				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, (runtime) => {
						if (runtime.snapshot === null) {
							return runtime;
						}
						const patch: Partial<GoalSnapshot> = {
							status,
							...(status === "active"
								? { continuationSuppressed: false, budgetLimitPromptSent: false }
								: {}),
						};
						nextSnapshot = withUpdatedSnapshot(runtime.snapshot, nowIso, patch);
						return {
							...runtime,
							snapshot: nextSnapshot,
							continuationInFlight: false,
						};
					}),
				);
				if (nextSnapshot !== null) {
					yield* saveSnapshot(nextSnapshot);
				}
				return nextSnapshot;
			},
		);

		const clear: GoalService["clear"] = (sessionId) =>
			Ref.update(runtimes, (state) =>
				withRuntime(state, sessionId, () => runtimeWithSnapshot(null)),
			).pipe(Effect.andThen(saveSnapshot(null)));

		const markAgentStart: GoalService["markAgentStart"] = (sessionId, nowMs) =>
			Ref.update(runtimes, (state) =>
				withRuntime(state, sessionId, (runtime) => {
					if (
						runtime.snapshot?.status !== "active" &&
						runtime.snapshot?.status !== "budget_limited"
					) {
						return runtime;
					}
					return { ...runtime, activeTurnStartedAtMs: nowMs };
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
							};
						}
						if (
							runtime.snapshot.status !== "active" &&
							runtime.snapshot.status !== "budget_limited"
						) {
							return {
								...runtime,
								activeTurnStartedAtMs: options.finishActiveAccounting
									? null
									: runtime.activeTurnStartedAtMs,
								continuationInFlight: false,
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
						if (
							snapshot.status === "active" &&
							snapshot.tokenBudget !== null &&
							snapshot.tokensUsed >= snapshot.tokenBudget
						) {
							snapshot = withUpdatedSnapshot(snapshot, nowIso, {
								status: "budget_limited",
							});
							budgetLimitReached = !snapshot.budgetLimitPromptSent;
						}
						nextSnapshot = snapshot;
						shouldPersist =
							tokens > 0 ||
							seconds > 0 ||
							runtime.continuationInFlight ||
							budgetLimitReached;
						return {
							snapshot,
							activeTurnStartedAtMs: options.finishActiveAccounting ? null : nowMs,
							continuationInFlight: false,
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
				continuationHadToolCall: hasAssistantToolCall(event),
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
				yield* Ref.update(runtimes, (state) =>
					withRuntime(state, sessionId, (runtime) => {
						if (runtime.snapshot === null) {
							return runtime;
						}
						nextSnapshot = withUpdatedSnapshot(runtime.snapshot, nowIso, {
							budgetLimitPromptSent: true,
						});
						return { ...runtime, snapshot: nextSnapshot };
					}),
				);
				if (nextSnapshot !== null) {
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
			clear,
			markAgentStart,
			accountAgentEnd,
			accountTurnEnd,
			markContinuationDispatched,
			markBudgetLimitPromptSent,
		});
	}),
);
