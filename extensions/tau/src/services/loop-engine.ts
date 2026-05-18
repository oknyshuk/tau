import { Clock, Effect, Layer, Option, Context } from "effect";

import type { ExecutionProfile } from "../execution/schema.js";
import type { ResolvedSandboxConfig } from "../sandbox/config.js";
import { emptyRalphLoopMetrics } from "../ralph/schema.js";
import { makeEmptyCapabilityContract, type RalphCapabilityContract } from "../ralph/contract.js";
import type { StorageError } from "../shared/atomic-write.js";
import {
	createAutoresearchPhaseSnapshot,
	normalizeAutoresearchTaskContractInput,
	parseAutoresearchTaskDocument,
	renderAutoresearchTaskDocument,
} from "../autoresearch/task-contract.js";
import { loopTaskFile } from "../loops/paths.js";
import { LoopRepo } from "../loops/repo.js";
import { resolveLoopWorkspaceRoot } from "../loops/workspace-root.js";
import {
	LoopAmbiguousOwnershipError,
	LoopContractValidationError,
	LoopLifecycleConflictError,
	LoopOwnershipValidationError,
	LoopTaskAlreadyExistsError,
	LoopTaskNotFoundError,
	type LoopEngineError,
} from "../loops/errors.js";
import {
	decodeLoopTaskIdSync,
	encodeLoopPersistedStateJsonSync,
	type AutoresearchLoopPersistedState,
	type BlockedManualResolutionLoopState,
	type LoopPersistedState,
	type RalphLoopStateDetails,
	type LoopSessionRef,
	type MetricDirection,
	validateLoopOwnership,
} from "../loops/schema.js";

const nowIso = Effect.gen(function* () {
	const millis = yield* Clock.currentTimeMillis;
	return new Date(millis).toISOString();
});

type TaskLock = {
	readonly key: string;
	readonly tail: Promise<void>;
	readonly release: () => void;
};

function stopRalphActiveTimer(
	metrics: RalphLoopStateDetails["metrics"],
	timestamp: string,
): RalphLoopStateDetails["metrics"] {
	if (Option.isNone(metrics.activeStartedAt)) {
		return {
			...metrics,
			activeStartedAt: Option.none(),
		};
	}
	const startedAt = Date.parse(metrics.activeStartedAt.value);
	const endedAt = Date.parse(timestamp);
	return {
		...metrics,
		activeDurationMs:
			metrics.activeDurationMs +
			(Number.isFinite(startedAt) && Number.isFinite(endedAt)
				? Math.max(0, endedAt - startedAt)
				: 0),
		activeStartedAt: Option.none(),
	};
}

export type LoopCreateRalphInput = {
	readonly kind: "ralph";
	readonly taskId: string;
	readonly title: string;
	readonly taskContent: string;
	readonly maxIterations: number;
	readonly itemsPerIteration: number;
	readonly reflectEvery: number;
	readonly reflectInstructions: string;
	readonly executionProfile: ExecutionProfile;
	readonly sandboxProfile: ResolvedSandboxConfig;
	readonly capabilityContract: RalphCapabilityContract | undefined;
};

export type LoopCreateAutoresearchInput = {
	readonly kind: "autoresearch";
	readonly taskId: string;
	readonly title: string;
	readonly taskContent: string;
	readonly benchmarkCommand: string;
	readonly checksCommand: Option.Option<string>;
	readonly metricName: string;
	readonly metricUnit: string;
	readonly metricDirection: MetricDirection;
	readonly scopeRoot: string;
	readonly scopePaths: readonly string[];
	readonly offLimits: readonly string[];
	readonly constraints: readonly string[];
	readonly maxIterations: Option.Option<number>;
	readonly executionProfile: ExecutionProfile;
};

export type LoopCreateInput = LoopCreateRalphInput | LoopCreateAutoresearchInput;

export type LoopManualResolutionInput = {
	readonly reasonCode: string;
	readonly message: string;
	readonly recoveryActions: readonly string[];
	readonly recoveryNotes: readonly string[];
};

export type LoopCleanResult = {
	readonly cleanedTaskIds: readonly string[];
};

export type LoopCleanKind = "all" | "ralph" | "autoresearch";

