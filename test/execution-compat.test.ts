import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
	DEFAULT_EXECUTION_POLICY,
	ExecutionProfileSchema,
	makeExecutionProfile,
	normalizeExecutionState,
} from "../src/execution/schema.js";

describe("execution normalization", () => {
	it("normalizes explicit execution state", () => {
		const state = normalizeExecutionState({
			policy: { tools: { kind: "inherit" } },
		});

		expect(state.policy.tools.kind).toBe("inherit");
	});

	it("defaults missing policy deterministically", () => {
		const state = normalizeExecutionState({});

		expect(state.policy.tools.kind).toBe("inherit");
	});

	it("builds concrete execution profiles", () => {
		const profile = makeExecutionProfile({
			model: "anthropic/claude-opus-4-5",
			thinking: "medium",
			policy: DEFAULT_EXECUTION_POLICY,
		});

		expect(profile).toEqual({
			model: "anthropic/claude-opus-4-5",
			thinking: "medium",
			policy: DEFAULT_EXECUTION_POLICY,
		});
		expect("selector" in profile).toBe(false);
		expect("promptProfile" in profile).toBe(false);
	});

	it("rejects legacy mode-shaped execution profiles", () => {
		const decode = Schema.decodeUnknownSync(ExecutionProfileSchema);

		expect(() =>
			decode({
				selector: { mode: "deep" },
				promptProfile: {
					mode: "deep",
					model: "anthropic/claude-opus-4-5",
					thinking: "high",
				},
				policy: DEFAULT_EXECUTION_POLICY,
			}),
		).toThrow();
	});
});
