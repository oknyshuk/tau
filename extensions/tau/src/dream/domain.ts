import { Schema } from "effect";

const DreamRunMode = Schema.Literals(["manual", "auto"]);
type DreamRunMode = typeof DreamRunMode.Type;

const DreamPhase = Schema.Literals([
	"queued",
	"orient",
	"gather",
	"consolidate",
	"prune",
	"done",
]);
type DreamPhase = typeof DreamPhase.Type;

const DreamTaskStatus = Schema.Literals([
	"running",
	"completed",
	"failed",
	"cancelled",
]);
type DreamTaskStatus = typeof DreamTaskStatus.Type;

export const DreamTaskId = Schema.String;
export type DreamTaskId = typeof DreamTaskId.Type;

export interface DreamTranscriptCandidate {
	readonly sessionId: string;
	readonly path: string;
	readonly touchedAt: number;
}

export interface DreamAutoPermit {
	readonly sinceMs: number;
	readonly sessions: ReadonlyArray<DreamTranscriptCandidate>;
}

export interface DreamRunRequest {
	readonly cwd: string;
	readonly mode: DreamRunMode;
	readonly currentSessionId?: string;
	readonly requestedBy: "user" | "scheduler";
}

export interface DreamTaskHandle {
	readonly taskId: DreamTaskId;
}

export type DreamProgressEvent =
	| {
			readonly _tag: "PhaseChanged";
			readonly phase: DreamPhase;
			readonly message?: string;
	  }
	| {
			readonly _tag: "SessionsDiscovered";
			readonly total: number;
	  }
	| {
			readonly _tag: "MemoryMutation";
			readonly action: string;
			readonly scope: string;
			readonly summary: string;
	  }
	| {
			readonly _tag: "Note";
			readonly text: string;
	  };

export interface DreamTaskState {
	readonly id: DreamTaskId;
	readonly type: "dream";
	readonly mode: DreamRunMode;
	readonly status: DreamTaskStatus;
	readonly phase: DreamPhase;
	readonly startedAt: number;
	readonly finishedAt?: number;
	readonly sessionsDiscovered: number;
	readonly sessionsReviewed: number;
	readonly memoryMutations: number;
	readonly latestMessage?: string;
	readonly cancellable: boolean;
}

/** Bookkeeping data the model sends via dream_finish. */
export const DreamFinishParams = Schema.Struct({
	runId: Schema.String,
	summary: Schema.String,
	reviewedSessions: Schema.Array(Schema.String),
	noChanges: Schema.Boolean,
});
export type DreamFinishParams = typeof DreamFinishParams.Type;

/** Result of a completed dream run, used by scheduler and task registry. */
export interface DreamRunResult {
	readonly mode: DreamRunMode;
	readonly startedAt: number;
	readonly finishedAt: number;
	readonly summary: string;
	readonly reviewedSessions: ReadonlyArray<string>;
	readonly memoryMutations: number;
	readonly noChanges: boolean;
}
