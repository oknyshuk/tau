import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverWorkspaceRoot } from "../src/sandbox/workspace-root.js";

function makeTempDir(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tau-${prefix}-`)));
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("discoverWorkspaceRoot", () => {
	it("returns the .git-rooted directory when only .git is present", () => {
		const root = makeTempDir("git-only");
		tempDirs.push(root);
		fs.mkdirSync(path.join(root, ".git"));

		const sub = path.join(root, "deep", "deeper");
		fs.mkdirSync(sub, { recursive: true });

		expect(discoverWorkspaceRoot(sub)).toBe(root);
	});

	it("returns the .jj-rooted directory when only .jj is present", () => {
		const root = makeTempDir("jj-only");
		tempDirs.push(root);
		fs.mkdirSync(path.join(root, ".jj"));

		const sub = path.join(root, "src", "nested");
		fs.mkdirSync(sub, { recursive: true });

		expect(discoverWorkspaceRoot(sub)).toBe(root);
	});

	it("prefers .jj over .git when both are present (colocated repo)", () => {
		const root = makeTempDir("colocated");
		tempDirs.push(root);
		fs.mkdirSync(path.join(root, ".jj"));
		fs.mkdirSync(path.join(root, ".git"));

		expect(discoverWorkspaceRoot(root)).toBe(root);
	});

	it("returns the deeper marker if a nested .jj sits below an outer .git", () => {
		const outer = makeTempDir("nested");
		tempDirs.push(outer);
		fs.mkdirSync(path.join(outer, ".git"));
		const inner = path.join(outer, "sub");
		fs.mkdirSync(inner);
		fs.mkdirSync(path.join(inner, ".jj"));

		expect(discoverWorkspaceRoot(inner)).toBe(inner);
	});

	it("returns the cwd unchanged when no VCS marker exists at or above", () => {
		const root = makeTempDir("no-vcs");
		tempDirs.push(root);
		const sub = path.join(root, "x");
		fs.mkdirSync(sub);

		expect(discoverWorkspaceRoot(sub)).toBe(sub);
	});

	it("treats .jj as a file (rare; submodule-style worktree pointer) the same as a directory", () => {
		const root = makeTempDir("jj-file");
		tempDirs.push(root);
		fs.writeFileSync(path.join(root, ".jj"), "gitdir: ../somewhere\n");

		const sub = path.join(root, "x");
		fs.mkdirSync(sub);

		expect(discoverWorkspaceRoot(sub)).toBe(root);
	});

	it("returns the cwd's realpath when no marker is found and cwd is symlinked", () => {
		const real = makeTempDir("symlink-target");
		tempDirs.push(real);
		const link = path.join(os.tmpdir(), `tau-symlink-${path.basename(real)}`);
		fs.symlinkSync(real, link);
		tempDirs.push(link);

		expect(discoverWorkspaceRoot(link)).toBe(real);
	});
});
