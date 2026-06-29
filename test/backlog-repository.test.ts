import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Cause, Effect, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { decodeBacklogEvent, resolveBacklogPaths } from "../src/backlog/contract.js";
import { BacklogStorageError } from "../src/backlog/errors.js";
import { BacklogInfrastructureLive } from "../src/backlog/repository.js";
import { BacklogRepository } from "../src/backlog/services.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-backlog-repo-"));
	tempDirs.push(dir);
	return dir;
}

const runWithRepository = <A>(
	workspaceRoot: string,
	run: (repository: ReturnType<typeof BacklogRepository.of>) => Effect.Effect<A, unknown, never>,
): Promise<A> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const repository = yield* BacklogRepository;
			return yield* run(repository);
		}).pipe(Effect.provide(BacklogInfrastructureLive(workspaceRoot))),
	);

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

describe("backlog repository infrastructure", () => {
	it("appends events and rebuilds materialized issues through the repository service", async () => {
		const workspaceRoot = await makeWorkspace();

		const created = Effect.runSync(decodeBacklogEvent({
			schema_version: 1,
			event_id: "evt-tau-1-001",
			issue_id: "tau-1",
			recorded_at: "2026-03-29T12:00:00.000Z",
			actor: "alice",
			kind: "issue.created",
			fields: {
				id: "tau-1",
				title: "Repository service",
				status: "open",
				priority: 2,
				issue_type: "task",
				created_at: "2026-03-29T12:00:00.000Z",
				updated_at: "2026-03-29T12:00:00.000Z",
			},
		}));

		const program = Effect.gen(function* () {
			const repository = yield* BacklogRepository;
			yield* repository.appendEvent(created);
			const rebuilt = yield* repository.rebuildMaterializedIssues();
			const cached = yield* repository.readMaterializedIssues();
			return { rebuilt, cached };
		});

		const result = await Effect.runPromise(program.pipe(Effect.provide(BacklogInfrastructureLive(workspaceRoot))));
		expect(result.rebuilt).toHaveLength(1);
		expect(result.cached).toHaveLength(1);
		expect(result.rebuilt[0]?.id).toBe("tau-1");
		expect(result.cached[0]?.title).toBe("Repository service");
	});

	it("returns typed storage errors for corrupt event JSON", async () => {
		const workspaceRoot = await makeWorkspace();
		const eventsDir = path.join(workspaceRoot, ".pi", "backlog", "events", "2026", "03", "29");
		await fs.mkdir(eventsDir, { recursive: true });
		await fs.writeFile(path.join(eventsDir, "broken.json"), "{not-json", "utf8");

		const program = Effect.gen(function* () {
			const repository = yield* BacklogRepository;
			return yield* Effect.exit(repository.readEvents());
		});

		const exit = await Effect.runPromise(program.pipe(Effect.provide(BacklogInfrastructureLive(workspaceRoot))));
		expect(exit._tag).toBe("Failure");
		if (exit._tag === "Failure") {
			const failure = Cause.findErrorOption(exit.cause);
			expect(Option.isSome(failure)).toBe(true);
			if (Option.isSome(failure)) {
				expect(failure.value).toBeInstanceOf(BacklogStorageError);
			}
		}
	});

	it("serializes concurrent withWriteLock calls and removes lock file on release", async () => {
		const workspaceRoot = await makeWorkspace();
		const lockPath = path.join(resolveBacklogPaths(workspaceRoot).materializedCacheDir, ".lock");

		let releaseFirstLock: (() => void) | undefined;
		const firstLockGate = new Promise<void>((resolve) => {
			releaseFirstLock = resolve;
		});

		const first = runWithRepository(workspaceRoot, (repository) =>
			repository.withWriteLock(Effect.promise(() => firstLockGate).pipe(Effect.as("first"))),
		);

		await waitForFile(lockPath);

		let secondResolved = false;
		const second = runWithRepository(workspaceRoot, (repository) =>
			repository.withWriteLock(Effect.succeed("second")),
		).then((value) => {
			secondResolved = true;
			return value;
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(secondResolved).toBe(false);

		releaseFirstLock?.();
		await expect(first).resolves.toBe("first");
		await expect(second).resolves.toBe("second");

		await expect(fs.access(lockPath)).rejects.toThrow();
	});

	it("reclaims stale lock files and leaves no claim artifacts", async () => {
		const workspaceRoot = await makeWorkspace();
		const lockPath = path.join(resolveBacklogPaths(workspaceRoot).materializedCacheDir, ".lock");
		await fs.mkdir(path.dirname(lockPath), { recursive: true });
		await fs.writeFile(lockPath, JSON.stringify({ pid: 999_999, token: "stale-lock" }), "utf8");

		await expect(
			runWithRepository(workspaceRoot, (repository) => repository.withWriteLock(Effect.succeed("ok"))),
		).resolves.toBe("ok");

		const cacheEntries = await fs.readdir(path.dirname(lockPath));
		expect(cacheEntries.filter((entry) => entry.startsWith(".lock.claim-"))).toEqual([]);
		await expect(fs.access(lockPath)).rejects.toThrow();
	});
});
