import * as path from "node:path";

export const LOOPS_DIR = ".pi/loops";
export const LOOPS_TASKS_DIR = path.join(LOOPS_DIR, "tasks");
export const LOOPS_STATE_DIR = path.join(LOOPS_DIR, "state");

const LOOPS_ARCHIVE_DIR = path.join(LOOPS_DIR, "archive");
export const LOOPS_ARCHIVE_TASKS_DIR = path.join(LOOPS_ARCHIVE_DIR, "tasks");
export const LOOPS_ARCHIVE_STATE_DIR = path.join(LOOPS_ARCHIVE_DIR, "state");

export function loopTaskFile(taskId: string, archived = false): string {
	return path.join(archived ? LOOPS_ARCHIVE_TASKS_DIR : LOOPS_TASKS_DIR, `${taskId}.md`);
}

export function loopStateFile(taskId: string, archived = false): string {
	return path.join(archived ? LOOPS_ARCHIVE_STATE_DIR : LOOPS_STATE_DIR, `${taskId}.json`);
}
