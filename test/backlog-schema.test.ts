import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeIssue, encodeIssue } from "../src/backlog/schema.js";

describe("backlog schema", () => {
	it("roundtrips unknown fields", async () => {
		const raw = {
			id: "tau-abc",
			title: "Keep unknown",
			priority: 2,
			status: "open",
			issue_type: "task",
			created_at: "2026-02-01T00:00:00.000Z",
			updated_at: "2026-02-01T00:00:00.000Z",
			custom_field: { nested: ["a", "b"], flag: true },
		};

		const issue = await Effect.runPromise(decodeIssue(raw));
		const encoded = await Effect.runPromise(encodeIssue(issue));

		expect(encoded["custom_field"]).toEqual(raw.custom_field);
		expect(encoded.id).toBe(raw.id);
		expect(encoded.title).toBe(raw.title);
	});
});
