import { Effect, Option, Schema } from "effect";
import { nanoid } from "nanoid";
import { Type, type Static } from "@sinclair/typebox";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { loadDreamConfig } from "./config-loader.js";
import {
	DreamFinishParams as DreamFinishParamsSchema,
	type DreamFinishParams,
	type DreamRunRequest,
	type DreamRunResult,
	type DreamTaskState,
} from "./domain.js";
import { DreamLock, type ManualDreamLease } from "./lock.js";
import { DreamRunner, DreamRunnerLive, type DreamRunnerApi } from "./runner.js";
import { DreamScheduler, type DreamSchedulerApi } from "./scheduler.js";
import { CuratedMemory } from "../services/curated-memory.js";
import { DreamTaskRegistry, type DreamTaskRegistryApi } from "./task-registry.js";
import type { DreamSubagent } from "./subagent.js";
import { buildDreamPrompt } from "./prompt.js";
import { setToolsEnabled } from "../shared/tool-activation.js";

type DreamRuntimeServices =
	| CuratedMemory
	| DreamLock
	| DreamScheduler
	| DreamSubagent
	| DreamTaskRegistry;

type RunDream = <A, E>(effect: Effect.Effect<A, E, DreamRuntimeServices>) => Promise<A>;

type DreamInitOptions = {
	readonly pollMs?: number;
	readonly maxPolls?: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly runner?: DreamRunnerApi;
	readonly registry?: DreamTaskRegistryApi;
};

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_POLLS = 300;
const DREAM_SCOPED_TOOLS = ["dream_finish"] as const;

// ---------------------------------------------------------------------------
// dream_finish tool params (foreground mode)
// ---------------------------------------------------------------------------

const DreamFinishToolParams = Type.Object({
	runId: Type.String({ description: "Foreground dream run id" }),
	summary: Type.String({ description: "Brief summary of what was found and changed" }),
	reviewedSessions: Type.Array(Type.String(), { description: "Session IDs reviewed" }),
	noChanges: Type.Boolean({ description: "True if no memory changes were made" }),
});

type DreamFinishToolParams = Static<typeof DreamFinishToolParams>;

const decodeDreamFinishParamsSync = Schema.decodeUnknownSync(DreamFinishParamsSchema);

const parseDreamFinishParams = (
	rawParams: unknown,
):
	| { readonly ok: true; readonly params: DreamFinishParams }
	| { readonly ok: false; readonly error: string } => {
	try {
		return {
			ok: true,
			params: decodeDreamFinishParamsSync(rawParams),
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: `Invalid dream_finish params: ${reason}`,
		};
	}
};

// ---------------------------------------------------------------------------
// Foreground run state
// ---------------------------------------------------------------------------

