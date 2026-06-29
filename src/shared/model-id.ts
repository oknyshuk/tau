export function isFullyQualifiedModelId(value: string): boolean {
	const idx = value.indexOf("/");
	return idx > 0 && idx < value.length - 1;
}

export function parseProviderModel(
	model: string,
): { readonly provider: string; readonly modelId: string } | undefined {
	const idx = model.indexOf("/");
	if (idx <= 0 || idx >= model.length - 1) {
		return undefined;
	}
	return { provider: model.slice(0, idx), modelId: model.slice(idx + 1) };
}
