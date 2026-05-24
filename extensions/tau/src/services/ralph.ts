import * as path from "node:path";

import { Clock, Deferred, Effect, Layer, Option, Ref, Context } from "effect";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";

import type { ExecutionProfile } from "../execution/schema.js";
import type { ResolvedSandboxConfig } from "../sandbox/config.js";
import {
	LoopAmbiguousOwnershipError,
	LoopContractValidationError,
	LoopLifecycleConflictError,
	LoopOwnershipValidationError,
	LoopTaskAlreadyExistsError,
	LoopTaskNotFoundError,
	type LoopEngineError,
} from "../loops/errors.js";
import type { LoopSessionRef } from "../loops/schema.js";
import { RalphRepo } from "../ralph/repo.js";
import { RALPH_TASKS_DIR } from "../ralph/paths.js";
import { RalphContractValidationError } from "../ralph/errors.js";
import type { LoopState, RalphPendingDecision } from "../ralph/schema.js";
import type { RalphLoopMetrics } from "../ralph/schema.js";
import type { RalphCapabilityContract } from "../ralph/contract.js";
import { resolveLoopWorkspaceRoot } from "../loops/workspace-root.js";
import {
	applyRalphConfigMutation,
	makeRalphLoopConfigService,
	type RalphConfigResult,
	type RalphConfigError,
	type RalphConfigMutation,
} from "../ralph/config-service.js";
import { StorageError } from "../shared/atomic-write.js";
import { LoopEngine } from "./loop-engine.js";

type LoopStepResult =
	| {
			readonly _tag: "continue";
	  }
	| {
			readonly _tag: "blocked";
			readonly message: string;
	  }
	| {
			readonly _tag: "stopped";
			readonly message: Option.Option<string>;
			readonly banner: Option.Option<string>;
	  };

const continueLoop: LoopStepResult = { _tag: "continue" };

type CurrentLoopRef = {
	readonly root: string;
	readonly loopName: string;
};

type RalphRunLoopResult = {
	readonly status: "blocked" | "stopped";
	readonly message: Option.Option<string>;
	readonly banner: Option.Option<string>;
};

type RalphContinueResult = {
	readonly text: string;
};

type RalphFinishResult = {
	readonly text: string;
};

type RalphAgentEndResult = {
	readonly consumedByWaitingLoop: boolean;
	readonly banner: Option.Option<string>;
};

type RalphStartLoopInput = {
	readonly loopName: string;
	readonly taskFile: string;
	readonly executionProfile: ExecutionProfile;
	readonly sandboxProfile: ResolvedSandboxConfig;
	readonly maxIterations: number;
	readonly itemsPerIteration: number;
	readonly reflectEvery: number;
	readonly reflectInstructions: string;
	readonly controllerSessionFile: Option.Option<string>;
	readonly defaultTaskTemplate: string;
	readonly capabilityContract?: import("../ralph/contract.js").RalphCapabilityContract;
	readonly overrides?: {
		readonly maxIterations: boolean;
		readonly itemsPerIteration: boolean;
		readonly reflectEvery: boolean;
		readonly reflectInstructions: boolean;
	};
};

type RalphStartLoopStateResult =
	| {
			readonly status: "started";
			readonly loopName: string;
			readonly taskFile: string;
			readonly createdTask: boolean;
			readonly maxIterations: number;
	  }
	| {
			readonly status: "already_active";
			readonly loopName: string;
	  }
	| {
			readonly status: "missing_controller_session";
	  };

type RalphPrepareLoopTaskInput = {
	readonly loopName: string;
	readonly taskContent: string;
};

type RalphPrepareLoopTaskResult =
	| {
			readonly status: "prepared";
			readonly taskFile: string;
	  }
	| {
			readonly status: "already_active";
			readonly loopName: string;
	  };

type RalphCreateDraftLoopForConfigurationInput = {
	readonly loopName: string;
	readonly taskFile: string;
	readonly taskContent: string;
	readonly executionProfile: ExecutionProfile;
	readonly sandboxProfile: ResolvedSandboxConfig;
	readonly maxIterations: number;
	readonly itemsPerIteration: number;
	readonly reflectEvery: number;
	readonly reflectInstructions: string;
	readonly capabilityContract: RalphCapabilityContract;
};

type RalphCreateDraftLoopForConfigurationResult = {
	readonly loop: LoopState;
	readonly createdState: boolean;
};

type RalphPauseCurrentLoopResult =
	| {
			readonly status: "paused";
			readonly loopName: string;
			readonly iteration: number;
	  }
	| {
			readonly status: "no_active_loop";
	  }
	| {
			readonly status: "missing_current_loop_state";
	  };

export type RalphStopLoopResult =
	| {
			readonly status: "stopped";
			readonly loopName: string;
			readonly iteration: number;
	  }
	| {
			readonly status: "no_active_loop";
	  }
	| {
			readonly status: "not_active";
			readonly loopName: string;
	  };

type RalphResumeLoopStateResult =
	| {
			readonly status: "resumed";
			readonly loopName: string;
	  }
	| {
			readonly status: "not_found";
	  }
	| {
			readonly status: "max_iterations_reached";
			readonly loopName: string;
			readonly iteration: number;
			readonly maxIterations: number;
	  }
	| {
			readonly status: "max_iterations_too_low";
			readonly loopName: string;
			readonly iteration: number;
			readonly requestedMaxIterations: number;
	  };

type RalphResumeLoopInput = {
	readonly loopName: string;
	readonly maxIterations: Option.Option<number>;
};

type RalphCancelLoopResult =
	| {
			readonly status: "cancelled";
	  }
	| {
			readonly status: "not_found";
	  };

type RalphArchiveLoopByNameResult =
	| {
			readonly status: "archived";
	  }
	| {
			readonly status: "not_found";
	  }
	| {
			readonly status: "active_loop";
	  };

type RalphCleanCompletedLoopsResult = {
	readonly cleanedLoops: ReadonlyArray<string>;
};

type RalphNukeLoopsResult = {
	readonly removed: boolean;
};

export type RalphCommandBoundary = {
	readonly cwd: string;
	readonly getSessionFile: () => string | undefined;
	readonly switchSession: (
		targetSessionFile: string,
	) => Effect.Effect<{ readonly cancelled: boolean }, never, never>;
	readonly newSession: (options: {
		readonly parentSession: string;
		readonly sandboxProfile: ResolvedSandboxConfig;
	}) => Effect.Effect<{ readonly cancelled: boolean }, never, never>;
	readonly captureSandboxProfile: Effect.Effect<ResolvedSandboxConfig, never, never>;
	readonly applyExecutionProfile: (
		profile: ExecutionProfile,
	) => Effect.Effect<{ readonly applied: boolean; readonly reason?: string }, never, never>;
	readonly applyCapabilityContract: (
		contract: RalphCapabilityContract,
		target: "controller" | "child",
	) => Effect.Effect<{ readonly applied: boolean; readonly reason?: string }, never, never>;
	readonly sendFollowUp: (
		prompt: string,
	) => Effect.Effect<{ readonly dispatched: boolean; readonly reason?: string }, never, never>;
};

interface RalphLiveConfig {
	readonly hasActiveSubagents: () => Effect.Effect<boolean, never, never>;
}

type IterationSignal =
	| {
			readonly _tag: "agent_end";
			readonly event: AgentEndEvent;
	  }
	| {
			readonly _tag: "session_shutdown";
	  };

type RalphIterationSignalBridgeEntry =
	| {
			readonly _tag: "queued";
			readonly signal: IterationSignal;
	  }
	| {
			readonly _tag: "waiting";
			readonly deferred: Deferred.Deferred<IterationSignal>;
	  };

const RALPH_ITERATION_SIGNAL_BRIDGE_GLOBAL = "__tau_ralph_iteration_signal_bridge";

type RalphSignalBridgeGlobalState = typeof globalThis & {
	[RALPH_ITERATION_SIGNAL_BRIDGE_GLOBAL]?: Map<string, RalphIterationSignalBridgeEntry>;
};

function getRalphIterationSignalBridge(): Map<string, RalphIterationSignalBridgeEntry> {
	const globalState = globalThis as RalphSignalBridgeGlobalState;
	const existing = globalState[RALPH_ITERATION_SIGNAL_BRIDGE_GLOBAL];
	if (existing) {
		return existing;
	}
	const registry = new Map<string, RalphIterationSignalBridgeEntry>();
	globalState[RALPH_ITERATION_SIGNAL_BRIDGE_GLOBAL] = registry;
	return registry;
}

