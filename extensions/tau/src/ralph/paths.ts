import * as path from "node:path";

export const RALPH_DIR = ".pi/loops";
export const RALPH_TASKS_DIR = path.join(RALPH_DIR, "tasks");
export const RALPH_STATE_DIR = path.join(RALPH_DIR, "state");
const RALPH_ARCHIVE_DIR = path.join(RALPH_DIR, "archive");
export const RALPH_ARCHIVE_TASKS_DIR = path.join(RALPH_ARCHIVE_DIR, "tasks");
export const RALPH_ARCHIVE_STATE_DIR = path.join(RALPH_ARCHIVE_DIR, "state");
