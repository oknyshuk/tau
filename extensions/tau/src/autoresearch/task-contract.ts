import * as crypto from "node:crypto";
import * as path from "node:path";

import { Option } from "effect";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { ExecutionProfile } from "../execution/schema.js";
import { LoopContractValidationError } from "../loops/errors.js";
import {
	sanitizePhaseId,
	type AutoresearchPhaseSnapshot,
	type MetricDirection,
} from "../loops/schema.js";

type WorkflowSection = {
	readonly id: string;
	readonly heading: string;
	readonly placeholder: string;
};

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

const AUTORESEARCH_WORKFLOW_SECTIONS: readonly WorkflowSection[] = [
	{
		id: "goal",
		heading: "Goal",
		placeholder:
			"Describe the optimization objective, workload shape, and strict acceptance criteria for this task.",
	},
	{
		id: "program",
		heading: "Program",
		placeholder:
			"Capture the active execution plan and hypotheses that should guide the next trial.",
	},
	{
		id: "ideas",
		heading: "Ideas",
		placeholder:
			"Record promising but deferred experiment ideas as concise bullet points.",
	},
	{
		id: "findings",
		heading: "Findings",
		placeholder:
			"Summarize observed behavior, surprising results, and conclusions that should persist across trials.",
	},
	{
		id: "progress",
		heading: "Progress",
		placeholder:
			"Append trial-by-trial notes with run IDs, measured outcomes, and decisions.",
	},
	{
		id: "next_steps",
		heading: "Next Steps",
		placeholder:
			"List immediate next experiments or manual follow-ups required before continuing.",
	},
] as const;

type AutoresearchTaskContract = {
	readonly kind: "autoresearch";
	readonly title: string;
	readonly benchmark: {
		readonly command: string;
		readonly checksCommand: Option.Option<string>;
	};
	readonly metric: {
		readonly name: string;
		readonly unit: string;
		readonly direction: MetricDirection;
	};
	readonly scope: {
		readonly root: string;
		readonly paths: readonly string[];
		readonly offLimits: readonly string[];
	};
	readonly constraints: readonly string[];
	readonly limits: Option.Option<{
		readonly maxIterations: number;
	}>;
};

type AutoresearchTaskContractInput = {
	readonly title: string;
	readonly benchmarkCommand: string;
	readonly checksCommand: Option.Option<string>;
	readonly metricName: string;
	readonly metricUnit: string;
	readonly metricDirection: MetricDirection;
	readonly scopeRoot: string;
	readonly scopePaths: readonly string[];
	readonly offLimits: readonly string[];
	readonly constraints: readonly string[];
	readonly maxIterations: Option.Option<number>;
};

function contractError(entity: string, reason: string): LoopContractValidationError {
	return new LoopContractValidationError({ entity, reason });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePlainString(value: string): string {
	return value.trim().replaceAll("\\", "/");
}

function requireString(
	value: unknown,
	entity: string,
	label: string,
	allowEmpty = false,
): string {
	if (typeof value !== "string") {
		throw contractError(entity, `${label} must be a string.`);
	}
	const normalized = value.trim();
	if (!allowEmpty && normalized.length === 0) {
		throw contractError(entity, `${label} must be a non-empty string.`);
	}
	return normalized;
}

function validateObjectKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	entity: string,
	label: string,
): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) {
			throw contractError(
				entity,
				`${label} contains unsupported key \`${key}\`. Allowed keys: ${allowed.join(", ")}.`,
			);
		}
	}
}

function normalizeMetricDirection(value: string, entity: string): MetricDirection {
	if (value === "lower" || value === "higher") {
		return value;
	}
	throw contractError(entity, "metric.direction must be `lower` or `higher`.");
}

function normalizeScopeRoot(rawRoot: string, entity: string): string {
	const raw = normalizePlainString(rawRoot);
	if (raw.length === 0) {
		throw contractError(entity, "scope.root must be a non-empty string.");
	}
	const windowsNormalized = raw.replaceAll("\\", "/");
	if (/^[A-Za-z]:\//.test(windowsNormalized) || windowsNormalized.startsWith("//")) {
		throw contractError(entity, "scope.root must be a relative path inside the workspace root.");
	}
	const normalized = path.posix.normalize(raw);
	if (path.posix.isAbsolute(normalized)) {
		throw contractError(entity, "scope.root must be a relative path inside the workspace root.");
	}
	if (normalized === ".." || normalized.startsWith("../")) {
		throw contractError(entity, "scope.root cannot escape the workspace root.");
	}
	if (normalized === "./") {
		return ".";
	}
	if (normalized.endsWith("/") && normalized !== "/") {
		return normalized.slice(0, -1);
	}
	return normalized;
}