function resetRalphIterationSignalBridge(): void {
	getRalphIterationSignalBridge().clear();
}

export function resetRalphIterationSignalBridgeForTests(): void {
	resetRalphIterationSignalBridge();
}

type AssistantStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

type AssistantSummary = {
	readonly text: string;
	readonly stopReason: Option.Option<AssistantStopReason>;
	readonly errorMessage: Option.Option<string>;
	readonly hasUsableAssistantMessage: boolean;
};

function isAssistantStopReason(value: unknown): value is AssistantStopReason {
	return (
		value === "stop" ||
		value === "length" ||
		value === "toolUse" ||
		value === "error" ||
		value === "aborted"
	);
}

const extractLastAssistantSummary = (event: AgentEndEvent): AssistantSummary => {
	const lastAssistant = [...event.messages]
		.reverse()
		.find((message) => message.role === "assistant");
	if (!lastAssistant || !Array.isArray(lastAssistant.content)) {
		return {
			text: "",
			stopReason: Option.none(),
			errorMessage: Option.none(),
			hasUsableAssistantMessage: false,
		};
	}
	const text = lastAssistant.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n");
	const stopReason =
		"stopReason" in lastAssistant && isAssistantStopReason(lastAssistant.stopReason)
			? Option.some(lastAssistant.stopReason)
			: Option.none<AssistantStopReason>();
	const errorMessage =
		"errorMessage" in lastAssistant && typeof lastAssistant.errorMessage === "string"
			? Option.some(lastAssistant.errorMessage)
			: Option.none<string>();
	return {
		text,
		stopReason,
		errorMessage,
		hasUsableAssistantMessage: true,
	};
};

const AUTO_RECOVERABLE_ERROR_PATTERNS = [
	/overloaded/i,
	/provider.?returned.?error/i,
	/rate.?limit/i,
	/too many requests/i,
	/\b429\b/,
	/\b50[0234]\b/,
	/service.?unavailable/i,
	/server.?error/i,
	/internal.?error/i,
	/network.?error/i,
	/connection.?error/i,
	/connection.?refused/i,
	/connection.?lost/i,
	/other side closed/i,
	/fetch failed/i,
	/upstream.?connect/i,
	/reset before headers/i,
	/socket hang up/i,
	/ended without/i,
	/http2 request did not get a response/i,
	/timed? out/i,
	/timeout/i,
	/terminated/i,
	/retry delay/i,
	/prompt is too long/i,
	/request_too_large/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds the limit of \d+/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/too large for model with \d+ maximum context length/i,
	/model_context_window_exceeded/i,
	/prompt too long; exceeded (?:max )?context length/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
];

