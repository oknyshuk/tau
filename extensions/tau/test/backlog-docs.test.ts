import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(process.cwd(), "../..");

async function readRepoFile(relativePath: string): Promise<string> {
	return fs.readFile(path.join(repoRoot, relativePath), "utf8");
}

describe("backlog docs", () => {
	it("documents backlog storage and migration in README", async () => {
		const readme = await readRepoFile("README.md");

		expect(readme).toContain(".pi/backlog/events/**");
		expect(readme).toContain(".pi/backlog/cache/**");
		expect(readme).toContain("backlog show <id>");
		expect(readme).not.toContain("extensions/beads");
	});

	it("uses backlog terminology in AGENTS quick reference", async () => {
		const agents = await readRepoFile("AGENTS.md");

		expect(agents).toContain("backlog ready");
		expect(agents).toContain("backlog show <id>");
		expect(agents).toContain("backlog create \"Title\"");
		expect(agents).toContain(".pi/backlog/events/**");
		expect(agents).not.toContain("bd ready");
		expect(agents).not.toContain("bd prime");
	});

	it("uses backlog as the source of truth in bundled skills", async () => {
		const skill = await readRepoFile("extensions/tau/skills/subagent-driven-development/SKILL.md");

		expect(skill).toContain("Backlog is the source of truth");
		expect(skill).toContain("backlog show <id>");
		expect(skill).toContain("backlog update tau-abc123 --status in_progress");
		expect(skill).toContain("backlog close tau-abc123 --reason \"Implemented and reviewed\"");
		expect(skill).not.toContain("bd show <id>");
		expect(skill).not.toContain("Beads is the spec");
	});
});