function normalizeScopeEntries(
	root: string,
	entries: readonly string[],
	entity: string,
	label: "scope.paths" | "scope.off_limits",
): readonly string[] {
	if (entries.length === 0 && label === "scope.paths") {
		throw contractError(entity, "scope.paths must include at least one path.");
	}

	const rootBase = path.posix.isAbsolute(root)
		? path.posix.normalize(root)
		: path.posix.resolve("/", root);
	const normalized: string[] = [];
	const seen = new Set<string>();

	for (const rawEntry of entries) {
		const source = normalizePlainString(rawEntry);
		if (source.length === 0) {
			throw contractError(entity, `${label} cannot contain empty entries.`);
		}

		const normalizedEntry = path.posix.normalize(source);
		const absolutePath = path.posix.isAbsolute(normalizedEntry)
			? normalizedEntry
			: path.posix.resolve(rootBase, normalizedEntry);
		const relative = path.posix.relative(rootBase, absolutePath);

		if (relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
			throw contractError(
				entity,
				`${label} entry \`${rawEntry}\` escapes scope.root \`${root}\`.`,
			);
		}

		const canonical = relative.length === 0 ? "." : relative;
		if (seen.has(canonical)) {
			continue;
		}
		seen.add(canonical);
		normalized.push(canonical);
	}

	normalized.sort((left, right) => left.localeCompare(right));
	return normalized;
}

function normalizeConstraints(
	constraints: readonly string[],
	entity: string,
): readonly string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const value of constraints) {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			throw contractError(entity, "constraints cannot contain empty entries.");
		}
		if (seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	normalized.sort((left, right) => left.localeCompare(right));
	return normalized;
}

function normalizeMaxIterations(
	maxIterations: Option.Option<number>,
	entity: string,
): Option.Option<number> {
	if (Option.isNone(maxIterations)) {
		return Option.none();
	}
	if (!Number.isInteger(maxIterations.value) || maxIterations.value <= 0) {
		throw contractError(entity, "limits.max_iterations must be a positive integer.");
	}
	return maxIterations;
}

function parseStringArray(
	value: unknown,
	entity: string,
	label: string,
): readonly string[] {
	if (!Array.isArray(value)) {
		throw contractError(entity, `${label} must be an array of strings.`);
	}
	return value.map((entry, index) => requireString(entry, entity, `${label}[${index}]`));
}

function parseLimits(
	value: unknown,
	entity: string,
): Option.Option<{ readonly maxIterations: number }> {
	if (value === undefined || value === null) {
		return Option.none();
	}
	if (!isRecord(value)) {
		throw contractError(entity, "limits must be an object when provided.");
	}
	validateObjectKeys(value, ["max_iterations"], entity, "limits");
	const maxIterationsValue = value["max_iterations"];
	if (maxIterationsValue === undefined || maxIterationsValue === null) {
		return Option.none();
	}
	if (
		typeof maxIterationsValue !== "number" ||
		!Number.isInteger(maxIterationsValue) ||
		maxIterationsValue <= 0
	) {
		throw contractError(entity, "limits.max_iterations must be a positive integer.");
	}
	return Option.some({ maxIterations: maxIterationsValue });
}

function parseChecksCommand(value: unknown, entity: string): Option.Option<string> {
	if (value === undefined || value === null) {
		return Option.none();
	}
	const command = requireString(value, entity, "benchmark.checks_command");
	return command.length === 0 ? Option.none() : Option.some(command);
}

function buildSectionBlock(section: WorkflowSection, content: string): string {
	return [
		`## ${section.heading}`,
		`<!-- tau:autoresearch.${section.id}:start -->`,
		content,
		`<!-- tau:autoresearch.${section.id}:end -->`,
	].join("\n");
}

function verifyWorkflowAnchors(body: string, entity: string): void {
	let previousEnd = -1;
	for (const section of AUTORESEARCH_WORKFLOW_SECTIONS) {
		const headingToken = `## ${section.heading}`;
		const startToken = `<!-- tau:autoresearch.${section.id}:start -->`;
		const endToken = `<!-- tau:autoresearch.${section.id}:end -->`;

		const headingIndex = body.indexOf(headingToken);
		const startIndex = body.indexOf(startToken);
		const endIndex = body.indexOf(endToken);
		if (headingIndex === -1 || startIndex === -1 || endIndex === -1) {
			throw contractError(
				entity,
				`workflow-managed section \`${section.heading}\` is missing required heading or anchor markers.`,
			);
		}

		if (!(headingIndex <= startIndex && startIndex < endIndex)) {
			throw contractError(
				entity,
				`workflow-managed section \`${section.heading}\` has invalid marker ordering.`,
			);
		}

		if (startIndex <= previousEnd) {
			throw contractError(
				entity,
				"workflow-managed section anchors must appear exactly once and in canonical order.",
			);
		}

		previousEnd = endIndex;
	}
}

