import { Effect, Option } from "effect";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import type { ReadThreadResult } from "./types.js";
import { ThreadCatalogError } from "./errors.js";

const MAX_CONTENT_SIZE = 50000; // Characters
const CONTEXT_WINDOW = 3; // Messages before/after a match

function isTextContent(c: unknown): c is TextContent {
  return typeof c === "object" && c !== null && "type" in c && c.type === "text" && "text" in c;
}

function extractTextFromArray(content: ReadonlyArray<unknown>): string {
  return content
    .filter((c): c is TextContent => isTextContent(c))
    .map((c) => c.text)
    .join("\n");
}

/**
 * Extract text content from a message entry
 */
function extractEntryText(entry: SessionEntry): string {
  switch (entry.type) {
    case "message": {
      const msg = entry.message;
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          return msg.content;
        }
        if (Array.isArray(msg.content)) {
          return extractTextFromArray(msg.content);
        }
      } else if (msg.role === "assistant") {
        if (Array.isArray(msg.content)) {
          return extractTextFromArray(msg.content);
        }
      } else if (msg.role === "toolResult") {
        if (Array.isArray(msg.content)) {
          return extractTextFromArray(msg.content);
        }
      }
      return "";
    }
    case "compaction":
      return `[Summary: ${entry.summary}]`;
    case "branch_summary":
      return `[Branch Summary: ${entry.summary}]`;
    default:
      return "";
  }
}

type EntryRole = "user" | "assistant" | "tool_result" | "compaction" | "branch_summary";

/**
 * Get message role for display
 */
function getEntryRole(entry: SessionEntry): EntryRole {
  switch (entry.type) {
    case "message": {
      const msg = entry.message;
      if (msg.role === "user") return "user";
      if (msg.role === "assistant") return "assistant";
      if (msg.role === "toolResult") return "tool_result";
      return "assistant";
    }
    case "compaction":
      return "compaction";
    case "branch_summary":
      return "branch_summary";
    default:
      return "assistant";
  }
}

/**
 * Check if an entry should be included in the transcript
 */
function shouldIncludeEntry(entry: SessionEntry): boolean {
  // Skip internal tau:state entries
  if (entry.type === "custom") {
    return false;
  }
  // Skip hidden custom messages
  if (entry.type === "custom_message" && !entry.display) {
    return false;
  }
  // Skip label entries
  if (entry.type === "label") {
    return false;
  }
  // Skip thinking level and model changes (metadata only)
  if (entry.type === "thinking_level_change" || entry.type === "model_change") {
    return false;
  }
  return true;
}

/**
 * Score entries by relevance to goal
 */
function scoreEntriesByGoal(
  entries: SessionEntry[],
  goal: string
): Map<string, number> {
  const scores = new Map<string, number>();
  const goalTerms = goal.toLowerCase().split(/\s+/).filter((t) => t.length > 2);

  for (const entry of entries) {
    if (!shouldIncludeEntry(entry)) {
      scores.set(entry.id, 0);
      continue;
    }

    const text = extractEntryText(entry).toLowerCase();
    let score = 0;

    // Exact phrase match
    if (text.includes(goal.toLowerCase())) {
      score += 100;
    }

    // Term matches
    for (const term of goalTerms) {
      if (text.includes(term)) {
        score += 10;
      }
    }

    scores.set(entry.id, score);
  }

  return scores;
}

/**
 * Select entries to include based on goal relevance
 */
function selectGoalRelevantEntries(
  entries: SessionEntry[],
  goal: string,
  maxSize: number
): { selected: SessionEntry[]; truncated: boolean } {
  const scores = scoreEntriesByGoal(entries, goal);

  // Sort by score descending
  const scoredEntries = entries
    .filter((e) => shouldIncludeEntry(e))
    .map((e) => ({ entry: e, score: scores.get(e.id) || 0 }))
    .sort((a, b) => b.score - a.score);

  // Always include header (first entry) and recent entries
  const header = entries[0];
  const recentEntries = entries.slice(-5);

  // Select top scoring entries with context
  const selected = new Set<SessionEntry>();
  if (header) selected.add(header);
  for (const r of recentEntries) {
    selected.add(r);
  }

  // Add high-scoring entries with neighbors
  for (const { entry } of scoredEntries.slice(0, 10)) {
    if (selected.has(entry)) continue;

    const index = entries.indexOf(entry);
    if (index === -1) continue;

    // Add entry and neighbors
    selected.add(entry);
    for (let i = 1; i <= CONTEXT_WINDOW; i++) {
      if (index - i >= 0) selected.add(entries[index - i]!);
      if (index + i < entries.length) selected.add(entries[index + i]!);
    }
  }

  // Convert to array and sort by timestamp/original order
  const result = entries.filter((e) => selected.has(e));

  // Check size
  let contentSize = 0;
  for (const entry of result) {
    contentSize += extractEntryText(entry).length;
  }

  if (contentSize > maxSize) {
    // Remove lower-scored entries until under limit
    const ordered = [...result];
    while (contentSize > maxSize && ordered.length > 10) {
      const toRemove = ordered.find((e) => e !== header && !recentEntries.includes(e));
      if (!toRemove) break;
      const idx = ordered.indexOf(toRemove);
      if (idx !== -1) {
        contentSize -= extractEntryText(toRemove).length;
        ordered.splice(idx, 1);
      }
    }
    return { selected: ordered, truncated: true };
  }

  return { selected: result, truncated: false };
}

