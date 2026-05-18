import { Effect, Layer, Result, Schedule, Stream } from "effect";
import { errorMessage } from "../shared/error-message.js";
import {
	AgentControl,
	AgentManager,
	AgentError,
	AgentAccessDenied,
	AgentSpawnRestricted,
	type Status,
	type ControlSpawnOptions,
	type SpawnOptions,
	type WaitResult,
} from "./services.js";
import { AgentRegistry } from "./agent-registry.js";
import { isFinal } from "./status.js";
import type { AgentId } from "./types.js";
import { Sandbox } from "../services/sandbox.js";
import { resolveEnabledAgentsForSessionAuthoritative } from "../agents-menu/index.js";
import { getRalphLoopMetadata } from "../agents-menu/state.js";
import { resolveAgentExecutionAtSpawn } from "./execution-profile.js";
import type { AgentDefinition } from "./types.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
export const MAX_WAIT_TIMEOUT_MS = 4 * 60 * 60 * 1000;

function formatEnabledAgents(enabled: ReadonlyArray<string>): string {
	return enabled.length > 0 ? enabled.join(", ") : "(none)";
}

export function buildDisabledAgentMessage(
	agentName: string,
	enabledAgents: ReadonlyArray<string>,
): string {
	return `Agent "${agentName}" is disabled for this session. Enabled agents: ${formatEnabledAgents(enabledAgents)}. If this agent is required, ask the user to enable it for this session.`;
}

export function normalizeWaitTimeoutMs(timeoutMs: number | undefined): number {
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
		return DEFAULT_WAIT_TIMEOUT_MS;
	}

	return Math.min(Math.max(timeoutMs, DEFAULT_WAIT_TIMEOUT_MS), MAX_WAIT_TIMEOUT_MS);
}

export function clampAgentDefinitionToolsToParentTools(
	definition: AgentDefinition,
	parentTools: ReadonlyArray<string> | undefined,
): AgentDefinition {
	if (parentTools === undefined) {
		return definition;
	}

	const allowed = new Set(parentTools);
	const tools =
		definition.tools === undefined
			? parentTools
			: definition.tools.filter((tool) => allowed.has(tool));

	return {
		...definition,
		tools: [...tools],
	};
}