export function normalizeAutoresearchTaskContractInput(
	input: AutoresearchTaskContractInput,
	entity = "loops.autoresearch.task",
): AutoresearchTaskContract {
	const title = requireString(input.title, entity, "title");
	const benchmarkCommand = requireString(
		input.benchmarkCommand,
		entity,
		"benchmark.command",
	);
	const checksCommand = Option.match(input.checksCommand, {
		onNone: () => Option.none<string>(),
		onSome: (value) => {
			const normalized = requireString(value, entity, "benchmark.checks_command");
			return normalized.length === 0 ? Option.none<string>() : Option.some(normalized);
		},
	});
	const metricName = requireString(input.metricName, entity, "metric.name");
	const metricUnit = requireString(input.metricUnit, entity, "metric.unit", true);
	const scopeRoot = normalizeScopeRoot(input.scopeRoot, entity);
	const scopePaths = normalizeScopeEntries(scopeRoot, input.scopePaths, entity, "scope.paths");
	const offLimits = normalizeScopeEntries(scopeRoot, input.offLimits, entity, "scope.off_limits");
	const constraints = normalizeConstraints(input.constraints, entity);
	const normalizedMaxIterations = normalizeMaxIterations(input.maxIterations, entity);

	return {
		kind: "autoresearch",
		title,
		benchmark: {
			command: benchmarkCommand,
			checksCommand,
		},
		metric: {
			name: metricName,
			unit: metricUnit,
			direction: input.metricDirection,
		},
		scope: {
			root: scopeRoot,
			paths: scopePaths,
			offLimits,
		},
		constraints,
		limits: Option.map(normalizedMaxIterations, (maxIterations) => ({
			maxIterations,
		})),
	};
}

export function parseAutoresearchTaskDocument(
	content: string,
	taskFile: string,
): AutoresearchTaskContract {
	const entity = `loops.autoresearch.task(${taskFile})`;
	const match = content.match(FRONTMATTER_REGEX);
	if (!match) {
		throw contractError(
			entity,
			"task file must start with YAML frontmatter delimited by `---`.",
		);
	}

	const frontmatterRaw = match[1];
	const body = match[2];
	if (frontmatterRaw === undefined || body === undefined) {
		throw contractError(entity, "task file frontmatter or body section is missing.");
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(frontmatterRaw);
	} catch (error) {
		throw contractError(entity, `invalid YAML frontmatter: ${String(error)}`);
	}

	if (!isRecord(parsed)) {
		throw contractError(entity, "frontmatter must decode to an object.");
	}

	validateObjectKeys(
		parsed,
		["kind", "title", "benchmark", "metric", "scope", "constraints", "limits"],
		entity,
		"frontmatter",
	);

	const kind = requireString(parsed["kind"], entity, "kind");
	if (kind !== "autoresearch") {
		throw contractError(entity, "kind must be `autoresearch`.");
	}

	const title = requireString(parsed["title"], entity, "title");

	const benchmarkValue = parsed["benchmark"];
	if (!isRecord(benchmarkValue)) {
		throw contractError(entity, "benchmark must be an object.");
	}
	validateObjectKeys(benchmarkValue, ["command", "checks_command"], entity, "benchmark");
	const benchmarkCommand = requireString(
		benchmarkValue["command"],
		entity,
		"benchmark.command",
	);
	const checksCommand = parseChecksCommand(benchmarkValue["checks_command"], entity);

	const metricValue = parsed["metric"];
	if (!isRecord(metricValue)) {
		throw contractError(entity, "metric must be an object.");
	}
	validateObjectKeys(metricValue, ["name", "unit", "direction"], entity, "metric");
	const metricName = requireString(metricValue["name"], entity, "metric.name");
	const metricUnit = requireString(metricValue["unit"], entity, "metric.unit", true);
	const metricDirection = normalizeMetricDirection(
		requireString(metricValue["direction"], entity, "metric.direction"),
		entity,
	);

	const scopeValue = parsed["scope"];
	if (!isRecord(scopeValue)) {
		throw contractError(entity, "scope must be an object.");
	}
	validateObjectKeys(
		scopeValue,
		["root", "paths", "off_limits"],
		entity,
		"scope",
	);
	const scopeRoot = requireString(scopeValue["root"], entity, "scope.root");
	const scopePaths = parseStringArray(scopeValue["paths"], entity, "scope.paths");
	const offLimits = parseStringArray(scopeValue["off_limits"], entity, "scope.off_limits");

	const constraints = parseStringArray(parsed["constraints"], entity, "constraints");
	const limits = parseLimits(parsed["limits"], entity);

	verifyWorkflowAnchors(body, entity);

	return normalizeAutoresearchTaskContractInput(
		{
			title,
			benchmarkCommand,
			checksCommand,
			metricName,
			metricUnit,
			metricDirection,
			scopeRoot,
			scopePaths,
			offLimits,
			constraints,
			maxIterations: Option.map(limits, (value) => value.maxIterations),
		},
		entity,
	);
}

