import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text, type AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Effect } from "effect";

import {
	addIssueComment,
	addIssueDependency,
	BacklogCommandServiceForWorkspace,
	createIssue,
	removeIssueDependency,
	setIssueStatus,
	updateIssueFields,
} from "./events.js";
import { exportIssuesToMarkdown, type BacklogExportResult } from "./export.js";
import { listDependencies, listDependents } from "./graph.js";
import { filterIssues, type IssueQuery, type SortField, type SortOrder } from "./query.js";
import type { Comment, Issue } from "./schema.js";
import { BacklogCommandService, type BacklogCommandServiceApi } from "./services.js";

type Theme = {
	fg: (key: string, s: string) => string;
	bold: (s: string) => string;
};

type BacklogRenderKind =
	| "ready"
	| "list"
	| "blocked"
	| "children"
	| "show"
	| "dep_tree"
	| "dep_list"
	| "dep_add"
	| "dep_remove"
	| "create"
	| "update"
	| "close"
	| "reopen"
	| "status"
	| "comment"
	| "comments"
	| "search"
	| "export"
	| "help"
	| "unknown"
	| "error";

type BacklogTreeNode = Issue & {
	readonly depth: number;
};

type BacklogStatusSummary = {
	readonly total_issues: number;
	readonly open_issues: number;
	readonly in_progress_issues: number;
	readonly closed_issues: number;
	readonly blocked_issues: number;
	readonly ready_issues: number;
	readonly deferred_issues: number;
	readonly pinned_issues: number;
};

type BacklogDependencyMutation = {
	readonly issue_id: string;
	readonly depends_on_id: string;
	readonly type: string;
	readonly status: "added" | "removed";
};

export type BacklogToolDetails = {
	readonly command: string;
	readonly kind: BacklogRenderKind;
	readonly ok: boolean;
	readonly data?: unknown;
	readonly outputText?: string;
};

const BACKLOG_MESSAGE_TYPE = "backlog";

const TOOL_DESCRIPTION =
	"Backlog planning tool. Provide a CLI-style command without a leading tool name. Examples: `list`, `ready`, `blocked`, `show <id>`, `children <epic-id> --status open`, `create \"Title\" --type task --priority 2`, `update <id> --title \"New title\"`, `close <id> --reason \"Done\"`, `dep list <id> --direction down --status open`, `dep add <id-1> <id-2> --type blocks`, `comment <id> \"note\"`, `export [id] [--status open] [--output .backlog]`, `status`. Use `--status`, `--type`, `--priority`, and `--text` with issue-list commands. Use `--limit N` with list/ready/blocked/search/children to cap results.";

const TOOL_PROMPT_SNIPPET =
	"Backlog planning system for task tracking and event-sourced issue management";

const TOOL_PROMPT_GUIDELINES = [
	"Use the backlog tool for planning and issue tracking.",
	"Prefer ready work whose blockers are satisfied.",
	"Use `backlog show <id>` to inspect issue details before changing them.",
] as const;

const backlogParams = Type.Object({
	command: Type.String({
			description:
				"Backlog command to run. Omit any leading tool name. Examples: `list`, `ready`, `show <id>`, `children <epic-id>`, `create \"Title\" --type task`, `dep list <id> --direction down`, `dep add <id-1> <id-2> --type blocks`.",
	}),
	cwd: Type.Optional(
		Type.String({
			description: "Optional working directory that contains the backlog workspace.",
		}),
	),
});

type BacklogParams = {
	readonly command: string;
	readonly cwd?: string;
};

function decodeBacklogParams(rawParams: unknown): BacklogParams {
	return Value.Parse(backlogParams, rawParams);
}

function readBacklogArgString(args: unknown, key: "command" | "cwd"): string | undefined {
	if (typeof args !== "object" || args === null || !Object.hasOwn(args, key)) {
		return undefined;
	}
	const value = Reflect.get(args, key);
	return typeof value === "string" ? value : undefined;
}

const separator =
	"──────────────────────────────────────────────────────────────────────────────";

function statusKind(
	issue: Issue,
): "done" | "closed" | "in_progress" | "deferred" | "open" | "unknown" {
	const status = (issue.status ?? "").trim();
	if (!status) return "unknown";
	if (status === "in_progress") return "in_progress";
	if (status === "deferred") return "deferred";
	if (status === "open") return "open";
	if (status === "done") return "done";
	if (status === "closed" || status === "tombstone") return "closed";
	return "unknown";
}

function statusGlyph(issue: Issue): string {
	switch (statusKind(issue)) {
		case "done":
			return "✔";
		case "closed":
			return "■";
		case "in_progress":
			return "◐";
		case "deferred":
			return "◇";
		case "open":
			return "□";
		default:
			return "·";
	}
}

