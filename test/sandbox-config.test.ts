import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { computeEffectiveConfig, ensureUserDefaults } from "../src/sandbox/config.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-sandbox-config-"));
}

describe("sandbox-config", () => {
	afterEach(() => {
		delete process.env["TAU_SANDBOX_USER_SETTINGS_PATH"];
	});

	it("fails fast on malformed user settings and does not overwrite file", () => {
		const dir = makeTempDir();
		const settingsPath = path.join(dir, "settings.json");
		const malformed = "{ this is not valid json";
		fs.writeFileSync(settingsPath, malformed, "utf8");
		process.env["TAU_SANDBOX_USER_SETTINGS_PATH"] = settingsPath;

		expect(() => ensureUserDefaults()).toThrow(/Invalid settings JSON/);
		expect(fs.readFileSync(settingsPath, "utf8")).toBe(malformed);

		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("rejects invalid preset in settings", () => {
		const workspaceRoot = makeTempDir();
		const settingsPath = path.join(workspaceRoot, "user-settings.json");
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({
				tau: {
					sandbox: {
						preset: "invalid-preset",
					},
				},
			}),
			"utf8",
		);
		process.env["TAU_SANDBOX_USER_SETTINGS_PATH"] = settingsPath;

		expect(() => computeEffectiveConfig({ workspaceRoot })).toThrow(/Invalid sandbox config/);

		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	});

	it("migrates legacy filesystemMode to nearest preset", () => {
		const workspaceRoot = makeTempDir();
		const settingsPath = path.join(workspaceRoot, "user-settings.json");
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({
				tau: {
					sandbox: {
						filesystemMode: "read-only",
						networkMode: "deny",
						approvalPolicy: "on-request",
					},
				},
			}),
			"utf8",
		);
		process.env["TAU_SANDBOX_USER_SETTINGS_PATH"] = settingsPath;

		const config = computeEffectiveConfig({ workspaceRoot });
		expect(config.preset).toBe("read-only");
		expect(config.filesystemMode).toBe("read-only");
		expect(config.networkMode).toBe("deny");

		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	});

	it("defaults to 'workspace-write' preset", () => {
		const workspaceRoot = makeTempDir();
		const settingsPath = path.join(workspaceRoot, "user-settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({}), "utf8");
		process.env["TAU_SANDBOX_USER_SETTINGS_PATH"] = settingsPath;

		const config = computeEffectiveConfig({ workspaceRoot });
		expect(config.preset).toBe("workspace-write");
		expect(config.filesystemMode).toBe("workspace-write");
		expect(config.networkMode).toBe("deny");
		expect(config.approvalPolicy).toBe("on-request");
		expect(config.approvalTimeoutSeconds).toBe(60);
		expect(config.subagent).toBe(false);

		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	});

	it("session override wins over user settings", () => {
		const workspaceRoot = makeTempDir();
		const settingsPath = path.join(workspaceRoot, "user-settings.json");
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({ tau: { sandbox: { preset: "workspace-write" } } }),
			"utf8",
		);
		process.env["TAU_SANDBOX_USER_SETTINGS_PATH"] = settingsPath;

		const config = computeEffectiveConfig({
			workspaceRoot,
			sessionOverride: { preset: "full-access" },
		});
		expect(config.preset).toBe("full-access");
		expect(config.filesystemMode).toBe("danger-full-access");
		expect(config.networkMode).toBe("allow-all");
		expect(config.approvalPolicy).toBe("never");

		fs.rmSync(workspaceRoot, { recursive: true, force: true });
	});
});
