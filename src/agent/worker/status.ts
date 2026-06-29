import type { Status, ToolRecord } from "../status.js";

export interface WorkerTrackingState {
	turns: number;
	toolCalls: number;
	workedMs: number;
	terminalState: "completed" | "failed" | "shutdown" | undefined;
	turnStartTime: number | undefined;
	tools: ToolRecord[];
	pendingTools: Map<string, ToolRecord>;
}

export function createWorkerTrackingState(): WorkerTrackingState {
	return {
		turns: 0,
		toolCalls: 0,
		workedMs: 0,
		terminalState: undefined,
		turnStartTime: undefined,
		tools: [],
		pendingTools: new Map<string, ToolRecord>(),
	};
}

export function buildRunningStatus(tracking: WorkerTrackingState): Status {
	return {
		state: "running",
		turns: tracking.turns,
		toolCalls: tracking.toolCalls,
		workedMs: tracking.workedMs,
		...(tracking.turnStartTime !== undefined
			? { activeTurnStartedAtMs: tracking.turnStartTime }
			: {}),
		tools: tracking.tools,
	};
}

export function buildFailedStatus(tracking: WorkerTrackingState, reason: string): Status {
	return {
		state: "failed",
		reason,
		turns: tracking.turns,
		toolCalls: tracking.toolCalls,
		workedMs: tracking.workedMs,
		tools: tracking.tools,
	};
}

export function buildCompletedStatus(
	tracking: WorkerTrackingState,
	message: string | undefined,
): Status {
	return {
		state: "completed",
		message,
		turns: tracking.turns,
		toolCalls: tracking.toolCalls,
		workedMs: tracking.workedMs,
		tools: tracking.tools,
	};
}

export function buildShutdownStatus(): Status {
	return { state: "shutdown" };
}
