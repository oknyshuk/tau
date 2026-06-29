import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
	addIssueComment,
	addIssueDependency,
	createIssue,
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
