import type { TextContent } from "@earendil-works/pi-ai";
import {
	type ContentItem,
	type MessageLike,
	asContentArray,
	isTextContent,
	prependToLastUserMessage,
} from "../../shared/message-injection.js";

type AgentContextOpts = {
	count: number;
	pids?: number[];
};

export function buildAgentContextNotice(opts: AgentContextOpts): string {
	const count = opts.count;
	if (count <= 0) return "AGENT_CONTEXT: no other agents detected";

	const plural = count === 1 ? "" : "s";
	const pids = Array.isArray(opts.pids) ? opts.pids : [];
	const pidSuffix =
		pids.length > 0
			? ` (pids: ${pids.slice(0, 4).join(", ")}${pids.length > 4 ? ", …" : ""})`
			: "";
	return `AGENT_CONTEXT: ${count} other pi agent${plural} detected in overlapping directories${pidSuffix}`;
}

function alreadyHasAgentContext(content: ContentItem[]): boolean {
	const first = content[0];
	if (!isTextContent(first)) return false;
	return first.text.trimStart().startsWith("AGENT_CONTEXT:");
}

export function injectAgentContextIntoMessages<T extends MessageLike>(
	messages: T[],
	noticeText: string,
): T[] {
	const out = [...messages];

	for (let i = out.length - 1; i >= 0; i--) {
		const msg = out[i];
		if (msg && msg.role === "user") {
			if (alreadyHasAgentContext(asContentArray(msg.content))) return out;
			break;
		}
	}

	return prependToLastUserMessage(messages, noticeText);
}
