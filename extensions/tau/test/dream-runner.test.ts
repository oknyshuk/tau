import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "vitest";

import type {
	DreamProgressEvent,
	DreamRunRequest,
	DreamRunResult,
	DreamTranscriptCandidate,
} from "../src/dream/domain.js";
import type { DreamConfig } from "../src/dream/config.js";
import type {
	DreamConfigError,
	DreamLockError,
} from "../src/dream/errors.js";
import {
	DreamDisabled,
	DreamSubagentSpawnFailed,
} from "../src/dream/errors.js";
import { DreamLock, type DreamLease, type DreamLockInfo, type ManualDreamLease } from "../src/dream/lock.js";
import { DreamScheduler } from "../src/dream/scheduler.js";
import { DreamTaskRegistry, DreamTaskRegistryLive } from "../src/dream/task-registry.js";
import { DreamSubagent, type DreamSubagentContext, type DreamSubagentResult } from "../src/dream/subagent.js";
import { DreamRunner, DreamRunnerLive, type DreamRunnerLiveConfig } from "../src/dream/runner.js";
import { CuratedMemory, type MutationResult } from "../src/services/curated-memory.js";
import type {
	MemoryEntriesSnapshot,
	MemoryEntry,
	MemoryBucketEntriesSnapshot,
	MemorySnapshot,
	MemoryBucketSnapshot,
} from "../src/memory/format.js";
import { MemoryFileError } from "../src/memory/errors.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createMemoryEntry } from "../src/memory/format.js";
import { DateTime } from "effect";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBucket(
	bucket: "project" | "global" | "user",
	entries: MemoryEntry[] = [],
	limitChars = 25_000,
): MemoryBucketEntriesSnapshot {
	const chars = entries.reduce((sum, e) => sum + e.content.length, 0);
	return {
		bucket,
		path: `/fake/.pi/tau/memories/${bucket.toUpperCase()}.jsonl`,
		entries,
		chars,
		limitChars,
		usagePercent: Math.round((chars / limitChars) * 100),
	};
}

function makeEmptySnapshot(): MemoryEntriesSnapshot {
	return {
		project: makeBucket("project"),
		global: makeBucket("global"),
		user: makeBucket("user", [], 25_000),
	};
}

function makeBucketSnapshot(
	bucket: "project" | "global" | "user",
	entries: string[] = [],
	limitChars = 25_000,
): MemoryBucketSnapshot {
	const chars = entries.reduce((sum, entry) => sum + entry.length, 0);
	return {
		bucket,
		path: `/fake/.pi/tau/memories/${bucket.toUpperCase()}.jsonl`,
		entries,
		chars,
		limitChars,
		usagePercent: Math.round((chars / limitChars) * 100),
	};
}

function makeEmptyMemorySnapshot(): MemorySnapshot {
	return {
		project: makeBucketSnapshot("project"),
		global: makeBucketSnapshot("global"),
		user: makeBucketSnapshot("user", [], 25_000),
	};
}

function makeEntry(id: string, scope: "project" | "global" | "user", content: string): MemoryEntry {
	return createMemoryEntry(content, {
		id,
		scope,
		summary: `${scope} hook ${id}`,
		now: DateTime.makeUnsafe("2025-01-01T00:00:00Z"),
	});
}

const defaultConfig: DreamConfig = {
	enabled: true,
	manual: { enabled: true },
	auto: {
		enabled: true,
		minHoursSinceLastRun: 24,
		minSessionsSinceLastRun: 5,
		scanThrottleMinutes: 10,
	},
	subagent: {
		model: "test/test-model",
		thinking: "medium",
		maxTurns: 4,
	},
};

