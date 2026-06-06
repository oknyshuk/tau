import type { AgentSession } from "@mariozechner/pi-coding-agent";

import { isRecord } from "../../shared/json.js";
import { getAssistantText, getLastAssistantMessage } from "./session-events.js";
import type { WorkerTrackingState } from "./status.js";

function truncateStr(value: string, max: number): string {
	if (value.length <= max) {
		return value;
	}
	return value.slice(0, max - 3) + "...";
}

function formatToolArgs(toolName: string, args: unknown): string {
	if (!isRecord(args)) {
		return "";
	}

	switch (toolName) {
		case "exec_command":
			return typeof args["cmd"] === "string" ? args["cmd"] : "";
		case "write_stdin":
			return typeof args["session_id"] === "number" ? `session ${args["session_id"]}` : "";
		case "backlog":
			return typeof args["command"] === "string" ? args["command"] : "";
		case "read":
			return typeof args["path"] === "string" ? args["path"] : "";
		case "write":
			return typeof args["path"] === "string" ? `${args["path"]} (create)` : "";
		case "edit":
			return typeof args["path"] === "string" ? `${args["path"]} (edit)` : "";
		default:
			if (typeof args["path"] === "string") return args["path"];
			if (typeof args["command"] === "string") return args["command"];
			if (typeof args["query"] === "string") return args["query"];
			return "";
	}
}

export interface WorkerSessionSubscriptionOptions {
	readonly session: AgentSession;
	readonly tracking: WorkerTrackingState;
	readonly publishRunningStatus: () => void;
	readonly publishRunningStatusIfNotFinal: () => void;
	readonly publishCompleted: (message: string | undefined) => void;
	readonly publishFailed: (reason: string) => void;
}

export function subscribeToWorkerSession(options: WorkerSessionSubscriptionOptions): () => void {
	const {
		session,
		tracking,
		publishRunningStatus,
		publishRunningStatusIfNotFinal,
		publishCompleted,
		publishFailed,
	} = options;

	return session.subscribe((event) => {
		if (tracking.terminalState === "shutdown") {
			return;
		}

		switch (event.type) {
			case "turn_start": {
				tracking.terminalState = undefined;
				tracking.turns += 1;
				tracking.turnStartTime = Date.now();
				publishRunningStatus();
				return;
			}
			case "turn_end": {
				if (tracking.turnStartTime !== undefined) {
					tracking.workedMs += Date.now() - tracking.turnStartTime;
					tracking.turnStartTime = undefined;
				}
				publishRunningStatusIfNotFinal();
				return;
			}
			case "tool_execution_start": {
				tracking.toolCalls += 1;
				tracking.pendingTools.set(event.toolCallId, {
					name: event.toolName,
					args: truncateStr(formatToolArgs(event.toolName, event.args), 100),
				});
				publishRunningStatus();
				return;
			}
			case "tool_execution_end": {
				const pending = tracking.pendingTools.get(event.toolCallId);
				if (pending) {
					tracking.pendingTools.delete(event.toolCallId);
					tracking.tools.push({
						...pending,
						result: truncateStr(
							typeof event.result === "string"
								? event.result
								: JSON.stringify(event.result),
							100,
						),
						isError: event.isError,
					});
				}
				publishRunningStatusIfNotFinal();
				return;
			}
			case "auto_compaction_start":
			case "auto_compaction_end": {
				publishRunningStatusIfNotFinal();
				return;
			}
			case "agent_end": {
				if (tracking.turnStartTime !== undefined) {
					tracking.workedMs += Date.now() - tracking.turnStartTime;
					tracking.turnStartTime = undefined;
				}

				const assistantMsg = getLastAssistantMessage(event.messages);

				if (assistantMsg?.stopReason === "error") {
					publishRunningStatusIfNotFinal();
					return;
				}

				if (assistantMsg?.stopReason === "aborted") {
					const textContent = getAssistantText(assistantMsg);
					if (!textContent) {
						publishFailed("Agent was aborted before producing a response");
					} else {
						publishCompleted(textContent);
					}
					return;
				}

				publishCompleted(assistantMsg ? getAssistantText(assistantMsg) : undefined);
			}
		}
	});
}
