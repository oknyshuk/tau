import { describe, expect, it } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { createMemoryEntry, type MemoryEntriesSnapshot } from "../src/memory/format.js";
import { renderMemoriesMessage, renderMemoryCall, renderMemoryResult } from "../src/memory/renderer.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function renderText(snapshot: MemoryEntriesSnapshot): string {
	return renderMemoriesMessage({ snapshot }, plainTheme).render(400).join("\n");
}

function renderToolCall(args: Record<string, unknown>): string {
	return renderMemoryCall(args, plainTheme).render(400).join("\n");
}

function renderToolResult(result: {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
	readonly details?: unknown;
}): string {
	const rendered = renderMemoryResult(result, plainTheme);
	if (!(rendered instanceof Text)) {
		throw new Error("Expected memory renderer to return Text");
	}
	return rendered.render(400).join("\n");
}

function makeEntry(summary: string, content = `${summary} body`) {
	return createMemoryEntry(content, { summary });
}

describe("memory renderer", () => {
	it("renders all scopes with id, size, scope, and preview columns", () => {
		const snapshot: MemoryEntriesSnapshot = {
			project: {
				bucket: "project",
				path: "/workspace/.pi/tau/memories/PROJECT.jsonl",
				entries: [makeEntry("project memory preview", "project memory details")],
				chars: 22,
				limitChars: 25000,
				usagePercent: 2,
			},
			global: {
				bucket: "global",
				path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
				entries: [makeEntry("global memory preview", "global memory details")],
				chars: 21,
				limitChars: 25000,
				usagePercent: 2,
			},
			user: {
				bucket: "user",
				path: "/home/test/.pi/agent/tau/memories/USER.jsonl",
				entries: [makeEntry("user memory preview", "user memory details")],
				chars: 19,
				limitChars: 25000,
				usagePercent: 3,
			},
		};

		const rendered = renderText(snapshot);

		expect(rendered).toContain("memories");
		expect(rendered).toContain("project");
		expect(rendered).toContain("global");
		expect(rendered).toContain("user");
		expect(rendered).toContain("id");
		expect(rendered).toContain("size");
		expect(rendered).toContain("scope");
		expect(rendered).toContain("preview");
		expect(rendered).toContain("project memory preview");
		expect(rendered).toContain("global memory preview");
		expect(rendered).toContain("user memory preview");
		expect(rendered).toContain(snapshot.project.entries[0]!.id);
	});

	it("aligns the /memories summary columns for counts and char totals", () => {
		const snapshot: MemoryEntriesSnapshot = {
			project: {
				bucket: "project",
				path: "/workspace/.pi/tau/memories/PROJECT.jsonl",
				entries: Array.from({ length: 7 }, (_, index) => makeEntry(`project-${index}`, `project body ${index}`)),
				chars: 1275,
				limitChars: 25000,
				usagePercent: 62,
			},
			global: {
				bucket: "global",
				path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
				entries: Array.from({ length: 11 }, (_, index) => makeEntry(`global-${index}`, `global body ${index}`)),
				chars: 1107,
				limitChars: 25000,
				usagePercent: 54,
			},
			user: {
				bucket: "user",
				path: "/home/test/.pi/agent/tau/memories/USER.jsonl",
				entries: Array.from({ length: 9 }, (_, index) => makeEntry(`user-${index}`, `user body ${index}`)),
				chars: 1452,
				limitChars: 25000,
				usagePercent: 141,
			},
		};

		const lines = renderText(snapshot).split("\n");
		const summaryLines = lines
			.filter((line) => /^\s{2}(project|global|user)\s+:/u.test(line))
			.map((line) => line.trimEnd());

		expect(summaryLines).toEqual([
			"  project : [█████████░░░░░]  7 entries · 1275/25000 chars",
			"  global  : [████████░░░░░░] 11 entries · 1107/25000 chars",
			"  user    : [██████████████]  9 entries · 1452/25000 chars",
		]);
	});

	it("suppresses the separate memory call cell to avoid duplicate content", () => {
		const rendered = renderToolCall({
			action: "add",
			target: "project",
			content: "remember this exact\nmulti-line memory",
		});

		expect(rendered.trim()).toBe("");
	});

	it("keeps the submitted content visible in the result when a memory file failure occurs", () => {
		const result = renderToolResult({
			content: [{ type: "text", text: 'Memory file error: Error: expected a nanoid\n    at ["id"]' }],
			details: {
				success: false,
				action: "add",
				scope: "project",
				submittedSummary: "short hook",
				submittedContent: "remember this exact\nmulti-line memory",
			},
		});

		expect(result).toContain("memory add");
		expect(result).toContain("scope   : project");
		expect(result).toContain("summary : short hook");
		expect(result).toContain("chars   : 37");
		expect(result).toContain("content:");
		expect(result).toContain("remember this exact");
		expect(result).toContain("multi-line memory");
		expect(result).toContain("expected a nanoid");
	});

	it("normalizes CRLF content before rendering failure content", () => {
		const rendered = renderToolResult({
			content: [{ type: "text", text: "Memory file error: broken" }],
			details: {
				success: false,
				action: "add",
				scope: "project",
				submittedSummary: "alpha beta hook",
				submittedContent: "alpha\r\nbeta",
			},
		});

		expect(rendered).toContain("alpha");
		expect(rendered).toContain("beta");
		expect(rendered).not.toContain("\r");
	});

	it("renders the stored scope for successful read results", () => {
		const entry = createMemoryEntry("boring durable fact body", {
			scope: "user",
			summary: "boring durable fact",
		});
		const rendered = renderToolResult({
			content: [{ type: "text", text: `id: ${entry.id}\nscope: ${entry.scope}` }],
			details: {
				success: true,
				action: "read",
				entry,
			},
		});

		expect(rendered).toContain("memory read");
		expect(rendered).toContain(`id      : ${entry.id}`);
		expect(rendered).toContain("scope   : user");
	});

	it("shows the full stored content for successful writes instead of only a preview", () => {
		const entry = createMemoryEntry("User wants exact answers.\nNo approximations.", {
			scope: "user",
			type: "fact",
			summary: "User wants exact answers.",
		});
		const rendered = renderToolResult({
			content: [
				{
					type: "text",
					text: [
						"Added entry to user memory.",
						"",
						`id: ${entry.id}`,
						`scope: ${entry.scope}`,
						`type: ${entry.type}`,
						`summary: ${entry.summary}`,
						`chars: ${entry.content.length}`,
						"content:",
						entry.content,
					].join("\n"),
				},
			],
			details: {
				success: true,
				action: "add",
				scope: "user",
				entry,
				bucket: {
					bucket: "user",
					path: "/home/test/.pi/agent/tau/memories/USER.jsonl",
					entries: [entry],
					chars: entry.content.length,
					limitChars: 25000,
					usagePercent: 1,
				},
			},
		});

		expect(rendered).toContain("memory add");
		expect(rendered).toContain("summary : User wants exact answers.");
		expect(rendered).toContain("content:");
		expect(rendered).toContain("User wants exact answers.");
		expect(rendered).toContain("No approximations.");
		expect(rendered).not.toContain("preview :");
	});

	it("surfaces entries that need summary repair in /memories", () => {
		const invalid = { ...makeEntry("repair hook", "repair body"), summary: "repair body" };
		const snapshot: MemoryEntriesSnapshot = {
			project: {
				bucket: "project",
				path: "/workspace/.pi/tau/memories/PROJECT.jsonl",
				entries: [invalid],
				chars: invalid.content.length,
				limitChars: 25000,
				usagePercent: 1,
			},
			global: {
				bucket: "global",
				path: "/home/test/.pi/agent/tau/memories/MEMORY.jsonl",
				entries: [],
				chars: 0,
				limitChars: 25000,
				usagePercent: 0,
			},
			user: {
				bucket: "user",
				path: "/home/test/.pi/agent/tau/memories/USER.jsonl",
				entries: [],
				chars: 0,
				limitChars: 25000,
				usagePercent: 0,
			},
		};

		const rendered = renderMemoriesMessage(
			{
				snapshot,
				issues: [
					{
						id: invalid.id,
						scope: invalid.scope,
						summary: invalid.summary,
						content: invalid.content,
						reason: "summary_matches_content",
					},
				],
			},
			plainTheme,
		)
			.render(400)
			.join("\n");

		expect(rendered).toContain("repair");
		expect(rendered).toContain(invalid.id);
		expect(rendered).toContain("summary duplicates content");
	});
});
