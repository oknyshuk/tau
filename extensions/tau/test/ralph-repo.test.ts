import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

import { RalphRepo, RalphRepoLive } from "../src/ralph/repo.js";
import type { LoopState } from "../src/ralph/schema.js";
import {
	makeExecutionProfile,
	makeSandboxProfile,
	makeRalphMetrics,
	makeCapabilityContract,
} from "./ralph-test-helpers.js";

const ralphRepoLayer = RalphRepoLive.pipe(Layer.provide(NodeFileSystem.layer));

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-ralph-repo-"));
}

function makeLoopState(loopName: string): LoopState {
	return {
		name: loopName,
		taskFile: path.join(".pi", "loops", "tasks", `${loopName}.md`),
		iteration: 2,
		maxIterations: 50,
		itemsPerIteration: 0,
		reflectEvery: 0,
		reflectInstructions: "reflect",
		status: "active",
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: Option.none(),
		lastReflectionAt: 0,
		controllerSessionFile: Option.some(`/tmp/${loopName}-controller.session.json`),
		activeIterationSessionFile: Option.some(`/tmp/${loopName}-iteration.session.json`),
		pendingDecision: Option.none(),
		executionProfile: makeExecutionProfile(),
		sandboxProfile: Option.some(makeSandboxProfile()),
		metrics: makeRalphMetrics(),
		capabilityContract: makeCapabilityContract(),
		deferredConfigMutations: [],
	};
}

describe("ralph repo", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists and decodes loop state through schema boundaries", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const loopState = makeLoopState("repo-loop");
		const loaded = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				yield* repo.saveState(cwd, loopState);
				return yield* repo.loadState(cwd, "repo-loop");
			}).pipe(Effect.provide(ralphRepoLayer)),
		);

		expect(Option.isSome(loaded)).toBe(true);
		if (Option.isSome(loaded)) {
			expect(loaded.value).toEqual(loopState);
		}
	});

	it("does not normalize different loop names to the same state file", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const loopState = makeLoopState("strict_loop");
		const loaded = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				yield* repo.saveState(cwd, loopState);
				return yield* repo.loadState(cwd, "strict/loop");
			}).pipe(Effect.provide(ralphRepoLayer)),
		);

		expect(Option.isNone(loaded)).toBe(true);
	});

	it("archives state and task files under .pi/loops/archive", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const loopState = makeLoopState("sleepy-loop");
		await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				yield* repo.saveState(cwd, {
					...loopState,
					status: "paused",
				});
				yield* repo.writeTaskFile(cwd, loopState.taskFile, "# Task\n");
				yield* repo.archiveLoop(cwd, {
					...loopState,
					status: "paused",
				});
			}).pipe(Effect.provide(ralphRepoLayer)),
		);

		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "state", "sleepy-loop.json"))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "archive", "state", "sleepy-loop.json")),
		).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "tasks", "sleepy-loop.md"))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "archive", "tasks", "sleepy-loop.md")),
		).toBe(true);
	});

	it("archives loop task files when loop names start with the archive prefix", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const loopState = makeLoopState("archive-loop");
		await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				yield* repo.saveState(cwd, {
					...loopState,
					status: "paused",
				});
				yield* repo.writeTaskFile(cwd, loopState.taskFile, "# Task\n");
				yield* repo.archiveLoop(cwd, {
					...loopState,
					status: "paused",
				});
			}).pipe(Effect.provide(ralphRepoLayer)),
		);

		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "tasks", "archive-loop.md"))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "archive", "tasks", "archive-loop.md")),
		).toBe(true);
	});

	it("findLoopBySessionFile skips completed loops but finds paused loops", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const completedLoop = { ...makeLoopState("completed-loop"), status: "completed" as const };
		const pausedLoop = { ...makeLoopState("paused-loop"), status: "paused" as const };

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				yield* repo.saveState(cwd, completedLoop);
				yield* repo.saveState(cwd, pausedLoop);
				const completed = yield* repo.findLoopBySessionFile(
					cwd,
					Option.getOrUndefined(completedLoop.controllerSessionFile),
				);
				const paused = yield* repo.findLoopBySessionFile(
					cwd,
					Option.getOrUndefined(pausedLoop.controllerSessionFile),
				);
				return { completed, paused };
			}).pipe(Effect.provide(ralphRepoLayer)),
		);

		expect(Option.isNone(result.completed)).toBe(true);
		expect(Option.isSome(result.paused) && Option.getOrUndefined(result.paused)?.name).toBe(
			"paused-loop",
		);
	});

	it("findLoopBySessionFile prefers active over paused when loops share a controller session", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const sharedSession = "/tmp/shared-controller.session.json";
		const activeLoop = {
			...makeLoopState("active-loop"),
			status: "active" as const,
			controllerSessionFile: Option.some(sharedSession),
		};
		const pausedLoop = {
			...makeLoopState("paused-loop"),
			status: "paused" as const,
			controllerSessionFile: Option.some(sharedSession),
		};

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				yield* repo.saveState(cwd, pausedLoop);
				yield* repo.saveState(cwd, activeLoop);
				return yield* repo.findLoopBySessionFile(cwd, sharedSession);
			}).pipe(Effect.provide(ralphRepoLayer)),
		);

		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value.name).toBe("active-loop");
			expect(result.value.status).toBe("active");
		}
	});

	it("findLoopBySessionFile still discovers paused loops when no active loop shares the session", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const sharedSession = "/tmp/only-paused.session.json";
		const pausedLoop = {
			...makeLoopState("paused-loop"),
			status: "paused" as const,
			controllerSessionFile: Option.some(sharedSession),
		};

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				yield* repo.saveState(cwd, pausedLoop);
				return yield* repo.findLoopBySessionFile(cwd, sharedSession);
			}).pipe(Effect.provide(ralphRepoLayer)),
		);

		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value.name).toBe("paused-loop");
			expect(result.value.status).toBe("paused");
		}
	});

	it("findLoopBySessionFile returns none when multiple paused loops share the same controller session", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const sharedSession = "/tmp/ambiguous-paused.session.json";
		const pausedLoopA = {
			...makeLoopState("paused-loop-a"),
			status: "paused" as const,
			controllerSessionFile: Option.some(sharedSession),
		};
		const pausedLoopB = {
			...makeLoopState("paused-loop-b"),
			status: "paused" as const,
			controllerSessionFile: Option.some(sharedSession),
		};

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				yield* repo.saveState(cwd, pausedLoopA);
				yield* repo.saveState(cwd, pausedLoopB);
				return yield* repo.findLoopBySessionFile(cwd, sharedSession);
			}).pipe(Effect.provide(ralphRepoLayer)),
		);

		expect(Option.isNone(result)).toBe(true);
	});
});
