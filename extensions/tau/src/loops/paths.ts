import * as path from "node:path";

export const LOOPS_DIR = ".pi/loops";
export const LOOPS_TASKS_DIR = path.join(LOOPS_DIR, "tasks");
export const LOOPS_STATE_DIR = path.join(LOOPS_DIR, "state");
export const LOOPS_PHASES_DIR = path.join(LOOPS_DIR, "phases");
export const LOOPS_RUNS_DIR = path.join(LOOPS_DIR, "runs");

const LOOPS_ARCHIVE_DIR = path.join(LOOPS_DIR, "archive");
export const LOOPS_ARCHIVE_TASKS_DIR = path.join(LOOPS_ARCHIVE_DIR, "tasks");
export const LOOPS_ARCHIVE_STATE_DIR = path.join(LOOPS_ARCHIVE_DIR, "state");
export const LOOPS_ARCHIVE_PHASES_DIR = path.join(LOOPS_ARCHIVE_DIR, "phases");
export const LOOPS_ARCHIVE_RUNS_DIR = path.join(LOOPS_ARCHIVE_DIR, "runs");

export function loopTaskFile(taskId: string, archived = false): string {
	return path.join(archived ? LOOPS_ARCHIVE_TASKS_DIR : LOOPS_TASKS_DIR, `${taskId}.md`);
}

export function loopStateFile(taskId: string, archived = false): string {
	return path.join(archived ? LOOPS_ARCHIVE_STATE_DIR : LOOPS_STATE_DIR, `${taskId}.json`);
}

export function loopPhaseDirectory(taskId: string, archived = false): string {
	return path.join(archived ? LOOPS_ARCHIVE_PHASES_DIR : LOOPS_PHASES_DIR, taskId);
}

export function loopPhaseFile(taskId: string, phaseId: string, archived = false): string {
	return path.join(loopPhaseDirectory(taskId, archived), `${phaseId}.json`);
}

export function loopRunsDirectory(taskId: string, archived = false): string {
	return path.join(archived ? LOOPS_ARCHIVE_RUNS_DIR : LOOPS_RUNS_DIR, taskId);
}

export function loopRunDirectory(taskId: string, runId: string, archived = false): string {
	return path.join(loopRunsDirectory(taskId, archived), runId);
}
