import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentControl } from "../src/agent/services.js";
import type { AgentDefinition } from "../src/agent/types.js";
import type { RunAgentControlFork } from "../src/agent/runtime.js";
import type { CuratedMemory } from "../src/services/curated-memory.js";
import type { ExecutionState } from "../src/services/execution-state.js";
import type { ResolvedSandboxConfig } from "../src/sandbox/config.js";
import { TAU_PERSISTED_STATE_TYPE } from "../src/shared/state.js";

const {
	createAgentSessionMock,
	applyAgentToolAllowlistMock,
	createdSessions,
	resourceLoaderOptions,
} = vi.hoisted(() => ({
	createAgentSessionMock: vi.fn(),
	applyAgentToolAllowlistMock: vi.fn(),
	createdSessions: [] as FakeAgentSession[],
	resourceLoaderOptions: [] as Array<{ readonly cwd: unknown; readonly agentDir: unknown }>,
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
		"@earendil-works/pi-coding-agent",
	);

	class FakeDefaultResourceLoader {
		constructor(options: { readonly cwd: unknown; readonly agentDir: unknown }) {
			resourceLoaderOptions.push({ cwd: options.cwd, agentDir: options.agentDir });
		}

		async reload(): Promise<void> {}
	}

	return {
		...actual,
		createAgentSession: createAgentSessionMock,
		DefaultResourceLoader: FakeDefaultResourceLoader,
	};
});

vi.mock("../src/agent/tool-allowlist.js", async () => {
	const { Effect } = await import("effect");
	return {
		applyAgentToolAllowlist: (...args: unknown[]) => {
			applyAgentToolAllowlistMock(...args);
			return Effect.void;
		},
		STRUCTURED_OUTPUT_TOOL_NAME: "submit_result",
	};
});

import { AgentWorker, toolOnlyStreamFn } from "../src/agent/worker.js";

type FakeSessionManager = {
	getEntries: () => unknown[];
	appendCustomEntry: (customType: string, data: unknown) => void;
	getSessionFile: () => string;
};

class FakeAgentSession {
	readonly sessionId: string;
	readonly sessionManager: FakeSessionManager;
	readonly agent: AgentSession["agent"];
	readonly messages: readonly unknown[] = [];
	readonly isStreaming = false;
	readonly isCompacting = false;
	readonly customEntries: Array<{ customType: string; data: unknown }> = [];
	readonly model: Model<Api>;
	thinkingLevel: AgentSession["thinkingLevel"] = "medium";

	constructor(id: string, streamFn: AgentSession["agent"]["streamFn"], model: Model<Api>) {
		this.sessionId = id;
		this.model = model;
		const sessionFile = `/tmp/${id}.jsonl`;
		this.sessionManager = {
			getEntries: () => [],
			appendCustomEntry: (customType, data) => {
				this.customEntries.push({ customType, data });
			},
			getSessionFile: () => sessionFile,
		};
		this.agent = {
			streamFn,
		} as AgentSession["agent"];
	}

	setThinkingLevel(level: AgentSession["thinkingLevel"]): void {
		this.thinkingLevel = level;
	}
	subscribe(): () => void {
		return () => undefined;
	}
	abort(): Promise<void> {
		return Promise.resolve();
	}
}

const TEST_MODEL: Model<Api> = {
	id: "gpt-5.4",
	name: "gpt-5.4",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
};

const TEST_FALLBACK_MODEL: Model<Api> = {
	id: "claude-opus-4-5",
	name: "claude-opus-4-5",
	api: "anthropic",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
};

const TEST_DEFINITION = {
	name: "oracle",
	description: "Oracle worker",
	models: [{ model: "openai-codex/gpt-5.4" }],
	sandbox: { preset: "workspace-write", subagent: true },
	systemPrompt: "You are oracle.",
} satisfies AgentDefinition;

