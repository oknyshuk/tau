import { describe, expect, it } from "vitest";

import { Effect, Layer } from "effect";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PiAPILive } from "../src/effect/pi.js";
import { Persistence, PersistenceLive } from "../src/services/persistence.js";
import {
	PersistedStateDecodeError,
	TAU_PERSISTED_STATE_TYPE,
	type TauPersistedState,
} from "../src/shared/state.js";

type SessionStartHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type PiMock = {
	readonly pi: ExtensionAPI;
	readonly handlers: Map<string, SessionStartHandler[]>;
	readonly appendedEntries: Array<{ readonly type: string; readonly data: unknown }>;
};

function makePiMock(): PiMock {
	const handlers = new Map<string, SessionStartHandler[]>();
	const appendedEntries: Array<{ readonly type: string; readonly data: unknown }> = [];
	const pi = {
		on: (event: string, handler: unknown) => {
			const current = handlers.get(event) ?? [];
			current.push(handler as SessionStartHandler);
			handlers.set(event, current);
		},
		appendEntry: (type: string, data: unknown) => {
			appendedEntries.push({ type, data });
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, appendedEntries };
}

function makeSessionStartContext(entries: unknown[], hasUI = true): ExtensionContext {
	return {
		hasUI,
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => "test-session",
		},
	} as unknown as ExtensionContext;
}

async function setupPersistence(pi: ExtensionAPI): Promise<{
	readonly getSnapshot: () => TauPersistedState;
	readonly update: (patch: Partial<TauPersistedState>) => void;
}> {
	const program = Effect.gen(function* () {
		const persistence = yield* Persistence;
		yield* persistence.setup;
		return persistence;
	});
	const layer = PersistenceLive.pipe(Layer.provide(PiAPILive(pi)));
	return Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));
}

describe("persistence session_start", () => {
	it("appends execution policy for interactive sessions", async () => {
		const mock = makePiMock();
		const persistence = await setupPersistence(mock.pi);

		persistence.update({
			execution: {
				policy: { tools: { kind: "allowlist", tools: ["read"] } },
			},
		});

		expect(mock.appendedEntries).toHaveLength(1);
		expect(mock.appendedEntries[0]).toEqual({
			type: TAU_PERSISTED_STATE_TYPE,
			data: {
				execution: {
					policy: {
						tools: {
							kind: "allowlist",
							tools: ["read"],
						},
					},
				},
			},
		});
	});

	it("does not append execution payload for non-interactive sessions", async () => {
		const mock = makePiMock();
		const persistence = await setupPersistence(mock.pi);

		const sessionStart = mock.handlers.get("session_start")?.[0];
		expect(sessionStart).toBeTypeOf("function");

		const nonInteractiveCtx = makeSessionStartContext([], false);
		await Promise.resolve(sessionStart?.({ type: "session_start" }, nonInteractiveCtx));

		persistence.update({
			execution: {
				policy: { tools: { kind: "allowlist", tools: ["read"] } },
			},
		});

		expect(mock.appendedEntries).toHaveLength(1);
		expect(mock.appendedEntries[0]).toEqual({
			type: TAU_PERSISTED_STATE_TYPE,
			data: {},
		});
	});

	it("keeps existing execution policy when session has no tau state", async () => {
		const mock = makePiMock();
		const persistence = await setupPersistence(mock.pi);
		persistence.update({ execution: { policy: { tools: { kind: "allowlist", tools: ["read"] } } } });

		const sessionStart = mock.handlers.get("session_start")?.[0];
		expect(sessionStart).toBeTypeOf("function");

		const ctx = makeSessionStartContext([]);
		await Promise.resolve(sessionStart?.({ type: "session_start" }, ctx));

		const state = persistence.getSnapshot();
		expect(state.execution?.policy?.tools.kind).toBe("allowlist");
	});

	it("prefers session execution policy when tau state contains one", async () => {
		const mock = makePiMock();
		const persistence = await setupPersistence(mock.pi);
		persistence.update({ execution: { policy: { tools: { kind: "allowlist", tools: ["read"] } } } });

		const sessionStart = mock.handlers.get("session_start")?.[0];
		expect(sessionStart).toBeTypeOf("function");

		const ctx = makeSessionStartContext([
			{
				type: "custom",
				customType: TAU_PERSISTED_STATE_TYPE,
				data: { execution: { policy: { tools: { kind: "require", tools: ["exec_command"] } } } },
			},
		]);
		await Promise.resolve(sessionStart?.({ type: "session_start" }, ctx));

		const state = persistence.getSnapshot();
		expect(state.execution?.policy?.tools.kind).toBe("require");
	});

	it("uses deterministic default when session tau state contains empty execution", async () => {
		const mock = makePiMock();
		const persistence = await setupPersistence(mock.pi);
		persistence.update({ execution: { policy: { tools: { kind: "allowlist", tools: ["read"] } } } });

		const sessionStart = mock.handlers.get("session_start")?.[0];
		expect(sessionStart).toBeTypeOf("function");

		const ctx = makeSessionStartContext([
			{
				type: "custom",
				customType: TAU_PERSISTED_STATE_TYPE,
				data: { execution: {} },
			},
		]);
		await Promise.resolve(sessionStart?.({ type: "session_start" }, ctx));

		const state = persistence.getSnapshot();
		expect(state.execution?.policy?.tools.kind).toBe("inherit");
	});

	it("surfaces invalid session tau state instead of treating it as missing", async () => {
		const mock = makePiMock();
		await setupPersistence(mock.pi);

		const sessionStart = mock.handlers.get("session_start")?.[0];
		expect(sessionStart).toBeTypeOf("function");

		const ctx = makeSessionStartContext([
			{
				type: "custom",
				customType: TAU_PERSISTED_STATE_TYPE,
				data: { status: { fetchedAt: Number.POSITIVE_INFINITY, values: {} } },
			},
		]);

		expect(() => sessionStart?.({ type: "session_start" }, ctx)).toThrowError(
			PersistedStateDecodeError,
		);
	});
});
