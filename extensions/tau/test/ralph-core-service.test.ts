import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

import type { ExecutionProfile } from "../src/execution/schema.js";
import { RalphRepo, RalphRepoLive } from "../src/ralph/repo.js";
import { LoopRepoLive } from "../src/loops/repo.js";
import { LoopEngineLive } from "../src/services/loop-engine.js";
import {
	Ralph,
	RalphLive,
	type RalphCommandBoundary,
	resetRalphIterationSignalBridgeForTests,
} from "../src/services/ralph.js";
import type { LoopState, RalphPendingDecision } from "../src/ralph/schema.js";
import {
	makeExecutionProfile,
	makeSandboxProfile,
	makeRalphMetrics,
	makeCapabilityContract,
} from "./ralph-test-helpers.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-ralph-core-"));
}

function makeState(loopName: string, sessionFile: string): LoopState {
	return {
		name: loopName,
		taskFile: path.join(".pi", "loops", "tasks", `${loopName}.md`),
		iteration: 3,
		maxIterations: 50,
		itemsPerIteration: 0,
		reflectEvery: 0,
		reflectInstructions: "reflect",
		status: "active",
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: Option.none(),
		lastReflectionAt: 0,
		controllerSessionFile: Option.some(
			path.join(path.dirname(sessionFile), `${loopName}-controller.session.json`),
		),
		activeIterationSessionFile: Option.some(sessionFile),
		pendingDecision: Option.none<RalphPendingDecision>(),
		executionProfile: makeExecutionProfile(),
		sandboxProfile: Option.some(makeSandboxProfile()),
		metrics: makeRalphMetrics(),
		capabilityContract: makeCapabilityContract(),
		deferredConfigMutations: [],
	};
}

function makeAgentEndEvent(
	text: string,
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" = "stop",
	usage = {
		input: 10,
		output: 5,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: 18,
		cost: {
			input: 0.01,
			output: 0.02,
			cacheRead: 0.001,
			cacheWrite: 0.002,
			total: 0.033,
		},
	},
): AgentEndEvent {
	const event: unknown = {
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [{ type: "text", text }],
				usage,
				stopReason,
			},
		],
	};
	return event as AgentEndEvent;
}

const ralphLayer = RalphLive({
	hasActiveSubagents: () => Effect.succeed(false),
}).pipe(
	Layer.provideMerge(RalphRepoLive),
	Layer.provideMerge(LoopEngineLive.pipe(Layer.provideMerge(LoopRepoLive))),
	Layer.provide(NodeFileSystem.layer),
);

