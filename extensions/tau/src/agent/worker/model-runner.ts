import type { Api, Model } from "@mariozechner/pi-ai";

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
