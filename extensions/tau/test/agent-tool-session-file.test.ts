import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { AgentControl, type ControlSpawnOptions } from "../src/agent/services.js";
import { createAgentToolDef } from "../src/agent/tool.js";

const TEST_MODEL: Model<Api> = {
	id: "gpt-5.4",
	name: "gpt-5.4",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
};

describe("createAgentToolDef", () => {
	it("forwards parentSessionFile to AgentControl.spawn", async () => {
		const spawnCalls: ControlSpawnOptions[] = [];
		const tool = createAgentToolDef(
			(effect) =>
				Effect.runPromise(
					effect.pipe(
						Effect.provide(
							Layer.succeed(
								AgentControl,
								AgentControl.of({
									spawn: (opts) =>
										Effect.sync(() => {
											spawnCalls.push(opts);
											return "agent-1";
										}),
									send: () => Effect.succeed("submission-1"),
									wait: () => Effect.succeed({ status: {}, timedOut: false }),
									waitStream: () => Stream.empty,
									close: () => Effect.succeed([]),
									closeAll: Effect.void,
									list: Effect.succeed([]),
								}),
							),
						),
					),
				),
			() => ({
				parentSessionFile: "/workspace/.pi/sessions/child.jsonl",
				parentAgentId: undefined,
				parentModel: TEST_MODEL,
				resolveParentExecution: async () => ({
					state: {
						policy: { tools: { kind: "inherit" } },
					},
					profile: {
						model: "openai-codex/gpt-5.4",
						thinking: "medium",
						policy: { tools: { kind: "inherit" } },
					},
				}),
				modelRegistry: {} as unknown as ModelRegistry,
				cwd: "/workspace",
				approvalBroker: undefined,
			}),
			"agent tool",
		);

		await tool.execute(
			"tool-call-1",
			{ action: "spawn", agent: "review", message: "review this" },
			undefined,
			undefined,
			{} as unknown as ExtensionContext,
		);

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.parentSessionFile).toBe("/workspace/.pi/sessions/child.jsonl");
	});
});
