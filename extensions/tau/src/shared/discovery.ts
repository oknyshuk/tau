import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { getHomeDir } from "./home.js";

const EXTENSION_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

export const EXTENSION_AGENTS_DIR = path.join(EXTENSION_ROOT, "agents");

export function getUserSettingsPath(): string {
	const override = process.env["TAU_SANDBOX_USER_SETTINGS_PATH"];
	if (override) return override;
	return path.join(getHomeDir(), ".pi", "agent", "settings.json");
}

export function getUserAgentsDir(): string {
	return path.join(getHomeDir(), ".pi", "agent", "agents");
}

export function getTauMemoryDir(): string {
	const override = process.env["TAU_MEMORY_DIR"];
	if (override) return override;
	return path.join(getHomeDir(), ".pi", "agent", "tau", "memories");
}

function pathExists(candidate: string): boolean {
	try {
		fs.statSync(candidate);
		return true;
	} catch {
		return false;
	}
}

export function findNearestWorkspaceRoot(cwd: string): string {
	const start = path.resolve(cwd);
	let current = path.resolve(cwd);
	for (;;) {
		if (
			pathExists(path.join(current, ".pi", "settings.json")) ||
			pathExists(path.join(current, ".pi", "loops")) ||
			pathExists(path.join(current, ".jj")) ||
			pathExists(path.join(current, ".git"))
		) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return start;
		}
		current = parent;
	}
}

export function getProjectSettingsPath(projectPiDir: string): string {
	return path.join(projectPiDir, "settings.json");
}

function findNearestProjectPiDir(cwd: string): string | null {
	let current = cwd;
	for (;;) {
		const candidate = path.join(current, ".pi");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			// not found at this level
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
