import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";

import { AgentRegistry } from "../src/agent/agent-registry.js";
import { validateResolvedAgentConfiguration } from "../src/agent/startup-validation.js";

function mkdtemp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function validAgentMarkdown(name: string): string {
	return `---
name: ${name}
description: test agent
models:
  - model: inherit
    thinking: inherit
sandbox: read-only
approval_timeout: 60
---

You are ${name}.
`;
}

function writeRequiredBundledAgentModels(tempHome: string, agents: Record<string, unknown> = {}): void {
	writeFile(
		path.join(tempHome, ".pi", "agent", "settings.json"),
		JSON.stringify(
			{
				agents: {
					smart: { models: [{ model: "inherit", thinking: "inherit" }] },
					deep: { models: [{ model: "inherit", thinking: "inherit" }] },
					rush: { models: [{ model: "inherit", thinking: "inherit" }] },
					...agents,
				},
			},
			null,
			2,
		),
	);
}

function runValidation(cwd: string) {
	return Effect.runPromise(
		AgentRegistry.load(cwd).pipe(Effect.flatMap(validateResolvedAgentConfiguration)),
	);
}

describe("agent startup validation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("fails startup when configurable bundled agents do not have model settings", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "settings.json"),
			JSON.stringify(
				{
					agents: {
						deep: { models: [{ model: "inherit", thinking: "inherit" }] },
						rush: { models: [{ model: "inherit", thinking: "inherit" }] },
					},
				},
				null,
				2,
			),
		);

		vi.stubEnv("HOME", tempHome);

		await expect(runValidation(tempProject)).rejects.toThrow(
			'Agent "smart" has no models configured. Set agents.smart.models in ~/.pi/agent/settings.json or .pi/settings.json.',
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("allows startup when user agent markdown files are valid", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "oracle.md"),
			validAgentMarkdown("oracle"),
		);
		writeRequiredBundledAgentModels(tempHome);

		vi.stubEnv("HOME", tempHome);

		await expect(runValidation(tempProject)).resolves.toBeUndefined();

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails startup with corrupted file paths when markdown is invalid", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "broken-one.md"),
			"this file is not valid frontmatter",
		);
		writeFile(
			path.join(tempHome, ".pi", "agent", "agents", "broken-two.md"),
			"---\nname: broken-two\ndescription: broken\n---",
		);

		vi.stubEnv("HOME", tempHome);

		await expect(runValidation(tempProject)).rejects.toThrow("broken-one.md");

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails startup when a bundled agent references unavailable tools", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeRequiredBundledAgentModels(tempHome, {
			deep: {
				models: [{ model: "inherit", thinking: "inherit" }],
				tools: ["read", "imaginary_tool"],
			},
		});

		vi.stubEnv("HOME", tempHome);

		await expect(runValidation(tempProject)).rejects.toThrow(
			'Invalid tools for agent "deep": imaginary_tool',
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("allows startup when a bundled agent uses backlog as its planning tool", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeRequiredBundledAgentModels(tempHome, {
			deep: {
				models: [{ model: "inherit", thinking: "inherit" }],
				tools: ["read", "backlog"],
			},
		});

		vi.stubEnv("HOME", tempHome);

		await expect(runValidation(tempProject)).resolves.toBeUndefined();

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});

	it("fails startup when a bundled agent requests disabled memory tool", async () => {
		const tempHome = mkdtemp("tau-home-");
		const tempProject = mkdtemp("tau-project-");

		writeRequiredBundledAgentModels(tempHome, {
			deep: {
				models: [{ model: "inherit", thinking: "inherit" }],
				tools: ["read", "memory"],
			},
		});

		vi.stubEnv("HOME", tempHome);

		await expect(runValidation(tempProject)).rejects.toThrow(
			'Invalid tools for agent "deep": memory',
		);

		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempProject, { recursive: true, force: true });
	});
});
