import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

async function withTempDir<A>(fn: (dir: string) => Promise<A>): Promise<A> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-test-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = 0;
	for (;;) {
		idx = haystack.indexOf(needle, idx);
		if (idx === -1) return count;
		count++;
		idx += needle.length;
	}
}

describe("AGENTS.md availability", () => {
	it("is available in agent sessions created for subagents", async () => {
		await withTempDir(async (cwd) => {
			const agentsPath = path.join(cwd, "AGENTS.md");
			await fs.writeFile(agentsPath, "AGENTS_TEST_MARKER\n", "utf8");

			const settingsManager = SettingsManager.inMemory();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: path.join(cwd, ".agent"),
				settingsManager,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			});
			await resourceLoader.reload();

			const { session } = await createAgentSession({
				cwd,
				authStorage: AuthStorage.create(),
				modelRegistry: ModelRegistry.create(AuthStorage.create()),
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
			});

			expect(session.systemPrompt).toBeTypeOf("string");
			expect(countOccurrences(session.systemPrompt, "AGENTS_TEST_MARKER")).toBe(1);
		});
	});
});
