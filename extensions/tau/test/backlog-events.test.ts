import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Database as DatabaseSync } from "bun:sqlite";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
	addIssueComment,
	addIssueDependency,
	createIssue,
	importBeadsIfNeeded,
	removeIssueDependency,
	setIssueStatus,
	updateIssueFields,
} from "../src/backlog/events.js";
import { resolveBacklogPaths } from "../src/backlog/contract.js";
import { BacklogInfrastructureLive } from "../src/backlog/repository.js";
import { BacklogRepository } from "../src/backlog/services.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-backlog-events-"));
	tempDirs.push(dir);
	return dir;
}

async function readBacklogEventsFromWorkspace(workspaceRoot: string) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const repository = yield* BacklogRepository;
			return yield* repository.readEvents();
		}).pipe(Effect.provide(BacklogInfrastructureLive(workspaceRoot))),
	);
}

async function readMaterializedIssuesCache(workspaceRoot: string) {
	return Effect.runPromise(
		Effect.gen(function* () {
			const repository = yield* BacklogRepository;
			return yield* repository.readMaterializedIssues();
		}).pipe(Effect.provide(BacklogInfrastructureLive(workspaceRoot))),
	);
}

async function holdBacklogWriteLock(
	workspaceRoot: string,
	releaseGate: Promise<void>,
): Promise<string> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const repository = yield* BacklogRepository;
			return yield* repository.withWriteLock(Effect.promise(() => releaseGate).pipe(Effect.as("locked")));
		}).pipe(Effect.provide(BacklogInfrastructureLive(workspaceRoot))),
	);
}

async function waitForFile(pathToWait: string, timeoutMs = 1_000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		try {
			await fs.access(pathToWait);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`Timed out waiting for file: ${pathToWait}`);
}

