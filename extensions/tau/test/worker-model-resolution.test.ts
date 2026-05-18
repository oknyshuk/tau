import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveModelPattern } from "../src/agent/worker.js";

const antigravityTemplate: Model<Api> = {
	id: "gemini-3-pro-high",
	name: "Gemini 3 Pro High",
	api: "google-generative-ai",
	provider: "google-antigravity",
	baseUrl: "https://api.google.com",
	reasoning: true,
	input: ["text", "image"],
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	},
	contextWindow: 1_048_576,
	maxTokens: 65_536,
};

describe("resolveModelPattern", () => {
	it("builds a model from provider template for unknown fully-qualified ids", () => {
		const resolved = resolveModelPattern("google-antigravity/gemini-3.1-pro-high", [
			antigravityTemplate,
		]);

		expect(resolved).toBeDefined();
		expect(resolved).not.toBe(antigravityTemplate);
		expect(resolved).toMatchObject({
			provider: "google-antigravity",
			id: "gemini-3.1-pro-high",
			name: "gemini-3.1-pro-high",
			api: "google-generative-ai",
			baseUrl: "https://api.google.com",
		});
	});

	it("returns undefined for fully-qualified patterns when provider is unknown", () => {
		const resolved = resolveModelPattern("unknown-provider/gemini-3.1-pro-high", [
			antigravityTemplate,
		]);
		expect(resolved).toBeUndefined();
	});
});
