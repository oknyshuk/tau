import { describe, expect, it } from "vitest";

import { rewriteShellToolNames } from "../src/sandbox/mutation-tools.js";

describe("rewriteShellToolNames", () => {
	it("replaces built-in bash with codex-style shell tools", () => {
		expect(rewriteShellToolNames(["read", "bash", "edit"])).toEqual([
			"read",
			"exec_command",
			"write_stdin",
			"edit",
		]);
	});

	it("keeps shell tool activation deduplicated", () => {
		expect(rewriteShellToolNames(["read", "bash", "exec_command", "write_stdin"])).toEqual([
			"read",
			"exec_command",
			"write_stdin",
		]);
	});
});
