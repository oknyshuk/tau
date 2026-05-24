import {
	type AgentSession,
	SettingsManager,
	ModelRegistry,
	DefaultResourceLoader,
	type ToolDefinition,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { Effect, SubscriptionRef, Stream } from "effect";
import { nanoid } from "nanoid";
import { type Status } from "./status.js";
import type { AgentId, AgentDefinition, ModelSpec } from "./types.js";
import {
	loadSubagentDefaults,
	resolveSubagentDefaults,
	type ResolvedSubagentDefaults,
} from "./subagent-defaults.js";
import { type Agent, AgentError } from "./services.js";
import { computeClampedWorkerSandboxConfig } from "./sandbox-policy.js";
import type { ResolvedSandboxConfig } from "../sandbox/config.js";
import type { ExecutionProfile, ExecutionSessionState } from "../execution/schema.js";

import type { ApprovalBroker } from "./approval-broker.js";
import {
	createWorkerAgentTool,
	type RunAgentControlFork,
	type RunAgentControlPromise,
} from "./runtime.js";
import { buildToolDescription } from "./tool.js";
import { buildWorkerAppendPrompts, createWorkerCustomTools } from "./worker/tools.js";
import {
	createSessionForModel,
	type SessionInfra,
	syncExecutionProfileToSession,
	wireSession,
} from "./worker/lifecycle.js";
import { waitForSessionSettlement } from "./worker/session-events.js";
import { resolveModelPattern, toolOnlyStreamFn } from "./worker/model-runner.js";
import {
	buildCompletedStatus,
	buildFailedStatus,
	buildRunningStatus,
	createWorkerTrackingState,
} from "./worker/status.js";
import { WorkerSessionController } from "./worker/session-controller.js";
import { isAgentDisabledForSession } from "../agents-menu/index.js";

export { createWorkerCustomTools } from "./worker/tools.js";
export { resolveModelPattern, toolOnlyStreamFn } from "./worker/model-runner.js";

const MAX_SUBMIT_RESULT_RETRIES = 3;

export class AgentWorker implements Agent {
	private readonly tracking = createWorkerTrackingState();
	private readonly sessionController: WorkerSessionController;

	constructor(
		readonly id: AgentId,
		readonly type: string,
		readonly depth: number,
		private session: AgentSession,
		private readonly statusRef: SubscriptionRef.SubscriptionRef<Status>,
		private readonly infra: SessionInfra,
		private readonly models: readonly ModelSpec[],
		private readonly parentModel: Model<Api> | undefined,
		private readonly executionState: ExecutionSessionState,
		private readonly executionProfile: ExecutionProfile,
		private readonly runFork: RunAgentControlFork,
		private readonly agentContext: {
			parentSessionFile: string | undefined;
			parentAgentId?: AgentId | undefined;
			parentModel: Model<Api> | undefined;
			parentExecutionState: ExecutionSessionState;
			parentExecutionProfile: ExecutionProfile;
			modelRegistry: ModelRegistry;
			cwd: string;
			approvalBroker: ApprovalBroker | undefined;
		},
	) {
		this.sessionController = new WorkerSessionController({
			tracking: this.tracking,
			resultSchema: this.infra.resultSchema,
			maxSubmitResultRetries: MAX_SUBMIT_RESULT_RETRIES,
			spawnBackground: (effect) => this.runFork(effect),
			publishRunningStatus: () => this.publishRunningStatus(),
			publishRunningStatusIfNotFinal: () => this.publishRunningStatusIfNotFinal(),
			publishCompleted: (message) => this.publishCompleted(message),
			publishFailed: (reason) => this.publishFailed(reason),
			repromptForSubmitResult: (retry) => this.repromptForSubmitResult(retry),
			statusRef: this.statusRef,
		});
	}

	get definition(): AgentDefinition {
		return this.infra.definition;
	}

	private get structuredOutput(): unknown {
		return this.tracking.structuredOutput;
	}

	private set structuredOutput(value: unknown) {
		this.tracking.structuredOutput = value;
	}

	private get submitResultRetries(): number {
		return this.tracking.submitResultRetries;
	}

	private set submitResultRetries(value: number) {
		this.tracking.submitResultRetries = value;
	}

	private get turns(): number {
		return this.tracking.turns;
	}

	private get toolCalls(): number {
		return this.tracking.toolCalls;
	}

	private get workedMs(): number {
		return this.tracking.workedMs;
	}

	private get terminalState(): "completed" | "failed" | "shutdown" | undefined {
		return this.tracking.terminalState;
	}

	private set terminalState(value: "completed" | "failed" | "shutdown" | undefined) {
		this.tracking.terminalState = value;
	}

	private currentRunningStatus(): Status {
		return buildRunningStatus(this.tracking);
	}

	private publishStatus(status: Status): void {
		Effect.runSync(SubscriptionRef.set(this.statusRef, status));
	}

	private publishRunningStatus(): void {
		this.publishStatus(this.currentRunningStatus());
	}

	private publishRunningStatusIfNotFinal(): void {
		if (this.terminalState !== undefined) {
			return;
		}
		this.publishRunningStatus();
	}

	private publishFailed(reason: string): void {
		this.terminalState = "failed";
		this.publishStatus(buildFailedStatus(this.tracking, reason));
	}

	private publishCompleted(message: string | undefined): void {
		this.terminalState = "completed";
		this.publishStatus(buildCompletedStatus(this.tracking, message, this.structuredOutput));
	}

	private repromptForSubmitResult(retry: number): Effect.Effect<void> {
		const reminderMessage = `You MUST call the submit_result tool with JSON matching the provided schema. This is retry ${retry} of ${MAX_SUBMIT_RESULT_RETRIES}. Call submit_result now.`;
		return Effect.tryPromise({
			try: () =>
				this.session.prompt(reminderMessage, {
					source: "extension",
					streamingBehavior: "steer",
				}),
			catch: (error) => new Error(error instanceof Error ? error.message : String(error)),
		}).pipe(
			Effect.catch((error) => {
				const reason = error instanceof Error ? error.message : String(error);
				return Effect.sync(() => {
					this.publishFailed(reason);
				});
			}),
		);
	}

	static make(opts: {
		definition: AgentDefinition;
		depth: number;
		cwd: string;
		parentSessionFile: string | undefined;
		executionState: ExecutionSessionState;
		executionProfile: ExecutionProfile;
		parentSandboxConfig: ResolvedSandboxConfig;
		parentModel: Model<Api> | undefined;
		approvalBroker: ApprovalBroker | undefined;
		modelRegistry?: ModelRegistry | undefined;
		resultSchema?: unknown;
		runPromise: RunAgentControlPromise;
		runFork: RunAgentControlFork;
		agentSummaries?: ReadonlyArray<{ readonly name: string; readonly description: string }>;
		/**
		 * Override subagent defaults loading. When omitted, defaults are
		 * loaded from `tau.subagentDefaults` in user/project settings and
		 * resolved against `modelRegistry`. Tests pass an explicit value
		 * (often `{ model: undefined, thinking: undefined }`) to skip the
		 * settings read.
		 */
		subagentDefaults?: ResolvedSubagentDefaults;
	}) {
		return Effect.gen(function* () {
			if (opts.modelRegistry === undefined) {
				return yield* Effect.fail(
					new AgentError({
						message: "Agent model registry is unavailable from the parent session",
					}),
				);
			}

			const modelRegistry = opts.modelRegistry;
			const authStorage = modelRegistry.authStorage;

			const appendPrompts = buildWorkerAppendPrompts({
				definition: opts.definition,
				resultSchema: opts.resultSchema,
			});

			const statusRef = yield* SubscriptionRef.make<Status>({ state: "pending" });

			const models = opts.definition.models;

			// Stable agent ID (survives session recreation on model fallback)
			const agentId: AgentId = nanoid(12);

			// Mutable context for nested agent tool
			const agentContext = {
				parentSessionFile: opts.parentSessionFile,
				parentAgentId: agentId,
				parentModel: opts.parentModel,
				parentExecutionState: opts.executionState,
				parentExecutionProfile: opts.executionProfile,
				resolveParentExecution: async () => ({
					state: agentContext.parentExecutionState,
					profile: agentContext.parentExecutionProfile,
				}),
				modelRegistry,
				cwd: opts.cwd,
				approvalBroker: opts.approvalBroker,
			};

			const agentTool = createWorkerAgentTool(
				opts.runPromise,
				agentContext,
				opts.agentSummaries
					? buildToolDescription(
							{ list: () => opts.agentSummaries ?? [] },
							opts.definition.spawns,
							(name) =>
								isAgentDisabledForSession(opts.cwd, opts.parentSessionFile, name),
						)
					: "Manage non-blocking agent tasks. Actions: spawn, send, wait, close, list.",
			);

			const customTools = createWorkerCustomTools(agentTool as ToolDefinition);

			// submit_result tool placeholder - needs agent reference, set after construction
			let agent: AgentWorker;

			if (opts.resultSchema) {
				customTools.push({
					name: "submit_result",
					label: "submit_result",
					description: "Submit structured result for the task",
					parameters: Type.Unsafe(opts.resultSchema as object),
					async execute(
						_toolCallId: string,
						params: unknown,
						signal: AbortSignal | undefined,
						_onUpdate,
						_ctx,
					) {
						if (signal?.aborted) throw new Error("Aborted");
						agent.structuredOutput = params;
						agent.session.abort().catch((error) => {
							Effect.runSync(Effect.logWarning("Agent session abort failed", error));
						});
						return {
							content: [{ type: "text" as const, text: "Result received." }],
							details: { ok: true },
						};
					},
				} as ToolDefinition);
			}

			const settingsManager = SettingsManager.inMemory();

			const resourceLoader = new DefaultResourceLoader({
				cwd: opts.cwd,
				agentDir: getAgentDir(),
				settingsManager,
				noExtensions: true,
				appendSystemPromptOverride: (base) => [...base, ...appendPrompts],
			});
			yield* Effect.promise(() => resourceLoader.reload());

			const sandboxConfig = computeClampedWorkerSandboxConfig(
				opts.definition.sandbox
					? { parent: opts.parentSandboxConfig, requested: opts.definition.sandbox }
					: { parent: opts.parentSandboxConfig },
			);

			const subagentDefaults = opts.subagentDefaults
				? opts.subagentDefaults
				: yield* (Effect.gen(function* () {
						const raw = yield* loadSubagentDefaults(opts.cwd).pipe(
							Effect.mapError(
								(cause) =>
									new AgentError({
										message: `Failed to load tau.subagentDefaults: ${
											cause instanceof Error ? cause.message : String(cause)
										}`,
									}),
							),
						);
						return yield* resolveSubagentDefaults(raw, modelRegistry).pipe(
							Effect.mapError(
								(cause) =>
									new AgentError({
										message: cause.message,
									}),
							),
						);
					}));

			const infra: SessionInfra = {
				authStorage,
				modelRegistry,
				settingsManager,
				resourceLoader,
				customTools,
				sandboxConfig,
				appendPrompts,
				cwd: opts.cwd,
				approvalBroker: opts.approvalBroker,
				definition: opts.definition,
				resultSchema: opts.resultSchema,
				executionPolicy: opts.executionState.policy,
				subagentInheritModel: subagentDefaults.model,
				subagentInheritThinking: subagentDefaults.thinking,
			};

			// Create initial session with first model
			const firstSpec = models[0];
			if (!firstSpec) {
				return yield* Effect.fail(
					new AgentError({ message: "Agent definition has no models" }),
				);
			}
			const session = yield* createSessionForModel(
				infra,
				firstSpec,
				opts.parentModel,
				modelRegistry,
			);

			agentContext.parentExecutionProfile = syncExecutionProfileToSession(
				agentContext.parentExecutionProfile,
				session,
			);

			// Wire sandbox and approval broker for the session
			wireSession(session, sandboxConfig, opts.approvalBroker, opts.executionState);

			if (opts.resultSchema) {
				session.agent.streamFn = toolOnlyStreamFn;
			}

			agent = new AgentWorker(
				agentId,
				opts.definition.name,
				opts.depth,
				session,
				statusRef,
				infra,
				models,
				opts.parentModel,
				opts.executionState,
				agentContext.parentExecutionProfile,
				opts.runFork,
				agentContext,
			);

			agent.subscribeToSession(session);

			return agent;
		});
	}

	/** Subscribe to session events for status tracking. Replaces any previous subscription. */
	private subscribeToSession(session: AgentSession): void {
		this.sessionController.attach(session);
	}

	private switchToModel(spec: ModelSpec): Effect.Effect<void, string> {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const worker = this;
		return Effect.gen(function* () {
			yield* Effect.promise(() => worker.session.abort()).pipe(
				Effect.tapError((error) =>
					Effect.logWarning("Agent session abort failed during model switch", error),
				),
				Effect.catch(() => Effect.void),
			);
			worker.sessionController.releaseSession(worker.session.sessionId);

			const newSession = yield* createSessionForModel(
				worker.infra,
				spec,
				worker.parentModel,
				worker.infra.modelRegistry,
			).pipe(Effect.mapError((err) => (err instanceof Error ? err.message : String(err))));

			worker.session = newSession;
			worker.agentContext.parentExecutionProfile = syncExecutionProfileToSession(
				worker.agentContext.parentExecutionProfile,
				newSession,
			);
			wireSession(
				newSession,
				worker.infra.sandboxConfig,
				worker.infra.approvalBroker,
				worker.executionState,
			);
			if (worker.infra.resultSchema) {
				newSession.agent.streamFn = toolOnlyStreamFn;
			}
			worker.subscribeToSession(newSession);
		});
	}

	private promptSession(message: string, modelLabel: string): Effect.Effect<void, string> {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const worker = this;
		return Effect.gen(function* () {
			if (worker.session.isStreaming) {
				yield* Effect.tryPromise({
					try: () =>
						worker.session.prompt(message, {
							source: "extension",
							streamingBehavior: "steer",
						}),
					catch: (err) =>
						`${modelLabel}: ${err instanceof Error ? err.message : String(err)}`,
				});
				return;
			}

			yield* Effect.tryPromise({
				try: () =>
					worker.session.prompt(message, {
						source: "extension",
						streamingBehavior: "steer",
					}),
				catch: (err) =>
					`${modelLabel}: ${err instanceof Error ? err.message : String(err)}`,
			});

			const settled = yield* waitForSessionSettlement(worker.session);

			if (!settled.ok) {
				return yield* Effect.fail(`${modelLabel}: ${settled.reason}`);
			}
		});
	}

	private failAllModels(errors: readonly string[]): Effect.Effect<void> {
		const reason =
			errors.length === 1
				? (errors[0] ?? "Unknown error")
				: `All models failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`;

		return SubscriptionRef.set(this.statusRef, buildFailedStatus(this.tracking, reason));
	}

	private tryModelSpec(
		message: string,
		spec: ModelSpec,
		index: number,
	): Effect.Effect<void, string> {
		return index === 0
			? this.promptSession(message, spec.model)
			: this.switchToModel(spec).pipe(
					Effect.flatMap(() => this.promptSession(message, spec.model)),
				);
	}

	private runWithModelFallback(message: string): Effect.Effect<void> {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const worker = this;
		return Effect.gen(function* () {
			const errors: string[] = [];
			let done = false;

			for (let index = 0; index < worker.models.length && !done; index++) {
				const spec = worker.models[index];
				if (!spec) continue;
				const result = yield* Effect.result(worker.tryModelSpec(message, spec, index));
				if (result._tag === "Success") {
					done = true;
				} else {
					errors.push(result.failure);
				}
			}

			if (!done) {
				yield* worker.failAllModels(errors);
			}
		});
	}

	prompt(message: string): Effect.Effect<string, AgentError> {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const worker = this;
		return Effect.gen(function* () {
			const submissionId = `sub-${nanoid(12)}`;
			worker.submitResultRetries = 0;
			worker.structuredOutput = undefined;
			worker.terminalState = undefined;

			yield* SubscriptionRef.set(worker.statusRef, worker.currentRunningStatus());

			yield* worker.sessionController.replaceBackground(
				worker.runWithModelFallback(message).pipe(
					Effect.catch((err: unknown) => {
						const reason = err instanceof Error ? err.message : String(err);
						return SubscriptionRef.set(
							worker.statusRef,
							buildFailedStatus(worker.tracking, reason),
						);
					}),
				),
			);

			return submissionId;
		});
	}

	interrupt(): Effect.Effect<void> {
		return Effect.promise(() => this.session.abort());
	}

	shutdown(): Effect.Effect<void> {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const worker = this;
		return Effect.gen(function* () {
			const abortSession = worker.terminalState === undefined;
			worker.terminalState = "shutdown";
			yield* worker.sessionController.shutdown(worker.session, { abortSession });
		});
	}

	get status(): Effect.Effect<Status> {
		return SubscriptionRef.get(this.statusRef);
	}

	subscribeStatus(): Stream.Stream<Status> {
		return SubscriptionRef.changes(this.statusRef);
	}
}
