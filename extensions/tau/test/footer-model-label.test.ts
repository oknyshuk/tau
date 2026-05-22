import { describe, expect, it } from "vitest";

import type { Api, Model } from "@earendil-works/pi-ai";

import { resolveFooterModelLabel } from "../src/services/footer.js";

function makeModel(partial: Partial<Model<Api>>): Model<Api> {
	return {
		id: "test-id",
		name: "Test Name",
		api: "anthropic-messages" as Api,
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 8000,
		...partial,
	} as Model<Api>;
}

describe("resolveFooterModelLabel", () => {
	it("returns 'no-model' for undefined", () => {
		expect(resolveFooterModelLabel(undefined)).toBe("no-model");
	});

	it("prefers Model.name when it differs from Model.id (Bedrock ARN with friendly name)", () => {
		const model = makeModel({
			id: "arn:aws:bedrock:us-east-1:284227543028:application-inference-profile/e4leivbxo36d",
			name: "Claude Opus 4.7",
			provider: "amazon-bedrock",
		});
		expect(resolveFooterModelLabel(model)).toBe("Claude Opus 4.7");
	});

	it("prefers Model.name when it differs from Model.id (built-in providers)", () => {
		const model = makeModel({
			id: "claude-sonnet-4-5-20250929",
			name: "Claude Sonnet 4.5",
		});
		expect(resolveFooterModelLabel(model)).toBe("Claude Sonnet 4.5");
	});

	it("falls back to the tail of an ARN-style id when name === id", () => {
		const arn =
			"arn:aws:bedrock:us-east-1:284227543028:application-inference-profile/e4leivbxo36d";
		const model = makeModel({ id: arn, name: arn });
		expect(resolveFooterModelLabel(model)).toBe("e4leivbxo36d");
	});

	it("falls back to the tail after a slash for provider/model-style ids when name === id", () => {
		const model = makeModel({ id: "openai/gpt-5", name: "openai/gpt-5" });
		expect(resolveFooterModelLabel(model)).toBe("gpt-5");
	});

	it("returns the id unchanged when there is no separator and name === id", () => {
		const model = makeModel({ id: "gpt-5", name: "gpt-5" });
		expect(resolveFooterModelLabel(model)).toBe("gpt-5");
	});

	it("treats an empty name as missing and falls back to the tail of the id", () => {
		const model = makeModel({
			id: "arn:aws:bedrock:us-east-1:284227543028:application-inference-profile/abcdef",
			name: "",
		});
		expect(resolveFooterModelLabel(model)).toBe("abcdef");
	});

	it("preserves a name that just happens to contain a slash", () => {
		const model = makeModel({
			id: "arn:aws:bedrock:us-east-1:1:application-inference-profile/xyz",
			name: "Anthropic / Claude Special",
		});
		expect(resolveFooterModelLabel(model)).toBe("Anthropic / Claude Special");
	});
});