export interface LoopEngineService {
	readonly createLoop: (
		cwd: string,
		input: LoopCreateInput,
	) => Effect.Effect<LoopPersistedState, LoopEngineError, never>;
	readonly startLoop: (
		cwd: string,
		taskId: string,
		controller: LoopSessionRef,
		executionProfile?: ExecutionProfile,
	) => Effect.Effect<LoopPersistedState, LoopEngineError, never>;
	readonly resumeLoop: (
		cwd: string,
		taskId: string,
		controller: LoopSessionRef,
		executionProfile?: ExecutionProfile,
	) => Effect.Effect<LoopPersistedState, LoopEngineError, never>;
	readonly pauseLoop: (
		cwd: string,
		taskId: string,
	) => Effect.Effect<LoopPersistedState, LoopEngineError, never>;
	readonly stopLoop: (
		cwd: string,
		taskId: string,
	) => Effect.Effect<LoopPersistedState, LoopEngineError, never>;
	readonly archiveLoop: (
		cwd: string,
		taskId: string,
	) => Effect.Effect<LoopPersistedState, LoopEngineError, never>;
	readonly cancelLoop: (
		cwd: string,
		taskId: string,
	) => Effect.Effect<void, LoopEngineError, never>;
	readonly cleanLoops: (
		cwd: string,
		all: boolean,
		kind?: LoopCleanKind,
	) => Effect.Effect<LoopCleanResult, LoopEngineError, never>;
	readonly listLoops: (
		cwd: string,
		archived?: boolean,
	) => Effect.Effect<ReadonlyArray<LoopPersistedState>, LoopEngineError, never>;
	readonly resolveOwnedLoop: (
		cwd: string,
		session: LoopSessionRef,
	) => Effect.Effect<Option.Option<LoopPersistedState>, LoopEngineError, never>;
	readonly attachChildSession: (
		cwd: string,
		taskId: string,
		child: LoopSessionRef,
	) => Effect.Effect<LoopPersistedState, LoopEngineError, never>;
	readonly clearChildSession: (
		cwd: string,
		taskId: string,
		child: LoopSessionRef,
	) => Effect.Effect<LoopPersistedState, LoopEngineError, never>;
	readonly blockLoopForManualResolution: (
		cwd: string,
		taskId: string,
		input: LoopManualResolutionInput,
	) => Effect.Effect<BlockedManualResolutionLoopState, LoopEngineError, never>;
}

export class LoopEngine extends Context.Service<LoopEngine, LoopEngineService>()("LoopEngine") {}

function sessionRefMatches(left: LoopSessionRef, right: LoopSessionRef): boolean {
	return left.sessionFile === right.sessionFile;
}

function stateOwnsSession(state: LoopPersistedState, session: LoopSessionRef): boolean {
	return Option.match(state.ownership.controller, {
		onNone: () =>
			Option.match(state.ownership.child, {
				onNone: () => false,
				onSome: (child) => sessionRefMatches(child, session),
			}),
		onSome: (controller) =>
			sessionRefMatches(controller, session) ||
			Option.match(state.ownership.child, {
				onNone: () => false,
				onSome: (child) => sessionRefMatches(child, session),
			}),
	});
}

function ensureLifecycle(
	state: LoopPersistedState,
	allowed: readonly LoopPersistedState["lifecycle"][],
	expectedLabel: string,
): Effect.Effect<void, LoopLifecycleConflictError, never> {
	if (allowed.includes(state.lifecycle)) {
		return Effect.void;
	}
	return Effect.fail(
		new LoopLifecycleConflictError({
			taskId: state.taskId,
			expected: expectedLabel,
			actual: state.lifecycle,
		}),
	);
}

function requireController(
	state: LoopPersistedState,
): Effect.Effect<LoopSessionRef, LoopOwnershipValidationError, never> {
	return Option.match(state.ownership.controller, {
		onNone: () =>
			Effect.fail(
				new LoopOwnershipValidationError({
					taskId: state.taskId,
					reason: "controller session is missing",
				}),
			),
		onSome: (controller) => Effect.succeed(controller),
	});
}

function normalizeTaskId(
	taskId: string,
): Effect.Effect<string, LoopContractValidationError, never> {
	return Effect.try({
		try: () => decodeLoopTaskIdSync(taskId),
		catch: (error) => error,
	}).pipe(
		Effect.catch((error) =>
			error instanceof LoopContractValidationError
				? Effect.fail(error)
				: Effect.fail(
						new LoopContractValidationError({
							entity: "loops.task_id",
							reason: String(error),
						}),
					),
		),
	);
}