const defaultRequest: DreamRunRequest = {
	cwd: "/tmp/test-dream",
	mode: "manual",
	requestedBy: "user",
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

function makeMockLock(opts: {
	acquireFail?: DreamLockError;
	inspectResult?: Option.Option<DreamLockInfo>;
} = {}): Layer.Layer<DreamLock> {
	return Layer.succeed(
		DreamLock,
		DreamLock.of({
			acquire: (_cwd) => {
				if (opts.acquireFail) {
					return Effect.fail(opts.acquireFail);
				}
				const lease: DreamLease = { path: "/tmp/test-dream/.pi/tau/dream.lock", acquiredAtMs: Date.now() };
				return Effect.acquireRelease(
					Effect.succeed(lease),
					() => Effect.void,
				);
			},
			acquireManual: (_cwd) => {
				if (opts.acquireFail) {
					return Effect.fail(opts.acquireFail);
				}
				const lease: ManualDreamLease = {
					path: "/tmp/test-dream/.pi/tau/dream.lock",
					token: "test-token",
					acquiredAtMs: Date.now(),
				};
				return Effect.succeed(lease);
			},
			releaseManual: () => Effect.void,
			inspect: (_cwd) => Effect.succeed(opts.inspectResult ?? Option.none()),
		}),
	);
}

function makeMockScheduler(opts: {
	lastCompletedAt?: number | null;
	evaluateAutoFail?: DreamConfigError | import("../src/dream/errors.js").DreamGateError | DreamLockError;
} = {}): Layer.Layer<DreamScheduler> {
	return Layer.succeed(
		DreamScheduler,
		DreamScheduler.of({
			evaluateAutoStart: (_request) => {
				if (opts.evaluateAutoFail) {
					return Effect.fail(opts.evaluateAutoFail);
				}
				return Effect.succeed({
					sinceMs: 0,
					sessions: [],
				});
			},
			markCompleted: () => Effect.void,
			readLastCompletedAt: () => Effect.succeed(opts.lastCompletedAt ?? null),
		}),
	);
}

function makeRecordingScheduler(recordedRuns: DreamRunResult[]): Layer.Layer<DreamScheduler> {
	return Layer.succeed(
		DreamScheduler,
		DreamScheduler.of({
			evaluateAutoStart: () => Effect.succeed({ sinceMs: 0, sessions: [] }),
			markCompleted: (_cwd, result) =>
				Effect.sync(() => {
					recordedRuns.push(result);
				}),
			readLastCompletedAt: () => Effect.succeed(null),
		}),
	);
}

/**
 * Create a mock subagent that simulates calling dream_finish via the
 * custom tools it receives. The `run` method finds the dream_finish tool
 * in customTools and calls its execute to capture the finish params.
 */
function makeMockSubagent(opts: {
	memoryMutations?: number;
	callFinish?: boolean;
	finishSummary?: string;
	finishReviewedSessions?: string[];
	finishNoChanges?: boolean;
} = {}): Layer.Layer<DreamSubagent> {
	const callFinish = opts.callFinish ?? true;
	return Layer.succeed(
		DreamSubagent,
		DreamSubagent.of({
			run: (request, _context, customTools, _onEvent) => {
				const callFinishAndReturn = Effect.gen(function* () {
					if (callFinish) {
						// Find the dream_finish tool and call it
						const finishTool = customTools.find((t) => t.name === "dream_finish");
						if (finishTool) {
							yield* Effect.promise(() =>
								finishTool.execute(
									"test-call-id",
									{
										runId: request.runId,
										summary: opts.finishSummary ?? "Test plan",
										reviewedSessions: opts.finishReviewedSessions ?? [],
										noChanges: opts.finishNoChanges ?? false,
									},
									new AbortController().signal,
									() => undefined,
									{} as Parameters<typeof finishTool.execute>[4],
								),
							);
						}
					}

					return {
						memoryMutations: opts.memoryMutations ?? 0,
					} satisfies DreamSubagentResult;
				});
				return callFinishAndReturn as Effect.Effect<DreamSubagentResult, import("../src/dream/errors.js").DreamSubagentError>;
			},
		}),
	);
}

function makeMockMemory(opts: {
	snapshot?: MemoryEntriesSnapshot;
} = {}): Layer.Layer<CuratedMemory> {
	const snapshot = opts.snapshot ?? makeEmptySnapshot();
	const defaultResult: MutationResult = {
		changedScope: "project",
		entry: makeEntry("abc123456789", "project", "test"),
	};

	return Layer.succeed(
		CuratedMemory,
		CuratedMemory.of({
			getSnapshot: () => Effect.die("not implemented in mock"),
			getEntriesSnapshot: () => Effect.succeed(snapshot),
			reloadFrozenSnapshot: () => Effect.void,
			getFrozenPromptBlock: Effect.succeed(""),
			add: () => Effect.succeed(defaultResult),
			update: () => Effect.succeed(defaultResult),
			remove: () => Effect.succeed(defaultResult),
			read: () => Effect.die("not implemented in mock"),
			setup: Effect.void,
		}),
	);
}

function makeFailingMemoryAddLayer(): Layer.Layer<CuratedMemory> {
	const snapshot = makeEmptySnapshot();
	return Layer.succeed(
		CuratedMemory,
		CuratedMemory.of({
			getSnapshot: () => Effect.die("not implemented in mock"),
			getEntriesSnapshot: () => Effect.succeed(snapshot),
			reloadFrozenSnapshot: () => Effect.void,
			getFrozenPromptBlock: Effect.succeed(""),
			add: () => Effect.fail(new MemoryFileError({ reason: "write failed" })),
			update: () => Effect.die("not implemented in mock"),
			remove: () => Effect.die("not implemented in mock"),
			read: () => Effect.die("not implemented in mock"),
			setup: Effect.void,
		}),
	);
}

function makeSuccessfulMemoryAddLayer(): Layer.Layer<CuratedMemory> {
	const entriesSnapshot = makeEmptySnapshot();
	const snapshot = makeEmptyMemorySnapshot();
	const defaultResult: MutationResult = {
		changedScope: "project",
		entry: makeEntry("abc123456789", "project", "test"),
	};

	return Layer.succeed(
		CuratedMemory,
		CuratedMemory.of({
			getSnapshot: () => Effect.succeed(snapshot),
			getEntriesSnapshot: () => Effect.succeed(entriesSnapshot),
			reloadFrozenSnapshot: () => Effect.void,
			getFrozenPromptBlock: Effect.succeed(""),
			add: () => Effect.succeed(defaultResult),
			update: () => Effect.die("not implemented in mock"),
			remove: () => Effect.die("not implemented in mock"),
			read: () => Effect.die("not implemented in mock"),
			setup: Effect.void,
		}),
	);
}

function makeMutatingFailingSubagent(): Layer.Layer<DreamSubagent> {
	return Layer.succeed(
		DreamSubagent,
		DreamSubagent.of({
			run: (request, _context, customTools) =>
				Effect.gen(function* () {
					const memoryTool = customTools.find((tool) => tool.name === "memory");
					if (memoryTool === undefined) {
						return yield* Effect.fail(
							new DreamSubagentSpawnFailed({ reason: "missing memory tool" }),
						);
					}

					yield* Effect.promise(() =>
						memoryTool.execute(
							"memory-call",
							{
								action: "add",
								target: "project",
								summary: "new summary",
								content: "new content",
							},
							new AbortController().signal,
							() => undefined,
							{} as Parameters<typeof memoryTool.execute>[4],
						),
					);

					return yield* Effect.fail(
						new DreamSubagentSpawnFailed({ reason: "subagent crashed after memory write" }),
					);
				}),
		}),
	);
}

function makeFailingMemoryNoFinishSubagent(): Layer.Layer<DreamSubagent> {
	return Layer.succeed(
		DreamSubagent,
		DreamSubagent.of({
			run: (_request, _context, customTools) =>
				Effect.gen(function* () {
					const memoryTool = customTools.find((tool) => tool.name === "memory");
					if (memoryTool === undefined) {
						return yield* Effect.fail(
							new DreamSubagentSpawnFailed({ reason: "missing memory tool" }),
						);
					}

					yield* Effect.promise(() =>
						memoryTool.execute(
							"memory-call",
							{
								action: "add",
								target: "project",
								summary: "new summary",
								content: "new content",
							},
							new AbortController().signal,
							() => undefined,
							{} as Parameters<typeof memoryTool.execute>[4],
						),
					);

					return {
						memoryMutations: 0,
					} satisfies DreamSubagentResult;
				}),
		}),
	);
}

const testRunnerConfig: DreamRunnerLiveConfig = {
	loadConfig: () => Effect.succeed(defaultConfig),
	modelRegistry: {
		getAll: () => [],
		find: () => undefined,
		getApiKey: () => Promise.resolve(null),
		getApiKeyForProvider: () => Promise.resolve(null),
		isUsingOAuth: () => false,
	} as unknown as import("@earendil-works/pi-coding-agent").ModelRegistry,
};

function runnerLayer(
	overrides: {
		config?: DreamRunnerLiveConfig;
		lock?: Layer.Layer<DreamLock>;
		scheduler?: Layer.Layer<DreamScheduler>;
		subagent?: Layer.Layer<DreamSubagent>;
		memory?: Layer.Layer<CuratedMemory>;
	} = {},
): Layer.Layer<DreamRunner> {
	return DreamRunnerLive(overrides.config ?? testRunnerConfig).pipe(
		Layer.provide(overrides.lock ?? makeMockLock()),
		Layer.provide(overrides.scheduler ?? makeMockScheduler()),
		Layer.provide(DreamTaskRegistryLive),
		Layer.provide(overrides.subagent ?? makeMockSubagent()),
		Layer.provide(overrides.memory ?? makeMockMemory()),
	);
}

function persistentRunnerLayer(
	overrides: Parameters<typeof runnerLayer>[0] = {},
): Layer.Layer<DreamRunner | DreamTaskRegistry> {
	const registryLayer = DreamTaskRegistryLive;
	const runnerWithRegistry = DreamRunnerLive(overrides.config ?? testRunnerConfig).pipe(
		Layer.provide(overrides.lock ?? makeMockLock()),
		Layer.provide(overrides.scheduler ?? makeMockScheduler()),
		Layer.provide(registryLayer),
		Layer.provide(overrides.subagent ?? makeMockSubagent()),
		Layer.provide(overrides.memory ?? makeMockMemory()),
	);

	return Layer.merge(registryLayer, runnerWithRegistry);
}

function runWithRunner<A, E>(
	effect: Effect.Effect<A, E, DreamRunner>,
	overrides?: Parameters<typeof runnerLayer>[0],
): Promise<A> {
	return Effect.runPromise(
		effect.pipe(Effect.provide(runnerLayer(overrides))),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DreamRunner", () => {
	describe("runOnce", () => {
		it("succeeds with no changes", async () => {
			const result = await runWithRunner(
				Effect.gen(function* () {
					const runner = yield* DreamRunner;
					return yield* runner.runOnce(defaultRequest);
				}),
				{
					subagent: makeMockSubagent({
						finishNoChanges: true,
						finishSummary: "Nothing to do",
					}),
				},
			);

			expect(result.mode).toBe("manual");
			expect(result.noChanges).toBe(true);
			expect(result.summary).toBe("Nothing to do");
		});

		it("reports memory mutations from the subagent", async () => {
			const result = await runWithRunner(
				Effect.gen(function* () {
					const runner = yield* DreamRunner;
					return yield* runner.runOnce(defaultRequest);
				}),
				{
					subagent: makeMockSubagent({
						memoryMutations: 3,
						finishSummary: "Added 3 facts",
					}),
				},
			);

			expect(result.memoryMutations).toBe(3);
			expect(result.summary).toBe("Added 3 facts");
			expect(result.reviewedSessions).toEqual([]);
		});

		it("fails when dream is disabled", async () => {
			const disabledConfig: DreamRunnerLiveConfig = {
				...testRunnerConfig,
				loadConfig: () =>
					Effect.succeed({ ...defaultConfig, enabled: false }),
			};

			const result = Effect.gen(function* () {
				const runner = yield* DreamRunner;
				return yield* runner.runOnce(defaultRequest);
			});

			await expect(
				runWithRunner(result, { config: disabledConfig }),
			).rejects.toThrow();
		});

		it("fails when manual mode is disabled for manual request", async () => {
			const config: DreamRunnerLiveConfig = {
				...testRunnerConfig,
				loadConfig: () =>
					Effect.succeed({
						...defaultConfig,
						manual: { enabled: false },
					}),
			};

			const result = Effect.gen(function* () {
				const runner = yield* DreamRunner;
				return yield* runner.runOnce(defaultRequest);
			});

			await expect(
				runWithRunner(result, { config }),
			).rejects.toThrow();
		});

		it("fails when the subagent exits without calling dream_finish", async () => {
			const result = Effect.gen(function* () {
				const runner = yield* DreamRunner;
				return yield* runner.runOnce(defaultRequest);
			});

			await expect(
				runWithRunner(result, {
					subagent: makeMockSubagent({ callFinish: false }),
				}),
			).rejects.toMatchObject({
				_tag: "DreamSubagentNoFinish",
				reason: "Dream subagent ended without calling dream_finish",
			});
		});

		it("does not advance the scheduler when failed memory writes are followed by missing dream_finish", async () => {
			const recordedRuns: DreamRunResult[] = [];
			const result = Effect.gen(function* () {
				const runner = yield* DreamRunner;
				return yield* runner.runOnce(defaultRequest);
			});

			await expect(
				runWithRunner(result, {
					scheduler: makeRecordingScheduler(recordedRuns),
					subagent: makeFailingMemoryNoFinishSubagent(),
					memory: makeFailingMemoryAddLayer(),
				}),
			).rejects.toMatchObject({
				_tag: "DreamSubagentNoFinish",
			});

			expect(recordedRuns).toHaveLength(0);
		});

		it("advances the scheduler when runOnce fails after a durable memory mutation", async () => {
			const recordedRuns: DreamRunResult[] = [];
			const result = Effect.gen(function* () {
				const runner = yield* DreamRunner;
				return yield* runner.runOnce(defaultRequest);
			});

			await expect(
				runWithRunner(result, {
					scheduler: makeRecordingScheduler(recordedRuns),
					subagent: makeMutatingFailingSubagent(),
					memory: makeSuccessfulMemoryAddLayer(),
				}),
			).rejects.toMatchObject({
				_tag: "DreamSubagentSpawnFailed",
				reason: "subagent crashed after memory write",
			});

			expect(recordedRuns).toHaveLength(1);
			expect(recordedRuns[0]?.memoryMutations).toBe(1);
			expect(recordedRuns[0]?.summary).toContain("Partial run");
		});
	});

	describe("spawnManual", () => {
		it("returns a task handle when dream startup succeeds", async () => {
			const handle = await runWithRunner(
				Effect.gen(function* () {
					const runner = yield* DreamRunner;
					return yield* runner.spawnManual(defaultRequest);
				}),
			);

			expect(handle.taskId).toMatch(/^[A-Za-z0-9_-]+$/);
		});

		it("continues running after spawnManual returns", async () => {
			const subagent = makeMockSubagent({
				finishSummary: "Done after delay",
			});

			const runtime = ManagedRuntime.make(
				persistentRunnerLayer({ subagent }),
			);

			try {
				const handle = await runtime.runPromise(
					Effect.gen(function* () {
						const runner = yield* DreamRunner;
						return yield* runner.spawnManual(defaultRequest);
					}),
				);

				await new Promise((resolve) => setTimeout(resolve, 50));

				const state = await runtime.runPromise(
					Effect.gen(function* () {
						const registry = yield* DreamTaskRegistry;
						return yield* registry.get(handle.taskId);
					}),
				);

				expect(state.phase).not.toBe("queued");
				expect(state.status).toBe("completed");
			} finally {
				await runtime.dispose();
			}
		});

		it("fails when lock is held", async () => {
			const lockLayer = makeMockLock({
				inspectResult: Option.some({
					path: "/tmp/test/.pi/tau/dream.lock",
					holderPid: 12345,
					acquiredAtMs: Date.now(),
				}),
			});

			const result = Effect.gen(function* () {
				const runner = yield* DreamRunner;
				return yield* runner.spawnManual(defaultRequest);
			});

			await expect(
				runWithRunner(result, { lock: lockLayer }),
			).rejects.toThrow();
		});

		it("fails when dream is disabled", async () => {
			const config: DreamRunnerLiveConfig = {
				...testRunnerConfig,
				loadConfig: () =>
					Effect.succeed({ ...defaultConfig, enabled: false }),
			};

			const result = Effect.gen(function* () {
				const runner = yield* DreamRunner;
				return yield* runner.spawnManual(defaultRequest);
			});

			await expect(
				runWithRunner(result, { config }),
			).rejects.toThrow();
		});
	});

	describe("maybeSpawnAuto", () => {
		it("returns None when auto gates fail", async () => {
			const scheduler = makeMockScheduler({
				evaluateAutoFail: new DreamDisabled({ mode: "auto" }),
			});

			const autoRequest: DreamRunRequest = {
				...defaultRequest,
				mode: "auto",
				requestedBy: "scheduler",
			};

			const result = await runWithRunner(
				Effect.gen(function* () {
					const runner = yield* DreamRunner;
					return yield* runner.maybeSpawnAuto(autoRequest);
				}),
				{ scheduler },
			);

			expect(Option.isNone(result)).toBe(true);
		});
	});
});