interface ForegroundDreamRun {
	readonly runId: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly startedAt: number;
	readonly lease: ManualDreamLease;
	/** Set by /dream cancel. Prevents dream_finish from recording completion. */
	cancelled: boolean;
	/** Set by dream_finish. Distinguishes clean finish from agent_end without finish. */
	finished: boolean;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export default function initDream(
	pi: ExtensionAPI,
	runEffect: RunDream,
	options?: DreamInitOptions,
): void {
	const pollMs = options?.pollMs ?? DEFAULT_POLL_MS;
	const maxPolls = options?.maxPolls ?? DEFAULT_MAX_POLLS;
	const sleep = options?.sleep ?? defaultSleep;
	const activeForegroundRuns = new Map<string, ForegroundDreamRun>();

	const syncDreamScopedToolAvailability = (
		ctx: ExtensionContext | ExtensionCommandContext,
	): void => {
		const sessionId = currentSessionIdOf(ctx);
		const run = sessionId === undefined ? undefined : activeForegroundRuns.get(sessionId);
		const enabled = run !== undefined && !run.cancelled && !run.finished;
		setToolsEnabled(pi, DREAM_SCOPED_TOOLS, enabled);
	};

	const withRunner = <A, E>(
		ctx: ExtensionContext | ExtensionCommandContext,
		f: (runner: DreamRunnerApi) => Effect.Effect<A, E, never>,
	): Promise<A> => {
		const effect = Effect.gen(function* () {
			const runner = yield* DreamRunner;
			return yield* f(runner);
		});

		if (options?.runner !== undefined) {
			return runEffect(effect.pipe(Effect.provideService(DreamRunner, DreamRunner.of(options.runner))));
		}

		return runEffect(
			effect.pipe(
				Effect.provide(
					DreamRunnerLive({
						loadConfig: loadDreamConfig,
						modelRegistry: ctx.modelRegistry,
					}),
				),
			),
		);
	};

	const withRegistry = <A, E>(
		f: (registry: DreamTaskRegistryApi) => Effect.Effect<A, E, never>,
	): Promise<A> => {
		const effect = Effect.gen(function* () {
			const registry = yield* DreamTaskRegistry;
			return yield* f(registry);
		});

		if (options?.registry !== undefined) {
			return runEffect(
				effect.pipe(
					Effect.provideService(DreamTaskRegistry, DreamTaskRegistry.of(options.registry)),
				),
			);
		}

		return runEffect(effect);
	};

	const withDreamData = <A, E>(
		f: (
			memory: CuratedMemory["Service"],
			scheduler: DreamSchedulerApi,
		) => Effect.Effect<A, E, never>,
	): Promise<A> =>
		runEffect(
			Effect.gen(function* () {
				const memory = yield* CuratedMemory;
				const scheduler = yield* DreamScheduler;
				return yield* f(memory, scheduler);
			}),
		);

	// ── dream_finish tool (foreground mode) ────────────────────────
	const dreamFinishTool = createDreamFinishTool({
		runEffect,
		activeForegroundRuns,
		syncDreamScopedToolAvailability,
	});
	pi.registerTool(dreamFinishTool);

	// ── /dream command ─────────────────────────────────────────────
	pi.registerCommand("dream", {
		description: "Run memory consolidation (dream)",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			if (args === "cancel") {
				const sessionId = currentSessionIdOf(ctx);
				if (sessionId === undefined) {
					if (ctx.hasUI) {
						ctx.ui.notify("Cannot cancel dream run: session id unavailable.", "warning");
					}
					return;
				}

				const active = activeForegroundRuns.get(sessionId);
				if (active === undefined) {
					if (ctx.hasUI) {
						ctx.ui.notify("No active foreground dream run.", "info");
					}
					return;
				}

				// Mark cancelled but keep lock held until agent_end to prevent
				// overlapping runs. The model may continue executing tool calls
				// until the agent turn ends, but dream_finish will reject.
				active.cancelled = true;
				syncDreamScopedToolAvailability(ctx);
				clearTaskStatus(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Dream cancelled (run ${active.runId}). Lock held until agent turn ends.`,
						"info",
					);
				}
				return;
			}

			if (args.length > 0) {
				if (ctx.hasUI) {
					ctx.ui.notify("Usage: /dream or /dream cancel", "warning");
				}
				return;
			}

			if (options?.runner === undefined && !ctx.isIdle()) {
				if (ctx.hasUI) {
					ctx.ui.notify("Dream starts when the agent is idle. Wait for the current response to finish.", "warning");
				}
				return;
			}

			try {
				if (options?.runner !== undefined) {
					const handle = await withRunner(ctx, (runner) => runner.spawnManual(makeRunRequest(ctx, "manual", "user")));

					if (ctx.hasUI) {
						ctx.ui.notify(
							`Dream started (task ${handle.taskId}). Running in foreground with live progress updates.`,
							"info",
						);
					}

					await pollTaskCompletion(ctx, handle.taskId, {
						verboseProgress: true,
					});
					return;
				}

				const sessionId = currentSessionIdOf(ctx);
				if (sessionId === undefined) {
					if (ctx.hasUI) {
						ctx.ui.notify("Dream cannot start: session id unavailable.", "warning");
					}
					return;
				}

				const existingRun = activeForegroundRuns.get(sessionId);
				if (existingRun !== undefined) {
					if (ctx.hasUI) {
						ctx.ui.notify(`Dream already running (run ${existingRun.runId}). Use /dream cancel first.`, "warning");
					}
					return;
				}

				const config = await Effect.runPromise(loadDreamConfig(ctx.cwd));
				if (!config.enabled || !config.manual.enabled) {
					if (ctx.hasUI) {
						ctx.ui.notify("Dream is disabled for manual mode in settings.", "warning");
					}
					return;
				}

				// Acquire lock
				let lease: ManualDreamLease;
				try {
					lease = await runEffect(
						Effect.gen(function* () {
							const dreamLock = yield* DreamLock;
							return yield* dreamLock.acquireManual(ctx.cwd);
						}),
					);
				} catch (lockError) {
					if (ctx.hasUI) {
						ctx.ui.notify(describeError(lockError), "warning");
					}
					return;
				}

				const memorySnapshot = await withDreamData((memory) => memory.getEntriesSnapshot(ctx.cwd));

				const run: ForegroundDreamRun = {
					runId: nanoid(12),
					sessionId,
					cwd: ctx.cwd,
					startedAt: Date.now(),
					lease,
					cancelled: false,
					finished: false,
				};

				activeForegroundRuns.set(sessionId, run);
				syncDreamScopedToolAvailability(ctx);
				if (ctx.hasUI) {
					ctx.ui.setStatus("dream", `dream: foreground run ${run.runId}`);
					ctx.ui.notify(`Dream started (run ${run.runId}).`, "info");
				}

				pi.sendUserMessage(
					buildDreamPrompt({
						runId: run.runId,
						mode: "manual",
						nowIso: new Date().toISOString(),
						memorySnapshot,
					}),
					{ deliverAs: "followUp" },
				);
				return;
			} catch (error) {
				if (ctx.hasUI) {
					ctx.ui.notify(describeError(error), "warning");
				}
			}
		},
	});

	// ── Auto-dream event handlers ──────────────────────────────────
	const autoSpawnHandler = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		syncDreamScopedToolAvailability(ctx);
		await tryAutoSpawn(ctx, { awaitCompletion: false });
	};

	const shutdownAutoSpawnHandler = async (
		_event: unknown,
		ctx: ExtensionContext,
	): Promise<void> => {
		const sessionId = currentSessionIdOf(ctx);
		if (sessionId !== undefined) {
			const run = activeForegroundRuns.get(sessionId);
			if (run !== undefined) {
				await releaseForegroundRun(runEffect, activeForegroundRuns, sessionId);
				clearTaskStatus(ctx);

				if (!run.cancelled && !run.finished && ctx.hasUI) {
					ctx.ui.notify(
						`Dream aborted: run ${run.runId} ended during session shutdown before dream_finish.`,
						"warning",
					);
				}
			}
		}

		syncDreamScopedToolAvailability(ctx);
		await tryAutoSpawn(ctx, { awaitCompletion: true });
	};

	pi.on("session_start", autoSpawnHandler);
	pi.on("before_agent_start", async (_event, ctx) => {
		syncDreamScopedToolAvailability(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		const sessionId = currentSessionIdOf(ctx);
		if (sessionId !== undefined) {
			const run = activeForegroundRuns.get(sessionId);
			if (run !== undefined) {
				await releaseForegroundRun(runEffect, activeForegroundRuns, sessionId);
				clearTaskStatus(ctx);

				if (run.cancelled) {
					// Already notified at cancel time, nothing more to say
				} else if (run.finished) {
					// Clean completion, dream_finish already showed the result
				} else if (ctx.hasUI) {
					ctx.ui.notify(
						`Dream failed: run ${run.runId} ended without dream_finish.`,
						"warning",
					);
				}
			}
		}
		syncDreamScopedToolAvailability(ctx);
		await autoSpawnHandler(_event, ctx);
	});
	pi.on("session_shutdown", shutdownAutoSpawnHandler);

	async function tryAutoSpawn(
		ctx: ExtensionContext,
		options: { readonly awaitCompletion: boolean },
	): Promise<void> {
		try {
			const result = await withRunner(ctx, (runner) => runner.maybeSpawnAuto(makeRunRequest(ctx, "auto", "scheduler")));

			if (Option.isSome(result)) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Auto-dream started (task ${result.value.taskId})`, "info");
				}

				if (options.awaitCompletion) {
					await pollTaskCompletion(ctx, result.value.taskId, {
						verboseProgress: false,
					});
				} else {
					void pollTaskCompletion(ctx, result.value.taskId, {
						verboseProgress: false,
					});
				}
			}
		} catch (error) {
			void runEffect(Effect.logDebug(`dream auto gate closed: ${describeError(error)}`)).catch(() => undefined);
		}
	}

