import { Cause, Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { LoopContractValidationError, LoopOwnershipValidationError } from "../src/loops/errors.js";
import {
	decodeLoopPersistedState,
	decodeLoopPersistedStateWithMigration,
	encodeLoopPersistedState,
	type EncodedLoopPersistedState,
	validateLoopOwnership,
} from "../src/loops/schema.js";
import {
	makeExecutionProfile,
	makeSandboxProfile,
	makeRalphMetrics,
	makeCapabilityContract,
} from "./ralph-test-helpers.js";

const encodedRalphState: EncodedLoopPersistedState = {
	taskId: "schema-loop",
	title: "Schema loop",
	taskFile: ".pi/loops/tasks/schema-loop.md",
	kind: "ralph",
	lifecycle: "active",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	startedAt: "2026-01-01T00:00:00.000Z",
	completedAt: null,
	archivedAt: null,
	ownership: {
		controller: {
			sessionId: "controller-session-id",
			sessionFile: "/tmp/controller.session.json",
		},
		child: {
			sessionId: "child-session-id",
			sessionFile: "/tmp/child.session.json",
		},
	},
	ralph: {
		iteration: 3,
		maxIterations: 50,
		itemsPerIteration: 3,
		reflectEvery: 10,
		reflectInstructions: "reflect",
		lastReflectionAt: 0,
		pendingDecision: null,
		pinnedExecutionProfile: makeExecutionProfile(),
		sandboxProfile: makeSandboxProfile(),
		metrics: {
			totalTokens: 0,
			totalCostUsd: 0,
			activeDurationMs: 0,
			activeStartedAt: null,
		},
		capabilityContract: makeCapabilityContract(),
		deferredConfigMutations: [],
	},
};

describe("loops schema", () => {
	it("decodes and re-encodes ralph loop state with session ids and file paths", async () => {
		const decoded = await Effect.runPromise(decodeLoopPersistedState(encodedRalphState));
		expect(decoded.kind).toBe("ralph");
		expect(Option.getOrUndefined(decoded.ownership.controller)?.sessionId).toBe(
			"controller-session-id",
		);
		expect(Option.getOrUndefined(decoded.ownership.child)?.sessionFile).toBe(
			"/tmp/child.session.json",
		);

		const reencoded = await Effect.runPromise(encodeLoopPersistedState(decoded));
		expect(reencoded).toEqual(encodedRalphState);
	});

	it("fails fast on legacy ralph payloads missing required fields", async () => {
		const {
			pendingDecision: _pendingDecision,
			sandboxProfile: _sandboxProfile,
			metrics: _metrics,
			deferredConfigMutations: _deferredConfigMutations,
			...legacyRalph
		} = encodedRalphState.ralph;
		const legacyState = {
			...encodedRalphState,
			ralph: legacyRalph,
		};

		const result = await Effect.runPromise(
			Effect.exit(decodeLoopPersistedStateWithMigration(legacyState)),
		);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			const failure = Cause.findErrorOption(result.cause);
			expect(Option.isSome(failure)).toBe(true);
			if (Option.isSome(failure)) {
				expect(failure.value).toBeInstanceOf(LoopContractValidationError);
			}
		}
	});

	it("fails ownership validation when child ownership is set without a controller", async () => {
		const decoded = await Effect.runPromise(
			decodeLoopPersistedState({
				...encodedRalphState,
				ownership: {
					controller: null,
					child: {
						sessionId: "child-session-id",
						sessionFile: "/tmp/child.session.json",
					},
				},
			}),
		);

		const result = await Effect.runPromise(Effect.exit(validateLoopOwnership(decoded)));
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			const failure = Cause.findErrorOption(result.cause);
			expect(Option.isSome(failure)).toBe(true);
			if (Option.isSome(failure)) {
				expect(failure.value).toBeInstanceOf(LoopOwnershipValidationError);
			}
		}
	});

	it("maps invalid payloads to LoopContractValidationError", async () => {
		const result = await Effect.runPromise(
			Effect.exit(
				decodeLoopPersistedState({
					...encodedRalphState,
					taskId: "bad id with spaces",
				}),
			),
		);
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			const failure = Cause.findErrorOption(result.cause);
			expect(Option.isSome(failure)).toBe(true);
			if (Option.isSome(failure)) {
				expect(failure.value).toBeInstanceOf(LoopContractValidationError);
			}
		}
	});
});