export const LoopEngineLive = Layer.effect(
	LoopEngine,
	Effect.gen(function* () {
		const repo = yield* LoopRepo;
		const taskLocks = new Map<string, Promise<void>>();

		const withTaskLock = <A, E>(
			cwd: string,
			taskId: string,
			effect: Effect.Effect<A, E, never>,
		): Effect.Effect<A, E, never> => {
			const acquire = Effect.promise(async (): Promise<TaskLock> => {
				const key = `${resolveLoopWorkspaceRoot(cwd)}\u0000${taskId}`;
				const previous = taskLocks.get(key) ?? Promise.resolve();
				let releaseLock: () => void = () => undefined;
				const current = new Promise<void>((resolve) => {
					releaseLock = resolve;
				});
				const tail = previous.then(
					() => current,
					() => current,
				);
				taskLocks.set(key, tail);
				await previous.catch((error) => {
					console.warn("Loop engine previous task failed:", error);
				});
				return {
					key,
					tail,
					release: releaseLock,
				};
			});

			return Effect.acquireUseRelease(
				acquire,
				() => effect,
				(lock) =>
					Effect.sync(() => {
						lock.release();
						if (taskLocks.get(lock.key) === lock.tail) {
							taskLocks.delete(lock.key);
						}
					}),
			);
		};

		const ensureLoadedState = (
			cwd: string,
			taskId: string,
		): Effect.Effect<
			LoopPersistedState,
			LoopTaskNotFoundError | LoopContractValidationError | StorageError,
			never
		> =>
			Effect.gen(function* () {
				const normalizedTaskId = yield* normalizeTaskId(taskId);
				const stateOption = yield* repo.loadState(cwd, normalizedTaskId);
				if (Option.isNone(stateOption)) {
					return yield* Effect.fail(
						new LoopTaskNotFoundError({ taskId: normalizedTaskId }),
					);
				}
				return stateOption.value;
			});

		const validateState = (
			state: LoopPersistedState,
		): Effect.Effect<LoopPersistedState, LoopOwnershipValidationError, never> =>
			validateLoopOwnership(state).pipe(Effect.as(state));

		const loadAllValidated = (
			cwd: string,
			archived = false,
		): Effect.Effect<
			ReadonlyArray<LoopPersistedState>,
			LoopContractValidationError | LoopOwnershipValidationError | StorageError,
			never
		> =>
			repo.listStates(cwd, archived).pipe(
				Effect.flatMap((states) =>
					Effect.forEach(states, (state) => validateState(state), {
						concurrency: 1,
					}),
				),
			);

		const loadAutoresearchTaskContract = Effect.fn("LoopEngine.loadAutoresearchTaskContract")(
			function* (cwd: string, taskId: string) {
				const taskPath = loopTaskFile(taskId);
				const taskContent = yield* repo.readTaskFile(cwd, taskId);
				if (Option.isNone(taskContent)) {
					return yield* Effect.fail(
						new LoopContractValidationError({
							entity: "loops.autoresearch.task",
							reason: `${taskPath} does not exist.`,
						}),
					);
				}

				return yield* Effect.try({
					try: () => parseAutoresearchTaskDocument(taskContent.value, taskPath),
					catch: (error) =>
						error instanceof LoopContractValidationError
							? error
							: new LoopContractValidationError({
									entity: "loops.autoresearch.task",
									reason: String(error),
								}),
				});
			},
		);

		const syncAutoresearchStateWithTask = Effect.fn("LoopEngine.syncAutoresearchStateWithTask")(
			function* (
				cwd: string,
				state: LoopPersistedState,
				options: {
					readonly clearPendingRun: boolean;
				},
			) {
				if (state.kind !== "autoresearch") {
					return state;
				}

				const contract = yield* loadAutoresearchTaskContract(cwd, state.taskId);
				const snapshot = createAutoresearchPhaseSnapshot(
					state.taskId,
					contract,
					state.autoresearch.pinnedExecutionProfile,
					state.updatedAt,
				);

				if (
					!options.clearPendingRun &&
					Option.isSome(state.autoresearch.pendingRunId) &&
					Option.isSome(state.autoresearch.phaseId) &&
					state.autoresearch.phaseId.value !== snapshot.phaseId
				) {
					return yield* Effect.fail(
						new LoopLifecycleConflictError({
							taskId: state.taskId,
							expected: "unchanged phase-defining contract while a run is pending",
							actual: "phase-defining contract changed",
						}),
					);
				}

				const existingSnapshot = yield* repo.loadPhaseSnapshot(
					cwd,
					state.taskId,
					snapshot.phaseId,
				);
				if (
					Option.isNone(existingSnapshot) ||
					existingSnapshot.value.fingerprint !== snapshot.fingerprint
				) {
					yield* repo.savePhaseSnapshot(cwd, snapshot);
				}

				return {
					...state,
					title: contract.title,
					autoresearch: {
						...state.autoresearch,
						phaseId: Option.some(snapshot.phaseId),
						pendingRunId: options.clearPendingRun
							? Option.none<string>()
							: state.autoresearch.pendingRunId,
						benchmarkCommand: contract.benchmark.command,
						checksCommand: contract.benchmark.checksCommand,
						metricName: contract.metric.name,
						metricUnit: contract.metric.unit,
						metricDirection: contract.metric.direction,
						scopeRoot: contract.scope.root,
						scopePaths: [...contract.scope.paths],
						offLimits: [...contract.scope.offLimits],
						constraints: [...contract.constraints],
						maxIterations: Option.map(contract.limits, (value) => value.maxIterations),
					},
				} satisfies LoopPersistedState;
			},
		);

		const ensureSessionUnambiguous = (
			cwd: string,
			taskId: string,
			session: LoopSessionRef,
		): Effect.Effect<void, LoopEngineError, never> =>
			Effect.gen(function* () {
				const states = yield* loadAllValidated(cwd);
				const conflictingTaskIds = states
					.filter(
						(state) =>
							state.taskId !== taskId &&
							state.lifecycle !== "completed" &&
							state.lifecycle !== "archived" &&
							stateOwnsSession(state, session),
					)
					.map((state) => state.taskId);
				if (conflictingTaskIds.length > 0) {
					return yield* Effect.fail(
						new LoopAmbiguousOwnershipError({
							sessionId: session.sessionId,
							sessionFile: session.sessionFile,
							matchingTaskIds: conflictingTaskIds,
						}),
					);
				}
				return yield* Effect.void;
			});

		const blockAutoresearchPendingChildLoss = Effect.fn(
			"LoopEngine.blockAutoresearchPendingChildLoss",
		)(function* (
			cwd: string,
			state: AutoresearchLoopPersistedState,
			input: {
				readonly operation: string;
				readonly pendingRunId: string;
				readonly child: Option.Option<LoopSessionRef>;
			},
		) {
			const pendingRunId = input.pendingRunId;
			const preservedStateBase64 = Buffer.from(
				encodeLoopPersistedStateJsonSync(state),
				"utf-8",
			).toString("base64");
			const blockedAt = yield* nowIso;
			const childNotes = Option.match(input.child, {
				onNone: () => ["child_session=none"],
				onSome: (child) => [
					`child_session_id=${child.sessionId}`,
					`child_session_file=${child.sessionFile}`,
				],
			});

			const nextState: BlockedManualResolutionLoopState = {
				taskId: state.taskId,
				title: state.title,
				taskFile: state.taskFile,
				kind: "blocked_manual_resolution",
				previousKind: "autoresearch",
				lifecycle: "paused",
				createdAt: state.createdAt,
				updatedAt: blockedAt,
				startedAt: state.startedAt,
				completedAt: Option.none(),
				archivedAt: Option.none(),
				ownership: {
					controller: state.ownership.controller,
					child: Option.none(),
				},
				blocked: {
					reasonCode: "autoresearch.pending_run_child_lost",
					message: `Autoresearch run ${pendingRunId} lost child ownership during ${input.operation}. Resolve the pending trial manually.`,
					blockedAt,
					recoveryActions: [
						"Inspect the run artifact and child session transcript.",
						"Decide whether the pending trial should be kept, discarded, marked crashed, or marked checks_failed.",
						"Restore the preserved state only after resolving the pending trial outcome.",
					],
					recoveryNotes: [
						`pending_run_id=${pendingRunId}`,
						`operation=${input.operation}`,
						...childNotes,
						`preserved_state_base64=${preservedStateBase64}`,
					],
				},
			};

			yield* validateLoopOwnership(nextState);
			yield* repo.saveState(cwd, nextState);
			return nextState;
		});

		const createLoop: LoopEngineService["createLoop"] = Effect.fn("LoopEngine.createLoop")(
			function* (cwd, input) {
				const taskId = yield* normalizeTaskId(input.taskId);
				const existing = yield* repo.loadState(cwd, taskId);
				if (Option.isSome(existing)) {
					return yield* Effect.fail(new LoopTaskAlreadyExistsError({ taskId }));
				}

				const timestamp = yield* nowIso;
				const normalizedAutoresearchContract =
					input.kind === "autoresearch"
						? normalizeAutoresearchTaskContractInput({
								title: input.title,
								benchmarkCommand: input.benchmarkCommand,
								checksCommand: input.checksCommand,
								metricName: input.metricName,
								metricUnit: input.metricUnit,
								metricDirection: input.metricDirection,
								scopeRoot: input.scopeRoot,
								scopePaths: input.scopePaths,
								offLimits: input.offLimits,
								constraints: input.constraints,
								maxIterations: input.maxIterations,
							})
						: null;

				const normalizedAutoresearchMaxIterations =
					normalizedAutoresearchContract === null
						? Option.none<number>()
						: Option.map(
								normalizedAutoresearchContract.limits,
								(value) => value.maxIterations,
							);

				const normalizedTitle = normalizedAutoresearchContract?.title ?? input.title;
				const taskContent =
					normalizedAutoresearchContract === null
						? input.taskContent
						: renderAutoresearchTaskDocument(
								normalizedAutoresearchContract,
								input.taskContent,
							);

				const shared = {
					taskId,
					title: normalizedTitle,
					taskFile: loopTaskFile(taskId),
					lifecycle: "draft" as const,
					createdAt: timestamp,
					updatedAt: timestamp,
					startedAt: Option.none<string>(),
					completedAt: Option.none<string>(),
					archivedAt: Option.none<string>(),
					ownership: {
						controller: Option.none<LoopSessionRef>(),
						child: Option.none<LoopSessionRef>(),
					},
				};

				const state: LoopPersistedState =
					input.kind === "ralph"
						? {
								...shared,
								kind: "ralph",
								ralph: {
									iteration: 0,
									maxIterations: input.maxIterations,
									itemsPerIteration: input.itemsPerIteration,
									reflectEvery: input.reflectEvery,
									reflectInstructions: input.reflectInstructions,
									lastReflectionAt: 0,
									pendingDecision: Option.none(),
									pinnedExecutionProfile: input.executionProfile,
									sandboxProfile: Option.some(input.sandboxProfile),
									metrics: {
										...emptyRalphLoopMetrics(),
										activeStartedAt: Option.some(timestamp),
									},
									capabilityContract:
										input.capabilityContract ?? makeEmptyCapabilityContract(),
									deferredConfigMutations: [],
								},
							}
						: {
								...shared,
								kind: "autoresearch",
								autoresearch: {
									phaseId: Option.none(),
									pendingRunId: Option.none(),
									runCount: 0,
									maxIterations: normalizedAutoresearchMaxIterations,
									benchmarkCommand:
										normalizedAutoresearchContract?.benchmark.command ??
										input.benchmarkCommand,
									checksCommand:
										normalizedAutoresearchContract?.benchmark.checksCommand ??
										input.checksCommand,
									metricName:
										normalizedAutoresearchContract?.metric.name ??
										input.metricName,
									metricUnit:
										normalizedAutoresearchContract?.metric.unit ??
										input.metricUnit,
									metricDirection:
										normalizedAutoresearchContract?.metric.direction ??
										input.metricDirection,
									scopeRoot:
										normalizedAutoresearchContract?.scope.root ??
										input.scopeRoot,
									scopePaths: [
										...(normalizedAutoresearchContract?.scope.paths ??
											input.scopePaths),
									],
									offLimits: [
										...(normalizedAutoresearchContract?.scope.offLimits ??
											input.offLimits),
									],
									constraints: [
										...(normalizedAutoresearchContract?.constraints ??
											input.constraints),
									],
									pinnedExecutionProfile: input.executionProfile,
								},
							};

				yield* validateLoopOwnership(state);
				yield* repo.ensureTaskFile(cwd, taskId, taskContent);
				yield* repo.saveState(cwd, state);
				return state;
			},
		);

		const startLoop: LoopEngineService["startLoop"] = Effect.fn("LoopEngine.startLoop")(
			function* (cwd, taskId, controller, executionProfile) {
				const state = yield* ensureLoadedState(cwd, taskId);
				yield* validateState(state);

				if (state.kind === "blocked_manual_resolution") {
					return yield* Effect.fail(
						new LoopLifecycleConflictError({
							taskId: state.taskId,
							expected: "draft or completed",
							actual: state.lifecycle,
						}),
					);
				}

				yield* ensureLifecycle(state, ["draft", "completed"], "draft or completed");
				yield* ensureSessionUnambiguous(cwd, state.taskId, controller);

				const timestamp = yield* nowIso;
				const restarted = state.kind === "ralph" && state.lifecycle === "completed";

				const nextStateBase: LoopPersistedState =
					state.kind === "ralph"
						? {
								...state,
								lifecycle: "active",
								updatedAt: timestamp,
								startedAt: Option.some(timestamp),
								completedAt: Option.none(),
								ownership: {
									controller: Option.some(controller),
									child: Option.none(),
								},
								ralph: {
									...state.ralph,
									iteration: restarted ? 0 : state.ralph.iteration,
									pendingDecision: Option.none(),
									metrics: {
										...(restarted
											? emptyRalphLoopMetrics()
											: state.ralph.metrics),
										activeStartedAt: Option.some(timestamp),
									},
								},
							}
						: {
								...state,
								lifecycle: "active",
								updatedAt: timestamp,
								startedAt: Option.some(timestamp),
								completedAt: Option.none(),
								ownership: {
									controller: Option.some(controller),
									child: Option.none(),
								},
								autoresearch: {
									...state.autoresearch,
									pinnedExecutionProfile:
										executionProfile ??
										state.autoresearch.pinnedExecutionProfile,
									pendingRunId: Option.none(),
								},
							};

				const nextState =
					nextStateBase.kind === "autoresearch"
						? yield* syncAutoresearchStateWithTask(cwd, nextStateBase, {
								clearPendingRun: true,
							})
						: nextStateBase;

				yield* validateLoopOwnership(nextState);
				yield* repo.saveState(cwd, nextState);
				return nextState;
			},
		);

		const resumeLoop: LoopEngineService["resumeLoop"] = Effect.fn("LoopEngine.resumeLoop")(
			function* (cwd, taskId, controller, executionProfile) {
				const state = yield* ensureLoadedState(cwd, taskId);
				yield* validateState(state);
				if (state.kind === "blocked_manual_resolution") {
					return yield* Effect.fail(
						new LoopLifecycleConflictError({
							taskId: state.taskId,
							expected: "paused",
							actual: state.lifecycle,
						}),
					);
				}

				yield* ensureLifecycle(state, ["paused"], "paused");
				yield* ensureSessionUnambiguous(cwd, state.taskId, controller);

				if (
					Option.isSome(state.ownership.controller) &&
					!sessionRefMatches(state.ownership.controller.value, controller)
				) {
					return yield* Effect.fail(
						new LoopOwnershipValidationError({
							taskId: state.taskId,
							reason: "controller session does not match persisted ownership for this loop",
						}),
					);
				}

				const timestamp = yield* nowIso;
				const nextStateBase: LoopPersistedState =
					state.kind === "ralph"
						? {
								...state,
								lifecycle: "active",
								updatedAt: timestamp,
								ownership: {
									controller: Option.some(controller),
									child: Option.none(),
								},
								ralph: {
									...state.ralph,
									metrics: {
										...state.ralph.metrics,
										activeStartedAt: Option.some(timestamp),
									},
								},
							}
						: {
								...state,
								lifecycle: "active",
								updatedAt: timestamp,
								ownership: {
									controller: Option.some(controller),
									child: Option.none(),
								},
								autoresearch: {
									...state.autoresearch,
									pinnedExecutionProfile:
										executionProfile ??
										state.autoresearch.pinnedExecutionProfile,
								},
							};

				const nextState =
					nextStateBase.kind === "autoresearch"
						? yield* syncAutoresearchStateWithTask(cwd, nextStateBase, {
								clearPendingRun: false,
							})
						: nextStateBase;

				yield* validateLoopOwnership(nextState);
				yield* repo.saveState(cwd, nextState);
				return nextState;
			},
		);

		const pauseLoop: LoopEngineService["pauseLoop"] = Effect.fn("LoopEngine.pauseLoop")(
			function* (cwd, taskId) {
				const state = yield* ensureLoadedState(cwd, taskId);
				yield* validateState(state);
				yield* ensureLifecycle(state, ["active"], "active");

				if (state.kind === "autoresearch" && Option.isSome(state.autoresearch.pendingRunId)) {
					return yield* blockAutoresearchPendingChildLoss(cwd, state, {
						operation: "pause",
						pendingRunId: state.autoresearch.pendingRunId.value,
						child: state.ownership.child,
					});
				}

				const timestamp = yield* nowIso;
				const nextState: LoopPersistedState =
					state.kind === "ralph"
						? {
								...state,
								lifecycle: "paused",
								updatedAt: timestamp,
								ownership: {
									controller: state.ownership.controller,
									child: Option.none(),
								},
								ralph: {
									...state.ralph,
									metrics: stopRalphActiveTimer(state.ralph.metrics, timestamp),
								},
							}
						: {
								...state,
								lifecycle: "paused",
								updatedAt: timestamp,
								ownership: {
									controller: state.ownership.controller,
									child: Option.none(),
								},
							};

				yield* validateLoopOwnership(nextState);
				yield* repo.saveState(cwd, nextState);
				return nextState;
			},
		);

		const stopLoop: LoopEngineService["stopLoop"] = Effect.fn("LoopEngine.stopLoop")(
			function* (cwd, taskId) {
				const state = yield* ensureLoadedState(cwd, taskId);
				yield* validateState(state);
				yield* ensureLifecycle(state, ["active", "paused"], "active or paused");

				if (state.kind === "autoresearch" && Option.isSome(state.autoresearch.pendingRunId)) {
					return yield* blockAutoresearchPendingChildLoss(cwd, state, {
						operation: "stop",
						pendingRunId: state.autoresearch.pendingRunId.value,
						child: state.ownership.child,
					});
				}

				const timestamp = yield* nowIso;
				const nextState: LoopPersistedState =
					state.kind === "ralph"
						? {
								...state,
								lifecycle: "completed",
								updatedAt: timestamp,
								completedAt: Option.some(timestamp),
								ownership: {
									controller: state.ownership.controller,
									child: Option.none(),
								},
								ralph: {
									...state.ralph,
									pendingDecision: Option.none(),
									metrics: stopRalphActiveTimer(state.ralph.metrics, timestamp),
								},
							}
						: {
								...state,
								lifecycle: "completed",
								updatedAt: timestamp,
								completedAt: Option.some(timestamp),
								ownership: {
									controller: state.ownership.controller,
									child: Option.none(),
								},
							};

				yield* validateLoopOwnership(nextState);
				yield* repo.saveState(cwd, nextState);
				return nextState;
			},
		);

		const attachChildSession: LoopEngineService["attachChildSession"] = Effect.fn(
			"LoopEngine.attachChildSession",
		)(function* (cwd, taskId, child) {
			const state = yield* ensureLoadedState(cwd, taskId);
			yield* validateState(state);
			yield* ensureLifecycle(state, ["active"], "active");

			const controller = yield* requireController(state);
			if (sessionRefMatches(controller, child)) {
				return yield* Effect.fail(
					new LoopOwnershipValidationError({
						taskId: state.taskId,
						reason: "child session cannot match controller session",
					}),
				);
			}

			if (Option.isSome(state.ownership.child)) {
				return yield* Effect.fail(
					new LoopLifecycleConflictError({
						taskId: state.taskId,
						expected: "no active child session",
						actual: "child session already set",
					}),
				);
			}

			yield* ensureSessionUnambiguous(cwd, state.taskId, child);

			const nextState: LoopPersistedState = {
				...state,
				updatedAt: yield* nowIso,
				ownership: {
					controller: Option.some(controller),
					child: Option.some(child),
				},
			};

			yield* validateLoopOwnership(nextState);
			yield* repo.saveState(cwd, nextState);
			return nextState;
		});

		const clearChildSession: LoopEngineService["clearChildSession"] = Effect.fn(
			"LoopEngine.clearChildSession",
		)(function* (cwd, taskId, child) {
			const state = yield* ensureLoadedState(cwd, taskId);
			yield* validateState(state);

			if (Option.isNone(state.ownership.child)) {
				return yield* Effect.fail(
					new LoopLifecycleConflictError({
						taskId: state.taskId,
						expected: "active child session",
						actual: "no child session",
					}),
				);
			}

			if (!sessionRefMatches(state.ownership.child.value, child)) {
				return yield* Effect.fail(
					new LoopOwnershipValidationError({
						taskId: state.taskId,
						reason: "child session does not match persisted ownership",
					}),
				);
			}

			if (state.kind === "autoresearch" && Option.isSome(state.autoresearch.pendingRunId)) {
				return yield* blockAutoresearchPendingChildLoss(cwd, state, {
					operation: "clear_child",
					pendingRunId: state.autoresearch.pendingRunId.value,
					child: Option.some(child),
				});
			}

			const nextState: LoopPersistedState = {
				...state,
				updatedAt: yield* nowIso,
				ownership: {
					controller: state.ownership.controller,
					child: Option.none(),
				},
			};

			yield* validateLoopOwnership(nextState);
			yield* repo.saveState(cwd, nextState);
			return nextState;
		});

		const blockLoopForManualResolution: LoopEngineService["blockLoopForManualResolution"] =
			Effect.fn("LoopEngine.blockLoopForManualResolution")(function* (cwd, taskId, input) {
				const state = yield* ensureLoadedState(cwd, taskId);
				yield* validateState(state);
				const preservedStateBase64 = Buffer.from(
					encodeLoopPersistedStateJsonSync(state),
					"utf-8",
				).toString("base64");

				const blockedAt = yield* nowIso;
				const nextState: BlockedManualResolutionLoopState = {
					taskId: state.taskId,
					title: state.title,
					taskFile: state.taskFile,
					kind: "blocked_manual_resolution",
					previousKind:
						state.kind === "blocked_manual_resolution"
							? state.previousKind
							: state.kind,
					lifecycle: "paused",
					createdAt: state.createdAt,
					updatedAt: blockedAt,
					startedAt: state.startedAt,
					completedAt: Option.none(),
					archivedAt: Option.none(),
					ownership: {
						controller: state.ownership.controller,
						child: Option.none(),
					},
					blocked: {
						reasonCode: input.reasonCode,
						message: input.message,
						blockedAt,
						recoveryActions: [...input.recoveryActions],
						recoveryNotes: [
							...input.recoveryNotes,
							`preserved_state_base64=${preservedStateBase64}`,
						],
					},
				};

				yield* validateLoopOwnership(nextState);
				yield* repo.saveState(cwd, nextState);
				return nextState;
			});

		const listLoops: LoopEngineService["listLoops"] = Effect.fn("LoopEngine.listLoops")(
			function* (cwd, archived = false) {
				return yield* loadAllValidated(cwd, archived);
			},
		);

		const resolveOwnedLoop: LoopEngineService["resolveOwnedLoop"] = Effect.fn(
			"LoopEngine.resolveOwnedLoop",
		)(function* (cwd, session) {
			const states = yield* loadAllValidated(cwd, false);
			const matching = states.filter(
				(state) =>
					state.lifecycle !== "completed" &&
					state.lifecycle !== "archived" &&
					stateOwnsSession(state, session),
			);

			if (matching.length === 0) {
				return Option.none();
			}

			if (matching.length > 1) {
				return yield* Effect.fail(
					new LoopAmbiguousOwnershipError({
						sessionId: session.sessionId,
						sessionFile: session.sessionFile,
						matchingTaskIds: matching.map((state) => state.taskId),
					}),
				);
			}

			const first = matching[0];
			return first === undefined ? Option.none() : Option.some(first);
		});

		const archiveLoop: LoopEngineService["archiveLoop"] = Effect.fn("LoopEngine.archiveLoop")(
			function* (cwd, taskId) {
				const state = yield* ensureLoadedState(cwd, taskId);
				yield* validateState(state);
				if (state.lifecycle === "active") {
					return yield* Effect.fail(
						new LoopLifecycleConflictError({
							taskId: state.taskId,
							expected: "paused or completed",
							actual: state.lifecycle,
						}),
					);
				}

				const timestamp = yield* nowIso;
				const archivedTaskFile = loopTaskFile(state.taskId, true);
				const archivedState: LoopPersistedState =
					state.kind === "blocked_manual_resolution"
						? {
								...state,
								taskFile: archivedTaskFile,
								lifecycle: "archived",
								updatedAt: timestamp,
								archivedAt: Option.some(timestamp),
								ownership: {
									controller: Option.none(),
									child: Option.none(),
								},
							}
						: state.kind === "ralph"
							? {
									...state,
									taskFile: archivedTaskFile,
									lifecycle: "archived",
									updatedAt: timestamp,
									archivedAt: Option.some(timestamp),
									ownership: {
										controller: Option.none(),
										child: Option.none(),
									},
									ralph: {
										...state.ralph,
										pendingDecision: Option.none(),
									},
								}
							: {
									...state,
									taskFile: archivedTaskFile,
									lifecycle: "archived",
									updatedAt: timestamp,
									archivedAt: Option.some(timestamp),
									ownership: {
										controller: Option.none(),
										child: Option.none(),
									},
								};

				yield* validateLoopOwnership(archivedState);
				yield* repo.archiveTaskArtifacts(cwd, state.taskId);
				yield* repo.saveState(cwd, archivedState, true);
				yield* repo.deleteState(cwd, state.taskId, false);
				return archivedState;
			},
		);

		const cancelLoop: LoopEngineService["cancelLoop"] = Effect.fn("LoopEngine.cancelLoop")(
			function* (cwd, taskId) {
				const state = yield* ensureLoadedState(cwd, taskId);
				yield* validateState(state);
				if (state.lifecycle === "active") {
					return yield* Effect.fail(
						new LoopLifecycleConflictError({
							taskId: state.taskId,
							expected: "paused, draft, or completed",
							actual: state.lifecycle,
						}),
					);
				}

				yield* repo.deleteState(cwd, state.taskId);
				yield* repo.deleteTaskFile(cwd, state.taskId);
				yield* repo.deletePhaseDirectory(cwd, state.taskId);
				yield* repo.deleteRunDirectory(cwd, state.taskId);
			},
		);

		const cleanLoops: LoopEngineService["cleanLoops"] = Effect.fn("LoopEngine.cleanLoops")(
			function* (cwd, all, kind = "all") {
				const states = yield* loadAllValidated(cwd);
				const cleanedTaskIds: string[] = [];
				for (const state of states) {
					if (state.lifecycle !== "completed") {
						continue;
					}
					if (kind !== "all" && state.kind !== kind) {
						continue;
					}
					yield* repo.deleteState(cwd, state.taskId);
					if (all) {
						yield* repo.deleteTaskFile(cwd, state.taskId);
						yield* repo.deletePhaseDirectory(cwd, state.taskId);
						yield* repo.deleteRunDirectory(cwd, state.taskId);
					}
					cleanedTaskIds.push(state.taskId);
				}

				return { cleanedTaskIds };
			},
		);

		return LoopEngine.of({
			createLoop: (cwd, input) =>
				withTaskLock(cwd, input.taskId, createLoop(cwd, input)),
			startLoop: (cwd, taskId, controller, executionProfile) =>
				withTaskLock(cwd, taskId, startLoop(cwd, taskId, controller, executionProfile)),
			resumeLoop: (cwd, taskId, controller, executionProfile) =>
				withTaskLock(cwd, taskId, resumeLoop(cwd, taskId, controller, executionProfile)),
			pauseLoop: (cwd, taskId) => withTaskLock(cwd, taskId, pauseLoop(cwd, taskId)),
			stopLoop: (cwd, taskId) => withTaskLock(cwd, taskId, stopLoop(cwd, taskId)),
			archiveLoop: (cwd, taskId) =>
				withTaskLock(cwd, taskId, archiveLoop(cwd, taskId)),
			cancelLoop: (cwd, taskId) =>
				withTaskLock(cwd, taskId, cancelLoop(cwd, taskId)),
			cleanLoops,
			listLoops,
			resolveOwnedLoop,
			attachChildSession: (cwd, taskId, child) =>
				withTaskLock(cwd, taskId, attachChildSession(cwd, taskId, child)),
			clearChildSession: (cwd, taskId, child) =>
				withTaskLock(cwd, taskId, clearChildSession(cwd, taskId, child)),
			blockLoopForManualResolution: (cwd, taskId, input) =>
				withTaskLock(cwd, taskId, blockLoopForManualResolution(cwd, taskId, input)),
		});
	}),
);
