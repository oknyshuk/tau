import { Effect, Option } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { SessionCatalogEntry, ThreadInfo } from "./types.js";
import { ThreadAmbiguousError, ThreadCatalogError } from "./errors.js";

// In-memory cache for session catalog entries
const catalogCache = new Map<string, { mtimeMs: number; entry: SessionCatalogEntry }>();

const PREVIEW_LENGTH = 200;

/**
 * Score a session against a query based on multiple factors
 */
function scoreSession(
  session: SessionCatalogEntry,
  query: string,
  cwd: string
): number {
  const lowerQuery = query.toLowerCase();
  const queryTerms = lowerQuery.split(/\s+/).filter((t) => t.length > 0);
  let score = 0;

  // Exact ID match (highest priority)
  if (session.id.toLowerCase() === lowerQuery) {
    score += 1000;
  } else if (session.id.toLowerCase().startsWith(lowerQuery)) {
    score += 500;
  }

  // Name/title match
  if (session.name) {
    const lowerName = session.name.toLowerCase();
    if (lowerName === lowerQuery) {
      score += 400;
    } else if (lowerName.includes(lowerQuery)) {
      score += 200;
    } else {
      // Check individual terms
      const nameMatches = queryTerms.filter((t) => lowerName.includes(t)).length;
      score += nameMatches * 50;
    }
  }

  // First user message match
  const lowerFirstMsg = session.firstUserMessage.toLowerCase();
  if (lowerFirstMsg.includes(lowerQuery)) {
    score += 150;
  } else {
    const firstMsgMatches = queryTerms.filter((t) =>
      lowerFirstMsg.includes(t)
    ).length;
    score += firstMsgMatches * 30;
  }

  // Content match
  const lowerContent = session.allMessagesText.toLowerCase();
  const contentMatches = queryTerms.filter((t) => lowerContent.includes(t)).length;
  score += contentMatches * 10;

  // CWD boost (prefer sessions from current workspace)
  if (session.cwd === cwd) {
    score += 100;
  }

  // Recency boost (more recent = higher score)
  const ageMs = Date.now() - new Date(session.updatedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 1) {
    score += 50;
  } else if (ageDays < 7) {
    score += 25;
  } else if (ageDays < 30) {
    score += 10;
  }

  return score;
}

/**
 * Build a catalog entry from SessionInfo with cached mtime
 */
async function buildCatalogEntry(
  info: SessionInfo,
  mtimeMs: number
): Promise<SessionCatalogEntry> {
  const entry: SessionCatalogEntry = {
    id: info.id,
    path: info.path,
    cwd: info.cwd,
    name: info.name,
    createdAt: info.created.toISOString(),
    updatedAt: info.modified.toISOString(),
    parentSession: info.parentSessionPath,
    messageCount: info.messageCount,
    firstUserMessage: info.firstMessage,
    allMessagesText: info.allMessagesText,
    mtimeMs,
  };
  return entry;
}

/**
 * Get or update cached catalog entry for a session file
 */
async function getCachedOrUpdatedEntry(
  info: SessionInfo
): Promise<SessionCatalogEntry> {
  const cached = catalogCache.get(info.path);

  // Check if file stats have changed
  let stats: { mtimeMs: number };
  try {
    const stat = await fs.stat(info.path);
    stats = { mtimeMs: stat.mtimeMs };
  } catch {
    // If stat fails, use cached version or return as-is
    if (cached) {
      return cached.entry;
    }
    stats = { mtimeMs: info.modified.getTime() };
  }

  if (cached && cached.mtimeMs === stats.mtimeMs) {
    return cached.entry;
  }

  // Build new entry and cache it
  const entry = await buildCatalogEntry(info, stats.mtimeMs);
  catalogCache.set(info.path, { mtimeMs: stats.mtimeMs, entry });
  return entry;
}

/**
 * Build a preview text from session content
 */
function buildPreview(entry: SessionCatalogEntry): string {
  const preview = entry.firstUserMessage.slice(0, PREVIEW_LENGTH);
  return preview.length < entry.firstUserMessage.length
    ? `${preview}...`
    : preview;
}

/**
 * Convert catalog entry to thread info
 */
function toThreadInfo(
  entry: SessionCatalogEntry,
  score: number
): ThreadInfo {
  const info: ThreadInfo = {
    id: entry.id,
    title: entry.name || entry.firstUserMessage.slice(0, 60) || "Untitled",
    path: entry.path,
    cwd: entry.cwd,
    messageCount: entry.messageCount,
    updatedAt: entry.updatedAt,
    createdAt: entry.createdAt,
    parentThreadId: entry.parentSession,
    preview: buildPreview(entry),
    score,
  };
  return info;
}

/**
 * Search sessions in the current workspace
 */
