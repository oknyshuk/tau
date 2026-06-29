import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { atomicWriteCalls } = vi.hoisted(() => ({
	atomicWriteCalls: vi.fn<(filePath: string, content: string) => void>(),
}));

vi.mock("../src/shared/atomic-write.js", async () => {
	const actual = await vi.importActual<typeof import("../src/shared/atomic-write.js")>(
		"../src/shared/atomic-write.js",
	);

	return {
		...actual,
		atomicWriteFileStringSync: (filePath: string, content: string) => {
			atomicWriteCalls(filePath, content);
			actual.atomicWriteFileStringSync(filePath, content);
		},
	};
});

import { AgentSelectionStore, getAgentSettingsPath } from "../src/agents-menu/state.js";

async function makeWorkspace(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "tau-agents-settings-atomic-"));
}

describe("agent settings persistence", () => {
	const cleanup = new Set<string>();

	afterEach(async () => {
		atomicWriteCalls.mockReset();
		await Promise.all(
			Array.from(cleanup, (dir) => fs.rm(dir, { recursive: true, force: true })),
		);
		cleanup.clear();
	});

	it("persists settings via shared atomic write helper", async () => {
		const workspace = await makeWorkspace();
		cleanup.add(workspace);
		const settingsPath = getAgentSettingsPath(workspace);

		const store = new AgentSelectionStore();
		await store.activate(workspace, ["finder", "smart"]);
		store.setEnabledForCwd(workspace, "smart", false);

		await store.persistForCwd(workspace, ["finder", "smart"]);

		expect(atomicWriteCalls).toHaveBeenCalledTimes(1);
		expect(atomicWriteCalls).toHaveBeenCalledWith(
			settingsPath,
			expect.stringContaining('"enabled": [\n        "finder"\n      ]'),
		);

		await expect(fs.readFile(settingsPath, "utf8")).resolves.toContain('"finder"');
		await expect(fs.readFile(settingsPath, "utf8")).resolves.not.toContain('"smart"');
	});
});