/**
 * Format entries as markdown transcript
 */
function formatTranscript(entries: SessionEntry[]): string {
  const parts: string[] = [];

  for (const entry of entries) {
    if (!shouldIncludeEntry(entry)) continue;

    const role = getEntryRole(entry);
    const text = extractEntryText(entry).trim();

    if (!text) continue;

    switch (role) {
      case "user":
        parts.push(`**User:** ${text.slice(0, 2000)}${text.length > 2000 ? "..." : ""}`);
        break;
      case "assistant":
        parts.push(`**Assistant:** ${text.slice(0, 2000)}${text.length > 2000 ? "..." : ""}`);
        break;
      case "tool_result":
        // Truncate tool results
        parts.push(`**Tool Result:** ${text.slice(0, 500)}${text.length > 500 ? "..." : ""}`);
        break;
      case "compaction":
      case "branch_summary":
        parts.push(`*${text}*`);
        break;
    }
  }

  return parts.join("\n\n");
}

/**
 * Ensure formatted transcript does not exceed max size
 */
function capTranscript(text: string, maxSize: number, truncated: boolean): { text: string; truncated: boolean } {
  if (text.length <= maxSize) {
    return { text, truncated };
  }
  const trimmed = text.slice(0, maxSize);
  const note = "\n\n[Output truncated due to size limit.]";
  const withNote = trimmed + note;
  return {
    text: withNote.length > maxSize ? trimmed : withNote,
    truncated: true,
  };
}

/**
 * Read a thread's content
 */
export function readThreadContent(
  sessionPath: string,
  goal: Option.Option<string>,
  title: string,
  cwd: string,
  createdAt: string,
  updatedAt: string,
  parentThreadId: string | undefined,
  totalMessages: number
): Effect.Effect<ReadThreadResult, ThreadCatalogError> {
  return Effect.gen(function* () {
    const session = yield* Effect.try({
      try: () => SessionManager.open(sessionPath),
      catch: (cause) =>
        new ThreadCatalogError({
          message: `Failed to open session: ${sessionPath}`,
          cause,
        }),
    });

    const header = session.getHeader();
    if (!header) {
      return yield* new ThreadCatalogError({
        message: `Session has no header: ${sessionPath}`,
      });
    }

    const entries = session.getEntries();
    const filteredEntries = entries.filter(shouldIncludeEntry);

    let selectedEntries: SessionEntry[];
    let truncated: boolean;

    if (Option.isSome(goal) && goal.value.trim()) {
      const result = selectGoalRelevantEntries(
        filteredEntries,
        goal.value,
        MAX_CONTENT_SIZE
      );
      selectedEntries = result.selected;
      truncated = result.truncated;
    } else {
      // Include all entries; if formatted transcript exceeds limit, keep first + recent
      selectedEntries = filteredEntries;
      const fullText = formatTranscript(selectedEntries);
      truncated = fullText.length > MAX_CONTENT_SIZE;
      if (truncated) {
        const firstEntry = selectedEntries[0];
        const recent = selectedEntries.slice(-20);
        selectedEntries = firstEntry ? [firstEntry, ...recent] : recent;
      }
    }

    let content = formatTranscript(selectedEntries);
    const capped = capTranscript(content, MAX_CONTENT_SIZE, truncated);
    content = capped.text;
    truncated = capped.truncated;

    const result: ReadThreadResult = {
      ok: true,
      threadID: header.id,
      resolvedPath: sessionPath,
      title,
      cwd,
      createdAt,
      updatedAt,
      parentThreadId,
      totalMessages,
      includedMessages: selectedEntries.length,
      truncated,
      content,
    };

    return result;
  });
}
