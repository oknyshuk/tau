import { Effect } from "effect";
import { AgentRegistry, AgentRegistryConfigError } from "./agent-registry.js";

const WORKER_AVAILABLE_TOOL_NAMES = [
	"agent",
	"apply_patch",
	"backlog",
	"crawling_exa",
	"edit",
	"exec_command",
	"find",
	"get_code_context_exa",
	"grep",
	"ls",
	"memory",
	"read",
	"web_search_exa",
	"write_stdin",
	"write",
] as const;

function formatList(values: readonly string[]): string {
	return [...values].sort().join(", ");
}

export function validateResolvedAgentConfiguration(
	registry: AgentRegistry,
): Effect.Effect<void, AgentRegistryConfigError> {
	const availableTools = new Set<string>(WORKER_AVAILABLE_TOOL_NAMES);

	return Effect.forEach(registry.names(), (name) =>
		Effect.gen(function* () {
			const definition = registry.resolve(name);
			if (!definition) {
				return yield* Effect.fail(
					new AgentRegistryConfigError({
						message: `Internal error: agent "${name}" is registered but has no resolved definition`,
					}),
				);
			}

			if (definition.models.length === 0) {
				return yield* Effect.fail(
					new AgentRegistryConfigError({
						message: `Agent "${name}" has no models configured. Set agents.${name}.models in ~/.pi/agent/settings.json or .pi/settings.json.`,
					}),
				);
			}

			if (definition.tools !== undefined) {
				const invalidTools = [
					...new Set(definition.tools.filter((tool) => !availableTools.has(tool))),
				];
				if (invalidTools.length > 0) {
					return yield* Effect.fail(
						new AgentRegistryConfigError({
							message:
								`Invalid tools for agent "${name}": ${invalidTools.join(", ")}. ` +
								`Available tools: ${formatList(WORKER_AVAILABLE_TOOL_NAMES)}`,
						}),
					);
				}
			}

			if (definition.spawns !== undefined && definition.spawns !== "*") {
				const invalidSpawns = [
					...new Set(definition.spawns.filter((spawn) => !registry.has(spawn))),
				];
				if (invalidSpawns.length > 0) {
					return yield* Effect.fail(
						new AgentRegistryConfigError({
							message:
								`Invalid spawns for agent "${name}": ${invalidSpawns.join(", ")}. ` +
								`Available agents: ${formatList(registry.names())}`,
						}),
					);
				}
			}
		}),
	).pipe(Effect.asVoid);
}
