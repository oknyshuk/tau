import { Effect, Layer, Ref, HashMap, Option, Semaphore } from "effect";
import {
	AgentManager,
	AgentConfig,
	type Agent,
	type AgentInfo,
	AgentLimitReached,
	AgentDepthExceeded,
	AgentNotFound,
	AgentAccessDenied,
	AgentSpawnRestricted,
} from "./services.js";
import { AgentRuntimeBridge } from "./runtime.js";
import type { AgentId } from "./types.js";
import { AgentWorker } from "./worker.js";
import { isFinal } from "./status.js";

const ORCHESTRATOR_PARENT = "orchestrator" as AgentId;

const canMutate = (
	parentMapRef: Ref.Ref<HashMap.HashMap<AgentId, AgentId>>,
	targetId: AgentId,
	requesterAgentId?: AgentId,
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		if (requesterAgentId === undefined) {
			return true;
		}
		const parentMap = yield* Ref.get(parentMapRef);
		const parentId = Option.getOrElse(
			HashMap.get(parentMap, targetId),
			() => ORCHESTRATOR_PARENT,
		);
		return parentId === requesterAgentId;
	});

const collectDescendants = (
	parentMap: HashMap.HashMap<AgentId, AgentId>,
	rootId: AgentId,
): AgentId[] => {
	const childrenByParent = new Map<AgentId, AgentId[]>();
	for (const [child, parent] of parentMap) {
		const list = childrenByParent.get(parent) ?? [];
		list.push(child);
		childrenByParent.set(parent, list);
	}

	const result: AgentId[] = [];
	const stack: AgentId[] = [rootId];
	const seen = new Set<AgentId>();
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined || seen.has(current)) {
			continue;
		}
		seen.add(current);
		result.push(current);
		const children = childrenByParent.get(current) ?? [];
		for (const child of children) {
			stack.push(child);
		}
	}

	return result;
};

const removeParentLinks = (
	parentMap: HashMap.HashMap<AgentId, AgentId>,
	targetId: AgentId,
): HashMap.HashMap<AgentId, AgentId> => {
	let next = HashMap.remove(parentMap, targetId);
	for (const [child, parent] of next) {
		if (parent === targetId) {
			next = HashMap.remove(next, child);
		}
	}
	return next;
};

