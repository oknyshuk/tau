import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai";

import { isRecord } from "../../shared/json.js";

function mergePayloadOverrides(
	payload: unknown,
	overrides: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const base = isRecord(payload) ? payload : {};
	return {
		...base,
		...overrides,
	};
}

function wrapPayloadOverrides(
	existing: SimpleStreamOptions["onPayload"] | undefined,
	overrides: Readonly<Record<string, unknown>>,
): NonNullable<SimpleStreamOptions["onPayload"]> {
	return async (payload, currentModel) => {
		const nextPayload = existing ? await existing(payload, currentModel) : undefined;
		return mergePayloadOverrides(nextPayload === undefined ? payload : nextPayload, overrides);
	};
}

function buildToolOnlyOptions(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
	providerOverrides: Readonly<Record<string, unknown>>,
	payloadOverrides?: Readonly<Record<string, unknown>>,
	omitKeys: ReadonlyArray<keyof SimpleStreamOptions> = [],
): Record<string, unknown> {
	const next: Record<string, unknown> = {
		...options,
		...providerOverrides,
		maxTokens: options?.maxTokens ?? Math.min(model.maxTokens, 32000),
	};

	for (const key of omitKeys) {
		delete next[key];
	}

	if (payloadOverrides !== undefined) {
		next["onPayload"] = wrapPayloadOverrides(options?.onPayload, payloadOverrides);
	}

	return next;
}

export const toolOnlyStreamFn: StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => {
	const api = model.api as string;

	switch (api) {
		case "anthropic-messages":
			return stream(
				model as Model<"anthropic-messages">,
				context,
				buildToolOnlyOptions(model, options, {
					thinkingEnabled: false,
					toolChoice: "any",
				}),
			);
		case "openai-completions":
			return stream(
				model as Model<"openai-completions">,
				context,
				buildToolOnlyOptions(model, options, {
					toolChoice: "required",
				}),
			);
		case "google-generative-ai":
		case "google-vertex":
		case "google-gemini-cli":
			return stream(
				model as Model<"google-generative-ai">,
				context,
				buildToolOnlyOptions(model, options, {
					toolChoice: "any",
					thinking: { enabled: false },
				}),
			);
		case "bedrock-converse-stream":
		case "amazon-bedrock":
			return stream(
				model as Model<"bedrock-converse-stream">,
				context,
				buildToolOnlyOptions(
					model,
					options,
					{
						toolChoice: "any",
					},
					undefined,
					["reasoning", "thinkingBudgets"],
				),
			);
		default:
			return streamSimple(
				model,
				context,
				buildToolOnlyOptions(
					model,
					options,
					api === "mistral-conversations" ? { toolChoice: "required" } : {},
					api === "openai-responses" ||
						api === "openai-codex-responses" ||
						api === "azure-openai-responses"
						? { tool_choice: "required" }
						: undefined,
				) as SimpleStreamOptions,
			);
	}
};

export function resolveModelPattern(pattern: string, models: Model<Api>[]): Model<Api> | undefined {
	const trimmed = pattern.trim();
	if (!trimmed) return undefined;

	const slashIndex = trimmed.indexOf("/");
	if (slashIndex !== -1) {
		const providerInput = trimmed.slice(0, slashIndex).trim();
		const modelIdInput = trimmed.slice(slashIndex + 1).trim();
		if (!providerInput || !modelIdInput) return undefined;

		const provider = providerInput.toLowerCase();
		const modelId = modelIdInput.toLowerCase();
		const match = models.find(
			(m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === modelId,
		);
		if (match) return match;

		const providerTemplate = models.find((m) => m.provider.toLowerCase() === provider);
		if (providerTemplate) {
			return {
				...providerTemplate,
				id: modelIdInput,
				name: modelIdInput,
			};
		}

		return undefined;
	}

	const exact = models.find((m) => m.id.toLowerCase() === trimmed.toLowerCase());
	if (exact) return exact;

	const partial = models.find(
		(m) =>
			m.id.toLowerCase().includes(trimmed.toLowerCase()) ||
			m.name?.toLowerCase().includes(trimmed.toLowerCase()),
	);
	return partial;
}
