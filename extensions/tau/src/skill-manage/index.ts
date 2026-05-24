import { Effect } from "effect";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { SkillManager } from "../services/skill-manager.js";
import { defineDecodedTool, textToolResult } from "../shared/decoded-tool.js";
import {
	SkillAlreadyExists,
	SkillFileError,
	SkillInvalidContent,
	SkillInvalidName,
	SkillNotFound,
	SkillPatchFailed,
	SkillSecurityViolation,
} from "./errors.js";

const SkillManageParams = Type.Object({
	action: Type.Union([
		Type.Literal("create"),
		Type.Literal("patch"),
		Type.Literal("edit"),
		Type.Literal("delete"),
		Type.Literal("write_file"),
		Type.Literal("remove_file"),
	]),
	name: Type.String({
		description: "Skill name (lowercase, hyphens/underscores, max 64 chars).",
	}),
	content: Type.Optional(
		Type.String({
			description:
				"Full SKILL.md content (YAML frontmatter + markdown body). Required for 'create' and 'edit'.",
		}),
	),
	old_string: Type.Optional(
		Type.String({
			description:
				"Text to find (required for 'patch'). Must be unique unless replace_all=true.",
		}),
	),
	new_string: Type.Optional(
		Type.String({
			description:
				"Replacement text (required for 'patch'). Empty string to delete matched text.",
		}),
	),
	replace_all: Type.Optional(
		Type.Boolean({ description: "For 'patch': replace all occurrences (default: false)." }),
	),
	category: Type.Optional(
		Type.String({
			description: "Optional category for organizing (e.g., 'devops'). Only for 'create'.",
		}),
	),
	file_path: Type.Optional(
		Type.String({
			description:
				"Path to supporting file (e.g., 'references/api.md'). For write_file/remove_file/patch.",
		}),
	),
	file_content: Type.Optional(
		Type.String({ description: "Content for the file. Required for 'write_file'." }),
	),
});

type SkillManageParams = Static<typeof SkillManageParams>;

function decodeSkillManageParams(rawParams: unknown): SkillManageParams {
	return Value.Parse(SkillManageParams, rawParams);
}

const TOOL_DESCRIPTION =
	"Manage skills (create, update, delete). Skills are your procedural memory — reusable approaches for recurring task types. New skills default to ~/.pi/agent/skills/, and edits/patches can target matching skills discovered from the current workspace as well.\n\nActions: create (full SKILL.md + optional category), patch (old_string/new_string — preferred for fixes), edit (full SKILL.md rewrite — major overhauls only), delete, write_file, remove_file.\n\nCreate when: complex task succeeded (5+ tool calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered, or user asks you to remember a procedure.\nUpdate when: instructions stale/wrong, missing steps or pitfalls found during use. If you used a skill and hit issues not covered by it, patch it immediately.\n\nAfter difficult/iterative tasks, offer to save as a skill. Skip for simple one-offs. Confirm with user before creating/deleting.\n\nGood skills: trigger conditions, numbered steps with exact commands, pitfalls section, verification steps.";

type SkillManageAction = ValidatedSkillManageParams["action"];

type SkillPatchDetails = {
	readonly name: string;
	readonly replacements: number;
	readonly filePath: string;
	readonly diff: string;
};

type ToolDetails = {
	readonly success: boolean;
	readonly action?: SkillManageAction;
	readonly patch?: SkillPatchDetails;
};

type ToolResult = AgentToolResult<ToolDetails>;

type ValidatedSkillManageParams =
	| {
			action: "create";
			name: string;
			content: string;
			category?: string;
	  }
	| {
			action: "patch";
			name: string;
			old_string: string;
			new_string: string;
			replace_all?: boolean;
			file_path?: string;
	  }
	| {
			action: "edit";
			name: string;
			content: string;
	  }
	| {
			action: "delete";
			name: string;
	  }
	| {
			action: "write_file";
			name: string;
			file_path: string;
			file_content: string;
	  }
	| {
			action: "remove_file";
			name: string;
			file_path: string;
	  };

type ValidationResult =
	| { ok: true; params: ValidatedSkillManageParams }
	| { ok: false; result: ToolResult };

type ToolSuccessPayload = {
	readonly text: string;
	readonly details: Omit<ToolDetails, "success">;
};

