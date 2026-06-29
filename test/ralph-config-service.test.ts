import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";

import {
	applyRalphConfigMutation,
	makeRalphLoopConfigService,
	RalphConfigLoopNotFoundError,
} from "../src/ralph/config-service.js";
import { emptyRalphLoopMetrics } from "../src/ralph/schema.js";
import { makeEmptyCapabilityContract } from "../src/ralph/contract.js";
import type { RalphRepoService } from "../src/ralph/repo.js";
import type { LoopState } from "../src/ralph/schema.js";

function makeMockRepo(initial: LoopState): RalphRepoService {
	let state = initial;
	return {
		loadState: () =>
			Effect.succeed(
				state.name === "missing" ? Option.none() : Option.some(state),
			),
		saveState: (_cwd: string, next: LoopState) =>
			Effect.sync(() => {
				state = next;
			}),
		listLoops: () => Effect.succeed([state]),
		findLoopBySessionFile: () => Effect.succeed(Option.some(state)),
		readTaskFile: () => Effect.succeed(Option.none()),
		writeTaskFile: () => Effect.void,
		ensureTaskFile: () => Effect.succeed(false),
		deleteState: () => Effect.void,
		deleteTaskByLoopName: () => Effect.void,
		archiveLoop: () => Effect.void,
		existsRalphDirectory: () => Effect.succeed(true),
		removeRalphDirectory: () => Effect.void,
	};
}

function makeTestLoop(overrides?: Partial<LoopState>): LoopState {
	return {
		name: "test-loop",
		taskFile: ".pi/loops/tasks/test-loop.md",
		iteration: 3,
		maxIterations: 50,
		itemsPerIteration: 2,
		reflectEvery: 5,
		reflectInstructions: "Reflect now",
		status: "paused",
		startedAt: new Date().toISOString(),
		completedAt: Option.none(),
		lastReflectionAt: 0,
		controllerSessionFile: Option.none(),
		activeIterationSessionFile: Option.none(),
		pendingDecision: Option.none(),
		sandboxProfile: Option.none(),
		metrics: emptyRalphLoopMetrics(),
		executionProfile: {
			model: "test-model",
			thinking: "medium",
			policy: { tools: { kind: "inherit" } },
		},
		capabilityContract: makeEmptyCapabilityContract(),
		deferredConfigMutations: [],
		...overrides,
	};
}

describe("ralph loop config service", () => {
	it("loads an existing loop", async () => {
		const loop = makeTestLoop();
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.name).toBe("test-loop");
	});

	it("throws for missing loop", async () => {
		const loop = makeTestLoop({ name: "missing" });
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		await expect(service.loadLoop("/tmp", "missing")).rejects.toThrow(
			RalphConfigLoopNotFoundError,
		);
	});

	it("mutates maxIterations", async () => {
		const loop = makeTestLoop();
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "maxIterations",
			value: 100,
		});
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.maxIterations).toBe(100);
	});

	it("mutates itemsPerIteration", async () => {
		const loop = makeTestLoop();
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "itemsPerIteration",
			value: 5,
		});
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.itemsPerIteration).toBe(5);
	});

	it("mutates reflectEvery", async () => {
		const loop = makeTestLoop();
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "reflectEvery",
			value: 10,
		});
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.reflectEvery).toBe(10);
	});

	it("mutates reflectInstructions", async () => {
		const loop = makeTestLoop();
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "reflectInstructions",
			value: "New instructions",
		});
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.reflectInstructions).toBe("New instructions");
	});

	it("mutates capability contract tools", async () => {
		const loop = makeTestLoop({
			capabilityContract: {
				version: "1",
				tools: {
					activeNames: ["read"],
					availableSnapshot: [
						{ name: "read", label: "Read", description: "Read files" },
						{ name: "exec_command", label: "Bash", description: "Run commands" },
					],
				},
				agents: {
					enabledNames: [],
					registrySnapshot: [],
				},
			},
		});
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "capabilityContractTools",
			activeNames: ["read", "exec_command"],
		});
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.capabilityContract.tools.activeNames).toEqual(["read", "exec_command"]);
	});

	it("mutates capability contract agents", async () => {
		const loop = makeTestLoop({
			capabilityContract: {
				version: "1",
				tools: {
					activeNames: [],
					availableSnapshot: [],
				},
				agents: {
					enabledNames: ["finder"],
					registrySnapshot: [
						{ name: "finder", description: "Find code" },
						{ name: "oracle", description: "Deep reasoning" },
					],
				},
			},
		});
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "capabilityContractAgents",
			enabledNames: ["finder", "oracle"],
		});
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.capabilityContract.agents.enabledNames).toEqual(["finder", "oracle"]);
	});

	it("returns no_change when mutation produces identical state", async () => {
		const loop = makeTestLoop({ maxIterations: 50 });
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "maxIterations",
			value: 50,
		});
		expect(result.status).toBe("no_change");
	});

	it("defers active-child contract edits", async () => {
		const loop = makeTestLoop({
			status: "active",
			activeIterationSessionFile: Option.some("/tmp/session.json"),
			capabilityContract: {
				version: "1",
				tools: {
					activeNames: [],
					availableSnapshot: [],
				},
				agents: {
					enabledNames: ["finder"],
					registrySnapshot: [
						{ name: "finder", description: "Find code" },
						{ name: "oracle", description: "Deep reasoning" },
					],
				},
			},
		});
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "capabilityContractAgents",
			enabledNames: ["finder", "oracle"],
		});
		expect(result.status).toBe("deferred");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.capabilityContract.agents.enabledNames).toEqual(["finder"]);
		expect(loaded.deferredConfigMutations).toEqual([
			{ kind: "capabilityContractAgents", enabledNames: ["finder", "oracle"] },
		]);
	});

	it("applies deferred contract edits when the next iteration begins", () => {
		const loop = makeTestLoop({
			deferredConfigMutations: [
				{ kind: "capabilityContractTools", activeNames: ["read", "exec_command"] },
			],
		});
		let next = loop;
		for (const mutation of loop.deferredConfigMutations) {
			next = applyRalphConfigMutation(next, mutation);
		}
		next = { ...next, deferredConfigMutations: [] };
		expect(next.capabilityContract.tools.activeNames).toEqual(["read", "exec_command"]);
		expect(next.deferredConfigMutations).toEqual([]);
	});

	it("allows contract mutations for active loops without a child session", async () => {
		const loop = makeTestLoop({
			status: "active",
			activeIterationSessionFile: Option.none(),
		});
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "capabilityContractAgents",
			enabledNames: ["finder"],
		});

		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.capabilityContract.agents.enabledNames).toEqual(["finder"]);
	});

	it("allows scalar mutations even with active child", async () => {
		const loop = makeTestLoop({
			status: "active",
			activeIterationSessionFile: Option.some("/tmp/session.json"),
		});
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutate("/tmp", "test-loop", {
			kind: "maxIterations",
			value: 100,
		});
		expect(result.status).toBe("updated");
	});

	it("applies multiple mutations atomically", async () => {
		const loop = makeTestLoop();
		const service = makeRalphLoopConfigService(makeMockRepo(loop));
		const result = await service.mutateMany("/tmp", "test-loop", [
			{ kind: "maxIterations", value: 100 },
			{ kind: "itemsPerIteration", value: 5 },
			{ kind: "reflectEvery", value: 10 },
		]);
		expect(result.status).toBe("updated");
		const loaded = await service.loadLoop("/tmp", "test-loop");
		expect(loaded.maxIterations).toBe(100);
		expect(loaded.itemsPerIteration).toBe(5);
		expect(loaded.reflectEvery).toBe(10);
	});
});
