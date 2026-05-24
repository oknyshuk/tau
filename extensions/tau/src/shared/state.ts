import { Data, Schema } from "effect";
import { deepMerge, isRecord } from "./json.js";
import {
	normalizeExecutionState,
	ExecutionPersistedStateSchema,
	type ExecutionPersistedState,
} from "../execution/schema.js";

export const TAU_PERSISTED_STATE_TYPE = "tau:state";

export type TauPersistedState = {
	terminalPrompt?: { enabled?: boolean | undefined } | undefined;
	workedFor?: { enabled?: boolean | undefined; toolsEnabled?: boolean | undefined } | undefined;
	status?: { fetchedAt: number; values: Record<string, { percentLeft: number }> } | undefined;
	execution?: ExecutionPersistedState | undefined;
	sandbox?: Record<string, unknown> | undefined;
};

function normalizePersistedState(state: TauPersistedState): TauPersistedState {
	if (state.execution === undefined) {
		return state;
	}

	const normalizedExecution = normalizeExecutionState(state.execution);
	return {
		...state,
		execution: normalizedExecution,
	};
}

export function mergePersistedState(
	base: TauPersistedState,
	patch: Partial<TauPersistedState>,
): TauPersistedState {
	return normalizePersistedState(deepMerge(base, patch));
}

const FiniteNumber = Schema.Number.check(Schema.isFinite());

const TauPersistedStateSchema = Schema.Struct({
	terminalPrompt: Schema.optional(
		Schema.Struct({
			enabled: Schema.optional(Schema.Boolean),
		}),
	),
	workedFor: Schema.optional(
		Schema.Struct({
			enabled: Schema.optional(Schema.Boolean),
			toolsEnabled: Schema.optional(Schema.Boolean),
		}),
	),
	status: Schema.optional(
		Schema.Struct({
			fetchedAt: FiniteNumber,
			values: Schema.Record(Schema.String, Schema.Struct({
				percentLeft: FiniteNumber,
			})),
		}),
	),
	execution: Schema.optional(ExecutionPersistedStateSchema),
	sandbox: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const decodePersistedStateSync = Schema.decodeUnknownSync(TauPersistedStateSchema);

export class PersistedStateDecodeError extends Data.TaggedError("PersistedStateDecodeError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

type PersistedStateEntry = {
	readonly data: unknown;
	readonly index: number;
};

type PersistedStateLoadResult =
	| { readonly _tag: "missing" }
	| { readonly _tag: "invalid"; readonly error: PersistedStateDecodeError }
	| { readonly _tag: "ok"; readonly state: TauPersistedState };

function findPersistedStateEntry(entries: readonly unknown[]): PersistedStateEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (
			isRecord(entry) &&
			entry["type"] === "custom" &&
			entry["customType"] === TAU_PERSISTED_STATE_TYPE
		) {
			return {
				data: entry["data"],
				index,
			};
		}
	}

	return undefined;
}

export function loadPersistedStateDetailed(ctx: {
	sessionManager: { getEntries: () => unknown[] };
}): PersistedStateLoadResult {
	const entry = findPersistedStateEntry(ctx.sessionManager.getEntries());
	if (entry === undefined) {
		return { _tag: "missing" };
	}

	try {
		return {
			_tag: "ok",
			state: normalizePersistedState(decodePersistedStateSync(entry.data)),
		};
	} catch (cause) {
		return {
			_tag: "invalid",
			error: new PersistedStateDecodeError({
				message: `Invalid tau persisted state in session entry ${entry.index + 1}`,
				cause,
			}),
		};
	}
}

export function loadPersistedState(ctx: {
	sessionManager: { getEntries: () => unknown[] };
}): TauPersistedState {
	const result = loadPersistedStateDetailed(ctx);
	if (result._tag === "missing") {
		return {};
	}
	if (result._tag === "invalid") {
		throw result.error;
	}
	return result.state;
}
