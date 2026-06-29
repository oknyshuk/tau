import { describe, expect, it } from "vitest";

import {
	loadPersistedState,
	loadPersistedStateDetailed,
	PersistedStateDecodeError,
	TAU_PERSISTED_STATE_TYPE,
} from "../src/shared/state.js";

function makeContext(entries: unknown[]) {
	return {
		sessionManager: {
			getEntries: () => entries,
		},
	};
}

describe("shared persisted state", () => {
	it("distinguishes missing session state from invalid session state", () => {
		expect(loadPersistedStateDetailed(makeContext([]))).toEqual({ _tag: "missing" });

		const invalid = loadPersistedStateDetailed(
			makeContext([
				{
					type: "custom",
					customType: TAU_PERSISTED_STATE_TYPE,
					data: { status: { fetchedAt: Number.POSITIVE_INFINITY, values: {} } },
				},
			]),
		);

		expect(invalid._tag).toBe("invalid");
		if (invalid._tag !== "invalid") {
			throw new Error("Expected invalid persisted state result");
		}
		expect(invalid.error).toBeInstanceOf(PersistedStateDecodeError);
		expect(invalid.error.message).toContain("Invalid tau persisted state in session entry 1");
	});

	it("throws a typed error when the latest session state entry is invalid", () => {
		const ctx = makeContext([
			{
				type: "custom",
				customType: TAU_PERSISTED_STATE_TYPE,
				data: { execution: { policy: { tools: { kind: "inherit" } } } },
			},
			{
				type: "custom",
				customType: TAU_PERSISTED_STATE_TYPE,
				data: { status: { fetchedAt: Number.POSITIVE_INFINITY, values: {} } },
			},
		]);

		expect(() => loadPersistedState(ctx)).toThrowError(PersistedStateDecodeError);
	});
});
