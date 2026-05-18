import type { Theme } from "@earendil-works/pi-coding-agent";
import type { FindThreadResult, ReadThreadResult, ThreadInfo } from "./types.js";

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

const formatRelativeTime = (dateStr: string): string => {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
};


// =============================================================================
// find_thread renderer
// =============================================================================

export const renderFindThreadCall = (args: unknown, theme: Theme): string => {
  const typedArgs = args as { query?: string };
  const query = typedArgs.query ?? "";
  let out = theme.fg("toolTitle", "find_thread");
  if (query) out += ` ${theme.fg("toolOutput", truncate(oneLine(query), 140))}`;
  return out;
};

const formatThreadPreview = (thread: ThreadInfo, index: number, theme: Theme): string => {
  const title = thread.title || "Untitled";
  const meta = [
    `${thread.messageCount} messages`,
    formatRelativeTime(thread.updatedAt),
    thread.cwd,
  ].join(" · ");

  let out = `  ${theme.fg("accent", `${index + 1}.`)} ${theme.fg("toolOutput", truncate(oneLine(title), 160))}`;
  out += `\n     ${theme.fg("dim", thread.id)}`;
  out += `\n     ${theme.fg("muted", meta)}`;

  if (thread.preview) {
    out += `\n     ${theme.fg("dim", truncate(oneLine(thread.preview), 200))}`;
  }

  return out;
};

export const renderFindThreadResult = (
  result: FindThreadResult,
  expanded: boolean,
  theme: Theme
): string => {
  const separator =
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

  let out = theme.fg("dim", separator);
  out += `\n${theme.fg("muted", "Query:")} ${theme.fg("toolOutput", result.query)}`;
  out += `\n${theme.fg("muted", "Results:")} ${result.threads.length}${result.hasMore ? "+" : ""}`;

  const threads = expanded ? result.threads : result.threads.slice(0, 5);

  for (let i = 0; i < threads.length; i++) {
    out += "\n\n" + formatThreadPreview(threads[i]!, i, theme);
  }

  if (!expanded && result.threads.length > threads.length) {
    out += `\n\n  ${theme.fg("dim", `… ${result.threads.length - threads.length} more (expand to view)`)}`;
  }

  if (result.threads.length === 0) {
    out += `\n\n  ${theme.fg("dim", "(no matching threads found)")}`;
  }

  return out;
};

// =============================================================================
// read_thread renderer
// =============================================================================

export const renderReadThreadCall = (args: unknown, theme: Theme): string => {
  const typedArgs = args as { threadID?: string; goal?: string };
  const threadID = typedArgs.threadID ?? "";
  const goal = typedArgs.goal;

  let out = theme.fg("toolTitle", "read_thread");
  if (threadID) out += ` ${theme.fg("dim", truncate(threadID, 40))}`;
  if (goal) out += `\n${theme.fg("muted", "goal:")} ${theme.fg("dim", truncate(oneLine(goal), 140))}`;

  return out;
};

export const renderReadThreadResult = (
  result: ReadThreadResult,
  expanded: boolean,
  theme: Theme
): string => {
  const separator =
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

  let out = theme.fg("dim", separator);

  // Header info
  out += `\n${theme.fg("muted", "Thread:")} ${theme.fg("toolOutput", result.title)}`;
  out += `\n${theme.fg("muted", "ID:")} ${theme.fg("dim", result.threadID)}`;
  out += `\n${theme.fg("muted", "CWD:")} ${theme.fg("dim", result.cwd)}`;
  out += `\n${theme.fg("muted", "Messages:")} ${result.includedMessages}/${result.totalMessages}${result.truncated ? " (truncated)" : ""}`;
  out += `\n${theme.fg("muted", "Updated:")} ${formatRelativeTime(result.updatedAt)}`;

  if (result.parentThreadId) {
    out += `\n${theme.fg("muted", "Parent:")} ${theme.fg("dim", result.parentThreadId)}`;
  }

  out += "\n" + theme.fg("dim", separator);

  // Content
  if (expanded) {
    out += "\n\n" + result.content;
  } else {
    const lines = result.content.split("\n");
    const head = lines.slice(0, 30).join("\n");
    out += "\n\n" + head;
    if (lines.length > 30) {
      out += `\n\n${theme.fg("dim", "… (expand to view full transcript)")}`;
    }
  }

  if (result.truncated) {
    out += `\n\n${theme.fg("warning", "Note: Content was truncated. Use a more specific goal to see relevant sections.")}`;
  }

  return out;
};