function statusGlyphThemed(issue: Issue, theme: Theme): string {
	const glyph = statusGlyph(issue);
	switch (statusKind(issue)) {
		case "done":
			return theme.fg("success", glyph);
		case "closed":
			return theme.fg("muted", glyph);
		case "in_progress":
			return theme.fg("accent", glyph);
		case "deferred":
			return theme.fg("muted", glyph);
		case "open":
			return theme.fg("dim", glyph);
		default:
			return theme.fg("dim", glyph);
	}
}

function renderIssueInline(issue: Issue, theme: Theme): string {
	const mark = statusGlyphThemed(issue, theme);
	const id = issue.id.padEnd(12);
	const prio = `[P${issue.priority ?? "?"}]`.padEnd(6);
	const type = `[${issue.issue_type ?? "?"}]`.padEnd(10);
	const status = `(${issue.status ?? "???"})`.padEnd(14);
	return `${mark}  ${theme.fg("accent", id)}  ${theme.fg("muted", prio)}  ${theme.fg("muted", type)}  ${theme.fg("dim", status)}  ${theme.fg("toolOutput", issue.title)}`;
}

function renderIssuesBlock(issues: ReadonlyArray<Issue>, options: { expanded: boolean }, theme: Theme): Text {
	const shown = options.expanded ? issues : issues.slice(0, 10);
	let out = theme.fg("dim", separator);
	for (const issue of shown) {
		out += `\n${renderIssueInline(issue, theme)}`;
	}
	if (issues.length === 0) {
		out += `\n${theme.fg("muted", "No issues found")}`;
	}
	if (!options.expanded && issues.length > shown.length) {
		out += `\n${theme.fg("dim", `… ${issues.length - shown.length} more (expand to view)`)}`;
	}
	return new Text(out, 0, 0);
}

function renderTreeBlock(nodes: ReadonlyArray<BacklogTreeNode>, options: { expanded: boolean }, theme: Theme): Text {
	const shown = options.expanded ? nodes : nodes.slice(0, 50);
	let out = theme.fg("dim", separator);
	for (const node of shown) {
		out += `\n${"  ".repeat(Math.max(0, node.depth))}${renderIssueInline(node, theme)}`;
	}
	if (nodes.length === 0) {
		out += `\n${theme.fg("muted", "No related issues found")}`;
	}
	if (!options.expanded && nodes.length > shown.length) {
		out += `\n${theme.fg("dim", `… ${nodes.length - shown.length} more (expand to view)`)}`;
	}
	return new Text(out, 0, 0);
}

function renderIssueDetails(issue: Issue, theme: Theme): Text {
	let out = theme.fg("dim", separator);
	out += `\n${renderIssueInline(issue, theme)}`;

	const fields: Array<[string, string | number | undefined]> = [
		["Owner", issue.owner],
		["Assignee", issue.assignee],
		["Created", issue.created_at],
		["Updated", issue.updated_at],
		["Closed", issue.closed_at],
		["Reason", issue.close_reason],
	];
	for (const [label, value] of fields) {
		if (value !== undefined) {
			out += `\n${theme.fg("toolTitle", `${label}:`)} ${theme.fg("toolOutput", String(value))}`;
		}
	}
	if (issue.description) {
		out += `\n\n${theme.fg("toolTitle", "Description")}`;
		out += `\n${issue.description}`;
	}
	if (issue.design) {
		out += `\n\n${theme.fg("toolTitle", "Design")}`;
		out += `\n${issue.design}`;
	}
	if (issue.acceptance_criteria) {
		out += `\n\n${theme.fg("toolTitle", "Acceptance Criteria")}`;
		out += `\n${issue.acceptance_criteria}`;
	}
	if (issue.notes) {
		out += `\n\n${theme.fg("toolTitle", "Notes")}`;
		out += `\n${issue.notes}`;
	}
	if ((issue.labels ?? []).length > 0) {
		out += `\n\n${theme.fg("toolTitle", "Labels")}`;
		out += `\n${(issue.labels ?? []).join(", ")}`;
	}
	if ((issue.dependencies ?? []).length > 0) {
		out += `\n\n${theme.fg("toolTitle", "Dependencies")}`;
		for (const dep of issue.dependencies ?? []) {
			out += `\n- ${dep.depends_on_id} (${dep.type})`;
		}
	}
	if ((issue.comments ?? []).length > 0) {
		out += `\n\n${theme.fg("toolTitle", "Comments")}`;
		for (const comment of issue.comments ?? []) {
			out += `\n- ${comment.author}: ${comment.text}`;
		}
	}
	return new Text(out, 0, 0);
}

function renderCommentsBlock(comments: ReadonlyArray<Comment>, theme: Theme): Text {
	let out = theme.fg("dim", separator);
	if (comments.length === 0) {
		out += `\n${theme.fg("muted", "No comments found")}`;
		return new Text(out, 0, 0);
	}
	for (const comment of comments) {
		out += `\n${theme.fg("toolTitle", "Comment")} ${theme.fg("accent", `#${comment.id}`)} by ${theme.fg("accent", comment.author)} on ${theme.fg("dim", comment.created_at)}`;
		out += `\n${comment.text}\n`;
	}
	return new Text(out.trimEnd(), 0, 0);
}

