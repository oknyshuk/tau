import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	truncateTail,
	formatSize,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import { Cause, Effect, Option } from "effect";

import { Sandbox } from "../services/sandbox.js";
import { ExecutionRuntime } from "../services/execution-runtime.js";
import { LoopEngine, type LoopEngineService } from "../services/loop-engine.js";
import {
	AutoresearchLoopRunner,
	type AutoresearchLoopRunnerService,
} from "../services/autoresearch-loop-runner.js";
import {
	type BenchmarkProgress,
	type ExecuteBenchmarkInput,
	type RunDetails,
	type AutoresearchViewData,
} from "../services/autoresearch.js";
import type { ExecutionProfile } from "../execution/schema.js";
import { getSandboxedBashOperations } from "../sandbox/index.js";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
	LoopContractValidationError,
	LoopLifecycleConflictError,
	LoopOwnershipValidationError,
	LoopTaskAlreadyExistsError,
	LoopTaskNotFoundError,
	LoopAmbiguousOwnershipError,
} from "../loops/errors.js";
import {
	decodeLoopTaskIdSync,
	decodeAutoresearchPhaseSnapshotJsonSync,
	decodeLoopPersistedStateJsonSync,
	encodeLoopPersistedStateJsonSync,
	type AutoresearchLoopPersistedState,
	type LoopPersistedState,
	type LoopSessionRef,
} from "../loops/schema.js";
import {
	loopPhaseFile,
	loopRunDirectory,
	loopRunsDirectory,
	loopStateFile,
	loopTaskFile,
} from "../loops/paths.js";
import { resolveLoopWorkspacePath, resolveLoopWorkspaceRoot } from "../loops/workspace-root.js";
import {
	normalizeAutoresearchTaskContractInput,
	parseAutoresearchTaskDocument,
	renderAutoresearchTaskDocument,
} from "./task-contract.js";
import { atomicWriteFileStringSync } from "../shared/atomic-write.js";
import { AutoresearchValidationError } from "./errors.js";
import {
	formatNum,
	formatElapsed,
	inferMetricUnitFromName,
	parseMetricLines,
	parseAsiLines,
	EXPERIMENT_MAX_BYTES,
	EXPERIMENT_MAX_LINES,
} from "./helpers.js";
import { renderRunExperimentResult } from "./run-experiment-render.js";
import {
	renderWidget,
	renderExpandedHeader,
	renderDashboardLines,
	renderOverlayRunningLine,
	renderOverlayFooter,
} from "./dashboard.js";
import { shouldCloseAutoresearchOverlay } from "./overlay-input.js";
import type { ExperimentResult } from "./schema.js";
import { computeConfidence, findBestResult } from "./state.js";
import { setToolEnabled } from "../shared/tool-activation.js";
import { isRecord } from "../shared/json.js";
import {
	cwdFromContextIfLive,
	isIgnorableSessionContextError,
	sessionFileFromContextIfLive,
} from "../shared/extension-context.js";

const AUTORESEARCH_RUN_TOOL_NAME = "autoresearch_run";
const AUTORESEARCH_DONE_TOOL_NAME = "autoresearch_done";

// ------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------

function stripSurroundingQuotes(value: string): string {
	return value.replace(/^"|"$/g, "");
}

function tokenizeCommandArgs(args: string): ReadonlyArray<string> {
	return (args.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((token) =>
		stripSurroundingQuotes(token),
	);
}

function commandSessionRef(
	ctx: Pick<ExtensionCommandContext, "sessionManager">,
): Option.Option<LoopSessionRef> {
	const sessionFile =
		typeof ctx.sessionManager.getSessionFile === "function"
			? ctx.sessionManager.getSessionFile()
			: undefined;
	if (sessionFile === undefined) {
		return Option.none();
	}
	return Option.some({
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile,
	});
}

function getSessionKey(ctx: Pick<ExtensionContext, "sessionManager">): string {
	return ctx.sessionManager.getSessionId();
}

function isAutoresearchLoopState(state: LoopPersistedState): boolean {
	return (
		state.kind === "autoresearch" ||
		(state.kind === "blocked_manual_resolution" && state.previousKind === "autoresearch")
	);
}

function formatAutoresearchLoopState(state: LoopPersistedState): string {
	if (state.kind === "autoresearch") {
		const pendingRun = Option.match(state.autoresearch.pendingRunId, {
			onNone: () => "none",
			onSome: (runId) => runId,
		});
		const phase = Option.match(state.autoresearch.phaseId, {
			onNone: () => "none",
			onSome: (phaseId) => phaseId,
		});
		return `${state.taskId}: ${state.lifecycle} (phase=${phase}, pending_run=${pendingRun}, runs=${state.autoresearch.runCount})`;
	}
	if (state.kind === "blocked_manual_resolution") {
		return `${state.taskId}: blocked (${state.blocked.reasonCode}) ${state.blocked.message}`;
	}
	return `${state.taskId}: ${state.lifecycle}`;
}

function validateTaskId(input: string): string {
	return decodeLoopTaskIdSync(input.trim());
}

function createDefaultTaskDocument(taskId: string, goalText: string): string {
	const defaultContract = normalizeAutoresearchTaskContractInput({
		title: taskId,
		benchmarkCommand: "bash autoresearch.sh",
		checksCommand: Option.none(),
		metricName: "metric",
		metricUnit: "",
		metricDirection: "lower",
		scopeRoot: ".",
		scopePaths: ["."],
		offLimits: [],
		constraints: [],
		maxIterations: Option.none(),
	});
	return renderAutoresearchTaskDocument(defaultContract, goalText);
}

type AutoresearchRunOutcome = "keep" | "discard" | "crash" | "checks_failed";

type PersistedAutoresearchRun = {
	readonly kind: "autoresearch_run";
	readonly version: 1;
	readonly taskId: string;
	readonly runId: string;
	readonly runNumber: number;
	readonly phaseId: string;
	readonly createdAt: string;
	readonly childSession: LoopSessionRef;
	readonly controllerSession: LoopSessionRef;
	readonly benchmark: {
		readonly command: string;
		readonly durationSeconds: number;
		readonly exitCode: number | null;
		readonly timedOut: boolean;
		readonly passed: boolean;
		readonly logFile: string;
		readonly tailOutput: string;
	};
	readonly checks: {
		readonly command: string;
		readonly durationSeconds: number;
		readonly passed: boolean | null;
		readonly timedOut: boolean;
		readonly logFile: string | null;
		readonly outputTail: string;
	} | null;
	readonly parsed: {
		readonly metricName: string;
		readonly metricUnit: string;
		readonly metrics: Record<string, number> | null;
		readonly primary: number | null;
		readonly asi: Record<string, unknown> | null;
	};
	readonly fullOutputLogFile: string | null;
	readonly finalized: {
		readonly status: AutoresearchRunOutcome;
		readonly description: string;
		readonly decidedAt: string;
		readonly metrics: Record<string, number> | null;
		readonly asi: Record<string, unknown> | null;
	} | null;
};

const RUN_BENCHMARK_LOG_FILE = "benchmark.log";
const RUN_CHECKS_LOG_FILE = "checks.log";
const RUN_FULL_OUTPUT_LOG_FILE = "benchmark.full.log";
const RUN_RECORD_FILE = "run.json";
const LEGACY_AUTORESEARCH_ARTIFACTS = [
	".autoresearch",
	"autoresearch.jsonl",
	"autoresearch.md",
	"autoresearch.ideas.md",
	"autoresearch.program.md",
	"autoresearch.config.json",
] as const;


function sessionRefMatches(left: LoopSessionRef, right: LoopSessionRef): boolean {
	return left.sessionFile === right.sessionFile;
}

function assertNoLegacyAutoresearchLayout(cwd: string): void {
	const present = LEGACY_AUTORESEARCH_ARTIFACTS.filter((artifact) =>
		fs.existsSync(path.resolve(cwd, artifact)),
	);
	if (present.length === 0) {
		return;
	}
	throw new LoopContractValidationError({
		entity: "loops.autoresearch.legacy_layout",
		reason:
			`Legacy autoresearch artifacts are present: ${present.join(", ")}. ` +
			"Legacy autoresearch files are not imported automatically. Remove them or import them explicitly before creating task-scoped loops.",
	});
}

function requireAutoresearchLoopState(state: LoopPersistedState): AutoresearchLoopPersistedState {
	if (state.kind !== "autoresearch") {
		throw new AutoresearchValidationError({
			reason: `Task ${state.taskId} is ${state.kind}. Autoresearch tools require kind=autoresearch.`,
		});
	}
	return state;
}

function isLoopSessionRef(value: unknown): value is LoopSessionRef {
	if (!isRecord(value)) {
		return false;
	}
	return (
		typeof value["sessionId"] === "string" &&
		value["sessionId"].trim().length > 0 &&
		typeof value["sessionFile"] === "string" &&
		value["sessionFile"].trim().length > 0
	);
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
	return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isNumericRecordOrNull(value: unknown): value is Record<string, number> | null {
	if (value === null) {
		return true;
	}
	if (!isRecord(value)) {
		return false;
	}
	for (const entry of Object.values(value)) {
		if (typeof entry !== "number" || !Number.isFinite(entry)) {
			return false;
		}
	}
	return true;
}

function isUnknownRecordOrNull(value: unknown): value is Record<string, unknown> | null {
	return value === null || isRecord(value);
}

function isRunOutcome(value: unknown): value is AutoresearchRunOutcome {
	return (
		value === "keep" || value === "discard" || value === "crash" || value === "checks_failed"
	);
}

function isPersistedAutoresearchRun(value: unknown): value is PersistedAutoresearchRun {
	if (!isRecord(value)) {
		return false;
	}
	if (value["kind"] !== "autoresearch_run" || value["version"] !== 1) {
		return false;
	}
	if (
		typeof value["taskId"] !== "string" ||
		typeof value["runId"] !== "string" ||
		typeof value["phaseId"] !== "string" ||
		typeof value["createdAt"] !== "string" ||
		typeof value["runNumber"] !== "number"
	) {
		return false;
	}
	if (!isLoopSessionRef(value["childSession"]) || !isLoopSessionRef(value["controllerSession"])) {
		return false;
	}

	const benchmark = value["benchmark"];
	if (!isRecord(benchmark)) {
		return false;
	}
	if (
		typeof benchmark["command"] !== "string" ||
		typeof benchmark["durationSeconds"] !== "number" ||
		!isFiniteNumberOrNull(benchmark["exitCode"]) ||
		typeof benchmark["timedOut"] !== "boolean" ||
		typeof benchmark["passed"] !== "boolean" ||
		typeof benchmark["logFile"] !== "string" ||
		typeof benchmark["tailOutput"] !== "string"
	) {
		return false;
	}

	const checks = value["checks"];
	if (checks !== null) {
		if (!isRecord(checks)) {
			return false;
		}
		if (
			typeof checks["command"] !== "string" ||
			typeof checks["durationSeconds"] !== "number" ||
			(checks["passed"] !== null && typeof checks["passed"] !== "boolean") ||
			typeof checks["timedOut"] !== "boolean" ||
			(checks["logFile"] !== null && typeof checks["logFile"] !== "string") ||
			typeof checks["outputTail"] !== "string"
		) {
			return false;
		}
	}

	const parsed = value["parsed"];
	if (!isRecord(parsed)) {
		return false;
	}
	if (
		typeof parsed["metricName"] !== "string" ||
		typeof parsed["metricUnit"] !== "string" ||
		!isNumericRecordOrNull(parsed["metrics"]) ||
		!isFiniteNumberOrNull(parsed["primary"]) ||
		!isUnknownRecordOrNull(parsed["asi"])
	) {
		return false;
	}

	if (value["fullOutputLogFile"] !== null && typeof value["fullOutputLogFile"] !== "string") {
		return false;
	}

	const finalized = value["finalized"];
	if (finalized !== null) {
		if (!isRecord(finalized)) {
			return false;
		}
		if (
			!isRunOutcome(finalized["status"]) ||
			typeof finalized["description"] !== "string" ||
			typeof finalized["decidedAt"] !== "string" ||
			!isNumericRecordOrNull(finalized["metrics"]) ||
			!isUnknownRecordOrNull(finalized["asi"])
		) {
			return false;
		}
	}

	return true;
}

function parsePersistedRunRecord(content: string, runFile: string): PersistedAutoresearchRun {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content) as unknown;
	} catch (error) {
		throw new LoopContractValidationError({
			entity: "loops.run",
			reason: `${runFile}: invalid JSON (${String(error)})`,
		});
	}

	if (!isPersistedAutoresearchRun(parsed)) {
		throw new LoopContractValidationError({
			entity: "loops.run",
			reason: `${runFile}: run record does not match the canonical schema.`,
		});
	}

	return parsed;
}

