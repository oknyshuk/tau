import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

import { LoopRepo, LoopRepoLive } from "../src/loops/repo.js";
import { LoopAmbiguousOwnershipError, LoopOwnershipValidationError } from "../src/loops/errors.js";
import type { LoopPersistedState, LoopSessionRef } from "../src/loops/schema.js";
import { LoopEngine, LoopEngineLive } from "../src/services/loop-engine.js";
import {
	makeExecutionProfile,
	makeSandboxProfile,
	makeRalphMetrics,
	makeCapabilityContract,
} from "./ralph-test-helpers.js";

const loopEngineLayer = LoopEngineLive.pipe(
	Layer.provideMerge(LoopRepoLive),
	Layer.provide(NodeFileSystem.layer),
);

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-loop-engine-"));
}

function makeSession(id: string, fileName: string): LoopSessionRef {
	return {
		sessionId: id,
		sessionFile: `/tmp/${fileName}`,
	};
}

function makeInvalidState(taskId: string, child: LoopSessionRef): LoopPersistedState {
	return {
		taskId,
		title: "Invalid",
		taskFile: path.join(".pi", "loops", "tasks", `${taskId}.md`),
		kind: "ralph",
		lifecycle: "active",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		startedAt: Option.some("2026-01-01T00:00:00.000Z"),
		completedAt: Option.none(),
		archivedAt: Option.none(),
		ownership: {
			controller: Option.none(),
			child: Option.some(child),
		},
		ralph: {
			iteration: 1,
			maxIterations: 10,
			itemsPerIteration: 2,
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

describe("loop engine service", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs create/start/pause/resume/stop/archive lifecycle with persisted session identity", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const controller = makeSession("controller-1", "controller-1.session.json");
		const child = makeSession("child-1", "child-1.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;

				yield* engine.createLoop(cwd, {
					kind: "ralph",
					taskId: "engine-loop",
					title: "Engine loop",
					taskContent: "# Task\n",
					maxIterations: 20,
					itemsPerIteration: 3,
					reflectEvery: 5,
					reflectInstructions: "reflect",
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
				capabilityContract: makeCapabilityContract(),
				});

				const started = yield* engine.startLoop(cwd, "engine-loop", controller);
				const withChild = yield* engine.attachChildSession(cwd, "engine-loop", child);
				const paused = yield* engine.pauseLoop(cwd, "engine-loop");
				const resumed = yield* engine.resumeLoop(cwd, "engine-loop", controller);
				const stopped = yield* engine.stopLoop(cwd, "engine-loop");
				const archived = yield* engine.archiveLoop(cwd, "engine-loop");

				return {
					started,
					withChild,
					paused,
					resumed,
					stopped,
					archived,
				};
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		expect(result.started.lifecycle).toBe("active");
		expect(Option.getOrUndefined(result.started.ownership.controller)?.sessionId).toBe(
			"controller-1",
		);
		expect(Option.getOrUndefined(result.withChild.ownership.child)?.sessionFile).toBe(
			"/tmp/child-1.session.json",
		);
		expect(result.paused.lifecycle).toBe("paused");
		expect(Option.isNone(result.paused.ownership.child)).toBe(true);
		expect(result.resumed.lifecycle).toBe("active");
		expect(result.stopped.lifecycle).toBe("completed");
		expect(result.archived.lifecycle).toBe("archived");
		expect(result.archived.taskFile).toBe(
			path.join(".pi", "loops", "archive", "tasks", "engine-loop.md"),
		);

		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "archive", "state", "engine-loop.json")),
		).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "state", "engine-loop.json"))).toBe(
			false,
		);
	});

	it("uses session files, not project session ids, for loop ownership", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const controller = makeSession("shared-project-session", "controller.session.json");
		const otherTerminal = makeSession("shared-project-session", "other-terminal.session.json");
		const child = makeSession("shared-project-session", "child.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;

				yield* engine.createLoop(cwd, {
					kind: "ralph",
					taskId: "session-file-owned-loop",
					title: "Session-file owned loop",
					taskContent: "# Task\n",
					maxIterations: 20,
					itemsPerIteration: 3,
					reflectEvery: 5,
					reflectInstructions: "reflect",
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
					capabilityContract: makeCapabilityContract(),
				});

				yield* engine.startLoop(cwd, "session-file-owned-loop", controller);
				const otherBeforeAttach = yield* engine.resolveOwnedLoop(cwd, otherTerminal);
				const withChild = yield* engine.attachChildSession(
					cwd,
					"session-file-owned-loop",
					child,
				);

				return { otherBeforeAttach, withChild };
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		expect(Option.isNone(result.otherBeforeAttach)).toBe(true);
		expect(Option.getOrUndefined(result.withChild.ownership.child)?.sessionFile).toBe(
			child.sessionFile,
		);
	});

	it("fails fast when ownership resolution is ambiguous", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const shared = makeSession("shared-controller", "shared-controller.session.json");

		await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;
				yield* engine.createLoop(cwd, {
					kind: "ralph",
					taskId: "ambiguous-a",
					title: "Ambiguous A",
					taskContent: "# Task\n",
					maxIterations: 10,
					itemsPerIteration: 2,
					reflectEvery: 5,
					reflectInstructions: "reflect",
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
				capabilityContract: makeCapabilityContract(),
				});
				yield* engine.createLoop(cwd, {
					kind: "ralph",
					taskId: "ambiguous-b",
					title: "Ambiguous B",
					taskContent: "# Task\n",
					maxIterations: 10,
					itemsPerIteration: 2,
					reflectEvery: 5,
					reflectInstructions: "reflect",
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
				capabilityContract: makeCapabilityContract(),
				});
				yield* engine.startLoop(cwd, "ambiguous-a", shared);
				yield* engine.pauseLoop(cwd, "ambiguous-a");
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* LoopRepo;
				const stateOption = yield* repo.loadState(cwd, "ambiguous-b");
				if (Option.isNone(stateOption) || stateOption.value.kind !== "ralph") {
					throw new Error("missing state");
				}
				const patched = {
					...stateOption.value,
					lifecycle: "paused" as const,
					ownership: {
						controller: Option.some(shared),
						child: Option.none(),
					},
				};
				yield* repo.saveState(cwd, patched);
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		await expect(
			Effect.runPromise(
				Effect.gen(function* () {
					const engine = yield* LoopEngine;
					return yield* engine.resolveOwnedLoop(cwd, shared);
				}).pipe(Effect.provide(loopEngineLayer)),
			),
		).rejects.toBeInstanceOf(LoopAmbiguousOwnershipError);
	});

	it("fails fast on invalid persisted ownership state", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const child = makeSession("invalid-child", "invalid-child.session.json");
		await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* LoopRepo;
				yield* repo.writeTaskFile(cwd, "invalid-loop", "# Task\n");
				yield* repo.saveState(cwd, makeInvalidState("invalid-loop", child));
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		await expect(
			Effect.runPromise(
				Effect.gen(function* () {
					const engine = yield* LoopEngine;
					return yield* engine.listLoops(cwd);
				}).pipe(Effect.provide(loopEngineLayer)),
			),
		).rejects.toBeInstanceOf(LoopOwnershipValidationError);
	});

	it("cleans completed ralph loops", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;

				yield* engine.createLoop(cwd, {
					kind: "ralph",
					taskId: "clean-ralph",
					title: "Clean Ralph",
					taskContent: "# Ralph\n",
					maxIterations: 5,
					itemsPerIteration: 1,
					reflectEvery: 2,
					reflectInstructions: "reflect",
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
				capabilityContract: makeCapabilityContract(),
				});
				yield* engine.startLoop(
					cwd,
					"clean-ralph",
					makeSession("c-ralph", "c-ralph.session.json"),
				);
				yield* engine.stopLoop(cwd, "clean-ralph");

				yield* engine.cleanLoops(cwd, false, "ralph");
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "state", "clean-ralph.json"))).toBe(
			false,
		);
	});

	it("preserves pre-block loop state snapshot for manual resolution recovery", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);

		const blocked = await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;

				yield* engine.createLoop(cwd, {
					kind: "ralph",
					taskId: "blocked-ralph",
					title: "Blocked ralph",
					taskContent: "Exercise manual resolution snapshot preservation.",
					maxIterations: 5,
					itemsPerIteration: 1,
					reflectEvery: 2,
					reflectInstructions: "reflect",
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
					capabilityContract: makeCapabilityContract(),
				});

				yield* engine.startLoop(
					cwd,
					"blocked-ralph",
					makeSession("blocked-controller", "blocked-controller.session.json"),
				);

				return yield* engine.blockLoopForManualResolution(cwd, "blocked-ralph", {
					reasonCode: "ralph.vcs.manual_resolution",
					message: "manual recovery required",
					recoveryActions: ["inspect checkout"],
					recoveryNotes: ["pending_run=run-0001"],
				});
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		const preservedNote = blocked.blocked.recoveryNotes.find((note) =>
			note.startsWith("preserved_state_base64="),
		);
		expect(preservedNote).toBeDefined();
		if (preservedNote === undefined) {
			return;
		}

		const encoded = preservedNote.slice("preserved_state_base64=".length);
		const decoded = Buffer.from(encoded, "base64").toString("utf-8");
		const parsed = JSON.parse(decoded) as { readonly kind?: unknown };
		expect(parsed.kind).toBe("ralph");
	});

	it("stores loop state at the nearest workspace root when invoked from nested directories", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		fs.mkdirSync(path.join(cwd, ".git"));
		const nested = path.join(cwd, "packages", "app", "src");
		fs.mkdirSync(nested, { recursive: true });

		const listed = await Effect.runPromise(
			Effect.gen(function* () {
				const engine = yield* LoopEngine;

				yield* engine.createLoop(nested, {
					kind: "ralph",
					taskId: "nested-root",
					title: "Nested root",
					taskContent: "Verify nested loop storage root.",
					maxIterations: 5,
					itemsPerIteration: 1,
					reflectEvery: 2,
					reflectInstructions: "reflect",
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
					capabilityContract: makeCapabilityContract(),
				});

				return yield* engine.listLoops(cwd);
			}).pipe(Effect.provide(loopEngineLayer)),
		);

		expect(listed.map((state) => state.taskId)).toContain("nested-root");
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "state", "nested-root.json"))).toBe(
			true,
		);
		expect(fs.existsSync(path.join(nested, ".pi", "loops", "state", "nested-root.json"))).toBe(
			false,
		);
	});
});
