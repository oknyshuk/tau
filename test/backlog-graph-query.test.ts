import { Cause, Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { BacklogContractValidationError } from "../src/backlog/errors.js";
import {
	assertNoDependencyCycles,
	buildGraph,
	hasPath,
	listDependencies,
	listDependents,
	wouldCreateCycle,
} from "../src/backlog/graph.js";
import { decodeIssueQuery, filterIssues } from "../src/backlog/query.js";
import { decodeIssue, type Issue } from "../src/backlog/schema.js";

function makeIssue(overrides: Partial<Issue> & { id: string; title: string }): Issue {
	const { id, title, ...rest } = overrides;
	return Effect.runSync(decodeIssue({
		id,
		title,
		priority: 2,
		status: "open",
		issue_type: "task",
		created_at: "2026-02-01T00:00:00.000Z",
		updated_at: "2026-02-01T00:00:00.000Z",
		...rest,
	}));
}

describe("backlog graph and query", () => {
	it("detects cycles and self references", () => {
		const a = makeIssue({
			id: "a",
			title: "a",
			dependencies: [{ issue_id: "a", depends_on_id: "b", type: "blocks", created_at: "2026-02-01T00:00:00.000Z" }],
		});
		const b = makeIssue({
			id: "b",
			title: "b",
			dependencies: [{ issue_id: "b", depends_on_id: "c", type: "blocks", created_at: "2026-02-01T00:00:00.000Z" }],
		});
		const c = makeIssue({ id: "c", title: "c" });

		const graph = buildGraph([a, b, c]);
		expect(hasPath(graph, "a", "c")).toBe(true);
		expect(wouldCreateCycle(graph, "c", "a")).toBe(true);
		expect(wouldCreateCycle(graph, "a", "a")).toBe(true);
	});

	it("returns dependency views", () => {
		const blocker = makeIssue({ id: "b", title: "blocker" });
		const blocked = makeIssue({
			id: "a",
			title: "blocked",
			dependencies: [{ issue_id: "a", depends_on_id: "b", type: "blocks", created_at: "2026-02-01T00:00:00.000Z" }],
		});

		expect(listDependencies("a", [blocked, blocker]).map((issue) => issue.id)).toEqual(["b"]);
		expect(listDependents("b", [blocked, blocker]).map((issue) => issue.id)).toEqual(["a"]);
	});

	it("filters ready and blocked", () => {
		const blocker = makeIssue({ id: "b", title: "blocker", status: "open" });
		const blocked = makeIssue({
			id: "a",
			title: "blocked",
			status: "open",
			dependencies: [{ issue_id: "a", depends_on_id: "b", type: "blocks", created_at: "2026-02-01T00:00:00.000Z" }],
		});
		const ready = makeIssue({ id: "c", title: "ready", status: "open" });

		const issues = [blocked, blocker, ready];

		expect(filterIssues(issues, { ready: true }).map((issue) => issue.id)).toEqual(["b", "c"]);
		expect(filterIssues(issues, { blocked: true }).map((issue) => issue.id)).toEqual(["a"]);
	});

	it("filters by text and sorts by priority", () => {
		const issue1 = makeIssue({ id: "a", title: "Fix bug", priority: 1 });
		const issue2 = makeIssue({
			id: "b",
			title: "Write docs",
			description: "documentation",
			priority: 3,
		});
		const issue3 = makeIssue({ id: "c", title: "Feature", priority: 2 });

		expect(filterIssues([issue1, issue2, issue3], { text: "docs" }).map((issue) => issue.id)).toEqual(["b"]);
		expect(filterIssues([issue2, issue3, issue1], { sortBy: "priority" }).map((issue) => issue.id)).toEqual([
			"a",
			"c",
			"b",
		]);
	});

	it("decodes issue queries with typed errors", async () => {
		const valid = await Effect.runPromise(
			decodeIssueQuery({ status: ["open"], ready: true, sortBy: "priority", order: "asc" }),
		);
		expect(valid.ready).toBe(true);

		const invalid = await Effect.runPromise(
			Effect.exit(decodeIssueQuery({ status: ["open"], sortBy: "invalid-field" })),
		);
		expect(invalid._tag).toBe("Failure");
		if (invalid._tag === "Failure") {
			const failure = Cause.findErrorOption(invalid.cause);
			expect(Option.isSome(failure)).toBe(true);
			if (Option.isSome(failure)) {
				expect(failure.value).toBeInstanceOf(BacklogContractValidationError);
			}
		}
	});

	it("rejects dependency cycles", () => {
		const a = makeIssue({
			id: "a",
			title: "a",
			dependencies: [{ issue_id: "a", depends_on_id: "b", type: "blocks", created_at: "2026-02-01T00:00:00.000Z" }],
		});
		const b = makeIssue({
			id: "b",
			title: "b",
			dependencies: [{ issue_id: "b", depends_on_id: "a", type: "blocks", created_at: "2026-02-01T00:00:00.000Z" }],
		});

		expect(() => Effect.runSync(assertNoDependencyCycles([a, b]))).toThrow();
	});
});
