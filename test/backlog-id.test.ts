import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
	generateChildIdEffect,
	generateHashId,
	generateIssueIdEffect,
	nextChildNumber,
} from "../src/backlog/id.js";
import { BacklogIdGenerationError } from "../src/backlog/errors.js";

const timestamp = new Date("2026-01-01T00:00:00Z");

describe("backlog id generation", () => {
	it("produces deterministic ids", () => {
		const a = generateHashId("tau", "title", "desc", "user", timestamp, 4, 0);
		const b = generateHashId("tau", "title", "desc", "user", timestamp, 4, 0);
		expect(a).toBe(b);
	});

	it("includes prefix and requested length", () => {
		const id = generateHashId("tau", "t", "d", "u", timestamp, 5, 0);
		expect(id).toMatch(/^tau-[0-9a-z]{5}$/);
	});

	it("generates unique issue ids", () => {
		const first = Effect.runSync(generateIssueIdEffect({
			prefix: "tau",
			title: "test",
			creator: "user",
			timestamp,
			existingIds: new Set(),
			existingTopLevelCount: 0,
		}));

		const second = Effect.runSync(generateIssueIdEffect({
			prefix: "tau",
			title: "test",
			creator: "user",
			timestamp,
			existingIds: new Set([first]),
			existingTopLevelCount: 1,
		}));

		expect(first).not.toBe(second);
	});

	it("uses longer ids when collision count is high", () => {
		const lowCount = Effect.runSync(generateIssueIdEffect({
			prefix: "tau",
			title: "a",
			creator: "u",
			timestamp,
			existingIds: new Set(),
			existingTopLevelCount: 5,
		}));

		const highCount = Effect.runSync(generateIssueIdEffect({
			prefix: "tau",
			title: "a",
			creator: "u",
			timestamp,
			existingIds: new Set(),
			existingTopLevelCount: 50_000,
		}));

		expect(highCount.split("-")[1]?.length).toBeGreaterThan(lowCount.split("-")[1]?.length ?? 0);
	});

	it("supports child ids and depth checks", () => {
		expect(Effect.runSync(generateChildIdEffect("tau-abc", 1))).toBe("tau-abc.1");
		expect(Effect.runSync(generateChildIdEffect("tau-abc.1", 3))).toBe("tau-abc.1.3");
		expect(() => Effect.runSync(generateChildIdEffect("tau-abc.1.2.3", 1, 3))).toThrow(BacklogIdGenerationError);
	});

	it("finds the next child number", () => {
		expect(nextChildNumber("tau-abc", new Set(["tau-abc", "tau-xyz"]))).toBe(1);
		expect(nextChildNumber("tau-abc", new Set(["tau-abc.1", "tau-abc.3", "tau-abc.2"]))).toBe(4);
		expect(nextChildNumber("tau-abc", new Set(["tau-abc.1", "tau-abc.1.5"]))).toBe(2);
	});
});