export function searchLocalSessions(
  query: string,
  cwd: string
): Effect.Effect<ReadonlyArray<ThreadInfo>, ThreadCatalogError> {
  return Effect.gen(function* () {
    const sessions = yield* Effect.tryPromise({
      try: () => SessionManager.list(cwd),
      catch: (cause) =>
        new ThreadCatalogError({
          message: `Failed to list local sessions: ${cause}`,
          cause,
        }),
    });

    const entries = yield* Effect.all(
      sessions.map((s) =>
        Effect.tryPromise({
          try: () => getCachedOrUpdatedEntry(s),
          catch: (cause) =>
            new ThreadCatalogError({
              message: `Failed to process session: ${s.path}`,
              cause,
            }),
        })
      ),
      { concurrency: 5 }
    );

    const scored = entries
      .map((entry) => ({
        entry,
        score: scoreSession(entry, query, cwd),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => toThreadInfo(item.entry, item.score));

    return scored;
  });
}

/**
 * Search all sessions globally
 */
export function searchGlobalSessions(
  query: string,
  cwd: string
): Effect.Effect<ReadonlyArray<ThreadInfo>, ThreadCatalogError> {
  return Effect.gen(function* () {
    const sessions = yield* Effect.tryPromise({
      try: () => SessionManager.listAll(),
      catch: (cause) =>
        new ThreadCatalogError({
          message: `Failed to list all sessions: ${cause}`,
          cause,
        }),
    });

    const entries = yield* Effect.all(
      sessions.map((s) =>
        Effect.tryPromise({
          try: () => getCachedOrUpdatedEntry(s),
          catch: (cause) =>
            new ThreadCatalogError({
              message: `Failed to process session: ${s.path}`,
              cause,
            }),
        })
      ),
      { concurrency: 5 }
    );

    const scored = entries
      .map((entry) => ({
        entry,
        score: scoreSession(entry, query, cwd),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => toThreadInfo(item.entry, item.score));

    return scored;
  });
}

/**
 * Find a session by ID (exact match or prefix)
 */
export function findSessionById(
  threadID: string,
  cwd: string
): Effect.Effect<
  Option.Option<SessionCatalogEntry>,
  ThreadCatalogError | ThreadAmbiguousError
> {
  return Effect.gen(function* () {
    const [localSessions, allSessions] = yield* Effect.all([
      Effect.tryPromise({
        try: () => SessionManager.list(cwd),
        catch: (cause) =>
          new ThreadCatalogError({
            message: `Failed to list local sessions: ${cause}`,
            cause,
          }),
      }),
      Effect.tryPromise({
        try: () => SessionManager.listAll(),
        catch: (cause) =>
          new ThreadCatalogError({
            message: `Failed to list all sessions: ${cause}`,
            cause,
          }),
      }),
    ]);

    const lowerId = threadID.toLowerCase();

    // Exact match takes precedence (local first, then global)
    for (const s of localSessions) {
      if (s.id.toLowerCase() === lowerId) {
        const entry = yield* Effect.tryPromise({
          try: () => getCachedOrUpdatedEntry(s),
          catch: (cause) =>
            new ThreadCatalogError({
              message: `Failed to process session: ${s.path}`,
              cause,
            }),
        });
        return Option.some(entry);
      }
    }
    for (const s of allSessions) {
      if (s.id.toLowerCase() === lowerId) {
        const entry = yield* Effect.tryPromise({
          try: () => getCachedOrUpdatedEntry(s),
          catch: (cause) =>
            new ThreadCatalogError({
              message: `Failed to process session: ${s.path}`,
              cause,
            }),
        });
        return Option.some(entry);
      }
    }

    // Collect all prefix matches across local and global
    const localPrefix = localSessions.filter((s) =>
      s.id.toLowerCase().startsWith(lowerId)
    );
    const globalPrefix = allSessions.filter((s) =>
      s.id.toLowerCase().startsWith(lowerId)
    );
    const seenLocal = new Set<string>(localPrefix.map((s) => s.id));
    const allPrefixMatches = [
      ...localPrefix,
      ...globalPrefix.filter((s) => !seenLocal.has(s.id)),
    ];

    if (allPrefixMatches.length === 1) {
      const entry = yield* Effect.tryPromise({
        try: () => getCachedOrUpdatedEntry(allPrefixMatches[0]!),
        catch: (cause) =>
          new ThreadCatalogError({
            message: `Failed to process session: ${allPrefixMatches[0]!.path}`,
            cause,
          }),
      });
      return Option.some(entry);
    }

    if (allPrefixMatches.length > 1) {
      return yield* Effect.fail(
        new ThreadAmbiguousError({
          threadID,
          matches: allPrefixMatches.map((s) => ({ id: s.id, path: s.path })),
        })
      );
    }

    return Option.none();
  });
}

/**
 * Resolve a threadID to a unique session path
 * Returns the resolved path or null if ambiguous/not found
 */
export function resolveThreadPath(
  threadID: string,
  cwd: string
): Effect.Effect<
  Option.Option<{ path: string; entry: SessionCatalogEntry }>,
  ThreadCatalogError | ThreadAmbiguousError
> {
  return Effect.gen(function* () {
    // If it's a path that exists, use it directly
    if (path.isAbsolute(threadID)) {
      try {
        const statResult = yield* Effect.tryPromise({
          try: () => fs.stat(threadID),
          catch: (cause) =>
            new ThreadCatalogError({
              message: `Failed to stat file: ${threadID}`,
              cause,
            }),
        });
        if (statResult.isFile() && threadID.endsWith(".jsonl")) {
          const basename = path.basename(threadID, ".jsonl");
          const id = basename.split("_").pop() || basename;
          const entry: SessionCatalogEntry = {
            id,
            path: threadID,
            cwd,
            name: undefined,
            createdAt: new Date(statResult.birthtime).toISOString(),
            updatedAt: new Date(statResult.mtime).toISOString(),
            parentSession: undefined,
            messageCount: 0,
            firstUserMessage: "",
            allMessagesText: "",
            mtimeMs: statResult.mtimeMs,
          };
          const resolved: { path: string; entry: SessionCatalogEntry } = {
            path: threadID,
            entry,
          };
          return Option.some(resolved);
        }
      } catch {
        // Not a valid path, continue to search
      }
    }

    // Try to find by ID
    const found = yield* findSessionById(threadID, cwd);
    return Option.map(found, (entry) => ({ path: entry.path, entry }));
  });
}