export function renderAutoresearchTaskDocument(
	contract: AutoresearchTaskContract,
	goalText: string,
): string {
	const benchmark = Option.match(contract.benchmark.checksCommand, {
		onNone: () => ({
			command: contract.benchmark.command,
		}),
		onSome: (checksCommand) => ({
			command: contract.benchmark.command,
			checks_command: checksCommand,
		}),
	});

	const limits = Option.match(contract.limits, {
		onNone: () => Option.none<{ readonly max_iterations: number }>(),
		onSome: (value) => Option.some({ max_iterations: value.maxIterations }),
	});

	const frontmatterBase: Record<string, unknown> = {
		kind: "autoresearch",
		title: contract.title,
		benchmark,
		metric: {
			name: contract.metric.name,
			unit: contract.metric.unit,
			direction: contract.metric.direction,
		},
		scope: {
			root: contract.scope.root,
			paths: [...contract.scope.paths],
			off_limits: [...contract.scope.offLimits],
		},
		constraints: [...contract.constraints],
	};

	const frontmatter = Option.match(limits, {
		onNone: () => frontmatterBase,
		onSome: (value) => ({
			...frontmatterBase,
			limits: value,
		}),
	});

	const normalizedGoal = goalText.trim().length > 0
		? goalText.trim()
		: AUTORESEARCH_WORKFLOW_SECTIONS[0]?.placeholder ?? "Describe the task objective.";

	const bodySections = AUTORESEARCH_WORKFLOW_SECTIONS.map((section) => {
		if (section.id === "goal") {
			return buildSectionBlock(section, normalizedGoal);
		}
		return buildSectionBlock(section, section.placeholder);
	});

	const frontmatterYaml = stringifyYaml(frontmatter).trimEnd();
	return `---\n${frontmatterYaml}\n---\n\n${bodySections.join("\n\n")}\n`;
}

export function buildAutoresearchPhaseFingerprint(
	contract: AutoresearchTaskContract,
	pinnedExecutionProfile: ExecutionProfile,
): string {
	const fingerprintPayload = {
		benchmark: {
			command: contract.benchmark.command,
			checksCommand: Option.getOrNull(contract.benchmark.checksCommand),
		},
		metric: {
			name: contract.metric.name,
			unit: contract.metric.unit,
			direction: contract.metric.direction,
		},
		scope: {
			root: contract.scope.root,
			paths: [...contract.scope.paths],
			offLimits: [...contract.scope.offLimits],
		},
		constraints: [...contract.constraints],
		pinnedExecutionProfile,
	};

	return crypto
		.createHash("sha256")
		.update(JSON.stringify(fingerprintPayload))
		.digest("hex");
}

function deriveAutoresearchPhaseId(fingerprint: string): string {
	return sanitizePhaseId(`phase-${fingerprint.slice(0, 32)}`);
}

export function createAutoresearchPhaseSnapshot(
	taskId: string,
	contract: AutoresearchTaskContract,
	pinnedExecutionProfile: ExecutionProfile,
	createdAt: string,
): AutoresearchPhaseSnapshot {
	const fingerprint = buildAutoresearchPhaseFingerprint(contract, pinnedExecutionProfile);
	const phaseId = deriveAutoresearchPhaseId(fingerprint);

	return {
		kind: "autoresearch",
		taskId,
		phaseId,
		fingerprint,
		createdAt,
		benchmark: {
			command: contract.benchmark.command,
			checksCommand: contract.benchmark.checksCommand,
		},
		metric: {
			name: contract.metric.name,
			unit: contract.metric.unit,
			direction: contract.metric.direction,
		},
		scope: {
			root: contract.scope.root,
			paths: [...contract.scope.paths],
			offLimits: [...contract.scope.offLimits],
		},
		constraints: [...contract.constraints],
		pinnedExecutionProfile,
	};
}
