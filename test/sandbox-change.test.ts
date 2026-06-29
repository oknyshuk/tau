import { describe, expect, it } from "vitest";

import { injectSandboxNoticeIntoMessages } from "../src/sandbox/sandbox-change.js";

type TextBlock = { type: "text"; text: string };

function isTextBlock(value: unknown): value is TextBlock {
	if (typeof value !== "object" || value === null) return false;
	if (!("type" in value) || !("text" in value)) return false;
	const candidate = value as { type: unknown; text: unknown };
	return candidate.type === "text" && typeof candidate.text === "string";
}

function getTextBlocks(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	return content.filter(isTextBlock).map((block) => block.text);
}

describe("sandbox-change", () => {
	it("injectSandboxNoticeIntoMessages: prepends sandbox state notice", () => {
		const messages = [{ role: "user", content: "do thing" }];

		const out = injectSandboxNoticeIntoMessages(
			messages,
			"SANDBOX_STATE: preset=workspace-write subagent=false",
		);
		const textBlocks = getTextBlocks(out[0]?.content);

		expect(textBlocks[0]).toContain("SANDBOX_STATE:");
		expect(textBlocks[1]).toBe("do thing");
	});

	it("injectSandboxNoticeIntoMessages: replaces an existing sandbox notice", () => {
		const messages = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "SANDBOX_STATE: preset=workspace-write subagent=false\n\n",
					},
					{ type: "text", text: "continue" },
				],
			},
		];

		const out = injectSandboxNoticeIntoMessages(
			messages,
			"SANDBOX_CHANGE: preset=full-access subagent=false",
		);
		const textBlocks = getTextBlocks(out[0]?.content);

		expect(textBlocks[0]).toContain("SANDBOX_CHANGE:");
		expect(textBlocks[1]).toBe("continue");
		expect(textBlocks).toHaveLength(2);
	});

	it("injectSandboxNoticeIntoMessages: strips notice prefix when notice and user text share one block", () => {
		const messages = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "SANDBOX_CHANGE: preset=read-only subagent=false\n\nrun tests",
					},
				],
			},
		];

		const out = injectSandboxNoticeIntoMessages(
			messages,
			"SANDBOX_STATE: preset=workspace-write subagent=false",
		);
		const textBlocks = getTextBlocks(out[0]?.content);

		expect(textBlocks[0]).toContain("SANDBOX_STATE:");
		expect(textBlocks[1]).toBe("run tests");
		expect(textBlocks).toHaveLength(2);
	});

	it("injectSandboxNoticeIntoMessages: keeps a single sandbox prefix across repeated calls", () => {
		const messages = [{ role: "user", content: "status" }];
		const once = injectSandboxNoticeIntoMessages(
			messages,
			"SANDBOX_STATE: preset=read-only subagent=false",
		);
		const twice = injectSandboxNoticeIntoMessages(
			once,
			"SANDBOX_STATE: preset=workspace-write subagent=false",
		);
		const textBlocks = getTextBlocks(twice[0]?.content);
		const sandboxHeaders = textBlocks.filter((text) => text.trimStart().startsWith("SANDBOX_"));

		expect(sandboxHeaders).toHaveLength(1);
		expect(sandboxHeaders[0]).toContain("workspace-write");
	});
});