export const AgentControlLive = Layer.effect(
	AgentControl,
	Effect.gen(function* () {
		const manager = yield* AgentManager;
		const sandbox = yield* Sandbox;
		const touchIds = (ids: ReadonlyArray<AgentId>) =>
			Effect.forEach(ids, (id) => manager.touch(id), { discard: true }).pipe(
				Effect.tapError((error) => Effect.logWarning("Agent touch failed", error)),
				Effect.catch(() => Effect.void),
			);

		return AgentControl.of({
			spawn: (opts: ControlSpawnOptions) =>
				Effect.gen(function* () {
					const parentExecution = opts.parentExecution;
					const registry = yield* AgentRegistry.load(opts.cwd);
					const availableAgents = registry.names();
					const definition = registry.resolve(opts.agent);

					if (!definition) {
						return yield* Effect.fail(
							new AgentError({
								message: `Unknown agent: "${opts.agent}". Available: ${availableAgents.join(", ")}`,
							}),
						);
					}

					const enabledAgents = yield* Effect.promise(() =>
						resolveEnabledAgentsForSessionAuthoritative(
							opts.cwd,
							opts.parentSessionFile,
							availableAgents,
						),
					);

					if (!enabledAgents.includes(opts.agent)) {
						return yield* Effect.fail(
							new AgentError({
								message: buildDisabledAgentMessage(opts.agent, enabledAgents),
							}),
						);
					}

					const parentSandboxConfig = yield* sandbox.getConfig;
					const ralphMetadata = getRalphLoopMetadata(opts.cwd, opts.parentSessionFile);
					const policyDefinition = clampAgentDefinitionToolsToParentTools(
						definition,
						ralphMetadata?.activeTools,
					);
					const resolvedExecution = yield* resolveAgentExecutionAtSpawn({
						definition: policyDefinition,
						cwd: opts.cwd,
						parentExecutionState: parentExecution.state,
						parentExecutionProfile: parentExecution.profile,
					});

					return yield* manager.spawn({
						definition: resolvedExecution.definition,
						message: opts.message,
						depth: 0, // Depth is handled by manager now
						cwd: opts.cwd,
						parentSessionFile: opts.parentSessionFile,
						executionState: resolvedExecution.executionState,
						executionProfile: resolvedExecution.executionProfile,
						parentAgentId: opts.parentAgentId,
						parentSandboxConfig,
						parentModel: opts.parentModel,
						approvalBroker: opts.approvalBroker,
						modelRegistry: opts.modelRegistry,
						resultSchema: opts.result_schema,
						agentSummaries: registry.list(),
					} satisfies SpawnOptions as SpawnOptions);
				}).pipe(
					Effect.mapError((error) =>
						error instanceof AgentError || error instanceof AgentSpawnRestricted
							? error
							: new AgentError({
									message: errorMessage(error),
								}),
					),
				),
			send: (id: AgentId, message: string, interrupt?: boolean, requesterAgentId?: AgentId) =>
				Effect.gen(function* () {
					const agent = yield* manager.get(id);
					const canRequesterMutate = yield* manager.canMutate(id, requesterAgentId);
					if (!canRequesterMutate && requesterAgentId !== undefined) {
						const agents = yield* manager.list;
						const target = agents.find((info) => info.id === id);
						const parentId = target?.parentAgentId ?? "orchestrator";
						return yield* Effect.fail(
							new AgentAccessDenied({
								id,
								requesterId: requesterAgentId,
								parentId,
							}),
						);
					}
					if (interrupt) {
						yield* agent.interrupt();
					}
					const submissionId = yield* agent.prompt(message);
					yield* manager.touch(id);
					return submissionId;
				}),
			wait: (ids: AgentId[], timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) =>
				Effect.gen(function* () {
					const startedAt = Date.now();
					const boundedTimeoutMs = normalizeWaitTimeoutMs(timeoutMs);
					const timeout = `${boundedTimeoutMs} millis` as const;

					const getStatusMap = Effect.gen(function* () {
						const statusMap: Record<string, Status> = {};
						for (const id of ids) {
							const agentResult = yield* manager.get(id).pipe(Effect.result);
							if (Result.isFailure(agentResult)) {
								statusMap[id] = { state: "failed", reason: "Not found" };
							} else {
								statusMap[id] = yield* agentResult.success.status;
							}
						}
						return statusMap;
					});

					const allFinal = (statusMap: Record<string, Status>) =>
						Object.values(statusMap).every(isFinal);

					const initialStatusMap = yield* getStatusMap;
					if (allFinal(initialStatusMap) || ids.length === 0) {
						return {
							status: initialStatusMap,
							timedOut: false,
							timeoutMs: boundedTimeoutMs,
							waitElapsedMs: Date.now() - startedAt,
						};
					}

					const waitAll = Effect.gen(function* () {
						// Poll until all agents reach final state
						// Using stream subscription for each non-final agent
						const waitForAgent = (id: AgentId) =>
							Effect.gen(function* () {
								const agentResult = yield* manager.get(id).pipe(Effect.result);
								if (Result.isFailure(agentResult)) {
									return;
								}
								const currentStatus = yield* agentResult.success.status;
								if (isFinal(currentStatus)) {
									return;
								}

								// Wait for this specific agent to complete
								yield* agentResult.success
									.subscribeStatus()
									.pipe(Stream.filter(isFinal), Stream.take(1), Stream.runDrain);
							});

						// Wait for all agents concurrently
						yield* Effect.all(
							ids.map((id) => waitForAgent(id)),
							{ concurrency: "unbounded" },
						);

						return yield* getStatusMap;
					});

					return yield* waitAll.pipe(
						Effect.timeout(timeout),
						Effect.map((status) => ({
							status,
							timedOut: false,
							timeoutMs: boundedTimeoutMs,
							waitElapsedMs: Date.now() - startedAt,
						})),
						Effect.catchTag("TimeoutError", () =>
							Effect.gen(function* () {
								const status = yield* getStatusMap;
								return {
									status,
									timedOut: true,
									timeoutMs: boundedTimeoutMs,
									waitElapsedMs: Date.now() - startedAt,
								};
							}),
						),
					);
				}).pipe(
					Effect.ensuring(
						Effect.gen(function* () {
							yield* touchIds(ids);
						}),
					),
				),
			waitStream: (
				ids: AgentId[],
				timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
				pollIntervalMs = 1000,
			) => {
				const boundedTimeoutMs = normalizeWaitTimeoutMs(timeoutMs);
				const pollInterval = Math.max(pollIntervalMs, 250); // Min 250ms
				const startedAt = Date.now();

				const getStatusAndTypes = Effect.gen(function* () {
					const statusMap: Record<string, Status> = {};
					const agentTypes: Record<string, string> = {};
					for (const id of ids) {
						const agentResult = yield* manager.get(id).pipe(Effect.result);
						if (Result.isFailure(agentResult)) {
							statusMap[id] = { state: "failed", reason: "Not found" };
							agentTypes[id] = "unknown";
						} else {
							statusMap[id] = yield* agentResult.success.status;
							agentTypes[id] = agentResult.success.type;
						}
					}
					return { statusMap, agentTypes };
				});

				const allFinal = (statusMap: Record<string, Status>) =>
					Object.values(statusMap).every(isFinal);

				const pollEffect = Effect.gen(function* () {
					const { statusMap, agentTypes } = yield* getStatusAndTypes;
					const waitElapsedMs = Date.now() - startedAt;
					const timedOut = waitElapsedMs >= boundedTimeoutMs;
					return {
						status: statusMap,
						timedOut,
						agentTypes,
						timeoutMs: boundedTimeoutMs,
						waitElapsedMs,
					} satisfies WaitResult;
				});

				return Stream.fromEffectSchedule(pollEffect, Schedule.spaced(pollInterval)).pipe(
					Stream.takeUntil(
						(result) => allFinal(result.status) || result.timedOut || ids.length === 0,
					),
					Stream.ensuring(
						Effect.gen(function* () {
							yield* touchIds(ids);
						}),
					),
				);
			},
			close: (id: AgentId, requesterAgentId?: AgentId) =>
				Effect.gen(function* () {
					return yield* manager.shutdown(id, requesterAgentId);
				}),
			closeAll: manager.shutdownAll,
			list: manager.list,
		});
	}),
);
