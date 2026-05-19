import { afterEach, describe, expect, it, vi } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";

import { AgentRegistry } from "../src/agent/agent-registry.js";
import { computeClampedWorkerSandboxConfig } from "../src/agent/sandbox-policy.js";
import type { ResolvedSandboxConfig } from "../src/sandbox/config.js";

function mkdtemp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

describe("agent sandbox policy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	describe("computeClampedWorkerSandboxConfig", () => {
		it("inherits the parent preset when no sandbox is specified", () => {
			const parentConfig: ResolvedSandboxConfig = {
				preset: "full-access",
				filesystemMode: "danger-full-access",
				networkMode: "allow-all",
				approvalPolicy: "never",
				approvalTimeoutSeconds: 60,
				subagent: false,
			};

			const result = computeClampedWorkerSandboxConfig({
				parent: parentConfig,
			});

			expect(result.preset).toBe("full-access");
			expect(result.subagent).toBe(true);

			const readOnlyParent: ResolvedSandboxConfig = {
				preset: "read-only",
				filesystemMode: "read-only",
				networkMode: "deny",
				approvalPolicy: "on-request",
				approvalTimeoutSeconds: 60,
				subagent: true,
			};

			const clampedResult = computeClampedWorkerSandboxConfig({
				parent: readOnlyParent,
			});

			// Even with the detached worker default, parent restrictions still win.
			expect(clampedResult.preset).toBe("read-only");
		});
	});

	describe("bundled agent sandbox defaults", () => {
		it("bundled writer subagents default to full-access", async () => {
			const tempHome = mkdtemp("tau-home-");
			vi.stubEnv("HOME", tempHome);

			try {
				const registry = await Effect.runPromise(AgentRegistry.load(process.cwd()));

				const smart = registry.resolve("smart");
				const deep = registry.resolve("deep");
				const rush = registry.resolve("rush");

				// Writer subagents (smart, deep, rush) default to full-access so they
				// can drive arbitrary workflows without per-call escalation prompts.
				// Read-only subagents (finder, librarian, oracle, review) keep
				// workspace-write or read-only via their own .md frontmatter.
				expect(smart?.sandbox.preset).toBe("full-access");
				expect(deep?.sandbox.preset).toBe("full-access");
				expect(rush?.sandbox.preset).toBe("full-access");
			} finally {
				fs.rmSync(tempHome, { recursive: true, force: true });
			}
		});
	});
});
