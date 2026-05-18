import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createSkillManageToolDefinition } from "../src/skill-manage/index.js";

function createToolContext(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext;
}

describe("skill_manage tool decoding", () => {
	it("rejects invalid action values at decode boundary", async () => {
		const tool = createSkillManageToolDefinition(async () => {
			throw new Error("runEffect should not execute for invalid params");
		});

		const result = await tool.execute(
			"call-1",
			{ action: "bogus", name: "demo" },
			undefined,
			undefined,
			createToolContext(process.cwd()),
		);

		expect((result.details as { readonly success?: boolean } | undefined)?.success).toBe(false);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Invalid skill_manage params");
	});

	it("accepts decoded action values and runs tool-level validation", async () => {
		const tool = createSkillManageToolDefinition(async () => {
			throw new Error("runEffect should not execute when validation fails");
		});

		const result = await tool.execute(
			"call-2",
			{ action: "create", name: "demo" },
			undefined,
			undefined,
			createToolContext(process.cwd()),
		);

		expect((result.details as { readonly success?: boolean } | undefined)?.success).toBe(false);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toBe("content is required for 'create' action.");
	});
});