describe("ralph core service", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		resetRalphIterationSignalBridgeForTests();
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("records iteration continuation through service state machine", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const sessionFile = path.join(cwd, ".pi", "sessions", "owned.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, makeState("service-loop", sessionFile));
				const done = yield* ralph.recordContinue(cwd, sessionFile);
				const saved = yield* repo.loadState(cwd, "service-loop");
				return { done, saved };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result.done.text).toContain("Iteration 3 complete. Continue recorded.");
		expect(Option.isSome(result.saved)).toBe(true);
		if (Option.isSome(result.saved)) {
			expect(Option.isSome(result.saved.value.pendingDecision)).toBe(true);
			if (Option.isSome(result.saved.value.pendingDecision)) {
				expect(result.saved.value.pendingDecision.value.kind).toBe("continue");
			}
		}
	});

	it("records finish with a required message", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const sessionFile = path.join(cwd, ".pi", "sessions", "owned.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, makeState("finish-loop", sessionFile));
				const finish = yield* ralph.recordFinish(cwd, sessionFile, "Task fully complete.");
				const saved = yield* repo.loadState(cwd, "finish-loop");
				return { finish, saved };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result.finish.text).toContain("Finish recorded");
		expect(Option.isSome(result.saved)).toBe(true);
		if (Option.isSome(result.saved) && Option.isSome(result.saved.value.pendingDecision)) {
			expect(result.saved.value.pendingDecision.value.kind).toBe("finish");
			if (result.saved.value.pendingDecision.value.kind === "finish") {
				expect(result.saved.value.pendingDecision.value.message).toBe(
					"Task fully complete.",
				);
			}
		}
	});

	it("accumulates Ralph usage from iteration agent_end events", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const sessionFile = path.join(cwd, ".pi", "sessions", "usage.session.json");

		const saved = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, makeState("usage-loop", sessionFile));
				yield* ralph.handleAgentEnd(
					cwd,
					sessionFile,
					makeAgentEndEvent("done", "stop", {
						input: 100,
						output: 50,
						cacheRead: 25,
						cacheWrite: 5,
						totalTokens: 180,
						cost: {
							input: 0.1,
							output: 0.2,
							cacheRead: 0.01,
							cacheWrite: 0.02,
							total: 0.33,
						},
					}),
				);
				return yield* repo.loadState(cwd, "usage-loop");
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(Option.isSome(saved)).toBe(true);
		if (Option.isSome(saved)) {
			expect(saved.value.metrics.totalTokens).toBe(180);
			expect(saved.value.metrics.totalCostUsd).toBe(0.33);
		}
	});

	it("accumulates active runtime only while the loop is active", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const sessionFile = path.join(cwd, ".pi", "sessions", "runtime.session.json");
		const state = makeState("runtime-loop", sessionFile);
		state.metrics = {
			...state.metrics,
			activeStartedAt: Option.some(new Date(Date.now() - 60_000).toISOString()),
		};

		const saved = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, state);
				yield* ralph.syncCurrentLoopFromSession(cwd, sessionFile);
				yield* ralph.pauseCurrentLoop(cwd);
				return yield* repo.loadState(cwd, "runtime-loop");
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(Option.isSome(saved)).toBe(true);
		if (Option.isSome(saved)) {
			expect(saved.value.metrics.activeDurationMs).toBeGreaterThanOrEqual(50_000);
			expect(Option.isNone(saved.value.metrics.activeStartedAt)).toBe(true);
		}
	});

	it("requires iteration-session ownership for ralph_continue and does not fallback to current-loop memory", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const ownedSessionFile = path.join(cwd, ".pi", "sessions", "owned.session.json");
		const unrelatedSessionFile = path.join(cwd, ".pi", "sessions", "unrelated.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, makeState("strict-loop", ownedSessionFile));
				yield* ralph.syncCurrentLoopFromSession(cwd, ownedSessionFile);
				const done = yield* ralph.recordContinue(cwd, unrelatedSessionFile);
				const saved = yield* repo.loadState(cwd, "strict-loop");
				return { done, saved };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result.done.text).toBe("No active Ralph loop.");
		expect(Option.isSome(result.saved)).toBe(true);
		if (Option.isSome(result.saved)) {
			expect(Option.isNone(result.saved.value.pendingDecision)).toBe(true);
		}
	});

	it("preserves the current Ralph loop across session sync misses so the UI can stay visible", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const controllerSessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
		const unrelatedSessionFile = path.join(cwd, ".pi", "sessions", "other.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ralph = yield* Ralph;
				yield* ralph.startLoopState(cwd, {
					loopName: "visible-loop",
					taskFile: path.join(".pi", "loops", "tasks", "visible-loop.md"),
					executionProfile: makeExecutionProfile({
						model: "anthropic/claude-opus-4-5",
						thinking: "medium",
					}),
					sandboxProfile: makeSandboxProfile(),
					maxIterations: 50,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					controllerSessionFile: Option.some(controllerSessionFile),
					defaultTaskTemplate: "# Task\n",
				});
				yield* ralph.syncCurrentLoopFromSession(cwd, unrelatedSessionFile);
				return yield* ralph.resolveLoopForUi(cwd, unrelatedSessionFile);
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value.name).toBe("visible-loop");
			expect(result.value.status).toBe("active");
		}
	});

	it("recovers the sole active Ralph loop for UI after a fresh session runtime starts", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const controllerSessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
		const childSessionFile = path.join(cwd, ".pi", "sessions", "child.session.json");

		await Effect.runPromise(
			Effect.gen(function* () {
				const ralph = yield* Ralph;
				yield* ralph.startLoopState(cwd, {
					loopName: "recoverable-loop",
					taskFile: path.join(".pi", "loops", "tasks", "recoverable-loop.md"),
					executionProfile: makeExecutionProfile(),
					sandboxProfile: makeSandboxProfile(),
					maxIterations: 50,
					itemsPerIteration: 0,
					reflectEvery: 0,
					reflectInstructions: "reflect",
					controllerSessionFile: Option.some(controllerSessionFile),
					defaultTaskTemplate: "# Task\n",
				});
			}).pipe(Effect.provide(ralphLayer)),
		);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const ralph = yield* Ralph;
				return yield* ralph.resolveLoopForUi(cwd, childSessionFile);
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value.name).toBe("recoverable-loop");
			expect(result.value.status).toBe("active");
		}
	});

	it("keeps iteration ownership after a handled child-session end so ralph_continue still works", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const loopName = "handshake-loop";
		const iterationSessionFile = path.join(cwd, ".pi", "sessions", "iteration.session.json");
		const controllerSessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
		const unrelatedSessionFile = path.join(cwd, ".pi", "sessions", "unrelated.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, {
					...makeState(loopName, iterationSessionFile),
					iteration: 0,
					maxIterations: 1,
					controllerSessionFile: Option.some(controllerSessionFile),
					activeIterationSessionFile: Option.none(),
				});
				yield* repo.writeTaskFile(
					cwd,
					path.join(".pi", "loops", "tasks", `${loopName}.md`),
					"# Task\n",
				);

				const followUpStarted = yield* Deferred.make<void>();
				const releaseFollowUp = yield* Deferred.make<void>();
				let sessionFile = controllerSessionFile;

				const boundary: RalphCommandBoundary = {
					cwd,
					getSessionFile: () => sessionFile,
					switchSession: (targetSessionFile) =>
						Effect.sync(() => {
							sessionFile = targetSessionFile;
							return { cancelled: false } as const;
						}),
					newSession: () =>
						Effect.sync(() => {
							sessionFile = iterationSessionFile;
							return { cancelled: false } as const;
						}),
					captureSandboxProfile: Effect.succeed(makeSandboxProfile()),
					applyExecutionProfile: () => Effect.succeed({ applied: true as const }),
					applyCapabilityContract: () => Effect.succeed({ applied: true as const }),
					sendFollowUp: () =>
						Effect.gen(function* () {
							yield* Deferred.succeed(followUpStarted, undefined);
							yield* Deferred.await(releaseFollowUp);
							return { dispatched: true as const };
						}),
				};

				const runFiber = yield* Effect.forkDetach(ralph.runLoop(boundary, loopName));
				yield* Deferred.await(followUpStarted);

				const unrelated = yield* ralph.handleAgentEnd(
					cwd,
					unrelatedSessionFile,
					makeAgentEndEvent("unrelated"),
				);
				const matching = yield* ralph.handleAgentEnd(
					cwd,
					iterationSessionFile,
					makeAgentEndEvent("worked"),
				);

				yield* Deferred.succeed(releaseFollowUp, undefined);
				yield* Effect.sleep("10 millis");

				const afterHandledEnd = yield* repo.loadState(cwd, loopName);
				const done = yield* ralph.recordContinue(cwd, iterationSessionFile);
				const afterDone = yield* repo.loadState(cwd, loopName);

				yield* Fiber.interrupt(runFiber);

				return { unrelated, matching, afterHandledEnd, done, afterDone };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result.unrelated.consumedByWaitingLoop).toBe(false);
		expect(result.matching.consumedByWaitingLoop).toBe(true);
		expect(Option.isSome(result.afterHandledEnd)).toBe(true);
		if (Option.isSome(result.afterHandledEnd)) {
			expect(result.afterHandledEnd.value.status).toBe("active");
			expect(Option.isNone(result.afterHandledEnd.value.pendingDecision)).toBe(true);
			expect(
				Option.getOrUndefined(result.afterHandledEnd.value.activeIterationSessionFile),
			).toBe(iterationSessionFile);
		}
		expect(result.done.text).toContain("Iteration 1 complete. Continue recorded.");
		expect(Option.isSome(result.afterDone)).toBe(true);
		if (Option.isSome(result.afterDone)) {
			expect(result.afterDone.value.status).toBe("active");
			expect(Option.isSome(result.afterDone.value.pendingDecision)).toBe(true);
			if (Option.isSome(result.afterDone.value.pendingDecision)) {
				expect(result.afterDone.value.pendingDecision.value.kind).toBe("continue");
			}
			expect(Option.getOrUndefined(result.afterDone.value.activeIterationSessionFile)).toBe(
				iterationSessionFile,
			);
		}
	});

	it("reapplies the pinned execution profile on each Ralph iteration", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const loopName = "profile-loop";
		const controllerSessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
		const iterationSessionFileA = path.join(cwd, ".pi", "sessions", "iteration-a.session.json");
		const iterationSessionFileB = path.join(cwd, ".pi", "sessions", "iteration-b.session.json");

		const pinnedExecutionProfile = makeExecutionProfile({
			model: "openai-codex/gpt-5.3-codex",
			thinking: "high",
		});

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, {
					...makeState(loopName, iterationSessionFileA),
					iteration: 0,
					maxIterations: 2,
					controllerSessionFile: Option.some(controllerSessionFile),
					activeIterationSessionFile: Option.none(),
					executionProfile: pinnedExecutionProfile,
				});
				yield* repo.writeTaskFile(
					cwd,
					path.join(".pi", "loops", "tasks", `${loopName}.md`),
					"# Task\n",
				);

				const appliedProfiles: ExecutionProfile[] = [];
				let sessionFile = controllerSessionFile;
				let newSessionCount = 0;
				let followUpCount = 0;
				const startedA = yield* Deferred.make<void>();
				const releaseA = yield* Deferred.make<void>();
				const startedB = yield* Deferred.make<void>();
				const releaseB = yield* Deferred.make<void>();

				const boundary: RalphCommandBoundary = {
					cwd,
					getSessionFile: () => sessionFile,
					switchSession: (targetSessionFile) =>
						Effect.sync(() => {
							sessionFile = targetSessionFile;
							return { cancelled: false } as const;
						}),
					newSession: () =>
						Effect.sync(() => {
							newSessionCount += 1;
							sessionFile =
								newSessionCount === 1
									? iterationSessionFileA
									: iterationSessionFileB;
							return { cancelled: false } as const;
						}),
					applyExecutionProfile: (profile) =>
						Effect.sync(() => {
							appliedProfiles.push(profile);
							return { applied: true } as const;
						}),
					applyCapabilityContract: () => Effect.succeed({ applied: true as const }),
					captureSandboxProfile: Effect.succeed(makeSandboxProfile()),
					sendFollowUp: () =>
						Effect.gen(function* () {
							if (followUpCount === 0) {
								followUpCount += 1;
								yield* Deferred.succeed(startedA, undefined);
								yield* Deferred.await(releaseA);
								return { dispatched: true as const };
							}

							followUpCount += 1;
							yield* Deferred.succeed(startedB, undefined);
							yield* Deferred.await(releaseB);
							return { dispatched: true as const };
						}),
				};

				const runFiber = yield* Effect.forkDetach(ralph.runLoop(boundary, loopName));
				yield* Deferred.await(startedA);
				yield* ralph.recordContinue(cwd, iterationSessionFileA);
				yield* ralph.handleAgentEnd(
					cwd,
					iterationSessionFileA,
					makeAgentEndEvent("worked"),
				);
				yield* Deferred.succeed(releaseA, undefined);
				yield* Deferred.await(startedB);
				yield* ralph.recordContinue(cwd, iterationSessionFileB);
				yield* ralph.handleAgentEnd(
					cwd,
					iterationSessionFileB,
					makeAgentEndEvent("worked again"),
				);
				yield* Deferred.succeed(releaseB, undefined);
				yield* Fiber.join(runFiber);

				return appliedProfiles;
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result).toEqual([pinnedExecutionProfile, pinnedExecutionProfile]);
	});

	it("bridges agent_end across fresh child-session runtimes so ralph_continue starts the next iteration", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const loopName = "bridge-loop";
		const controllerSessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");
		const iterationSessionFileA = path.join(cwd, ".pi", "sessions", "iteration-a.session.json");
		const iterationSessionFileB = path.join(cwd, ".pi", "sessions", "iteration-b.session.json");

		let resolveStartedA!: () => void;
		let resolveReleaseA!: () => void;
		let resolveStartedB!: () => void;
		let resolveReleaseB!: () => void;
		const startedA = new Promise<void>((resolve) => {
			resolveStartedA = resolve;
		});
		const releaseA = new Promise<void>((resolve) => {
			resolveReleaseA = resolve;
		});
		const startedB = new Promise<void>((resolve) => {
			resolveStartedB = resolve;
		});
		const releaseB = new Promise<void>((resolve) => {
			resolveReleaseB = resolve;
		});

		const controllerRuntime = ManagedRuntime.make(ralphLayer);
		const childRuntime = ManagedRuntime.make(ralphLayer);

		try {
			const runLoopPromise = controllerRuntime.runPromise(
				Effect.gen(function* () {
					const repo = yield* RalphRepo;
					const ralph = yield* Ralph;
					yield* repo.saveState(cwd, {
						...makeState(loopName, iterationSessionFileA),
						iteration: 0,
						maxIterations: 2,
						controllerSessionFile: Option.some(controllerSessionFile),
						activeIterationSessionFile: Option.none(),
					});
					yield* repo.writeTaskFile(
						cwd,
						path.join(".pi", "loops", "tasks", `${loopName}.md`),
						"# Task\n",
					);

					let sessionFile = controllerSessionFile;
					let followUpCount = 0;
					let newSessionCount = 0;

					const boundary: RalphCommandBoundary = {
						cwd,
						getSessionFile: () => sessionFile,
						switchSession: (targetSessionFile) =>
							Effect.sync(() => {
								sessionFile = targetSessionFile;
								return { cancelled: false } as const;
							}),
						newSession: () =>
							Effect.sync(() => {
								newSessionCount += 1;
								sessionFile =
									newSessionCount === 1
										? iterationSessionFileA
										: iterationSessionFileB;
								return { cancelled: false } as const;
							}),
						applyExecutionProfile: () => Effect.succeed({ applied: true as const }),
					applyCapabilityContract: () => Effect.succeed({ applied: true as const }),
						captureSandboxProfile: Effect.succeed(makeSandboxProfile()),
						sendFollowUp: () =>
							Effect.promise(async () => {
								if (followUpCount === 0) {
									followUpCount += 1;
									resolveStartedA();
									await releaseA;
									return { dispatched: true as const };
								}

								followUpCount += 1;
								resolveStartedB();
								await releaseB;
								return { dispatched: true as const };
							}),
					};

					return yield* ralph.runLoop(boundary, loopName);
				}),
			);

			await startedA;

			const continueResult = await childRuntime.runPromise(
				Effect.gen(function* () {
					const ralph = yield* Ralph;
					const done = yield* ralph.recordContinue(cwd, iterationSessionFileA);
					const handled = yield* ralph.handleAgentEnd(
						cwd,
						iterationSessionFileA,
						makeAgentEndEvent("iteration complete"),
					);
					return { done, handled };
				}),
			);

			expect(continueResult.done.text).toContain("Iteration 1 complete. Continue recorded.");
			expect(continueResult.handled.consumedByWaitingLoop).toBe(true);

			resolveReleaseA();
			await startedB;

			const afterContinue = await controllerRuntime.runPromise(
				Effect.gen(function* () {
					const repo = yield* RalphRepo;
					return yield* repo.loadState(cwd, loopName);
				}),
			);
			expect(Option.isSome(afterContinue)).toBe(true);
			if (Option.isSome(afterContinue)) {
				expect(afterContinue.value.iteration).toBe(2);
				expect(Option.getOrUndefined(afterContinue.value.activeIterationSessionFile)).toBe(
					iterationSessionFileB,
				);
				expect(Option.isNone(afterContinue.value.pendingDecision)).toBe(true);
			}

			await childRuntime.runPromise(
				Effect.gen(function* () {
					const ralph = yield* Ralph;
					yield* ralph.recordFinish(cwd, iterationSessionFileB, "done");
					yield* ralph.handleAgentEnd(
						cwd,
						iterationSessionFileB,
						makeAgentEndEvent("done"),
					);
				}),
			);
			resolveReleaseB();

			const runResult = await runLoopPromise;
			expect(runResult.status).toBe("stopped");
		} finally {
			await controllerRuntime.dispose();
			await childRuntime.dispose();
		}
	});

	it("handles current-loop pause, resume, and stop through command-side Ralph methods", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const sessionFile = path.join(cwd, ".pi", "sessions", "current-loop.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, makeState("current-loop", sessionFile));
				yield* ralph.syncCurrentLoopFromSession(cwd, sessionFile);

				const paused = yield* ralph.pauseCurrentLoop(cwd);
				const pausedState = yield* repo.loadState(cwd, "current-loop");
				const resumed = yield* ralph.resumeLoopState(cwd, {
					loopName: "current-loop",
					maxIterations: Option.none(),
				});
				const stopped = yield* ralph.stopActiveLoop(cwd);
				const stoppedState = yield* repo.loadState(cwd, "current-loop");

				return { paused, pausedState, resumed, stopped, stoppedState };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result.paused.status).toBe("paused");
		expect(result.resumed.status).toBe("resumed");
		expect(result.stopped.status).toBe("stopped");
		expect(Option.isSome(result.pausedState)).toBe(true);
		expect(Option.isSome(result.stoppedState)).toBe(true);
		if (Option.isSome(result.pausedState)) {
			expect(result.pausedState.value.status).toBe("paused");
		}
		if (Option.isSome(result.stoppedState)) {
			expect(result.stoppedState.value.status).toBe("completed");
			expect(Option.isSome(result.stoppedState.value.completedAt)).toBe(true);
		}
	});

	it("pauses the current session loop when multiple loops are active", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const ownedSessionFile = path.join(cwd, ".pi", "sessions", "owned.session.json");
		const otherSessionFile = path.join(cwd, ".pi", "sessions", "other.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				yield* repo.saveState(cwd, makeState("owned-loop", ownedSessionFile));
				yield* repo.saveState(cwd, makeState("other-loop", otherSessionFile));
				yield* ralph.syncCurrentLoopFromSession(cwd, ownedSessionFile);

				const paused = yield* ralph.pauseCurrentLoop(cwd);
				const owned = yield* repo.loadState(cwd, "owned-loop");
				const other = yield* repo.loadState(cwd, "other-loop");
				return { paused, owned, other };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result.paused.status).toBe("paused");
		if (result.paused.status === "paused") {
			expect(result.paused.loopName).toBe("owned-loop");
		}
		expect(Option.isSome(result.owned)).toBe(true);
		expect(Option.isSome(result.other)).toBe(true);
		if (Option.isSome(result.owned)) {
			expect(result.owned.value.status).toBe("paused");
		}
		if (Option.isSome(result.other)) {
			expect(result.other.value.status).toBe("active");
		}
	});

	it("pauses the active workspace loop without trusting stale current-loop memory", async () => {
		const firstCwd = makeTempDir();
		const secondCwd = makeTempDir();
		tempDirs.push(firstCwd, secondCwd);
		const firstSessionFile = path.join(firstCwd, ".pi", "sessions", "first.session.json");
		const secondSessionFile = path.join(secondCwd, ".pi", "sessions", "second.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;

				yield* repo.saveState(firstCwd, makeState("stale-loop", firstSessionFile));
				yield* ralph.syncCurrentLoopFromSession(firstCwd, firstSessionFile);
				yield* repo.saveState(secondCwd, makeState("active-loop", secondSessionFile));

				const paused = yield* ralph.pauseCurrentLoop(secondCwd);
				const saved = yield* repo.loadState(secondCwd, "active-loop");
				return { paused, saved };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result.paused.status).toBe("paused");
		if (result.paused.status === "paused") {
			expect(result.paused.loopName).toBe("active-loop");
		}
		expect(Option.isSome(result.saved)).toBe(true);
		if (Option.isSome(result.saved)) {
			expect(result.saved.value.status).toBe("paused");
		}
	});

	it("reopens completed loops through resumeLoopState without resetting iteration", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const sessionFile = path.join(cwd, ".pi", "sessions", "done-loop.session.json");

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;
				const completedState: LoopState = {
					...makeState("done-loop", sessionFile),
					iteration: 9,
					maxIterations: 12,
					status: "completed",
					completedAt: Option.some("2026-01-01T00:00:00.000Z"),
					activeIterationSessionFile: Option.none(),
				};
				yield* repo.saveState(cwd, completedState);

				const resumed = yield* ralph.resumeLoopState(cwd, {
					loopName: "done-loop",
					maxIterations: Option.none(),
				});
				const resumedState = yield* repo.loadState(cwd, "done-loop");

				return { resumed, resumedState };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(result.resumed.status).toBe("resumed");
		expect(Option.isSome(result.resumedState)).toBe(true);
		if (Option.isSome(result.resumedState)) {
			expect(result.resumedState.value.status).toBe("active");
			expect(result.resumedState.value.iteration).toBe(9);
			expect(result.resumedState.value.maxIterations).toBe(12);
			expect(Option.isNone(result.resumedState.value.completedAt)).toBe(true);
		}
	});

	it("archives, cleans, and nukes through Ralph service command flows", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const sessionFile = path.join(cwd, ".pi", "sessions", "controller.session.json");

		const beforeNuke = await Effect.runPromise(
			Effect.gen(function* () {
				const repo = yield* RalphRepo;
				const ralph = yield* Ralph;

				const archivedLoop: LoopState = {
					...makeState("sleepy-loop", sessionFile),
					status: "paused",
					activeIterationSessionFile: Option.none(),
				};
				yield* repo.saveState(cwd, archivedLoop);
				yield* repo.writeTaskFile(cwd, archivedLoop.taskFile, "# Task\n");

				const doneA: LoopState = {
					...makeState("done-a", sessionFile),
					status: "completed",
					completedAt: Option.some("2026-01-01T00:00:00.000Z"),
					activeIterationSessionFile: Option.none(),
				};
				const doneB: LoopState = {
					...makeState("done-b", sessionFile),
					status: "completed",
					completedAt: Option.some("2026-01-01T00:00:00.000Z"),
					activeIterationSessionFile: Option.none(),
				};
				yield* repo.saveState(cwd, doneA);
				yield* repo.writeTaskFile(cwd, doneA.taskFile, "# Task\n");
				yield* repo.saveState(cwd, doneB);
				yield* repo.writeTaskFile(cwd, doneB.taskFile, "# Task\n");

				const archived = yield* ralph.archiveLoopByName(cwd, "sleepy-loop");
				const cleaned = yield* ralph.cleanCompletedLoops(cwd, true);
				return { archived, cleaned };
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(beforeNuke.archived.status).toBe("archived");
		expect(beforeNuke.cleaned.cleanedLoops).toEqual(["done-a", "done-b"]);
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "state", "sleepy-loop.json"))).toBe(
			false,
		);
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "tasks", "sleepy-loop.md"))).toBe(
			false,
		);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "archive", "state", "sleepy-loop.json")),
		).toBe(true);
		expect(
			fs.existsSync(path.join(cwd, ".pi", "loops", "archive", "tasks", "sleepy-loop.md")),
		).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "state", "done-a.json"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "tasks", "done-a.md"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "state", "done-b.json"))).toBe(false);
		expect(fs.existsSync(path.join(cwd, ".pi", "loops", "tasks", "done-b.md"))).toBe(false);

		const nuked = await Effect.runPromise(
			Effect.gen(function* () {
				const ralph = yield* Ralph;
				return yield* ralph.nukeLoops(cwd);
			}).pipe(Effect.provide(ralphLayer)),
		);

		expect(nuked.removed).toBe(true);
		expect(fs.existsSync(path.join(cwd, ".pi", "ralph"))).toBe(false);
	});
});
