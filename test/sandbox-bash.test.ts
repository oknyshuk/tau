import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { wrapCommandWithSandbox } from "../src/sandbox/bash.js";

function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("wrapCommandWithSandbox argv", () => {
	it("does not include duplicate 'bwrap' in args (Node spawn prepends file as argv[0])", async () => {
		const workspaceRoot = makeTempDir("tau-sandbox-argv-");

		const result = await wrapCommandWithSandbox({
			command: "echo hello",
			workspaceRoot,
			filesystemMode: "workspace-write",
			networkMode: "deny",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		// Node.js spawn(file, args) prepends file to argv automatically.
		// args[0] must NOT be "bwrap" — that would create a duplicate entry
		// that bwrap misinterprets as the command to execute.
		expect(result.file).toBe("bwrap");
		expect(result.args[0]).not.toBe("bwrap");
		expect(result.args[0]).toBe("--new-session");
	});
});

describe("wrapCommandWithSandbox mount order", () => {
	it("binds siblings of .pi/loops/tasks as read-only and tasks as writable", async () => {
		const workspaceRoot = makeTempDir("tau-sandbox-bwrap-");
		fs.mkdirSync(path.join(workspaceRoot, ".pi", "loops", "tasks"), { recursive: true });
		fs.writeFileSync(path.join(workspaceRoot, ".pi", "settings.json"), "{}", "utf-8");

		const result = await wrapCommandWithSandbox({
			command: "echo hello",
			workspaceRoot,
			filesystemMode: "workspace-write",
			networkMode: "deny",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const parts = result.args;
		const settingsPath = path.join(workspaceRoot, ".pi", "settings.json");
		const tasksPath = path.join(workspaceRoot, ".pi", "loops", "tasks");

		function findRoBindIndex(targetPath: string): number {
			for (let i = 0; i < parts.length - 1; i++) {
				if (parts[i] === "--ro-bind" && parts[i + 1] === targetPath) {
					return i;
				}
			}
			return -1;
		}

		function findBindIndex(targetPath: string): number {
			for (let i = 0; i < parts.length - 1; i++) {
				if (parts[i] === "--bind" && parts[i + 1] === targetPath) {
					return i;
				}
			}
			return -1;
		}

		const settingsRoBindIndex = findRoBindIndex(settingsPath);
		const tasksBindIndex = findBindIndex(tasksPath);

		expect(settingsRoBindIndex).toBeGreaterThan(-1);
		expect(tasksBindIndex).toBeGreaterThan(-1);
		expect(tasksBindIndex).toBeGreaterThan(settingsRoBindIndex);
	});

	it("ro-binds .pi as a whole when the writable exception does not exist yet", async () => {
		const workspaceRoot = makeTempDir("tau-sandbox-bwrap-");
		fs.mkdirSync(path.join(workspaceRoot, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(workspaceRoot, ".pi", "settings.json"), "{}", "utf-8");

		const result = await wrapCommandWithSandbox({
			command: "echo hello",
			workspaceRoot,
			filesystemMode: "workspace-write",
			networkMode: "deny",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const parts = result.args;
		const tasksPath = path.join(workspaceRoot, ".pi", "loops", "tasks");
		const piPath = path.join(workspaceRoot, ".pi");
		const tasksBindIndex = parts.indexOf(tasksPath);

		function findRoBindIndex(targetPath: string): number {
			for (let i = 0; i < parts.length - 1; i++) {
				if (parts[i] === "--ro-bind" && parts[i + 1] === targetPath) {
					return i;
				}
			}
			return -1;
		}

		expect(tasksBindIndex).toBe(-1);
		expect(findRoBindIndex(piPath)).toBeGreaterThan(-1);
	});

	it("binds the home parent read-only before the writable workspace", async () => {
		const workspaceRoot = makeTempDir("tau-sandbox-bwrap-");

		const result = await wrapCommandWithSandbox({
			command: "echo hello",
			workspaceRoot,
			filesystemMode: "workspace-write",
			networkMode: "deny",
		});

		expect(result.success).toBe(true);
		if (!result.success) return;

		const parts = result.args;
		const homeParent = path.dirname(os.homedir());

		function findMountIndex(flag: "--bind" | "--ro-bind", targetPath: string): number {
			for (let i = 0; i < parts.length - 1; i++) {
				if (parts[i] === flag && parts[i + 1] === targetPath) {
					return i;
				}
			}
			return -1;
		}

		const homeParentRoBindIndex = findMountIndex("--ro-bind", homeParent);
		const workspaceBindIndex = findMountIndex("--bind", workspaceRoot);

		expect(homeParentRoBindIndex).toBeGreaterThan(-1);
		expect(workspaceBindIndex).toBeGreaterThan(homeParentRoBindIndex);
	});
});
