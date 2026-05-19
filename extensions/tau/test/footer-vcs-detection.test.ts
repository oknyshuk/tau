import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectVcsAtRoot, parseJjStatSummary } from "../src/services/footer.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tau-${prefix}-`)));
}

describe("parseJjStatSummary", () => {
	it("parses the summary line of jj diff --stat", () => {
		const out = [
			"AGENTS.md                                    |  2 +-",
			"extensions/tau/src/sandbox/workspace-root.ts | 54 +++++++--------",
			"extensions/tau/test/workspace-root.test.ts   | 93 +++++++++++++++++++++",
			"5 files changed, 126 insertions(+), 26 deletions(-)",
			"",
		].join("\n");

		expect(parseJjStatSummary(out)).toEqual({ added: 126, removed: 26 });
	});

	it("returns zeros for empty output", () => {
		expect(parseJjStatSummary("")).toEqual({ added: 0, removed: 0 });
	});

	it("handles insertions-only summary", () => {
		const out = "1 file changed, 7 insertions(+)\n";
		expect(parseJjStatSummary(out)).toEqual({ added: 7, removed: 0 });
	});

	it("handles deletions-only summary", () => {
		const out = "1 file changed, 4 deletions(-)\n";
		expect(parseJjStatSummary(out)).toEqual({ added: 0, removed: 4 });
	});

	it("handles singular file/insertion/deletion grammar", () => {
		const out = "1 file changed, 1 insertion(+), 1 deletion(-)\n";
		expect(parseJjStatSummary(out)).toEqual({ added: 1, removed: 1 });
	});

	it("ignores trailing blank lines and finds the last summary", () => {
		const out = ["earlier noise", "", "2 files changed, 5 insertions(+), 3 deletions(-)", "", "", ""].join("\n");
		expect(parseJjStatSummary(out)).toEqual({ added: 5, removed: 3 });
	});

	it("returns zeros when output has no summary line", () => {
		expect(parseJjStatSummary("just some unrelated text\n")).toEqual({ added: 0, removed: 0 });
	});
});

describe("detectVcsAtRoot", () => {
	it("returns 'jj' when only .jj is present", () => {
		const root = makeTempDir("vcs-jj");
		tempDirs.push(root);
		fs.mkdirSync(path.join(root, ".jj"));
		expect(detectVcsAtRoot(root)).toBe("jj");
	});

	it("returns 'git' when only .git is present", () => {
		const root = makeTempDir("vcs-git");
		tempDirs.push(root);
		fs.mkdirSync(path.join(root, ".git"));
		expect(detectVcsAtRoot(root)).toBe("git");
	});

	it("prefers 'jj' when both .jj and .git exist (colocated)", () => {
		const root = makeTempDir("vcs-coloc");
		tempDirs.push(root);
		fs.mkdirSync(path.join(root, ".jj"));
		fs.mkdirSync(path.join(root, ".git"));
		expect(detectVcsAtRoot(root)).toBe("jj");
	});

	it("returns null when neither marker exists", () => {
		const root = makeTempDir("vcs-none");
		tempDirs.push(root);
		expect(detectVcsAtRoot(root)).toBeNull();
	});

	it("treats .jj as a regular file (worktree pointer) the same as a directory", () => {
		const root = makeTempDir("vcs-jj-file");
		tempDirs.push(root);
		fs.writeFileSync(path.join(root, ".jj"), "gitdir: ../somewhere\n");
		expect(detectVcsAtRoot(root)).toBe("jj");
	});
});
