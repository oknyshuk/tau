/**
 * Per-user/per-project defaults for subagent model resolution.
 *
 * When an agent definition declares `models: [{ model: inherit }]` and a user
 * sets `tau.subagentDefaults.model` in `~/.pi/agent/settings.json` or
 * `.pi/settings.json`, that model is used as the inherit base instead of the
 * parent agent's model. Same for `thinking`.
 *
 * Example settings.json:
 *
 *   {
 *     "tau": {
 *       "subagentDefaults": {
 *         "model": "amazon-bedrock/arn:aws:bedrock:...:profile/sonnet",
 *         "thinking": "high"
 *       }
 *     }
 *   }
 */

import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Data, Effect, Exit, Schema } from "effect";

import { resolveModelPattern } from "./worker/model-runner.js";
import { isRecord, type AnyRecord } from "../shared/json.js";
import {
	getProjectSettingsPath,
	getUserSettingsPath,
} from "../shared/discovery.js";
import {
	findNearestProjectPiDirEffect,
	readProjectSettings,
	readUserSettings,
	SettingsError,
} from "../shared/settings.js";

export class SubagentDefaultsError extends Data.TaggedError("SubagentDefaultsError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

const SUBAGENT_THINKING_LEVELS = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

const ThinkingLevelSchema = Schema.Literals([...SUBAGENT_THINKING_LEVELS]);

const SubagentDefaultsSchema = Schema.Struct({
	model: Schema.optional(Schema.String),
	thinking: Schema.optional(ThinkingLevelSchema),
});

type SubagentDefaults = Schema.Schema.Type<typeof SubagentDefaultsSchema>;

export interface ResolvedSubagentDefaults {
	readonly model: Model<Api> | undefined;
	readonly thinking: ThinkingLevel | undefined;
}

const decode = Schema.decodeUnknownExit(SubagentDefaultsSchema);

function decodeOrFail(
	value: unknown,
	source: string,
): Effect.Effect<SubagentDefaults, SubagentDefaultsError> {
	const result = decode(value);
	if (Exit.isFailure(result)) {
		return Effect.fail(
			new SubagentDefaultsError({
				message: `Invalid subagent defaults at ${source}: ${String(result.cause)}`,
				cause: result.cause,
			}),
		);
	}
	return Effect.succeed(result.value);
}

function readNamespace(
	settings: AnyRecord | null,
	settingsPath: string,
): Effect.Effect<SubagentDefaults, SubagentDefaultsError> {
	if (settings === null) return Effect.succeed({});
	const tau = settings["tau"];
	if (!isRecord(tau)) return Effect.succeed({});
	const raw = tau["subagentDefaults"];
	if (raw === undefined) return Effect.succeed({});
	return decodeOrFail(raw, `${settingsPath}: tau.subagentDefaults`);
}

/**
 * Read raw subagent defaults from user + project settings, with project
 * overriding user.
 */
export function loadSubagentDefaults(
	cwd: string,
): Effect.Effect<SubagentDefaults, SubagentDefaultsError | SettingsError> {
	return Effect.gen(function* () {
		const userSettings = yield* readUserSettings();
		const userDef = yield* readNamespace(userSettings, getUserSettingsPath());
		const projectSettings = yield* readProjectSettings(cwd);
		const projectDef = yield* (() => {
			if (projectSettings === null) return Effect.succeed({} as SubagentDefaults);
			return findNearestProjectPiDirEffect(cwd).pipe(
				Effect.map((projectPiDir) =>
					projectPiDir === null ? null : getProjectSettingsPath(projectPiDir),
				),
				Effect.flatMap((projectSettingsPath) =>
					readNamespace(
						projectSettings,
						projectSettingsPath ?? "<project settings>",
					),
				),
			);
		})();
		return {
			model: projectDef.model ?? userDef.model,
			thinking: projectDef.thinking ?? userDef.thinking,
		};
	});
}

/**
 * Resolve raw defaults against a model registry. Returns undefined fields when
 * the corresponding setting is unset; throws SubagentDefaultsError when a
 * configured model id cannot be matched in the registry.
 */
export function resolveSubagentDefaults(
	defaults: SubagentDefaults,
	modelRegistry: ModelRegistry,
): Effect.Effect<ResolvedSubagentDefaults, SubagentDefaultsError> {
	if (defaults.model === undefined) {
		return Effect.succeed({ model: undefined, thinking: defaults.thinking });
	}
	const model = resolveModelPattern(defaults.model, modelRegistry.getAll());
	if (model === undefined) {
		return Effect.fail(
			new SubagentDefaultsError({
				message:
					`tau.subagentDefaults.model "${defaults.model}" did not match any ` +
					`available model. Available providers: ${[
						...new Set(modelRegistry.getAll().map((m) => m.provider)),
					].join(", ") || "<none>"}`,
			}),
		);
	}
	return Effect.succeed({ model, thinking: defaults.thinking });
}
