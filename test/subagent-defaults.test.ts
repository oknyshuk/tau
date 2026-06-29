import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
	resolveSubagentDefaults,
	SubagentDefaultsError,
} from "../src/agent/subagent-defaults.js";

// NOTE: HOME-dependent loader tests are deferred until tau-aqib lands a HOME
// resolver that respects vi.stubEnv under Bun. Until then, the loader is
// covered by integration via worker.ts spawning subagents end-to-end.

describe("subagent defaults resolver", () => {
	const fakeRegistry = {
		getAll: () => [
			{
				id: "claude-sonnet",
				provider: "anthropic",
				name: "Claude Sonnet",
				api: "anthropic-messages",
				input: ["text"],
				contextWindow: 200000,
				maxTokens: 8192,
				cost: { input: 0, output: 0 },
				reasoning: true,
			},
		],
	} as unknown as Parameters<typeof resolveSubagentDefaults>[1];

	it("returns undefined model when defaults.model is unset", async () => {
		const resolved = await Effect.runPromise(
			resolveSubagentDefaults({ thinking: "high" }, fakeRegistry),
		);
		expect(resolved.model).toBeUndefined();
		expect(resolved.thinking).toBe("high");
	});

	it("resolves an exact provider/id match", async () => {
		const resolved = await Effect.runPromise(
			resolveSubagentDefaults({ model: "anthropic/claude-sonnet" }, fakeRegistry),
		);
		expect(resolved.model?.id).toBe("claude-sonnet");
		expect(resolved.model?.provider).toBe("anthropic");
	});

	it("constructs a provider-template model for an unregistered id under a known provider", async () => {
		// resolveModelPattern intentionally accepts ARNs and other ids not in
		// the static registry, falling back to a provider template.
		const resolved = await Effect.runPromise(
			resolveSubagentDefaults({ model: "anthropic/some-arn" }, fakeRegistry),
		);
		expect(resolved.model?.id).toBe("some-arn");
		expect(resolved.model?.provider).toBe("anthropic");
	});

	it("fails fast when the provider is not present in the registry", async () => {
		await expect(
			Effect.runPromise(
				resolveSubagentDefaults(
					{ model: "unknownprovider/anything" },
					fakeRegistry,
				),
			),
		).rejects.toThrowError(SubagentDefaultsError);
	});

	it("propagates the configured thinking level when resolving a model", async () => {
		const resolved = await Effect.runPromise(
			resolveSubagentDefaults(
				{ model: "anthropic/claude-sonnet", thinking: "medium" },
				fakeRegistry,
			),
		);
		expect(resolved.thinking).toBe("medium");
	});
});
