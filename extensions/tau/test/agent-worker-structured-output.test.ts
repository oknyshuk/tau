import type { Context, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamMock, streamSimpleMock } = vi.hoisted(() => ({
	streamMock: vi.fn(),
	streamSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>(
		"@earendil-works/pi-ai",
	);

	return {
		...actual,
		stream: streamMock,
		streamSimple: streamSimpleMock,
	};
});

import { toolOnlyStreamFn } from "../src/agent/worker.js";

const TEST_CONTEXT: Context = {
	systemPrompt: "System prompt",
	messages: [
		{
			role: "user",
			content: "Return structured output",
			timestamp: 1,
		},
	],
	tools: [
		{
			name: "submit_result",
			description: "Submit structured output",
			parameters: {
				type: "object",
				properties: {
					ok: { type: "boolean" },
				},
				required: ["ok"],
			} as never,
		},
	],
};

const BASE_MODEL = {
	name: "test-model",
	provider: "test-provider",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"] as Array<"text" | "image">,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
};

describe("toolOnlyStreamFn", () => {
	beforeEach(() => {
		streamMock.mockReset();
		streamSimpleMock.mockReset();
	});

	it("forwards the full context unchanged to provider-specific stream functions", () => {
		const sentinel = { kind: "stream" };
		streamMock.mockReturnValue(sentinel);

		const model = {
			...BASE_MODEL,
			id: "kimi-for-coding",
			api: "anthropic-messages",
		} satisfies Model<"anthropic-messages">;

		const result = toolOnlyStreamFn(model, TEST_CONTEXT, { maxTokens: 321 });

		expect(result).toBe(sentinel);
		expect(streamMock).toHaveBeenCalledTimes(1);
		expect(streamMock).toHaveBeenCalledWith(
			model,
			TEST_CONTEXT,
			expect.objectContaining({
				maxTokens: 321,
				thinkingEnabled: false,
				toolChoice: "any",
			}),
		);
	});

	it("preserves generic stream options like onPayload on provider-specific branches", async () => {
		streamMock.mockReturnValue({ kind: "stream" });

		const model = {
			...BASE_MODEL,
			id: "kimi-for-coding",
			api: "anthropic-messages",
		} satisfies Model<"anthropic-messages">;

		const onPayload = vi.fn(async (payload: unknown) => {
			return {
				...(payload as Record<string, unknown>),
				custom: true,
			};
		});

		toolOnlyStreamFn(model, TEST_CONTEXT, {
			maxTokens: 321,
			onPayload,
			transport: "websocket",
			maxRetryDelayMs: 1234,
		});

		const passedOptions = streamMock.mock.calls[0]?.[2] as {
			onPayload?: (payload: unknown, model: Model<"anthropic-messages">) => Promise<unknown>;
			transport?: string;
			maxRetryDelayMs?: number;
		};

		expect(passedOptions.transport).toBe("websocket");
		expect(passedOptions.maxRetryDelayMs).toBe(1234);
		await expect(
			passedOptions.onPayload?.({ original: true }, model),
		).resolves.toEqual({ original: true, custom: true });
		expect(onPayload).toHaveBeenCalledWith({ original: true }, model);
	});

	it("keeps bedrock tool-only calls out of reasoning mode", () => {
		streamMock.mockReturnValue({ kind: "stream" });

		const model = {
			...BASE_MODEL,
			id: "claude-sonnet",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
		} satisfies Model<"bedrock-converse-stream">;

		toolOnlyStreamFn(model, TEST_CONTEXT, {
			reasoning: "high",
			thinkingBudgets: { high: 4096 },
			transport: "websocket",
		});

		const passedOptions = streamMock.mock.calls[0]?.[2] as Record<string, unknown>;
		expect(passedOptions["transport"]).toBe("websocket");
		expect(passedOptions["toolChoice"]).toBe("any");
		expect("reasoning" in passedOptions).toBe(false);
		expect("thinkingBudgets" in passedOptions).toBe(false);
	});

	it("forwards the full context unchanged to streamSimple for response APIs", () => {
		const sentinel = { kind: "stream-simple" };
		streamSimpleMock.mockReturnValue(sentinel);

		const model = {
			...BASE_MODEL,
			id: "gpt-5.4",
			api: "openai-codex-responses",
			provider: "openai-codex",
		} satisfies Model<"openai-codex-responses">;

		const options = { maxTokens: 654, sessionId: "session-123" };
		const result = toolOnlyStreamFn(model, TEST_CONTEXT, options);

		expect(result).toBe(sentinel);
		expect(streamSimpleMock).toHaveBeenCalledTimes(1);
		expect(streamSimpleMock).toHaveBeenCalledWith(
			model,
			TEST_CONTEXT,
			expect.objectContaining({
				maxTokens: 654,
				sessionId: "session-123",
				onPayload: expect.any(Function),
			}),
		);
	});

	it("forces tool_choice required for response APIs while preserving caller payload hooks", async () => {
		streamSimpleMock.mockReturnValue({ kind: "stream-simple" });

		const model = {
			...BASE_MODEL,
			id: "gpt-5.4",
			api: "openai-codex-responses",
			provider: "openai-codex",
		} satisfies Model<"openai-codex-responses">;

		const originalOnPayload = vi.fn(async (payload: unknown) => {
			return {
				...(payload as Record<string, unknown>),
				custom: true,
			};
		});

		toolOnlyStreamFn(model, TEST_CONTEXT, {
			maxTokens: 654,
			sessionId: "session-123",
			onPayload: originalOnPayload,
		});

		const passedOptions = streamSimpleMock.mock.calls[0]?.[2] as {
			onPayload?: (payload: unknown, model: Model<"openai-codex-responses">) => Promise<unknown>;
		};

		await expect(
			passedOptions.onPayload?.({ tools: [{ name: "submit_result" }], existing: true }, model),
		).resolves.toEqual({
			tools: [{ name: "submit_result" }],
			existing: true,
			custom: true,
			tool_choice: "required",
		});
		expect(originalOnPayload).toHaveBeenCalledWith(
			{ tools: [{ name: "submit_result" }], existing: true },
			model,
		);
	});

	it("forces tool_choice required for azure response APIs too", async () => {
		streamSimpleMock.mockReturnValue({ kind: "stream-simple" });

		const model = {
			...BASE_MODEL,
			id: "gpt-5.4",
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
		} satisfies Model<"azure-openai-responses">;

		toolOnlyStreamFn(model, TEST_CONTEXT, {
			sessionId: "azure-session",
		});

		const passedOptions = streamSimpleMock.mock.calls[0]?.[2] as {
			onPayload?: (payload: unknown, model: Model<"azure-openai-responses">) => Promise<unknown>;
		};

		await expect(
			passedOptions.onPayload?.({ tools: [{ name: "submit_result" }] }, model),
		).resolves.toEqual({
			tools: [{ name: "submit_result" }],
			tool_choice: "required",
		});
	});

	it("forces tool choice on mistral conversations too", () => {
		streamSimpleMock.mockReturnValue({ kind: "stream-simple" });

		const model = {
			...BASE_MODEL,
			id: "mistral-large",
			api: "mistral-conversations",
			provider: "mistral",
		} satisfies Model<"mistral-conversations">;

		toolOnlyStreamFn(model, TEST_CONTEXT, {
			sessionId: "mistral-session",
		});

		expect(streamSimpleMock).toHaveBeenCalledWith(
			model,
			TEST_CONTEXT,
			expect.objectContaining({
				sessionId: "mistral-session",
				toolChoice: "required",
			}),
		);
	});
});
