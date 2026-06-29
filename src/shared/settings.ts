import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Data, Effect } from "effect";

import { getProjectSettingsPath, getUserSettingsPath } from "./discovery.js";
import { JsonFileError, readJsonObjectFileEffect } from "./fs.js";
import type { AnyRecord } from "./json.js";

export class SettingsError extends Data.TaggedError("SettingsError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

const mapJsonFileError = (cause: JsonFileError): SettingsError =>
	new SettingsError({
		message: cause.message,
		cause,
	});

export function findNearestProjectPiDirEffect(
	cwd: string,
): Effect.Effect<string | null, SettingsError> {
	const loop = (current: string): Effect.Effect<string | null, SettingsError> =>
		Effect.tryPromise({
			try: () => fs.stat(path.join(current, ".pi")),
			catch: (cause) => cause,
		}).pipe(
			Effect.flatMap((stats) =>
				stats.isDirectory() ? Effect.succeed(path.join(current, ".pi")) : Effect.succeed(null),
			),
			Effect.catchIf(
				(cause) =>
					typeof cause === "object" &&
					cause !== null &&
					"code" in cause &&
					cause.code === "ENOENT",
				() => {
					const parent = path.dirname(current);
					return parent === current ? Effect.succeed(null) : loop(parent);
				},
			),
			Effect.mapError(
				(cause) =>
					new SettingsError({
						message: `Failed to discover project .pi directory from ${current}`,
						cause,
					}),
			),
		);

	return loop(path.resolve(cwd));
}

export function readUserSettings(): Effect.Effect<AnyRecord | null, SettingsError> {
	return readJsonObjectFileEffect(getUserSettingsPath()).pipe(
		Effect.mapError(mapJsonFileError),
	);
}

export function readProjectSettings(
	cwd: string,
): Effect.Effect<AnyRecord | null, SettingsError> {
	return findNearestProjectPiDirEffect(cwd).pipe(
		Effect.flatMap((projectPiDir) =>
			projectPiDir === null
				? Effect.succeed(null)
				: readJsonObjectFileEffect(getProjectSettingsPath(projectPiDir)).pipe(
						Effect.mapError(mapJsonFileError),
					),
		),
	);
}

