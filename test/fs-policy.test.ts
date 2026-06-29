import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { checkWriteAllowed } from "../src/sandbox/fs-policy.js";

const createdDirs: string[] = [];

function makeTempDir(prefix: string, baseDir?: string): string {
	const dir = fs.mkdtempSync(path.join(baseDir ?? os.tmpdir(), prefix));
	createdDirs.push(dir);
	return dir;
}

function expectDenied(
	result: ReturnType<typeof checkWriteAllowed>,
	expectedReasonPart: string,
): void {
	expect(result.allowed).toBe(false);
	if (result.allowed) {
		throw new Error("Expected denied result");
	}
	expect(result.reason).toContain(expectedReasonPart);
}

afterEach(() => {
	for (const dir of createdDirs.splice(0, createdDirs.length)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("checkWriteAllowed symlink hardening", () => {
	it("denies workspace symlink traversal outside workspace", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const outsideRoot = makeTempDir("tau-fs-outside-");
		const escapeLink = path.join(workspaceRoot, "escape");
		fs.symlinkSync(outsideRoot, escapeLink);

		const result = checkWriteAllowed({
			targetPath: path.join(escapeLink, "nested", "file.txt"),
			cwd: workspaceRoot,
			workspaceRoot,
			filesystemMode: "workspace-write",
		});

		expectDenied(result, "resolves outside workspace root");
	});

	it("allows workspace symlink traversal that stays inside workspace", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const safeDir = path.join(workspaceRoot, "safe");
		fs.mkdirSync(safeDir, { recursive: true });
		const safeLink = path.join(workspaceRoot, "safe-link");
		fs.symlinkSync(safeDir, safeLink);

		const result = checkWriteAllowed({
			targetPath: path.join(safeLink, "new-file.txt"),
			cwd: workspaceRoot,
			workspaceRoot,
			filesystemMode: "workspace-write",
		});

		expect(result).toEqual({ allowed: true });
	});

	it("denies read-only writes through temp symlink escaping allowed roots", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const tempRoot = makeTempDir("tau-fs-temp-");
		const outsideRoot = makeTempDir("tau-fs-nontemp-", process.cwd());
		const escapeLink = path.join(tempRoot, "escape");
		fs.symlinkSync(outsideRoot, escapeLink);

		const result = checkWriteAllowed({
			targetPath: path.join(escapeLink, "file.txt"),
			cwd: workspaceRoot,
			workspaceRoot,
			filesystemMode: "read-only",
		});

		expectDenied(result, "resolves outside allowed writable roots");
	});

	it("denies .git writes through workspace symlink with missing descendants", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const gitDir = path.join(workspaceRoot, ".git");
		fs.mkdirSync(gitDir, { recursive: true });
		const gitLink = path.join(workspaceRoot, "git-link");
		fs.symlinkSync(gitDir, gitLink);

		const result = checkWriteAllowed({
			targetPath: path.join(gitLink, "objects", "new-object"),
			cwd: workspaceRoot,
			workspaceRoot,
			filesystemMode: "workspace-write",
		});

		expectDenied(result, "Write to .git/");
	});

	it("allows read-only writes to regular temp paths", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const tempRoot = makeTempDir("tau-fs-temp-");

		const result = checkWriteAllowed({
			targetPath: path.join(tempRoot, "regular-file.txt"),
			cwd: workspaceRoot,
			workspaceRoot,
			filesystemMode: "read-only",
		});

		expect(result).toEqual({ allowed: true });
	});
});

describe("checkWriteAllowed workspace protected path policy", () => {
	it("allows writes to .pi/loops/tasks", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const tasksDir = path.join(workspaceRoot, ".pi", "loops", "tasks");
		fs.mkdirSync(tasksDir, { recursive: true });

		const result = checkWriteAllowed({
			targetPath: path.join(tasksDir, "loop.md"),
			cwd: workspaceRoot,
			workspaceRoot,
			filesystemMode: "workspace-write",
		});

		expect(result).toEqual({ allowed: true });
	});

	it("denies writes to .pi/loops/state", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const stateDir = path.join(workspaceRoot, ".pi", "loops", "state");
		fs.mkdirSync(stateDir, { recursive: true });

		const result = checkWriteAllowed({
			targetPath: path.join(stateDir, "loop.state.json"),
			cwd: workspaceRoot,
			workspaceRoot,
			filesystemMode: "workspace-write",
		});

		expectDenied(result, "protected workspace metadata under .pi/");
	});

	it("denies writes to .pi/backlog", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const backlogDir = path.join(workspaceRoot, ".pi", "backlog");
		fs.mkdirSync(backlogDir, { recursive: true });

		const result = checkWriteAllowed({
			targetPath: path.join(backlogDir, "events", "issue.json"),
			cwd: workspaceRoot,
			workspaceRoot,
			filesystemMode: "workspace-write",
		});

		expectDenied(result, "protected workspace metadata under .pi/");
	});

	it("denies writes to .pi/settings.json", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const piDir = path.join(workspaceRoot, ".pi");
		fs.mkdirSync(piDir, { recursive: true });

		const result = checkWriteAllowed({
			targetPath: path.join(piDir, "settings.json"),
			cwd: workspaceRoot,
			workspaceRoot,
			filesystemMode: "workspace-write",
		});

		expectDenied(result, "protected workspace metadata under .pi/");
	});

	it("denies .pi/loops/tasks symlink traversal into protected state", () => {
		const workspaceRoot = makeTempDir("tau-fs-workspace-");
		const tasksDir = path.join(workspaceRoot, ".pi", "loops", "tasks");
		const stateDir = path.join(workspaceRoot, ".pi", "loops", "state");
		fs.mkdirSync(tasksDir, { recursive: true });
		fs.mkdirSync(stateDir, { recursive: true });

		const escapeLink = path.join(tasksDir, "escape");
		fs.symlinkSync(stateDir, escapeLink);

		const result = checkWriteAllowed({
			targetPath: path.join(escapeLink, "loop.state.json"),
			cwd: workspaceRoot,
			workspaceRoot,
			filesystemMode: "workspace-write",
		});

		expectDenied(result, "protected workspace metadata under .pi/");
	});
});
