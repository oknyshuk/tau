import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export type MessageLike = { role: string; content?: unknown };

export type ContentItem = TextContent | ImageContent;

export function asContentArray(content: unknown): ContentItem[] {
	if (content === undefined || content === null) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (Array.isArray(content)) return content as ContentItem[];
	return [];
}

export function isTextContent(item: ContentItem | undefined): item is TextContent {
	return Boolean(item && item.type === "text");
}

export function prependToLastUserMessage<T extends MessageLike>(
	messages: T[],
	noticeText: string,
	prepareContent?: (content: ContentItem[]) => ContentItem[],
): T[] {
	const out = [...messages];

	for (let i = out.length - 1; i >= 0; i--) {
		const msg = out[i];
		if (msg && msg.role === "user") {
			const raw = asContentArray(msg.content);
			const contentArr = prepareContent ? prepareContent(raw) : raw;
			const injected: TextContent = { type: "text", text: `${noticeText}\n\n` };
			out[i] = { ...msg, content: [injected, ...contentArr] };
			return out;
		}
	}

	return out;
}
