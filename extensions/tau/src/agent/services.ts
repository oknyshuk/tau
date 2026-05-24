import { Context, Data, Effect, Stream } from "effect";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentId, AgentDefinition } from "./types.js";
import type { Status } from "./status.js";
export type { Status };
import type { ResolvedSandboxConfig } from "../sandbox/config.js";
import type { ApprovalBroker } from "./approval-broker.js";
import type { ExecutionProfile, ExecutionSessionState } from "../execution/schema.js";

export interface ParentExecutionContext {
	readonly state: ExecutionSessionState;
	readonly profile: ExecutionProfile;
}

// Error Types
export class AgentNotFound extends Data.TaggedError("AgentNotFound")<{
	readonly id: AgentId;
}> {}
export class AgentAccessDenied extends Data.TaggedError("AgentAccessDenied")<{
	readonly id: AgentId;
	readonly requesterId: AgentId;
	readonly parentId: AgentId;
}> {}
export class AgentLimitReached extends Data.TaggedError("AgentLimitReached")<{
	readonly max: number;
}> {}
export class AgentDepthExceeded extends Data.TaggedError("AgentDepthExceeded")<{
	readonly max: number;
}> {}
export class AgentSpawnRestricted extends Data.TaggedError("AgentSpawnRestricted")<{
	readonly parentId: AgentId;
	readonly parentType: string;
	readonly requestedAgent: string;
	readonly allowedSpawns: readonly string[];
}> {}
export class AgentError extends Data.TaggedError("AgentError")<{
	readonly message: string;
}> {}

// Config
interface AgentConfigService {
	readonly maxThreads: number;
	readonly maxDepth: number;
}

export class AgentConfig extends Context.Service<AgentConfig, AgentConfigService>()(
	"AgentConfig",
) {}

// Agent Info
export interface AgentInfo {
	readonly id: AgentId;
	readonly type: string;
	readonly status: Status;
	readonly parentAgentId?: AgentId | undefined;
}

// Agent Worker Interface
export interface Agent {
	readonly id: AgentId;
	readonly type: string;
	readonly depth: number;
	readonly definition: AgentDefinition;
	readonly prompt: (message: string) => Effect.Effect<string, AgentError>; // returns submission_id
	readonly interrupt: () => Effect.Effect<void>;
	readonly shutdown: () => Effect.Effect<void>;
	readonly status: Effect.Effect<Status>;
	readonly subscribeStatus: () => Stream.Stream<Status>;
}

// Agent Manager
export interface SpawnOptions {
	readonly definition: AgentDefinition;
	readonly message: string;
	readonly depth: number;
	readonly cwd: string;
	readonly parentSessionFile: string | undefined;
	readonly executionState: ExecutionSessionState;
	readonly executionProfile: ExecutionProfile;
	readonly parentAgentId?: AgentId | undefined;
	readonly parentSandboxConfig: ResolvedSandboxConfig;
	readonly parentModel?: Model<Api> | undefined;
	readonly approvalBroker?: ApprovalBroker | undefined;
	readonly modelRegistry?: ModelRegistry | undefined;
	readonly resultSchema?: unknown;
	readonly agentSummaries?: ReadonlyArray<{
		readonly name: string;
		readonly description: string;
	}>;
}

export class AgentManager extends Context.Service<
	AgentManager,
	{
		readonly spawn: (
			opts: SpawnOptions,
		) => Effect.Effect<
			AgentId,
			AgentLimitReached | AgentDepthExceeded | AgentSpawnRestricted | AgentError
		>;
		readonly get: (id: AgentId) => Effect.Effect<Agent, AgentNotFound>;
		readonly touch: (id: AgentId) => Effect.Effect<void>;
		readonly list: Effect.Effect<AgentInfo[]>;
		readonly canMutate: (
			id: AgentId,
			requesterAgentId?: AgentId,
		) => Effect.Effect<boolean, AgentNotFound>;
		readonly shutdown: (
			id: AgentId,
			requesterAgentId?: AgentId,
		) => Effect.Effect<AgentId[], AgentNotFound | AgentAccessDenied>;
		readonly shutdownAll: Effect.Effect<void>;
	}
>()("AgentManager") {}

// Agent Control
export interface ControlSpawnOptions {
	readonly agent: string;
	readonly message: string;
	readonly result_schema?: unknown;
	readonly approvalBroker?: ApprovalBroker | undefined;
	readonly parentSessionFile: string | undefined;
	readonly parentExecution: ParentExecutionContext;
	readonly parentAgentId?: AgentId | undefined;
	readonly parentModel?: Model<Api> | undefined;
	readonly modelRegistry?: ModelRegistry | undefined;
	readonly cwd: string;
}

/** Result type for wait operations */
export interface WaitResult {
	readonly status: Record<AgentId, Status>;
	readonly timedOut: boolean;
	/** Map of agent id to agent type/name */
	readonly agentTypes?: Record<AgentId, string>;
	/** Effective timeout applied to this wait call in milliseconds */
	readonly timeoutMs?: number;
	/** Wall-clock time spent waiting in milliseconds */
	readonly waitElapsedMs?: number;
	/** True if wait was interrupted by user */
	readonly interrupted?: boolean;
}

export class AgentControl extends Context.Service<
	AgentControl,
	{
		readonly spawn: (
			opts: ControlSpawnOptions,
		) => Effect.Effect<
			AgentId,
			AgentLimitReached | AgentDepthExceeded | AgentSpawnRestricted | AgentError
		>;
		readonly send: (
			id: AgentId,
			message: string,
			interrupt?: boolean,
			requesterAgentId?: AgentId,
		) => Effect.Effect<string, AgentNotFound | AgentAccessDenied | AgentError>;
		readonly wait: (ids: AgentId[], timeoutMs?: number) => Effect.Effect<WaitResult, unknown>;
		/** Stream version of wait that emits status updates */
		readonly waitStream: (
			ids: AgentId[],
			timeoutMs?: number,
			pollIntervalMs?: number,
		) => Stream.Stream<WaitResult, unknown>;
		readonly close: (
			id: AgentId,
			requesterAgentId?: AgentId,
		) => Effect.Effect<AgentId[], AgentNotFound | AgentAccessDenied>;
		readonly closeAll: Effect.Effect<void>;
		readonly list: Effect.Effect<AgentInfo[]>;
	}
>()("AgentControl") {}
