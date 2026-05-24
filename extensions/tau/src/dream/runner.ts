// DreamRunner -- orchestration service that coordinates lock, scheduler,
// subagent, and task registry to execute memory consolidation runs.
// The model does the work directly through tools (memory + dream_finish).

import { Clock, Effect, Exit, Layer, Option, Scope, Context } from "effect";
import { nanoid } from "nanoid";

import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
	type DreamFinishParams,
	type DreamProgressEvent,
	type DreamRunRequest,
	type DreamRunResult,
	type DreamTaskHandle,
} from "./domain.js";
import { DreamFinishToolParams, parseDreamFinishParams } from "./finish-tool.js";
import type { DreamConfig } from "./config.js";
import type {
	DreamConfigError,
	DreamGateError,
	DreamLockError,
	DreamSubagentError,
} from "./errors.js";
import { DreamDisabled, DreamLockHeld, DreamLockIoError, DreamSubagentNoFinish } from "./errors.js";
import type { DreamRunError } from "./task-registry.js";

import { DreamLock } from "./lock.js";
import { readMemoryToolAction, shouldCountMemoryMutation } from "./memory-mutations.js";
import { DreamScheduler } from "./scheduler.js";
import { DreamTaskRegistry } from "./task-registry.js";
import { DreamSubagent } from "./subagent.js";
import { CuratedMemory } from "../services/curated-memory.js";
import { createMemoryToolDefinition } from "../memory/index.js";

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface DreamRunnerApi {
	readonly runOnce: (
		request: DreamRunRequest,
	) => Effect.Effect<DreamRunResult, DreamRunError>;

	readonly spawnManual: (
		request: DreamRunRequest,
	) => Effect.Effect<DreamTaskHandle, DreamConfigError | DreamGateError | DreamLockError>;

	readonly maybeSpawnAuto: (
		request: DreamRunRequest,
	) => Effect.Effect<Option.Option<DreamTaskHandle>, DreamConfigError | DreamLockError>;
}

export class DreamRunner extends Context.Service<DreamRunner, DreamRunnerApi>()(
	"DreamRunner",
) {}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DreamRunnerLiveConfig {
	readonly loadConfig: (cwd: string) => Effect.Effect<DreamConfig, DreamConfigError>;
	readonly modelRegistry: ModelRegistry;
}

// ---------------------------------------------------------------------------
// dream_finish tool for auto-mode subagent sessions — schema + parser are
// shared with dream/init.ts via dream/finish-tool.ts.
// ---------------------------------------------------------------------------

/** Mutable holder for dream_finish params captured from the subagent. */
interface DreamFinishCapture {
	value: DreamFinishParams | undefined;
}

