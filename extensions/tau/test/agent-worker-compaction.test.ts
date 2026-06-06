import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import { Effect, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { Status } from "../src/agent/status.js";
import type { ModelSpec } from "../src/agent/types.js";
import { AgentWorker } from "../src/agent/worker.js";

type SessionListener = (event: AgentSessionEvent) => void;

type AssistantEventMessage = {
	readonly role: "assistant";
	readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
	readonly stopReason?: string;
	readonly errorMessage?: string;
};

interface PromptCall {
	readonly message: unknown;
	readonly options: unknown;
}

const waitForTimers = async (): Promise<void> => {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
};

const assistantMessage = (options: {
	readonly text: string;
	readonly stopReason?: string;
	readonly errorMessage?: string;
}): AssistantEventMessage => ({
	role: "assistant",
	content: [{ type: "text", text: options.text }],
	...(options.stopReason !== undefined ? { stopReason: options.stopReason } : {}),
	...(options.errorMessage !== undefined ? { errorMessage: options.errorMessage } : {}),
});

class FakeAgentSession {
	readonly listeners: SessionListener[] = [];
	readonly promptCalls: PromptCall[] = [];
	messages: readonly AssistantEventMessage[] = [];
	isStreaming = false;
	isCompacting = false;
	sessionId = "session-1";
	sessionManager = {} as AgentSession["sessionManager"];
	agent = {} as AgentSession["agent"];

	constructor(private readonly onPrompt?: (session: FakeAgentSession) => Promise<void>) {}

	subscribe(listener: SessionListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) {
				this.listeners.splice(index, 1);
			}
		};
	}

	async prompt(message?: unknown, options?: unknown): Promise<void> {
		this.promptCalls.push({ message, options });
		if (this.onPrompt) {
			await this.onPrompt(this);
		}
	}

	async abort(): Promise<void> {}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	asAgentSession(): AgentSession {
		return this as unknown as AgentSession;
	}
}

const makeWorker = async (
	session: FakeAgentSession,
): Promise<{
	readonly worker: AgentWorker;
	readonly statusRef: SubscriptionRef.SubscriptionRef<Status>;
}> => {
	const statusRef = await Effect.runPromise(SubscriptionRef.make<Status>({ state: "pending" }));
	const definition = {
		name: "deep",
		description: "Deep worker",
		models: [{ model: "openai/gpt-5-codex" }] as const,
		sandbox: { preset: "workspace-write", subagent: true } as const,
		systemPrompt: "",
	} satisfies {
		readonly name: string;
		readonly description: string;
		readonly models: readonly ModelSpec[];
		readonly sandbox: { readonly preset: "workspace-write"; readonly subagent: true };
		readonly systemPrompt: string;
	};

	const worker = new (AgentWorker as unknown as {
		new (
			id: string,
			type: string,
			depth: number,
			session: AgentSession,
			statusRef: SubscriptionRef.SubscriptionRef<Status>,
			infra: unknown,
			models: readonly ModelSpec[],
			parentModel: Model<Api> | undefined,
			executionState: unknown,
			executionProfile: unknown,
			runFork: unknown,
			agentContext: unknown,
		): AgentWorker;
	})(
		"agent-1",
		"deep",
		1,
		session.asAgentSession(),
		statusRef,
		{
			definition,
		},
		definition.models,
		undefined,
		{
			policy: {
				tools: {
					kind: "inherit",
				},
			},
		},
		{
			model: "openai/gpt-5-codex",
			thinking: "medium",
			policy: {
				tools: {
					kind: "inherit",
				},
			},
		},
		(effect: Effect.Effect<unknown, unknown, never>) => Effect.runFork(effect),
		{
			parentSessionFile: "parent-session",
			parentModel: undefined,
			parentExecutionState: {
				policy: {
					tools: {
						kind: "inherit",
					},
				},
			},
			parentExecutionProfile: {
				model: "openai/gpt-5-codex",
				thinking: "medium",
				policy: {
					tools: {
						kind: "inherit",
					},
				},
			},
			resolveParentExecution: async () => ({
				state: {
					policy: {
						tools: {
							kind: "inherit",
						},
					},
				},
				profile: {
					model: "openai/gpt-5-codex",
					thinking: "medium",
					policy: {
						tools: {
							kind: "inherit",
						},
					},
				},
			}),
			modelRegistry: {},
			cwd: process.cwd(),
			approvalBroker: undefined,
		},
	);

	(worker as unknown as { subscribeToSession(session: AgentSession): void }).subscribeToSession(
		session.asAgentSession(),
	);

	return { worker, statusRef };
};

