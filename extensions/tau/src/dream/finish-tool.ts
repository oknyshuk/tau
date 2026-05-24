import { Schema } from "effect";
import { Type, type Static } from "typebox";

import { DreamFinishParams } from "./domain.js";

/**
 * TypeBox parameter schema for the dream_finish tool, shared by both the
 * foreground orchestrator (dream/init.ts) and the auto-mode subagent
 * (dream/runner.ts) so the tool surface stays in lock-step.
 */
export const DreamFinishToolParams = Type.Object({
	runId: Type.String({ description: "Dream run id" }),
	summary: Type.String({ description: "Brief summary of what was found and changed" }),
	reviewedSessions: Type.Array(Type.String(), { description: "Session IDs reviewed" }),
	noChanges: Type.Boolean({ description: "True if no memory changes were made" }),
});
export type DreamFinishToolParams = Static<typeof DreamFinishToolParams>;

const decodeDreamFinishParamsSync = Schema.decodeUnknownSync(DreamFinishParams);

export type DreamFinishParseResult =
	| { readonly ok: true; readonly params: DreamFinishParams }
	| { readonly ok: false; readonly error: string };

export const parseDreamFinishParams = (rawParams: unknown): DreamFinishParseResult => {
	try {
		return { ok: true, params: decodeDreamFinishParamsSync(rawParams) };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Invalid dream_finish params: ${reason}` };
	}
};
