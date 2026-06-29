import { describe, expect, it } from "vitest";

import {
	EXEC_COMMAND_TOOL_DESCRIPTION,
	EXEC_COMMAND_TTY_PARAMETER_DESCRIPTION,
	WRITE_STDIN_CHARS_PARAMETER_DESCRIPTION,
	WRITE_STDIN_TOOL_DESCRIPTION,
	formatShellResult,
} from "../src/sandbox/index.js";

describe("sandbox exec tool contract", () => {
	it("uses Codex-like tool descriptions for exec sessions", () => {
		expect(EXEC_COMMAND_TOOL_DESCRIPTION).toContain(
			"returning output or a session ID for ongoing interaction",
		);
		expect(EXEC_COMMAND_TTY_PARAMETER_DESCRIPTION).toContain("Defaults to false (plain pipes)");
		expect(WRITE_STDIN_TOOL_DESCRIPTION).toContain("existing unified exec session");
		expect(WRITE_STDIN_CHARS_PARAMETER_DESCRIPTION).toContain("may be empty to poll");
	});

	it("formats exec results with Codex-like process status text", () => {
		expect(formatShellResult({
			output: "hello\n",
			exitCode: 0,
			wallTimeMs: 123,
		})).toBe("Wall time: 0.1230 seconds\nProcess exited with code 0\nOutput:\nhello\n");

		expect(formatShellResult({
			output: "",
			sessionId: 42,
			wallTimeMs: 250,
		})).toBe("Wall time: 0.2500 seconds\nProcess running with session ID 42\nOutput:\n");
	});
});
