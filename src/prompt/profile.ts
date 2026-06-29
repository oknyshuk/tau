function formatModelId(model: {
	readonly provider: string;
	readonly id: string;
}): string {
	return `${model.provider}/${model.id}`;
}

export function readModelId(
	model:
		| {
				readonly provider: string;
				readonly id: string;
		  }
		| undefined,
): string | undefined {
	if (model === undefined) {
		return undefined;
	}
	return formatModelId(model);
}
