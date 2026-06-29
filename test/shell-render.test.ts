import { describe, expect, it } from "vitest";

import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";

import { renderShellCall, renderShellResult } from "../src/sandbox/shell-render.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function normalizeRendered(text: Text): string {
	return text
		.render(240)
		.map((line) => line.trimEnd())
		.join("\n");
}

function renderResult(
	result: unknown,
	options: ToolRenderResultOptions = { expanded: false, isPartial: false },
): string {
	return normalizeRendered(renderShellResult(result, options, plainTheme));
}

describe("shell renderer", () => {
	it("renders an in-flight exec_command call and clears it once final", () => {
		const inflight = normalizeRendered(renderShellCall({
			cmd: "printf 'hello'",
			workdir: "/tmp/project",
			tty: true,
		}, plainTheme));

		expect(inflight).toContain("exec_command");
		expect(inflight).toContain("printf 'hello'");
		expect(inflight).toContain("running…");

		const final = normalizeRendered(
			renderShellCall({ cmd: "printf 'hello'" }, plainTheme, { isPartial: false }),
		);
		expect(final).toBe("");
	});

	it("renders an in-flight poll call so long polls aren't invisible", () => {
		const inflight = normalizeRendered(
			renderShellCall({ session_id: 39 }, plainTheme, { isPartial: true }),
		);

		expect(inflight).toContain("poll");
		expect(inflight).toContain("session 39");
		expect(inflight).toContain("waiting for output…");
	});

	it("renders compact and expanded exec_command results for Ctrl+O", () => {
		const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
		const result = {
			content: [{ type: "text", text: output }],
			details: {
				kind: "exec_command",
				command: "for i in {1..20}; do echo line $i; done",
				output,
				exitCode: 0,
			},
		};

		const compact = renderResult(result, { expanded: false, isPartial: false });
		const expanded = renderResult(result, { expanded: true, isPartial: false });

		expect(compact).toContain("✓ exec_command · for i in {1..20}; do echo line $i; done");
		expect(compact).toContain("exit: 0");
		expect(compact).toContain("\n\n  ");
		expect(compact).toContain("earlier lines");
		expect(compact).toContain("line 20");
		expect(`\n${compact}\n`).not.toContain("\nline 1\n");
		expect(expanded).toContain("line 1");
		expect(expanded).toContain("line 20");
	});

	it("renders write_stdin session output with written character count", () => {
		const rendered = renderResult({
			content: [{ type: "text", text: "got input" }],
			details: {
				kind: "write_stdin",
				output: "got input",
				sessionId: 7,
				writtenChars: 4,
			},
		});

		expect(rendered).toContain("↪ stdin · session 7");
		expect(rendered).toContain("session: 7");
		expect(rendered).toContain("wrote: 4 chars");
		expect(rendered).toContain("got input");
	});

	it("renders empty write_stdin calls as polling", () => {
		const rendered = renderResult({
			content: [{ type: "text", text: "" }],
			details: {
				kind: "write_stdin",
				output: "",
				sessionId: 39,
				writtenChars: 0,
				writtenText: "",
			},
		});

		expect(rendered).toContain("↪ poll · session 39");
		expect(rendered).toContain("session: 39");
		expect(rendered).not.toContain("wrote:");
		expect(rendered).toContain("(still running; no new output)");
		expect(rendered).not.toContain("(no output)");
	});

	it("renders compact and expanded poll results for Ctrl+O", () => {
		const output = `prefix ${"x".repeat(500)} suffix`;
		const result = {
			content: [{ type: "text", text: output }],
			details: {
				kind: "write_stdin",
				output,
				exitCode: 0,
				writtenChars: 0,
				writtenText: "",
			},
		};

		const compact = renderResult(result, { expanded: false, isPartial: false });
		const expanded = renderResult(result, { expanded: true, isPartial: false });

		expect(compact).toContain("✓ poll · no input");
		expect(compact).toContain("exit: 0");
		expect(compact).toContain("prefix");
		expect(compact).toContain("…");
		expect(compact).not.toContain("suffix");
		expect(expanded).toContain("suffix");
	});

	it("hides echoed TTY input in compact write_stdin results", () => {
		const rendered = renderResult({
			content: [{ type: "text", text: "echo hi\r\nhi\r\n$ " }],
			details: {
				kind: "write_stdin",
				output: "echo hi\r\nhi\r\n$ ",
				sessionId: 8,
				writtenChars: 8,
				writtenText: "echo hi\r",
			},
		});

		expect(rendered).toContain("hi");
		expect(`\n${rendered}\n`).not.toContain("\n  echo hi\n");
	});
});
