import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";

import { createIssue, setIssueStatus } from "../src/backlog/events.js";
import {
	countInProgressIssues,
	makeFooterHygieneRef,
	readFooterHygiene,
	readFooterBacklogInProgressCount,
	setFooterHygieneIfChanged,
} from "../src/services/footer.js";

async function withTempWorkspace<A>(fn: (workspaceRoot: string) => Promise<A>): Promise<A> {
	const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tau-footer-backlog-"));
	try {
		await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
		return await fn(workspaceRoot);
	} finally {
		await fs.rm(workspaceRoot, { recursive: true, force: true });
	}
}

describe("footer backlog hygiene", () => {
	it("stores VCS hygiene in a ref and reports only changed snapshots", () => {
		const ref = makeFooterHygieneRef();
		const next = {
			vcsLineDelta: { added: 110, removed: 97 },
			inProgressCount: 1,
		};

		expect(setFooterHygieneIfChanged(ref, next)).toBe(true);
		expect(readFooterHygiene(ref)).toEqual(next);
		expect(setFooterHygieneIfChanged(ref, next)).toBe(false);
	});

	it("counts in-progress issues from backlog state", () => {
		expect(
			countInProgressIssues([
				{ id: "tau-1", title: "one", status: "in_progress" },
				{ id: "tau-2", title: "two", status: "open" },
				{ id: "tau-3", title: "three", status: "closed" },
			]),
		).toBe(1);
	});

	it("resolves the nearest workspace root and reads backlog cache state", async () => {
		await withTempWorkspace(async (workspaceRoot) => {
			const first = await Effect.runPromise(
				createIssue(workspaceRoot, { title: "Alpha", actor: "test", prefix: "test" }),
			);
			await Effect.runPromise(createIssue(workspaceRoot, { title: "Beta", actor: "test", prefix: "test" }));
			await Effect.runPromise(setIssueStatus(workspaceRoot, {
				issueId: first.id,
				actor: "test",
				status: "in_progress",
			}));

			const nested = path.join(workspaceRoot, "packages", "tau", "src");
			await fs.mkdir(nested, { recursive: true });

			expect(await readFooterBacklogInProgressCount(nested)).toBe(1);
		});
	});
});
