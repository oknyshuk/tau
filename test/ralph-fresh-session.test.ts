import { describe, expect, it } from "vitest";
import { Option } from "effect";

import { RalphContractValidationError } from "../src/ralph/errors.js";
import { loopOwnsSessionFile } from "../src/ralph/repo.js";
import { decodeLoopStateSync, sanitizeLoopName } from "../src/ralph/schema.js";
import {
	makeExecutionProfile,
	makeSandboxProfile,
	makeCapabilityContract,
} from "./ralph-test-helpers.js";

function currentFields(): Record<string, unknown> {
	return {
		metrics: {
			totalTokens: 0,
			totalCostUsd: 0,
			activeDurationMs: 0,
			activeStartedAt: null,
		},
		capabilityContract: makeCapabilityContract(),
		deferredConfigMutations: [],
	};
}

describe("ralph fresh-session helpers", () => {
	it("preserves uppercase letters when sanitizing loop names", () => {
		expect(sanitizeLoopName("MyFeature")).toBe("MyFeature");
		expect(sanitizeLoopName("ABC-123")).toBe("ABC-123");
		expect(sanitizeLoopName("alpha/beta")).toBe("alpha_beta");
	});

	it("decodes persisted state with explicit null-backed option fields", () => {
		const state = decodeLoopStateSync({
			name: "legacy-loop",
			taskFile: ".pi/ralph/tasks/legacy-loop.md",
			iteration: 3,
			maxIterations: 50,
			itemsPerIteration: 0,
			reflectEvery: 0,
			reflectInstructions: "reflect",
			status: "active",
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: null,
			lastReflectionAt: 0,
			controllerSessionFile: null,
			activeIterationSessionFile: null,
			pendingDecision: null,
			executionProfile: makeExecutionProfile(),
			sandboxProfile: makeSandboxProfile(),
			...currentFields(),
		});

		expect(Option.isNone(state.completedAt)).toBe(true);
		expect(Option.isNone(state.controllerSessionFile)).toBe(true);
		expect(Option.isNone(state.activeIterationSessionFile)).toBe(true);
		expect(Option.isNone(state.pendingDecision)).toBe(true);
	});

	it("fails fast when persisted state contains legacy Option objects", () => {
		expect(() =>
			decodeLoopStateSync({
				name: "controller-loop",
				taskFile: ".pi/ralph/tasks/controller-loop.md",
				iteration: 1,
				maxIterations: 10,
				itemsPerIteration: 0,
				reflectEvery: 0,
				reflectInstructions: "reflect",
				status: "active",
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: { _id: "Option", _tag: "None" },
				lastReflectionAt: 0,
				controllerSessionFile: {
					_id: "Option",
					_tag: "Some",
					value: "/tmp/controller.session",
				},
				activeIterationSessionFile: null,
				pendingDecision: null,
				executionProfile: makeExecutionProfile(),
				sandboxProfile: makeSandboxProfile(),
				...currentFields(),
			}),
		).toThrow(RalphContractValidationError);
	});

	it("matches controller and iteration session files", () => {
		const normalized = decodeLoopStateSync({
			name: "session-loop",
			taskFile: ".pi/ralph/tasks/session-loop.md",
			iteration: 2,
			maxIterations: 10,
			itemsPerIteration: 0,
			reflectEvery: 0,
			reflectInstructions: "reflect",
			status: "active",
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: null,
			lastReflectionAt: 0,
			controllerSessionFile: "/tmp/controller.session",
			activeIterationSessionFile: "/tmp/iteration.session",
			pendingDecision: null,
			executionProfile: makeExecutionProfile(),
			sandboxProfile: makeSandboxProfile(),
			...currentFields(),
		});

		expect(loopOwnsSessionFile(normalized, "/tmp/controller.session")).toBe(true);
		expect(loopOwnsSessionFile(normalized, "/tmp/iteration.session")).toBe(true);
		expect(loopOwnsSessionFile(normalized, "/tmp/other.session")).toBe(false);
	});

	it("fails fast for legacy prompt-profile loop state", () => {
		expect(() =>
			decodeLoopStateSync({
				name: "legacy-normalized",
				taskFile: ".pi/ralph/tasks/legacy-normalized.md",
				iteration: 2,
				maxIterations: 10,
				itemsPerIteration: 0,
				reflectEvery: 0,
				reflectInstructions: "reflect",
				status: "active",
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: null,
				lastReflectionAt: 0,
				controllerSessionFile: "/tmp/controller.session",
				activeIterationSessionFile: "/tmp/iteration.session",
				pendingDecision: null,
				promptProfile: {
					mode: "deep",
					model: "anthropic/claude-opus-4-5",
					thinking: "high",
				},
			}),
		).toThrow(RalphContractValidationError);
	});
});
