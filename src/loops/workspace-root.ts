import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

function pathExists(candidate: string): boolean {
	try {
		fs.statSync(candidate);
		return true;
	} catch {
		return false;
	}
}

export function resolveLoopWorkspaceRoot(cwd: string): string {
	const start = path.resolve(cwd);
	let current = start;
	const localLoopsRoot =
		current !== os.tmpdir() && pathExists(path.join(current, ".pi", "loops"))
			? current
			: undefined;
	for (;;) {
		if (
			current !== os.tmpdir() &&
			(pathExists(path.join(current, ".git")) ||
				pathExists(path.join(current, ".pi", "settings.json")))
		) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return localLoopsRoot ?? start;
		}
		current = parent;
	}
}

export function resolveLoopWorkspacePath(cwd: string, relativePath: string): string {
	return path.resolve(resolveLoopWorkspaceRoot(cwd), relativePath);
}