function isAutomaticallyRecoverableAssistantError(summary: AssistantSummary): boolean {
	if (Option.isNone(summary.errorMessage)) {
		return false;
	}
	const message = summary.errorMessage.value;
	return AUTO_RECOVERABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

const optionContains = (option: Option.Option<string>, value: string | undefined): boolean => {
	if (value === undefined) {
		return false;
	}
	return Option.match(option, {
		onNone: () => false,
		onSome: (optionValue) => optionValue === value,
	});
};

const toContractError = (entity: string, reason: string): RalphContractValidationError =>
	new RalphContractValidationError({
		entity,
		reason,
	});

const loopEngineErrorToContract = (error: LoopEngineError): RalphContractValidationError => {
	if (error instanceof LoopContractValidationError) {
		return toContractError(error.entity, error.reason);
	}
	if (error instanceof LoopTaskNotFoundError) {
		return toContractError("loops.state", `task "${error.taskId}" not found`);
	}
	if (error instanceof LoopTaskAlreadyExistsError) {
		return toContractError("loops.state", `task "${error.taskId}" already exists`);
	}
	if (error instanceof LoopLifecycleConflictError) {
		return toContractError(
			"loops.lifecycle",
			`task "${error.taskId}" expected ${error.expected}, got ${error.actual}`,
		);
	}
	if (error instanceof LoopOwnershipValidationError) {
		return toContractError("loops.ownership", error.reason);
	}
	if (error instanceof LoopAmbiguousOwnershipError) {
		return toContractError(
			"loops.ownership",
			`session ${error.sessionFile} matches multiple loops: ${error.matchingTaskIds.join(", ")}`,
		);
	}
	return toContractError("loops.engine", String(error));
};

const mapLoopEngineError = <A>(
	effect: Effect.Effect<A, LoopEngineError, never>,
): Effect.Effect<A, RalphContractValidationError, never> =>
	effect.pipe(Effect.mapError(loopEngineErrorToContract));

const ralphRepoErrorToContract = (
	error: RalphContractValidationError | StorageError,
): RalphContractValidationError =>
	error instanceof StorageError
		? toContractError("ralph.storage", `${error.reason} (${error.path})`)
		: error;

const mapRalphRepoError = <A>(
	effect: Effect.Effect<A, RalphContractValidationError | StorageError, never>,
): Effect.Effect<A, RalphContractValidationError, never> =>
	effect.pipe(Effect.mapError(ralphRepoErrorToContract));

const sessionRefFromFile = (sessionFile: string): LoopSessionRef => ({
	sessionId: sessionFile,
	sessionFile,
});

const nowIso = Effect.gen(function* () {
	const millis = yield* Clock.currentTimeMillis;
	return new Date(millis).toISOString();
});

function buildPrompt(state: LoopState, taskContent: string, isReflection: boolean): string {
	const maxStr = state.maxIterations > 0 ? `/${state.maxIterations}` : "";
	const header = `───────────────────────────────────────────────────────────────────────
🔄 RALPH LOOP: ${state.name} | Iteration ${state.iteration}${maxStr}${isReflection ? " | 🪞 REFLECTION" : ""}
───────────────────────────────────────────────────────────────────────`;

	const parts = [header, ""];
	if (isReflection) {
		parts.push(state.reflectInstructions, "\n---\n");
	}

	parts.push(`## Current Task (from ${state.taskFile})\n\n${taskContent}\n\n---`);
	parts.push(`\n## Instructions\n`);
	parts.push(
		`You are in a Ralph loop (iteration ${state.iteration}${state.maxIterations > 0 ? ` of ${state.maxIterations}` : ""}).\n`,
	);

	if (state.itemsPerIteration > 0) {
		parts.push(
			`**THIS ITERATION: Process approximately ${state.itemsPerIteration} items, then end with exactly one Ralph loop tool.**\n`,
		);
		parts.push(`1. Work on the next ~${state.itemsPerIteration} items from your checklist`);
	} else {
		parts.push(`1. Continue working on the task`);
	}

	parts.push(`2. Update the task file (${state.taskFile}) with your progress`);
	parts.push(
		`3. If the overall Ralph loop is complete, call ralph_finish with a short completion message`,
	);
	parts.push(`4. If this iteration is done and Ralph should continue, call ralph_continue`);
	parts.push(
		`5. End this iteration with exactly one Ralph loop tool.`,
	);
	parts.push(
		`6. Correct recoverable tool input or usage errors and continue the iteration.`,
	);

	return parts.join("\n");
}

export interface RalphService {
	readonly startLoopState: (
		cwd: string,
		input: RalphStartLoopInput,
	) => Effect.Effect<RalphStartLoopStateResult, RalphContractValidationError, never>;
	readonly prepareLoopTask: (
		cwd: string,
		input: RalphPrepareLoopTaskInput,
	) => Effect.Effect<RalphPrepareLoopTaskResult, RalphContractValidationError, never>;
	readonly createDraftLoopForConfiguration: (
		cwd: string,
		input: RalphCreateDraftLoopForConfigurationInput,
	) => Effect.Effect<
		RalphCreateDraftLoopForConfigurationResult,
		RalphContractValidationError,
		never
	>;
	readonly listLoops: (
		cwd: string,
		archived?: boolean,
	) => Effect.Effect<ReadonlyArray<LoopState>, RalphContractValidationError, never>;
	readonly findLoopBySessionFile: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<Option.Option<LoopState>, RalphContractValidationError, never>;
	readonly resolveLoopForUi: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<Option.Option<LoopState>, RalphContractValidationError, never>;
	readonly pauseCurrentLoop: (
		cwd: string,
	) => Effect.Effect<RalphPauseCurrentLoopResult, RalphContractValidationError, never>;
	readonly stopActiveLoop: (
		cwd: string,
	) => Effect.Effect<RalphStopLoopResult, RalphContractValidationError, never>;
	readonly resumeLoopState: (
		cwd: string,
		input: RalphResumeLoopInput,
	) => Effect.Effect<RalphResumeLoopStateResult, RalphContractValidationError, never>;
	readonly cancelLoop: (
		cwd: string,
		loopName: string,
	) => Effect.Effect<RalphCancelLoopResult, RalphContractValidationError, never>;
	readonly archiveLoopByName: (
		cwd: string,
		loopName: string,
	) => Effect.Effect<RalphArchiveLoopByNameResult, RalphContractValidationError, never>;
	readonly cleanCompletedLoops: (
		cwd: string,
		all: boolean,
	) => Effect.Effect<RalphCleanCompletedLoopsResult, RalphContractValidationError, never>;
	readonly nukeLoops: (
		cwd: string,
	) => Effect.Effect<RalphNukeLoopsResult, RalphContractValidationError, never>;
	readonly syncCurrentLoopFromSession: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<void, RalphContractValidationError, never>;
	readonly existsRalphDirectory: (
		cwd: string,
	) => Effect.Effect<boolean, RalphContractValidationError, never>;
	readonly persistOwnedLoopOnShutdown: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<void, RalphContractValidationError, never>;
	readonly runLoop: (
		boundary: RalphCommandBoundary,
		loopName: string,
	) => Effect.Effect<RalphRunLoopResult, RalphContractValidationError, never>;
	readonly recordContinue: (
		cwd: string,
		sessionFile: string | undefined,
	) => Effect.Effect<RalphContinueResult, RalphContractValidationError, never>;
	readonly recordFinish: (
		cwd: string,
		sessionFile: string | undefined,
		message: string,
	) => Effect.Effect<RalphFinishResult, RalphContractValidationError, never>;
	readonly handleAgentEnd: (
		cwd: string,
		sessionFile: string | undefined,
		event: AgentEndEvent,
	) => Effect.Effect<RalphAgentEndResult, RalphContractValidationError, never>;
	readonly configureLoop: (
		cwd: string,
		loopName: string,
		mutation: RalphConfigMutation,
	) => Effect.Effect<RalphConfigResult, RalphConfigError, never>;
	readonly configureLoopMany: (
		cwd: string,
		loopName: string,
		mutations: ReadonlyArray<RalphConfigMutation>,
	) => Effect.Effect<RalphConfigResult, RalphConfigError, never>;
	readonly recaptureLoopExecutionProfile: (
		cwd: string,
		loopName: string,
		profile: ExecutionProfile,
	) => Effect.Effect<RalphConfigResult, RalphConfigError, never>;
	readonly recaptureLoopSandboxProfile: (
		cwd: string,
		loopName: string,
		profile: ResolvedSandboxConfig,
	) => Effect.Effect<RalphConfigResult, RalphConfigError, never>;
}

export class Ralph extends Context.Service<Ralph, RalphService>()("Ralph") {}

const stopWithMessage = (message: string): LoopStepResult => ({
	_tag: "stopped",
	message: Option.some(message),
	banner: Option.none(),
});

const blockedWithMessage = (message: string): LoopStepResult => ({
	_tag: "blocked",
	message,
});

const stoppedWithoutMessage: LoopStepResult = {
	_tag: "stopped",
	message: Option.none(),
	banner: Option.none(),
};

const finishBanner = (state: LoopState, message: string): string =>
	`───────────────────────────────────────────────────────────────────────\n✅ RALPH LOOP COMPLETE: ${state.name} | ${state.iteration} iterations\n───────────────────────────────────────────────────────────────────────\n${message}`;

const setPendingDecision = (state: LoopState, decision: RalphPendingDecision): void => {
	state.pendingDecision = Option.some(decision);
};

const clearPendingDecision = (state: LoopState): void => {
	state.pendingDecision = Option.none();
};

const applyDeferredConfigMutations = (state: LoopState): LoopState => {
	if (state.deferredConfigMutations.length === 0) {
		return state;
	}
	let next = state;
	for (const mutation of state.deferredConfigMutations) {
		next = applyRalphConfigMutation(next, mutation);
	}
	return { ...next, deferredConfigMutations: [] };
};

const isUnstartedDraftState = (state: LoopState): boolean =>
	state.status === "paused" &&
	state.iteration === 0 &&
	Option.isNone(state.controllerSessionFile) &&
	Option.isNone(state.activeIterationSessionFile);

const isAtIterationLimit = (state: LoopState): boolean =>
	state.maxIterations > 0 && state.iteration >= state.maxIterations;

function activeStartedAtMillis(metrics: RalphLoopMetrics): number | undefined {
	if (Option.isNone(metrics.activeStartedAt)) {
		return undefined;
	}
	const millis = Date.parse(metrics.activeStartedAt.value);
	return Number.isFinite(millis) ? millis : undefined;
}

function stopActiveTimer(metrics: RalphLoopMetrics, nowMillis: number): RalphLoopMetrics {
	const startedAt = activeStartedAtMillis(metrics);
	if (startedAt === undefined) {
		return {
			...metrics,
			activeStartedAt: Option.none(),
		};
	}
	return {
		...metrics,
		activeDurationMs: metrics.activeDurationMs + Math.max(0, nowMillis - startedAt),
		activeStartedAt: Option.none(),
	};
}

function addAgentEndUsage(metrics: RalphLoopMetrics, event: AgentEndEvent): RalphLoopMetrics {
	let totalTokens = 0;
	let totalCostUsd = 0;
	for (const message of event.messages) {
		if (message.role !== "assistant") {
			continue;
		}
		if (message.stopReason === "aborted" || message.stopReason === "error") {
			continue;
		}
		const { usage } = message;
		if (usage === undefined) {
			continue;
		}
		totalTokens +=
			usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		totalCostUsd += usage.cost.total;
	}
	if (totalTokens === 0 && totalCostUsd === 0) {
		return metrics;
	}
	return {
		...metrics,
		totalTokens: metrics.totalTokens + totalTokens,
		totalCostUsd: metrics.totalCostUsd + totalCostUsd,
	};
}

export const RalphLive = (config: RalphLiveConfig) =>
	Layer.effect(
		Ralph,
		Effect.gen(function* () {
			const rawRepo = yield* RalphRepo;
			const repo = {
				loadState: (cwd: string, name: string, archived?: boolean) =>
					mapRalphRepoError(rawRepo.loadState(cwd, name, archived)),
				saveState: (cwd: string, state: LoopState, archived?: boolean) =>
					mapRalphRepoError(rawRepo.saveState(cwd, state, archived)),
				listLoops: (cwd: string, archived?: boolean) =>
					mapRalphRepoError(rawRepo.listLoops(cwd, archived)),
				findLoopBySessionFile: (cwd: string, sessionFile: string | undefined) =>
					mapRalphRepoError(rawRepo.findLoopBySessionFile(cwd, sessionFile)),
				readTaskFile: (cwd: string, taskFile: string) =>
					mapRalphRepoError(rawRepo.readTaskFile(cwd, taskFile)),
				writeTaskFile: (cwd: string, taskFile: string, content: string) =>
					mapRalphRepoError(rawRepo.writeTaskFile(cwd, taskFile, content)),
				ensureTaskFile: (cwd: string, taskFile: string, content: string) =>
					mapRalphRepoError(rawRepo.ensureTaskFile(cwd, taskFile, content)),
				deleteState: (cwd: string, name: string, archived?: boolean) =>
					mapRalphRepoError(rawRepo.deleteState(cwd, name, archived)),
				deleteTaskByLoopName: (cwd: string, name: string, archived?: boolean) =>
					mapRalphRepoError(rawRepo.deleteTaskByLoopName(cwd, name, archived)),
				archiveLoop: (cwd: string, state: LoopState) =>
					mapRalphRepoError(rawRepo.archiveLoop(cwd, state)),
				existsRalphDirectory: (cwd: string) =>
					mapRalphRepoError(rawRepo.existsRalphDirectory(cwd)),
				removeRalphDirectory: (cwd: string) =>
					mapRalphRepoError(rawRepo.removeRalphDirectory(cwd)),
			} as const;
			const loopEngine = yield* LoopEngine;
			const currentLoopRef = yield* Ref.make<Option.Option<CurrentLoopRef>>(Option.none());

			const waitForGlobalIterationSignal = Effect.fn("Ralph.waitForGlobalIterationSignal")(
				function* (iterationSessionFile: string) {
					const deferred = yield* Deferred.make<IterationSignal>();
					const queuedSignal = yield* Effect.sync(() => {
						const bridge = getRalphIterationSignalBridge();
						const existing = bridge.get(iterationSessionFile);
						if (existing?._tag === "queued") {
							bridge.delete(iterationSessionFile);
							return existing.signal;
						}
						bridge.set(iterationSessionFile, {
							_tag: "waiting",
							deferred,
						});
						return undefined;
					});

					const awaitEvent =
						queuedSignal !== undefined
							? Effect.succeed(queuedSignal)
							: Deferred.await(deferred).pipe(
									Effect.ensuring(
										Effect.sync(() => {
											const bridge = getRalphIterationSignalBridge();
											const existing = bridge.get(iterationSessionFile);
											if (
												existing?._tag === "waiting" &&
												existing.deferred === deferred
											) {
												bridge.delete(iterationSessionFile);
											}
										}),
									),
								);

					return { awaitEvent } as const;
				},
			);

			const publishGlobalIterationSignal = Effect.fn("Ralph.publishGlobalIterationSignal")(
				function* (iterationSessionFile: string, signal: IterationSignal) {
					const waitingDeferred = yield* Effect.sync(() => {
						const bridge = getRalphIterationSignalBridge();
						const existing = bridge.get(iterationSessionFile);
						if (existing?._tag === "waiting") {
							bridge.delete(iterationSessionFile);
							return existing.deferred;
						}
						if (existing === undefined) {
							bridge.set(iterationSessionFile, {
								_tag: "queued",
								signal,
							});
						}
						return undefined;
					});

					if (waitingDeferred !== undefined) {
						yield* Deferred.succeed(waitingDeferred, signal);
					}
				},
			);

			const setCurrentLoop = Effect.fn("Ralph.setCurrentLoop")(function* (
				cwd: string,
				next: Option.Option<string>,
			) {
				yield* Ref.set(
					currentLoopRef,
					Option.map(next, (loopName) => ({
						root: resolveLoopWorkspaceRoot(cwd),
						loopName,
					})),
				);
			});

			const getCurrentLoop = Effect.fn("Ralph.getCurrentLoop")(function* (cwd: string) {
				const current = yield* Ref.get(currentLoopRef);
				if (Option.isNone(current)) {
					return Option.none<string>();
				}
				if (current.value.root !== resolveLoopWorkspaceRoot(cwd)) {
					return Option.none<string>();
				}
				return Option.some(current.value.loopName);
			});

			const clearCurrentLoop = Ref.set(currentLoopRef, Option.none());

			const syncCurrentLoopFromSession: RalphService["syncCurrentLoopFromSession"] =
				Effect.fn("Ralph.syncCurrentLoopFromSession")(function* (cwd, sessionFile) {
					const scoped = yield* repo.findLoopBySessionFile(cwd, sessionFile);
					if (Option.isSome(scoped)) {
						yield* setCurrentLoop(cwd, Option.some(scoped.value.name));
					}
				});

			const persistOwnedLoopOnShutdown: RalphService["persistOwnedLoopOnShutdown"] =
				Effect.fn("Ralph.persistOwnedLoopOnShutdown")(function* (cwd, sessionFile) {
					const scoped = yield* repo.findLoopBySessionFile(cwd, sessionFile);
					if (Option.isSome(scoped)) {
						yield* repo.saveState(cwd, scoped.value);
					}

					if (sessionFile === undefined) {
						return;
					}

					yield* publishGlobalIterationSignal(sessionFile, {
						_tag: "session_shutdown",
					});
				});

			const markLoopPaused = Effect.fn("Ralph.markLoopPaused")(function* (
				cwd: string,
				state: LoopState,
			) {
				const nowMillis = yield* Clock.currentTimeMillis;
				state.metrics = stopActiveTimer(state.metrics, nowMillis);
				if (state.status === "active") {
					yield* repo.saveState(cwd, state);
					yield* mapLoopEngineError(loopEngine.pauseLoop(cwd, state.name));
				} else {
					const pausedState: LoopState = {
						...state,
						status: "paused",
					};
					yield* repo.saveState(cwd, pausedState);
				}
				yield* clearCurrentLoop;
			});

			const markLoopCompleted = Effect.fn("Ralph.markLoopCompleted")(function* (
				cwd: string,
				state: LoopState,
			) {
				const nowMillis = yield* Clock.currentTimeMillis;
				const completedAt = Option.some(new Date(nowMillis).toISOString());
				const nextState: LoopState = {
					...state,
					metrics: stopActiveTimer(state.metrics, nowMillis),
					completedAt,
					pendingDecision: Option.none(),
					activeIterationSessionFile: Option.none(),
					deferredConfigMutations: [],
				};
				if (nextState.status === "active" || nextState.status === "paused") {
					yield* repo.saveState(cwd, nextState);
					yield* mapLoopEngineError(loopEngine.stopLoop(cwd, nextState.name));
				} else {
					yield* repo.saveState(cwd, {
						...nextState,
						status: "completed",
					});
				}
				yield* clearCurrentLoop;
			});

			const startLoopState: RalphService["startLoopState"] = Effect.fn(
				"Ralph.startLoopState",
			)(function* (cwd, input) {
				const existing = yield* repo.loadState(cwd, input.loopName);
				if (Option.isSome(existing) && existing.value.status === "active") {
					return {
						status: "already_active",
						loopName: input.loopName,
					} satisfies RalphStartLoopStateResult;
				}

				if (Option.isNone(input.controllerSessionFile)) {
					return {
						status: "missing_controller_session",
					} satisfies RalphStartLoopStateResult;
				}

				const defaultTaskFile = path.join(RALPH_TASKS_DIR, `${input.loopName}.md`);
				const taskFile = defaultTaskFile;

				const createdTask = yield* repo.ensureTaskFile(
					cwd,
					taskFile,
					input.defaultTaskTemplate,
				);

				if (Option.isNone(existing)) {
					yield* mapLoopEngineError(
						loopEngine.createLoop(cwd, {
							kind: "ralph",
							taskId: input.loopName,
							title: input.loopName,
							taskContent: input.defaultTaskTemplate,
							maxIterations: input.maxIterations,
							itemsPerIteration: input.itemsPerIteration,
							reflectEvery: input.reflectEvery,
							reflectInstructions: input.reflectInstructions,
							executionProfile: input.executionProfile,
							sandboxProfile: input.sandboxProfile,
							capabilityContract: input.capabilityContract,
						}),
					);
				} else {
					const preserveDraftConfiguration = isUnstartedDraftState(existing.value);
					const overrides = input.overrides;
					const preparedState: LoopState = {
						...existing.value,
						taskFile,
						maxIterations:
							preserveDraftConfiguration && overrides?.maxIterations !== true
								? existing.value.maxIterations
								: input.maxIterations,
						itemsPerIteration:
							preserveDraftConfiguration && overrides?.itemsPerIteration !== true
								? existing.value.itemsPerIteration
								: input.itemsPerIteration,
						reflectEvery:
							preserveDraftConfiguration && overrides?.reflectEvery !== true
								? existing.value.reflectEvery
								: input.reflectEvery,
						reflectInstructions:
							preserveDraftConfiguration && overrides?.reflectInstructions !== true
								? existing.value.reflectInstructions
								: input.reflectInstructions,
						executionProfile: preserveDraftConfiguration
							? existing.value.executionProfile
							: input.executionProfile,
						sandboxProfile: preserveDraftConfiguration
							? existing.value.sandboxProfile
							: Option.some(input.sandboxProfile),
						lastReflectionAt: 0,
						activeIterationSessionFile: Option.none(),
						pendingDecision: Option.none(),
						capabilityContract: preserveDraftConfiguration
							? existing.value.capabilityContract
							: (input.capabilityContract ?? existing.value.capabilityContract),
					};
					yield* repo.saveState(cwd, preparedState);
				}

				const controllerSessionFile = Option.getOrUndefined(input.controllerSessionFile);
				if (controllerSessionFile === undefined) {
					return {
						status: "missing_controller_session",
					} satisfies RalphStartLoopStateResult;
				}

				const controller = sessionRefFromFile(controllerSessionFile);
				const startLifecycle = loopEngine.startLoop(cwd, input.loopName, controller).pipe(
					Effect.catch((error) => {
						if (
							error instanceof LoopLifecycleConflictError &&
							error.actual === "paused"
						) {
							return loopEngine
								.stopLoop(cwd, input.loopName)
								.pipe(
									Effect.flatMap(() =>
										loopEngine.startLoop(cwd, input.loopName, controller),
									),
								);
						}
						return Effect.fail(error);
					}),
				);
				yield* mapLoopEngineError(startLifecycle);
				yield* setCurrentLoop(cwd, Option.some(input.loopName));

				const persistedState = yield* repo.loadState(cwd, input.loopName);
				const maxIterations = Option.isSome(persistedState)
					? persistedState.value.maxIterations
					: input.maxIterations;

				return {
					status: "started",
					loopName: input.loopName,
					taskFile,
					createdTask,
					maxIterations,
				} satisfies RalphStartLoopStateResult;
			});

			const prepareLoopTask: RalphService["prepareLoopTask"] = Effect.fn(
				"Ralph.prepareLoopTask",
			)(function* (cwd, input) {
				const existing = yield* repo.loadState(cwd, input.loopName);
				if (Option.isSome(existing) && existing.value.status === "active") {
					return {
						status: "already_active",
						loopName: input.loopName,
					} satisfies RalphPrepareLoopTaskResult;
				}

				const taskFile = path.join(RALPH_TASKS_DIR, `${input.loopName}.md`);
				yield* repo.writeTaskFile(cwd, taskFile, input.taskContent);
				return {
					status: "prepared",
					taskFile,
				} satisfies RalphPrepareLoopTaskResult;
			});

			const createDraftLoopForConfiguration: RalphService["createDraftLoopForConfiguration"] =
				Effect.fn("Ralph.createDraftLoopForConfiguration")(function* (cwd, input) {
					const existing = yield* repo.loadState(cwd, input.loopName);
					if (Option.isSome(existing)) {
						return {
							loop: existing.value,
							createdState: false,
						} satisfies RalphCreateDraftLoopForConfigurationResult;
					}

					yield* mapLoopEngineError(
						loopEngine.createLoop(cwd, {
							kind: "ralph",
							taskId: input.loopName,
							title: input.loopName,
							taskContent: input.taskContent,
							maxIterations: input.maxIterations,
							itemsPerIteration: input.itemsPerIteration,
							reflectEvery: input.reflectEvery,
							reflectInstructions: input.reflectInstructions,
							executionProfile: input.executionProfile,
							sandboxProfile: input.sandboxProfile,
							capabilityContract: input.capabilityContract,
						}),
					);

					const created = yield* repo.loadState(cwd, input.loopName);
					if (Option.isNone(created)) {
						return yield* Effect.fail(
							new RalphContractValidationError({
								entity: "ralph.config.create_draft",
								reason: `Created loop "${input.loopName}" but could not reload its state.`,
							}),
						);
					}
					return {
						loop: created.value,
						createdState: true,
					} satisfies RalphCreateDraftLoopForConfigurationResult;
				});

			const resolveLoopForUi: RalphService["resolveLoopForUi"] = Effect.fn(
				"Ralph.resolveLoopForUi",
			)(function* (cwd, sessionFile) {
				const fromSession = yield* repo.findLoopBySessionFile(cwd, sessionFile);
				if (Option.isSome(fromSession)) {
					return fromSession;
				}

				const activeLoops = (yield* repo.listLoops(cwd)).filter(
					(loop) => loop.status === "active",
				);
				const soleActiveLoop = activeLoops.length === 1 ? activeLoops[0] : undefined;
				if (soleActiveLoop !== undefined) {
					return Option.some(soleActiveLoop);
				}

				return Option.none<LoopState>();
			});

			const pauseCurrentLoop: RalphService["pauseCurrentLoop"] = Effect.fn(
				"Ralph.pauseCurrentLoop",
			)(function* (cwd) {
				const currentLoop = yield* getCurrentLoop(cwd);
				if (Option.isSome(currentLoop)) {
					const stateOption = yield* repo.loadState(cwd, currentLoop.value);
					if (Option.isSome(stateOption)) {
						if (stateOption.value.status === "active") {
							yield* markLoopPaused(cwd, stateOption.value);
							return {
								status: "paused",
								loopName: stateOption.value.name,
								iteration: stateOption.value.iteration,
							} satisfies RalphPauseCurrentLoopResult;
						}
						if (stateOption.value.status === "paused") {
							return {
								status: "paused",
								loopName: stateOption.value.name,
								iteration: stateOption.value.iteration,
							} satisfies RalphPauseCurrentLoopResult;
						}
					}
				}

				const activeLoops = (yield* repo.listLoops(cwd)).filter(
					(loop) => loop.status === "active",
				);
				const active = activeLoops.length === 1 ? activeLoops[0] : undefined;
				if (active === undefined) {
					return {
						status: "no_active_loop",
					} satisfies RalphPauseCurrentLoopResult;
				}

				yield* markLoopPaused(cwd, active);
				return {
					status: "paused",
					loopName: active.name,
					iteration: active.iteration,
				} satisfies RalphPauseCurrentLoopResult;
			});

			const stopActiveLoop: RalphService["stopActiveLoop"] = Effect.fn(
				"Ralph.stopActiveLoop",
			)(function* (cwd) {
				const currentLoop = yield* getCurrentLoop(cwd);
				const maybeCurrentState = Option.isSome(currentLoop)
					? yield* repo.loadState(cwd, currentLoop.value)
					: Option.none<LoopState>();
				if (Option.isSome(maybeCurrentState) && maybeCurrentState.value.status === "active") {
					yield* markLoopCompleted(cwd, maybeCurrentState.value);
					return {
						status: "stopped",
						loopName: maybeCurrentState.value.name,
						iteration: maybeCurrentState.value.iteration,
					} satisfies RalphStopLoopResult;
				}

				const activeLoops = (yield* repo.listLoops(cwd)).filter(
					(loop) => loop.status === "active",
				);
				const active = activeLoops.length === 1 ? activeLoops[0] : undefined;
				const resolvedState =
					active === undefined ? Option.none<LoopState>() : Option.some(active);

				if (Option.isNone(resolvedState)) {
					return {
						status: "no_active_loop",
					} satisfies RalphStopLoopResult;
				}

				const state = resolvedState.value;
				if (state.status !== "active") {
					return {
						status: "not_active",
						loopName: state.name,
					} satisfies RalphStopLoopResult;
				}

				yield* markLoopCompleted(cwd, state);
				return {
					status: "stopped",
					loopName: state.name,
					iteration: state.iteration,
				} satisfies RalphStopLoopResult;
			});

			const resumeLoopState: RalphService["resumeLoopState"] = Effect.fn(
				"Ralph.resumeLoopState",
			)(function* (cwd, input) {
				const loopName = input.loopName;
				const stateOption = yield* repo.loadState(cwd, loopName);
				if (Option.isNone(stateOption)) {
					return {
						status: "not_found",
					} satisfies RalphResumeLoopStateResult;
				}

				const initialState = stateOption.value;
				let state = initialState;
				const requestedMaxIterations = Option.getOrUndefined(input.maxIterations);
				if (initialState.status === "completed") {
					if (
						requestedMaxIterations !== undefined &&
						requestedMaxIterations > 0 &&
						requestedMaxIterations <= initialState.iteration
					) {
						return {
							status: "max_iterations_too_low",
							loopName,
							iteration: initialState.iteration,
							requestedMaxIterations,
						} satisfies RalphResumeLoopStateResult;
					}

					const reopenedState: LoopState = {
						...initialState,
						status: "paused",
						maxIterations: requestedMaxIterations ?? initialState.maxIterations,
						completedAt: Option.none(),
						activeIterationSessionFile: Option.none(),
						pendingDecision: Option.none(),
					};

					if (isAtIterationLimit(reopenedState)) {
						return {
							status: "max_iterations_reached",
							loopName,
							iteration: reopenedState.iteration,
							maxIterations: reopenedState.maxIterations,
						} satisfies RalphResumeLoopStateResult;
					}

					yield* repo.saveState(cwd, reopenedState);
					state = reopenedState;
				}

				if (requestedMaxIterations !== undefined) {
					if (requestedMaxIterations > 0 && requestedMaxIterations <= state.iteration) {
						return {
							status: "max_iterations_too_low",
							loopName,
							iteration: state.iteration,
							requestedMaxIterations,
						} satisfies RalphResumeLoopStateResult;
					}

					if (requestedMaxIterations !== state.maxIterations) {
						state = {
							...state,
							maxIterations: requestedMaxIterations,
						};
						yield* repo.saveState(cwd, state);
					}
				}

				if (isAtIterationLimit(state)) {
					return {
						status: "max_iterations_reached",
						loopName,
						iteration: state.iteration,
						maxIterations: state.maxIterations,
					} satisfies RalphResumeLoopStateResult;
				}

				const controllerSessionFile = Option.getOrUndefined(state.controllerSessionFile);
				if (controllerSessionFile === undefined) {
					return yield* Effect.fail(
						toContractError(
							"ralph.controller_session",
							`Loop "${loopName}" has no controller session file`,
						),
					);
				}

				if (state.status === "paused") {
					yield* mapLoopEngineError(
						loopEngine.resumeLoop(
							cwd,
							loopName,
							sessionRefFromFile(controllerSessionFile),
						),
					);
				}
				yield* setCurrentLoop(cwd, Option.some(loopName));

				return {
					status: "resumed",
					loopName,
				} satisfies RalphResumeLoopStateResult;
			});

			const cancelLoop: RalphService["cancelLoop"] = Effect.fn("Ralph.cancelLoop")(
				function* (cwd, loopName) {
					const state = yield* repo.loadState(cwd, loopName);
					if (Option.isNone(state)) {
						return {
							status: "not_found",
						} satisfies RalphCancelLoopResult;
					}
					if (state.value.status === "active") {
						yield* markLoopPaused(cwd, state.value);
					}

					const currentLoop = yield* getCurrentLoop(cwd);
					if (Option.isSome(currentLoop) && currentLoop.value === loopName) {
						yield* clearCurrentLoop;
					}

					yield* mapLoopEngineError(loopEngine.cancelLoop(cwd, loopName));
					return {
						status: "cancelled",
					} satisfies RalphCancelLoopResult;
				},
			);

			const archiveLoopByName: RalphService["archiveLoopByName"] = Effect.fn(
				"Ralph.archiveLoopByName",
			)(function* (cwd, loopName) {
				const stateOption = yield* repo.loadState(cwd, loopName);
				if (Option.isNone(stateOption)) {
					return {
						status: "not_found",
					} satisfies RalphArchiveLoopByNameResult;
				}

				const state = stateOption.value;
				if (state.status === "active") {
					return {
						status: "active_loop",
					} satisfies RalphArchiveLoopByNameResult;
				}

				const currentLoop = yield* getCurrentLoop(cwd);
				if (Option.isSome(currentLoop) && currentLoop.value === loopName) {
					yield* clearCurrentLoop;
				}

				yield* repo.archiveLoop(cwd, state);
				return {
					status: "archived",
				} satisfies RalphArchiveLoopByNameResult;
			});

			const cleanCompletedLoops: RalphService["cleanCompletedLoops"] = Effect.fn(
				"Ralph.cleanCompletedLoops",
			)(function* (cwd, all) {
				const cleaned = yield* mapLoopEngineError(loopEngine.cleanLoops(cwd, all, "ralph"));
				const currentLoop = yield* getCurrentLoop(cwd);
				if (
					Option.isSome(currentLoop) &&
					cleaned.cleanedTaskIds.includes(currentLoop.value)
				) {
					yield* clearCurrentLoop;
				}

				return {
					cleanedLoops: [...cleaned.cleanedTaskIds],
				} satisfies RalphCleanCompletedLoopsResult;
			});

			const nukeLoops: RalphService["nukeLoops"] = Effect.fn("Ralph.nukeLoops")(
				function* (cwd) {
					const exists = yield* repo.existsRalphDirectory(cwd);
					if (!exists) {
						return {
							removed: false,
						} satisfies RalphNukeLoopsResult;
					}

					yield* clearCurrentLoop;
					yield* repo.removeRalphDirectory(cwd);
					return {
						removed: true,
					} satisfies RalphNukeLoopsResult;
				},
			);

			const pauseLoop = (
				cwd: string,
				state: LoopState,
				message: string,
				kind: "blocked" | "stopped",
			): Effect.Effect<LoopStepResult, RalphContractValidationError, never> =>
				Effect.gen(function* () {
					yield* markLoopPaused(cwd, state);
					return kind === "blocked"
						? blockedWithMessage(message)
						: stopWithMessage(message);
				});

			const completeLoop = (
				cwd: string,
				state: LoopState,
				banner: string,
			): Effect.Effect<LoopStepResult, RalphContractValidationError, never> =>
				Effect.gen(function* () {
					yield* markLoopCompleted(cwd, state);
					return {
						_tag: "stopped",
						message: Option.none(),
						banner: Option.some(banner),
					} satisfies LoopStepResult;
				});

			const applyPendingDecision = (
				boundary: RalphCommandBoundary,
				loopName: string,
			): Effect.Effect<LoopStepResult, RalphContractValidationError, never> =>
				Effect.gen(function* () {
					const stateOption = yield* repo.loadState(boundary.cwd, loopName);
					if (Option.isNone(stateOption) || stateOption.value.status !== "active") {
						return stoppedWithoutMessage;
					}

					const state = stateOption.value;
					if (Option.isNone(state.pendingDecision)) {
						const next = applyDeferredConfigMutations(state);
						if (next !== state) {
							yield* repo.saveState(boundary.cwd, next);
						}
						return continueLoop;
					}

					if (yield* config.hasActiveSubagents()) {
						state.activeIterationSessionFile = Option.none();
						return yield* pauseLoop(
							boundary.cwd,
							state,
							"Ralph paused: subagents are still active. Complete or close them, then run /ralph resume to continue.",
							"blocked",
						);
					}

					const decision = state.pendingDecision.value;
					clearPendingDecision(state);
					state.activeIterationSessionFile = Option.none();
					if (decision.kind === "continue") {
						yield* repo.saveState(boundary.cwd, applyDeferredConfigMutations(state));
						return continueLoop;
					}

					return yield* completeLoop(
						boundary.cwd,
						state,
						finishBanner(state, decision.message),
					);
				});

			const buildMissingDecisionNudge = (): string =>
				[
					"This Ralph iteration ended without a Ralph loop tool.",
					"- Call ralph_finish if the Ralph loop is complete.",
					"- Call ralph_continue if this iteration is done and Ralph should start the next one.",
					"- If more work is needed in this iteration, continue working now and end with exactly one Ralph loop tool.",
				].join("\n");

			const waitForIterationSignal = Effect.fn("Ralph.waitForIterationSignal")(function* (
				iterationSessionFile: string,
			) {
				return yield* waitForGlobalIterationSignal(iterationSessionFile);
			});

			const runSingleIteration = (
				boundary: RalphCommandBoundary,
				loopName: string,
			): Effect.Effect<LoopStepResult, RalphContractValidationError, never> =>
				Effect.gen(function* () {
					const stateOption = yield* repo.loadState(boundary.cwd, loopName);
					if (Option.isNone(stateOption) || stateOption.value.status !== "active") {
						return stoppedWithoutMessage;
					}

					const state = stateOption.value;
					if (isAtIterationLimit(state)) {
						yield* markLoopPaused(boundary.cwd, state);
						return {
							_tag: "stopped",
							message: Option.none(),
							banner: Option.some(
								`───────────────────────────────────────────────────────────────────────\n⚠️ RALPH LOOP STOPPED: ${state.name} | Max iterations (${state.maxIterations}) reached\n───────────────────────────────────────────────────────────────────────`,
							),
						} satisfies LoopStepResult;
					}

					const controllerSession = Option.getOrUndefined(state.controllerSessionFile);
					if (controllerSession === undefined) {
						return yield* pauseLoop(
							boundary.cwd,
							state,
							"Ralph loop has no controller session file. Loop paused.",
							"stopped",
						);
					}

					if (boundary.getSessionFile() !== controllerSession) {
						const switched = yield* boundary.switchSession(controllerSession);
						if (switched.cancelled) {
							return yield* pauseLoop(
								boundary.cwd,
								state,
								"Could not switch to Ralph controller session.",
								"stopped",
							);
						}
					}

					const controllerContractApplied = yield* boundary.applyCapabilityContract(
						state.capabilityContract,
						"controller",
					);
					if (!controllerContractApplied.applied) {
						return yield* pauseLoop(
							boundary.cwd,
							state,
							`Could not apply Ralph controller contract: ${controllerContractApplied.reason ?? "unknown error"}`,
							"stopped",
						);
					}

					if (yield* config.hasActiveSubagents()) {
						state.activeIterationSessionFile = Option.none();
						return yield* pauseLoop(
							boundary.cwd,
							state,
							"Ralph paused: subagents became active. Complete or close them, then run /ralph resume to continue.",
							"blocked",
						);
					}

					let sandboxProfile = Option.getOrUndefined(state.sandboxProfile);
					if (sandboxProfile === undefined) {
						sandboxProfile = yield* boundary.captureSandboxProfile;
						state.sandboxProfile = Option.some(sandboxProfile);
						yield* repo.saveState(boundary.cwd, state);
					}

					const child = yield* boundary.newSession({
						parentSession: controllerSession,
						sandboxProfile,
					});
					if (child.cancelled) {
						return yield* pauseLoop(
							boundary.cwd,
							state,
							"Creating Ralph iteration session was cancelled.",
							"stopped",
						);
					}

					const afterSessionOption = yield* repo.loadState(boundary.cwd, loopName);
					if (
						Option.isNone(afterSessionOption) ||
						afterSessionOption.value.status !== "active"
					) {
						return stoppedWithoutMessage;
					}

					const afterSession = afterSessionOption.value;
					afterSession.iteration += 1;
					const iterationSessionFile = boundary.getSessionFile();
					if (iterationSessionFile === undefined) {
						return yield* pauseLoop(
							boundary.cwd,
							afterSession,
							"Ralph iteration session has no session file. Loop paused.",
							"stopped",
						);
					}
					afterSession.activeIterationSessionFile = Option.none();
					clearPendingDecision(afterSession);
					const childContractApplied = yield* boundary.applyCapabilityContract(
						afterSession.capabilityContract,
						"child",
					);
					if (!childContractApplied.applied) {
						return yield* pauseLoop(
							boundary.cwd,
							afterSession,
							`Could not apply Ralph child contract: ${childContractApplied.reason ?? "unknown error"}`,
							"stopped",
						);
					}
					const executionProfileApplied = yield* boundary.applyExecutionProfile(
						afterSession.executionProfile,
					);
					if (!executionProfileApplied.applied) {
						return yield* pauseLoop(
							boundary.cwd,
							afterSession,
							`Could not apply Ralph execution profile: ${executionProfileApplied.reason ?? "unknown error"}`,
							"stopped",
						);
					}
					yield* repo.saveState(boundary.cwd, afterSession);
					yield* mapLoopEngineError(
						loopEngine.attachChildSession(
							boundary.cwd,
							loopName,
							sessionRefFromFile(iterationSessionFile),
						),
					);
					yield* setCurrentLoop(boundary.cwd, Option.some(loopName));

					const taskContent = yield* repo.readTaskFile(
						boundary.cwd,
						afterSession.taskFile,
					);
					if (Option.isNone(taskContent)) {
						return yield* pauseLoop(
							boundary.cwd,
							afterSession,
							`Could not read Ralph task file: ${afterSession.taskFile}`,
							"stopped",
						);
					}

					const needsReflection =
						afterSession.reflectEvery > 0 &&
						afterSession.iteration > 1 &&
						(afterSession.iteration - 1) % afterSession.reflectEvery === 0;

					let missingDecisionNudged = false;
					let pendingSignal = yield* waitForIterationSignal(iterationSessionFile);
					const initialPromptDispatch = yield* boundary.sendFollowUp(
						buildPrompt(afterSession, taskContent.value, needsReflection),
					);
					if (!initialPromptDispatch.dispatched) {
						return yield* pauseLoop(
							boundary.cwd,
							afterSession,
							`Could not deliver Ralph prompt to the iteration session: ${initialPromptDispatch.reason ?? "unknown error"}`,
							"stopped",
						);
					}

					while (true) {
						const signal = yield* pendingSignal.awaitEvent;

						const afterTurnOption = yield* repo.loadState(boundary.cwd, loopName);
						if (
							Option.isNone(afterTurnOption) ||
							afterTurnOption.value.status !== "active"
						) {
							return stoppedWithoutMessage;
						}

						const afterTurn = afterTurnOption.value;
						if (signal._tag === "session_shutdown") {
							if (Option.isSome(afterTurn.pendingDecision)) {
								return continueLoop;
							}
							return yield* pauseLoop(
								boundary.cwd,
								afterTurn,
								`Iteration ${afterTurn.iteration} session shut down before calling ralph_continue or ralph_finish. Ralph paused. Use /ralph resume ${loopName} to continue.`,
								"stopped",
							);
						}

						if (Option.isSome(afterTurn.pendingDecision)) {
							const decision = afterTurn.pendingDecision.value;
							if (decision.kind === "continue") {
								return continueLoop;
							}
							return yield* completeLoop(
								boundary.cwd,
								afterTurn,
								finishBanner(afterTurn, decision.message),
							);
						}

						const assistant = extractLastAssistantSummary(signal.event);
						const stopReason = Option.getOrUndefined(assistant.stopReason);
						if (stopReason === "aborted") {
							return yield* pauseLoop(
								boundary.cwd,
								afterTurn,
								`Iteration ${afterTurn.iteration} ended with stop reason ${stopReason}. Ralph paused. Use /ralph resume ${loopName} to continue.`,
								"stopped",
							);
						}
						if (stopReason === "error") {
							if (isAutomaticallyRecoverableAssistantError(assistant)) {
								pendingSignal = yield* waitForIterationSignal(iterationSessionFile);
								continue;
							}
							return yield* pauseLoop(
								boundary.cwd,
								afterTurn,
								`Iteration ${afterTurn.iteration} ended with stop reason ${stopReason}. Ralph paused. Use /ralph resume ${loopName} to continue.`,
								"stopped",
							);
						}

						if (
							assistant.hasUsableAssistantMessage &&
							(stopReason === undefined ||
								stopReason === "stop" ||
								stopReason === "length")
						) {
							if (missingDecisionNudged) {
								return yield* pauseLoop(
									boundary.cwd,
									afterTurn,
									`Iteration ${afterTurn.iteration} ended twice without calling ralph_continue or ralph_finish. Ralph paused. Use /ralph resume ${loopName} to continue.`,
									"stopped",
								);
							}
							missingDecisionNudged = true;
							pendingSignal = yield* waitForIterationSignal(iterationSessionFile);
							const nudgeDispatch = yield* boundary.sendFollowUp(
								buildMissingDecisionNudge(),
							);
							if (!nudgeDispatch.dispatched) {
								return yield* pauseLoop(
									boundary.cwd,
									afterTurn,
									`Could not deliver the Ralph follow-up prompt: ${nudgeDispatch.reason ?? "unknown error"}`,
									"stopped",
								);
							}
							continue;
						}

						return yield* pauseLoop(
							boundary.cwd,
							afterTurn,
							`Iteration ${afterTurn.iteration} ended without a usable Ralph decision (stop reason: ${stopReason ?? "unknown"}). Ralph paused. Use /ralph resume ${loopName} to continue.`,
							"stopped",
						);
					}
				});

			const runLoop: RalphService["runLoop"] = Effect.fn("Ralph.runLoop")(
				function* (boundary, loopName) {
					while (true) {
						const stateOption = yield* repo.loadState(boundary.cwd, loopName);
						if (Option.isNone(stateOption) || stateOption.value.status !== "active") {
							return {
								status: "stopped",
								message: Option.none(),
								banner: Option.none(),
							} satisfies RalphRunLoopResult;
						}

						yield* setCurrentLoop(boundary.cwd, Option.some(loopName));

						const finalize = yield* applyPendingDecision(boundary, loopName);
						if (finalize._tag === "blocked") {
							return {
								status: "blocked",
								message: Option.some(finalize.message),
								banner: Option.none(),
							} satisfies RalphRunLoopResult;
						}
						if (finalize._tag === "stopped") {
							return {
								status: "stopped",
								message: finalize.message,
								banner: finalize.banner,
							} satisfies RalphRunLoopResult;
						}

						const iteration = yield* runSingleIteration(boundary, loopName);
						if (iteration._tag === "continue") {
							continue;
						}
						if (iteration._tag === "blocked") {
							return {
								status: "blocked",
								message: Option.some(iteration.message),
								banner: Option.none(),
							} satisfies RalphRunLoopResult;
						}
						return {
							status: "stopped",
							message: iteration.message,
							banner: iteration.banner,
						} satisfies RalphRunLoopResult;
					}
				},
			);

			const recordContinue: RalphService["recordContinue"] = Effect.fn(
				"Ralph.recordContinue",
			)(function* (cwd, sessionFile) {
				const stateOption = yield* repo.findLoopBySessionFile(cwd, sessionFile);
				if (Option.isNone(stateOption)) {
					return { text: "No active Ralph loop." } satisfies RalphContinueResult;
				}

				const state = stateOption.value;
				if (state.status !== "active") {
					return { text: "Ralph loop is not active." } satisfies RalphContinueResult;
				}
				if (!optionContains(state.activeIterationSessionFile, sessionFile)) {
					return { text: "No active Ralph loop." } satisfies RalphContinueResult;
				}
				if (Option.isSome(state.pendingDecision)) {
					return {
						text: "A Ralph decision is already recorded for this iteration.",
					} satisfies RalphContinueResult;
				}
				const timestamp = yield* nowIso;
				setPendingDecision(state, {
					kind: "continue",
					requestedAt: timestamp,
				});
				if (yield* config.hasActiveSubagents()) {
					state.activeIterationSessionFile = Option.none();
					yield* markLoopPaused(cwd, state);
					return {
						text: "Ralph iteration recorded. Subagents are still active, so advancement is blocked until they finish. Run /ralph resume when they are done.",
					} satisfies RalphContinueResult;
				}

				yield* repo.saveState(cwd, state);
				yield* setCurrentLoop(cwd, Option.some(state.name));
				return {
					text: `Iteration ${state.iteration} complete. Continue recorded.`,
				} satisfies RalphContinueResult;
			});

			const recordFinish: RalphService["recordFinish"] = Effect.fn("Ralph.recordFinish")(
				function* (cwd, sessionFile, message) {
					const trimmedMessage = message.trim();
					if (trimmedMessage.length === 0) {
						return {
							text: "Finish message must not be empty.",
						} satisfies RalphFinishResult;
					}

					const stateOption = yield* repo.findLoopBySessionFile(cwd, sessionFile);
					if (Option.isNone(stateOption)) {
						return { text: "No active Ralph loop." } satisfies RalphFinishResult;
					}

					const state = stateOption.value;
					if (state.status !== "active") {
						return { text: "Ralph loop is not active." } satisfies RalphFinishResult;
					}
					if (!optionContains(state.activeIterationSessionFile, sessionFile)) {
						return { text: "No active Ralph loop." } satisfies RalphFinishResult;
					}
					if (Option.isSome(state.pendingDecision)) {
						return {
							text: "A Ralph decision is already recorded for this iteration.",
						} satisfies RalphFinishResult;
					}

					const timestamp = yield* nowIso;
					setPendingDecision(state, {
						kind: "finish",
						requestedAt: timestamp,
						message: trimmedMessage,
					});
					if (yield* config.hasActiveSubagents()) {
						state.activeIterationSessionFile = Option.none();
						yield* markLoopPaused(cwd, state);
						return {
							text: "Finish recorded. Subagents are still active, so completion is blocked until they finish. Run /ralph resume when they are done.",
						} satisfies RalphFinishResult;
					}

					yield* repo.saveState(cwd, state);
					yield* setCurrentLoop(cwd, Option.some(state.name));
					return {
						text: `Finish recorded for iteration ${state.iteration}.`,
					} satisfies RalphFinishResult;
				},
			);

			const handleAgentEnd: RalphService["handleAgentEnd"] = Effect.fn(
				"Ralph.handleAgentEnd",
			)(function* (cwd, sessionFile, event) {
				if (sessionFile === undefined) {
					return {
						consumedByWaitingLoop: false,
						banner: Option.none(),
					} satisfies RalphAgentEndResult;
				}

				const stateOption = yield* repo.findLoopBySessionFile(cwd, sessionFile);
				const ownedActiveState =
					Option.isSome(stateOption) &&
					stateOption.value.status === "active" &&
					optionContains(stateOption.value.activeIterationSessionFile, sessionFile)
						? Option.some(stateOption.value)
						: Option.none<LoopState>();

				if (Option.isSome(ownedActiveState)) {
					const state = ownedActiveState.value;
					const nextMetrics = addAgentEndUsage(state.metrics, event);
					if (nextMetrics !== state.metrics) {
						state.metrics = nextMetrics;
						yield* repo.saveState(cwd, state);
					}
				}

				const pending = yield* Effect.sync(() => {
					const bridge = getRalphIterationSignalBridge();
					const existing = bridge.get(sessionFile);
					return existing?._tag === "waiting" || existing?._tag === "queued";
				});
				if (pending) {
					yield* publishGlobalIterationSignal(sessionFile, {
						_tag: "agent_end",
						event,
					});
					return {
						consumedByWaitingLoop: true,
						banner: Option.none(),
					} satisfies RalphAgentEndResult;
				}

				if (Option.isNone(ownedActiveState)) {
					return {
						consumedByWaitingLoop: false,
						banner: Option.none(),
					} satisfies RalphAgentEndResult;
				}

				const state = ownedActiveState.value;
				if (
					Option.isSome(state.pendingDecision) &&
					state.pendingDecision.value.kind === "finish"
				) {
					const message = state.pendingDecision.value.message;
					clearPendingDecision(state);
					state.activeIterationSessionFile = Option.none();
					yield* markLoopCompleted(cwd, state);
					return {
						consumedByWaitingLoop: false,
						banner: Option.some(finishBanner(state, message)),
					} satisfies RalphAgentEndResult;
				}

				return {
					consumedByWaitingLoop: false,
					banner: Option.none(),
				} satisfies RalphAgentEndResult;
			});

			const configService = makeRalphLoopConfigService(rawRepo);

			const configureLoop: RalphService["configureLoop"] = (cwd, loopName, mutation) =>
				Effect.promise(() => configService.mutate(cwd, loopName, mutation));

			const configureLoopMany: RalphService["configureLoopMany"] = (cwd, loopName, mutations) =>
				Effect.promise(() => configService.mutateMany(cwd, loopName, mutations));

			const recaptureLoopExecutionProfile: RalphService["recaptureLoopExecutionProfile"] = (
				cwd,
				loopName,
				profile,
			) => Effect.promise(() => configService.recaptureExecutionProfile(cwd, loopName, profile));

			const recaptureLoopSandboxProfile: RalphService["recaptureLoopSandboxProfile"] = (
				cwd,
				loopName,
				profile,
			) => Effect.promise(() => configService.recaptureSandboxProfile(cwd, loopName, profile));

			return Ralph.of({
				startLoopState,
				prepareLoopTask,
				createDraftLoopForConfiguration,
				listLoops: repo.listLoops,
				findLoopBySessionFile: repo.findLoopBySessionFile,
				resolveLoopForUi,
				pauseCurrentLoop,
				stopActiveLoop,
				resumeLoopState,
				cancelLoop,
				archiveLoopByName,
				cleanCompletedLoops,
				nukeLoops,
				existsRalphDirectory: repo.existsRalphDirectory,
				syncCurrentLoopFromSession,
				persistOwnedLoopOnShutdown,
				runLoop,
				recordContinue,
				recordFinish,
				handleAgentEnd,
				configureLoop,
				configureLoopMany,
				recaptureLoopExecutionProfile,
				recaptureLoopSandboxProfile,
			});
		}),
	);