const PARENT_SANDBOX_CONFIG: ResolvedSandboxConfig = {
	preset: "workspace-write",
	filesystemMode: "workspace-write",
	networkMode: "deny",
	approvalPolicy: "on-request",
	approvalTimeoutSeconds: 30,
	subagent: false,
};

const TEST_EXECUTION_STATE = {
	policy: {
		tools: {
			kind: "inherit",
		},
	},
} as const;

const TEST_EXECUTION_PROFILE = {
	model: "openai-codex/gpt-5.4",
	thinking: "medium",
	policy: {
		tools: {
			kind: "inherit",
		},
	},
} as const;

const makeModelRegistry = () => ({
	authStorage: {},
	getAll: () => [TEST_MODEL, TEST_FALLBACK_MODEL],
});

const runForkForTests: RunAgentControlFork = <
	A,
	E,
	R extends AgentControl | CuratedMemory | ExecutionState,
>(
	effect: Effect.Effect<A, E, R>,
) => Effect.runFork(effect as unknown as Effect.Effect<A, E, never>);

const makeSession = (index: number, model: Model<Api>): FakeAgentSession => {
	const session = new FakeAgentSession(
		`session-${index}`,
		vi.fn() as AgentSession["agent"]["streamFn"],
		model,
	);
	createdSessions.push(session);
	return session;
};

