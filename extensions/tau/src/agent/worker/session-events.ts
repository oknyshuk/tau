import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import { isRecord } from "../../shared/json.js";

type AssistantTextPart = { type: string; text?: string };

export type AssistantLikeMessage = {
	role: "assistant";
	content?: ReadonlyArray<AssistantTextPart>;
	stopReason?: string;
	errorMessage?: string;
};

function readAssistantTextPart(value: unknown): AssistantTextPart | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const type = value["type"];
	if (typeof type !== "string") {
		return undefined;
	}

	const text = value["text"];
	return typeof text === "string" ? { type, text } : { type };
}

export function getAssistantText(message: AssistantLikeMessage | undefined): string {
	if (!message) {
		return "";
	}

	return (
		message.content
			?.filter(
				(part): part is { type: "text"; text: string } =>
					part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n") ?? ""
	);
}

export function getAssistantFailureReason(
	message: AssistantLikeMessage | undefined,
	fallback: string,
): string {
	const text = getAssistantText(message);
	return message?.errorMessage || text || fallback;
}

export function getLastAssistantMessage(
	messages: readonly unknown[],
): AssistantLikeMessage | undefined {
	const last = messages[messages.length - 1];
	if (!isRecord(last) || last["role"] !== "assistant") {
		return undefined;
	}

	const content = Array.isArray(last["content"])
		? last["content"]
				.map((part) => readAssistantTextPart(part))
				.filter((part): part is AssistantTextPart => part !== undefined)
		: undefined;

	const stopReason = typeof last["stopReason"] === "string" ? last["stopReason"] : undefined;
	const errorMessage =
		typeof last["errorMessage"] === "string" ? last["errorMessage"] : undefined;

	return {
		role: "assistant",
		...(content !== undefined ? { content } : {}),
		...(stopReason !== undefined ? { stopReason } : {}),
		...(errorMessage !== undefined ? { errorMessage } : {}),
	};
}

export function waitForSessionSettlement(
	session: AgentSession,
): Effect.Effect<{ ok: true } | { ok: false; reason: string }> {
	return Effect.callback<{ ok: true } | { ok: false; reason: string }>((resume) => {
		let pendingFailureTimer: ReturnType<typeof setTimeout> | undefined = undefined;
		let settled = false;

		const clearPendingFailureTimer = (): void => {
			if (pendingFailureTimer !== undefined) {
				clearTimeout(pendingFailureTimer);
				pendingFailureTimer = undefined;
			}
		};

		const finish = (result: { ok: true } | { ok: false; reason: string }): void => {
			if (settled) return;
			settled = true;
			clearPendingFailureTimer();
			unsubscribe();
			resume(Effect.succeed(result));
		};

		const settleFromCurrentState = (): void => {
			if (session.isStreaming || session.isCompacting) {
				return;
			}

			const assistant = getLastAssistantMessage(session.messages);
			if (assistant?.stopReason === "error") {
				clearPendingFailureTimer();
				pendingFailureTimer = setTimeout(() => {
					pendingFailureTimer = undefined;
					finish({
						ok: false,
						reason: getAssistantFailureReason(assistant, "Agent ended with error"),
					});
				}, 0);
				return;
			}

			finish({ ok: true });
		};

		const unsubscribe = session.subscribe((event) => {
			if (event.type === "compaction_start") {
				clearPendingFailureTimer();
				return;
			}

			if (event.type === "compaction_end") {
				clearPendingFailureTimer();
				if (event.errorMessage) {
					finish({ ok: false, reason: event.errorMessage });
					return;
				}
				if (!event.willRetry) {
					setTimeout(settleFromCurrentState, 0);
				}
				return;
			}

			if (event.type === "agent_end") {
				const assistant = getLastAssistantMessage(event.messages);
				if (assistant?.stopReason === "error") {
					clearPendingFailureTimer();
					pendingFailureTimer = setTimeout(() => {
						pendingFailureTimer = undefined;
						finish({
							ok: false,
							reason: getAssistantFailureReason(assistant, "Agent ended with error"),
						});
					}, 0);
					return;
				}

				finish({ ok: true });
			}
		});

		settleFromCurrentState();

		return Effect.sync(() => {
			clearPendingFailureTimer();
			unsubscribe();
		});
	});
}
