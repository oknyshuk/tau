import type { ResolvedSandboxConfig } from "./config.js";
import {
	type ContentItem,
	type MessageLike,
	isTextContent,
	prependToLastUserMessage,
} from "../shared/message-injection.js";

const SANDBOX_NOTICE_PREFIX = /^\s*SANDBOX_(?:STATE|CHANGE):[^\n]*(?:\n\n)?/;

export function computeSandboxConfigHash(cfg: ResolvedSandboxConfig): string {
	return [
		`preset=${cfg.preset}`,
		`subagent=${cfg.subagent}`,
	].join(";");
}

function buildSandboxNotice(
	prefix: "SANDBOX_STATE:" | "SANDBOX_CHANGE:",
	cfg: ResolvedSandboxConfig,
): string {
	return [
		prefix,
		`preset=${cfg.preset}`,
		`subagent=${cfg.subagent}`,
	].join(" ");
}

export function buildSandboxStateNoticeText(cfg: ResolvedSandboxConfig): string {
	return buildSandboxNotice("SANDBOX_STATE:", cfg);
}

export function buildSandboxChangeNoticeText(cfg: ResolvedSandboxConfig): string {
	return buildSandboxNotice("SANDBOX_CHANGE:", cfg);
}

function stripSandboxNoticePrefix(text: string): string {
	return text.replace(SANDBOX_NOTICE_PREFIX, "");
}

function stripLeadingSandboxNotice(content: ContentItem[]): ContentItem[] {
	if (content.length === 0) return content;

	const first = content[0];
	if (!isTextContent(first)) return content;

	const strippedText = stripSandboxNoticePrefix(first.text);
	if (strippedText === first.text) return content;
	if (strippedText.length === 0) return content.slice(1);

	return [{ ...first, text: strippedText }, ...content.slice(1)];
}

export function injectSandboxNoticeIntoMessages<T extends MessageLike>(
	messages: T[],
	noticeText: string,
): T[] {
	return prependToLastUserMessage(messages, noticeText, stripLeadingSandboxNotice);
}
