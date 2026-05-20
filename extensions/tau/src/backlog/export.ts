import * as path from "node:path";

import { stringify as stringifyYaml } from "yaml";

import { atomicWriteFileStringSync } from "../shared/atomic-write.js";
import type { Issue } from "./schema.js";

export type BacklogExportResult = {
	readonly count: number;
	readonly files: ReadonlyArray<string>;
};

const bodyFields = new Set(["description", "design", "acceptance_criteria", "notes"]);

function issueRecord(issue: Issue): Readonly<Record<string, unknown>> {
	return issue;
}

function copyIfPresent(
	source: Readonly<Record<string, unknown>>,
	target: Record<string, unknown>,
	key: string,
): void {
	if (Object.hasOwn(source, key)) {
		target[key] = source[key];
	}
}

function issueFrontmatter(issue: Issue): Readonly<Record<string, unknown>> {
	const source = issueRecord(issue);
	const frontmatter: Record<string, unknown> = {
		id: issue.id,
		title: issue.title,
	};

	const preferredKeys = [
		"status",
		"priority",
		"issue_type",
		"assignee",
		"owner",
		"estimated_minutes",
		"labels",
		"created_at",
		"created_by",
		"updated_at",
		"closed_at",
		"close_reason",
		"closed_by_session",
		"due_at",
		"defer_until",
		"external_ref",
		"source_system",
		"pinned",
		"dependencies",
		"comments",
	] as const;

	for (const key of preferredKeys) {
		copyIfPresent(source, frontmatter, key);
	}

	for (const key of Object.keys(source).sort()) {
		if (Object.hasOwn(frontmatter, key) || bodyFields.has(key)) {
			continue;
		}
		copyIfPresent(source, frontmatter, key);
	}

	return frontmatter;
}

function markdownSection(title: string, content: string | undefined): string | undefined {
	const trimmed = content?.trim();
	if (!trimmed) {
		return undefined;
	}
	return `## ${title}\n\n${trimmed}`;
}

export function serializeIssueToMarkdown(issue: Issue): string {
	const frontmatterYaml = stringifyYaml(issueFrontmatter(issue)).trimEnd();
	const sections = [
		markdownSection("description", issue.description),
		markdownSection("design", issue.design),
		markdownSection("acceptance criteria", issue.acceptance_criteria),
		markdownSection("notes", issue.notes),
	].filter((section): section is string => section !== undefined);

	const body =
		sections.length > 0
			? `\n\n# ${issue.title}\n\n${sections.join("\n\n")}\n`
			: `\n\n# ${issue.title}\n`;
	return `---\n${frontmatterYaml}\n---${body}`;
}

function resolveOutputPath(workspaceRoot: string, output: string | undefined): string | undefined {
	if (output === undefined) {
		return undefined;
	}
	return path.isAbsolute(output) ? output : path.join(workspaceRoot, output);
}

function isMarkdownPath(outputPath: string): boolean {
	return path.extname(outputPath).toLowerCase() === ".md";
}

function defaultIssuePath(workspaceRoot: string, issue: Issue): string {
	return path.join(workspaceRoot, ".backlog", `${issue.id}.md`);
}

function outputPathForIssue(
	workspaceRoot: string,
	issue: Issue,
	selectedOutputPath: string | undefined,
	issueCount: number,
): string {
	if (selectedOutputPath === undefined) {
		return defaultIssuePath(workspaceRoot, issue);
	}
	if (issueCount === 1 && isMarkdownPath(selectedOutputPath)) {
		return selectedOutputPath;
	}
	if (issueCount > 1 && isMarkdownPath(selectedOutputPath)) {
		throw new Error("--output must be a directory when exporting multiple issues");
	}
	return path.join(selectedOutputPath, `${issue.id}.md`);
}

export function exportIssuesToMarkdown(
	workspaceRoot: string,
	issues: ReadonlyArray<Issue>,
	output: string | undefined,
): BacklogExportResult {
	const selectedOutputPath = resolveOutputPath(workspaceRoot, output);
	const files: string[] = [];

	for (const issue of issues) {
		const filePath = outputPathForIssue(
			workspaceRoot,
			issue,
			selectedOutputPath,
			issues.length,
		);
		atomicWriteFileStringSync(filePath, serializeIssueToMarkdown(issue));
		files.push(filePath);
	}

	return { count: files.length, files };
}
