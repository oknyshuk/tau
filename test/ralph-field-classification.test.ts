import { describe, expect, it } from "vitest";

import {
	allRalphFieldsAreClassified,
	getRalphFieldClassification,
	RALPH_FIELD_CLASSIFICATIONS,
} from "../src/ralph/field-classification.js";

describe("ralph field classification", () => {
	it("has every RalphLoopStateDetails field classified", () => {
		expect(allRalphFieldsAreClassified()).toBe(true);
	});

	it("classifies capabilityContract as configurable", () => {
		expect(getRalphFieldClassification("capabilityContract")).toBe("configurable");
	});

	it("classifies system-managed fields correctly", () => {
		expect(getRalphFieldClassification("iteration")).toBe("system");
		expect(getRalphFieldClassification("metrics")).toBe("system");
	});

	it("classifies runtime-managed fields correctly", () => {
		expect(getRalphFieldClassification("pendingDecision")).toBe("runtime");
		expect(getRalphFieldClassification("lastReflectionAt")).toBe("runtime");
	});

	it("has no duplicate field entries", () => {
		const fields = RALPH_FIELD_CLASSIFICATIONS.map((entry) => entry.field);
		const uniqueFields = new Set(fields);
		expect(uniqueFields.size).toBe(fields.length);
	});
});
