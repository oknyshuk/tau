export function formatTokenCount(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${(tokens / 1_000_000).toFixed(2).replace(/\.00$/, "")}m`;
}
