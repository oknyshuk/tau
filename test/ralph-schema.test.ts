import { Cause, Effect, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { RalphContractValidationError, RalphLoopNotFoundError } from "../src/ralph/errors.js";
import {
	type EncodedLoopState,
	decodeLoopState,
	decodeLoopStateJson,
	encodeLoopState,
	encodeLoopStateJson,
	LoopNameSchema,
} from "../src/ralph/schema.js";
import {
	makeExecutionProfile,
	makeSandboxProfile,
	makeRalphMetrics,
	makeCapabilityContract,
} from "./ralph-test-helpers.js";

const encodedLoopState: EncodedLoopState = {
	name: "schema-loop",
	taskFile: ".pi/ralph/tasks/schema-loop.md",
	iteration: 3,
	maxIterations: 50,
	itemsPerIteration: 0,
	reflectEvery: 0,
	reflectInstructions: "reflect",
	status: "active",
	startedAt: "2026-01-01T00:00:00.000Z",
	completedAt: null,
	lastReflectionAt: 0,
	controllerSessionFile: "/tmp/controller.session.json",
	activeIterationSessionFile: null,
	pendingDecision: null,
	executionProfile: makeExecutionProfile(),
	sandboxProfile: makeSandboxProfile(),
	metrics: {
		totalTokens: 0,
		totalCostUsd: 0,
		activeDurationMs: 0,
		activeStartedAt: null,
	},
	capabilityContract: makeCapabilityContract(),
	deferredConfigMutations: [],
};

describe("ralph schema", () => {
	it("decodes persisted loop state using null-backed option fields", async () => {
		const decoded = await Effect.runPromise(decodeLoopState(encodedLoopState));

		expect(decoded.name).toBe("schema-loop");
		expect(decoded.status).toBe("active");
		expect(Option.isNone(decoded.completedAt)).toBe(true);
		expect(Option.getOrUndefined(decoded.controllerSessionFile)).toBe(
			"/tmp/controller.session.json",
		);
		expect(Option.isNone(decoded.activeIterationSessionFile)).toBe(true);
	});

	it("encodes option fields back to JSON-safe values", async () => {
		const decoded = await Effect.runPromise(decodeLoopState(encodedLoopState));
		const encoded = await Effect.runPromise(encodeLoopState(decoded));

		expect(encoded.completedAt).toBeNull();
		expect(encoded.controllerSessionFile).toBe("/tmp/controller.session.json");
		expect(encoded.activeIterationSessionFile).toBeNull();
	});

	it("roundtrips loop state JSON codec", async () => {
		const decoded = await Effect.runPromise(decodeLoopState(encodedLoopState));
		const json = await Effect.runPromise(encodeLoopStateJson(decoded));
		const roundtripped = await Effect.runPromise(decodeLoopStateJson(json));

		expect(roundtripped).toEqual(decoded);
	});

	it("fails fast on legacy Option object payloads", async () => {
		const invalidState = {
			...encodedLoopState,
			controllerSessionFile: {
				_id: "Option",
				_tag: "Some",
				value: "/tmp/controller.session.json",
			},
		};

		const result = await Effect.runPromise(Effect.exit(decodeLoopState(invalidState)));
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			const failure = Cause.findErrorOption(result.cause);
			expect(Option.isSome(failure)).toBe(true);
			if (Option.isSome(failure)) {
				expect(failure.value).toBeInstanceOf(RalphContractValidationError);
			}
		}
	});

	it("rejects legacy promptProfile payloads", async () => {
		const legacyState = {
			name: encodedLoopState.name,
			taskFile: encodedLoopState.taskFile,
			iteration: encodedLoopState.iteration,
			maxIterations: encodedLoopState.maxIterations,
			itemsPerIteration: encodedLoopState.itemsPerIteration,
			reflectEvery: encodedLoopState.reflectEvery,
			reflectInstructions: encodedLoopState.reflectInstructions,
			status: encodedLoopState.status,
			startedAt: encodedLoopState.startedAt,
			completedAt: encodedLoopState.completedAt,
			lastReflectionAt: encodedLoopState.lastReflectionAt,
			controllerSessionFile: encodedLoopState.controllerSessionFile,
			activeIterationSessionFile: encodedLoopState.activeIterationSessionFile,
			pendingDecision: encodedLoopState.pendingDecision,
			promptProfile: {
				mode: "smart",
				model: "anthropic/claude-opus-4-5",
				thinking: "medium",
			},
		};

		const result = await Effect.runPromise(Effect.exit(decodeLoopState(legacyState)));
		expect(result._tag).toBe("Failure");
	});

	it("fails fast when required runtime fields are missing", async () => {
		const {
			sandboxProfile: _sandboxProfile,
			metrics: _metrics,
			capabilityContract: _capabilityContract,
			deferredConfigMutations: _deferredConfigMutations,
			...legacyState
		} = encodedLoopState;

		const result = await Effect.runPromise(Effect.exit(decodeLoopState(legacyState)));
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			const failure = Cause.findErrorOption(result.cause);
			expect(Option.isSome(failure)).toBe(true);
			if (Option.isSome(failure)) {
				expect(failure.value).toBeInstanceOf(RalphContractValidationError);
			}
		}
	});

	it("maps invalid JSON payloads to RalphContractValidationError", async () => {
		const result = await Effect.runPromise(Effect.exit(decodeLoopStateJson("{")));
		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			const failure = Cause.findErrorOption(result.cause);
			expect(Option.isSome(failure)).toBe(true);
			if (Option.isSome(failure)) {
				expect(failure.value).toBeInstanceOf(RalphContractValidationError);
			}
		}
	});

	it("rejects unsanitized loop names", () => {
		const decodeLoopName = Schema.decodeUnknownSync(LoopNameSchema);
		expect(() => decodeLoopName("bad name")).toThrow();
		expect(() => decodeLoopName("bad__name")).toThrow();
		expect(() => decodeLoopName("bad/name")).toThrow();
		expect(decodeLoopName("good-name_01")).toBe("good-name_01");
	});

	it("exposes tagged domain errors", () => {
		const error = new RalphLoopNotFoundError({ loopName: "missing-loop" });
		expect(error._tag).toBe("RalphLoopNotFoundError");
		expect(error.loopName).toBe("missing-loop");
	});
});