function renderDependencyMutation(details: BacklogDependencyMutation, theme: Theme): Text {
	let out = theme.fg("dim", separator);
	const status = details.status === "added" ? theme.fg("success", "✔ Added") : theme.fg("warning", "✘ Removed");
	out += `\n${status} dependency: ${theme.fg("accent", details.issue_id)} ➔ ${theme.fg("accent", details.depends_on_id)} (${details.type})`;
	return new Text(out, 0, 0);
}

function renderStatusBlock(summary: BacklogStatusSummary, theme: Theme): Text {
	let out = theme.fg("dim", separator);
	const row = (label: string, value: number) => `\n  ${label.padEnd(20)}: ${theme.fg("toolOutput", String(value))}`;
	out += row("Total Issues", summary.total_issues);
	out += row("Open", summary.open_issues);
	out += row("In Progress", summary.in_progress_issues);
	out += row("Closed", summary.closed_issues);
	out += row("Blocked", summary.blocked_issues);
	out += row("Ready", summary.ready_issues);
	out += row("Deferred", summary.deferred_issues);
	out += row("Pinned", summary.pinned_issues);
	return new Text(out, 0, 0);
}

function renderExportBlock(result: BacklogExportResult, theme: Theme): Text {
	let out = theme.fg("dim", separator);
	out += `\n${theme.fg("success", `Exported ${result.count} issue${result.count === 1 ? "" : "s"}`)}`;
	for (const file of result.files) {
		out += `\n${theme.fg("toolOutput", file)}`;
	}
	return new Text(out, 0, 0);
}

function renderHelpBlock(theme: Theme): Text {
	const lines = [
		theme.fg("dim", separator),
		"backlog list [--status open] [--type task] [--priority 2] [--text query] [--limit 20]",
		"backlog ready [--limit 20]",
		"backlog blocked [--limit 20]",
		"backlog search <query> [--limit 20]",
		"backlog show <id>",
		"backlog children <id> [--recursive] [--status open] [--type task] [--limit 50]",
		'backlog create "Title" [--type task] [--priority 2] [--description "..."]',
		'backlog update <id> [--title "..."] [--status open] [--priority 1] [--unset notes]',
		'backlog close <id> [--reason "..."]',
		"backlog reopen <id>",
		"backlog dep list <id> [--direction up|down] [--status open] [--type task]",
		"backlog dep tree <id> [--direction up|down] [--status open] [--type task]",
		"backlog dep add <id> <target> [--type blocks]",
		"backlog dep remove <id> <target> [--type blocks]",
		'backlog comment <id> "text"',
		"backlog comments <id>",
		"backlog export [id] [--status open] [--type task] [--priority 2] [--text query] [--output .backlog]",
		"backlog status",
	];
	return new Text(lines.join("\n"), 0, 0);
}

function renderError(text: string, theme: Theme): Text {
	return new Text(`${theme.fg("dim", separator)}\n${theme.fg("warning", text)}`, 0, 0);
}

function stripLeadingPrompt(input: string): string {
	const trimmed = input.trim();
	if (trimmed.startsWith("$ ")) return trimmed.slice(2).trim();
	if (trimmed.startsWith("$")) return trimmed.slice(1).trim();
	return trimmed;
}

function shellSplit(input: string): string[] {
	const out: string[] = [];
	let current = "";
	let mode: "none" | "single" | "double" = "none";
	let escaped = false;

	const flush = (): void => {
		if (current.length > 0) out.push(current);
		current = "";
	};

	for (let index = 0; index < input.length; index += 1) {
		const ch = input[index]!;
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && mode !== "single") {
			escaped = true;
			continue;
		}
		if (mode === "single") {
			if (ch === "'") mode = "none";
			else current += ch;
			continue;
		}
		if (mode === "double") {
			if (ch === '"') mode = "none";
			else current += ch;
			continue;
		}
		if (ch === "'") {
			mode = "single";
			continue;
		}
		if (ch === '"') {
			mode = "double";
			continue;
		}
		if (ch === " " || ch === "\n" || ch === "\t") {
			flush();
			continue;
		}
		current += ch;
	}
	flush();
	return out;
}

function stripLeadingBacklog(tokens: ReadonlyArray<string>): string[] {
	const remaining = [...tokens];
	while (remaining[0] === "") {
		remaining.shift();
	}
	if (remaining[0] === "backlog") {
		return remaining.slice(1);
	}
	return remaining;
}

type ParsedCommand = {
	readonly raw: string;
	readonly positional: ReadonlyArray<string>;
	readonly flags: ReadonlyMap<string, ReadonlyArray<string>>;
};

