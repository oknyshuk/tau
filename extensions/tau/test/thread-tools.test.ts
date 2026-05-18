import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import { createThreadToolDefinitions } from "../src/thread/index.js";
import {
	renderFindThreadCall,
	renderFindThreadResult,
	renderReadThreadCall,
	renderReadThreadResult,
} from "../src/thread/renderer.js";
import { resolveThreadPath } from "../src/thread/search.js";
import type { FindThreadResult, ReadThreadResult } from "../src/thread/types.js";

function createToolContext(cwd: string): ExtensionContext {
	return { cwd } as ExtensionContext;
}

describe("createThreadToolDefinitions", () => {
	it("exports find_thread and read_thread tools", () => {
		const tools = createThreadToolDefinitions();
		expect(tools.map((t) => t.name)).toEqual(["find_thread", "read_thread"]);
	});

	it("find_thread has a non-empty description", () => {
		const tools = createThreadToolDefinitions();
		const findThread = tools.find((t) => t.name === "find_thread")!;
		expect(findThread).toBeDefined();
		expect(typeof findThread.description).toBe("string");
		expect(findThread.description.length).toBeGreaterThan(0);
	});

	it("read_thread has a non-empty description", () => {
		const tools = createThreadToolDefinitions();
		const readThread = tools.find((t) => t.name === "read_thread")!;
		expect(readThread).toBeDefined();
		expect(typeof readThread.description).toBe("string");
		expect(readThread.description.length).toBeGreaterThan(0);
	});

	it("rejects invalid find_thread params before execution", async () => {
		const tools = createThreadToolDefinitions();
		const findThread = tools.find((tool) => tool.name === "find_thread")!;

		const result = await findThread.execute(
			"call-1",
			{},
			undefined,
			undefined,
			createToolContext(process.cwd()),
		);

		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
			"Invalid find_thread params",
		);
		expect(result.details).toBeUndefined();
	});
});

describe("thread renderers", () => {
	const mockTheme = {
		fg: (name: string, text: string) => `[${name}:${text}]`,
		bold: (text: string) => `**${text}**`,
	};

	it("renders find_thread call with query", () => {
		const rendered = renderFindThreadCall({ query: "test query" }, mockTheme as never);
		expect(rendered).toContain("find_thread");
		expect(rendered).toContain("test query");
	});

	it("renders read_thread call with threadID and goal", () => {
		const rendered = renderReadThreadCall(
			{ threadID: "abc123", goal: "find bugs" },
			mockTheme as never,
		);
		expect(rendered).toContain("read_thread");
		expect(rendered).toContain("abc123");
		expect(rendered).toContain("find bugs");
	});

	it("renders find_thread results with matches", () => {
		const result: FindThreadResult = {
			ok: true,
			query: "my query",
			threads: [
				{
					id: "thread-1",
					title: "First Thread",
					path: "/tmp/thread1.jsonl",
					cwd: "/workspace",
					messageCount: 5,
					updatedAt: new Date().toISOString(),
					createdAt: new Date().toISOString(),
					parentThreadId: undefined,
					preview: "Hello world",
					score: 100,
				},
			],
			hasMore: false,
		};

		const rendered = renderFindThreadResult(result, true, mockTheme as never);
		expect(rendered).toContain("my query");
		expect(rendered).toContain("First Thread");
		expect(rendered).toContain("thread-1");
		expect(rendered).toContain("Hello world");
	});

	it("renders read_thread result with content", () => {
		const result: ReadThreadResult = {
			ok: true,
			threadID: "thread-1",
			resolvedPath: "/tmp/thread1.jsonl",
			title: "Test Thread",
			cwd: "/workspace",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			parentThreadId: undefined,
			totalMessages: 3,
			includedMessages: 3,
			truncated: false,
			content: "**User:** Hello\n\n**Assistant:** Hi there!",
		};

		const rendered = renderReadThreadResult(result, true, mockTheme as never);
		expect(rendered).toContain("Test Thread");
		expect(rendered).toContain("thread-1");
		expect(rendered).toContain("3/3");
		expect(rendered).toContain("User:** Hello");
	});

	it("renders find_thread empty results gracefully", () => {
		const result: FindThreadResult = {
			ok: true,
			query: "nonexistent",
			threads: [],
			hasMore: false,
		};

		const rendered = renderFindThreadResult(result, true, mockTheme as never);
		expect(rendered).toContain("nonexistent");
		expect(rendered).not.toMatch(/\d+\./);
	});
});

describe("thread service", () => {
	it("resolveThreadPath returns none for nonexistent ID", async () => {
		const resolved = await Effect.runPromise(
			resolveThreadPath("definitely-does-not-exist-1234567890", process.cwd()),
		);
		expect(Option.isNone(resolved)).toBe(true);
	}, 20_000);
});
