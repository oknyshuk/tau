import type { ContextUsage } from "@earendil-works/pi-coding-agent";

export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

export function shouldDeferAutoresearchResumeUntilAfterCompaction(
	usage: ContextUsage | undefined,
	reserveTokens: number = DEFAULT_COMPACTION_RESERVE_TOKENS,
): boolean {
	if (!usage) return false;
	if (usage.tokens === null) return false;
	return usage.tokens >= usage.contextWindow - reserveTokens;
}