function parseCommand(command: string): ParsedCommand {
	const raw = stripLeadingPrompt(command);
	const tokens = stripLeadingBacklog(shellSplit(raw));
	const positional: string[] = [];
	const flags = new Map<string, string[]>();

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token.startsWith("-")) {
			const [rawKey, inlineValue] = token.split("=", 2) as [string, string | undefined];
			const key = rawKey.replace(/^-+/u, "").replace(/-/gu, "_");
			const values = flags.get(key) ?? [];
			if (inlineValue !== undefined) {
				values.push(inlineValue);
				flags.set(key, values);
				continue;
			}
			const next = tokens[index + 1];
			if (next !== undefined && !next.startsWith("-")) {
				values.push(next);
				index += 1;
			}
			flags.set(key, values);
			continue;
		}
		positional.push(token);
	}

	return { raw, positional, flags };
}

function flagValues(parsed: ParsedCommand, ...names: ReadonlyArray<string>): ReadonlyArray<string> {
	for (const name of names) {
		const values = parsed.flags.get(name.replace(/-/gu, "_"));
		if (values !== undefined) {
			return values;
		}
	}
	return [];
}

function flagValue(parsed: ParsedCommand, ...names: ReadonlyArray<string>): string | undefined {
	const values = flagValues(parsed, ...names);
	return values.length > 0 ? values[values.length - 1] : undefined;
}

function commandKind(parsed: ParsedCommand): BacklogRenderKind {
	const [first, second] = parsed.positional;
	if (!first || first === "help") return "help";
	if (first === "ready") return "ready";
	if (first === "list") return "list";
	if (first === "blocked") return "blocked";
	if (first === "children") return "children";
	if (first === "show") return "show";
	if (first === "create") return "create";
	if (first === "update") return "update";
	if (first === "close") return "close";
	if (first === "reopen") return "reopen";
	if (first === "status") return "status";
	if (first === "search") return "search";
	if (first === "export") return "export";
	if (first === "comment") return "comment";
	if (first === "comments") return "comments";
	if (first === "dep" && second === "list") return "dep_list";
	if (first === "dep" && second === "tree") return "dep_tree";
	if (first === "dep" && second === "add") return "dep_add";
	if (first === "dep" && second === "remove") return "dep_remove";
	return "unknown";
}

