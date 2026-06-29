import { describe, expect, it } from "vitest";

import { buildToolDescription } from "../src/agent/tool.js";

function makeRegistry(agents: ReadonlyArray<{ name: string; description: string }>) {
	return { list: () => agents };
}

const agents = [
	{ name: "smart", description: "Smart agent.\nGeneral purpose." },
	{ name: "oracle", description: "Expert reasoning agent." },
	{ name: "finder", description: "Fast code search agent." },
];

describe("buildToolDescription", () => {
	it("lists all agents when no isDisabled predicate is given", () => {
		const desc = buildToolDescription(makeRegistry(agents));
		expect(desc).toContain("- smart:");
		expect(desc).toContain("- oracle:");
		expect(desc).toContain("- finder:");
	});

	it("lists all agents when isDisabled returns false for every agent", () => {
		const desc = buildToolDescription(makeRegistry(agents), undefined, () => false);
		expect(desc).toContain("- smart:");
		expect(desc).toContain("- oracle:");
		expect(desc).toContain("- finder:");
	});

	it("excludes disabled agents entirely from description", () => {
		const disabled = new Set(["oracle"]);
		const desc = buildToolDescription(makeRegistry(agents), undefined, (n) => disabled.has(n));

		expect(desc).toContain("- smart:");
		expect(desc).toContain("- finder:");
		expect(desc).not.toContain("oracle");
	});

	it("excludes multiple disabled agents", () => {
		const disabled = new Set(["smart", "finder"]);
		const desc = buildToolDescription(makeRegistry(agents), undefined, (n) => disabled.has(n));

		expect(desc).toContain("- oracle:");
		expect(desc).not.toContain("smart");
		expect(desc).not.toContain("finder");
	});

	it("uses only first line of multi-line description", () => {
		const desc = buildToolDescription(makeRegistry(agents));
		expect(desc).toContain("- smart: Smart agent. General purpose.");
	});

	it("normalizes folded yaml-style whitespace without truncating the description", () => {
		const desc = buildToolDescription(
			makeRegistry([
				{
					name: "review",
					description:
						"Code review agent (read-only).\nReviews diffs for bugs, security issues,\nimprovements. Returns prioritized findings (P0-P3).",
				},
			]),
		);

		expect(desc).toContain(
			"- review: Code review agent (read-only). Reviews diffs for bugs, security issues, improvements. Returns prioritized findings (P0-P3).",
		);
	});

	it("respects spawns filter combined with isDisabled", () => {
		const disabled = new Set(["oracle"]);
		const desc = buildToolDescription(makeRegistry(agents), ["smart", "oracle"], (n) =>
			disabled.has(n),
		);

		expect(desc).toContain("- smart:");
		expect(desc).not.toContain("oracle");
		expect(desc).not.toContain("finder");
	});

	it("shows no agent entries when all are disabled", () => {
		const desc = buildToolDescription(makeRegistry(agents), undefined, () => true);

		expect(desc).not.toContain("- smart:");
		expect(desc).not.toContain("- oracle:");
		expect(desc).not.toContain("- finder:");
	});
});
