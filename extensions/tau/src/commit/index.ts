/**
 * Commit Extension - Interactive VCS describe/commit workflow
 *
 * Provides:
 * - /commit command: User selects mode (auto/current|staged/changed/other),
 *   then LLM drafts a message.
 * - git_commit_with_user_approval tool: LLM calls this when the user should
 *   confirm a describe (jj) or commit (git).
 *
 * VCS detection at execution time:
 * - jj-vcs: tool runs `jj describe -m <msg>` on `@`. There is no staging area;
 *   the working-copy commit IS the change. Files parameter is ignored with a
 *   note (use `jj split` separately if needed).
 * - git: classic stage + commit + show hash flow.
 *
 * Usage:
 *   /commit          - Select what to describe/commit, LLM drafts message.
 *   /commit message  - Quick describe/commit with provided message hint.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

import { detectVcsAtRoot, discoverWorkspaceRoot } from "../sandbox/workspace-root.js";

const COMMIT_FORMAT_GUIDE = `
Commit message format guidelines:
- Start with a short prefix followed by colon and space (feat:, fix:, docs:, refactor:, test:, chore:, etc.)
- feat: for user-visible features, fix: for bug fixes
- A scope MAY be added in parentheses, e.g. fix(parser): - only when it meaningfully improves clarity
- Short description in imperative mood explaining what changed, not how
- Body MAY be included after one blank line for context, rationale, or non-obvious behavior
- Footers MAY be included (Token: value format, use - instead of spaces in tokens)
- Breaking changes should be explained clearly in description or body, no special marking required
- Clarity and usefulness matter more than strict conformance
`.trim();

type Vcs = "jj" | "git" | null;

function detectVcsForCwd(cwd: string): Vcs {
	return detectVcsAtRoot(discoverWorkspaceRoot(cwd));
}

const JJ_MODE_OPTIONS = [
	"auto - Let the agent decide what to describe in @",
	"current - Describe the current working-copy commit (@) as-is",
	"other - Describe a subset (agent splits unrelated files first)",
] as const;

const GIT_MODE_OPTIONS = [
	"auto - Let the agent figure out what to commit",
	"staged - Commit currently staged files",
	"changed - Commit all changed files",
	"other - Describe what you want to commit",
] as const;

function buildJjPrompt(mode: string, instruction: string): string | null {
	switch (mode) {
		case "auto":
			return `Analyze the current working-copy commit (\`@\`) using \`jj st\` and \`jj diff --stat\`. Decide what should be described in this change.

If \`@\` already contains a coherent unit of work, draft a message and call \`git_commit_with_user_approval\` with it. The tool will run \`jj describe -m <msg>\`.

If \`@\` mixes unrelated changes, run \`jj split <paths>\` first to peel the unrelated files into a sibling change, then describe what remains.

IMPORTANT: be selective. In jj, every file you touched is already in \`@\`; if some changes don't belong, split them out before describing.`;
		case "current":
			return `Run \`jj diff --stat\` to inspect the current working-copy commit (\`@\`). Draft a commit message that describes its content as-is. Call \`git_commit_with_user_approval\` with the message; the tool will run \`jj describe -m <msg>\`. Do not split or move files.`;
		case "other":
			return `I want to describe: ${instruction}

Inspect \`@\` with \`jj st\` and \`jj diff --stat\`. Use \`jj split <paths>\` to peel any files that don't match this description into a sibling change. Then draft a commit message for what remains in \`@\` and call \`git_commit_with_user_approval\`.

IMPORTANT: be conservative about what you keep in \`@\`. Split out anything unrelated.`;
		default:
			return null;
	}
}

function buildGitPrompt(mode: string, instruction: string): string | null {
	switch (mode) {
		case "auto":
			return `Analyze the current git status and changes. Determine what should be committed, stage the appropriate files, and draft a commit message. Use git_commit_with_user_approval to let me review and confirm the commit.

IMPORTANT: Be very selective about what you commit. Only include files that are clearly related to recent work in this session or the task at hand. Do NOT commit:
- Untracked files unless they are clearly part of the current work
- Unrelated local changes that may have been sitting in the working directory
- Configuration files, logs, or other artifacts that shouldn't be in version control

When in doubt, leave a file out. The user can always add more files manually.`;
		case "staged":
			return `Check what files are currently staged (git diff --cached). Draft a commit message for the staged changes. Use git_commit_with_user_approval to let me review and confirm the commit. Do not stage any additional files.`;
		case "changed":
			return `Stage all tracked files that have been modified (git add -u) and draft a commit message based on the changes. Use git_commit_with_user_approval to let me review and confirm the commit.

NOTE: This only stages already-tracked files that have been modified, not untracked files. This is equivalent to what 'git commit -a' does.`;
		case "other":
			return `I want to commit: ${instruction}

Analyze the git status and stage ONLY the files that are directly relevant to this request. Draft a commit message. Use git_commit_with_user_approval to let me review and confirm the commit.

IMPORTANT: Be very conservative about what you include. Only stage files that are clearly related to the requested commit. Do NOT include:
- Unrelated local changes that happen to be in the working directory
- Untracked files unless explicitly part of the request
- Files that seem like they might be leftover from other work

When in doubt, leave a file out.`;
		default:
			return null;
	}
}

type CommitToolDetails = {
	committed: boolean;
	reason?: string;
	hash?: string;
	message?: string;
	error?: string;
	vcs?: "jj" | "git" | "none";
	filesIgnored?: boolean;
};

async function executeJjDescribe(
	pi: ExtensionAPI,
	params: { message: string; files?: ReadonlyArray<string> },
	ctx: ExtensionContext,
	execOpts: { signal?: AbortSignal },
): Promise<{ content: Array<{ type: "text"; text: string }>; details: CommitToolDetails }> {
	if (!ctx.hasUI) {
		return {
			content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
			details: { committed: false, reason: "no-ui", vcs: "jj" },
		};
	}

	// Show what's currently in @
	const diffStatResult = await pi.exec("jj", ["diff", "--stat", "--no-pager"], execOpts);
	const stagedInfo = diffStatResult.stdout.trim();
	if (!stagedInfo) {
		return {
			content: [{ type: "text", text: "Working copy `@` has no changes to describe" }],
			details: { committed: false, reason: "nothing-to-describe", vcs: "jj" },
		};
	}

	const filesIgnored = !!(params.files && params.files.length > 0);
	const filesNote = filesIgnored
		? "\n\nNote: in jj-vcs there is no staging area — `@` is the change itself. The `files` parameter is ignored. Run `jj split <paths>` separately if you need to peel files out of `@` before describing."
		: "";

	const editorPrompt = `Working copy (\`@\`) changes:\n${stagedInfo}${filesNote}\n\n───────────────────────────────────────\nEdit describe message (save to commit, cancel to abort):`;
	const finalMessage = await ctx.ui.editor(editorPrompt, params.message);

	if (finalMessage === undefined || finalMessage.trim() === "") {
		return {
			content: [{ type: "text", text: "Describe cancelled by user" }],
			details: { committed: false, reason: "user-cancelled", vcs: "jj" },
		};
	}

	const descResult = await pi.exec("jj", ["describe", "-m", finalMessage.trim()], execOpts);
	if (descResult.code !== 0) {
		return {
			content: [{ type: "text", text: `jj describe failed: ${descResult.stderr}` }],
			details: { committed: false, reason: "describe-failed", error: descResult.stderr, vcs: "jj" },
		};
	}

	const idResult = await pi.exec(
		"jj",
		["log", "-r", "@", "--no-graph", "--no-pager", "-T", "change_id.shortest()"],
		execOpts,
	);
	const changeId = idResult.code === 0 ? idResult.stdout.trim() : "";

	return {
		content: [
			{
				type: "text",
				text: `Described ${changeId}: ${finalMessage.trim().split("\n")[0]}`,
			},
		],
		details: {
			committed: true,
			hash: changeId,
			message: finalMessage.trim(),
			vcs: "jj",
			filesIgnored,
		},
	};
}

async function executeGitCommit(
	pi: ExtensionAPI,
	params: { message: string; files?: ReadonlyArray<string> },
	ctx: ExtensionContext,
	execOpts: { signal?: AbortSignal },
): Promise<{ content: Array<{ type: "text"; text: string }>; details: CommitToolDetails }> {
	if (!ctx.hasUI) {
		return {
			content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
			details: { committed: false, reason: "no-ui", vcs: "git" },
		};
	}

	if (params.files && params.files.length > 0) {
		const stageResult = await pi.exec("git", ["add", "--", ...params.files], execOpts);
		if (stageResult.code !== 0) {
			return {
				content: [{ type: "text", text: `Error staging files: ${stageResult.stderr}` }],
				details: {
					committed: false,
					reason: "stage-failed",
					error: stageResult.stderr,
					vcs: "git",
				},
			};
		}
	}

	const statusResult = await pi.exec("git", ["diff", "--cached", "--quiet"], execOpts);
	if (statusResult.code === 0) {
		return {
			content: [{ type: "text", text: "Nothing staged to commit" }],
			details: { committed: false, reason: "nothing-staged", vcs: "git" },
		};
	}

	const diffStatResult = await pi.exec("git", ["diff", "--cached", "--stat"], execOpts);
	const stagedInfo = diffStatResult.stdout.trim();

	const editorPrompt = `Staged changes:\n${stagedInfo}\n\n───────────────────────────────────────\nEdit commit message (save to commit, cancel to abort):`;
	const finalMessage = await ctx.ui.editor(editorPrompt, params.message);

	if (finalMessage === undefined || finalMessage.trim() === "") {
		return {
			content: [{ type: "text", text: "Commit cancelled by user" }],
			details: { committed: false, reason: "user-cancelled", vcs: "git" },
		};
	}

	const commitResult = await pi.exec("git", ["commit", "-m", finalMessage.trim()], execOpts);
	if (commitResult.code !== 0) {
		return {
			content: [{ type: "text", text: `Commit failed: ${commitResult.stderr}` }],
			details: {
				committed: false,
				reason: "commit-failed",
				error: commitResult.stderr,
				vcs: "git",
			},
		};
	}

	const hashResult = await pi.exec("git", ["rev-parse", "--short", "HEAD"], execOpts);
	const commitHash = hashResult.stdout.trim();

	return {
		content: [
			{
				type: "text",
				text: `Committed ${commitHash}: ${finalMessage.trim().split("\n")[0]}`,
			},
		],
		details: {
			committed: true,
			hash: commitHash,
			message: finalMessage.trim(),
			vcs: "git",
		},
	};
}

export default function initCommit(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Draft and create a VCS commit/describe with LLM assistance",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			const vcs = detectVcsForCwd(ctx.cwd);
			let mode: string;
			let instruction = (args ?? "").trim();

			if (instruction) {
				mode = "other";
			} else {
				const options =
					vcs === "jj" ? [...JJ_MODE_OPTIONS] : [...GIT_MODE_OPTIONS];
				const selection = await ctx.ui.select(
					vcs === "jj"
						? "What do you want to describe in `@`?"
						: "What do you want to commit?",
					options,
				);

				if (!selection) {
					ctx.ui.notify("Cancelled", "info");
					return;
				}

				mode = selection.split(" - ")[0] ?? "auto";

				if (mode === "other") {
					const input = await ctx.ui.input(
						vcs === "jj"
							? "What do you want to describe?"
							: "What do you want to commit?",
					);
					if (!input) {
						ctx.ui.notify("Cancelled", "info");
						return;
					}
					instruction = input;
				}
			}

			const prompt =
				vcs === "jj"
					? buildJjPrompt(mode, instruction)
					: buildGitPrompt(mode, instruction);

			if (prompt === null) {
				ctx.ui.notify("Unknown mode", "error");
				return;
			}

			pi.sendUserMessage(prompt);
		},
	});

	pi.registerTool({
		name: "git_commit_with_user_approval",
		label: "Commit (with approval)",
		description: `Create a VCS commit/describe with user review and approval. Use this tool when the user should confirm and potentially edit the message before finalizing.

Behavior is VCS-aware:
- jj-vcs: runs \`jj describe -m <message>\` on the working-copy commit (\`@\`). There is no staging area; the \`files\` parameter is ignored with a note. Use \`jj split\` separately if you need to peel unrelated files out of \`@\` before describing.
- git: stages \`files\` (if provided) and runs \`git commit -m <message>\` against staged content.

For automated commits where no user confirmation is needed, use the regular \`jj describe\` / \`git commit\` command via \`exec_command\` instead.

${COMMIT_FORMAT_GUIDE}`,
		promptSnippet: "Create a VCS commit/describe with user review and approval",
		promptGuidelines: [
			"Use git_commit_with_user_approval when the user should confirm and potentially edit the message before finalizing. For automated commits where no user confirmation is needed, use the regular `jj describe` / `git commit` command via `exec_command` instead.",
		],
		parameters: Type.Object({
			message: Type.String({
				description:
					"Proposed commit message (subject line, optionally followed by blank line and body)",
			}),
			files: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Files to stage before committing. git only — ignored in jj-vcs because `@` is the change itself.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const execOpts = signal ? { signal } : {};
			const vcs = detectVcsForCwd(ctx.cwd);

			if (vcs === "jj") {
				return executeJjDescribe(pi, params, ctx, execOpts);
			}
			if (vcs === "git") {
				return executeGitCommit(pi, params, ctx, execOpts);
			}

			return {
				content: [
					{
						type: "text",
						text: "Error: no VCS detected at workspace root (no `.jj` or `.git` directory found)",
					},
				],
				details: { committed: false, reason: "no-vcs", vcs: "none" },
			};
		},

		renderCall(args, theme) {
			const message = (args.message as string) || "";
			const subject = message.split("\n")[0];
			const files = (args.files as string[]) || [];

			let text = theme.fg("toolTitle", theme.bold("commit "));
			text += theme.fg("muted", `"${subject}"`);
			if (files.length > 0) {
				text += theme.fg("dim", ` (${files.length} file${files.length !== 1 ? "s" : ""})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as CommitToolDetails | undefined;

			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (!details.committed) {
				const reason = details.reason || "unknown";
				if (reason === "user-cancelled") {
					return new Text(theme.fg("warning", "Cancelled"), 0, 0);
				}
				if (reason === "nothing-staged" || reason === "nothing-to-describe") {
					return new Text(theme.fg("warning", "Nothing to commit"), 0, 0);
				}
				return new Text(theme.fg("error", `Failed: ${details.error || reason}`), 0, 0);
			}

			const subject = (details.message || "").split("\n")[0];
			const verb = details.vcs === "jj" ? "✓ described" : "✓";
			return new Text(
				theme.fg("success", `${verb} `) +
					theme.fg("accent", details.hash || "") +
					theme.fg("muted", ` ${subject}`),
				0,
				0,
			);
		},
	});
}