function listRunRecordsForTask(
	cwd: string,
	taskId: string,
): ReadonlyArray<PersistedAutoresearchRun> {
	const runsRoot = resolveLoopWorkspacePath(cwd, loopRunsDirectory(taskId));
	if (!fs.existsSync(runsRoot)) {
		return [];
	}

	const entries = fs.readdirSync(runsRoot, { withFileTypes: true });
	const runs: PersistedAutoresearchRun[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const runFile = path.join(runsRoot, entry.name, RUN_RECORD_FILE);
		if (!fs.existsSync(runFile)) {
			continue;
		}
		const runContent = fs.readFileSync(runFile, "utf-8");
		runs.push(parsePersistedRunRecord(runContent, runFile));
	}
	return runs;
}

// ------------------------------------------------------------------------------
// Benchmark execution
// ------------------------------------------------------------------------------

async function executeBenchmarkAsync(
	input: ExecuteBenchmarkInput & { readonly checksCommand?: Option.Option<string> },
	onUpdate:
		| ((result: {
				content: Array<{ type: "text"; text: string }>;
				details: BenchmarkProgress;
		  }) => void)
		| undefined,
	ops: BashOperations,
): Promise<RunDetails> {
	const {
		workDir,
		runDirectory,
		benchmarkLogPath,
		checksLogPath,
		command,
		timeoutSeconds,
		checksTimeoutSeconds,
		checksCommand,
		metricName,
		metricUnit,
		signal,
	} = input;

	const outputChunks: Buffer[] = [];
	let totalBytes = 0;

	const handleData = (data: Buffer) => {
		outputChunks.push(data);
		totalBytes += data.length;
	};

	const t0 = Date.now();
	let timerInterval: ReturnType<typeof setInterval> | undefined;

	if (onUpdate) {
		timerInterval = setInterval(() => {
			const elapsedMs = Date.now() - t0;
			const elapsed = formatElapsed(elapsedMs);
			const currentOutput = Buffer.concat(outputChunks).toString("utf-8");
			const tail = truncateTail(currentOutput, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			onUpdate({
				content: [{ type: "text", text: tail.content || "" }],
				details: {
					phase: "running",
					elapsed,
					tailOutput: tail.content,
				},
			});
		}, 1000);
	}

	const benchmarkOptions: {
		onData: (data: Buffer) => void;
		timeout?: number;
		signal?: AbortSignal;
	} = {
		onData: handleData,
	};
	if (timeoutSeconds > 0) {
		benchmarkOptions.timeout = timeoutSeconds;
	}
	if (signal) {
		benchmarkOptions.signal = signal;
	}

	const result = await ops.exec(command, workDir, benchmarkOptions);

	if (timerInterval) clearInterval(timerInterval);

	const durationSeconds = (Date.now() - t0) / 1000;
	const processTimedOut = result.exitCode === null;

	const fullOutput = Buffer.concat(outputChunks).toString("utf-8");

	fs.writeFileSync(benchmarkLogPath, fullOutput);

	const benchmarkPassed = result.exitCode === 0 && !processTimedOut;

	let checksPass: boolean | null = null;
	let checksTimedOut = false;
	let checksOutput = "";
	let checksDuration = 0;

	const explicitChecksCommand = checksCommand ?? Option.none<string>();
	const resolvedChecksCommand = Option.match(explicitChecksCommand, {
		onSome: (command) => command,
		onNone: () => null,
	});
	if (benchmarkPassed && resolvedChecksCommand !== null) {
		const checksChunks: Buffer[] = [];
		const ct0 = Date.now();
		const checksOptions: {
			onData: (data: Buffer) => void;
			timeout?: number;
			signal?: AbortSignal;
		} = {
			onData: (data) => checksChunks.push(data),
		};
		if (checksTimeoutSeconds > 0) {
			checksOptions.timeout = checksTimeoutSeconds;
		}
		if (signal) {
			checksOptions.signal = signal;
		}

		const checksResult = await ops.exec(resolvedChecksCommand, workDir, checksOptions);

		checksDuration = (Date.now() - ct0) / 1000;
		checksTimedOut = checksResult.exitCode === null;
		checksPass = checksResult.exitCode === 0 && !checksTimedOut;
		checksOutput = Buffer.concat(checksChunks).toString("utf-8").trim();

		if (Option.isSome(checksLogPath)) {
			fs.writeFileSync(checksLogPath.value, checksOutput);
		}
	}

	const passed = benchmarkPassed && (checksPass === null || checksPass);
	const displayTruncation = truncateTail(fullOutput, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	const llmTruncation = truncateTail(fullOutput, {
		maxLines: EXPERIMENT_MAX_LINES,
		maxBytes: EXPERIMENT_MAX_BYTES,
	});
	const truncation: TruncationResult | null = llmTruncation.truncated ? llmTruncation : null;

	const totalLines = fullOutput.split("\n").length;
	let fullOutputPath: string | undefined;
	if (totalBytes > EXPERIMENT_MAX_BYTES || totalLines > EXPERIMENT_MAX_LINES) {
		fullOutputPath = path.join(
			os.tmpdir(),
			`pi-experiment-${randomBytes(8).toString("hex")}.log`,
		);
		fs.writeFileSync(fullOutputPath, fullOutput);
	}

	const parsedMetricMap = parseMetricLines(fullOutput);
	const parsedMetrics = parsedMetricMap.size > 0 ? Object.fromEntries(parsedMetricMap) : null;
	const parsedPrimary = parsedMetricMap.get(metricName) ?? null;

	return {
		runNumber: 0,
		runDirectory,
		benchmarkLogPath,
		checksLogPath,
		command,
		exitCode: result.exitCode,
		durationSeconds,
		passed,
		crashed: !passed,
		timedOut: processTimedOut,
		tailOutput: displayTruncation.content,
		llmTailOutput: llmTruncation.content,
		checksPass,
		checksTimedOut,
		checksOutput: checksOutput.split("\n").slice(-80).join("\n"),
		checksDuration,
		parsedMetrics,
		parsedPrimary,
		parsedAsi: parseAsiLines(fullOutput),
		metricName,
		metricUnit,
		fullOutputPath: fullOutputPath ? Option.some(fullOutputPath) : Option.none(),
		truncation,
	};
}

// ------------------------------------------------------------------------------
// Workspace execution
// ------------------------------------------------------------------------------

function resolveWorkspaceScopeWorkDir(workspaceRoot: string, scopeRoot: string): string {
	const normalizedRoot = path.normalize(scopeRoot);
	if (path.isAbsolute(normalizedRoot)) {
		throw new AutoresearchValidationError({
			reason: `scope.root must be relative to the workspace root. Received: ${scopeRoot}`,
		});
	}

	const resolved = path.resolve(workspaceRoot, normalizedRoot);
	const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
	if (
		resolved !== normalizedWorkspaceRoot &&
		!resolved.startsWith(`${normalizedWorkspaceRoot}${path.sep}`)
	) {
		throw new AutoresearchValidationError({
			reason: `scope.root resolves outside the workspace root: ${scopeRoot}`,
		});
	}
	return resolved;
}

// ------------------------------------------------------------------------------
// Response builders
// ------------------------------------------------------------------------------

function buildRunExperimentText(details: RunDetails): string {
	let text = "";
	const benchmarkPassed = details.exitCode === 0 && !details.timedOut;

	if (details.timedOut) {
		text += `TIMEOUT after ${details.durationSeconds.toFixed(1)}s\n`;
	} else if (!benchmarkPassed) {
		text += `FAILED (exit code ${details.exitCode}) in ${details.durationSeconds.toFixed(1)}s\n`;
	} else if (details.checksTimedOut) {
		text += `Benchmark PASSED in ${details.durationSeconds.toFixed(1)}s\n`;
		text += `CHECKS TIMEOUT (autoresearch.checks.sh) after ${details.checksDuration.toFixed(1)}s\n`;
		text += `Log this as 'checks_failed'\n`;
	} else if (details.checksPass === false) {
		text += `Benchmark PASSED in ${details.durationSeconds.toFixed(1)}s\n`;
		text += `CHECKS FAILED (autoresearch.checks.sh) in ${details.checksDuration.toFixed(1)}s\n`;
		text += `Log this as 'checks_failed'\n`;
	} else {
		text += `PASSED in ${details.durationSeconds.toFixed(1)}s\n`;
		if (details.checksPass === true) {
			text += `Checks passed in ${details.checksDuration.toFixed(1)}s\n`;
		}
	}

	if (details.parsedMetrics) {
		text += `\nParsed metrics:`;
		if (details.parsedPrimary !== null) {
			text += ` ${details.metricName}=${formatNum(details.parsedPrimary, details.metricUnit)}`;
		}
		const secondary = Object.entries(details.parsedMetrics).filter(
			([k]) => k !== details.metricName,
		);
		for (const [name, value] of secondary) {
			text += ` ${name}=${formatNum(value, "")}`;
		}
		text += `\n`;
	}

	text += `\n${details.llmTailOutput}`;

	if (details.truncation !== null && Option.isSome(details.fullOutputPath)) {
		if (details.truncation.truncatedBy === "lines") {
			text += `\n\n[Showing last ${details.truncation.outputLines} of ${details.truncation.totalLines} lines. Full output: ${details.fullOutputPath.value}]`;
		} else {
			text += `\n\n[Showing last ${details.truncation.outputLines} lines (${formatSize(EXPERIMENT_MAX_BYTES)} limit). Full output: ${details.fullOutputPath.value}]`;
		}
	}

	if (details.checksPass === false && details.checksOutput) {
		text += `\n\nChecks output (last 80 lines):\n${details.checksOutput}`;
	}

	return text;
}
// ------------------------------------------------------------------------------
// Extension
// ------------------------------------------------------------------------------

export default function initAutoresearch(
	pi: ExtensionAPI,
	runEffect: <A, E>(
		effect: Effect.Effect<A, E, LoopEngine | Sandbox | ExecutionRuntime | AutoresearchLoopRunner>,
	) => Promise<A>,
): void {
	const withLoopEngine = <A, E>(
		f: (service: LoopEngineService) => Effect.Effect<A, E, never>,
	): Promise<A> =>
		runEffect(
			Effect.gen(function* () {
				const service = yield* LoopEngine;
				return yield* f(service);
			}),
		);

	const withExecutionRuntime = <A, E>(
		f: (service: ExecutionRuntime) => Effect.Effect<A, E, never>,
	): Promise<A> =>
		runEffect(
			Effect.gen(function* () {
				const service = yield* ExecutionRuntime;
				return yield* f(service);
			}),
		);

	const captureCurrentExecutionProfile = (
		ctx: Pick<ExtensionContext, "model">,
	): Promise<ExecutionProfile | null> =>
		withExecutionRuntime((runtime) => runtime.captureCurrentExecutionProfile(ctx));

	const applyExecutionProfileInSession = (
		profile: ExecutionProfile,
		ctx: ExtensionContext,
	): Promise<{ readonly applied: true } | { readonly applied: false; readonly reason: string }> =>
		withExecutionRuntime((runtime) =>
			runtime
				.applyExecutionProfile(profile, ctx, {
					notifyOnSuccess: false,
					persist: false,
					ephemeral: true,
				})
				.pipe(
					Effect.map((result) =>
						result.applied
							? ({ applied: true } as const)
							: ({ applied: false, reason: result.reason } as const),
					),
				),
		);

	const withAutoresearchLoopRunner = <A, E>(
		f: (service: AutoresearchLoopRunnerService) => Effect.Effect<A, E, never>,
	): Promise<A> =>
		runEffect(
			Effect.gen(function* () {
				const service = yield* AutoresearchLoopRunner;
				return yield* f(service);
			}),
		);

	const expandedState = new Map<string, boolean>();
	type OverlayState = {
		readonly tui: import("@earendil-works/pi-tui").TUI;
		readonly done: (value: void) => void;
		readonly spinnerTimer: ReturnType<typeof setInterval>;
		spinnerFrame: number;
	};
	const latestViewData = new Map<string, AutoresearchViewData>();
	const overlayStates = new Map<string, OverlayState>();

	const requestOverlayRender = (sessionId: string): void => {
		const state = overlayStates.get(sessionId);
		if (state) {
			state.tui.invalidate();
		}
	};

	const closeFullscreenOverlay = (sessionId: string): void => {
		const state = overlayStates.get(sessionId);
		if (state) {
			clearInterval(state.spinnerTimer);
			state.done(undefined);
			overlayStates.delete(sessionId);
		}
	};

	const buildViewData = (
		cwd: string,
		state: AutoresearchLoopPersistedState,
	): AutoresearchViewData => {
		const runRecords = [...listRunRecordsForTask(cwd, state.taskId)].sort(
			(left: PersistedAutoresearchRun, right: PersistedAutoresearchRun) =>
				left.runNumber - right.runNumber,
		);
		const phaseOrder = new Map<string, number>();
		for (const run of runRecords) {
			if (!phaseOrder.has(run.phaseId)) {
				phaseOrder.set(run.phaseId, phaseOrder.size);
			}
		}
		const currentPhaseId = Option.match(state.autoresearch.phaseId, {
			onNone: () => null,
			onSome: (value) => value,
		});
		const currentSegment = currentPhaseId === null ? 0 : (phaseOrder.get(currentPhaseId) ?? 0);

		const results: ExperimentResult[] = runRecords
			.filter((run) => run.finalized !== null)
			.map((run: PersistedAutoresearchRun) => {
				const finalized = run.finalized;
				if (finalized === null) {
					throw new Error(`Missing finalized data for run ${run.runId}`);
				}
				const metrics = finalized.metrics ?? run.parsed.metrics ?? {};
				const metric = metrics[state.autoresearch.metricName] ?? run.parsed.primary ?? 0;
				return {
					runNumber: run.runNumber,
					commit: finalized.status === "keep" ? "keep" : "",
					metric,
					metrics,
					status: finalized.status,
					description: finalized.description,
					timestamp: Date.parse(finalized.decidedAt),
					segment: phaseOrder.get(run.phaseId) ?? 0,
					confidence: null,
					asi: finalized.asi ?? run.parsed.asi ?? undefined,
				};
			});

		const secondaryMetricNames = Array.from(
			new Set(
				results
					.flatMap((result) => Object.keys(result.metrics))
					.filter((name) => name !== state.autoresearch.metricName),
			),
		);
		const secondaryMetrics = secondaryMetricNames.map((name) => ({
			name,
			unit: inferMetricUnitFromName(name),
		}));

		const best = findBestResult(results, currentSegment, state.autoresearch.metricDirection);
		const pendingRunId = Option.match(state.autoresearch.pendingRunId, {
			onNone: () => null,
			onSome: (value) => value,
		});
		const pendingRun =
			pendingRunId === null
				? null
				: (runRecords.find((run: PersistedAutoresearchRun) => run.runId === pendingRunId) ??
					null);

		return {
			autoresearchMode: state.lifecycle === "active",
			name: state.title,
			metricName: state.autoresearch.metricName,
			metricUnit: state.autoresearch.metricUnit,
			bestMetric: best?.result.metric ?? null,
			bestDirection: state.autoresearch.metricDirection,
			currentSegment,
			currentSegmentRunCount: results.filter((result) => result.segment === currentSegment)
				.length,
			totalRunCount: results.length,
			currentSegmentKeptCount: results.filter(
				(result) => result.segment === currentSegment && result.status === "keep",
			).length,
			currentSegmentCrashedCount: results.filter(
				(result) => result.segment === currentSegment && result.status === "crash",
			).length,
			currentSegmentChecksFailedCount: results.filter(
				(result) => result.segment === currentSegment && result.status === "checks_failed",
			).length,
			bestPrimaryMetric: best?.result.metric ?? null,
			bestRunNumber: best?.result.runNumber ?? null,
			confidence: computeConfidence(
				results,
				currentSegment,
				state.autoresearch.metricDirection,
			),
			secondaryMetrics,
			runningExperiment:
				pendingRun === null
					? null
					: {
							startedAt: Date.parse(pendingRun.createdAt),
							command: pendingRun.benchmark.command,
							runDirectory: path.resolve(
								cwd,
								loopRunDirectory(state.taskId, pendingRun.runId),
							),
							runNumber: pendingRun.runNumber,
						},
			results,
			maxExperiments: Option.match(state.autoresearch.maxIterations, {
				onNone: () => null,
				onSome: (value) => value,
			}),
		};
	};

	const cancelAutoresearchLoop = (cwd: string, taskId: string): void => {
		void withAutoresearchLoopRunner((runner) => runner.cancelLoop(`${cwd}:${taskId}`)).catch(
			(error) => {
				Effect.runSync(Effect.logWarning("Autoresearch loop cancel failed", error));
			},
		);
	};

	const openFullscreenOverlay = async (cwd: string, ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) {
			return;
		}
		const sessionId = getSessionKey(ctx);
		const viewData = latestViewData.get(sessionId);
		if (viewData === undefined) {
			ctx.ui.notify("No autoresearch dashboard is available for this session.", "info");
			return;
		}

		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const state: OverlayState = {
					tui,
					done,
					spinnerTimer: setInterval(() => {
						state.spinnerFrame += 1;
						tui.invalidate();
					}, 80),
					spinnerFrame: 0,
				};
				overlayStates.set(sessionId, state);

				let scrollOffset = 0;
				return {
					render(width: number): string[] {
						const currentView = latestViewData.get(sessionId);
						if (currentView === undefined) {
							done(undefined);
							return [];
						}
						const terminalRows = process.stdout.rows ?? 40;
						const header = renderExpandedHeader(currentView, width, theme);
						const body = renderDashboardLines(currentView, width, theme, 0);
						if (currentView.runningExperiment !== null) {
							body.push(
								renderOverlayRunningLine(
									currentView,
									theme,
									width,
									state.spinnerFrame,
								),
							);
						}
						const viewportRows = Math.max(4, terminalRows - 4);
						const maxScroll = Math.max(0, body.length - viewportRows);
						if (scrollOffset > maxScroll) {
							scrollOffset = maxScroll;
						}
						const visible = body.slice(scrollOffset, scrollOffset + viewportRows);
						const footer = renderOverlayFooter(
							width,
							scrollOffset,
							viewportRows,
							body.length,
							theme,
						);
						return [
							header,
							...visible,
							...Array.from(
								{ length: Math.max(0, viewportRows - visible.length) },
								() => "",
							),
							footer,
						];
					},
					handleInput(data: string): void {
						const currentView = latestViewData.get(sessionId);
						const totalRows =
							currentView === undefined
								? 0
								: renderDashboardLines(
										currentView,
										process.stdout.columns ?? 120,
										theme,
										0,
									).length + (currentView.runningExperiment === null ? 0 : 1);
						const terminalRows = process.stdout.rows ?? 40;
						const viewportRows = Math.max(4, terminalRows - 4);
						const maxScroll = Math.max(0, totalRows - viewportRows);
						if (shouldCloseAutoresearchOverlay(data)) {
							done(undefined);
							return;
						}
						if (matchesKey(data, "up") || data === "k") {
							scrollOffset = Math.max(0, scrollOffset - 1);
						} else if (matchesKey(data, "down") || data === "j") {
							scrollOffset = Math.min(maxScroll, scrollOffset + 1);
						} else if (matchesKey(data, "pageUp") || data === "u") {
							scrollOffset = Math.max(0, scrollOffset - viewportRows);
						} else if (matchesKey(data, "pageDown") || data === "d") {
							scrollOffset = Math.min(maxScroll, scrollOffset + viewportRows);
						} else if (data === "g") {
							scrollOffset = 0;
						} else if (data === "G") {
							scrollOffset = maxScroll;
						}
						tui.invalidate();
					},
					invalidate(): void {},
					dispose(): void {
						clearInterval(state.spinnerTimer);
						overlayStates.delete(sessionId);
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" },
			},
		);
	};

	type ActiveAutoresearchChildContext = {
		readonly session: LoopSessionRef;
		readonly loopState: AutoresearchLoopPersistedState;
		readonly controller: LoopSessionRef;
		readonly child: LoopSessionRef;
	};

	type ReplacementSessionOptions = {
		readonly parentSession?: string;
		readonly withSession?: (ctx: ExtensionCommandContext) => Promise<void> | void;
	};

	type SwitchSessionOptions = {
		readonly withSession?: (ctx: ExtensionCommandContext) => Promise<void> | void;
	};

	type SessionReplacementResult = {
		readonly cancelled: boolean;
	};

	const readCanonicalLoopState = (cwd: string, taskId: string): LoopPersistedState => {
		const statePath = resolveLoopWorkspacePath(cwd, loopStateFile(taskId));
		if (!fs.existsSync(statePath)) {
			throw new LoopTaskNotFoundError({ taskId });
		}
		const content = fs.readFileSync(statePath, "utf-8");
		return decodeLoopPersistedStateJsonSync(content);
	};

	const writeCanonicalLoopState = (cwd: string, state: LoopPersistedState): void => {
		const statePath = resolveLoopWorkspacePath(cwd, loopStateFile(state.taskId));
		atomicWriteFileStringSync(statePath, encodeLoopPersistedStateJsonSync(state));
	};

	const loadPhaseSnapshotForState = (cwd: string, state: AutoresearchLoopPersistedState) => {
		const phaseId = Option.match(state.autoresearch.phaseId, {
			onNone: () => {
				throw new AutoresearchValidationError({
					reason: `Autoresearch task ${state.taskId} has no active phase snapshot. Start or resume the loop first.`,
				});
			},
			onSome: (value) => value,
		});
		const snapshotPath = resolveLoopWorkspacePath(cwd, loopPhaseFile(state.taskId, phaseId));
		if (!fs.existsSync(snapshotPath)) {
			throw new LoopContractValidationError({
				entity: "loops.phase_snapshot",
				reason: `${loopPhaseFile(state.taskId, phaseId)} does not exist.`,
			});
		}
		const content = fs.readFileSync(snapshotPath, "utf-8");
		return decodeAutoresearchPhaseSnapshotJsonSync(content);
	};

	const resolveActiveAutoresearchChildContext = async (
		ctx: ExtensionContext,
	): Promise<ActiveAutoresearchChildContext> => {
		const session = commandSessionRef(ctx);
		if (Option.isNone(session)) {
			throw new AutoresearchValidationError({
				reason: "Autoresearch run tools require an interactive session file.",
			});
		}

		const owned = await withLoopEngine((engine) =>
			engine.resolveOwnedLoop(ctx.cwd, session.value),
		);
		if (Option.isNone(owned)) {
			throw new AutoresearchValidationError({
				reason: "No loop is owned by the current session.",
			});
		}

		if (owned.value.kind === "blocked_manual_resolution") {
			throw new AutoresearchValidationError({
				reason: `Task ${owned.value.taskId} is blocked for manual resolution: ${owned.value.blocked.message}`,
			});
		}

		const loopState = requireAutoresearchLoopState(owned.value);
		if (loopState.lifecycle !== "active") {
			throw new AutoresearchValidationError({
				reason: `Autoresearch task ${loopState.taskId} is ${loopState.lifecycle}. Start or resume it before running trials.`,
			});
		}

		const controller = Option.match(loopState.ownership.controller, {
			onNone: () => {
				throw new AutoresearchValidationError({
					reason: `Autoresearch task ${loopState.taskId} has no controller session ownership.`,
				});
			},
			onSome: (value) => value,
		});
		const child = Option.match(loopState.ownership.child, {
			onNone: () => {
				throw new AutoresearchValidationError({
					reason: `Autoresearch task ${loopState.taskId} has no active child session. Start the next trial iteration first.`,
				});
			},
			onSome: (value) => value,
		});

		if (!sessionRefMatches(child, session.value)) {
			const fromController = sessionRefMatches(controller, session.value);
			throw new AutoresearchValidationError({
				reason: fromController
					? `Session ${session.value.sessionId} is the controller session for ${loopState.taskId}. autoresearch_run and autoresearch_done are child-session tools only.`
					: `Session ${session.value.sessionId} does not match the active child session for ${loopState.taskId}.`,
			});
		}

		return {
			session: session.value,
			loopState,
			controller,
			child,
		};
	};

	const syncAutoresearchToolVisibility = async (ctx: ExtensionContext): Promise<void> => {
		try {
			await resolveActiveAutoresearchChildContext(ctx);
			setToolEnabled(pi, AUTORESEARCH_RUN_TOOL_NAME, true);
			setToolEnabled(pi, AUTORESEARCH_DONE_TOOL_NAME, true);
		} catch (error) {
			if (
				error instanceof AutoresearchValidationError ||
				error instanceof LoopContractValidationError ||
				error instanceof LoopTaskNotFoundError ||
				error instanceof LoopAmbiguousOwnershipError ||
				error instanceof LoopLifecycleConflictError ||
				error instanceof LoopOwnershipValidationError
			) {
				setToolEnabled(pi, AUTORESEARCH_RUN_TOOL_NAME, false);
				setToolEnabled(pi, AUTORESEARCH_DONE_TOOL_NAME, false);
				return;
			}
			throw error;
		}
	};

	const makeRunId = (runNumber: number): string =>
		`run-${String(runNumber).padStart(4, "0")}-${Date.now()}`;

	const readRunRecord = (
		cwd: string,
		taskId: string,
		runId: string,
	): PersistedAutoresearchRun => {
		const runPath = path.join(
			resolveLoopWorkspacePath(cwd, loopRunDirectory(taskId, runId)),
			RUN_RECORD_FILE,
		);
		if (!fs.existsSync(runPath)) {
			throw new LoopContractValidationError({
				entity: "loops.run",
				reason: `${path.relative(resolveLoopWorkspaceRoot(cwd), runPath)} does not exist.`,
			});
		}
		return parsePersistedRunRecord(fs.readFileSync(runPath, "utf-8"), runPath);
	};

	const writeRunRecord = (cwd: string, run: PersistedAutoresearchRun): void => {
		const runPath = path.join(
			resolveLoopWorkspacePath(cwd, loopRunDirectory(run.taskId, run.runId)),
			RUN_RECORD_FILE,
		);
		atomicWriteFileStringSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
	};

	const switchSession = async (
		ctx: ExtensionCommandContext,
		targetSessionFile: string,
	): Promise<ExtensionCommandContext | null> => {
		try {
			let replacementContext: ExtensionCommandContext | undefined;
			const switchSessionWithReplacement = ctx.switchSession as (
				target: string,
				options?: SwitchSessionOptions,
			) => Promise<SessionReplacementResult>;
			const result = await switchSessionWithReplacement(targetSessionFile, {
				withSession: async (nextContext) => {
					replacementContext = nextContext;
				},
			});
			return result.cancelled ? null : (replacementContext ?? ctx);
		} catch {
			return null;
		}
	};

	const createChildSession = async (
		ctx: ExtensionCommandContext,
		parentSessionFile: string,
	): Promise<ExtensionCommandContext | null> => {
		try {
			let replacementContext: ExtensionCommandContext | undefined;
			const newSessionWithReplacement = ctx.newSession as (
				options: ReplacementSessionOptions,
			) => Promise<SessionReplacementResult>;
			const result = await newSessionWithReplacement({
				parentSession: parentSessionFile,
				withSession: async (nextContext) => {
					replacementContext = nextContext;
				},
			});
			return result.cancelled ? null : (replacementContext ?? ctx);
		} catch {
			return null;
		}
	};

	const ensureAutoresearchChildSession = async (
		ctx: ExtensionCommandContext,
		taskId: string,
	): Promise<LoopSessionRef> => {
		const persisted = requireAutoresearchLoopState(readCanonicalLoopState(ctx.cwd, taskId));
		if (persisted.lifecycle !== "active") {
			throw new AutoresearchValidationError({
				reason: `Autoresearch task ${persisted.taskId} is ${persisted.lifecycle}. Start or resume it before running trials.`,
			});
		}
		if (Option.isSome(persisted.autoresearch.pendingRunId)) {
			throw new AutoresearchValidationError({
				reason: `Task ${persisted.taskId} already has pending run ${persisted.autoresearch.pendingRunId.value}. Finalize it with autoresearch_done first.`,
			});
		}
		if (Option.isSome(persisted.ownership.child)) {
			throw new AutoresearchValidationError({
				reason: `Autoresearch task ${persisted.taskId} already has an active child session (${persisted.ownership.child.value.sessionId}).`,
			});
		}

		const controller = Option.match(persisted.ownership.controller, {
			onNone: () => {
				throw new AutoresearchValidationError({
					reason: `Autoresearch task ${persisted.taskId} has no controller session ownership.`,
				});
			},
			onSome: (value) => value,
		});

		const currentSession = commandSessionRef(ctx);
		let activeContext = ctx;
		if (Option.isNone(currentSession)) {
			throw new AutoresearchValidationError({
				reason: "Autoresearch commands require an interactive session file.",
			});
		}

		if (!sessionRefMatches(controller, currentSession.value)) {
			const switchedContext = await switchSession(activeContext, controller.sessionFile);
			if (switchedContext === null) {
				throw new AutoresearchValidationError({
					reason: `Could not switch to controller session ${controller.sessionFile} for task ${persisted.taskId}.`,
				});
			}
			activeContext = switchedContext;
		}

		const sessionAfterSwitch = commandSessionRef(activeContext);
		if (
			Option.isNone(sessionAfterSwitch) ||
			!sessionRefMatches(controller, sessionAfterSwitch.value)
		) {
			throw new AutoresearchValidationError({
				reason: `Current session does not match controller ownership for task ${persisted.taskId}.`,
			});
		}

		const childContext = await createChildSession(activeContext, controller.sessionFile);
		if (childContext === null) {
			throw new AutoresearchValidationError({
				reason: `Creating child session for task ${persisted.taskId} was cancelled.`,
			});
		}
		activeContext = childContext;

		const child = commandSessionRef(activeContext);
		try {
			if (Option.isNone(child)) {
				throw new AutoresearchValidationError({
					reason: `Autoresearch child session for task ${persisted.taskId} has no persisted session file.`,
				});
			}
			if (sessionRefMatches(child.value, controller)) {
				throw new AutoresearchValidationError({
					reason: `Created child session matches controller ownership for task ${persisted.taskId}.`,
				});
			}

			const applied = await applyExecutionProfileInSession(
				persisted.autoresearch.pinnedExecutionProfile,
				activeContext,
			);
			if (!applied.applied) {
				throw new AutoresearchValidationError({
					reason: `Could not apply pinned execution profile for task ${persisted.taskId}: ${applied.reason}`,
				});
			}

			await withLoopEngine((engine) =>
				engine.attachChildSession(activeContext.cwd, taskId, child.value),
			);
			return child.value;
		} catch (error) {
			if (Option.isSome(child) && !sessionRefMatches(child.value, controller)) {
				try {
					fs.rmSync(child.value.sessionFile, { force: true });
				} catch {
					// best-effort rollback only
				}
			}
			const switchedBack = await switchSession(activeContext, controller.sessionFile);
			if (switchedBack === null) {
				const originalReason = error instanceof Error ? error.message : String(error);
				throw new AutoresearchValidationError({
					reason: `Autoresearch child-session rollback failed for task ${persisted.taskId}: could not switch back to controller session ${controller.sessionFile}. Original error: ${originalReason}`,
				});
			}
			throw error;
		}
	};

	const queueAutoresearchChildPrompt = (cwd: string, taskId: string): void => {
		const persisted = requireAutoresearchLoopState(readCanonicalLoopState(cwd, taskId));
		const phaseSnapshotPath = Option.match(persisted.autoresearch.phaseId, {
			onNone: () => null,
			onSome: (phaseId) => loopPhaseFile(taskId, phaseId),
		});
		const lines = [
			`Continue autoresearch task "${taskId}" in this child session.`,
			`Read ${loopTaskFile(taskId)}${phaseSnapshotPath === null ? "" : ` and ${phaseSnapshotPath}`} before acting.`,
			"",
			"Complete exactly one trial in this session:",
			"1. Pick the next highest-value experiment that stays within the task contract and scope.",
			"2. Make any necessary edits for that experiment.",
			"3. Call autoresearch_run exactly once.",
			"4. Inspect the run result and checks output.",
			'5. Call autoresearch_done exactly once with status, description, metrics, and asi including at least {"hypothesis": "..."}.',
			"",
			"Do not start a second trial in this session. If you cannot safely run a trial, explain why and stop.",
		];
		pi.sendUserMessage(lines.join("\n"), { deliverAs: "followUp" });
	};

	const runAutoresearchLoop = (ctx: ExtensionCommandContext, taskId: string): void => {
		const loopKey = `${ctx.cwd}:${taskId}`;

		void withAutoresearchLoopRunner((runner) => {
			const loopProgram = Effect.gen(function* () {
				while (true) {
					const persisted = requireAutoresearchLoopState(
						readCanonicalLoopState(ctx.cwd, taskId),
					);
					if (persisted.lifecycle !== "active") {
						return;
					}
					const maxIterations = Option.getOrUndefined(
						persisted.autoresearch.maxIterations,
					);

					if (
						maxIterations !== undefined &&
						persisted.autoresearch.runCount >= maxIterations &&
						Option.isNone(persisted.autoresearch.pendingRunId)
					) {
						yield* Effect.promise(() =>
							withLoopEngine((engine) => engine.stopLoop(ctx.cwd, taskId)),
						);
						if (ctx.hasUI) {
							yield* Effect.sync(() => {
								ctx.ui.notify(
									`Autoresearch task ${taskId} reached limits.max_iterations=${maxIterations}.`,
									"info",
								);
							});
						}
						yield* Effect.promise(() => updateAutoresearchUI(ctx.cwd, ctx));
						return;
					}

					const currentChild = Option.getOrUndefined(persisted.ownership.child);
					const child =
						currentChild ??
						(yield* Effect.promise(() => ensureAutoresearchChildSession(ctx, taskId)));
					if (currentChild === undefined) {
						yield* Effect.sync(() => {
							queueAutoresearchChildPrompt(ctx.cwd, taskId);
						});
					}

					const waitResult = yield* runner.waitForAgentEnd(child.sessionFile);
					if (waitResult._tag === "cancelled") {
						return;
					}
					if (waitResult._tag === "timed_out") {
						yield* Effect.promise(() =>
							withLoopEngine((engine) => engine.pauseLoop(ctx.cwd, taskId)),
						);
						if (ctx.hasUI) {
							yield* Effect.sync(() => {
								ctx.ui.notify(
									`Autoresearch paused: timed out waiting for child session for ${taskId} to end.`,
									"warning",
								);
							});
						}
						yield* Effect.promise(() => updateAutoresearchUI(ctx.cwd, ctx));
						return;
					}

					const afterTurn = requireAutoresearchLoopState(
						readCanonicalLoopState(ctx.cwd, taskId),
					);
					if (afterTurn.lifecycle !== "active") {
						return;
					}

					if (Option.isSome(afterTurn.autoresearch.pendingRunId)) {
						yield* Effect.promise(() =>
							withLoopEngine((engine) => engine.pauseLoop(ctx.cwd, taskId)),
						);
						if (ctx.hasUI) {
							yield* Effect.sync(() => {
								ctx.ui.notify(
									`Autoresearch paused: child session for ${taskId} ended without autoresearch_done.`,
									"warning",
								);
							});
						}
						yield* Effect.promise(() => updateAutoresearchUI(ctx.cwd, ctx));
						return;
					}
				}
			});

			const guardedLoopProgram = loopProgram.pipe(
				Effect.catchCause((cause) => {
					if (Cause.hasInterrupts(cause)) {
						return Effect.void;
					}

					const error = Cause.squash(cause);
					return Effect.promise(async () => {
						if (ctx.hasUI) {
							ctx.ui.notify(
								error instanceof Error ? error.message : String(error),
								"error",
							);
						}
						await updateAutoresearchUI(ctx.cwd, ctx);
					});
				}),
			);

			return runner.ensureLoopRunning(loopKey, guardedLoopProgram);
		}).catch((error) => {
			if (ctx.hasUI) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		});
	};

	const clearAutoresearchUI = (ctx: ExtensionContext): void => {
		const sessionId = getSessionKey(ctx);
		latestViewData.delete(sessionId);
		closeFullscreenOverlay(sessionId);
		if (!ctx.hasUI) {
			return;
		}
		if (typeof ctx.ui.setStatus === "function") {
			ctx.ui.setStatus("autoresearch", undefined);
		}
		if (typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget("autoresearch", undefined);
		}
	};

	const updateAutoresearchUI = async (cwd: string, ctx: ExtensionContext): Promise<void> => {
		await syncAutoresearchToolVisibility(ctx);

		if (!ctx.hasUI) {
			return;
		}
		if (typeof ctx.ui.setStatus !== "function" || typeof ctx.ui.setWidget !== "function") {
			return;
		}

		const session = commandSessionRef(ctx);
		if (Option.isNone(session)) {
			clearAutoresearchUI(ctx);
			return;
		}

		const owned = await withLoopEngine((engine) => engine.resolveOwnedLoop(cwd, session.value));
		if (Option.isNone(owned) || !isAutoresearchLoopState(owned.value)) {
			clearAutoresearchUI(ctx);
			return;
		}

		const state = owned.value;
		const { theme } = ctx.ui;
		if (state.kind === "blocked_manual_resolution") {
			latestViewData.delete(getSessionKey(ctx));
			ctx.ui.setStatus(
				"autoresearch",
				theme.fg("warning", `autoresearch: ${state.taskId} (blocked)`),
			);
			ctx.ui.setWidget("autoresearch", [
				theme.fg("accent", theme.bold("Autoresearch")),
				theme.fg("muted", `Task: ${state.taskId}`),
				theme.fg("warning", `Status: blocked (${state.blocked.reasonCode})`),
				theme.fg("dim", state.blocked.message),
			]);
			return;
		}

		const autoresearchState = requireAutoresearchLoopState(state);
		const sessionId = getSessionKey(ctx);
		const viewData = buildViewData(cwd, autoresearchState);
		latestViewData.set(sessionId, viewData);
		requestOverlayRender(sessionId);
		const expanded = expandedState.get(sessionId) ?? false;
		ctx.ui.setStatus(
			"autoresearch",
			theme.fg("accent", `autoresearch: ${autoresearchState.taskId}`),
		);
		ctx.ui.setWidget("autoresearch", (_tui, widgetTheme) => {
			const width = process.stdout.columns ?? 120;
			return new Text(renderWidget(viewData, width, widgetTheme, expanded), 0, 0);
		});
	};

	const autoresearchHelp = () =>
		[
			"Usage: /autoresearch <command>",
			"",
			"Commands:",
			"  create <task-id> [goal]    Create an autoresearch loop task under .pi/loops/tasks/<task-id>.md",
			"  start <task-id>            Start an autoresearch loop",
			"  resume <task-id>           Resume a paused autoresearch loop or launch the next trial child session",
			"  pause [task-id]            Pause an active autoresearch loop",
			"  stop [task-id]             Stop an active or paused autoresearch loop",
			"  status [--archived]        Show autoresearch loops",
			"  archive <task-id>          Archive a stopped autoresearch loop",
			"  cancel <task-id>           Delete a non-active autoresearch loop",
			"  clean [--all]              Remove completed autoresearch loops",
		].join("\n");

	// --------------------------------------------------------------------------
	// Tools
	// --------------------------------------------------------------------------

	pi.registerTool({
		name: "autoresearch_run",
		label: "Autoresearch Run",
		description:
			"Execute exactly one autoresearch trial and persist artifacts under .pi/loops/runs/<task-id>/<run-id>/.",
		promptSnippet: "Execute one autoresearch trial and persist run artifacts.",
		promptGuidelines: [
			"Autoresearch loop ownership resolves the active trial context automatically.",
			"Each autoresearch task allows only one pending trial at a time.",
			"Call autoresearch_done after autoresearch_run to finalize the pending trial.",
		],
		parameters: Type.Object({
			timeout: Type.Optional(
				Type.Number({ description: "Benchmark timeout in seconds (default 600)." }),
			),
			checks_timeout: Type.Optional(
				Type.Number({
					description:
						"Checks timeout in seconds when checks_command is set (default 300).",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let nextStateWritten = false;
			let runDirectoryToCleanup: string | null = null;
			let previousState: AutoresearchLoopPersistedState | null = null;

			try {
				const active = await resolveActiveAutoresearchChildContext(ctx);
				const persisted = requireAutoresearchLoopState(
					readCanonicalLoopState(ctx.cwd, active.loopState.taskId),
				);

				if (persisted.lifecycle !== "active") {
					return {
						content: [
							{
								type: "text",
								text: `Error: autoresearch task ${persisted.taskId} is ${persisted.lifecycle}.`,
							},
						],
						details: {},
						isError: true,
					};
				}

				if (Option.isSome(persisted.autoresearch.pendingRunId)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: task ${persisted.taskId} already has pending run ${persisted.autoresearch.pendingRunId.value}. Finalize it with autoresearch_done first.`,
							},
						],
						details: {},
						isError: true,
					};
				}

				if (
					Option.isSome(persisted.autoresearch.maxIterations) &&
					persisted.autoresearch.runCount >= persisted.autoresearch.maxIterations.value
				) {
					return {
						content: [
							{
								type: "text",
								text: `Error: task ${persisted.taskId} reached limits.max_iterations=${persisted.autoresearch.maxIterations.value}.`,
							},
						],
						details: {},
						isError: true,
					};
				}

				const existingChildRun = listRunRecordsForTask(ctx.cwd, persisted.taskId).find(
					(run) => sessionRefMatches(run.childSession, active.child),
				);
				if (existingChildRun !== undefined) {
					return {
						content: [
							{
								type: "text",
								text: `Error: child session ${active.child.sessionId} already executed run ${existingChildRun.runId} for task ${persisted.taskId}. Create a new child session for the next trial.`,
							},
						],
						details: {},
						isError: true,
					};
				}

				const phaseSnapshot = loadPhaseSnapshotForState(ctx.cwd, persisted);

				const ops = getSandboxedBashOperations(ctx, false);
				if (!ops) {
					throw new AutoresearchValidationError({
						reason: "Sandbox bash operations are not available.",
					});
				}

				const runNumber = persisted.autoresearch.runCount + 1;
				const runId = makeRunId(runNumber);
				const runDirectory = path.resolve(
					ctx.cwd,
					loopRunDirectory(persisted.taskId, runId),
				);
				runDirectoryToCleanup = runDirectory;

				previousState = persisted;
				const now = new Date().toISOString();
				const pendingState: AutoresearchLoopPersistedState = {
					...persisted,
					updatedAt: now,
					autoresearch: {
						...persisted.autoresearch,
						pendingRunId: Option.some(runId),
						runCount: runNumber,
					},
				};
				writeCanonicalLoopState(ctx.cwd, pendingState);
				nextStateWritten = true;

				fs.mkdirSync(runDirectory, { recursive: true });
				const benchmarkLogPath = path.join(runDirectory, RUN_BENCHMARK_LOG_FILE);
				const checksLogPath = Option.match(phaseSnapshot.benchmark.checksCommand, {
					onNone: () => Option.none<string>(),
					onSome: () => Option.some(path.join(runDirectory, RUN_CHECKS_LOG_FILE)),
				});

				const workDir = resolveWorkspaceScopeWorkDir(ctx.cwd, phaseSnapshot.scope.root);
				const details = await executeBenchmarkAsync(
					{
						workDir,
						runDirectory,
						benchmarkLogPath,
						checksLogPath,
						checksCommand: phaseSnapshot.benchmark.checksCommand,
						command: phaseSnapshot.benchmark.command,
						timeoutSeconds: params.timeout ?? 600,
						checksTimeoutSeconds: params.checks_timeout ?? 300,
						metricName: phaseSnapshot.metric.name,
						metricUnit: phaseSnapshot.metric.unit,
						signal,
					},
					onUpdate,
					ops,
				);

				const copiedFullOutput = Option.match(details.fullOutputPath, {
					onNone: () => null,
					onSome: (sourcePath) => {
						const targetPath = path.join(runDirectory, RUN_FULL_OUTPUT_LOG_FILE);
						fs.copyFileSync(sourcePath, targetPath);
						return RUN_FULL_OUTPUT_LOG_FILE;
					},
				});

				const runRecord: PersistedAutoresearchRun = {
					kind: "autoresearch_run",
					version: 1,
					taskId: persisted.taskId,
					runId,
					runNumber,
					phaseId: phaseSnapshot.phaseId,
					createdAt: now,
					childSession: active.child,
					controllerSession: active.controller,
					benchmark: {
						command: phaseSnapshot.benchmark.command,
						durationSeconds: details.durationSeconds,
						exitCode: details.exitCode,
						timedOut: details.timedOut,
						passed: details.passed,
						logFile: RUN_BENCHMARK_LOG_FILE,
						tailOutput: details.llmTailOutput,
					},
					checks: Option.match(phaseSnapshot.benchmark.checksCommand, {
						onNone: () => null,
						onSome: (command) => ({
							command,
							durationSeconds: details.checksDuration,
							passed: details.checksPass,
							timedOut: details.checksTimedOut,
							logFile: Option.isSome(checksLogPath) ? RUN_CHECKS_LOG_FILE : null,
							outputTail: details.checksOutput,
						}),
					}),
					parsed: {
						metricName: details.metricName,
						metricUnit: details.metricUnit,
						metrics: details.parsedMetrics,
						primary: details.parsedPrimary,
						asi: details.parsedAsi,
					},
					fullOutputLogFile: copiedFullOutput,
					finalized: null,
				};
				writeRunRecord(ctx.cwd, runRecord);

				let text = `Run ${runNumber} recorded as pending (${runId}). Finalize with autoresearch_done.\n`;
				text += buildRunExperimentText(details);
				await updateAutoresearchUI(ctx.cwd, ctx);
				return {
					content: [{ type: "text", text }],
					details: {
						run_id: runId,
						run_number: runNumber,
						task_id: persisted.taskId,
						phase_id: phaseSnapshot.phaseId,
						benchmark_command: phaseSnapshot.benchmark.command,
					},
				};
			} catch (error) {
				if (nextStateWritten && previousState !== null) {
					const recoveredState: AutoresearchLoopPersistedState = {
						...previousState,
						updatedAt: new Date().toISOString(),
					};
					writeCanonicalLoopState(ctx.cwd, recoveredState);
				}
				if (runDirectoryToCleanup !== null) {
					fs.rmSync(runDirectoryToCleanup, { recursive: true, force: true });
				}

				if (
					error instanceof AutoresearchValidationError ||
					error instanceof LoopContractValidationError ||
					error instanceof LoopTaskNotFoundError ||
					error instanceof LoopAmbiguousOwnershipError ||
					error instanceof LoopLifecycleConflictError ||
					error instanceof LoopOwnershipValidationError
				) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${"reason" in error ? String(error.reason) : String(error)}`,
							},
						],
						details: {},
						isError: true,
					};
				}
				throw error;
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("autoresearch_run"));
			if (typeof args.timeout === "number") {
				text += theme.fg("dim", ` timeout=${args.timeout}s`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme) {
			return renderRunExperimentResult(result, options, theme);
		},
	});

	pi.registerTool({
		name: "autoresearch_done",
		label: "Autoresearch Done",
		description:
			"Finalize the pending autoresearch trial with keep/discard/crash/checks_failed.",
		promptSnippet: "Finalize one pending autoresearch trial.",
		promptGuidelines: [
			"Autoresearch loop ownership resolves the pending trial automatically.",
			"Call this exactly once for each pending autoresearch_run.",
			"This tool records the trial outcome without committing, reverting, or cleaning workspace changes.",
		],
		parameters: Type.Object({
			status: Type.Union([
				Type.Literal("keep"),
				Type.Literal("discard"),
				Type.Literal("crash"),
				Type.Literal("checks_failed"),
			]),
			description: Type.String({ description: "Short summary of what this trial proved." }),
			metrics: Type.Optional(Type.Record(Type.String(), Type.Number())),
			asi: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const active = await resolveActiveAutoresearchChildContext(ctx);
				const persisted = requireAutoresearchLoopState(
					readCanonicalLoopState(ctx.cwd, active.loopState.taskId),
				);

				const pendingRunId = Option.match(persisted.autoresearch.pendingRunId, {
					onNone: () => {
						throw new AutoresearchValidationError({
							reason: `Task ${persisted.taskId} has no pending run. Call autoresearch_run first.`,
						});
					},
					onSome: (value) => value,
				});

				const runRecord = readRunRecord(ctx.cwd, persisted.taskId, pendingRunId);
				if (runRecord.finalized !== null) {
					return {
						content: [
							{
								type: "text",
								text: `Error: run ${pendingRunId} is already finalized.`,
							},
						],
						details: {},
						isError: true,
					};
				}
				if (!sessionRefMatches(runRecord.childSession, active.child)) {
					return {
						content: [
							{
								type: "text",
								text: `Error: run ${pendingRunId} belongs to child session ${runRecord.childSession.sessionId}, not ${active.child.sessionId}.`,
							},
						],
						details: {},
						isError: true,
					};
				}

				const finalizedAsi =
					params.asi === undefined ? null : isRecord(params.asi) ? params.asi : null;
				if (params.asi !== undefined && !isRecord(params.asi)) {
					return {
						content: [
							{
								type: "text",
								text: "Error: asi must be a JSON object when provided.",
							},
						],
						details: {},
						isError: true,
					};
				}

				const finalizedRun: PersistedAutoresearchRun = {
					...runRecord,
					finalized: {
						status: params.status,
						description: params.description,
						decidedAt: new Date().toISOString(),
						metrics: params.metrics ?? null,
						asi: finalizedAsi,
					},
				};
				writeRunRecord(ctx.cwd, finalizedRun);

				const nextState: AutoresearchLoopPersistedState = {
					...persisted,
					updatedAt: new Date().toISOString(),
					ownership: {
						controller: persisted.ownership.controller,
						child: Option.none(),
					},
					autoresearch: {
						...persisted.autoresearch,
						pendingRunId: Option.none<string>(),
					},
				};
				writeCanonicalLoopState(ctx.cwd, nextState);
				await updateAutoresearchUI(ctx.cwd, ctx);

				return {
					content: [
						{
							type: "text",
							text:
								`Finalized run ${pendingRunId} as ${params.status}. Pending trial cleared for task ${persisted.taskId}. Child session ownership cleared. Next trial will start automatically if the task remains active. Workspace changes were left untouched.`,
						},
					],
					details: {
						task_id: persisted.taskId,
						run_id: pendingRunId,
						status: params.status,
					},
				};
			} catch (error) {
				if (
					error instanceof AutoresearchValidationError ||
					error instanceof LoopContractValidationError ||
					error instanceof LoopTaskNotFoundError ||
					error instanceof LoopAmbiguousOwnershipError ||
					error instanceof LoopLifecycleConflictError ||
					error instanceof LoopOwnershipValidationError
				) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${"reason" in error ? String(error.reason) : String(error)}`,
							},
						],
						details: {},
						isError: true,
					};
				}
				throw error;
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("autoresearch_done "));
			text += theme.fg("accent", String(args.status));
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, _theme) {
			const msg = result.content[0];
			return new Text(msg?.type === "text" ? msg.text : "", 0, 0);
		},
	});

	// --------------------------------------------------------------------------
	// Command
	// --------------------------------------------------------------------------

	pi.registerCommand("autoresearch", {
		description: "Manage task-scoped autoresearch loops",
		handler: async (args, ctx) => {
			const tokens = tokenizeCommandArgs(args ?? "");
			const command = (tokens[0] ?? "").toLowerCase();
			const rest = tokens.slice(1);

			const requireTaskId = (value: string | undefined, usage: string): string | null => {
				if (!value || value.trim().length === 0) {
					ctx.ui.notify(`Usage: ${usage}`, "warning");
					return null;
				}
				return validateTaskId(value);
			};

			const resolveScopedTaskId = async (): Promise<string | null> => {
				const session = commandSessionRef(ctx);
				if (Option.isNone(session)) {
					ctx.ui.notify(
						"Autoresearch commands require an interactive session file.",
						"error",
					);
					return null;
				}

				const owned = await withLoopEngine((engine) =>
					engine.resolveOwnedLoop(ctx.cwd, session.value),
				);
				if (Option.isNone(owned) || !isAutoresearchLoopState(owned.value)) {
					ctx.ui.notify(
						"No autoresearch loop is owned by the current session.",
						"warning",
					);
					return null;
				}
				return owned.value.taskId;
			};

			try {
				if (!command) {
					ctx.ui.notify(autoresearchHelp(), "info");
					return;
				}

				switch (command) {
					case "create": {
						assertNoLegacyAutoresearchLayout(ctx.cwd);
						const taskId = requireTaskId(
							rest[0],
							"/autoresearch create <task-id> [goal]",
						);
						if (taskId === null) {
							return;
						}
						const executionProfile = await captureCurrentExecutionProfile(ctx);
						if (executionProfile === null) {
							ctx.ui.notify(
								"Could not capture the current execution profile for this autoresearch task.",
								"error",
							);
							return;
						}

						const goalText = rest.slice(1).join(" ");
						const taskPath = loopTaskFile(taskId);
						const taskAbsolutePath = path.resolve(ctx.cwd, taskPath);
						const taskContent = fs.existsSync(taskAbsolutePath)
							? fs.readFileSync(taskAbsolutePath, "utf-8")
							: createDefaultTaskDocument(taskId, goalText);
						const contract = parseAutoresearchTaskDocument(taskContent, taskPath);

						await withLoopEngine((engine) =>
							engine.createLoop(ctx.cwd, {
								kind: "autoresearch",
								taskId,
								title: contract.title,
								taskContent: goalText,
								benchmarkCommand: contract.benchmark.command,
								checksCommand: contract.benchmark.checksCommand,
								metricName: contract.metric.name,
								metricUnit: contract.metric.unit,
								metricDirection: contract.metric.direction,
								scopeRoot: contract.scope.root,
								scopePaths: contract.scope.paths,
								offLimits: contract.scope.offLimits,
								constraints: contract.constraints,
								maxIterations: Option.map(
									contract.limits,
									(value) => value.maxIterations,
								),
								executionProfile,
							}),
						);

						ctx.ui.notify(
							`Created autoresearch task "${taskId}" at ${taskPath}`,
							"info",
						);
						await updateAutoresearchUI(ctx.cwd, ctx);
						return;
					}

					case "start": {
						const taskId = requireTaskId(rest[0], "/autoresearch start <task-id>");
						if (taskId === null) {
							return;
						}
						const session = commandSessionRef(ctx);
						if (Option.isNone(session)) {
							ctx.ui.notify(
								"Autoresearch start requires an interactive session file.",
								"error",
							);
							return;
						}
						const executionProfile = await captureCurrentExecutionProfile(ctx);
						if (executionProfile === null) {
							ctx.ui.notify(
								"Could not capture the current execution profile for this autoresearch phase.",
								"error",
							);
							return;
						}

						await withLoopEngine((engine) =>
							engine.startLoop(ctx.cwd, taskId, session.value, executionProfile),
						);
						const child = await ensureAutoresearchChildSession(ctx, taskId);
						queueAutoresearchChildPrompt(ctx.cwd, taskId);
						ctx.ui.notify(
							`Started autoresearch loop "${taskId}" in child session ${child.sessionId}.`,
							"info",
						);
						await updateAutoresearchUI(ctx.cwd, ctx);
						runAutoresearchLoop(ctx, taskId);
						return;
					}

					case "resume": {
						const taskId = requireTaskId(rest[0], "/autoresearch resume <task-id>");
						if (taskId === null) {
							return;
						}
						const persisted = readCanonicalLoopState(ctx.cwd, taskId);
						const autoresearch = requireAutoresearchLoopState(persisted);

						if (autoresearch.lifecycle === "paused") {
							const session = commandSessionRef(ctx);
							if (Option.isNone(session)) {
								ctx.ui.notify(
									"Autoresearch resume requires an interactive session file.",
									"error",
								);
								return;
							}
							const executionProfile = await captureCurrentExecutionProfile(ctx);
							if (executionProfile === null) {
								ctx.ui.notify(
									"Could not capture the current execution profile for this autoresearch phase.",
									"error",
								);
								return;
							}
							await withLoopEngine((engine) =>
								engine.resumeLoop(ctx.cwd, taskId, session.value, executionProfile),
							);
						} else if (autoresearch.lifecycle !== "active") {
							ctx.ui.notify(
								`Autoresearch loop "${taskId}" is ${autoresearch.lifecycle}. Resume requires paused or active-without-child state.`,
								"warning",
							);
							return;
						}

						const child = await ensureAutoresearchChildSession(ctx, taskId);
						queueAutoresearchChildPrompt(ctx.cwd, taskId);
						ctx.ui.notify(
							`Resumed autoresearch loop "${taskId}" in child session ${child.sessionId}.`,
							"info",
						);
						await updateAutoresearchUI(ctx.cwd, ctx);
						runAutoresearchLoop(ctx, taskId);
						return;
					}

					case "pause": {
						const taskId = rest[0]
							? requireTaskId(rest[0], "/autoresearch pause [task-id]")
							: await resolveScopedTaskId();
						if (taskId === null) {
							return;
						}
						const persisted = readCanonicalLoopState(ctx.cwd, taskId);
						if (
							persisted.kind === "autoresearch" &&
							Option.isSome(persisted.autoresearch.pendingRunId)
						) {
							ctx.ui.notify(
								`Cannot pause autoresearch loop "${taskId}" while run ${persisted.autoresearch.pendingRunId.value} is pending. Finalize it with autoresearch_done first.`,
								"warning",
							);
							return;
						}
						await withLoopEngine((engine) => engine.pauseLoop(ctx.cwd, taskId));
						cancelAutoresearchLoop(ctx.cwd, taskId);
						ctx.ui.notify(`Paused autoresearch loop "${taskId}"`, "info");
						await updateAutoresearchUI(ctx.cwd, ctx);
						return;
					}

					case "stop": {
						const taskId = rest[0]
							? requireTaskId(rest[0], "/autoresearch stop [task-id]")
							: await resolveScopedTaskId();
						if (taskId === null) {
							return;
						}
						const persisted = readCanonicalLoopState(ctx.cwd, taskId);
						if (
							persisted.kind === "autoresearch" &&
							Option.isSome(persisted.autoresearch.pendingRunId)
						) {
							ctx.ui.notify(
								`Cannot stop autoresearch loop "${taskId}" while run ${persisted.autoresearch.pendingRunId.value} is pending. Finalize it with autoresearch_done first.`,
								"warning",
							);
							return;
						}
						await withLoopEngine((engine) => engine.stopLoop(ctx.cwd, taskId));
						cancelAutoresearchLoop(ctx.cwd, taskId);
						ctx.ui.notify(`Stopped autoresearch loop "${taskId}"`, "info");
						await updateAutoresearchUI(ctx.cwd, ctx);
						return;
					}

					case "status": {
						if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--archived")) {
							ctx.ui.notify("Usage: /autoresearch status [--archived]", "warning");
							return;
						}
						const archived = rest[0] === "--archived";
						const loops = await withLoopEngine((engine) =>
							engine.listLoops(ctx.cwd, archived),
						);
						const autoresearchLoops = loops.filter((loop) =>
							isAutoresearchLoopState(loop),
						);
						if (autoresearchLoops.length === 0) {
							ctx.ui.notify(
								archived
									? "No archived autoresearch loops."
									: "No autoresearch loops found.",
								"info",
							);
							return;
						}

						const heading = archived
							? "Archived autoresearch loops"
							: "Autoresearch loops";
						ctx.ui.notify(
							`${heading}:\n${autoresearchLoops.map((loop) => formatAutoresearchLoopState(loop)).join("\n")}`,
							"info",
						);
						return;
					}

					case "archive": {
						const taskId = requireTaskId(rest[0], "/autoresearch archive <task-id>");
						if (taskId === null) {
							return;
						}
						await withLoopEngine((engine) => engine.archiveLoop(ctx.cwd, taskId));
						cancelAutoresearchLoop(ctx.cwd, taskId);
						ctx.ui.notify(`Archived autoresearch loop "${taskId}"`, "info");
						await updateAutoresearchUI(ctx.cwd, ctx);
						return;
					}

					case "cancel": {
						const taskId = requireTaskId(rest[0], "/autoresearch cancel <task-id>");
						if (taskId === null) {
							return;
						}
						await withLoopEngine((engine) => engine.cancelLoop(ctx.cwd, taskId));
						cancelAutoresearchLoop(ctx.cwd, taskId);
						ctx.ui.notify(`Cancelled autoresearch loop "${taskId}"`, "info");
						await updateAutoresearchUI(ctx.cwd, ctx);
						return;
					}

					case "clean": {
						if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--all")) {
							ctx.ui.notify("Usage: /autoresearch clean [--all]", "warning");
							return;
						}
						const removeArtifacts = rest[0] === "--all";
						const cleaned = await withLoopEngine((engine) =>
							engine.cleanLoops(ctx.cwd, removeArtifacts, "autoresearch"),
						);
						if (cleaned.cleanedTaskIds.length === 0) {
							ctx.ui.notify("No completed autoresearch loops to clean.", "info");
							return;
						}
						ctx.ui.notify(
							removeArtifacts
								? `Removed ${cleaned.cleanedTaskIds.length} completed autoresearch loop(s).`
								: `Cleaned ${cleaned.cleanedTaskIds.length} completed autoresearch loop state file(s).`,
							"info",
						);
						await updateAutoresearchUI(ctx.cwd, ctx);
						return;
					}

					default: {
						ctx.ui.notify(autoresearchHelp(), "info");
						return;
					}
				}
			} catch (error) {
				if (error instanceof LoopTaskAlreadyExistsError) {
					ctx.ui.notify(`Autoresearch task "${error.taskId}" already exists.`, "warning");
					return;
				}
				if (error instanceof LoopTaskNotFoundError) {
					ctx.ui.notify(`Autoresearch task "${error.taskId}" not found.`, "error");
					return;
				}
				if (error instanceof LoopLifecycleConflictError) {
					ctx.ui.notify(
						`Lifecycle conflict for "${error.taskId}": expected ${error.expected}, actual ${error.actual}.`,
						"warning",
					);
					return;
				}
				if (error instanceof LoopOwnershipValidationError) {
					ctx.ui.notify(
						`Ownership error for "${error.taskId}": ${error.reason}`,
						"error",
					);
					return;
				}
				if (error instanceof LoopAmbiguousOwnershipError) {
					ctx.ui.notify(
						`Ambiguous loop ownership for this session: ${error.matchingTaskIds.join(", ")}`,
						"error",
					);
					return;
				}
				if (error instanceof LoopContractValidationError) {
					ctx.ui.notify(`${error.entity}: ${error.reason}`, "error");
					return;
				}
				if (error instanceof AutoresearchValidationError) {
					ctx.ui.notify(error.reason, "error");
					return;
				}
				throw error;
			}
		},
	});

	pi.registerShortcut("ctrl+alt+x", {
		description: "Toggle autoresearch dashboard",
		async handler(ctx): Promise<void> {
			const sessionId = getSessionKey(ctx);
			const viewData = latestViewData.get(sessionId);
			if (viewData === undefined) {
				ctx.ui.notify("No autoresearch dashboard is available for this session.", "info");
				return;
			}
			expandedState.set(sessionId, !(expandedState.get(sessionId) ?? false));
			await updateAutoresearchUI(ctx.cwd, ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+shift+x", {
		description: "Show autoresearch dashboard overlay",
		handler(ctx): Promise<void> {
			return openFullscreenOverlay(ctx.cwd, ctx);
		},
	});

	pi.on("agent_end", async (event, ctx) => {
		try {
			const sessionFile = sessionFileFromContextIfLive(ctx);
			if (sessionFile !== undefined) {
				await withAutoresearchLoopRunner((runner) =>
					runner.resolveAgentEnd(sessionFile, event),
				);
			}

			const cwd = cwdFromContextIfLive(ctx);
			if (cwd === undefined) {
				return;
			}

			await updateAutoresearchUI(cwd, ctx);
		} catch (error) {
			if (isIgnorableSessionContextError(error)) {
				return;
			}
			if (
				error instanceof LoopOwnershipValidationError ||
				error instanceof LoopAmbiguousOwnershipError ||
				error instanceof LoopContractValidationError
			) {
				clearAutoresearchUI(ctx);
				return;
			}
			throw error;
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await updateAutoresearchUI(ctx.cwd, ctx);
		} catch (error) {
			if (
				error instanceof LoopOwnershipValidationError ||
				error instanceof LoopAmbiguousOwnershipError ||
				error instanceof LoopContractValidationError
			) {
				clearAutoresearchUI(ctx);
				return;
			}
			throw error;
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await syncAutoresearchToolVisibility(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		if (sessionFile !== undefined) {
			await withAutoresearchLoopRunner((runner) =>
				runner.resolveAgentEnd(sessionFile, event),
			);

			const loops = await withLoopEngine((engine) => engine.listLoops(ctx.cwd, false));
			for (const loop of loops) {
				if (loop.kind !== "autoresearch") {
					continue;
				}
				if (loop.lifecycle !== "active") {
					continue;
				}
				const child = Option.getOrUndefined(loop.ownership.child);
				if (child === undefined || child.sessionFile !== sessionFile) {
					continue;
				}

				const nextState: AutoresearchLoopPersistedState = {
					...loop,
					updatedAt: new Date().toISOString(),
					ownership: {
						controller: loop.ownership.controller,
						child: Option.none(),
					},
				};
				writeCanonicalLoopState(ctx.cwd, nextState);
			}
		}

		setToolEnabled(pi, AUTORESEARCH_RUN_TOOL_NAME, false);
		setToolEnabled(pi, AUTORESEARCH_DONE_TOOL_NAME, false);
	});
}
