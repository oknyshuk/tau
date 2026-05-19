import { describe, expect, it } from "vitest";

import { Text } from "@earendil-works/pi-tui";
import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";

import {
	createBacklogToolDefinition,
	truncateFlagValueForRenderCall,
	type BacklogToolDetails,
} from "../src/backlog/tool.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const issue = {
	id: "tau-1",
	title: "Issue",
	status: "open",
	priority: 2,
	issue_type: "task",
	created_at: "2026-03-29T12:00:00.000Z",
	updated_at: "2026-03-29T12:00:00.000Z",
};

function renderResult(details: BacklogToolDetails, options: ToolRenderResultOptions = { expanded: true, isPartial: false }): Text {
	const tool = createBacklogToolDefinition();
	const renderResultFn = tool.renderResult as unknown as (
		result: unknown,
		options: ToolRenderResultOptions,
		theme: Theme,
	) => Text;
	const rendered = renderResultFn({ content: [], details }, options, plainTheme);
	return rendered as Text;
}

function renderCall(args: { command: string; cwd?: string }): Text {
	const tool = createBacklogToolDefinition();
	const renderCallFn = tool.renderCall as unknown as (args: unknown, theme: Theme) => Text;
	const rendered = renderCallFn(args, plainTheme);
	return rendered as Text;
}

function normalizeRendered(text: Text): string {
	return text
		.render(80)
		.map((line) => line.trimEnd())
		.join("\n");
}

