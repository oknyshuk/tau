import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Determine the workspace root for sandboxing.
 *
 * Walks upward from `cwd` looking for a VCS marker (`.jj` or `.git`). When both
 * exist at the same level (colocated repo), `.jj` wins — jj-vcs is the
 * canonical VCS in this fork. The marker may be a directory or a regular file
 * (e.g. submodule / worktree pointer).
 *
 * Falls back to the canonicalized `cwd` when no marker is found anywhere
 * upward.
 *
 * Notes:
 * - Best-effort; never throws.
 * - Pure filesystem; no spawn, no shell.
 */
export function discoverWorkspaceRoot(cwd: string): string {
	let canonical: string;
	try {
		canonical = fs.realpathSync(cwd);
	} catch {
		canonical = path.resolve(cwd);
	}

	let current = canonical;
	for (;;) {
		if (markerExists(path.join(current, ".jj")) || markerExists(path.join(current, ".git"))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return canonical;
		}
		current = parent;
	}
}

/**
 * Identify the VCS in use at a given workspace root by checking for `.jj` or
 * `.git` markers. `.jj` wins when both are present (colocated repo).
 *
 * Returns `null` when no marker exists at this level.
 */
export function detectVcsAtRoot(workspaceRoot: string): "jj" | "git" | null {
	if (markerExists(path.join(workspaceRoot, ".jj"))) return "jj";
	if (markerExists(path.join(workspaceRoot, ".git"))) return "git";
	return null;
}

function markerExists(candidate: string): boolean {
	try {
		fs.statSync(candidate);
		return true;
	} catch {
		return false;
	}
}