function createDreamFinishToolForSubagent(
	expectedRunId: string,
	capture: DreamFinishCapture,
): ToolDefinition {
	return {
		name: "dream_finish",
		label: "dream_finish",
		description: "Signal that the dream memory consolidation run is complete. Call this after all memory mutations are done.",
		parameters: DreamFinishToolParams,
		async execute(_toolCallId, rawParams) {
			const decoded = parseDreamFinishParams(rawParams);
			if (!decoded.ok) {
				return {
					isError: true,
					content: [{ type: "text", text: decoded.error }],
					details: {},
				};
			}

			const params = decoded.params;

			if (params.runId !== expectedRunId) {
				return {
					isError: true,
					content: [{ type: "text", text: `Run id mismatch. Expected ${expectedRunId}, received ${params.runId}.` }],
					details: {},
				};
			}

			capture.value = {
				runId: params.runId,
				summary: params.summary,
				reviewedSessions: params.reviewedSessions,
				noChanges: params.noChanges,
			};

			return {
				content: [{ type: "text", text: `Dream run ${params.runId} marked complete. ${params.summary}` }],
				details: {},
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Live layer
// ---------------------------------------------------------------------------

export const DreamRunnerLive = (runtimeConfig: DreamRunnerLiveConfig) =>
	Layer.effect(
		DreamRunner,
		Effect.gen(function* () {
			const lock = yield* DreamLock;
			const scheduler = yield* DreamScheduler;
			const reg = yield* DreamTaskRegistry;
			const subagent = yield* DreamSubagent;
			const mem = yield* CuratedMemory;
			const serviceScope = yield* Effect.scope;
			const backgroundScope = yield* Scope.make();
			yield* Scope.addFinalizer(serviceScope, Scope.close(backgroundScope, Exit.void));

			const subagentContext = {
				modelRegistry: runtimeConfig.modelRegistry,
			};

			// ── helpers ────────────────────────────────────────────────

			/** Create a memory tool that the subagent can use to mutate memory.
			 *  Returns the tool and a mutable counter for tracking mutations at
			 *  the runner level (so the failure path can advance the scheduler). */
			function createTrackedMemoryTool(): {
				readonly tool: ToolDefinition;
				readonly getMutationCount: () => number;
			} {
				const baseTool = createMemoryToolDefinition((effect) =>
					Effect.runPromise(
						effect.pipe(Effect.provideService(CuratedMemory, CuratedMemory.of(mem))),
					),
				);

				let mutations = 0;

					const tracked: ToolDefinition = {
						...baseTool,
						async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
							const result = await baseTool.execute(toolCallId, rawParams, signal, onUpdate, ctx);
							const action = readMemoryToolAction(rawParams);
							if (shouldCountMemoryMutation(action, result)) {
								mutations += 1;
							}
							return result;
					},
				};

				return { tool: tracked, getMutationCount: () => mutations };
			}

			function progress(taskId: string, event: DreamProgressEvent): Effect.Effect<void> {
				return reg.report(taskId, event).pipe(
					Effect.tapError((error) =>
						Effect.logWarning("Dream progress report failed", error),
					),
					Effect.catch(() => Effect.void),
				);
			}

			function failTask(taskId: string, err: DreamRunError): Effect.Effect<never, DreamRunError> {
				return reg.fail(taskId, err).pipe(Effect.flatMap(() => Effect.fail(err)));
			}

			/** Best-effort scheduler checkpoint advance after a failed run that
			 *  already made durable memory mutations. Prevents re-processing the
			 *  same transcripts while partial writes have already been persisted. */
			function advanceSchedulerOnFailure(
				request: DreamRunRequest,
				startedAt: number,
				mutations: number,
			): Effect.Effect<void> {
				return Effect.gen(function* () {
					const finishedAt = yield* Clock.currentTimeMillis;
					yield* scheduler.markCompleted(request.cwd, {
						mode: request.mode,
						startedAt,
						finishedAt,
						summary: `Partial run (${mutations} mutations before failure)`,
						reviewedSessions: [],
						memoryMutations: mutations,
						noChanges: false,
					});
				}).pipe(
					Effect.tapError((error) =>
						Effect.logWarning("Dream scheduler advance on failure failed", error),
					),
					Effect.catch(() => Effect.void),
				);
			}

			// ── runOnce (scoped -- caller wraps in Effect.scoped) ──────
			const runOnceScoped = Effect.fn("DreamRunner.runOnce")(
				function* (request: DreamRunRequest) {
					const startedAt = yield* Clock.currentTimeMillis;
					const dreamConfig = yield* runtimeConfig.loadConfig(request.cwd);

					if (!dreamConfig.enabled) {
						return yield* new DreamDisabled({ mode: request.mode });
					}
					if (request.mode === "manual" && !dreamConfig.manual.enabled) {
						return yield* new DreamDisabled({ mode: "manual" });
					}

					// Acquire scoped lock (released on scope exit / interruption)
					yield* lock.acquire(request.cwd);

					const memorySnapshot = yield* mem.getEntriesSnapshot(request.cwd);

					const runId = nanoid(12);
					const finishCapture: DreamFinishCapture = { value: undefined };
					const dreamFinishTool = createDreamFinishToolForSubagent(runId, finishCapture);
					const { tool: memoryTool, getMutationCount } = createTrackedMemoryTool();

					const subagentResult = yield* subagent
						.run(
							{
								cwd: request.cwd,
								runId,
								mode: request.mode,
								model: dreamConfig.subagent,
								memorySnapshot,
								nowIso: new Date().toISOString(),
							},
							subagentContext,
							[memoryTool, dreamFinishTool],
							() => Effect.void,
						)
						.pipe(
							Effect.catch((err: DreamSubagentError) => {
								const mutations = getMutationCount();
								if (mutations > 0) {
									return advanceSchedulerOnFailure(
										request,
										startedAt,
										mutations,
									).pipe(Effect.flatMap(() => Effect.fail(err)));
								}
								return Effect.fail(err);
							}),
						);

					if (finishCapture.value === undefined) {
						const mutations = getMutationCount();
						if (mutations > 0) {
							yield* advanceSchedulerOnFailure(request, startedAt, mutations);
						}
						return yield* new DreamSubagentNoFinish({
							reason: "Dream subagent ended without calling dream_finish",
						});
					}

					yield* mem.reloadFrozenSnapshot(request.cwd);

					const finishedAt = yield* Clock.currentTimeMillis;

					const finishParams = finishCapture.value;
					const runResult: DreamRunResult = {
						mode: request.mode,
						startedAt,
						finishedAt,
						summary: finishParams.summary,
						reviewedSessions: finishParams.reviewedSessions,
						memoryMutations: subagentResult.memoryMutations,
						noChanges: finishParams.noChanges,
					};

					yield* scheduler.markCompleted(request.cwd, runResult);
					return runResult;
				},
			);

			// ── runOnce with task progress reporting ──────────────────
			function runOnceWithProgress(
				request: DreamRunRequest,
				taskId: string,
			): Effect.Effect<DreamRunResult, DreamRunError, Scope.Scope> {
				return Effect.gen(function* () {
					const startedAt = yield* Clock.currentTimeMillis;

					const dreamConfig = yield* runtimeConfig.loadConfig(request.cwd).pipe(
						Effect.catch((err: DreamConfigError) => failTask(taskId, err)),
					);

					if (!dreamConfig.enabled) {
						return yield* failTask(taskId, new DreamDisabled({ mode: request.mode }));
					}

					// Acquire lock
					yield* progress(taskId, {
						_tag: "PhaseChanged",
						phase: "orient",
						message: "Acquiring lock",
					});

					yield* lock.acquire(request.cwd).pipe(
						Effect.catch((err: DreamLockError) => failTask(taskId, err)),
					);

					// Orient
					yield* progress(taskId, {
						_tag: "PhaseChanged",
						phase: "orient",
						message: "Loading memory snapshot",
					});

					const memorySnapshot = yield* mem.getEntriesSnapshot(request.cwd).pipe(
						Effect.catch((err) => failTask(taskId, err)),
					);

					// Gather
					yield* progress(taskId, {
						_tag: "PhaseChanged",
						phase: "gather",
						message: "Preparing memory curation",
					});

					// Run subagent with memory tool and dream_finish
					yield* progress(taskId, {
						_tag: "PhaseChanged",
						phase: "consolidate",
						message: "Running subagent",
					});

					const runId = nanoid(12);
					const finishCapture: DreamFinishCapture = { value: undefined };
					const dreamFinishTool = createDreamFinishToolForSubagent(runId, finishCapture);
					const { tool: memoryTool, getMutationCount } = createTrackedMemoryTool();

					const subagentResult = yield* subagent
						.run(
							{
								cwd: request.cwd,
								runId,
								mode: request.mode,
								model: dreamConfig.subagent,
								memorySnapshot,
								nowIso: new Date().toISOString(),
							},
							subagentContext,
							[memoryTool, dreamFinishTool],
							(event: DreamProgressEvent) => progress(taskId, event),
						)
						.pipe(
							Effect.catch((err: DreamSubagentError) => {
								// If the subagent failed but already made memory mutations,
								// advance the scheduler checkpoint so the same transcripts
								// aren't re-processed (those mutations are already durable).
								const mutations = getMutationCount();
								if (mutations > 0) {
									return advanceSchedulerOnFailure(
										request, startedAt, mutations,
									).pipe(Effect.flatMap(() => failTask(taskId, err)));
								}
								return failTask(taskId, err);
							}),
						);

					// Check if dream_finish was called
					if (finishCapture.value === undefined) {
						const mutations = getMutationCount();
						if (mutations > 0) {
							yield* advanceSchedulerOnFailure(request, startedAt, mutations);
						}
						return yield* failTask(
							taskId,
							new DreamSubagentNoFinish({
								reason: "Dream subagent ended without calling dream_finish",
							}),
						);
					}

					// Reload frozen snapshot
					yield* mem.reloadFrozenSnapshot(request.cwd).pipe(
						Effect.catch((err) => failTask(taskId, err)),
					);

					const finishedAt = yield* Clock.currentTimeMillis;
					const finishParams = finishCapture.value;
					const runResult: DreamRunResult = {
						mode: request.mode,
						startedAt,
						finishedAt,
						summary: finishParams.summary,
						reviewedSessions: finishParams.reviewedSessions,
						memoryMutations: subagentResult.memoryMutations,
						noChanges: finishParams.noChanges,
					};

					// Best-effort scheduler update
					yield* scheduler.markCompleted(request.cwd, runResult).pipe(
						Effect.tapError((error) =>
							Effect.logWarning("Dream scheduler markCompleted failed", error),
						),
						Effect.catch(() => Effect.void),
					);

					yield* reg.complete(taskId, runResult);
					return runResult;
				}).pipe(
					// Catch defects and convert to typed errors so the registry fiber
					// type is honest and failures are observable.
					Effect.catchDefect((defect) =>
						Effect.gen(function* () {
							const err = new DreamLockIoError({
								path: request.cwd,
								operation: "runOnceWithProgress",
								reason: `Unhandled dream failure: ${String(defect)}`,
							});
							yield* reg.fail(taskId, err).pipe(
								Effect.tapError((error) =>
									Effect.logWarning("Dream task registry fail failed", error),
								),
								Effect.catch(() => Effect.void),
							);
							return yield* Effect.fail(err);
						}),
					),
				);
			}

			// ── spawnManual ────────────────────────────────────────────
			const spawnManual: DreamRunnerApi["spawnManual"] = Effect.fn("DreamRunner.spawnManual")(
				function* (request) {
					const dreamConfig = yield* runtimeConfig.loadConfig(request.cwd);
					if (!dreamConfig.enabled || !dreamConfig.manual.enabled) {
						return yield* new DreamDisabled({ mode: "manual" });
					}

					// Pre-flight lock check (non-blocking)
					const lockInfo = yield* lock.inspect(request.cwd);
					if (Option.isSome(lockInfo)) {
						return yield* new DreamLockHeld({
							path: lockInfo.value.path,
							holderPid: lockInfo.value.holderPid,
						});
					}

					const handle = yield* reg.create(request);
					const fiber = yield* Effect.forkIn(
						Effect.scoped(runOnceWithProgress(request, handle.taskId)),
						backgroundScope,
					);
					yield* reg.attach(handle.taskId, fiber);

					return handle;
				},
			);

			// ── maybeSpawnAuto ──────────────────────────────────────────
			const maybeSpawnAuto: DreamRunnerApi["maybeSpawnAuto"] = Effect.fn("DreamRunner.maybeSpawnAuto")(
				function* (request) {
					const permitResult = yield* scheduler.evaluateAutoStart(request).pipe(
						Effect.map(Option.some),
						Effect.catchIf(
							(err: DreamConfigError | DreamGateError | DreamLockError) =>
								err._tag === "DreamDisabled" ||
								err._tag === "DreamTooSoon" ||
								err._tag === "DreamNotEnoughSessions" ||
								err._tag === "DreamSessionScanThrottled" ||
								err._tag === "DreamLockHeld",
							() => Effect.succeed(Option.none()),
						),
					);

					if (Option.isNone(permitResult)) {
						return Option.none();
					}

					const handle = yield* reg.create(request);
					const fiber = yield* Effect.forkIn(
						Effect.scoped(runOnceWithProgress(request, handle.taskId)),
						backgroundScope,
					);
					yield* reg.attach(handle.taskId, fiber);

					return Option.some(handle);
				},
			);

			return DreamRunner.of({
				runOnce: (request) => Effect.scoped(runOnceScoped(request)),
				spawnManual,
				maybeSpawnAuto,
			});
		}),
	);
