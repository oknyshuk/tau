import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { createExaToolDefinitions } from "../src/exa/index.js";

function createToolContext(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext;
}

describe("exa tool param decoding", () => {
	it("rejects empty search query before execution", async () => {
		const tool = createExaToolDefinitions().find((candidate) => candidate.name === "web_search_exa");
		expect(tool).toBeDefined();

		const result = await tool!.execute(
			"call-1",
			{ query: "" },
			undefined,
			undefined,
			createToolContext(process.cwd()),
		);

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Invalid web_search_exa params");
		expect(text).not.toContain("EXA_API_KEY is not set");
		expect(result.details).toEqual({ results: [] });
	});

	it("rejects numResults outside TypeBox bounds", async () => {
		const tool = createExaToolDefinitions().find((candidate) => candidate.name === "web_search_exa");
		expect(tool).toBeDefined();

		const result = await tool!.execute(
			"call-2",
			{ query: "effect", numResults: 101 },
			undefined,
			undefined,
			createToolContext(process.cwd()),
		);

		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Invalid web_search_exa params");
		expect(result.details).toEqual({ results: [] });
	});
});
