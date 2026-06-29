import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Option } from "effect";

import {
	AgentSelectionStore,
	clearRalphOwnedSessionCacheEntry,
	getAgentSettingsPath,
	preloadRalphOwnedSessionCache,
} from "../src/agents-menu/state.js";
import { encodeLoopPersistedStateJsonSync } from "../src/loops/schema.js";
import {
	makeExecutionProfile,
	makeSandboxProfile,
	makeRalphMetrics,
	makeCapabilityContract,
} from "./ralph-test-helpers.js";

async function makeWorkspace(): Promise<string> {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "tau-agents-settings-"));
	await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
	return workspace;
}

async function writeRalphState(
	workspace: string,
	loopName: string,
	input: {
		readonly controllerSessionFile: string;
		readonly activeIterationSessionFile?: string;
		readonly status?: "active" | "paused" | "completed";
		readonly enabledAgents?: ReadonlyArray<string>;
	},
): Promise<void> {
	const statePath = path.join(workspace, ".pi", "loops", "state", `${loopName}.json`);
	await fs.mkdir(path.dirname(statePath), { recursive: true });
	const status = input.status ?? "active";
	const lifecycle = status === "active" ? "active" : status === "paused" ? "paused" : "completed";
	const contract = makeCapabilityContract();
	await fs.writeFile(
		statePath,
		encodeLoopPersistedStateJsonSync({
			taskId: loopName,
			title: loopName,
			taskFile: path.join(".pi", "loops", "tasks", `${loopName}.md`),
			kind: "ralph",
			lifecycle,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			startedAt: Option.some("2026-01-01T00:00:00.000Z"),
			completedAt:
				status === "completed" ? Option.some("2026-01-01T01:00:00.000Z") : Option.none(),
			archivedAt: Option.none(),
			ownership: {
				controller: Option.some({
					sessionId: input.controllerSessionFile,
					sessionFile: input.controllerSessionFile,
				}),
				child:
					input.activeIterationSessionFile === undefined
						? Option.none()
						: Option.some({
								sessionId: input.activeIterationSessionFile,
								sessionFile: input.activeIterationSessionFile,
							}),
			},
			ralph: {
				iteration: 1,
				maxIterations: 50,
				itemsPerIteration: 0,
				reflectEvery: 0,
				reflectInstructions: "reflect",
				lastReflectionAt: 0,
				pendingDecision: Option.none(),
				pinnedExecutionProfile: makeExecutionProfile(),
				sandboxProfile: Option.some(makeSandboxProfile()),
				metrics: makeRalphMetrics(),
				capabilityContract: {
					...contract,
					agents: {
						...contract.agents,
						enabledNames: input.enabledAgents ?? ["finder"],
					},
				},
				deferredConfigMutations: [],
			},
		}),
		"utf8",
	);
}