function toolOk(text: string, details: Omit<ToolDetails, "success"> = {}): ToolResult {
	return textToolResult(text, { success: true, ...details });
}
function toolFail(text: string, details: Omit<ToolDetails, "success"> = {}): ToolResult {
	return textToolResult(text, { success: false, ...details });
}

function getToolCwd(ctx: unknown): string {
	if (typeof ctx !== "object" || ctx === null || !("cwd" in ctx)) {
		throw new Error("skill_manage requires an execution context with cwd.");
	}
	const cwd = ctx.cwd;
	if (typeof cwd !== "string" || cwd.length === 0) {
		throw new Error("skill_manage requires a non-empty execution context cwd.");
	}
	return cwd;
}

function validateParams(params: SkillManageParams): ValidationResult {
	switch (params.action) {
		case "create": {
			if (params.content === undefined) {
				return { ok: false, result: toolFail("content is required for 'create' action.") };
			}
			const validatedParams: ValidatedSkillManageParams = {
				action: "create",
				name: params.name,
				content: params.content,
				...(params.category === undefined ? {} : { category: params.category }),
			};
			return {
				ok: true,
				params: validatedParams,
			};
		}
		case "edit": {
			if (params.content === undefined) {
				return { ok: false, result: toolFail("content is required for 'edit' action.") };
			}
			return {
				ok: true,
				params: {
					action: "edit",
					name: params.name,
					content: params.content,
				},
			};
		}
		case "patch": {
			if (params.old_string === undefined) {
				return {
					ok: false,
					result: toolFail("old_string is required for 'patch' action."),
				};
			}
			if (params.new_string === undefined) {
				return {
					ok: false,
					result: toolFail("new_string is required for 'patch' action."),
				};
			}
			const validatedParams: ValidatedSkillManageParams = {
				action: "patch",
				name: params.name,
				old_string: params.old_string,
				new_string: params.new_string,
				...(params.replace_all === undefined ? {} : { replace_all: params.replace_all }),
				...(params.file_path === undefined ? {} : { file_path: params.file_path }),
			};
			return {
				ok: true,
				params: validatedParams,
			};
		}
		case "delete": {
			return { ok: true, params: { action: "delete", name: params.name } };
		}
		case "write_file": {
			if (params.file_path === undefined) {
				return {
					ok: false,
					result: toolFail("file_path is required for 'write_file' action."),
				};
			}
			if (params.file_content === undefined) {
				return {
					ok: false,
					result: toolFail("file_content is required for 'write_file' action."),
				};
			}
			return {
				ok: true,
				params: {
					action: "write_file",
					name: params.name,
					file_path: params.file_path,
					file_content: params.file_content,
				},
			};
		}
		case "remove_file": {
			if (params.file_path === undefined) {
				return {
					ok: false,
					result: toolFail("file_path is required for 'remove_file' action."),
				};
			}
			return {
				ok: true,
				params: {
					action: "remove_file",
					name: params.name,
					file_path: params.file_path,
				},
			};
		}
	}
}

function renderPatchDiff(
	diffText: string,
	theme: {
		fg: (
			key: "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext" | "toolTitle",
			text: string,
		) => string;
	},
): string {
	const renderedLines: string[] = [];
	for (const line of diffText.split("\n")) {
		if (line.startsWith("+")) {
			renderedLines.push(theme.fg("toolDiffAdded", line));
			continue;
		}
		if (line.startsWith("-")) {
			renderedLines.push(theme.fg("toolDiffRemoved", line));
			continue;
		}
		renderedLines.push(theme.fg("toolDiffContext", line));
	}
	return renderedLines.join("\n");
}