	async function pollTaskCompletion(
		ctx: ExtensionContext,
		taskId: string,
		options: {
			readonly verboseProgress: boolean;
		},
	): Promise<void> {
		let lastNotifiedPhase: DreamTaskState["phase"] | undefined;
		let lastNotifiedMessage: string | undefined;

		for (let pollIndex = 0; pollIndex < maxPolls; pollIndex += 1) {
			await sleep(pollMs);

			try {
				const state = await withRegistry((registry) => registry.get(taskId));
				updateTaskStatus(ctx, state);

				if (options.verboseProgress && ctx.hasUI) {
					if (state.phase !== lastNotifiedPhase) {
						lastNotifiedPhase = state.phase;
						ctx.ui.notify(`Dream phase: ${state.phase}`, "info");
					}

					if (state.latestMessage !== undefined && state.latestMessage !== lastNotifiedMessage) {
						lastNotifiedMessage = state.latestMessage;
						ctx.ui.notify(`Dream: ${state.latestMessage}`, "info");
					}
				}

				if (state.status === "completed") {
					clearTaskStatus(ctx);
					if (ctx.hasUI) {
						ctx.ui.notify(formatCompletion(state), "info");
					}
					return;
				}

				if (state.status === "failed" || state.status === "cancelled") {
					clearTaskStatus(ctx);
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Dream ${state.status}: ${state.latestMessage ?? "no details"}`,
							"warning",
						);
					}
					return;
				}
			} catch {
				clearTaskStatus(ctx);
				return;
			}
		}

		clearTaskStatus(ctx);
	}
}

// ---------------------------------------------------------------------------
// dream_finish tool implementation (foreground)
// ---------------------------------------------------------------------------

type DreamFinishToolDeps = {
	readonly runEffect: RunDream;
	readonly activeForegroundRuns: Map<string, ForegroundDreamRun>;
	readonly syncDreamScopedToolAvailability: (
		ctx: ExtensionContext | ExtensionCommandContext,
	) => void;
};

function createDreamFinishTool(
	deps: DreamFinishToolDeps,
): ToolDefinition<typeof DreamFinishToolParams> {
	return {
		name: "dream_finish",
		label: "dream_finish",
		description: "Signal that the foreground dream memory consolidation run is complete. Call this after all memory mutations are done.",
		parameters: DreamFinishToolParams,
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const decoded = parseDreamFinishParams(rawParams);
			if (!decoded.ok) {
				return {
					isError: true,
					content: [{ type: "text", text: decoded.error }],
					details: {},
				};
			}

			const params = decoded.params;
			const sessionId = currentSessionIdOf(ctx);
			if (sessionId === undefined) {
				return {
					isError: true,
					content: [{ type: "text", text: "No active session id found for dream_finish." }],
					details: {},
				};
			}

			const run = deps.activeForegroundRuns.get(sessionId);
			if (run === undefined) {
				return {
					isError: true,
					content: [{ type: "text", text: "No active foreground dream run for this session." }],
					details: {},
				};
			}

			if (run.cancelled) {
				return {
					isError: true,
					content: [{ type: "text", text: "Dream run was cancelled. Stop processing." }],
					details: {},
				};
			}

			if (run.finished) {
				return {
					isError: true,
					content: [{ type: "text", text: "dream_finish already called for this run." }],
					details: {},
				};
			}

			if (params.runId !== run.runId) {
				return {
					isError: true,
					content: [{ type: "text", text: `Run id mismatch. Expected ${run.runId}, received ${params.runId}.` }],
					details: {},
				};
			}

			try {
				// Mark finished BEFORE doing bookkeeping so subsequent memory
				// calls in the same turn see the flag via the cancelled/finished
				// check above (dream_finish rejects double-calls).
				run.finished = true;
				deps.syncDreamScopedToolAvailability(ctx);

				// Mark scheduler complete and reload frozen snapshot
				await deps.runEffect(
					Effect.gen(function* () {
						const memory = yield* CuratedMemory;
						const scheduler = yield* DreamScheduler;

						yield* memory.reloadFrozenSnapshot(run.cwd);

						const finishedAt = Date.now();
						const runResult: DreamRunResult = {
							mode: "manual",
							startedAt: run.startedAt,
							finishedAt,
							summary: params.summary,
							reviewedSessions: params.reviewedSessions,
							memoryMutations: 0, // not tracked in foreground; mutations already happened visibly
							noChanges: params.noChanges,
						};

						yield* scheduler.markCompleted(run.cwd, runResult);
					}),
				);

				// Do NOT release lock or remove from map here.
				// Lock is released in the agent_end handler to prevent
				// post-finish memory mutations from racing with a new dream run.
				clearTaskStatus(ctx);

				return {
					content: [
						{
							type: "text",
							text: `Dream complete: reviewed ${params.reviewedSessions.length} session(s). ${params.summary}. Do not make further memory changes.`,
						},
					],
					details: {},
				};
			} catch (error) {
				// Revert finished flag so agent_end reports failure correctly
				run.finished = false;
				deps.syncDreamScopedToolAvailability(ctx);
				return {
					isError: true,
					content: [{ type: "text", text: `dream_finish failed: ${describeError(error)}` }],
					details: {},
				};
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Foreground lock release helper
// ---------------------------------------------------------------------------

async function releaseForegroundRun(
	runEffect: RunDream,
	activeForegroundRuns: Map<string, ForegroundDreamRun>,
	sessionId: string,
): Promise<void> {
	const run = activeForegroundRuns.get(sessionId);
	if (run === undefined) {
		return;
	}

	activeForegroundRuns.delete(sessionId);

	try {
		await runEffect(
			Effect.gen(function* () {
				const dreamLock = yield* DreamLock;
				yield* dreamLock.releaseManual(run.lease);
			}),
		);
	} catch {
		// Best-effort lock release
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunRequest(
	ctx: ExtensionContext | ExtensionCommandContext,
	mode: DreamRunRequest["mode"],
	requestedBy: DreamRunRequest["requestedBy"],
): DreamRunRequest {
	const currentSessionId = currentSessionIdOf(ctx);

	return {
		cwd: ctx.cwd,
		mode,
		requestedBy,
		...(currentSessionId === undefined ? {} : { currentSessionId }),
	};
}

function currentSessionIdOf(ctx: ExtensionContext | ExtensionCommandContext): string | undefined {
	const sessionId = ctx.sessionManager?.getSessionId?.();
	return typeof sessionId === "string" ? sessionId : undefined;
}

function updateTaskStatus(ctx: ExtensionContext, state: DreamTaskState): void {
	if (!ctx.hasUI) {
		return;
	}

	const mutations = state.memoryMutations > 0
		? ` (${state.memoryMutations} mutations)`
		: "";
	ctx.ui.setStatus("dream", `dream: ${state.phase}${mutations}`);
	if (typeof ctx.ui.setWidget === "function") {
		ctx.ui.setWidget("dream", dreamWidgetLines(state));
	}
}

function clearTaskStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) {
		return;
	}

	ctx.ui.setStatus("dream", undefined);
	if (typeof ctx.ui.setWidget === "function") {
		ctx.ui.setWidget("dream", undefined);
	}
}

function formatCompletion(state: DreamTaskState): string {
	const base = `Dream complete: reviewed ${state.sessionsReviewed} session(s), ${state.memoryMutations} memory mutation(s).`;
	if (state.latestMessage) {
		return `${base} ${state.latestMessage}`;
	}
	return base;
}

function dreamWidgetLines(state: DreamTaskState): string[] {
	return [
		"Dream",
		`Mode: ${state.mode}`,
		`Phase: ${state.phase}`,
		`Sessions: ${state.sessionsReviewed}/${state.sessionsDiscovered}`,
		`Mutations: ${state.memoryMutations}`,
		`Status: ${state.status}`,
		...(state.latestMessage === undefined ? [] : [`Note: ${state.latestMessage}`]),
	];
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

function describeError(error: unknown): string {
	if (typeof error !== "object" || error === null || !("_tag" in error)) {
		return `Dream failed: ${String(error)}`;
	}

	const tagged = error as { readonly _tag: string; readonly mode?: string };
	if (tagged._tag === "DreamDisabled") {
		return `Dream is disabled${tagged.mode === undefined ? "" : ` (mode: ${tagged.mode})`}. Enable it in settings.json under tau.dream.enabled`;
	}

	if (tagged._tag === "DreamLockHeld") {
		return "Another dream run is already in progress.";
	}

	if (tagged._tag === "DreamConfigDecodeError") {
		const reason = "reason" in error ? String((error as { reason: unknown }).reason) : String(error);
		return `Dream configuration error: ${reason}`;
	}

	if (tagged._tag === "DreamConfigMissingModel") {
		return "Dream configuration error: missing tau.dream.subagent.model";
	}

	if (tagged._tag === "DreamConfigInvalidThreshold") {
		const field = "field" in error ? String((error as { field: unknown }).field) : "unknown";
		const value = "value" in error ? String((error as { value: unknown }).value) : "unknown";
		return `Dream configuration error: invalid value for ${field} (${value})`;
	}

	if (tagged._tag === "DreamSubagentSpawnFailed" || tagged._tag === "DreamSubagentNoFinish") {
		const reason = "reason" in error ? (error as { reason: string }).reason : tagged._tag;
		return `Dream failed: ${reason}`;
	}

	return `Dream failed: ${tagged._tag}`;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export { describeError as _describeDreamError };
