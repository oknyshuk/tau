import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

import { LoopRepo, LoopRepoLive } from "../src/loops/repo.js";
import { LoopContractValidationError } from "../src/loops/errors.js";
import type {
	LoopPersistedState,
	LoopSessionRef,
} from "../src/loops/schema.js";
import {
	makeExecutionProfile,
	makeSandboxProfile,
	makeRalphMetrics,
	makeCapabilityContract,
} from "./ralph-test-helpers.js";

const loopRepoLayer = LoopRepoLive.pipe(Layer.provide(NodeFileSystem.layer));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-loops-repo-"));
}

function makeControllerSessionRef(): LoopSessionRef {
	return {
		sessionId: "controller-session-id",
		sessionFile: "/tmp/controller.session.json",
	};
}

function makeLoopState(taskId: string): LoopPersistedState {
	return {
		taskId,
		title: `Loop ${taskId}`,
		taskFile: path.join(".pi", "loops", "tasks", `${taskId}.md`),
		kind: "ralph",
		lifecycle: "paused",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		startedAt: Option.some("2026-01-01T00:00:00.000Z"),
		completedAt: Option.none(),
		archivedAt: Option.none(),
		ownership: {
			controller: Option.some(makeControllerSessionRef()),
			child: Option.none(),
		},
		ralph: {
			iteration: 2,
			maxIterations: 20,
			itemsPerIteration: 3,
			reflectEvery: 5,
			reflectInstructions: "reflect",
			lastReflectionAt: 0,
			pendingDecision: Option.none(),
			pinnedExecutionProfile: makeExecutionProfile(),
			sandboxProfile: Option.some(makeSandboxProfile()),
			metrics: makeRalphMetrics(),
			capabilityContract: makeCapabilityContract(),
			deferredConfigMutations: [],
		},
	};
}

describe("loop repo", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists canonical loop state and task files under .pi/loops", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const loopState = makeLoopState("repo-loop");
		const loaded = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* LoopRepo;
				yield* repo.writeTaskFile(cwd, loopState.taskId, "# Task\n");
				yield* repo.saveState(cwd, loopState);
				return yield* repo.loadState(cwd, loopState.taskId);
			}).pipe(Effect.provide(loopRepoLayer)),
		);

		expect(Option.isSome(loaded)).toBe(true);
		if (Option.isSome(loaded)) {
			expect(loaded.value).toEqual(loopState);
		}
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "state", "repo-loop.json"))).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "tasks", "repo-loop.md"))).toBe(true);
	});

	it("ignores stale nested .pi/loops when a parent git root exists", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
		const nestedCwd = path.join(cwd, "packages", "feature");
		fs.mkdirSync(path.join(nestedCwd, ".pi", "loops"), { recursive: true });

		const loopState = makeLoopState("nested-root-loop");
		const loaded = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* LoopRepo;
				yield* repo.saveState(nestedCwd, loopState);
				return yield* repo.loadState(nestedCwd, loopState.taskId);
			}).pipe(Effect.provide(loopRepoLayer)),
		);

		expect(Option.isSome(loaded)).toBe(true);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "state", "nested-root-loop.json")),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(nestedCwd, ".pi", "loops", "state", "nested-root-loop.json"),
			),
		).toBe(false);
	});

	it("fails fast on legacy state files missing required ralph fields", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const taskId = "legacy-repo-loop";
		const statePath = path.join(cwd, ".pi", "loops", "state", `${taskId}.json`);

		await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* LoopRepo;
				yield* repo.saveState(cwd, makeLoopState(taskId));
			}).pipe(Effect.provide(loopRepoLayer)),
		);

		const parsedLegacy = JSON.parse(fs.readFileSync(statePath, "utf-8")) as unknown;
		expect(isRecord(parsedLegacy)).toBe(true);
		if (!isRecord(parsedLegacy)) {
			throw new Error("expected record loop state payload");
		}
		const parsedRalph = parsedLegacy["ralph"];
		expect(isRecord(parsedRalph)).toBe(true);
		if (!isRecord(parsedRalph)) {
			throw new Error("expected record ralph payload");
		}

		const legacyRalph: Record<string, unknown> = { ...parsedRalph };
		delete legacyRalph["pendingDecision"];
		legacyRalph["advanceRequestedAt"] = null;
		legacyRalph["awaitingFinalize"] = false;

		const legacyState: Record<string, unknown> = {
			...parsedLegacy,
			ralph: legacyRalph,
		};
		fs.writeFileSync(statePath, JSON.stringify(legacyState, null, 2), "utf-8");

		await expect(
			Effect.runPromise(
				Effect.gen(function* () {
					const repo = yield* LoopRepo;
					return yield* repo.loadState(cwd, taskId);
				}).pipe(Effect.provide(loopRepoLayer)),
			),
		).rejects.toBeInstanceOf(LoopContractValidationError);
	});

	it("archives task and state artifacts under .pi/loops/archive", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const loopState = makeLoopState("archive-loop");
		await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* LoopRepo;
				yield* repo.writeTaskFile(cwd, loopState.taskId, "# Task\n");
				yield* repo.saveState(cwd, loopState);
				yield* repo.archiveTaskArtifacts(cwd, loopState.taskId);
				yield* repo.saveState(
					cwd,
					{
						...loopState,
						taskFile: path.join(
							".pi",
							"loops",
							"archive",
							"tasks",
							`${loopState.taskId}.md`,
						),
						lifecycle: "archived",
						archivedAt: Option.some("2026-01-01T01:00:00.000Z"),
					},
					true,
				);
				yield* repo.deleteState(cwd, loopState.taskId);
			}).pipe(Effect.provide(loopRepoLayer)),
		);

		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "state", "archive-loop.json"))).toBe(
			false,
		);
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "tasks", "archive-loop.md"))).toBe(
			false,
		);

		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "archive", "state", "archive-loop.json")),
		).toBe(true);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "archive", "tasks", "archive-loop.md")),
		).toBe(true);
	});
});