describe("backlog tool renderer", () => {
	it("renders calls", () => {
		const rendered = renderCall({ command: "show tau-1", cwd: "/tmp/workspace" });
		expect(rendered).toBeInstanceOf(Text);
		expect(rendered?.render(400).join("\n")).toContain("backlog show tau-1");
	});

	it("renders valueless flags in calls", () => {
		const rendered = normalizeRendered(renderCall({ command: "children tau-epic --recursive" }));
		expect(rendered).toContain("backlog children tau-epic");
		expect(rendered).toContain("recursive: true");
	});

	it("renders search and children in help", () => {
		const rendered = normalizeRendered(
			renderResult({ command: "help", kind: "help", ok: true, outputText: "help" }),
		);
		expect(rendered).toContain("backlog search <query> [--limit 20]");
		expect(rendered).toContain("backlog children <id> [--recursive] [--status open] [--type task] [--limit 50]");
	});

	it("renders update calls and results with the compact issue summary layout", () => {
		const command =
			'update tau-kjk --description "Port the missing trustmate review area from the banana product page as a Storybook-friendly section: disclosure note, score summary cards, lightweight filter chrome, and review cards/list composition." --design "Do not attempt to recreate the whole third-party widget runtime. Instead, build honest presentational React components that capture the visible Frisco structure for trustmate reviews using plain typed props and story fixtures based on the banana reference fragment. Keep interactions shallow and local; focus on review cards, score summaries, filter chips/buttons, and section composition that can later be wired to real data or embedded widget decisions." --acceptance_criteria "The product-page component system includes typed Tailwind components and stories for the visible trustmate reviews section, including summary metrics and a review-list/card composition that matches the banana reference structure closely enough for later parity polish."';

		const callRendered = normalizeRendered(
			renderCall({
				command,
				cwd: "/home/ribelo/projects/retailic/frisco-effect",
			}),
		);
		// Header should only show verb + positional args
		expect(callRendered).toContain("backlog update tau-kjk");
		// Long flag values are truncated to 60 chars + ellipsis to keep the call
		// header compact. The full value is still visible in the result body.
		expect(callRendered).toContain("description: ");
		expect(callRendered).toContain("design: ");
		expect(callRendered).toContain("acceptance-criteria: ");
		expect(callRendered).toMatch(
			/description: Port the missing trustmate review area from the banana \S*\.\.\./,
		);
		expect(callRendered).toMatch(
			/design: Do not attempt to recreate the whole third-party widget \S*\.\.\./,
		);
		expect(callRendered).toMatch(
			/acceptance-criteria: The product-page component system includes typed/,
		);
		// Truncated portion (past the cut) must NOT appear in the call header.
		expect(callRendered).not.toContain("Storybook-friendly section");
		expect(callRendered).not.toContain("presentational React components");
		expect(callRendered).not.toContain("summary metrics");
		expect(callRendered).toContain("cwd: /home/ribelo/projects/retailic/frisco-effect");

		const resultRendered = normalizeRendered(
			renderResult({
				command,
				kind: "update",
				ok: true,
				data: {
					id: "tau-kjk",
					title: "Port product-page trustmate reviews section and review cards",
					status: "open",
					priority: 1,
					issue_type: "task",
					created_at: "2026-03-30T12:00:00.000Z",
					updated_at: "2026-03-30T12:00:00.000Z",
				},
			}),
		);
		expect(resultRendered).toContain("──────────────────────────────────────────────────────────────────────────────");
		expect(resultRendered).toContain("□  tau-kjk       [P1]    [task]      (open)");
		expect(resultRendered).toContain("Port product-page trustmate");
		expect(resultRendered).toContain("reviews section and review cards");
	});

	describe("truncateFlagValueForRenderCall", () => {
		it("leaves short values unchanged", () => {
			expect(truncateFlagValueForRenderCall("task")).toBe("task");
			expect(truncateFlagValueForRenderCall("")).toBe("");
		});

		it("truncates values longer than the default threshold", () => {
			const sixtyOneChars = "a".repeat(61);
			const out = truncateFlagValueForRenderCall(sixtyOneChars);
			expect(out.length).toBe(60);
			expect(out.endsWith("...")).toBe(true);
			expect(out).toBe(`${"a".repeat(57)}...`);
		});

		it("keeps values exactly at the default threshold unchanged", () => {
			const sixtyChars = "b".repeat(60);
			expect(truncateFlagValueForRenderCall(sixtyChars)).toBe(sixtyChars);
		});

		it("respects an explicit max", () => {
			expect(truncateFlagValueForRenderCall("abcdefghij", 5)).toBe("ab...");
		});

		it("handles a max so small that no characters fit before the ellipsis", () => {
			expect(truncateFlagValueForRenderCall("abcdefghij", 2)).toBe("...");
		});
	});

	it("renders short flag values verbatim in the call header (no ellipsis)", () => {
		const rendered = normalizeRendered(
			renderCall({
				command: 'create "Title" --type task --priority 1 --status open',
			}),
		);
		expect(rendered).toContain("backlog create Title");
		expect(rendered).toContain("type: task");
		expect(rendered).toContain("priority: 1");
		expect(rendered).toContain("status: open");
		expect(rendered).not.toContain("...");
	});

	it("renders every backlog result kind without throwing", () => {
		const cases: BacklogToolDetails[] = [
			{ command: "ready", kind: "ready", ok: true, data: [issue] },
			{ command: "list", kind: "list", ok: true, data: [issue] },
			{ command: "blocked", kind: "blocked", ok: true, data: [issue] },
			{ command: "children tau-1", kind: "children", ok: true, data: [issue] },
			{ command: "show tau-1", kind: "show", ok: true, data: { ...issue, notes: "note" } },
			{ command: "dep tree tau-1", kind: "dep_tree", ok: true, data: [{ ...issue, depth: 0 }] },
			{ command: "dep list tau-1", kind: "dep_list", ok: true, data: [issue] },
			{ command: "dep add tau-1 tau-2", kind: "dep_add", ok: true, data: { issue_id: "tau-1", depends_on_id: "tau-2", type: "blocks", status: "added" } },
			{ command: "dep remove tau-1 tau-2", kind: "dep_remove", ok: true, data: { issue_id: "tau-1", depends_on_id: "tau-2", type: "blocks", status: "removed" } },
			{ command: "create \"Issue\"", kind: "create", ok: true, data: issue },
			{ command: "update tau-1", kind: "update", ok: true, data: issue },
			{ command: "close tau-1", kind: "close", ok: true, data: { ...issue, status: "closed" } },
			{ command: "reopen tau-1", kind: "reopen", ok: true, data: issue },
			{ command: "status", kind: "status", ok: true, data: { total_issues: 1, open_issues: 1, in_progress_issues: 0, closed_issues: 0, blocked_issues: 0, ready_issues: 1, deferred_issues: 0, pinned_issues: 0 } },
			{ command: "comment tau-1", kind: "comment", ok: true, data: [{ id: 1, issue_id: "tau-1", author: "alice", text: "hello", created_at: "2026-03-29T12:00:00.000Z" }] },
			{ command: "comments tau-1", kind: "comments", ok: true, data: [{ id: 1, issue_id: "tau-1", author: "alice", text: "hello", created_at: "2026-03-29T12:00:00.000Z" }] },
			{ command: "search issue", kind: "search", ok: true, data: [issue] },
			{ command: "help", kind: "help", ok: true, outputText: "help" },
			{ command: "unknown", kind: "unknown", ok: false, outputText: "Unknown backlog command" },
			{ command: "error", kind: "error", ok: false, outputText: "Backlog command failed" },
		];

		for (const details of cases) {
			const rendered = renderResult(details);
			expect(rendered).toBeInstanceOf(Text);
			expect(() => rendered.render(400)).not.toThrow();
		}
	});

	it("renders partial results without details fallback safely", () => {
		const tool = createBacklogToolDefinition();
		const renderResultFn = tool.renderResult as unknown as (
			result: unknown,
			options: ToolRenderResultOptions,
			theme: Theme,
		) => Text;
		const rendered = renderResultFn({ content: [] }, { expanded: false, isPartial: true }, plainTheme);
		expect(rendered).toBeInstanceOf(Text);
		expect(rendered?.render(400).join("\n")).toContain("(no backlog details)");
	});
});
