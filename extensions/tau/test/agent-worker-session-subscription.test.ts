import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
	buildCompletedStatus,
	buildRunningStatus,
	createWorkerTrackingState,
} from "../src/agent/worker/status.js";
import { subscribeToWorkerSession } from "../src/agent/worker/session-subscription.js";

type SessionListener = (event: AgentSessionEvent) => void;

class FakeAgentSession {
	readonly listeners: SessionListener[] = [];
	messages: readonly unknown[] = [];
	isStreaming = false;
	isCompacting = false;

	subscribe(listener: SessionListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) {
				this.listeners.splice(index, 1);
			}
		};
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	asAgentSession(): AgentSession {
		return this as unknown as AgentSession;
	}
}

const assistantMessage = (options: {
	readonly text: string;
	readonly stopReason?: string;
	readonly errorMessage?: string;
}) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text: options.text }],
	...(options.stopReason !== undefined ? { stopReason: options.stopReason } : {}),
	...(options.errorMessage !== undefined ? { errorMessage: options.errorMessage } : {}),
});

describe("worker session subscription", () => {
	it("requests a submit_result retry when structured output is required but missing", () => {
		const session = new FakeAgentSession();
		const tracking = createWorkerTrackingState();
		const publishCompleted = vi.fn();
		const publishFailed = vi.fn();
		const publishRunningStatus = vi.fn();
		const publishRunningStatusIfNotFinal = vi.fn();
		const repromptForSubmitResult = vi.fn();

		subscribeToWorkerSession({
			session: session.asAgentSession(),
			tracking,
			resultSchema: { type: "object" },
			maxSubmitResultRetries: 3,
			publishCompleted,
			publishFailed,
			publishRunningStatus,
			publishRunningStatusIfNotFinal,
			repromptForSubmitResult,
		});

		session.emit({ type: "turn_start" } as AgentSessionEvent);
		session.emit({
			type: "agent_end",
			messages: [assistantMessage({ text: "done", stopReason: "stop" })],
		} as AgentSessionEvent);

		expect(repromptForSubmitResult).toHaveBeenCalledWith(1);
		expect(publishCompleted).not.toHaveBeenCalled();
		expect(publishFailed).not.toHaveBeenCalled();
	});

	it("treats aborted agent_end with captured structured output as completion", () => {
		const session = new FakeAgentSession();
		const tracking = createWorkerTrackingState();
		tracking.structuredOutput = { ok: true };
		const publishCompleted = vi.fn();

		subscribeToWorkerSession({
			session: session.asAgentSession(),
			tracking,
			resultSchema: { type: "object" },
			maxSubmitResultRetries: 3,
			publishCompleted,
			publishFailed: vi.fn(),
			publishRunningStatus: vi.fn(),
			publishRunningStatusIfNotFinal: vi.fn(),
			repromptForSubmitResult: vi.fn(),
		});

		session.emit({ type: "turn_start" } as AgentSessionEvent);
		session.emit({
			type: "agent_end",
			messages: [assistantMessage({ text: "ignored", stopReason: "aborted" })],
		} as AgentSessionEvent);

		expect(publishCompleted).toHaveBeenCalledWith(undefined);
	});
});

describe("worker status builders", () => {
	it("omits active turn timestamp until a turn starts and includes structured output on completion", () => {
		const tracking = createWorkerTrackingState();

		expect(buildRunningStatus(tracking)).toEqual({
			state: "running",
			turns: 0,
			toolCalls: 0,
			workedMs: 0,
			tools: [],
		});

		tracking.turnStartTime = 42;
		tracking.turns = 2;
		tracking.toolCalls = 3;
		tracking.workedMs = 99;
		tracking.tools.push({ name: "read", args: "file.ts", result: "ok" });

		expect(buildCompletedStatus(tracking, "done", { ok: true })).toEqual({
			state: "completed",
			message: "done",
			structured_output: { ok: true },
			turns: 2,
			toolCalls: 3,
			workedMs: 99,
			tools: [{ name: "read", args: "file.ts", result: "ok" }],
		});
	});
});