describe("AgentWorker structured-output wiring", () => {
	beforeEach(() => {
		createAgentSessionMock.mockReset();
		applyAgentToolAllowlistMock.mockClear();
		createdSessions.length = 0;
		resourceLoaderOptions.length = 0;
		createAgentSessionMock.mockImplementation(async () => ({
			session: makeSession(createdSessions.length + 1, TEST_MODEL) as unknown as AgentSession,
		}));
	});

	it("installs toolOnlyStreamFn on the created session when structured output is requested", async () => {
		await Effect.runPromise(
			AgentWorker.make({
				definition: TEST_DEFINITION,
				depth: 0,
				cwd: process.cwd(),
				parentSessionFile: "parent-session",
				executionState: TEST_EXECUTION_STATE,
				executionProfile: TEST_EXECUTION_PROFILE,
				parentSandboxConfig: PARENT_SANDBOX_CONFIG,
				parentModel: TEST_MODEL,
				approvalBroker: undefined,
				modelRegistry: makeModelRegistry() as never,
				resultSchema: { type: "object", properties: { ok: { type: "boolean" } } },
				runPromise: async () => {
					throw new Error("unused");
				},
				runFork: runForkForTests,
				subagentDefaults: { model: undefined, thinking: undefined },
			}),
		);

		expect(createdSessions).toHaveLength(1);
		expect(resourceLoaderOptions[0]?.cwd).toBe(process.cwd());
		expect(resourceLoaderOptions[0]?.agentDir).toEqual(expect.any(String));
		expect(resourceLoaderOptions[0]?.agentDir).not.toBe("");
		expect(createdSessions[0]?.agent.streamFn).toBe(toolOnlyStreamFn);
		expect(applyAgentToolAllowlistMock).toHaveBeenCalledTimes(1);
	});

	it("fails instead of creating a fallback session when the configured model cannot resolve", async () => {
		await expect(
			Effect.runPromise(
				AgentWorker.make({
					definition: {
						...TEST_DEFINITION,
						models: [{ model: "unknown-provider/nope" }],
					},
					depth: 0,
					cwd: process.cwd(),
					parentSessionFile: "parent-session",
					executionState: TEST_EXECUTION_STATE,
					executionProfile: TEST_EXECUTION_PROFILE,
					parentSandboxConfig: PARENT_SANDBOX_CONFIG,
					parentModel: TEST_MODEL,
					approvalBroker: undefined,
					modelRegistry: makeModelRegistry() as never,
					resultSchema: undefined,
					runPromise: async () => {
						throw new Error("unused");
					},
					runFork: runForkForTests,
				subagentDefaults: { model: undefined, thinking: undefined },
				}),
			),
		).rejects.toThrow('Agent model "unknown-provider/nope" is not available');

		expect(createAgentSessionMock).not.toHaveBeenCalled();
	});

	it("fails before session creation when parent model registry is unavailable", async () => {
		await expect(
			Effect.runPromise(
				AgentWorker.make({
					definition: TEST_DEFINITION,
					depth: 0,
					cwd: process.cwd(),
					parentSessionFile: "parent-session",
					executionState: TEST_EXECUTION_STATE,
					executionProfile: TEST_EXECUTION_PROFILE,
					parentSandboxConfig: PARENT_SANDBOX_CONFIG,
					parentModel: TEST_MODEL,
					approvalBroker: undefined,
					modelRegistry: undefined,
					resultSchema: undefined,
					runPromise: async () => {
						throw new Error("unused");
					},
					runFork: runForkForTests,
				}),
			),
		).rejects.toThrow("Agent model registry is unavailable from the parent session");

		expect(createAgentSessionMock).not.toHaveBeenCalled();
	});

	it("reinstalls toolOnlyStreamFn after session recreation on model switch", async () => {
		const worker = await Effect.runPromise(
			AgentWorker.make({
				definition: TEST_DEFINITION,
				depth: 0,
				cwd: process.cwd(),
				parentSessionFile: "parent-session",
				executionState: TEST_EXECUTION_STATE,
				executionProfile: TEST_EXECUTION_PROFILE,
				parentSandboxConfig: PARENT_SANDBOX_CONFIG,
				parentModel: TEST_MODEL,
				approvalBroker: undefined,
				modelRegistry: makeModelRegistry() as never,
				resultSchema: { type: "object", properties: { ok: { type: "boolean" } } },
				runPromise: async () => {
					throw new Error("unused");
				},
				runFork: runForkForTests,
				subagentDefaults: { model: undefined, thinking: undefined },
			}),
		);

		await Effect.runPromise(
			(
				worker as unknown as {
					switchToModel: (spec: { model: string }) => Effect.Effect<void, string>;
				}
			).switchToModel({ model: "openai-codex/gpt-5.4" }),
		);

		expect(createdSessions).toHaveLength(2);
		expect(createdSessions[1]?.agent.streamFn).toBe(toolOnlyStreamFn);
	});

	it("updates inherited execution profile after worker model fallback", async () => {
		const sessionModels = [TEST_MODEL, TEST_FALLBACK_MODEL];
		createAgentSessionMock.mockImplementation(async () => {
			const model = sessionModels[createdSessions.length] ?? TEST_MODEL;
			return {
				session: makeSession(createdSessions.length + 1, model) as unknown as AgentSession,
			};
		});

		const worker = await Effect.runPromise(
			AgentWorker.make({
				definition: TEST_DEFINITION,
				depth: 0,
				cwd: process.cwd(),
				parentSessionFile: "parent-session",
				executionState: TEST_EXECUTION_STATE,
				executionProfile: TEST_EXECUTION_PROFILE,
				parentSandboxConfig: PARENT_SANDBOX_CONFIG,
				parentModel: TEST_MODEL,
				approvalBroker: undefined,
				modelRegistry: makeModelRegistry() as never,
				resultSchema: undefined,
				runPromise: async () => {
					throw new Error("unused");
				},
				runFork: runForkForTests,
				subagentDefaults: { model: undefined, thinking: undefined },
			}),
		);

		await Effect.runPromise(
			(
				worker as unknown as {
					switchToModel: (spec: {
						model: string;
						thinking?: "high";
					}) => Effect.Effect<void, string>;
				}
			).switchToModel({ model: "anthropic/claude-opus-4-5", thinking: "high" }),
		);

		const parentExecutionProfile = (
			worker as unknown as {
			agentContext: {
				parentExecutionProfile: {
					model: string;
					thinking: string;
				};
			};
		}
	).agentContext.parentExecutionProfile;

	expect(parentExecutionProfile.model).toBe("anthropic/claude-opus-4-5");
	expect(parentExecutionProfile.thinking).toBe("high");
	});

	it("preserves the inherited session file for nested agent gating", async () => {
		const parentSessionFile = "/tmp/parent-session.jsonl";
		const worker = await Effect.runPromise(
			AgentWorker.make({
				definition: TEST_DEFINITION,
				depth: 0,
				cwd: process.cwd(),
				parentSessionFile,
				executionState: TEST_EXECUTION_STATE,
				executionProfile: TEST_EXECUTION_PROFILE,
				parentSandboxConfig: PARENT_SANDBOX_CONFIG,
				parentModel: TEST_MODEL,
				approvalBroker: undefined,
				modelRegistry: makeModelRegistry() as never,
				resultSchema: undefined,
				runPromise: async () => {
					throw new Error("unused");
				},
				runFork: runForkForTests,
				subagentDefaults: { model: undefined, thinking: undefined },
			}),
		);

		const agentContext = (
			worker as unknown as {
				agentContext: {
					parentSessionFile: string | undefined;
				};
			}
		).agentContext;

		expect(agentContext.parentSessionFile).toBe(parentSessionFile);
	});

	it("preserves the inherited session file after worker model fallback", async () => {
		const parentSessionFile = "/tmp/parent-session.jsonl";
		const worker = await Effect.runPromise(
			AgentWorker.make({
				definition: TEST_DEFINITION,
				depth: 0,
				cwd: process.cwd(),
				parentSessionFile,
				executionState: TEST_EXECUTION_STATE,
				executionProfile: TEST_EXECUTION_PROFILE,
				parentSandboxConfig: PARENT_SANDBOX_CONFIG,
				parentModel: TEST_MODEL,
				approvalBroker: undefined,
				modelRegistry: makeModelRegistry() as never,
				resultSchema: undefined,
				runPromise: async () => {
					throw new Error("unused");
				},
				runFork: runForkForTests,
				subagentDefaults: { model: undefined, thinking: undefined },
			}),
		);

		await Effect.runPromise(
			(
				worker as unknown as {
					switchToModel: (spec: { model: string }) => Effect.Effect<void, string>;
				}
			).switchToModel({ model: "openai-codex/gpt-5.4" }),
		);

		const agentContext = (
			worker as unknown as {
				agentContext: {
					parentSessionFile: string | undefined;
				};
			}
		).agentContext;

		expect(createdSessions).toHaveLength(2);
		expect(createdSessions[1]?.sessionManager.getSessionFile()).not.toBe(parentSessionFile);
		expect(agentContext.parentSessionFile).toBe(parentSessionFile);
	});

	it("persists resolved execution state into child session state", async () => {
		await Effect.runPromise(
			AgentWorker.make({
				definition: TEST_DEFINITION,
				depth: 0,
				cwd: process.cwd(),
				parentSessionFile: "parent-session",
				executionState: TEST_EXECUTION_STATE,
				executionProfile: TEST_EXECUTION_PROFILE,
				parentSandboxConfig: PARENT_SANDBOX_CONFIG,
				parentModel: TEST_MODEL,
				approvalBroker: undefined,
				modelRegistry: makeModelRegistry() as never,
				resultSchema: undefined,
				runPromise: async () => {
					throw new Error("unused");
				},
				runFork: runForkForTests,
				subagentDefaults: { model: undefined, thinking: undefined },
			}),
		);

		expect(createdSessions).toHaveLength(1);
		const session = createdSessions[0];
		expect(session?.customEntries).toHaveLength(1);
		expect(session?.customEntries[0]).toMatchObject({
			customType: TAU_PERSISTED_STATE_TYPE,
			data: {
			execution: {
				policy: {
						tools: {
							kind: "inherit",
						},
					},
				},
			},
		});
	});
});