describe("agent selection settings", () => {
	const cleanup = new Set<string>();

	afterEach(async () => {
		await Promise.all(
			Array.from(cleanup, (dir) => fs.rm(dir, { recursive: true, force: true })),
		);
		cleanup.clear();
	});

	it("loads saved enabled agents from project settings", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const settingsPath = getAgentSettingsPath(workspace);

		await fs.mkdir(path.dirname(settingsPath), { recursive: true });
		await fs.writeFile(
			settingsPath,
			JSON.stringify({ tau: { agents: { enabled: ["finder"] } } }, null, 2),
			"utf8",
		);

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["deep", "finder", "smart"]);

		expect(store.isDisabledForCwd(workspace, "finder")).toBe(false);
		expect(store.isDisabledForCwd(workspace, "deep")).toBe(true);
		expect(store.isDisabledForCwd(workspace, "smart")).toBe(true);
	});

	it("fails closed when project settings JSON is malformed", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const settingsPath = getAgentSettingsPath(workspace);

		await fs.mkdir(path.dirname(settingsPath), { recursive: true });
		await fs.writeFile(settingsPath, '{\n  "tau":', "utf8");

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["deep", "finder", "smart"]);

		expect(store.isDisabledForCwd(workspace, "finder")).toBe(true);
		expect(store.isDisabledForCwd(workspace, "deep")).toBe(true);
		expect(store.isDisabledForCwd(workspace, "smart")).toBe(true);
	});

	it("fails closed when project settings JSON is not an object", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const settingsPath = getAgentSettingsPath(workspace);

		await fs.mkdir(path.dirname(settingsPath), { recursive: true });
		await fs.writeFile(settingsPath, JSON.stringify(["invalid"]), "utf8");

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["deep", "finder", "smart"]);

		expect(store.isDisabledForCwd(workspace, "finder")).toBe(true);
		expect(store.isDisabledForCwd(workspace, "deep")).toBe(true);
		expect(store.isDisabledForCwd(workspace, "smart")).toBe(true);
	});

	it("keeps unsaved agent changes across reactivation for the same project", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["finder", "smart"]);
		store.setEnabledForCwd(workspace, "smart", false);

		await store.activate(workspace, ["finder", "smart"]);

		expect(store.isDisabledForCwd(workspace, "smart")).toBe(true);
		expect(store.isDisabledForCwd(workspace, "finder")).toBe(false);
	});

	it("tracks disabled agents per project instead of using the last activated project", async () => {
		const workspaceA = await makeWorkspace();
		const workspaceB = await makeWorkspace();
		cleanup.add(workspaceA);
		cleanup.add(workspaceB);

		const store = new AgentSelectionStore();
		await store.activate(workspaceA, ["finder", "smart"]);
		store.setEnabledForCwd(workspaceA, "smart", false);

		await store.activate(workspaceB, ["finder", "smart"]);

		expect(store.isDisabledForCwd(workspaceA, "smart")).toBe(true);
		expect(store.isDisabledForCwd(workspaceB, "smart")).toBe(false);
	});

	it("persists enabled agents into project settings without overwriting unrelated settings", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const settingsPath = getAgentSettingsPath(workspace);

		await fs.mkdir(path.dirname(settingsPath), { recursive: true });
		await fs.writeFile(
			settingsPath,
			JSON.stringify(
				{
					other: { keep: true },
					tau: { dream: { enabled: true } },
				},
				null,
				2,
			),
			"utf8",
		);

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["finder", "smart"]);
		store.setEnabledForCwd(workspace, "smart", false);
		await store.persistForCwd(workspace, ["finder", "smart"]);

		const raw = await fs.readFile(settingsPath, "utf8");
		expect(JSON.parse(raw)).toEqual({
			other: { keep: true },
			tau: {
				agents: { enabled: ["finder"] },
				dream: { enabled: true },
			},
		});
	});

	it("tracks dirty state per project independently", async () => {
		const workspaceA = await makeWorkspace();
		const workspaceB = await makeWorkspace();
		cleanup.add(workspaceA);
		cleanup.add(workspaceB);

		const store = new AgentSelectionStore();
		await store.activate(workspaceA, ["finder", "smart"]);
		await store.activate(workspaceB, ["finder", "smart"]);
		store.setEnabledForCwd(workspaceA, "smart", false);

		expect(store.isDirtyForCwd(workspaceA)).toBe(true);
		expect(store.isDirtyForCwd(workspaceB)).toBe(false);
	});

	it("applies the default Ralph agent allowlist for Ralph-owned sessions", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const controllerSession = path.join(
			workspace,
			".pi",
			"sessions",
			"controller.session.json",
		);

		await writeRalphState(workspace, "loop-a", {
			controllerSessionFile: controllerSession,
		});

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["deep", "finder", "librarian", "smart"]);
		await preloadRalphOwnedSessionCache(workspace, controllerSession);

		expect(store.isDisabledForSession(workspace, controllerSession, "finder")).toBe(false);
		expect(store.isDisabledForSession(workspace, controllerSession, "librarian")).toBe(true);
		expect(store.isDisabledForSession(workspace, controllerSession, "deep")).toBe(true);
		expect(store.isDisabledForSession(workspace, controllerSession, "smart")).toBe(true);
	});

	it("uses loop-state capabilityContract.agents.enabledNames for Ralph-owned sessions", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const iterationSession = path.join(workspace, ".pi", "sessions", "iteration.session.json");

		await writeRalphState(workspace, "loop-b", {
			controllerSessionFile: path.join(
				workspace,
				".pi",
				"sessions",
				"controller.session.json",
			),
			activeIterationSessionFile: iterationSession,
			enabledAgents: ["finder", "oracle"],
		});

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["finder", "librarian", "oracle"]);
		await preloadRalphOwnedSessionCache(workspace, iterationSession);

		expect(store.isDisabledForSession(workspace, iterationSession, "finder")).toBe(false);
		expect(store.isDisabledForSession(workspace, iterationSession, "oracle")).toBe(false);
		expect(store.isDisabledForSession(workspace, iterationSession, "librarian")).toBe(true);
	});

	it("rescans Ralph ownership after an early miss for a newly attached child session", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const iterationSession = path.join(workspace, ".pi", "sessions", "late-child.session.json");

		await expect(preloadRalphOwnedSessionCache(workspace, iterationSession)).resolves.toBe(
			false,
		);
		await writeRalphState(workspace, "late-loop", {
			controllerSessionFile: path.join(
				workspace,
				".pi",
				"sessions",
				"controller.session.json",
			),
			activeIterationSessionFile: iterationSession,
			enabledAgents: ["finder"],
		});

		const store = new AgentSelectionStore();
		const enabled = await store.resolveEnabledAgentsForSession(workspace, iterationSession, [
			"finder",
			"librarian",
		]);

		expect(enabled).toEqual(["finder"]);
		expect(store.isDisabledForSession(workspace, iterationSession, "librarian")).toBe(true);
	});

	it("Ralph loop state overrides project settings for Ralph-owned sessions", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const settingsPath = getAgentSettingsPath(workspace);
		const controllerSession = path.join(
			workspace,
			".pi",
			"sessions",
			"controller.session.json",
		);

		await fs.mkdir(path.dirname(settingsPath), { recursive: true });
		await fs.writeFile(
			settingsPath,
			JSON.stringify({ tau: { agents: { enabled: ["librarian"] } } }, null, 2),
			"utf8",
		);
		await writeRalphState(workspace, "loop-c", {
			controllerSessionFile: controllerSession,
			enabledAgents: ["librarian"],
		});

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["finder", "librarian"]);
		await preloadRalphOwnedSessionCache(workspace, controllerSession);

		expect(store.isDisabledForSession(workspace, controllerSession, "finder")).toBe(true);
		expect(store.isDisabledForSession(workspace, controllerSession, "librarian")).toBe(false);
	});

	it("Ralph loop state is authoritative over project-disabled agents", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const settingsPath = getAgentSettingsPath(workspace);
		const controllerSession = path.join(
			workspace,
			".pi",
			"sessions",
			"controller.session.json",
		);

		await fs.mkdir(path.dirname(settingsPath), { recursive: true });
		await fs.writeFile(
			settingsPath,
			JSON.stringify({ tau: { agents: { enabled: ["finder"] } } }, null, 2),
			"utf8",
		);
		await writeRalphState(workspace, "loop-c2", {
			controllerSessionFile: controllerSession,
			enabledAgents: ["oracle"],
		});

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["finder", "oracle"]);
		await preloadRalphOwnedSessionCache(workspace, controllerSession);

		expect(store.isDisabledForSession(workspace, controllerSession, "finder")).toBe(true);
		expect(store.isDisabledForSession(workspace, controllerSession, "oracle")).toBe(false);
	});

	it("ignores completed Ralph loops when computing session restrictions", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const controllerSession = path.join(
			workspace,
			".pi",
			"sessions",
			"controller.session.json",
		);

		await writeRalphState(workspace, "loop-d", {
			controllerSessionFile: controllerSession,
			status: "completed",
		});

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["deep", "finder", "librarian", "smart"]);
		await preloadRalphOwnedSessionCache(workspace, controllerSession);

		expect(store.isDisabledForSession(workspace, controllerSession, "deep")).toBe(false);
		expect(store.isDisabledForSession(workspace, controllerSession, "smart")).toBe(false);
	});

	it("refreshes a stale Ralph ownership cache entry after loop completion", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const iterationSession = path.join(workspace, ".pi", "sessions", "iteration.session.json");

		await writeRalphState(workspace, "loop-stale", {
			controllerSessionFile: path.join(
				workspace,
				".pi",
				"sessions",
				"controller.session.json",
			),
			activeIterationSessionFile: iterationSession,
			enabledAgents: ["finder"],
		});
		await preloadRalphOwnedSessionCache(workspace, iterationSession);
		await writeRalphState(workspace, "loop-stale", {
			controllerSessionFile: path.join(
				workspace,
				".pi",
				"sessions",
				"controller.session.json",
			),
			activeIterationSessionFile: iterationSession,
			status: "completed",
			enabledAgents: ["finder"],
		});

		const store = new AgentSelectionStore();
		const enabled = await store.resolveEnabledAgentsForSession(workspace, iterationSession, [
			"finder",
			"librarian",
		]);

		expect(enabled).toEqual(["finder", "librarian"]);
		expect(store.isDisabledForSession(workspace, iterationSession, "librarian")).toBe(false);
	});

	it("clears one Ralph ownership cache entry without releasing active sibling sessions", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const iterationSession = path.join(workspace, ".pi", "sessions", "iteration.session.json");
		const unrelatedSession = path.join(workspace, ".pi", "sessions", "unrelated.session.json");

		await writeRalphState(workspace, "loop-cache-entry", {
			controllerSessionFile: path.join(
				workspace,
				".pi",
				"sessions",
				"controller.session.json",
			),
			activeIterationSessionFile: iterationSession,
			enabledAgents: ["finder"],
		});
		await preloadRalphOwnedSessionCache(workspace, iterationSession);

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["finder", "librarian"]);
		clearRalphOwnedSessionCacheEntry(workspace, unrelatedSession);

		expect(store.isDisabledForSession(workspace, iterationSession, "librarian")).toBe(true);
	});

	it("normalizes Ralph ownership cache keys to the workspace root", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const subdir = path.join(workspace, "src");
		await fs.mkdir(subdir, { recursive: true });
		const iterationSession = path.join(workspace, ".pi", "sessions", "iteration.session.json");

		await writeRalphState(workspace, "loop-cache-root", {
			controllerSessionFile: path.join(
				workspace,
				".pi",
				"sessions",
				"controller.session.json",
			),
			activeIterationSessionFile: iterationSession,
			enabledAgents: ["finder"],
		});
		await preloadRalphOwnedSessionCache(workspace, iterationSession);
		await preloadRalphOwnedSessionCache(subdir, iterationSession);
		clearRalphOwnedSessionCacheEntry(workspace, iterationSession);

		const store = new AgentSelectionStore();
		await store.activate(subdir, ["finder", "librarian"]);

		expect(store.isDisabledForSession(subdir, iterationSession, "librarian")).toBe(false);
	});

	it("resolves authoritative session restrictions without prior activation or Ralph cache warmup", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const settingsPath = getAgentSettingsPath(workspace);
		const controllerSession = path.join(
			workspace,
			".pi",
			"sessions",
			"controller.session.json",
		);

		await fs.mkdir(path.dirname(settingsPath), { recursive: true });
		await fs.writeFile(
			settingsPath,
			JSON.stringify(
				{ tau: { agents: { enabled: ["deep", "finder", "librarian"] } } },
				null,
				2,
			),
			"utf8",
		);
		await writeRalphState(workspace, "loop-e", {
			controllerSessionFile: controllerSession,
			enabledAgents: ["finder", "librarian"],
		});

		const store = new AgentSelectionStore();
		const enabled = await store.resolveEnabledAgentsForSession(workspace, controllerSession, [
			"deep",
			"finder",
			"librarian",
		]);

		expect(enabled).toEqual(["finder", "librarian"]);
		expect(store.isDisabledForSession(workspace, controllerSession, "deep")).toBe(true);
		expect(store.isDisabledForSession(workspace, controllerSession, "finder")).toBe(false);
	});

	it("ignores stale child .pi/loops ownership when a parent git root exists", async () => {
		const parent = await makeWorkspace();
		cleanup.add(parent);
		await fs.mkdir(path.join(parent, ".git"), { recursive: true });
		const workspace = path.join(parent, "apsis");
		await fs.mkdir(workspace, { recursive: true });
		const childSession = path.join(workspace, ".pi", "sessions", "iteration.session.json");

		await writeRalphState(parent, "loop-f", {
			controllerSessionFile: path.join(workspace, ".pi", "sessions", "controller.session.json"),
			activeIterationSessionFile: childSession,
			enabledAgents: ["finder"],
		});
		await writeRalphState(workspace, "stale-loop-f", {
			controllerSessionFile: path.join(workspace, ".pi", "sessions", "stale-controller.session.json"),
			activeIterationSessionFile: childSession,
			enabledAgents: ["oracle"],
		});

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["finder", "oracle"]);
		await preloadRalphOwnedSessionCache(workspace, childSession);

		expect(store.isDisabledForSession(workspace, childSession, "finder")).toBe(false);
		expect(store.isDisabledForSession(workspace, childSession, "oracle")).toBe(true);
	});
});
