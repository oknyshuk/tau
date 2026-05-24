import type { Option } from "effect";

/**
 * Thread information for find_thread results
 */
export interface ThreadInfo {
	readonly id: string;
	readonly title: string;
	readonly path: string;
	readonly cwd: string;
	readonly messageCount: number;
	readonly updatedAt: string;
	readonly createdAt: string;
	readonly parentThreadId: string | undefined;
	readonly preview: string;
	readonly score: number;
}

/**
 * Result of find_thread operation
 */
export interface FindThreadResult {
	readonly ok: true;
	readonly query: string;
	readonly threads: ReadonlyArray<ThreadInfo>;
	readonly hasMore: boolean;
}

/**
 * Thread content block for read_thread
 */
interface ThreadContentBlock {
	readonly type: "user" | "assistant" | "tool_result" | "compaction" | "branch_summary";
	readonly content: string;
	readonly timestamp?: string;
}

/**
 * Result of read_thread operation
 */
export interface ReadThreadResult {
	readonly ok: true;
	readonly threadID: string;
	readonly resolvedPath: string;
	readonly title: string;
	readonly cwd: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly parentThreadId: string | undefined;
	readonly totalMessages: number;
	readonly includedMessages: number;
	readonly truncated: boolean;
	readonly content: string;
}

/**
 * Raw session catalog entry for search indexing
 */
export interface SessionCatalogEntry {
	readonly id: string;
	readonly path: string;
	readonly cwd: string;
	readonly name: string | undefined;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly parentSession: string | undefined;
	readonly messageCount: number;
	readonly firstUserMessage: string;
	readonly allMessagesText: string;
	readonly mtimeMs: number;
}

/**
 * Parameters for find_thread tool
 */
interface FindThreadParams {
	readonly query: string;
}

/**
 * Parameters for read_thread tool
 */
interface ReadThreadParams {
	readonly threadID: string;
	readonly goal?: string;
}

/**
 * Service interface for thread operations
 */
interface ThreadCatalogService {
	readonly find: (
		query: string,
		cwd: string,
	) => Promise<FindThreadResult>;
	readonly read: (
		threadID: string,
		goal: Option.Option<string>,
		cwd: string,
	) => Promise<ReadThreadResult>;
}
