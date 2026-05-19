import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getHomeDir } from "../src/shared/home.js";
import {
	getUserAgentsDir,
	getUserSettingsPath,
	getTauMemoryDir,
} from "../src/shared/discovery.js";

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_TAU_HOME = process.env["TAU_HOME"];
const ORIGINAL_USERPROFILE = process.env["USERPROFILE"];
const ORIGINAL_TAU_SETTINGS = process.env["TAU_SANDBOX_USER_SETTINGS_PATH"];
const ORIGINAL_TAU_MEMORY = process.env["TAU_MEMORY_DIR"];

function restoreOriginal(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

describe("getHomeDir", () => {
	beforeEach(() => {
		// Clear overrides so each test sets the exact env it cares about.
		delete process.env["TAU_HOME"];
		delete process.env["HOME"];
		delete process.env["USERPROFILE"];
	});

	afterEach(() => {
		restoreOriginal("TAU_HOME", ORIGINAL_TAU_HOME);
		restoreOriginal("HOME", ORIGINAL_HOME);
		restoreOriginal("USERPROFILE", ORIGINAL_USERPROFILE);
	});

	it("re-reads process.env.HOME on every call (Bun-cached os.homedir() workaround)", () => {
		process.env["HOME"] = "/tmp/tau-home-a";
		expect(getHomeDir()).toBe("/tmp/tau-home-a");

		process.env["HOME"] = "/tmp/tau-home-b";
		expect(getHomeDir()).toBe("/tmp/tau-home-b");
	});

	it("prefers TAU_HOME over HOME when set", () => {
		process.env["HOME"] = "/tmp/tau-home";
		process.env["TAU_HOME"] = "/tmp/tau-override";
		expect(getHomeDir()).toBe("/tmp/tau-override");
	});

	it("falls back to USERPROFILE on Windows-style env where HOME is unset", () => {
		process.env["USERPROFILE"] = "C:\\Users\\tau";
		expect(getHomeDir()).toBe("C:\\Users\\tau");
	});

	it("falls back to os.homedir() when no env var is set", () => {
		// neither TAU_HOME, HOME, nor USERPROFILE is set in beforeEach.
		const result = getHomeDir();
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
	});

	it("ignores empty-string env values", () => {
		process.env["TAU_HOME"] = "";
		process.env["HOME"] = "/tmp/tau-real-home";
		expect(getHomeDir()).toBe("/tmp/tau-real-home");
	});
});

describe("discovery resolvers honor vi.stubEnv(\"HOME\", ...)", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		restoreOriginal("TAU_SANDBOX_USER_SETTINGS_PATH", ORIGINAL_TAU_SETTINGS);
		restoreOriginal("TAU_MEMORY_DIR", ORIGINAL_TAU_MEMORY);
	});

	it("getUserSettingsPath reflects stubbed HOME", () => {
		// Make sure no per-resolver override is active.
		delete process.env["TAU_SANDBOX_USER_SETTINGS_PATH"];
		vi.stubEnv("HOME", "/tmp/tau-stubbed-home");
		expect(getUserSettingsPath()).toBe("/tmp/tau-stubbed-home/.pi/agent/settings.json");
	});

	it("getUserAgentsDir reflects stubbed HOME", () => {
		vi.stubEnv("HOME", "/tmp/tau-stubbed-home");
		expect(getUserAgentsDir()).toBe("/tmp/tau-stubbed-home/.pi/agent/agents");
	});

	it("getTauMemoryDir reflects stubbed HOME", () => {
		delete process.env["TAU_MEMORY_DIR"];
		vi.stubEnv("HOME", "/tmp/tau-stubbed-home");
		expect(getTauMemoryDir()).toBe("/tmp/tau-stubbed-home/.pi/agent/tau/memories");
	});

	it("explicit TAU_SANDBOX_USER_SETTINGS_PATH override beats stubbed HOME", () => {
		vi.stubEnv("HOME", "/tmp/tau-stubbed-home");
		vi.stubEnv("TAU_SANDBOX_USER_SETTINGS_PATH", "/tmp/explicit/settings.json");
		expect(getUserSettingsPath()).toBe("/tmp/explicit/settings.json");
	});
});