export const AgentManagerLive = Layer.effect(
	AgentManager,
	Effect.gen(function* () {
		const config = yield* AgentConfig;
		const agentRuntime = yield* AgentRuntimeBridge;
		const agentsRef = yield* Ref.make(HashMap.empty<AgentId, Agent>());
		const depthMapRef = yield* Ref.make(HashMap.empty<AgentId, number>());
		const parentMapRef = yield* Ref.make(HashMap.empty<AgentId, AgentId>());
		const lastActivityRef = yield* Ref.make(HashMap.empty<AgentId, number>());
		const operationGate = yield* Semaphore.make(1);
		const withGate = operationGate.withPermits(1);

		const removeAgentState = (id: AgentId) =>
			Effect.gen(function* () {
				yield* Ref.update(agentsRef, (map) => HashMap.remove(map, id));
				yield* Ref.update(depthMapRef, (map) => HashMap.remove(map, id));
				yield* Ref.update(parentMapRef, (map) => removeParentLinks(map, id));
				yield* Ref.update(lastActivityRef, (map) => HashMap.remove(map, id));
			});

		const evictLru = Effect.gen(function* () {
			const agents = yield* Ref.get(agentsRef);
			const parentMap = yield* Ref.get(parentMapRef);
			const lastActivityMap = yield* Ref.get(lastActivityRef);

			const parentsWithActiveChildren = new Set<AgentId>();
			for (const [childId, parentId] of parentMap) {
				const child = HashMap.get(agents, childId);
				if (Option.isSome(child)) {
					const status = yield* child.value.status;
					if (!isFinal(status)) {
						parentsWithActiveChildren.add(parentId);
					}
				}
			}

			const candidates: Array<{ id: AgentId; lastUsed: number }> = [];
			for (const agent of HashMap.values(agents)) {
				const status = yield* agent.status;
				if (!isFinal(status)) {
					continue;
				}
				if (parentsWithActiveChildren.has(agent.id)) {
					continue;
				}
				const lastUsed = Option.getOrElse(HashMap.get(lastActivityMap, agent.id), () => 0);
				candidates.push({ id: agent.id, lastUsed });
			}

			if (candidates.length === 0) {
				return false;
			}

			candidates.sort((a, b) => a.lastUsed - b.lastUsed);
			const victim = candidates[0];
			if (victim === undefined) {
				return false;
			}

			const idsToClose = collectDescendants(parentMap, victim.id);
			for (const closedId of idsToClose) {
				const currentAgents = yield* Ref.get(agentsRef);
				const agent = HashMap.get(currentAgents, closedId);
				if (Option.isSome(agent)) {
					yield* agent.value.shutdown().pipe(
						Effect.tapError((error) =>
							Effect.logWarning("Agent shutdown failed during eviction", error),
						),
						Effect.catch(() => Effect.void),
					);
				}
				yield* removeAgentState(closedId);
			}

			return true;
		});

		return AgentManager.of({
			spawn: (opts) =>
				withGate(
					Effect.gen(function* () {
						const agents = yield* Ref.get(agentsRef);
						if (HashMap.size(agents) >= config.maxThreads) {
							const evicted = yield* evictLru;
							if (!evicted) {
								return yield* Effect.fail(
									new AgentLimitReached({ max: config.maxThreads }),
								);
							}
						}

						const depthMap = yield* Ref.get(depthMapRef);
						const parentDepth =
							opts.parentAgentId !== undefined
								? Option.getOrElse(
										HashMap.get(depthMap, opts.parentAgentId),
										() => 0,
									)
								: 0;
						const depth = parentDepth + 1;

						if (depth > config.maxDepth) {
							return yield* Effect.fail(
								new AgentDepthExceeded({ max: config.maxDepth }),
							);
						}

						if (opts.parentAgentId !== undefined) {
							const parentAgent = HashMap.get(agents, opts.parentAgentId);
							if (Option.isSome(parentAgent)) {
								const allowedSpawns = parentAgent.value.definition.spawns;
								if (
									allowedSpawns !== undefined &&
									allowedSpawns !== "*" &&
									!allowedSpawns.includes(opts.definition.name)
								) {
									return yield* Effect.fail(
										new AgentSpawnRestricted({
											parentId: opts.parentAgentId,
											parentType: parentAgent.value.type,
											requestedAgent: opts.definition.name,
											allowedSpawns,
										}),
									);
								}
							}
						}

						const agent = yield* AgentWorker.make({
							definition: opts.definition,
							depth: depth,
							cwd: opts.cwd,
							parentSessionFile: opts.parentSessionFile,
							executionState: opts.executionState,
							executionProfile: opts.executionProfile,
							parentSandboxConfig: opts.parentSandboxConfig,
							parentModel: opts.parentModel,
							approvalBroker: opts.approvalBroker,
							modelRegistry: opts.modelRegistry,
							runPromise: agentRuntime.runPromise,
							runFork: agentRuntime.runFork,
							...(opts.agentSummaries !== undefined
								? { agentSummaries: opts.agentSummaries }
								: {}),
						});

						const id = agent.id;
						const parentAgentId = opts.parentAgentId;
						yield* Ref.update(agentsRef, (map) => HashMap.set(map, id, agent));
						yield* Ref.update(depthMapRef, (map) => HashMap.set(map, id, depth));
						yield* Ref.update(lastActivityRef, (map) =>
							HashMap.set(map, id, Date.now()),
						);
						if (parentAgentId !== undefined) {
							yield* Ref.update(parentMapRef, (map) =>
								HashMap.set(map, id, parentAgentId),
							);
						}

						// Initial prompt
						yield* agent.prompt(opts.message);
						yield* Ref.update(lastActivityRef, (map) =>
							HashMap.set(map, id, Date.now()),
						);

						return id;
					}),
				),
			get: (id) =>
				Effect.gen(function* () {
					const agents = yield* Ref.get(agentsRef);
					const agent = HashMap.get(agents, id);
					if (Option.isNone(agent)) {
						return yield* Effect.fail(new AgentNotFound({ id }));
					}
					return agent.value;
				}),
			touch: (id) =>
				Ref.update(lastActivityRef, (map) => {
					if (Option.isNone(HashMap.get(map, id))) {
						return map;
					}
					return HashMap.set(map, id, Date.now());
				}),
			list: withGate(
				Effect.gen(function* () {
					const agents = yield* Ref.get(agentsRef);
					const parentMap = yield* Ref.get(parentMapRef);
					const infos: AgentInfo[] = [];
					for (const agent of HashMap.values(agents)) {
						const status = yield* agent.status;
						const parentAgentId = Option.getOrUndefined(
							HashMap.get(parentMap, agent.id),
						);
						infos.push({
							id: agent.id,
							type: agent.type,
							status,
							parentAgentId,
						});
					}
					return infos;
				}),
			),
			canMutate: (id, requesterAgentId) =>
				withGate(
					Effect.gen(function* () {
						const agents = yield* Ref.get(agentsRef);
						const agent = HashMap.get(agents, id);
						if (Option.isNone(agent)) {
							return yield* Effect.fail(new AgentNotFound({ id }));
						}
						return yield* canMutate(parentMapRef, id, requesterAgentId);
					}),
				),
			shutdown: (id, requesterAgentId) =>
				withGate(
					Effect.gen(function* () {
						const agents = yield* Ref.get(agentsRef);
						const agent = HashMap.get(agents, id);
						if (Option.isNone(agent)) {
							return yield* Effect.fail(new AgentNotFound({ id }));
						}

						const parentMap = yield* Ref.get(parentMapRef);
						const parentId = Option.getOrElse(
							HashMap.get(parentMap, id),
							() => ORCHESTRATOR_PARENT,
						);
						const allowed = yield* canMutate(parentMapRef, id, requesterAgentId);
						if (!allowed && requesterAgentId !== undefined) {
							return yield* Effect.fail(
								new AgentAccessDenied({
									id,
									requesterId: requesterAgentId,
									parentId,
								}),
							);
						}

						const idsToClose = collectDescendants(parentMap, id);
						for (const closedId of idsToClose) {
							const currentAgents = yield* Ref.get(agentsRef);
							const currentAgent = HashMap.get(currentAgents, closedId);
							if (Option.isSome(currentAgent)) {
								yield* currentAgent.value.shutdown();
							}
							yield* removeAgentState(closedId);
						}

						return idsToClose;
					}),
				),
			shutdownAll: withGate(
				Effect.gen(function* () {
					const agents = yield* Ref.get(agentsRef);
					for (const agent of HashMap.values(agents)) {
						yield* agent.shutdown().pipe(
							Effect.tapError((error) =>
								Effect.logWarning("Agent shutdown failed during shutdownAll", error),
							),
							Effect.catch(() => Effect.void),
						);
					}
					yield* Ref.set(agentsRef, HashMap.empty());
					yield* Ref.set(depthMapRef, HashMap.empty());
					yield* Ref.set(parentMapRef, HashMap.empty());
					yield* Ref.set(lastActivityRef, HashMap.empty());
				}),
			),
		});
	}),
);
