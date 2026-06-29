import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
	EXEC_DEFAULT_YIELD_TIME_MS,
	Shell,
	ShellExecutionError,
	ShellLive,
} from "../src/services/shell.js";

function envRecord(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") env[key] = value;
	}
	return env;
}

function isProcessRunning(pid: number): boolean {
	try {
		const status = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
			encoding: "utf8",
		}).trim();
		return status.length > 0 && !status.startsWith("Z");
	} catch {
		return false;
	}
}

function shQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function waitForProcessExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (!isProcessRunning(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function waitForPidFile(pidPath: string): Promise<number> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			const content = await fs.readFile(pidPath, "utf8");
			const pid = Number.parseInt(content.trim(), 10);
			if (Number.isInteger(pid)) return pid;
		} catch {
			// The process may not have written the pid yet.
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Timed out waiting for shell pid file");
}

async function withTempDir<A>(fn: (dir: string) => Promise<A>): Promise<A> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-shell-service-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("Shell service", () => {
	it("runs a one-shot command to completion", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* Shell;
				return yield* shell.exec({
					file: "bash",
					args: ["-lc", "echo hello"],
					cwd: process.cwd(),
					env: envRecord(),
					tty: false,
					ownerId: "test-session",
					yieldTimeMs: 1_000,
					maxOutputTokens: 1_000,
				});
			}).pipe(Effect.provide(ShellLive)),
		);

		expect(result.exitCode).toBe(0);
		expect(result.sessionId).toBeUndefined();
		expect(result.output).toContain("hello");
		expect(result.wallTimeMs).toBeTypeOf("number");
	});

	it("uses the Codex exec default wait for invalid caller input", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* Shell;
				return yield* shell.exec({
					file: "bash",
					args: ["-lc", "sleep 0.2; echo default-wait"],
					cwd: process.cwd(),
					env: envRecord(),
					tty: false,
					ownerId: "test-session",
					yieldTimeMs: Number.NaN,
					maxOutputTokens: 1_000,
				});
			}).pipe(Effect.provide(ShellLive)),
		);

		expect(EXEC_DEFAULT_YIELD_TIME_MS).toBe(10_000);
		expect(result.exitCode).toBe(0);
		expect(result.sessionId).toBeUndefined();
		expect(result.output).toContain("default-wait");
	});

	it("keeps a tty session open and accepts stdin", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* Shell;
				const started = yield* shell.exec({
					file: "bash",
					args: ["-lc", "read line; echo got:$line"],
					cwd: process.cwd(),
					env: envRecord(),
					tty: true,
					ownerId: "test-session",
					yieldTimeMs: 25,
					maxOutputTokens: 1_000,
				});
				expect(started.sessionId).toBeTypeOf("number");
				return yield* shell.write({
					sessionId: started.sessionId!,
					ownerId: "test-session",
					chars: "abc\r",
					yieldTimeMs: 1_000,
					maxOutputTokens: 1_000,
				});
			}).pipe(Effect.provide(ShellLive)),
		);

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("got:abc");
	});

	it("uses empty write_stdin calls to poll and wait for completion", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* Shell;
				const started = yield* shell.exec({
					file: "bash",
					args: ["-lc", "sleep 0.5; echo delayed-output"],
					cwd: process.cwd(),
					env: envRecord(),
					tty: false,
					ownerId: "test-session",
					yieldTimeMs: 250,
					maxOutputTokens: 1_000,
				});
				expect(started.sessionId).toBeTypeOf("number");
				expect(started.output).not.toContain("delayed-output");
				return yield* shell.write({
					sessionId: started.sessionId!,
					ownerId: "test-session",
					chars: "",
					yieldTimeMs: 10,
					maxOutputTokens: 1_000,
				});
			}).pipe(Effect.provide(ShellLive)),
		);

		expect(result.exitCode).toBe(0);
		expect(result.sessionId).toBeUndefined();
		expect(result.output).toContain("delayed-output");
	});

	it("rejects stdin writes for non-tty sessions", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* Shell;
				const started = yield* shell.exec({
					file: "bash",
					args: ["-lc", "sleep 1"],
					cwd: process.cwd(),
					env: envRecord(),
					tty: false,
					ownerId: "test-session",
					yieldTimeMs: 250,
					maxOutputTokens: 1_000,
				});
				expect(started.sessionId).toBeTypeOf("number");
				const writeResult = yield* shell.write({
					sessionId: started.sessionId!,
					ownerId: "test-session",
					chars: "abc\n",
					yieldTimeMs: 250,
					maxOutputTokens: 1_000,
				}).pipe(
					Effect.catch((error: ShellExecutionError) => Effect.succeed(error)),
				);
				yield* shell.shutdownOwner("test-session");
				return writeResult;
			}).pipe(Effect.provide(ShellLive)),
		);

		expect(result).toBeInstanceOf(ShellExecutionError);
		expect("reason" in result ? result.reason : "").toContain(
			"stdin is closed for this session",
		);
	});

	it("rejects writes from another owner", async () => {
		const exit = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* Shell;
				const started = yield* shell.exec({
					file: "bash",
					args: ["-lc", "sleep 1"],
					cwd: process.cwd(),
					env: envRecord(),
					tty: false,
					ownerId: "owner-a",
					yieldTimeMs: 25,
					maxOutputTokens: 1_000,
				});
				expect(started.sessionId).toBeTypeOf("number");
				const result = yield* Effect.exit(
					shell.write({
						sessionId: started.sessionId!,
						ownerId: "owner-b",
						chars: "",
						yieldTimeMs: 0,
						maxOutputTokens: 1_000,
					}),
				);
				yield* shell.shutdownOwner("owner-a");
				return result;
			}).pipe(Effect.provide(ShellLive)),
		);

		expect(exit._tag).toBe("Failure");
		if (exit._tag === "Failure") {
			expect(String(exit.cause)).toContain(ShellExecutionError.name);
		}
	});

	it("kills tracked sessions when the shell layer scope closes", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const shell = yield* Shell;
				return yield* shell.exec({
					file: "bash",
					args: ["-lc", "echo $$; sleep 60"],
					cwd: process.cwd(),
					env: envRecord(),
					tty: false,
					ownerId: "scoped-session",
					yieldTimeMs: 25,
					maxOutputTokens: 1_000,
				});
			}).pipe(Effect.provide(ShellLive)),
		);

		const [pidText] = result.output.trim().split(/\s+/);
		const pid = Number.parseInt(pidText ?? "", 10);

		expect(Number.isInteger(pid)).toBe(true);
		await waitForProcessExit(pid);
		expect(isProcessRunning(pid)).toBe(false);
	});

	it("kills a started command when its exec call is aborted", async () => {
		await withTempDir(async (dir) => {
			const pidPath = path.join(dir, "pid");
			const controller = new AbortController();
			const promise = Effect.runPromise(
				Effect.gen(function* () {
					const shell = yield* Shell;
					return yield* shell.exec({
						file: "bash",
						args: ["-lc", `echo $$ > ${shQuote(pidPath)}; sleep 60`],
						cwd: process.cwd(),
						env: envRecord(),
						tty: false,
						ownerId: "aborted-session",
						yieldTimeMs: 60_000,
						maxOutputTokens: 1_000,
						abortSignal: controller.signal,
					});
				}).pipe(Effect.provide(ShellLive)),
			);

			const pid = await waitForPidFile(pidPath);
			controller.abort();

			await expect(promise).rejects.toThrow();
			await waitForProcessExit(pid);
			expect(isProcessRunning(pid)).toBe(false);
		});
	});
});
