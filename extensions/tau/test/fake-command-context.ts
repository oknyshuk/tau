import * as path from "node:path";

import type {
	ExtensionCommandContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

/**
 * Shared fakes for ExtensionCommandContext used across loop / store / adapter
 * tests. Centralizes the context shape, the NewSessionPlan stepper, the
 * stale-after-replacement guard, and the small amount of session-manager
 * fakery required for newSession({ setup, withSession }) and switchSession({
 * withSession }).
 *
 * Each test file imports `makeFakeCommandContext` and gets back a harness with
 * the live ExtensionCommandContext under `.ctx` plus the captured side-effects
 * (notifications, calls, appended custom entries, ...) it can assert against.
 *
 * Behavior knobs are opt-in. Tests that want simpler semantics (no staleness
 * tracking, no withSession plumbing) just leave them unset.
 */

export type Notification = { readonly message: string; readonly level: string };
export type Notifications = Notification[];

export type WidgetUpdates = unknown[];
export type StatusUpdates = (string | undefined)[];

export type AppendedCustomEntry = { readonly customType: string; readonly data: unknown };

export type NewSessionPlan = {
	readonly cancelled: boolean;
	readonly sessionFile?: string;
	readonly updateContextSessionFile?: boolean;
	readonly staleContextAfterReplacement?: boolean;
};

export type ReplacementSessionContextForTest = ExtensionCommandContext & {
	readonly sendMessage: () => Promise<void>;
	readonly sendUserMessage: () => Promise<void>;
};

export type SetupSessionManagerForTest = Pick<
	SessionManager,
	"getSessionFile" | "appendCustomEntry"
>;

export type NewSessionOptionsForTest = {
	readonly parentSession?: string;
	readonly setup?: (sessionManager: SessionManager) => Promise<void>;
	readonly withSession?: (ctx: ReplacementSessionContextForTest) => Promise<void>;
};

export type SwitchSessionOptionsForTest = {
	readonly withSession?: (ctx: ReplacementSessionContextForTest) => Promise<void>;
};

export const STALE_EXTENSION_CONTEXT_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

export function readNewSessionOptionsForTest(options: unknown): NewSessionOptionsForTest {
	if (typeof options !== "object" || options === null) {
		return {};
	}
	const candidate = options as {
		readonly parentSession?: unknown;
		readonly setup?: unknown;
		readonly withSession?: unknown;
	};
	return {
		...(typeof candidate.parentSession === "string"
			? { parentSession: candidate.parentSession }
			: {}),
		...(typeof candidate.setup === "function"
			? {
					setup: candidate.setup as (sessionManager: SessionManager) => Promise<void>,
				}
			: {}),
		...(typeof candidate.withSession === "function"
			? {
					withSession: candidate.withSession as (
						ctx: ReplacementSessionContextForTest,
					) => Promise<void>,
				}
			: {}),
	};
}

export function readSwitchSessionOptionsForTest(options: unknown): SwitchSessionOptionsForTest {
	if (typeof options !== "object" || options === null) {
		return {};
	}
	const candidate = options as { readonly withSession?: unknown };
	return {
		...(typeof candidate.withSession === "function"
			? {
					withSession: candidate.withSession as (
						ctx: ReplacementSessionContextForTest,
					) => Promise<void>,
				}
			: {}),
	};
}

export interface FakeCommandContextOptions {
	readonly cwd: string;
	readonly newSessionPlan?: readonly NewSessionPlan[];
	readonly initialEntries?: readonly unknown[];
	readonly replacementEntries?: readonly unknown[];
	readonly modelProvider?: string;
	readonly idle?: boolean;
	/**
	 * Optional external array to receive notifications. The harness still
	 * exposes its own `notifications` array, but when this is provided every
	 * notify() call is also pushed into the caller's array. Useful when porting
	 * tests that already declared `const notifications: Notifications = []`
	 * outside the helper.
	 */
	readonly notificationsSink?: Notifications;
	/**
	 * Initial session file path. Defaults to <cwd>/.pi/sessions/controller.session.json.
	 */
	readonly sessionFile?: string;
	/**
	 * Custom session-id resolver. Receives the current session file path and
	 * returns the id that getSessionId() should report. Defaults to a fixed
	 * "test-session".
	 */
	readonly resolveSessionId?: (sessionFile: string) => string;
	/**
	 * When true, the controller ctx becomes stale after a successful
	 * switchSession (mirrors pi 0.70+ semantics that ralph-service relies on).
	 * Defaults to false to keep the simpler tests that re-use the ctx after
	 * switchSession working.
	 */
	readonly staleAfterSwitchSession?: boolean;
}

export interface FakeCommandContext {
	readonly ctx: ExtensionCommandContext;
	readonly notifications: Notifications;
	readonly newSessionCalls: unknown[];
	readonly switchSessionCalls: string[];
	readonly appendedCustomEntries: AppendedCustomEntry[];
	readonly activeToolCalls: string[][];
	readonly widgetUpdates: WidgetUpdates;
	readonly statusUpdates: StatusUpdates;
	readonly setSessionFile: (next: string) => void;
	readonly getSessionFile: () => string;
	readonly disposeCommandContext: () => void;
	readonly markStale: () => void;
	/**
	 * Test-side helpers to drive the active-tool state without going through
	 * the adapter under test. Mirrors how each test originally maintained its
	 * own activeTools shadow array.
	 */
	readonly setActiveTools: (next: ReadonlyArray<string>) => void;
	readonly getActiveTools: () => ReadonlyArray<string>;
}

export function makeFakeCommandContext(options: FakeCommandContextOptions): FakeCommandContext {
	const {
		cwd,
		newSessionPlan = [{ cancelled: false }],
		initialEntries = [],
		replacementEntries = initialEntries,
		modelProvider,
		idle = true,
		notificationsSink,
		sessionFile: initialSessionFile,
		resolveSessionId,
		staleAfterSwitchSession = false,
	} = options;

	const notifications: Notifications = [];
	const pushNotification = (entry: Notification): void => {
		notifications.push(entry);
		notificationsSink?.push(entry);
	};
	const newSessionCalls: unknown[] = [];
	const appendedCustomEntries: AppendedCustomEntry[] = [];
	const switchSessionCalls: string[] = [];
	const activeToolCalls: string[][] = [];
	const widgetUpdates: WidgetUpdates = [];
	const statusUpdates: StatusUpdates = [];
	let sessionFile =
		initialSessionFile ?? path.join(cwd, ".pi", "sessions", "controller.session.json");
	let sessionCounter = 0;
	let disposed = false;
	let stale = false;

	const throwIfDisposed = (): void => {
		if (disposed) {
			throw new Error("ManagedRuntime disposed");
		}
	};
	const throwIfStale = (): void => {
		if (stale) {
			throw new Error(STALE_EXTENSION_CONTEXT_MESSAGE);
		}
	};
	const throwIfInactive = (): void => {
		throwIfStale();
		throwIfDisposed();
	};

	const model =
		modelProvider === undefined ? undefined : { provider: modelProvider, id: "test-model" };

	const getSessionId = (file: string): string =>
		resolveSessionId ? resolveSessionId(file) : "test-session";

	const makeReplacementContext = (targetSessionFile: string): ReplacementSessionContextForTest =>
		({
			cwd,
			hasUI: true,
			model,
			modelRegistry: {
				find: (provider: string, id: string) => ({ provider, id }),
				getAll: () => [],
			},
			sessionManager: {
				getEntries: () => [...replacementEntries],
				getBranch: () => [],
				getSessionId: () => getSessionId(targetSessionFile),
				getSessionFile: () => targetSessionFile,
			},
			ui: {
				setStatus: (_key: string, text: string | undefined) => {
					throwIfDisposed();
					statusUpdates.push(text);
				},
				setWidget: (_key: string, content: unknown) => {
					throwIfDisposed();
					widgetUpdates.push(content);
				},
				setFooter: () => {
					throwIfDisposed();
					return () => undefined;
				},
				setEditorComponent: () => {
					throwIfDisposed();
				},
				notify: (message: string, level: string) => {
					throwIfDisposed();
					pushNotification({ message, level });
				},
				confirm: async () => true,
				getEditorText: () => "",
				custom: async () => undefined,
				theme: {
					fg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				},
			},
			isIdle: () => idle,
			abort: () => undefined,
			hasPendingMessages: () => false,
			shutdown: () => undefined,
			getContextUsage: () => undefined,
			getActiveTools: () => [...(activeToolCalls.at(-1) ?? [])],
			setActiveTools: (tools: string[]) => {
				throwIfDisposed();
				activeToolCalls.push([...tools]);
			},
			getAllTools: () => [],
			getCommands: () => [],
			setModel: async () => true,
			getThinkingLevel: () => "medium",
			setThinkingLevel: () => undefined,
			compact: () => undefined,
			getSystemPrompt: () => "",
			waitForIdle: async () => undefined,
			newSession: async (innerOptions?: unknown) => {
				newSessionCalls.push(innerOptions);
				const sessionOptions = readNewSessionOptionsForTest(innerOptions);
				const plan = newSessionPlan[sessionCounter] ?? { cancelled: false };
				sessionCounter += 1;
				if (!plan.cancelled) {
					const nextSessionFile =
						plan.sessionFile ??
						path.join(cwd, ".pi", "sessions", `child-${sessionCounter}.session.json`);
					if (sessionOptions.setup) {
						const setupSessionManager: SetupSessionManagerForTest = {
							getSessionFile: () => nextSessionFile,
							appendCustomEntry: (customType: string, data?: unknown) => {
								appendedCustomEntries.push({ customType, data });
								return `custom-${appendedCustomEntries.length}`;
							},
						};
						await sessionOptions.setup(setupSessionManager as SessionManager);
					}
					if (sessionOptions.withSession) {
						await sessionOptions.withSession(makeReplacementContext(nextSessionFile));
					}
				}
				return { cancelled: plan.cancelled };
			},
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async (target: string, switchOptions?: unknown) => {
				switchSessionCalls.push(target);
				const sessionOptions = readSwitchSessionOptionsForTest(switchOptions);
				if (sessionOptions.withSession) {
					await sessionOptions.withSession(makeReplacementContext(target));
				}
				return { cancelled: false };
			},
			reload: async () => undefined,
			sendMessage: async () => undefined,
			sendUserMessage: async () => undefined,
		}) as unknown as ReplacementSessionContextForTest;

	const uiHandle: ExtensionCommandContext["ui"] = {
		setStatus: (_key: string, text: string | undefined) => {
			throwIfInactive();
			statusUpdates.push(text);
		},
		setWidget: (_key: string, content: unknown) => {
			throwIfInactive();
			widgetUpdates.push(content);
		},
		setFooter: () => {
			throwIfInactive();
			return () => undefined;
		},
		setEditorComponent: () => {
			throwIfInactive();
		},
		notify: (message: string, level: string) => {
			throwIfInactive();
			pushNotification({ message, level });
		},
		confirm: async () => true,
		getEditorText: () => "",
		custom: async () => undefined,
		theme: {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		},
	} as unknown as ExtensionCommandContext["ui"];

	const ctx = {
		cwd,
		hasUI: true,
		model,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			getAll: () => [],
		},
		sessionManager: {
			getEntries: () => [...initialEntries],
			getBranch: () => [],
			getSessionId: () => getSessionId(sessionFile),
			getSessionFile: () => sessionFile,
		},
		ui: uiHandle,
		isIdle: () => idle,
		abort: () => undefined,
		hasPendingMessages: () => false,
		shutdown: () => undefined,
		getContextUsage: () => undefined,
		getActiveTools: () => [...(activeToolCalls.at(-1) ?? [])],
		setActiveTools: (tools: string[]) => {
			throwIfInactive();
			activeToolCalls.push([...tools]);
		},
		getAllTools: () => [],
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => undefined,
		compact: () => undefined,
		getSystemPrompt: () => "",
		waitForIdle: async () => undefined,
		newSession: async (innerOptions?: unknown) => {
			throwIfInactive();
			newSessionCalls.push(innerOptions);
			const sessionOptions = readNewSessionOptionsForTest(innerOptions);
			const plan = newSessionPlan[sessionCounter] ?? { cancelled: false };
			sessionCounter += 1;
			if (!plan.cancelled) {
				const targetSessionFile =
					plan.sessionFile ??
					path.join(cwd, ".pi", "sessions", `child-${sessionCounter}.session.json`);
				if (sessionOptions.setup) {
					const setupSessionManager: SetupSessionManagerForTest = {
						getSessionFile: () => targetSessionFile,
						appendCustomEntry: (customType: string, data?: unknown) => {
							appendedCustomEntries.push({ customType, data });
							return `custom-${appendedCustomEntries.length}`;
						},
					};
					await sessionOptions.setup(setupSessionManager as SessionManager);
				}
				if (sessionOptions.withSession) {
					await sessionOptions.withSession(makeReplacementContext(targetSessionFile));
				}
				if (plan.updateContextSessionFile !== false) {
					sessionFile = targetSessionFile;
				}
				if (plan.staleContextAfterReplacement) {
					stale = true;
				}
			}
			return { cancelled: plan.cancelled };
		},
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async (target: string, switchOptions?: unknown) => {
			throwIfInactive();
			switchSessionCalls.push(target);
			const sessionOptions = readSwitchSessionOptionsForTest(switchOptions);
			if (sessionOptions.withSession) {
				await sessionOptions.withSession(makeReplacementContext(target));
			}
			sessionFile = target;
			if (staleAfterSwitchSession) {
				stale = true;
			}
			return { cancelled: false };
		},
		reload: async () => undefined,
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		notifications,
		newSessionCalls,
		appendedCustomEntries,
		switchSessionCalls,
		activeToolCalls,
		widgetUpdates,
		statusUpdates,
		disposeCommandContext: () => {
			disposed = true;
		},
		setSessionFile: (next) => {
			sessionFile = next;
		},
		getSessionFile: () => sessionFile,
		markStale: () => {
			stale = true;
		},
		setActiveTools: (next) => {
			activeToolCalls.push([...next]);
		},
		getActiveTools: () => [...(activeToolCalls.at(-1) ?? [])],
	};
}
