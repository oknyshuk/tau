import { parse as parseYaml } from "yaml";
import { isRecord } from "../shared/json.js";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const ALLOWED_FILE_PATH_ROOTS = new Set(["references", "templates", "scripts", "assets"]);
const INJECTION_PATTERNS = [
	"ignore previous instructions",
	"ignore all previous",
	"you are now",
	"disregard your",
	"forget your instructions",
	"new instructions:",
	"system prompt:",
	"<system>",
	"]]>",
] as const;


export function validateName(name: string): string | undefined {
	if (name.trim().length === 0) {
		return "Skill name is required.";
	}

	if (name.length > MAX_NAME_LENGTH) {
		return `Skill name must be ${MAX_NAME_LENGTH} characters or fewer.`;
	}

	if (!VALID_NAME_RE.test(name)) {
		return "Skill name must start with a lowercase letter or digit and use only lowercase letters, digits, or hyphens.";
	}

	return undefined;
}

export function validateFrontmatter(content: string): string | undefined {
	if (!content.startsWith("---")) {
		return "SKILL.md must start with YAML frontmatter (---).";
	}

	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
	if (!match) {
		return "SKILL.md frontmatter must end with --- on its own line.";
	}

	const frontmatterRaw = match[1];
	const bodyRaw = match[2] ?? "";
	if (frontmatterRaw === undefined) {
		return "SKILL.md frontmatter must end with --- on its own line.";
	}

	let frontmatter: unknown;
	try {
		frontmatter = parseYaml(frontmatterRaw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Invalid YAML frontmatter: ${message}`;
	}

	if (!isRecord(frontmatter)) {
		return "SKILL.md frontmatter must be a YAML mapping.";
	}

	const name = frontmatter["name"];
	if (typeof name !== "string" || name.trim().length === 0) {
		return "SKILL.md frontmatter must include a non-empty name.";
	}

	const description = frontmatter["description"];
	if (typeof description !== "string" || description.trim().length === 0) {
		return "SKILL.md frontmatter must include a non-empty description.";
	}

	if (description.length > MAX_DESCRIPTION_LENGTH) {
		return `Skill description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer.`;
	}

	if (bodyRaw.trim().length === 0) {
		return "SKILL.md must include body content after the frontmatter.";
	}

	return undefined;
}

export function validateFilePath(filePath: string): string | undefined {
	if (filePath.trim().length === 0) {
		return "file_path is required.";
	}

	if (filePath.includes("..")) {
		return "file_path must not contain '..'.";
	}

	const segments = filePath.split("/");
	const firstSegment = segments[0];
	const remainingSegments = segments.slice(1);

	if (firstSegment === undefined || !ALLOWED_FILE_PATH_ROOTS.has(firstSegment)) {
		return `file_path must start with one of: ${Array.from(ALLOWED_FILE_PATH_ROOTS).join(", ")}.`;
	}

	if (remainingSegments.length === 0 || remainingSegments.some((segment) => segment.length === 0)) {
		return "file_path must include a directory and file name.";
	}

	return undefined;
}

export function checkInjectionPatterns(content: string): string | undefined {
	const lowerContent = content.toLowerCase();

	for (const pattern of INJECTION_PATTERNS) {
		if (lowerContent.includes(pattern)) {
			return pattern;
		}
	}

	return undefined;
}