afterEach(async () => {
	await waitForTimers();
});

describe("AgentWorker overflow compaction handling", () => {
	it("steers a running worker when prompted again", async () => {
		const session = new FakeAgentSession();
		session.isStreaming = true;
		const { worker, statusRef } = await makeWorker(session);

		const submissionId = await Effect.runPromise(worker.prompt("take this nudge"));
		await waitForTimers();

		expect(submissionId).toMatch(/^sub-/);
		expect(session.promptCalls).toEqual([
			{
				message: "take this nudge",
				options: {
					source: "extension",
					streamingBehavior: "steer",
				},
			},
		]);
		expect(Effect.runSync(SubscriptionRef.get(statusRef)).state).toBe("running");
	});

	it("keeps worker status running when overflow compaction starts after agent_end", async () => {
		const session = new FakeAgentSession();
		const { statusRef } = await makeWorker(session);

		session.emit({ type: "turn_start" } as AgentSessionEvent);
		session.emit({
			type: "agent_end",
			messages: [
				assistantMessage({
					text: "overflow",
					stopReason: "error",
					errorMessage: "context_length_exceeded",
				}),
			],
		} as AgentSessionEvent);
		session.emit({
			type: "auto_compaction_start",
			reason: "overflow",
		} satisfies AgentSessionEvent);

		await waitForTimers();

		expect(Effect.runSync(SubscriptionRef.get(statusRef)).state).toBe("running");
	});

	it("keeps completed status when threshold compaction runs after a successful turn", async () => {
		const session = new FakeAgentSession();
		const { statusRef } = await makeWorker(session);

		session.emit({ type: "turn_start" } as AgentSessionEvent);
		session.emit({
			type: "agent_end",
			messages: [
				assistantMessage({
					text: "done",
					stopReason: "stop",
				}),
			],
		} as AgentSessionEvent);
		session.emit({
			type: "auto_compaction_start",
			reason: "threshold",
		} satisfies AgentSessionEvent);
		session.emit({
			type: "auto_compaction_end",
			result: undefined,
			aborted: false,
			willRetry: false,
		} satisfies AgentSessionEvent);

		await waitForTimers();

		expect(Effect.runSync(SubscriptionRef.get(statusRef)).state).toBe("completed");
	});

	it("waits for overflow compaction retry before failing the current model", async () => {
		const session = new FakeAgentSession(async (activeSession) => {
			const overflow = assistantMessage({
				text: "overflow",
				stopReason: "error",
				errorMessage: "context_length_exceeded",
			});

			activeSession.messages = [overflow];
			activeSession.emit({
				type: "agent_end",
				messages: [overflow],
			} as AgentSessionEvent);

			setTimeout(() => {
				activeSession.isCompacting = true;
				activeSession.emit({
					type: "auto_compaction_start",
					reason: "overflow",
				} satisfies AgentSessionEvent);

				activeSession.isCompacting = false;
				activeSession.emit({
					type: "auto_compaction_end",
					result: undefined,
					aborted: false,
					willRetry: true,
				} satisfies AgentSessionEvent);

				const success = assistantMessage({
					text: "done",
					stopReason: "stop",
				});
				activeSession.messages = [success];
				activeSession.emit({
					type: "agent_end",
					messages: [success],
				} as AgentSessionEvent);
			}, 0);
		});

		const { worker } = await makeWorker(session);

		await expect(
			Effect.runPromise(
				(
					worker as unknown as {
						promptSession(
							message: string,
							modelLabel: string,
						): Effect.Effect<void, string>;
					}
				).promptSession("continue", "openai/gpt-5-codex"),
			),
		).resolves.toBeUndefined();
	});
});
