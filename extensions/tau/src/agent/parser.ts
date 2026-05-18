import { Data, Effect, Option, Schema } from "effect";
import { parse } from "yaml";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentDefinition, ModelSpec } from "./types.js";
import type { SandboxConfig } from "../sandbox/config.js";
import { ApprovalTimeoutSeconds } from "../schemas/config.js";
import { EXTENSION_AGENTS_DIR, getUserAgentsDir } from "../shared/discovery.js";
import { isRecord } from "../shared/json.js";
import { SANDBOX_PRESET_NAMES } from "../shared/policy.js";
import { findNearestProjectPiDirEffect } from "../shared/settings.js";
import { decodeAgentModelSpec } from "./model-spec.js";
import { parseConfiguredToolNames } from "./tool-allowlist.js";

export class AgentDefinitionError extends Data.TaggedError("AgentDefinitionError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

const SandboxPresetSchema = Schema.Literals([...SANDBOX_PRESET_NAMES]);

const AGENT_DEFINITION_FRONTMATTER_KEYS = [
	"name",
	"description",
	"models",
	"tools",
	"spawns",
	"sandbox",
	"approval_timeout",
] as const;

const VALID_AGENT_DEFINITION_FRONTMATTER_KEYS = new Set<string>(
	AGENT_DEFINITION_FRONTMATTER_KEYS,
);

const AgentDefinitionFrontmatterSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	models: Schema.optional(Schema.Array(Schema.Unknown)),
	tools: Schema.optional(Schema.Array(Schema.Unknown)),
	spawns: Schema.optional(
		Schema.Union([Schema.Literal("*"), Schema.Array(Schema.String)]),
	),
	sandbox: Schema.optional(SandboxPresetSchema),
	approval_timeout: Schema.optional(ApprovalTimeoutSeconds),
});

function validateFrontmatterKeys(
	frontmatter: unknown,
): Effect.Effect<unknown, AgentDefinitionError> {
	if (!isRecord(frontmatter)) {
		return Effect.succeed(frontmatter);
	}

	const unknownKeys = Object.keys(frontmatter)
		.filter((key) => !VALID_AGENT_DEFINITION_FRONTMATTER_KEYS.has(key))
		.sort((left, right) => left.localeCompare(right));
	if (unknownKeys.length === 0) {
		return Effect.succeed(frontmatter);
	}

	return Effect.fail(
		new AgentDefinitionError({
			message: `Invalid agent frontmatter: unknown keys: ${unknownKeys.join(", ")} (allowed keys: ${AGENT_DEFINITION_FRONTMATTER_KEYS.join(", ")})`,
		}),
	);
}

export function parseAgentDefinition(
	content: string,
): Effect.Effect<AgentDefinition, AgentDefinitionError> {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) {
		return Effect.fail(
			new AgentDefinitionError({
				message: "Invalid agent definition: Missing YAML frontmatter",
			}),
		);
	}

	const frontmatterRaw = match[1];
	const systemPromptRaw = match[2];
	if (frontmatterRaw === undefined || systemPromptRaw === undefined) {
		return Effect.fail(
			new AgentDefinitionError({
				message: "Invalid agent definition: Missing YAML frontmatter or body",
			}),
		);
	}

	return Effect.try({
		try: () => parse(frontmatterRaw) as unknown,
		catch: (cause) =>
			new AgentDefinitionError({
				message: "Invalid agent frontmatter: invalid YAML",
				cause,
			}),
	}).pipe(
		Effect.flatMap((frontmatter) =>
			validateFrontmatterKeys(frontmatter).pipe(
				Effect.flatMap((validatedFrontmatter) =>
					Schema.decodeUnknownEffect(AgentDefinitionFrontmatterSchema)(validatedFrontmatter).pipe(
						Effect.mapError(
							(cause) =>
								new AgentDefinitionError({
									message: `Invalid agent frontmatter: ${String(cause)}`,
									cause,
								}),
						),
					),
				),
			),
		),
		Effect.flatMap((parsedFrontmatter) =>
			Effect.forEach(parsedFrontmatter.models ?? [], (entry) =>
				decodeAgentModelSpec(entry, "Invalid agent model spec").pipe(
					Effect.mapError(
						(error) =>
							new AgentDefinitionError({
								message: error.message,
								cause: error,
							}),
					),
				),
			).pipe(
				Effect.flatMap((models) =>
					Effect.try({
						try: () => parseConfiguredToolNames(parsedFrontmatter.tools, "tools"),
						catch: (cause) =>
							new AgentDefinitionError({
								message:
									cause instanceof Error
										? cause.message
										: `Invalid agent tools: ${String(cause)}`,
								cause,
							}),
					}).pipe(
						Effect.map((tools): AgentDefinition => {
							const sandbox: SandboxConfig =
								parsedFrontmatter.sandbox === undefined
									? {}
									: { preset: parsedFrontmatter.sandbox };
							if (parsedFrontmatter.approval_timeout !== undefined) {
								sandbox.approvalTimeoutSeconds = parsedFrontmatter.approval_timeout;
							}

							return {
								name: parsedFrontmatter.name,
								description: parsedFrontmatter.description,
								models: models as ReadonlyArray<ModelSpec>,
								...(tools !== undefined ? { tools } : {}),
								...(parsedFrontmatter.spawns !== undefined
									? { spawns: parsedFrontmatter.spawns }
									: {}),
								sandbox,
								systemPrompt: systemPromptRaw.trim(),
							};
						}),
					),
				),
			),
		),
	);
}

