// Dream shared prompt builder
// One prompt for both manual (foreground) and auto (background) modes.
// The model uses the existing memory tool for mutations, and dream_finish
// for end-of-run bookkeeping.

import type { MemoryBucketEntriesSnapshot, MemoryEntry, MemoryEntriesSnapshot } from "../memory/format.js";

interface BuildDreamPromptOpts {
	readonly runId: string;
	readonly mode: "manual" | "auto";
	readonly nowIso: string;
	readonly memorySnapshot: MemoryEntriesSnapshot;
}

function formatBucketForPrompt(bucket: MemoryBucketEntriesSnapshot): string {
	const header = `### ${bucket.bucket} (${bucket.chars}/${bucket.limitChars} chars, ${bucket.usagePercent}% used)`;
	if (bucket.entries.length === 0) {
		return `${header}\n  (empty)`;
	}
	// Render compact index (id/scope/type/summary) instead of full content.
	// The model can use `memory read <id>` to fetch full content when needed.
	const lines = bucket.entries.map(
		(e: MemoryEntry) => `  [${e.id}] (scope=${e.scope}, type=${e.type}) ${e.summary}`,
	);
	return `${header}\n${lines.join("\n")}`;
}

function formatMemorySnapshotForPrompt(snapshot: MemoryEntriesSnapshot): string {
	return [
		formatBucketForPrompt(snapshot.project),
		formatBucketForPrompt(snapshot.global),
		formatBucketForPrompt(snapshot.user),
	].join("\n\n");
}

export function buildDreamPrompt(opts: BuildDreamPromptOpts): string {
	const { runId, mode, nowIso, memorySnapshot } = opts;

	const modeNote = mode === "manual"
		? "You are running in the current visible session (foreground mode)."
		: "You are running in a background session (auto mode).";

	const memoryText = formatMemorySnapshotForPrompt(memorySnapshot);

	return `# Dream memory consolidation run: ${runId}
Time: ${nowIso}

${modeNote}

Your job is to curate the existing durable memory index.
You have direct access to tools: \`memory\` (add/update/remove/read) and \`dream_finish\`.

Do not read thread or session transcripts. Work only from the compact memory snapshot below and full memory entries fetched with \`memory read\`.

## Scope limits
- project: 25000 chars (workspace-specific facts)
- global: 25000 chars (cross-project notes)
- user: 25000 chars (who the user is -- preferences, role, habits)

## Scope rules
- project: workspace-specific facts, local commands, repo conventions, local API quirks
- global: cross-project facts, reusable workflow rules, durable environment facts
- user: who the user is -- preferences, role, habits, communication style

## 4-phase procedure

### Phase 1: ORIENT
- Review the memory snapshot below (shows id/scope/type/summary only)
- Use \`memory read <id>\` to fetch the full content of entries you need to evaluate
- Identify duplicates, stale facts, overlap, and misplaced scopes

### Phase 2: CLASSIFY
- Decide whether each questionable entry belongs in project, global, or user memory
- Move misplaced entries to the correct scope by adding the corrected entry and removing the old entry
- Keep scope decisions strict and explicit

### Phase 3: CONSOLIDATE
Mutate memory directly using the \`memory\` tool:
- \`memory add\` -- recreate an entry in the correct scope when moving it
- \`memory update\` -- correct/improve existing entries
- \`memory remove\` -- delete stale, duplicate, or temporary entries

Rules for entries:
- Keep entries compact and factual, not essays
- Respect scope character limits
- Prefer merging related entries over adding duplicates
- Preserve useful facts when correcting scope mistakes

### Phase 4: PRUNE
- Resolve remaining duplicates or overlapping entries
- Remove entries that are entirely obsolete
- Verify scope sizes remain within limits

## What to persist
- User collaboration preferences, habits, role, communication constraints
- Project conventions, API quirks, workflow rules, durable environment facts
- Cross-project durable engineering patterns

## What NOT to persist
- Temporary task state, TODOs, one-off logs
- Session-specific progress snapshots
- Verbose narratives when a compact fact is enough

## Current memory snapshot (compact index -- use \`memory read <id>\` for full content)
${memoryText}

## REQUIRED FINAL ACTION
When done, call \`dream_finish\` with:
{
  "runId": "${runId}",
  "summary": "brief description of what was found and changed",
  "reviewedSessions": [],
  "noChanges": false
}

Always pass an empty reviewedSessions array. Set noChanges to true only if the current memory index needs no consolidation, pruning, or scope corrections.
Do not end without calling dream_finish.`;
}

export { formatMemorySnapshotForPrompt as _formatMemorySnapshotForPrompt };
