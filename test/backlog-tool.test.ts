import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { runBacklogCommand } from "../src/backlog/tool.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-backlog-tool-"));
	tempDirs.push(dir);
	return dir;
}

function readFrontmatter(markdown: string): unknown {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
	expect(match).not.toBeNull();
	const yaml = match?.[1];
	expect(yaml).toBeDefined();
	return parseYaml(yaml ?? "");
}

describe("backlog tool", () => {
	it("supports create, update, show, close, and status commands", async () => {
		const workspaceRoot = await makeWorkspace();

		const created = await runBacklogCommand('create "Alpha" --id tau-1 --type task --priority 1', workspaceRoot);
		expect(created.ok).toBe(true);
		expect((created.data as { id: string }).id).toBe("tau-1");

		const updated = await runBacklogCommand('update tau-1 --title "Alpha updated" --notes "note"', workspaceRoot);
		expect(updated.ok).toBe(true);
		expect((updated.data as { title: string }).title).toBe("Alpha updated");

		const shown = await runBacklogCommand("show tau-1", workspaceRoot);
		expect(shown.ok).toBe(true);
		expect((shown.data as { notes?: string }).notes).toBe("note");

		const closed = await runBacklogCommand('close tau-1 --reason "Done"', workspaceRoot);
		expect(closed.ok).toBe(true);
		expect((closed.data as { status?: string }).status).toBe("closed");

		const status = await runBacklogCommand("status", workspaceRoot);
		expect(status.ok).toBe(true);
		expect((status.data as { total_issues: number; closed_issues: number }).total_issues).toBe(1);
		expect((status.data as { total_issues: number; closed_issues: number }).closed_issues).toBe(1);
	});

	it("exports a specific issue to the default markdown path with YAML frontmatter", async () => {
		const workspaceRoot = await makeWorkspace();

		await runBacklogCommand(
			'create "Alpha" --id tau-1 --type task --priority 1 --description "First paragraph" --design "Use files" --acceptance-criteria "Export exists" --notes "one way only"',
			workspaceRoot,
		);

		const exported = await runBacklogCommand("export tau-1", workspaceRoot);

		expect(exported.ok).toBe(true);
		expect(exported.data).toEqual({ count: 1, files: [path.join(workspaceRoot, ".backlog", "tau-1.md")] });
		const content = await fs.readFile(path.join(workspaceRoot, ".backlog", "tau-1.md"), "utf8");
		const frontmatter = readFrontmatter(content);
		expect(frontmatter).toMatchObject({
			id: "tau-1",
			title: "Alpha",
			status: "open",
			priority: 1,
			issue_type: "task",
		});
		expect(content).toContain("# Alpha");
		expect(content).toContain("## description\n\nFirst paragraph");
		expect(content).toContain("## design\n\nUse files");
		expect(content).toContain("## acceptance criteria\n\nExport exists");
		expect(content).toContain("## notes\n\none way only");
	});

	it("exports filtered issues to an output directory and overwrites existing files", async () => {
		const workspaceRoot = await makeWorkspace();
		const outputDir = path.join(workspaceRoot, "exports");
		const stalePath = path.join(outputDir, "tau-1.md");

		await runBacklogCommand('create "Alpha" --id tau-1 --type task --priority 1', workspaceRoot);
		await runBacklogCommand('create "Beta" --id tau-2 --type bug --priority 2', workspaceRoot);
		await fs.mkdir(outputDir, { recursive: true });
		await fs.writeFile(stalePath, "stale", "utf8");

		const exported = await runBacklogCommand("export --type task --output exports", workspaceRoot);

		expect(exported.ok).toBe(true);
		expect(exported.data).toEqual({ count: 1, files: [stalePath] });
		expect(await fs.readFile(stalePath, "utf8")).toContain("title: Alpha");
		await expect(fs.stat(path.join(outputDir, "tau-2.md"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("exports a single issue to an explicit markdown file", async () => {
		const workspaceRoot = await makeWorkspace();

		await runBacklogCommand('create "Alpha" --id tau-1', workspaceRoot);

		const exported = await runBacklogCommand("export tau-1 --output issue.md", workspaceRoot);

		expect(exported.ok).toBe(true);
		expect(exported.data).toEqual({ count: 1, files: [path.join(workspaceRoot, "issue.md")] });
		expect(await fs.readFile(path.join(workspaceRoot, "issue.md"), "utf8")).toContain("id: tau-1");
	});

	it("rejects a markdown output file for multiple issue exports", async () => {
		const workspaceRoot = await makeWorkspace();

		await runBacklogCommand('create "Alpha" --id tau-1', workspaceRoot);
		await runBacklogCommand('create "Beta" --id tau-2', workspaceRoot);

		const exported = await runBacklogCommand("export --output all.md", workspaceRoot);

		expect(exported.ok).toBe(false);
		expect(exported.outputText).toContain("--output must be a directory");
	});

	it("supports dependency, comment, ready, and blocked commands", async () => {
		const workspaceRoot = await makeWorkspace();

		await runBacklogCommand('create "Blocker" --id tau-1', workspaceRoot);
		await runBacklogCommand('create "Blocked" --id tau-2', workspaceRoot);
		await runBacklogCommand('dep add tau-2 tau-1 --type blocks', workspaceRoot);
		await runBacklogCommand('comment tau-2 "needs review"', workspaceRoot);

		const blocked = await runBacklogCommand("blocked", workspaceRoot);
		expect(blocked.ok).toBe(true);
		expect((blocked.data as Array<{ id: string }>).map((issue) => issue.id)).toEqual(["tau-2"]);

		const ready = await runBacklogCommand("ready", workspaceRoot);
		expect(ready.ok).toBe(true);
		expect((ready.data as Array<{ id: string }>).map((issue) => issue.id)).toEqual(["tau-1"]);

		const comments = await runBacklogCommand("comments tau-2", workspaceRoot);
		expect(comments.ok).toBe(true);
		expect((comments.data as Array<{ text: string }>)[0]?.text).toBe("needs review");

		const depTree = await runBacklogCommand("dep tree tau-2 --direction up", workspaceRoot);
		expect(depTree.ok).toBe(true);
		expect((depTree.data as Array<{ id: string; depth: number }>).map((node) => [node.id, node.depth])).toEqual([
			["tau-2", 0],
			["tau-1", 1],
		]);
	});

	it("finds epic children by id without paging through list output", async () => {
		const workspaceRoot = await makeWorkspace();

		await runBacklogCommand('create "Epic" --id tau-epic --type epic', workspaceRoot);
		await runBacklogCommand('create "Visible cursor" --id tau-child-a --type bug', workspaceRoot);
		await runBacklogCommand('create "Border titles" --id tau-child-b --type task', workspaceRoot);
		await runBacklogCommand('create "Nested hotkeys" --id tau-grandchild --type task', workspaceRoot);
		await runBacklogCommand('dep add tau-child-a tau-epic --type parent-child', workspaceRoot);
		await runBacklogCommand('dep add tau-child-b tau-epic --type parent-child', workspaceRoot);
		await runBacklogCommand('dep add tau-grandchild tau-child-b --type parent-child', workspaceRoot);

		const directChildren = await runBacklogCommand("children tau-epic", workspaceRoot);
		expect(directChildren.ok).toBe(true);
		expect((directChildren.data as Array<{ id: string }>).map((issue) => issue.id)).toEqual([
			"tau-child-a",
			"tau-child-b",
		]);

		const recursiveChildren = await runBacklogCommand("children tau-epic --recursive", workspaceRoot);
		expect(recursiveChildren.ok).toBe(true);
		expect((recursiveChildren.data as Array<{ id: string }>).map((issue) => issue.id)).toEqual([
			"tau-child-a",
			"tau-child-b",
			"tau-grandchild",
		]);
	});

	it("filters direct and recursive children by status", async () => {
		const workspaceRoot = await makeWorkspace();

		await runBacklogCommand('create "Epic" --id tau-epic --type epic', workspaceRoot);
		await runBacklogCommand('create "Open child" --id tau-open-child --type task', workspaceRoot);
		await runBacklogCommand('create "Closed child" --id tau-closed-child --type task', workspaceRoot);
		await runBacklogCommand('create "Open grandchild" --id tau-open-grandchild --type task', workspaceRoot);
		await runBacklogCommand('dep add tau-open-child tau-epic --type parent-child', workspaceRoot);
		await runBacklogCommand('dep add tau-closed-child tau-epic --type parent-child', workspaceRoot);
		await runBacklogCommand('dep add tau-open-grandchild tau-closed-child --type parent-child', workspaceRoot);
		await runBacklogCommand('close tau-closed-child --reason "Done"', workspaceRoot);

		const directOpenChildren = await runBacklogCommand("children tau-epic --status open", workspaceRoot);
		expect(directOpenChildren.ok).toBe(true);
		expect((directOpenChildren.data as Array<{ id: string }>).map((issue) => issue.id)).toEqual([
			"tau-open-child",
		]);

		const recursiveOpenChildren = await runBacklogCommand(
			"children tau-epic --recursive --status open",
			workspaceRoot,
		);
		expect(recursiveOpenChildren.ok).toBe(true);
		expect((recursiveOpenChildren.data as Array<{ id: string }>).map((issue) => issue.id)).toEqual([
			"tau-open-child",
			"tau-open-grandchild",
		]);
	});

	it("filters dependency issue views by status", async () => {
		const workspaceRoot = await makeWorkspace();

		await runBacklogCommand('create "Root" --id tau-root --type task', workspaceRoot);
		await runBacklogCommand('create "Open child" --id tau-open-child --type task', workspaceRoot);
		await runBacklogCommand('create "Closed child" --id tau-closed-child --type task', workspaceRoot);
		await runBacklogCommand('dep add tau-open-child tau-root --type blocks', workspaceRoot);
		await runBacklogCommand('dep add tau-closed-child tau-root --type blocks', workspaceRoot);
		await runBacklogCommand('close tau-closed-child --reason "Done"', workspaceRoot);

		const openDependents = await runBacklogCommand("dep list tau-root --direction down --status open", workspaceRoot);
		expect(openDependents.ok).toBe(true);
		expect((openDependents.data as Array<{ id: string }>).map((issue) => issue.id)).toEqual([
			"tau-open-child",
		]);
	});

	it("search matches issue ids and dependency ids", async () => {
		const workspaceRoot = await makeWorkspace();

		await runBacklogCommand('create "Epic" --id tau-epic --type epic', workspaceRoot);
		await runBacklogCommand('create "Child" --id tau-child --type task', workspaceRoot);
		await runBacklogCommand('dep add tau-child tau-epic --type parent-child', workspaceRoot);

		const result = await runBacklogCommand("search tau-epic", workspaceRoot);
		expect(result.ok).toBe(true);
		expect((result.data as Array<{ id: string }>).map((issue) => issue.id)).toEqual([
			"tau-epic",
			"tau-child",
		]);
	});

	it("rejects adding a new task under a closed epic with a clear error", async () => {
		const workspaceRoot = await makeWorkspace();

		await runBacklogCommand('create "Platform epic" --id tau-epic --type epic', workspaceRoot);
		await runBacklogCommand('close tau-epic --reason "Done"', workspaceRoot);
		await runBacklogCommand('create "Follow-up task" --id tau-task --type task', workspaceRoot);

		const result = await runBacklogCommand("dep add tau-task tau-epic --type parent-child", workspaceRoot);

		expect(result.ok).toBe(false);
		expect(result.outputText).toContain("closed epic");
		expect(result.outputText).toContain("tau-epic");
	});
});