function parseNumber(value: string | undefined, flagName: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid numeric value for --${flagName.replace(/_/gu, "-")}: ${value}`);
	}
	return parsed;
}

function issueFilterQueryFromFlags(parsed: ParsedCommand): IssueQuery {
	const status = flagValue(parsed, "status");
	const issueType = flagValue(parsed, "type", "issue_type");
	const priority = parseNumber(flagValue(parsed, "priority"), "priority");
	const textQuery = flagValue(parsed, "text");
	return {
		...(status !== undefined ? { status } : {}),
		...(issueType !== undefined ? { type: issueType } : {}),
		...(priority !== undefined ? { priority } : {}),
		...(textQuery ? { text: textQuery } : {}),
	};
}

function filterIssueListByFlags(
	issues: ReadonlyArray<Issue>,
	parsed: ParsedCommand,
): ReadonlyArray<Issue> {
	const query = issueFilterQueryFromFlags(parsed);
	if (Object.keys(query).length === 0) {
		return issues;
	}
	const matchingIds = new Set(filterIssues(issues, query).map((issue) => issue.id));
	return issues.filter((issue) => matchingIds.has(issue.id));
}

async function runWithBacklogCommandService<A>(
	workspaceRoot: string,
	run: (service: BacklogCommandServiceApi) => Effect.Effect<A, unknown, never>,
): Promise<A> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const service = yield* BacklogCommandService;
			return yield* run(service);
		}).pipe(Effect.provide(BacklogCommandServiceForWorkspace(workspaceRoot))),
	);
}

function dependencyDirection(parsed: ParsedCommand): "up" | "down" {
	const direction = flagValue(parsed, "direction");
	if (direction === undefined || direction === "up" || direction === "down") {
		return direction ?? "up";
	}
	throw new Error(`Invalid dependency direction: ${direction}`);
}

function formatBacklogError(error: unknown): string {
	if (typeof error === "object" && error !== null) {
		const record = error as Record<string, unknown>;
		const reason = record["reason"];
		if (typeof reason === "string" && reason.trim().length > 0) {
			return reason;
		}
	}

	if (error instanceof Error && error.message.trim().length > 0) {
		return error.message;
	}

	if (typeof error === "object" && error !== null) {
		const record = error as Record<string, unknown>;
		const reason = record["reason"];
		if (typeof reason === "string" && reason.trim().length > 0) {
			return reason;
		}
		const usage = record["usage"];
		if (typeof usage === "string" && usage.trim().length > 0) {
			return usage;
		}
		const issueId = record["issueId"];
		if (typeof issueId === "string" && issueId.trim().length > 0) {
			return `Issue not found: ${issueId}`;
		}
		const tag = record["_tag"];
		if (typeof tag === "string" && tag.trim().length > 0) {
			return tag;
		}
	}

	if (error instanceof Error && error.name.trim().length > 0) {
		return error.name;
	}

	const rendered = String(error);
	return rendered.trim().length > 0 ? rendered : "Backlog command failed";
}

function buildDependencyTree(
	issueId: string,
	issues: ReadonlyArray<Issue>,
	direction: "up" | "down",
): ReadonlyArray<BacklogTreeNode> {
	const byId = new Map(issues.map((issue) => [issue.id, issue]));
	const root = byId.get(issueId);
	if (!root) {
		return [];
	}
	const visited = new Set<string>();
	const nodes: BacklogTreeNode[] = [];
	const related = (id: string): ReadonlyArray<Issue> =>
		direction === "up" ? listDependencies(id, issues) : listDependents(id, issues);

	const visit = (id: string, depth: number): void => {
		const issue = byId.get(id);
		if (!issue) {
			return;
		}
		nodes.push({ ...issue, depth });
		if (visited.has(id)) {
			return;
		}
		visited.add(id);
		for (const next of related(id)) {
			visit(next.id, depth + 1);
		}
	};

	visit(root.id, 0);
	return nodes;
}

function listParentChildChildren(
	issueId: string,
	issues: ReadonlyArray<Issue>,
	recursive: boolean,
): ReadonlyArray<Issue> {
	const childrenOf = (parentId: string): ReadonlyArray<Issue> =>
		issues.filter((issue) =>
			(issue.dependencies ?? []).some(
				(dependency) =>
					dependency.type === "parent-child" && dependency.depends_on_id === parentId,
			),
		);

	if (!recursive) {
		return childrenOf(issueId);
	}

	const result: Issue[] = [];
	const visited = new Set<string>();
	const visit = (parentId: string): void => {
		for (const child of childrenOf(parentId)) {
			if (visited.has(child.id)) {
				continue;
			}
			visited.add(child.id);
			result.push(child);
			visit(child.id);
		}
	};

	visit(issueId);
	return result;
}

function createFieldsFromFlags(parsed: ParsedCommand): Readonly<Record<string, unknown>> {
	const fields: Record<string, unknown> = {};
	const assignString = (field: string, ...flags: ReadonlyArray<string>): void => {
		const value = flagValue(parsed, ...flags);
		if (value !== undefined) {
			fields[field] = value;
		}
	};
	assignString("description", "description");
	assignString("design", "design");
	assignString("acceptance_criteria", "acceptance_criteria", "acceptance-criteria");
	assignString("notes", "notes");
	assignString("issue_type", "type", "issue_type", "issue-type");
	assignString("status", "status");
	assignString("owner", "owner");
	assignString("assignee", "assignee");
	assignString("title", "title");
	const priority = parseNumber(flagValue(parsed, "priority"), "priority");
	if (priority !== undefined) {
		fields["priority"] = priority;
	}
	const labels = flagValues(parsed, "label", "labels");
	if (labels.length > 0) {
		fields["labels"] = labels;
	}
	return fields;
}

export async function runBacklogCommand(command: string, cwd: string): Promise<BacklogToolDetails> {
	const workspaceRoot = cwd;
	const projectName = basename(workspaceRoot);
	const parsed = parseCommand(command);
	const kind = commandKind(parsed);

	try {
		switch (kind) {
			case "help": {
				return { command, kind, ok: true, outputText: "help" };
			}
			case "list":
			case "ready":
			case "blocked":
			case "search": {
				const issueFilters = issueFilterQueryFromFlags(parsed);
				const textQuery =
					kind === "search"
						? parsed.positional.slice(1).join(" ") || flagValue(parsed, "text")
						: flagValue(parsed, "text");
				const sortBy = flagValue(parsed, "sort", "sort_by") as SortField | undefined;
				const order = flagValue(parsed, "order") as SortOrder | undefined;
				const limitInput = parseNumber(flagValue(parsed, "limit"), "limit");
				const limit = limitInput ?? 20;
				const query: IssueQuery = {
					...issueFilters,
					...(textQuery ? { text: textQuery } : {}),
					...(kind === "ready" ? { ready: true } : {}),
					...(kind === "blocked" ? { blocked: true } : {}),
					...(sortBy !== undefined ? { sortBy } : {}),
					...(order !== undefined ? { order } : {}),
				};
				const commandServiceIssues = await runWithBacklogCommandService(workspaceRoot, (service) =>
					service.list(query),
				);
				return { command, kind, ok: true, data: commandServiceIssues.slice(0, limit) };
			}
			case "export": {
				const issueId = parsed.positional[1];
				const output = flagValue(parsed, "output");
				const issues = issueId
					? [await runWithBacklogCommandService(workspaceRoot, (service) => service.show(issueId))]
					: await runWithBacklogCommandService(workspaceRoot, (service) =>
						service.list(issueFilterQueryFromFlags(parsed)),
					);
				const result = exportIssuesToMarkdown(workspaceRoot, issues, output);
				return { command, kind, ok: true, data: result };
			}
			case "show": {
				const issueId = parsed.positional[1];
				if (!issueId) {
					throw new Error("Usage: backlog show <id>");
				}
				const issue = await runWithBacklogCommandService(workspaceRoot, (service) => service.show(issueId));
				return { command, kind, ok: true, data: issue };
			}
			case "children": {
				const issueId = parsed.positional[1];
				if (!issueId) {
					throw new Error("Usage: backlog children <id> [--recursive] [--status open] [--limit 50]");
				}
				const issues = await runWithBacklogCommandService(workspaceRoot, (service) => service.list({}));
				await runWithBacklogCommandService(workspaceRoot, (service) => service.show(issueId));
				const recursive = parsed.flags.has("recursive");
				const limit = parseNumber(flagValue(parsed, "limit"), "limit") ?? 50;
				const children = filterIssueListByFlags(listParentChildChildren(issueId, issues, recursive), parsed);
				return { command, kind, ok: true, data: children.slice(0, limit) };
			}
			case "create": {
				const title = parsed.positional.slice(1).join(" ") || flagValue(parsed, "title");
				if (!title) {
					throw new Error("Usage: backlog create \"Title\" [--type task] [--priority 2]");
				}
				const createInput: {
					title: string;
					actor: string;
					prefix: string;
					id?: string;
					fields: Readonly<Record<string, unknown>>;
				} = {
					title,
					actor: "backlog",
					prefix: projectName,
					fields: createFieldsFromFlags(parsed),
				};
				const explicitId = flagValue(parsed, "id");
				if (explicitId !== undefined) {
					createInput.id = explicitId;
				}
				const issue = await Effect.runPromise(createIssue(workspaceRoot, createInput));
				return { command, kind, ok: true, data: issue };
			}
			case "update": {
				const issueId = parsed.positional[1];
				if (!issueId) {
					throw new Error("Usage: backlog update <id> [--title ...] [--status ...]");
				}
				const unsetFields = flagValues(parsed, "unset").map((field) => field.replace(/-/gu, "_"));
				const patch = createFieldsFromFlags(parsed);
				const updateOptions: { unsetFields?: ReadonlyArray<string> } = {};
				if (unsetFields.length > 0) {
					updateOptions.unsetFields = unsetFields;
				}
				const updated = await Effect.runPromise(
					updateIssueFields(workspaceRoot, issueId, "tau-backlog", patch, updateOptions),
				);
				return { command, kind, ok: true, data: updated };
			}
			case "close": {
				const issueId = parsed.positional[1];
				if (!issueId) {
					throw new Error("Usage: backlog close <id> [--reason ...]");
				}
				const statusInput: {
					issueId: string;
					actor: string;
					status: string;
					reason?: string;
				} = {
					issueId,
					actor: "backlog",
					status: "closed",
				};
				const reason = flagValue(parsed, "reason");
				if (reason !== undefined) {
					statusInput.reason = reason;
				}
				const closed = await Effect.runPromise(setIssueStatus(workspaceRoot, statusInput));
				return { command, kind, ok: true, data: closed };
			}
			case "reopen": {
				const issueId = parsed.positional[1];
				if (!issueId) {
					throw new Error("Usage: backlog reopen <id>");
				}
				const reopened = await Effect.runPromise(setIssueStatus(workspaceRoot, {
					issueId,
					actor: "backlog",
					status: "open",
				}));
				return { command, kind, ok: true, data: reopened };
			}
			case "comment": {
				const issueId = parsed.positional[1];
				const text = parsed.positional.slice(2).join(" ") || flagValue(parsed, "text");
				if (!issueId || !text) {
					throw new Error("Usage: backlog comment <id> \"text\"");
				}
				const issue = await Effect.runPromise(addIssueComment(workspaceRoot, {
					issueId,
					actor: "backlog",
					text,
				}));
				const comment = issue.comments?.at(-1);
				return { command, kind, ok: true, data: comment ? [comment] : [] };
			}
			case "comments": {
				const issueId = parsed.positional[1];
				if (!issueId) {
					throw new Error("Usage: backlog comments <id>");
				}
				const issue = await runWithBacklogCommandService(workspaceRoot, (service) => service.show(issueId));
				return { command, kind, ok: true, data: issue.comments ?? [] };
			}
			case "dep_add": {
				const issueId = parsed.positional[2];
				const dependsOnId = parsed.positional[3];
				if (!issueId || !dependsOnId) {
					throw new Error("Usage: backlog dep add <id> <target> [--type blocks]");
				}
				await Effect.runPromise(addIssueDependency(workspaceRoot, {
					issueId,
					actor: "backlog",
					dependsOnId,
					type: flagValue(parsed, "type") ?? "blocks",
				}));
				const mutation: BacklogDependencyMutation = {
					issue_id: issueId,
					depends_on_id: dependsOnId,
					type: flagValue(parsed, "type") ?? "blocks",
					status: "added",
				};
				return { command, kind, ok: true, data: mutation };
			}
			case "dep_remove": {
				const issueId = parsed.positional[2];
				const dependsOnId = parsed.positional[3];
				if (!issueId || !dependsOnId) {
					throw new Error("Usage: backlog dep remove <id> <target> [--type blocks]");
				}
				const removeInput: {
					issueId: string;
					actor: string;
					dependsOnId: string;
					type?: string;
				} = {
					issueId,
					actor: "backlog",
					dependsOnId,
				};
				const dependencyType = flagValue(parsed, "type");
				if (dependencyType !== undefined) {
					removeInput.type = dependencyType;
				}
				await Effect.runPromise(removeIssueDependency(workspaceRoot, removeInput));
				const mutation: BacklogDependencyMutation = {
					issue_id: issueId,
					depends_on_id: dependsOnId,
					type: flagValue(parsed, "type") ?? "blocks",
					status: "removed",
				};
				return { command, kind, ok: true, data: mutation };
			}
			case "dep_list":
			case "dep_tree": {
				const issueId = parsed.positional[2];
				if (!issueId) {
					throw new Error(
						`Usage: backlog dep ${kind === "dep_tree" ? "tree" : "list"} <id> [--direction up|down] [--status open]`,
					);
				}
				const issues = await runWithBacklogCommandService(workspaceRoot, (service) => service.list({}));
				await runWithBacklogCommandService(workspaceRoot, (service) => service.show(issueId));
				const direction = dependencyDirection(parsed);
				const related = filterIssueListByFlags(
					direction === "up" ? listDependencies(issueId, issues) : listDependents(issueId, issues),
					parsed,
				);
				if (kind === "dep_tree") {
					return {
						command,
						kind,
						ok: true,
						data: filterIssueListByFlags(buildDependencyTree(issueId, issues, direction), parsed),
					};
				}
				return { command, kind, ok: true, data: related };
			}
			case "status": {
				const summary = await runWithBacklogCommandService(workspaceRoot, (service) => service.status());
				const output: BacklogStatusSummary = {
					total_issues: summary.total,
					open_issues: summary.open,
					in_progress_issues: summary.inProgress,
					closed_issues: summary.closed,
					blocked_issues: summary.blocked,
					ready_issues: summary.ready,
					deferred_issues: summary.deferred,
					pinned_issues: summary.pinned,
				};
				return { command, kind, ok: true, data: output };
			}
			case "unknown":
			default:
				return {
					command,
					kind: kind === "unknown" ? "unknown" : kind,
					ok: false,
					outputText: `Unknown backlog command: ${parsed.raw || "(empty)"}`,
				};
		}
	} catch (error) {
		return {
			command,
			kind: kind === "unknown" ? "error" : kind,
			ok: false,
			outputText: formatBacklogError(error),
		};
	}
}

function formatBacklogDetailsAsText(details: BacklogToolDetails): string {
	if (details.data !== undefined) {
		return JSON.stringify(details.data, null, 2);
	}
	return details.outputText ?? "(no output)";
}

function renderBacklog(details: BacklogToolDetails, options: { expanded: boolean }, theme: Theme): Text {
	if (!details.ok) {
		return renderError(details.outputText ?? "Backlog command failed", theme);
	}

	switch (details.kind) {
		case "help":
			return renderHelpBlock(theme);
		case "export":
			return renderExportBlock(details.data as BacklogExportResult, theme);
		case "status":
			return renderStatusBlock(details.data as BacklogStatusSummary, theme);
		case "comment":
		case "comments":
			return renderCommentsBlock((details.data as ReadonlyArray<Comment> | undefined) ?? [], theme);
		case "dep_add":
		case "dep_remove":
			return renderDependencyMutation(details.data as BacklogDependencyMutation, theme);
		case "show":
			return renderIssueDetails(details.data as Issue, theme);
		case "dep_tree":
			return renderTreeBlock((details.data as ReadonlyArray<BacklogTreeNode> | undefined) ?? [], options, theme);
		case "list":
		case "ready":
		case "blocked":
		case "children":
		case "search":
		case "dep_list":
		case "create":
		case "update":
		case "close":
		case "reopen": {
			const issues = Array.isArray(details.data) ? (details.data as ReadonlyArray<Issue>) : [details.data as Issue];
			return renderIssuesBlock(issues, options, theme);
		}
		default:
			return new Text(`${theme.fg("dim", separator)}\n${formatBacklogDetailsAsText(details)}`, 0, 0);
	}
}

function createCompletionItems(): ReadonlyArray<AutocompleteItem> {
	return [
		{ value: "list", label: "list", description: "List issues" },
		{ value: "ready", label: "ready", description: "List ready issues" },
		{ value: "blocked", label: "blocked", description: "List blocked issues" },
		{ value: "children ", label: "children", description: "List child issues" },
		{ value: "show ", label: "show", description: "Show issue" },
		{ value: "create ", label: "create", description: "Create issue" },
		{ value: "update ", label: "update", description: "Update issue" },
		{ value: "close ", label: "close", description: "Close issue" },
		{ value: "reopen ", label: "reopen", description: "Reopen issue" },
		{ value: "dep list ", label: "dep list", description: "List dependencies" },
		{ value: "dep tree ", label: "dep tree", description: "Dependency tree" },
		{ value: "dep add ", label: "dep add", description: "Add dependency" },
		{ value: "dep remove ", label: "dep remove", description: "Remove dependency" },
		{ value: "comment ", label: "comment", description: "Add comment" },
		{ value: "comments ", label: "comments", description: "List comments" },
		{ value: "export ", label: "export", description: "Export issues to markdown" },
		{ value: "status", label: "status", description: "Show summary" },
		{ value: "help", label: "help", description: "Show help" },
	];
}

export function renderBacklogResult(
	details: BacklogToolDetails,
	options: { expanded: boolean },
	theme: Theme,
): Text {
	return renderBacklog(details, options, theme);
}

export function createBacklogToolDefinition(): ToolDefinition {
	return {
		name: "backlog",
		label: "backlog",
		description: TOOL_DESCRIPTION,
		promptSnippet: TOOL_PROMPT_SNIPPET,
		promptGuidelines: [...TOOL_PROMPT_GUIDELINES],
		parameters: backlogParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const decodedParams = decodeBacklogParams(params);
			const details = await runBacklogCommand(decodedParams.command, decodedParams.cwd ?? ctx.cwd);
			return {
				content: [{ type: "text", text: formatBacklogDetailsAsText(details) }],
				details,
			};
		},

		renderCall(args, theme) {
			const rawCmd = readBacklogArgString(args, "command")?.trim() ?? "";
			const parsed = parseCommand(rawCmd);

			// Build header: backlog <verb> <positional args...>
			const verb = parsed.positional[0] ?? "";
			const positionalArgs = parsed.positional.slice(1);

			// Format positional args
			const formattedPositional = positionalArgs.map((arg) => arg);

			const headerParts = ["backlog", verb, ...formattedPositional];
			let out = theme.fg("toolTitle", theme.bold(headerParts.join(" ").trim()));

			// Render flags below the header
			const flagsToSkip = new Set(["cwd"]);
			for (const [key, values] of parsed.flags) {
				if (flagsToSkip.has(key)) continue;

				// Convert snake_case to display name (e.g., "issue_type" -> "type")
				let displayKey = key;
				if (key === "issue_type") displayKey = "type";
				else if (key === "acceptance_criteria") displayKey = "acceptance-criteria";

				// Use the last value for single-value flags; valueless flags are boolean true.
				const value = values.length > 0 ? values[values.length - 1] : "true";
				if (value === undefined) continue;

				out += `\n  ${theme.fg("toolTitle", `${displayKey}:`)} ${theme.fg("toolOutput", value)}`;
			}

			const cwd = readBacklogArgString(args, "cwd");
			if (cwd) {
				out += `\n${theme.fg("muted", `cwd: ${cwd}`)}`;
			}
			return new Text(out, 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as BacklogToolDetails | undefined;
			if (!details) {
				return new Text(theme.fg("dim", "(no backlog details)"), 0, 0);
			}
			return renderBacklog(details, options, theme as Theme);
		},
	};
}

export default function initBacklog(pi: ExtensionAPI): void {
	pi.on("context", async (event) => ({
		messages: event.messages.filter(
			(message) => !(message?.role === "custom" && message?.customType === BACKLOG_MESSAGE_TYPE),
		),
	}));

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: `Backlog integration: Prefer the \`backlog\` tool for planning operations.\n\n${event.systemPrompt}`,
	}));

	pi.registerCommand("backlog", {
		description: "backlog wrapper: /backlog <command>",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const normalized = prefix.toLowerCase();
			const matches = createCompletionItems().filter((item) => item.value.toLowerCase().startsWith(normalized));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx: ExtensionContext) => {
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /backlog list | /backlog show <id> | /backlog export", "info");
				return;
			}
			const details = await runBacklogCommand(trimmed, ctx.cwd);
			pi.sendMessage(
				{
					customType: BACKLOG_MESSAGE_TYPE,
					content: `backlog ${trimmed}`,
					display: true,
					details,
				},
				{ triggerTurn: false },
			);
		},
	});

	pi.registerMessageRenderer<BacklogToolDetails>(BACKLOG_MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details;
		if (!details) {
			return new Text(theme.fg("dim", "(no backlog details)"), 0, 0);
		}
		return renderBacklog(details, options, theme as Theme);
	});

	pi.registerTool(createBacklogToolDefinition());
}