function isFile(filePath: string): Effect.Effect<boolean, AgentDefinitionError> {
	return Effect.tryPromise({
		try: () => fs.stat(filePath),
		catch: (cause) => cause,
	}).pipe(
		Effect.map((stats) => stats.isFile()),
		Effect.catchIf(
			(cause) =>
				typeof cause === "object" &&
				cause !== null &&
				"code" in cause &&
				cause.code === "ENOENT",
			() => Effect.succeed(false),
		),
		Effect.mapError(
			(cause) =>
				new AgentDefinitionError({
					message: `Failed to inspect agent definition ${filePath}`,
					cause,
				}),
		),
	);
}

const VALID_AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function isPathWithinParent(parent: string, candidate: string): boolean {
	const rel = path.relative(parent, candidate);
	return !rel.startsWith("..") && rel !== "";
}

export function loadAgentDefinition(
	name: string,
	cwd: string,
): Effect.Effect<Option.Option<AgentDefinition>, AgentDefinitionError> {
	if (!VALID_AGENT_NAME_RE.test(name)) {
		return Effect.fail(
			new AgentDefinitionError({
				message: `Invalid agent name: "${name}". Names must match /^[a-z0-9][a-z0-9_-]*$/.`,
			}),
		);
	}

	return findNearestProjectPiDirEffect(cwd).pipe(
		Effect.flatMap((projectPi) => {
			const candidates: Array<{ readonly path: string; readonly root: string }> = [];
			if (projectPi) {
				const root = path.join(projectPi, "agents");
				candidates.push({ path: path.join(root, `${name}.md`), root });
			}
			const userRoot = getUserAgentsDir();
			candidates.push({ path: path.join(userRoot, `${name}.md`), root: userRoot });
			candidates.push({ path: path.join(EXTENSION_AGENTS_DIR, `${name}.md`), root: EXTENSION_AGENTS_DIR });

			return Effect.gen(function* () {
				for (const candidate of candidates) {
					if (!isPathWithinParent(candidate.root, candidate.path)) {
						continue;
					}

					const exists = yield* isFile(candidate.path);
					if (!exists) {
						continue;
					}

					const contents = yield* Effect.tryPromise({
						try: () => fs.readFile(candidate.path, "utf-8"),
						catch: (cause) =>
							new AgentDefinitionError({
								message: `Failed to read agent definition ${candidate.path}`,
								cause,
							}),
					});

					return yield* parseAgentDefinition(contents).pipe(Effect.map(Option.some));
				}

				return Option.none();
			});
		}),
		Effect.mapError((cause) =>
			cause instanceof AgentDefinitionError
				? cause
				: new AgentDefinitionError({
						message: "Failed to load agent definition",
						cause,
					}),
		),
	);
}