export function createSkillManageToolDefinition(
	runEffect: <A, E>(effect: Effect.Effect<A, E, SkillManager>) => Promise<A>,
): ToolDefinition {
	return defineDecodedTool<typeof SkillManageParams, SkillManageParams, ToolDetails>({
		name: "skill_manage",
		label: "skill_manage",
		description: TOOL_DESCRIPTION,
		parameters: SkillManageParams,
		decodeParams: decodeSkillManageParams,
		formatInvalidParamsResult: (message) => toolFail(message),
		async execute(params, { ctx }) {
			const cwd = getToolCwd(ctx);
			const validation = validateParams(params);
			if (!validation.ok) {
				return validation.result;
			}

			const program = Effect.gen(function* () {
				const skillManager = yield* SkillManager;
				switch (validation.params.action) {
					case "create": {
						const result = yield* skillManager.create(
							validation.params.name,
							validation.params.content,
							validation.params.category,
							cwd,
						);
						return {
							text: `Skill '${result.name}' created at ${result.path}.`,
							details: { action: "create" },
						} satisfies ToolSuccessPayload;
					}
					case "edit": {
						yield* skillManager.edit(
							validation.params.name,
							validation.params.content,
							cwd,
						);
						return {
							text: `Skill '${validation.params.name}' updated.`,
							details: { action: "edit" },
						} satisfies ToolSuccessPayload;
					}
					case "patch": {
						const result = yield* skillManager.patch(
							validation.params.name,
							validation.params.old_string,
							validation.params.new_string,
							validation.params.file_path,
							validation.params.replace_all,
							cwd,
						);
						return {
							text: `Patched ${result.replacements} replacement(s) in skill '${result.name}'.`,
							details: {
								action: "patch",
								patch: {
									name: result.name,
									replacements: result.replacements,
									filePath: result.filePath,
									diff: result.diff,
								},
							},
						} satisfies ToolSuccessPayload;
					}
					case "delete": {
						yield* skillManager.remove(validation.params.name, cwd);
						return {
							text: `Skill '${validation.params.name}' deleted.`,
							details: { action: "delete" },
						} satisfies ToolSuccessPayload;
					}
					case "write_file": {
						const result = yield* skillManager.writeFile(
							validation.params.name,
							validation.params.file_path,
							validation.params.file_content,
							cwd,
						);
						return {
							text: `File '${result.filePath}' written to skill '${result.name}'.`,
							details: { action: "write_file" },
						} satisfies ToolSuccessPayload;
					}
					case "remove_file": {
						const result = yield* skillManager.removeFile(
							validation.params.name,
							validation.params.file_path,
							cwd,
						);
						return {
							text: `File '${result.filePath}' removed from skill '${result.name}'.`,
							details: { action: "remove_file" },
						} satisfies ToolSuccessPayload;
					}
				}
			});

			try {
				const result = await runEffect(program);
				return toolOk(result.text, result.details);
			} catch (cause: unknown) {
				if (cause instanceof SkillNotFound)
					return toolFail(`Skill '${cause.name}' not found.`, {
						action: validation.params.action,
					});
				if (cause instanceof SkillAlreadyExists)
					return toolFail(`Skill '${cause.name}' already exists at ${cause.path}.`, {
						action: validation.params.action,
					});
				if (cause instanceof SkillInvalidName)
					return toolFail(`Invalid skill name '${cause.name}': ${cause.reason}`, {
						action: validation.params.action,
					});
				if (cause instanceof SkillInvalidContent)
					return toolFail(`Invalid skill content: ${cause.reason}`, {
						action: validation.params.action,
					});
				if (cause instanceof SkillFileError)
					return toolFail(`Skill file error: ${cause.reason}`, {
						action: validation.params.action,
					});
				if (cause instanceof SkillSecurityViolation)
					return toolFail(`Skill content rejected: ${cause.reason}`, {
						action: validation.params.action,
					});
				if (cause instanceof SkillPatchFailed)
					return toolFail(
						`Patch failed for skill '${validation.params.name}': ${cause.reason}`,
						{ action: validation.params.action },
					);
				return toolFail(cause instanceof Error ? cause.message : String(cause), {
					action: validation.params.action,
				});
			}
		},
		renderResult(result, _options, theme) {
			const details = (result as { details?: ToolDetails }).details;
			if (details?.success !== true || details.action !== "patch" || details.patch === undefined) {
				return new Text("", 0, 0);
			}

			if (details.patch.diff.trim().length === 0) {
				return new Text("", 0, 0);
			}

			const header = theme.fg("toolTitle", `${details.patch.name}/${details.patch.filePath}`);
			const renderedDiff = renderPatchDiff(details.patch.diff, theme);
			return new Text(`\n${header}\n${renderedDiff}`, 0, 0);
		},
	});
}

export default function initSkillManage(
	pi: ExtensionAPI,
	runEffect: <A, E>(effect: Effect.Effect<A, E, SkillManager>) => Promise<A>,
): void {
	pi.registerTool(createSkillManageToolDefinition(runEffect));
}