describe("backlog events", () => {
	it("writes immutable event files for create, update, status, dependency, and comment mutations", async () => {
		const workspaceRoot = await makeWorkspace();

		const created = await Effect.runPromise(createIssue(workspaceRoot, {
			title: "Initial",
			actor: "alice",
			id: "tau-1",
			recorded_at: "2026-03-29T12:00:00.000Z",
		}));
		expect(created.id).toBe("tau-1");

		await Effect.runPromise(updateIssueFields(
			workspaceRoot,
			"tau-1",
			"alice",
			{ title: "Changed" },
			{ recorded_at: "2026-03-29T12:01:00.000Z" },
		));
		await Effect.runPromise(setIssueStatus(workspaceRoot, {
			issueId: "tau-1",
			actor: "alice",
			status: "in_progress",
			recorded_at: "2026-03-29T12:02:00.000Z",
		}));

		await Effect.runPromise(createIssue(workspaceRoot, {
			title: "Blocker",
			actor: "alice",
			id: "tau-2",
			recorded_at: "2026-03-29T12:02:30.000Z",
		}));

		await Effect.runPromise(addIssueDependency(workspaceRoot, {
			issueId: "tau-1",
			actor: "alice",
			dependsOnId: "tau-2",
			type: "blocks",
			recorded_at: "2026-03-29T12:03:00.000Z",
		}));
		await Effect.runPromise(addIssueComment(workspaceRoot, {
			issueId: "tau-1",
			actor: "alice",
			text: "hello",
			recorded_at: "2026-03-29T12:04:00.000Z",
		}));

		const events = await readBacklogEventsFromWorkspace(workspaceRoot);
		expect(events).toHaveLength(6);
		expect(events.map((event) => event.kind)).toEqual([
			"issue.created",
			"issue.updated",
			"issue.updated",
			"issue.created",
			"issue.updated",
			"issue.updated",
		]);

		const paths = resolveBacklogPaths(workspaceRoot);
		const cached = await readMaterializedIssuesCache(workspaceRoot);
		const issue = cached.find((entry) => entry.id === "tau-1");
		expect(issue?.title).toBe("Changed");
		expect(issue?.status).toBe("in_progress");
		expect(issue?.dependencies?.[0]?.depends_on_id).toBe("tau-2");
		expect(issue?.comments?.[0]?.text).toBe("hello");
		expect(await fs.readFile(paths.materializedIssuesPath, "utf8")).toContain("tau-1");
	});

	it("imports .beads/issues.jsonl on first use and preserves ids and dependencies", async () => {
		const workspaceRoot = await makeWorkspace();
		const beadsDir = path.join(workspaceRoot, ".beads");
		await fs.mkdir(beadsDir, { recursive: true });
		await fs.writeFile(
			path.join(beadsDir, "issues.jsonl"),
			[
				JSON.stringify({
					id: "tau-legacy-1",
					title: "Legacy blocker",
					status: "open",
					priority: 1,
					issue_type: "task",
					created_at: "2026-03-20T10:00:00.000+01:00",
					updated_at: "2026-03-20T10:00:00.000+01:00",
				}),
				JSON.stringify({
					id: "tau-legacy-2",
					title: "Legacy blocked",
					status: "open",
					priority: 2,
					issue_type: "task",
					created_at: "2026-03-20T10:01:00.000Z",
					updated_at: "2026-03-20T10:01:00.000Z",
					dependencies: [
						{
							issue_id: "tau-legacy-2",
							depends_on_id: "tau-legacy-1",
							type: "blocks",
							created_at: "2026-03-20T10:01:00.000Z",
						},
					],
					custom_field: { keep: true },
				}),
			].join("\n") + "\n",
			"utf8",
		);

		const imported = await Effect.runPromise(importBeadsIfNeeded(workspaceRoot));
		expect(imported.map((issue) => issue.id).sort()).toEqual(["tau-legacy-1", "tau-legacy-2"]);
		expect(imported.find((issue) => issue.id === "tau-legacy-2")?.dependencies?.[0]?.depends_on_id).toBe("tau-legacy-1");
		expect(imported.find((issue) => issue.id === "tau-legacy-2")?.["custom_field"]).toEqual({ keep: true });

		const events = await readBacklogEventsFromWorkspace(workspaceRoot);
		expect(events).toHaveLength(2);
		expect(events.every((event) => event.kind === "issue.imported")).toBe(true);
		expect(events.find((event) => event.issue_id === "tau-legacy-1")?.recorded_at).toBe(
			"2026-03-20T09:00:00.000Z",
		);
	});

	it("imports from .beads/beads.db when jsonl is absent and rebuilds cache after appended events", async () => {
		const workspaceRoot = await makeWorkspace();
		const beadsDir = path.join(workspaceRoot, ".beads");
		await fs.mkdir(beadsDir, { recursive: true });

		const dbPath = path.join(beadsDir, "beads.db");
		const db = new DatabaseSync(dbPath);
		try {
			db.exec(`
				CREATE TABLE issues (
					id TEXT NOT NULL,
					title TEXT NOT NULL,
					description TEXT,
					status TEXT,
					priority INTEGER,
					issue_type TEXT,
					created_at TEXT,
					updated_at TEXT,
					deleted_at TEXT
				);
				CREATE TABLE dependencies (
					issue_id TEXT NOT NULL,
					depends_on_id TEXT NOT NULL,
					type TEXT NOT NULL,
					created_at TEXT NOT NULL,
					created_by TEXT
				);
				CREATE TABLE comments (
					id INTEGER PRIMARY KEY,
					issue_id TEXT NOT NULL,
					author TEXT NOT NULL,
					text TEXT NOT NULL,
					created_at TEXT NOT NULL
				);
			`);
			db.prepare(
				`INSERT INTO issues (id, title, description, status, priority, issue_type, created_at, updated_at, deleted_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
			).run(
				"tau-db-1",
				"Loaded from db",
				"db fallback",
				"open",
				1,
				"task",
				"2026-03-21T00:00:00.000Z",
				"2026-03-21T00:00:00.000Z",
			);
			db.prepare(
				`INSERT INTO comments (id, issue_id, author, text, created_at) VALUES (?, ?, ?, ?, ?)`,
			).run(1, "tau-db-1", "alice", "hello", "2026-03-21T00:00:00.000Z");
		} finally {
			db.close();
		}

		const imported = await Effect.runPromise(importBeadsIfNeeded(workspaceRoot));
		expect(imported).toHaveLength(1);
		expect(imported[0]?.id).toBe("tau-db-1");
		expect(imported[0]?.comments?.[0]?.text).toBe("hello");

		await Effect.runPromise(addIssueComment(workspaceRoot, {
			issueId: "tau-db-1",
			actor: "alice",
			text: "after import",
			recorded_at: "2026-03-21T00:01:00.000Z",
		}));

		const cached = await readMaterializedIssuesCache(workspaceRoot);
		expect(cached[0]?.comments?.map((comment) => comment.text)).toEqual(["hello", "after import"]);
	});

	it("removes dependencies via a new immutable event", async () => {
		const workspaceRoot = await makeWorkspace();
		await Effect.runPromise(createIssue(workspaceRoot, { title: "A", actor: "alice", id: "tau-a", recorded_at: "2026-03-29T12:00:00.000Z" }));
		await Effect.runPromise(createIssue(workspaceRoot, { title: "B", actor: "alice", id: "tau-b", recorded_at: "2026-03-29T12:00:01.000Z" }));
		await Effect.runPromise(addIssueDependency(workspaceRoot, {
			issueId: "tau-a",
			actor: "alice",
			dependsOnId: "tau-b",
			type: "blocks",
			recorded_at: "2026-03-29T12:00:02.000Z",
		}));
		const updated = await Effect.runPromise(removeIssueDependency(workspaceRoot, {
			issueId: "tau-a",
			actor: "alice",
			dependsOnId: "tau-b",
			type: "blocks",
			recorded_at: "2026-03-29T12:00:03.000Z",
		}));

		expect(updated.dependencies ?? []).toEqual([]);
		expect((await readBacklogEventsFromWorkspace(workspaceRoot)).length).toBe(4);
	});

	it("serializes concurrent dependency appends so incompatible cycles cannot both commit", async () => {
		const workspaceRoot = await makeWorkspace();
		await Effect.runPromise(createIssue(workspaceRoot, { title: "A", actor: "alice", id: "tau-a", recorded_at: "2026-03-29T12:00:00.000Z" }));
		await Effect.runPromise(createIssue(workspaceRoot, { title: "B", actor: "alice", id: "tau-b", recorded_at: "2026-03-29T12:00:01.000Z" }));
		const lockPath = path.join(resolveBacklogPaths(workspaceRoot).materializedCacheDir, ".lock");

		let releaseFirstLock: (() => void) | undefined;
		const firstLockGate = new Promise<void>((resolve) => {
			releaseFirstLock = resolve;
		});

		const heldLock = holdBacklogWriteLock(workspaceRoot, firstLockGate);
		await waitForFile(lockPath);

		let addResolved = false;
		const first = Effect.runPromise(addIssueDependency(workspaceRoot, {
			issueId: "tau-a",
			actor: "alice",
			dependsOnId: "tau-b",
			type: "blocks",
			recorded_at: "2026-03-29T12:00:02.000Z",
		})).then((value) => {
			addResolved = true;
			return value;
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(addResolved).toBe(false);

		releaseFirstLock?.();
		await expect(heldLock).resolves.toBe("locked");
		await expect(first).resolves.toBeDefined();

		const second = Effect.runPromise(addIssueDependency(workspaceRoot, {
			issueId: "tau-b",
			actor: "alice",
			dependsOnId: "tau-a",
			type: "blocks",
			recorded_at: "2026-03-29T12:00:03.000Z",
		}));
		await expect(second).rejects.toBeDefined();

		const events = await readBacklogEventsFromWorkspace(workspaceRoot);
		expect(events).toHaveLength(3);
		expect(events.filter((event) => event.kind === "issue.updated")).toHaveLength(1);

		const cached = await readMaterializedIssuesCache(workspaceRoot);
		const aDeps = cached.find((issue) => issue.id === "tau-a")?.dependencies ?? [];
		const bDeps = cached.find((issue) => issue.id === "tau-b")?.dependencies ?? [];
		expect(aDeps.length + bDeps.length).toBe(1);
	});
});
