import { Effect, Option, Context } from "effect";

import type { BacklogEvent } from "./contract.js";
import type {
	BacklogCacheError,
	BacklogCommandUsageError,
	BacklogContractValidationError,
	BacklogDependencyCycleError,
	BacklogIdGenerationError,
	BacklogIssueNotFoundError,
	BacklogLockError,
	BacklogStorageError,
} from "./errors.js";
import type { Issue, IssueStatus } from "./schema.js";
import type { IssueQuery } from "./query.js";

/**
 * Backlog v4 architecture contract.
 * - Repository service owns event + cache persistence and write locking.
 * - Command service is the only mutation/query facade used by the tool adapter.
 * - Storage layout and command UX parity are hard constraints during migration.
 */
const BACKLOG_COMMAND_SURFACE = [
	"list",
	"show",
	"ready",
	"blocked",
	"create",
	"update",
	"close",
	"reopen",
	"comment",
	"dep",
	"status",
	"search",
] as const;

type BacklogCommandName = (typeof BACKLOG_COMMAND_SURFACE)[number];

const BACKLOG_RUNTIME_BOUNDARY_RULES = Object.freeze({
	runtimeRunnerBoundary: "Only extension and tool adapters may execute backlog effects.",
	storageLayout: "Canonical events stay under .pi/backlog/events/** and cache under .pi/backlog/cache/**.",
	uxParity: "CLI command syntax and rendered output must stay stable during migration.",
});

interface BacklogConfigService {
	readonly workspaceRoot: string;
	readonly eventsRoot: string;
	readonly cacheRoot: string;
	readonly issuesCachePath: string;
}

export class BacklogConfig extends Context.Service<BacklogConfig, BacklogConfigService>()(
	"BacklogConfig",
) {}

interface BacklogRepositoryService {
	readonly readEvents: () => Effect.Effect<
		ReadonlyArray<BacklogEvent>,
		BacklogStorageError | BacklogContractValidationError,
		never
	>;
	readonly appendEvent: (
		event: BacklogEvent,
	) => Effect.Effect<
		void,
		BacklogStorageError | BacklogContractValidationError | BacklogDependencyCycleError,
		never
	>;
	readonly readMaterializedIssues: () => Effect.Effect<
		ReadonlyArray<Issue>,
		BacklogCacheError | BacklogContractValidationError | BacklogStorageError | BacklogDependencyCycleError,
		never
	>;
	readonly writeMaterializedIssues: (
		issues: ReadonlyArray<Issue>,
	) => Effect.Effect<void, BacklogCacheError | BacklogContractValidationError, never>;
	readonly rebuildMaterializedIssues: () => Effect.Effect<
		ReadonlyArray<Issue>,
		BacklogStorageError | BacklogCacheError | BacklogContractValidationError | BacklogDependencyCycleError,
		never
	>;
	readonly withWriteLock: <A, E>(
		effect: Effect.Effect<A, E, never>,
	) => Effect.Effect<A, E | BacklogLockError, never>;
}

export class BacklogRepository extends Context.Service<BacklogRepository, BacklogRepositoryService>()(
	"BacklogRepository",
) {}

export type CreateIssueInput = {
	readonly title: string;
	readonly actor: string;
	readonly id: Option.Option<string>;
	readonly prefix: Option.Option<string>;
	readonly recordedAt: Option.Option<string>;
	readonly fields: Readonly<Record<string, unknown>>;
};

export type UpdateIssueInput = {
	readonly issueId: string;
	readonly actor: string;
	readonly recordedAt: Option.Option<string>;
	readonly setFields: Readonly<Record<string, unknown>>;
	readonly unsetFields: ReadonlyArray<string>;
};

export type SetIssueStatusInput = {
	readonly issueId: string;
	readonly actor: string;
	readonly status: IssueStatus;
	readonly reason: Option.Option<string>;
	readonly recordedAt: Option.Option<string>;
};

export type AddDependencyInput = {
	readonly issueId: string;
	readonly actor: string;
	readonly dependsOnId: string;
	readonly dependencyType: string;
	readonly recordedAt: Option.Option<string>;
};

export type RemoveDependencyInput = {
	readonly issueId: string;
	readonly actor: string;
	readonly dependsOnId: string;
	readonly dependencyType: Option.Option<string>;
	readonly recordedAt: Option.Option<string>;
};

export type AddCommentInput = {
	readonly issueId: string;
	readonly actor: string;
	readonly text: string;
	readonly recordedAt: Option.Option<string>;
};

export type BacklogStatusSummary = {
	readonly total: number;
	readonly open: number;
	readonly inProgress: number;
	readonly closed: number;
	readonly blocked: number;
	readonly ready: number;
	readonly deferred: number;
	readonly pinned: number;
};

export interface BacklogCommandServiceApi {
	readonly create: (input: CreateIssueInput) => Effect.Effect<Issue, BacklogCommandMutationError, never>;
	readonly update: (input: UpdateIssueInput) => Effect.Effect<Issue, BacklogCommandMutationError, never>;
	readonly setStatus: (
		input: SetIssueStatusInput,
	) => Effect.Effect<Issue, BacklogCommandMutationError, never>;
	readonly addDependency: (
		input: AddDependencyInput,
	) => Effect.Effect<Issue, BacklogCommandMutationError, never>;
	readonly removeDependency: (
		input: RemoveDependencyInput,
	) => Effect.Effect<Issue, BacklogCommandMutationError, never>;
	readonly addComment: (input: AddCommentInput) => Effect.Effect<Issue, BacklogCommandMutationError, never>;
	readonly list: (query: IssueQuery) => Effect.Effect<ReadonlyArray<Issue>, BacklogCommandQueryError, never>;
	readonly show: (issueId: string) => Effect.Effect<Issue, BacklogCommandQueryError, never>;
	readonly ready: () => Effect.Effect<ReadonlyArray<Issue>, BacklogCommandQueryError, never>;
	readonly blocked: () => Effect.Effect<ReadonlyArray<Issue>, BacklogCommandQueryError, never>;
	readonly search: (
		text: string,
		limit: Option.Option<number>,
	) => Effect.Effect<ReadonlyArray<Issue>, BacklogCommandQueryError, never>;
	readonly status: () => Effect.Effect<BacklogStatusSummary, BacklogCommandQueryError, never>;
}

export class BacklogCommandService extends Context.Service<
	BacklogCommandService,
	BacklogCommandServiceApi
>()(
	"BacklogCommandService",
) {}

export type BacklogCommandQueryError =
	| BacklogStorageError
	| BacklogCacheError
	| BacklogContractValidationError
	| BacklogDependencyCycleError
	| BacklogIssueNotFoundError
	| BacklogCommandUsageError;

export type BacklogCommandMutationError =
	| BacklogStorageError
	| BacklogCacheError
	| BacklogContractValidationError
	| BacklogIdGenerationError
	| BacklogIssueNotFoundError
	| BacklogDependencyCycleError
	| BacklogLockError
	| BacklogCommandUsageError;
