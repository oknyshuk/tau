import * as path from "node:path";

import { Clock, Effect, Layer, Option, Ref, Context } from "effect";
import type { TruncationResult } from "@mariozechner/pi-coding-agent";

import { AutoresearchRepo } from "../autoresearch/repo.js";
import {
	decodeExperimentState,
	type ASIData,
	type ExperimentResult,
	type ExperimentState,
	type MetricDirection,
	type NumericMetricMap,
	type AutoresearchJsonConfigEntry,
} from "../autoresearch/schema.js";
import {
	AutoresearchContractValidationError,
	AutoresearchFingerprintMismatchError,
	AutoresearchBenchmarkCommandMismatchError,
	AutoresearchMaxExperimentsReachedError,
	AutoresearchValidationError,
	AutoresearchNoPendingRunError,
	AutoresearchGitError,
} from "../autoresearch/errors.js";
import {
	readAutoresearchContractFromContent,
	buildAutoresearchSegmentFingerprint,
	contractPathListsEqual,
	contractListsEqual,
	type AutoresearchContract,
} from "../autoresearch/contract.js";
import {
	createExperimentState,
	cloneExperimentState,
	reconstructStateFromJsonl,
	findBaselineMetric,
	findBestKeptMetric,
	computeConfidence,
	currentResults,
} from "../autoresearch/state.js";
import {
	parseMetricLines,
	parseAsiLines,
	mergeAsi,
	isAutoresearchShCommand,
	isBetter,
	inferMetricUnitFromName,
	formatNum,
	getAutoresearchRunDirectory,
} from "../autoresearch/helpers.js";
import {
	AUTORESEARCH_MD,
	AUTORESEARCH_SH,
	AUTORESEARCH_CHECKS_SH,
} from "../autoresearch/paths.js";
import type { ExecutionProfile } from "../execution/schema.js";
import { StorageError } from "../shared/atomic-write.js";
import { isRecord } from "../shared/json.js";

// ------------------------------------------------------------------------------
// Execution boundary
// ------------------------------------------------------------------------------

export interface RunDetails {
	readonly runNumber: number;
	readonly runDirectory: string;
	readonly benchmarkLogPath: string;
	readonly checksLogPath: Option.Option<string>;
	readonly command: string;
	readonly exitCode: number | null;
	readonly durationSeconds: number;
	readonly passed: boolean;
	readonly crashed: boolean;
	readonly timedOut: boolean;
	readonly tailOutput: string;
	readonly llmTailOutput: string;
	readonly checksPass: boolean | null;
	readonly checksTimedOut: boolean;
	readonly checksOutput: string;
	readonly checksDuration: number;
	readonly parsedMetrics: NumericMetricMap | null;
	readonly parsedPrimary: number | null;
	readonly parsedAsi: ASIData | null;
	readonly metricName: string;
	readonly metricUnit: string;
	readonly fullOutputPath: Option.Option<string>;
	readonly truncation: TruncationResult | null;
}

export interface BenchmarkProgress {
	readonly phase: "running";
	readonly elapsed: string;
	readonly tailOutput: string;
}

export interface KeepCommitResult {
	readonly commit: string;
	readonly note: string;
}

export interface RevertResult {
	readonly note: string;
}

export interface ExecuteBenchmarkInput {
	readonly workDir: string;
	readonly runDirectory: string;
	readonly benchmarkLogPath: string;
	readonly checksLogPath: Option.Option<string>;
	readonly command: string;
	readonly timeoutSeconds: number;
	readonly checksTimeoutSeconds: number;
	readonly metricName: string;
	readonly metricUnit: string;
	readonly signal?: AbortSignal | undefined;
}

export interface AutoresearchExecutionBoundary {
	readonly executeBenchmark: (
		input: ExecuteBenchmarkInput,
		onUpdate?: (progress: BenchmarkProgress) => void,
	) => Effect.Effect<RunDetails, AutoresearchValidationError, never>;
	readonly commitKeep: (
		workDir: string,
		experiment: ExperimentResult,
		committablePaths: readonly string[],
	) => Effect.Effect<KeepCommitResult, AutoresearchGitError, never>;
	readonly revertNonKeep: (
		workDir: string,
		scopePaths: readonly string[],
	) => Effect.Effect<RevertResult, AutoresearchGitError, never>;
	readonly sendFollowUp: (prompt: string) => Effect.Effect<void, never, never>;
	readonly applyExecutionProfile: (
		profile: ExecutionProfile,
	) => Effect.Effect<{ readonly applied: true } | { readonly applied: false; readonly reason: string }, never, never>;
}

// ------------------------------------------------------------------------------
// Session runtime
// ------------------------------------------------------------------------------

export interface PendingRunSummary {
	readonly checksDurationSeconds: number | null;
	readonly checksPass: boolean | null;
	readonly checksTimedOut: boolean;
	readonly command: string;
	readonly durationSeconds: number | null;
	readonly parsedAsi: ASIData | null;
	readonly parsedMetrics: NumericMetricMap | null;
	readonly parsedPrimary: number | null;
	readonly passed: boolean;
	readonly runDirectory: string;
	readonly runNumber: number;
}

export interface SessionRuntime {
	autoresearchMode: boolean;
	autoResumeArmed: boolean;
	loopProgressThisTurn: boolean;
	lastAutoResumePendingRunNumber: number | null;
	lastAutoResumeAt: number | null;
	autoResumeCountThisSegment: number;
	experimentsThisSession: number;
	iterationStartTokens: number | null;
	iterationTokenHistory: number[];
	lastRunChecks: { pass: boolean; output: string; duration: number } | null;
	lastRunDuration: number | null;
	lastRunAsi: ASIData | null;
	lastRunArtifactDir: string | null;
	lastRunNumber: number | null;
	lastRunSummary: PendingRunSummary | null;
	runningExperiment: { startedAt: number; command: string; runDirectory: string; runNumber: number } | null;
	state: ExperimentState;
	goal: string | null;
}

function createSessionRuntime(): SessionRuntime {
	return {
		autoresearchMode: false,
		autoResumeArmed: false,
		loopProgressThisTurn: false,
		lastAutoResumePendingRunNumber: null,
		lastAutoResumeAt: null,
		autoResumeCountThisSegment: 0,
		experimentsThisSession: 0,
		iterationStartTokens: null,
		iterationTokenHistory: [],
		lastRunChecks: null,
		lastRunDuration: null,
		lastRunAsi: null,
		lastRunArtifactDir: null,
		lastRunNumber: null,
		lastRunSummary: null,
		runningExperiment: null,
		state: createExperimentState(),
		goal: null,
	};
}

// ------------------------------------------------------------------------------
// Inputs / Outputs
// ------------------------------------------------------------------------------

export interface InitExperimentInput {
	readonly name: string;
	readonly metricName: string;
	readonly metricUnit: string;
	readonly direction: MetricDirection;
	readonly benchmarkCommand: string;
	readonly scopePaths: readonly string[];
	readonly offLimits: readonly string[];
	readonly constraints: readonly string[];
	readonly maxExperiments?: number | null;
	readonly executionProfile: ExecutionProfile;
}

export interface InitExperimentResult {
	readonly name: string;
	readonly metricName: string;
	readonly metricUnit: string;
	readonly direction: MetricDirection;
	readonly benchmarkCommand: string;
	readonly scopePaths: readonly string[];
	readonly segment: number;
	readonly isReinitializing: boolean;
}

export interface RunExperimentInput {
	readonly command: string;
	readonly timeoutSeconds: number;
	readonly checksTimeoutSeconds: number;
	readonly contextUsage?: { readonly tokens: number; readonly contextWindow: number } | undefined;
}

export interface LogExperimentInput {
	readonly commit: string;
	readonly metric: number;
	readonly status: ExperimentResult["status"];
	readonly description: string;
	readonly metrics: NumericMetricMap | undefined;
	readonly force: boolean;
	readonly asi: ASIData | undefined;
}

export interface LogExperimentResult {
	readonly status: ExperimentResult["status"];
	readonly runNumber: number;
	readonly gitNote: string | null;
	readonly wallClockSeconds: number | null;
	readonly experiment: ExperimentResult;
	readonly state: ExperimentState;
}

export interface AutoresearchViewData {
	readonly autoresearchMode: boolean;
	readonly name: string | null;
	readonly metricName: string;
	readonly metricUnit: string;
	readonly bestMetric: number | null;
	readonly bestDirection: MetricDirection;
	readonly currentSegment: number;
	readonly currentSegmentRunCount: number;
	readonly totalRunCount: number;
	readonly currentSegmentKeptCount: number;
	readonly currentSegmentCrashedCount: number;
	readonly currentSegmentChecksFailedCount: number;
	readonly bestPrimaryMetric: number | null;
	readonly bestRunNumber: number | null;
	readonly confidence: number | null;
	readonly secondaryMetrics: { name: string; unit: string }[];
	readonly runningExperiment: SessionRuntime["runningExperiment"];
	readonly results: readonly ExperimentResult[];
	readonly maxExperiments: number | null;
}

export interface OnAgentEndResult {
	readonly didResume: boolean;
	readonly blockedReason: string | null;
}

// ------------------------------------------------------------------------------
// Service interface
// ------------------------------------------------------------------------------

export interface AutoresearchService {
	readonly rehydrate: (
		sessionId: string,
		workDir: string,
	) => Effect.Effect<void, AutoresearchContractValidationError | AutoresearchValidationError, never>;
	readonly initExperiment: (
		sessionId: string,
		workDir: string,
		input: InitExperimentInput,
	) => Effect.Effect<InitExperimentResult, AutoresearchValidationError | AutoresearchBenchmarkCommandMismatchError | AutoresearchContractValidationError, never>;
	readonly runExperiment: (
		sessionId: string,
		workDir: string,
		input: RunExperimentInput,
		boundary: AutoresearchExecutionBoundary,
	) => Effect.Effect<RunDetails, AutoresearchValidationError | AutoresearchFingerprintMismatchError | AutoresearchMaxExperimentsReachedError, never>;
	readonly logExperiment: (
		sessionId: string,
		workDir: string,
		input: LogExperimentInput,
		boundary: AutoresearchExecutionBoundary,
	) => Effect.Effect<LogExperimentResult, AutoresearchValidationError | AutoresearchFingerprintMismatchError | AutoresearchNoPendingRunError | AutoresearchGitError, never>;
	readonly getViewData: (sessionId: string) => Effect.Effect<AutoresearchViewData, never, never>;
	readonly getExecutionProfile: (sessionId: string) => Effect.Effect<ExecutionProfile | null, never, never>;
	readonly onAgentEnd: (
		sessionId: string,
		workDir: string,
		boundary: AutoresearchExecutionBoundary,
	) => Effect.Effect<OnAgentEndResult, AutoresearchValidationError, never>;
	readonly setMode: (
		sessionId: string,
		enabled: boolean,
		goal: string | null,
	) => Effect.Effect<void, never, never>;
	readonly clearSession: (sessionId: string) => Effect.Effect<void, never, never>;
	readonly recordAgentEndTokens: (sessionId: string, tokens: number | null) => Effect.Effect<void, never, never>;
	readonly resetSessionCounters: (sessionId: string) => Effect.Effect<void, never, never>;
}

export class Autoresearch extends Context.Service<Autoresearch, AutoresearchService>()("Autoresearch") {}

// ------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------

const nowIso = Effect.gen(function* () {
	const millis = yield* Clock.currentTimeMillis;
	return new Date(millis).toISOString();
});

function getRuntime(
	sessionsRef: Ref.Ref<Map<string, SessionRuntime>>,
	sessionId: string,
): Effect.Effect<SessionRuntime, never, never> {
	return Ref.get(sessionsRef).pipe(
		Effect.map((sessions) => {
			const existing = sessions.get(sessionId);
			if (existing) return existing;
			const created = createSessionRuntime();
			sessions.set(sessionId, created);
			return created;
		}),
	);
}

function sanitizeAsi(value: { [key: string]: unknown } | undefined): ASIData | undefined {
	if (!value) return undefined;
	const result: ASIData = {};
	for (const [key, entryValue] of Object.entries(value)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		const sanitized = sanitizeAsiValue(entryValue);
		if (sanitized !== undefined) {
			result[key] = sanitized;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeAsiValue(value: unknown): ASIData[string] | undefined {
	if (value === null) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		const items = value
			.map((item) => sanitizeAsiValue(item))
			.filter((item): item is NonNullable<typeof item> => item !== undefined);
		return items;
	}
	if (typeof value === "object") {
		const objectValue = value as { [key: string]: unknown };
		const result: ASIData = {};
		for (const [key, entryValue] of Object.entries(objectValue)) {
			if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
			const sanitized = sanitizeAsiValue(entryValue);
			if (sanitized !== undefined) {
				result[key] = sanitized;
			}
		}
		return result;
	}
	return undefined;
}

function validateAsiRequirements(asi: ASIData | undefined, status: ExperimentResult["status"]): string | null {
	if (!asi) {
		return "asi is required. Include at minimum a non-empty hypothesis.";
	}
	if (typeof asi["hypothesis"] !== "string" || asi["hypothesis"].trim().length === 0) {
		return "asi.hypothesis is required and must be a non-empty string.";
	}
	if (status === "keep") return null;
	if (typeof asi["rollback_reason"] !== "string" || asi["rollback_reason"].trim().length === 0) {
		return "asi.rollback_reason is required for discard, crash, and checks_failed results.";
	}
	if (typeof asi["next_action_hint"] !== "string" || asi["next_action_hint"].trim().length === 0) {
		return "asi.next_action_hint is required for discard, crash, and checks_failed results.";
	}
	return null;
}

function validateSecondaryMetrics(
	state: ExperimentState,
	metrics: NumericMetricMap,
	force: boolean,
): string | null {
	if (state.secondaryMetrics.length === 0) return null;
	const knownNames = new Set(state.secondaryMetrics.map((metric) => metric.name));
	const providedNames = new Set(Object.keys(metrics));

	const missing = [...knownNames].filter((name) => !providedNames.has(name));
	if (missing.length > 0) {
		return `missing secondary metrics: ${missing.join(", ")}`;
	}

	const newMetrics = [...providedNames].filter((name) => !knownNames.has(name));
	if (newMetrics.length > 0 && !force) {
		return `new secondary metrics require force=true: ${newMetrics.join(", ")}`;
	}
	return null;
}

function buildSecondaryMetrics(
	overrides: NumericMetricMap | undefined,
	parsedMetrics: NumericMetricMap | null,
	primaryMetricName: string,
): NumericMetricMap {
	const merged: NumericMetricMap = {};
	for (const [name, value] of Object.entries(parsedMetrics ?? {})) {
		if (name === "__proto__" || name === "constructor" || name === "prototype") continue;
		if (name === primaryMetricName) continue;
		merged[name] = value;
	}
	for (const [name, value] of Object.entries(overrides ?? {})) {
		if (name === "__proto__" || name === "constructor" || name === "prototype") continue;
		merged[name] = value;
	}
	return merged;
}

function collectLoggedRunNumbers(results: ExperimentState["results"]): Set<number> {
	const runNumbers = new Set<number>();
	for (const result of results) {
		if (result.runNumber !== null) {
			runNumbers.add(result.runNumber);
		}
	}
	return runNumbers;
}

function storageReason(error: StorageError): string {
	return `${error.reason} (${error.path})`;
}

function mapStorageValidation<A>(effect: Effect.Effect<A, StorageError, never>): Effect.Effect<A, AutoresearchValidationError, never> {
	return effect.pipe(
		Effect.mapError((error) =>
			new AutoresearchValidationError({
				reason: storageReason(error),
			}),
		),
	);
}

type AutoresearchStateRepo = {
	readonly readJsonl: (workDir: string) => Effect.Effect<Option.Option<string>, AutoresearchValidationError, never>;
	readonly writeJsonl: (workDir: string, content: string) => Effect.Effect<void, AutoresearchValidationError, never>;
	readonly appendJsonlLine: (workDir: string, line: string) => Effect.Effect<void, AutoresearchValidationError, never>;
	readonly readAutoresearchMd: (workDir: string) => Effect.Effect<Option.Option<string>, AutoresearchValidationError, never>;
	readonly readAutoresearchSh: (workDir: string) => Effect.Effect<Option.Option<string>, AutoresearchValidationError, never>;
	readonly readAutoresearchChecksSh: (workDir: string) => Effect.Effect<Option.Option<string>, AutoresearchValidationError, never>;
	readonly readRunJson: (runDirectory: string) => Effect.Effect<Option.Option<string>, AutoresearchValidationError, never>;
	readonly writeRunJson: (runDirectory: string, content: string) => Effect.Effect<void, AutoresearchValidationError, never>;
	readonly ensureAutoresearchDir: (workDir: string) => Effect.Effect<void, AutoresearchValidationError, never>;
	readonly listRunDirectories: (workDir: string) => Effect.Effect<ReadonlyArray<string>, AutoresearchValidationError, never>;
};

function getNextRunNumber(
	workDir: string,
	lastRunNumber: number | null,
	repo: Pick<AutoresearchStateRepo, "listRunDirectories">,
): Effect.Effect<number, AutoresearchValidationError, never> {
	return repo.listRunDirectories(workDir).pipe(
		Effect.map((directories) => {
			let maxRunNumber = lastRunNumber ?? 0;
			for (const dirName of directories) {
				const runNumber = Number.parseInt(dirName, 10);
				if (Number.isFinite(runNumber)) {
					maxRunNumber = Math.max(maxRunNumber, runNumber);
				}
			}
			return maxRunNumber + 1;
		}),
	);
}

function parsePendingRunSummary(
	value: unknown,
	runDirectory: string,
	directoryName: string,
	loggedRunNumbers: ReadonlySet<number>,
): PendingRunSummary | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as {
		checks?: { durationSeconds?: unknown; passed?: unknown; timedOut?: unknown };
		completedAt?: unknown;
		command?: unknown;
		durationSeconds?: unknown;
		exitCode?: unknown;
		loggedAt?: unknown;
		parsedAsi?: unknown;
		parsedMetrics?: unknown;
		parsedPrimary?: unknown;
		runNumber?: unknown;
		status?: unknown;
		timedOut?: unknown;
	};
	if (candidate.loggedAt !== undefined || candidate.status !== undefined) {
		return null;
	}

	const command = typeof candidate.command === "string" ? candidate.command : "";
	const runNumber =
		typeof candidate.runNumber === "number" && Number.isFinite(candidate.runNumber)
			? candidate.runNumber
			: parseInt(directoryName, 10);
	if (!Number.isFinite(runNumber)) return null;
	if (loggedRunNumbers.has(runNumber)) return null;

	const hasCompletedMetadata =
		typeof candidate.completedAt === "string" ||
		candidate.exitCode !== undefined ||
		candidate.timedOut !== undefined ||
		candidate.durationSeconds !== undefined ||
		candidate.checks !== undefined ||
		candidate.parsedPrimary !== undefined ||
		candidate.parsedMetrics !== undefined ||
		candidate.parsedAsi !== undefined;
	if (!hasCompletedMetadata) {
		return null;
	}

	const checksPass =
		typeof candidate.checks?.passed === "boolean"
			? candidate.checks.passed
			: typeof candidate.checks?.timedOut === "boolean" && candidate.checks.timedOut
				? false
				: null;
	const exitCode =
		typeof candidate.exitCode === "number" && Number.isFinite(candidate.exitCode) ? candidate.exitCode : null;
	const timedOut = candidate.timedOut === true;
	const durationSeconds =
		typeof candidate.durationSeconds === "number" && Number.isFinite(candidate.durationSeconds)
			? candidate.durationSeconds
			: null;
	const parsedPrimary =
		typeof candidate.parsedPrimary === "number" && Number.isFinite(candidate.parsedPrimary)
			? candidate.parsedPrimary
			: null;
	const parsedAsi = clonePendingAsiData(candidate.parsedAsi);
	const parsedMetrics = clonePendingNumericMetricMap(candidate.parsedMetrics);
	const checksDurationSeconds =
		typeof candidate.checks?.durationSeconds === "number" && Number.isFinite(candidate.checks.durationSeconds)
			? candidate.checks.durationSeconds
			: null;
	const checksTimedOut = candidate.checks?.timedOut === true;

	return {
		checksDurationSeconds,
		checksPass,
		checksTimedOut,
		command,
		durationSeconds,
		parsedAsi,
		parsedMetrics,
		parsedPrimary,
		passed: exitCode === 0 && !timedOut && checksPass !== false,
		runDirectory,
		runNumber,
	};
}

function clonePendingNumericMetricMap(value: unknown): NumericMetricMap | null {
	if (typeof value !== "object" || value === null) return null;
	const metrics = value as { [key: string]: unknown };
	const clone: NumericMetricMap = {};
	for (const [key, entryValue] of Object.entries(metrics)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		if (typeof entryValue === "number" && Number.isFinite(entryValue)) {
			clone[key] = entryValue;
		}
	}
	return Object.keys(clone).length > 0 ? clone : null;
}

function clonePendingAsiData(value: unknown): ASIData | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as { [key: string]: unknown };
	const clone: ASIData = {};
	for (const [key, entryValue] of Object.entries(candidate)) {
		if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
		const sanitized = clonePendingAsiValue(entryValue);
		if (sanitized !== undefined) {
			clone[key] = sanitized;
		}
	}
	return Object.keys(clone).length > 0 ? clone : null;
}

function clonePendingAsiValue(value: unknown): ASIData[string] | undefined {
	if (value === null) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		const items = value
			.map((entry) => clonePendingAsiValue(entry))
			.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
		return items;
	}
	if (typeof value === "object") {
		const candidate = value as { [key: string]: unknown };
		const clone: { [key: string]: ASIData[string] } = {};
		for (const [key, entryValue] of Object.entries(candidate)) {
			if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
			const sanitized = clonePendingAsiValue(entryValue);
			if (sanitized !== undefined) {
				clone[key] = sanitized;
			}
		}
		return clone;
	}
	return undefined;
}

function readPendingRunSummary(
	repo: Pick<AutoresearchStateRepo, "listRunDirectories" | "readRunJson">,
	workDir: string,
	loggedRunNumbers: ReadonlySet<number>,
): Effect.Effect<PendingRunSummary | null, AutoresearchValidationError, never> {
	return repo.listRunDirectories(workDir).pipe(
		Effect.flatMap((directories) => {
			// directories are already sorted descending
			function checkNext(index: number): Effect.Effect<PendingRunSummary | null, AutoresearchValidationError, never> {
				if (index >= directories.length) {
					return Effect.succeed(null);
				}
				const directoryName = directories[index];
				if (!directoryName) return checkNext(index + 1);
				const runDirectory = path.join(workDir, ".autoresearch", "runs", directoryName);
				return repo.readRunJson(runDirectory).pipe(
					Effect.flatMap((option) => {
						if (Option.isNone(option)) {
							return checkNext(index + 1);
						}
						let parsed: unknown;
						try {
							parsed = JSON.parse(option.value) as unknown;
						} catch {
							return checkNext(index + 1);
						}
						const summary = parsePendingRunSummary(parsed, runDirectory, directoryName, loggedRunNumbers);
						if (summary) {
							return Effect.succeed(summary);
						}
						return checkNext(index + 1);
					}),
				);
			}
			return checkNext(0);
		}),
	);
}

// ------------------------------------------------------------------------------
// Service implementation
// ------------------------------------------------------------------------------

export const AutoresearchLive = Layer.effect(
	Autoresearch,
	Effect.gen(function* () {
		const rawRepo = yield* AutoresearchRepo;
		const repo: AutoresearchStateRepo = {
			readJsonl: (workDir) => mapStorageValidation(rawRepo.readJsonl(workDir)),
			writeJsonl: (workDir, content) => mapStorageValidation(rawRepo.writeJsonl(workDir, content)),
			appendJsonlLine: (workDir, line) => mapStorageValidation(rawRepo.appendJsonlLine(workDir, line)),
			readAutoresearchMd: (workDir) => mapStorageValidation(rawRepo.readAutoresearchMd(workDir)),
			readAutoresearchSh: (workDir) => mapStorageValidation(rawRepo.readAutoresearchSh(workDir)),
			readAutoresearchChecksSh: (workDir) => mapStorageValidation(rawRepo.readAutoresearchChecksSh(workDir)),
			readRunJson: (runDirectory) => mapStorageValidation(rawRepo.readRunJson(runDirectory)),
			writeRunJson: (runDirectory, content) => mapStorageValidation(rawRepo.writeRunJson(runDirectory, content)),
			ensureAutoresearchDir: (workDir) => mapStorageValidation(rawRepo.ensureAutoresearchDir(workDir)),
			listRunDirectories: (workDir) => mapStorageValidation(rawRepo.listRunDirectories(workDir)),
		};
		const sessionsRef = yield* Ref.make<Map<string, SessionRuntime>>(new Map());

		const ensureSession = (sessionId: string): Effect.Effect<SessionRuntime, never, never> =>
			getRuntime(sessionsRef, sessionId);

		const rehydrate: AutoresearchService["rehydrate"] = Effect.fn("Autoresearch.rehydrate")(
			function* (sessionId, workDir) {
				const runtime = yield* ensureSession(sessionId);
				const jsonlOption = yield* repo.readJsonl(workDir);
				if (Option.isSome(jsonlOption)) {
					const reconstructed = reconstructStateFromJsonl(jsonlOption.value);
					runtime.state = cloneExperimentState(reconstructed.state);
				} else {
					runtime.state = createExperimentState();
				}
				runtime.autoResumeArmed = false;
				runtime.loopProgressThisTurn = false;
				runtime.lastAutoResumePendingRunNumber = null;
				runtime.runningExperiment = null;
				const loggedRunNumbers = collectLoggedRunNumbers(runtime.state.results);
				const pendingRun = yield* readPendingRunSummary(repo, workDir, loggedRunNumbers);
				runtime.lastRunSummary = pendingRun;
				runtime.lastRunChecks =
					pendingRun?.checksPass === null
						? null
						: {
								pass: pendingRun?.checksPass ?? false,
								output: "",
								duration: pendingRun?.checksDurationSeconds ?? 0,
							};
				runtime.lastRunDuration = pendingRun?.durationSeconds ?? null;
				runtime.lastRunAsi = pendingRun?.parsedAsi ?? null;
				runtime.lastRunArtifactDir = pendingRun?.runDirectory ?? null;
				runtime.lastRunNumber = pendingRun?.runNumber ?? null;
			},
		);

		const readContract = (workDir: string): Effect.Effect<AutoresearchContract, AutoresearchValidationError, never> =>
			repo.readAutoresearchMd(workDir).pipe(
				Effect.flatMap((option) => {
					if (Option.isNone(option)) {
						return Effect.fail(
							new AutoresearchValidationError({
								reason: `${AUTORESEARCH_MD} does not exist. Create it before initializing autoresearch.`,
							}),
						);
					}
					const result = readAutoresearchContractFromContent(option.value, path.join(workDir, AUTORESEARCH_MD));
					if (result.errors.length > 0) {
						return Effect.fail(
							new AutoresearchValidationError({
								reason: result.errors.join(" "),
							}),
						);
					}
					return Effect.succeed(result.contract);
				}),
			);

		const readScriptSnapshot = (workDir: string): Effect.Effect<{ benchmarkScript: string; checksScript: string | null }, AutoresearchValidationError, never> =>
			Effect.gen(function* () {
				const benchmarkOption = yield* repo.readAutoresearchSh(workDir);
				if (Option.isNone(benchmarkOption)) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason: `${AUTORESEARCH_SH} does not exist. Create it before initializing autoresearch.`,
						}),
					);
				}
				const checksOption = yield* repo.readAutoresearchChecksSh(workDir);
				return {
					benchmarkScript: benchmarkOption.value,
					checksScript: Option.isSome(checksOption) ? checksOption.value : null,
				};
			});

		const validateFingerprint = (
			segmentFingerprint: string | null,
			workDir: string,
		): Effect.Effect<void, AutoresearchValidationError | AutoresearchFingerprintMismatchError, never> =>
			Effect.gen(function* () {
				if (!segmentFingerprint) {
					return yield* Effect.fail(
						new AutoresearchFingerprintMismatchError({
							reason:
								"The current segment has no fingerprint metadata. Re-run init_experiment before continuing.",
						}),
					);
				}
				const contract = yield* readContract(workDir);
				const scripts = yield* readScriptSnapshot(workDir);
				const currentFingerprint = buildAutoresearchSegmentFingerprint(contract, scripts);
				if (currentFingerprint !== segmentFingerprint) {
					return yield* Effect.fail(
						new AutoresearchFingerprintMismatchError({
							reason:
								"autoresearch.md, autoresearch.sh, or autoresearch.checks.sh changed since the current segment was initialized. Re-run init_experiment before continuing.",
						}),
					);
				}
				yield* Effect.void;
			});

		const requirePinnedExecutionProfile = (
			state: ExperimentState,
		): Effect.Effect<ExecutionProfile, AutoresearchValidationError, never> =>
			state.executionProfile === null
				? Effect.fail(
						new AutoresearchValidationError({
							reason:
								"The current segment has no pinned execution profile. Re-run init_experiment before continuing.",
						}),
					)
				: Effect.succeed(state.executionProfile);

		const initExperiment: AutoresearchService["initExperiment"] = Effect.fn("Autoresearch.initExperiment")(
			function* (sessionId, workDir, input) {
				const runtime = yield* ensureSession(sessionId);
				const state = runtime.state;
				const isReinitializing = state.results.length > 0;

				const loggedRunNumbers = collectLoggedRunNumbers(state.results);
				const pendingRun = yield* readPendingRunSummary(repo, workDir, loggedRunNumbers);
				if (pendingRun) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason: `run #${pendingRun.runNumber} has not been logged yet. Call log_experiment before re-initializing the current segment.`,
						}),
					);
				}

				const contract = yield* readContract(workDir);
				const scripts = yield* readScriptSnapshot(workDir);
				const benchmarkContract = contract.benchmark;
				const expectedDirection = benchmarkContract.direction ?? "lower";
				const expectedMetricUnit = benchmarkContract.metricUnit;

				if (benchmarkContract.command && !isAutoresearchShCommand(benchmarkContract.command)) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason:
								"Benchmark.command in autoresearch.md must invoke `autoresearch.sh` directly. Move the real workload into `autoresearch.sh` and re-run init_experiment.",
						}),
					);
				}
				if (benchmarkContract.command !== input.benchmarkCommand.trim()) {
					return yield* Effect.fail(
						new AutoresearchBenchmarkCommandMismatchError({
							expected: benchmarkContract.command ?? "(missing)",
							received: input.benchmarkCommand,
						}),
					);
				}
				if (benchmarkContract.primaryMetric !== input.metricName.trim()) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason: `metric_name does not match autoresearch.md. Expected: ${benchmarkContract.primaryMetric ?? "(missing)"}\nReceived: ${input.metricName}`,
						}),
					);
				}
				if (input.metricUnit !== expectedMetricUnit) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason: `metric_unit does not match autoresearch.md. Expected: ${expectedMetricUnit || "(empty)"}\nReceived: ${input.metricUnit}`,
						}),
					);
				}
				if (input.direction !== expectedDirection) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason: `direction does not match autoresearch.md. Expected: ${expectedDirection}\nReceived: ${input.direction}`,
						}),
					);
				}
				if (!contractPathListsEqual(input.scopePaths, contract.scopePaths)) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason: `scope_paths do not match autoresearch.md. Expected: ${contract.scopePaths.join(", ")}`,
						}),
					);
				}
				if (!contractPathListsEqual(input.offLimits, contract.offLimits)) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason: `off_limits do not match autoresearch.md. Expected: ${contract.offLimits.join(", ") || "(empty)"}`,
						}),
					);
				}
				if (!contractListsEqual(input.constraints, contract.constraints)) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason: `constraints do not match autoresearch.md. Expected: ${contract.constraints.join(", ") || "(empty)"}`,
						}),
					);
				}

				const segmentFingerprint = buildAutoresearchSegmentFingerprint(contract, scripts);

				state.name = input.name;
				state.metricName = input.metricName;
				state.metricUnit = input.metricUnit;
				state.bestDirection = input.direction;
				state.benchmarkCommand = input.benchmarkCommand.trim();
				state.maxExperiments = input.maxExperiments ?? null;
				state.bestMetric = null;
				state.confidence = null;
				state.secondaryMetrics = benchmarkContract.secondaryMetrics.map((name) => ({
					name,
					unit: inferMetricUnitFromName(name),
				}));
				state.scopePaths = [...contract.scopePaths];
				state.offLimits = [...contract.offLimits];
				state.constraints = [...contract.constraints];
				state.segmentFingerprint = segmentFingerprint;
				state.executionProfile = structuredClone(input.executionProfile);
				if (isReinitializing) {
					state.currentSegment += 1;
				}

				const configLine: AutoresearchJsonConfigEntry = {
					type: "config",
					name: state.name ?? undefined,
					metricName: state.metricName,
					metricUnit: state.metricUnit,
					bestDirection: state.bestDirection,
					benchmarkCommand: state.benchmarkCommand ?? undefined,
					secondaryMetrics: state.secondaryMetrics.map((m) => m.name),
					scopePaths: state.scopePaths,
					offLimits: state.offLimits,
					constraints: state.constraints,
					segmentFingerprint,
					executionProfile: state.executionProfile ?? undefined,
				};

				if (isReinitializing) {
					yield* repo.appendJsonlLine(workDir, JSON.stringify(configLine));
				} else {
					yield* repo.writeJsonl(workDir, `${JSON.stringify(configLine)}\n`);
				}

				runtime.autoresearchMode = true;
				runtime.autoResumeArmed = true;
				runtime.loopProgressThisTurn = true;
				runtime.lastAutoResumePendingRunNumber = null;
				runtime.lastAutoResumeAt = null;
				runtime.autoResumeCountThisSegment = 0;
				runtime.experimentsThisSession = 0;
				runtime.iterationStartTokens = null;
				runtime.iterationTokenHistory = [];
				runtime.lastRunChecks = null;
				runtime.lastRunDuration = null;
				runtime.lastRunAsi = null;
				runtime.lastRunArtifactDir = null;
				runtime.lastRunNumber = null;
				runtime.lastRunSummary = null;

				return {
					name: state.name,
					metricName: state.metricName,
					metricUnit: state.metricUnit,
					direction: state.bestDirection,
					benchmarkCommand: state.benchmarkCommand,
					scopePaths: state.scopePaths,
					segment: state.currentSegment,
					isReinitializing,
				};
			},
		);

		const runExperiment: AutoresearchService["runExperiment"] = Effect.fn("Autoresearch.runExperiment")(
			function* (sessionId, workDir, input, boundary) {
				const runtime = yield* ensureSession(sessionId);
				const state = runtime.state;
				yield* requirePinnedExecutionProfile(state);

				yield* validateFingerprint(state.segmentFingerprint, workDir);

				if (state.benchmarkCommand && input.command.trim() !== state.benchmarkCommand) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason: `command does not match the benchmark command recorded for this segment.\nExpected: ${state.benchmarkCommand}\nReceived: ${input.command}`,
						}),
					);
				}

				const autoresearchScriptPath = path.join(workDir, AUTORESEARCH_SH);
				const scriptExists = yield* repo.readAutoresearchSh(workDir).pipe(
					Effect.map(Option.isSome),
				);
				if (scriptExists && !isAutoresearchShCommand(input.command)) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason:
								`autoresearch.sh exists. Run it directly instead of using a different command.\nExpected something like: bash autoresearch.sh\nReceived: ${input.command}`,
						}),
					);
				}

				const segmentRuns = state.results.filter((result) => result.segment === state.currentSegment).length;
				if (state.maxExperiments !== null && segmentRuns >= state.maxExperiments) {
					return yield* Effect.fail(
						new AutoresearchMaxExperimentsReachedError({
							maxExperiments: state.maxExperiments,
						}),
					);
				}

				const loggedRunNumbers = collectLoggedRunNumbers(state.results);
				const pendingRun =
					runtime.lastRunSummary ?? (yield* readPendingRunSummary(repo, workDir, loggedRunNumbers));
				if (pendingRun) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason: `run #${pendingRun.runNumber} has not been logged yet. Call log_experiment before starting another benchmark run.`,
						}),
					);
				}

				if (input.contextUsage) {
					runtime.experimentsThisSession += 1;
					if (runtime.iterationTokenHistory.length > 0) {
						const values = runtime.iterationTokenHistory;
						const mean = values.reduce((a, b) => a + b, 0) / values.length;
						const sorted = [...values].sort((a, b) => a - b);
						const median =
							sorted.length % 2 === 0
								? (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
								: sorted[Math.floor(sorted.length / 2)]!;
						const estimate = Math.max(mean, median) * 1.2;
						if (input.contextUsage.tokens + estimate > input.contextUsage.contextWindow) {
							return yield* Effect.fail(
								new AutoresearchValidationError({
									reason:
										`Context exhaustion projected: estimated next iteration needs ${Math.round(estimate)} tokens, but only ${input.contextUsage.contextWindow - input.contextUsage.tokens} remain. Reduce benchmark output or start a new segment.`,
								}),
							);
						}
					}
					runtime.iterationStartTokens = input.contextUsage.tokens;
				}

				const runNumber = yield* getNextRunNumber(workDir, runtime.lastRunNumber, repo);
				const runDirectory = getAutoresearchRunDirectory(workDir, runNumber);
				const benchmarkLogPath = path.join(runDirectory, "benchmark.log");
				const checksLogPath = path.join(runDirectory, "checks.log");
				const runJsonPath = path.join(runDirectory, "run.json");

				yield* repo.ensureAutoresearchDir(workDir);
				yield* repo.writeRunJson(runDirectory, "");
				yield* repo.writeRunJson(
					runDirectory,
					JSON.stringify(
						{
							runNumber,
							runDirectory,
							benchmarkLogPath,
							checksLogPath,
							command: input.command,
							startedAt: yield* nowIso,
						},
						null,
						2,
					),
				);

				runtime.lastRunChecks = null;
				runtime.lastRunDuration = null;
				runtime.lastRunAsi = null;
				runtime.lastRunArtifactDir = runDirectory;
				runtime.lastRunNumber = runNumber;
				runtime.lastRunSummary = null;
				runtime.runningExperiment = {
					startedAt: Date.now(),
					command: input.command,
					runDirectory,
					runNumber,
				};

				const details = yield* boundary.executeBenchmark(
					{
						workDir,
						runDirectory,
						benchmarkLogPath,
						checksLogPath: Option.some(checksLogPath),
						command: input.command,
						timeoutSeconds: input.timeoutSeconds,
						checksTimeoutSeconds: input.checksTimeoutSeconds,
						metricName: state.metricName,
						metricUnit: state.metricUnit,
					},
					// onUpdate is not passed through service; adapter handles it directly
				);

				runtime.runningExperiment = null;
				runtime.lastRunDuration = details.durationSeconds;
				runtime.lastRunChecks =
					details.checksPass === null
						? null
						: {
								pass: details.checksPass,
								output: details.checksOutput,
								duration: details.checksDuration,
							};
				runtime.lastRunAsi = details.parsedAsi;
				runtime.lastRunSummary = {
					checksDurationSeconds: details.checksDuration,
					checksPass: details.checksPass,
					checksTimedOut: details.checksTimedOut,
					command: input.command,
					durationSeconds: details.durationSeconds,
					parsedAsi: details.parsedAsi,
					parsedMetrics: details.parsedMetrics,
					parsedPrimary: details.parsedPrimary,
					passed: details.passed,
					runDirectory,
					runNumber,
				};
				runtime.autoResumeArmed = true;
				runtime.loopProgressThisTurn = true;
				runtime.lastAutoResumePendingRunNumber = null;

				const runJsonContent = {
					runNumber,
					runDirectory,
					benchmarkLogPath: details.benchmarkLogPath,
					checksLogPath: Option.getOrUndefined(details.checksLogPath),
					command: input.command,
					completedAt: yield* nowIso,
					durationSeconds: details.durationSeconds,
					exitCode: details.exitCode,
					timedOut: details.timedOut,
					checks: {
						durationSeconds: details.checksDuration,
						passed: details.checksPass,
						timedOut: details.checksTimedOut,
					},
					parsedMetrics: details.parsedMetrics,
					parsedPrimary: details.parsedPrimary,
					parsedAsi: details.parsedAsi,
					fullOutputPath: Option.getOrUndefined(details.fullOutputPath),
				};
				yield* repo.writeRunJson(runDirectory, JSON.stringify(runJsonContent, null, 2));

				return details;
			},
		);

		const logExperiment: AutoresearchService["logExperiment"] = Effect.fn("Autoresearch.logExperiment")(
			function* (sessionId, workDir, input, boundary) {
				const runtime = yield* ensureSession(sessionId);
				const state = runtime.state;
				yield* requirePinnedExecutionProfile(state);

				yield* validateFingerprint(state.segmentFingerprint, workDir);

				const loggedRunNumbers = collectLoggedRunNumbers(state.results);
				const pendingRun =
					runtime.lastRunSummary ?? (yield* readPendingRunSummary(repo, workDir, loggedRunNumbers));
				if (!pendingRun) {
					return yield* Effect.fail(
						new AutoresearchNoPendingRunError({ reason: "no unlogged run is available. Run run_experiment first." }),
					);
				}
				runtime.lastRunSummary = pendingRun;
				runtime.lastRunAsi = pendingRun.parsedAsi;
				runtime.lastRunChecks =
					pendingRun.checksPass === null
						? null
						: {
								pass: pendingRun.checksPass,
								output: "",
								duration: pendingRun.checksDurationSeconds ?? 0,
							};
				runtime.lastRunDuration = pendingRun.durationSeconds;

				if (pendingRun.parsedPrimary !== null && input.metric !== pendingRun.parsedPrimary) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason: `metric does not match the parsed primary metric from the pending run.\nExpected: ${pendingRun.parsedPrimary}\nReceived: ${input.metric}`,
						}),
					);
				}

				if (input.status === "keep" && !pendingRun.passed) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason:
								"cannot keep this run because the pending benchmark did not pass. Log it as crash or checks_failed instead.",
						}),
					);
				}

				if (input.status === "keep" && runtime.lastRunChecks && !runtime.lastRunChecks.pass) {
					return yield* Effect.fail(
						new AutoresearchValidationError({
							reason:
								"cannot keep this run because autoresearch.checks.sh failed. Log it as checks_failed instead.",
						}),
					);
				}

				const observedStatusError = validateObservedStatus(input.status, pendingRun);
				if (observedStatusError) {
					return yield* Effect.fail(
						new AutoresearchValidationError({ reason: observedStatusError }),
					);
				}

				const secondaryMetrics = buildSecondaryMetrics(input.metrics, pendingRun.parsedMetrics, state.metricName);
				const secondaryValidationError = validateSecondaryMetrics(state, secondaryMetrics, input.force);
				if (secondaryValidationError) {
					return yield* Effect.fail(
						new AutoresearchValidationError({ reason: secondaryValidationError }),
					);
				}

				const mergedAsi = mergeAsi(runtime.lastRunAsi, sanitizeAsi(input.asi));
				const asiValidationError = validateAsiRequirements(mergedAsi, input.status);
				if (asiValidationError) {
					return yield* Effect.fail(
						new AutoresearchValidationError({ reason: asiValidationError }),
					);
				}

				if (input.status === "keep") {
					const currentBestMetric = findBestKeptMetric(state.results, state.currentSegment, state.bestDirection);
					if (
						currentBestMetric !== null &&
						input.metric !== currentBestMetric &&
						!isBetter(input.metric, currentBestMetric, state.bestDirection)
					) {
						return yield* Effect.fail(
							new AutoresearchValidationError({
								reason: `cannot keep this run because the primary metric regressed.\nCurrent best: ${currentBestMetric}\nReceived: ${input.metric}`,
							}),
						);
					}
				}

				const experiment: ExperimentResult = {
					runNumber: runtime.lastRunNumber ?? pendingRun.runNumber,
					commit: input.commit.slice(0, 7),
					metric: input.metric,
					metrics: secondaryMetrics,
					status: input.status,
					description: input.description,
					timestamp: Date.now(),
					segment: state.currentSegment,
					confidence: null,
					asi: mergedAsi,
				};

				let gitNote: string | null = null;
				if (input.status === "keep") {
					const scopeValidation = yield* validateKeepPaths(workDir, state, repo);
					if (typeof scopeValidation === "string") {
						return yield* Effect.fail(new AutoresearchValidationError({ reason: scopeValidation }));
					}
					const commitResult = yield* boundary.commitKeep(workDir, experiment, scopeValidation.committablePaths);
					experiment.commit = commitResult.commit;
					gitNote = commitResult.note;
				} else {
					const revertResult = yield* boundary.revertNonKeep(workDir, state.scopePaths);
					gitNote = revertResult.note;
				}

				state.results.push(experiment);
				for (const name of Object.keys(secondaryMetrics)) {
					if (!state.secondaryMetrics.some((metric) => metric.name === name)) {
						state.secondaryMetrics.push({
							name,
							unit: inferMetricUnitFromName(name),
						});
					}
				}
				state.bestMetric = findBaselineMetric(state.results, state.currentSegment);
				state.confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
				experiment.confidence = state.confidence;

				const wallClockSeconds = runtime.lastRunDuration;
				yield* repo.appendJsonlLine(
					workDir,
					JSON.stringify({
						run: experiment.runNumber,
						...experiment,
					}),
				);

				const runDirectory = runtime.lastRunArtifactDir ?? pendingRun.runDirectory;
				if (runDirectory) {
					const runJsonOption = yield* repo.readRunJson(runDirectory);
					let existing: Record<string, unknown> = {};
					if (Option.isSome(runJsonOption)) {
						try {
							const parsed = JSON.parse(runJsonOption.value) as unknown;
							if (isRecord(parsed)) {
								existing = parsed;
							}
						} catch (error) {
							yield* Effect.logWarning("Failed to parse run.json, using empty object", error);
						}
					}
					const updated = {
						...existing,
						loggedRunNumber: experiment.runNumber,
						loggedAt: new Date(experiment.timestamp).toISOString(),
						loggedAsi: experiment.asi,
						loggedMetric: experiment.metric,
						loggedMetrics: experiment.metrics,
						status: experiment.status,
						description: experiment.description,
						commit: experiment.commit,
						gitNote,
						confidence: experiment.confidence,
						wallClockSeconds,
					};
					yield* repo.writeRunJson(runDirectory, JSON.stringify(updated, null, 2));
				}

				runtime.runningExperiment = null;
				runtime.lastRunChecks = null;
				runtime.lastRunDuration = null;
				runtime.lastRunAsi = null;
				runtime.lastRunArtifactDir = null;
				runtime.lastRunNumber = null;
				runtime.lastRunSummary = null;
				runtime.autoResumeArmed = true;
				runtime.lastAutoResumePendingRunNumber = null;

				return {
					status: experiment.status,
					runNumber: experiment.runNumber ?? state.results.length,
					gitNote,
					wallClockSeconds,
					experiment,
					state: cloneExperimentState(state),
				};
			},
		);

		const getViewData: AutoresearchService["getViewData"] = Effect.fn("Autoresearch.getViewData")(
			function* (sessionId) {
				const runtime = yield* ensureSession(sessionId);
				const state = runtime.state;
				const cur = currentResults(state.results, state.currentSegment);
				const kept = cur.filter((r) => r.status === "keep").length;
				const crashed = cur.filter((r) => r.status === "crash").length;
				const checksFailed = cur.filter((r) => r.status === "checks_failed").length;

				let bestPrimary: number | null = null;
				let bestRunNum: number | null = null;
				for (let i = state.results.length - 1; i >= 0; i--) {
					const r = state.results[i];
					if (!r || r.segment !== state.currentSegment) continue;
					if (r.status === "keep" && r.metric > 0) {
						if (bestPrimary === null || isBetter(r.metric, bestPrimary, state.bestDirection)) {
							bestPrimary = r.metric;
							bestRunNum = i + 1;
						}
					}
				}

				return {
					autoresearchMode: runtime.autoresearchMode,
					name: state.name,
					metricName: state.metricName,
					metricUnit: state.metricUnit,
					bestMetric: state.bestMetric,
					bestDirection: state.bestDirection,
					currentSegment: state.currentSegment,
					currentSegmentRunCount: cur.length,
					totalRunCount: state.results.length,
					currentSegmentKeptCount: kept,
					currentSegmentCrashedCount: crashed,
					currentSegmentChecksFailedCount: checksFailed,
					bestPrimaryMetric: bestPrimary,
					bestRunNumber: bestRunNum,
					confidence: state.confidence,
					secondaryMetrics: state.secondaryMetrics.map((m) => ({ ...m })),
					runningExperiment: runtime.runningExperiment,
					results: state.results.slice(),
					maxExperiments: state.maxExperiments,
				};
			},
		);

		const getExecutionProfile: AutoresearchService["getExecutionProfile"] = Effect.fn(
			"Autoresearch.getExecutionProfile",
		)(function* (sessionId) {
			const runtime = yield* ensureSession(sessionId);
			return runtime.state.executionProfile === null
				? null
				: structuredClone(runtime.state.executionProfile);
		});

		const onAgentEnd: AutoresearchService["onAgentEnd"] = Effect.fn("Autoresearch.onAgentEnd")(
			function* (sessionId, workDir, boundary) {
				const runtime = yield* ensureSession(sessionId);
				runtime.runningExperiment = null;
				if (!runtime.autoresearchMode) {
					return { didResume: false, blockedReason: null };
				}

				const loggedRunNumbers = collectLoggedRunNumbers(runtime.state.results);
				const pendingRun =
					runtime.lastRunSummary ?? (yield* readPendingRunSummary(repo, workDir, loggedRunNumbers));
					runtime.lastRunSummary = pendingRun;
					runtime.lastRunChecks =
						pendingRun?.checksPass === null
							? null
							: {
									pass: pendingRun?.checksPass ?? false,
									output: "",
									duration: pendingRun?.checksDurationSeconds ?? 0,
								};
					runtime.lastRunDuration = pendingRun?.durationSeconds ?? runtime.lastRunDuration;
					runtime.lastRunAsi = pendingRun?.parsedAsi ?? runtime.lastRunAsi;

				const shouldResumePendingRun =
					pendingRun !== null && runtime.lastAutoResumePendingRunNumber !== pendingRun.runNumber;
				const shouldResumeExperimentLoop = runtime.autoResumeArmed && runtime.loopProgressThisTurn;
				if (!shouldResumePendingRun && !shouldResumeExperimentLoop) {
					return { didResume: false, blockedReason: null };
				}

				const isExperimentLoopResume = shouldResumeExperimentLoop;
				const now = Date.now();
				if (
					!isExperimentLoopResume &&
					runtime.lastAutoResumeAt !== null &&
					now - runtime.lastAutoResumeAt < 5 * 60 * 1000
				) {
					return { didResume: false, blockedReason: null };
				}
				if (runtime.autoResumeCountThisSegment >= 20) {
					return { didResume: false, blockedReason: null };
				}

				const executionProfile = runtime.state.executionProfile;
				if (executionProfile === null) {
					return {
						didResume: false,
						blockedReason:
							"The current segment has no pinned execution profile. Re-run init_experiment before continuing.",
					};
				}

				const applyExecution = yield* boundary.applyExecutionProfile(executionProfile);
				if (!applyExecution.applied) {
					return {
						didResume: false,
						blockedReason:
							`Could not apply pinned autoresearch execution profile: ${applyExecution.reason}`,
					};
				}

				runtime.lastAutoResumeAt = now;
				runtime.autoResumeCountThisSegment += 1;
				runtime.autoResumeArmed = false;
				runtime.loopProgressThisTurn = false;
				runtime.lastAutoResumePendingRunNumber = pendingRun?.runNumber ?? null;

				// Adapter is responsible for deciding whether to actually send the follow-up
				// based on session idle status. Service only arms it.
				return { didResume: true, blockedReason: null };
			},
		);

		const setMode: AutoresearchService["setMode"] = Effect.fn("Autoresearch.setMode")(
			function* (sessionId, enabled, goal) {
				const runtime = yield* ensureSession(sessionId);
				runtime.autoresearchMode = enabled;
				runtime.autoResumeArmed = false;
				runtime.loopProgressThisTurn = false;
				runtime.goal = goal;
				runtime.lastAutoResumePendingRunNumber = null;
			},
		);

		const clearSession: AutoresearchService["clearSession"] = Effect.fn("Autoresearch.clearSession")(
			function* (sessionId) {
				yield* Ref.update(sessionsRef, (sessions) => {
					sessions.delete(sessionId);
					return sessions;
				});
			},
		);

		const recordAgentEndTokens: AutoresearchService["recordAgentEndTokens"] = Effect.fn(
			"Autoresearch.recordAgentEndTokens",
		)(function* (sessionId, tokens) {
			const runtime = yield* ensureSession(sessionId);
			if (runtime.iterationStartTokens !== null) {
				if (tokens !== null) {
					const delta = tokens - runtime.iterationStartTokens;
					if (delta > 0) {
						runtime.iterationTokenHistory.push(delta);
					}
				}
				runtime.iterationStartTokens = null;
			}
		});

		const resetSessionCounters: AutoresearchService["resetSessionCounters"] = Effect.fn(
			"Autoresearch.resetSessionCounters",
		)(function* (sessionId) {
			const runtime = yield* ensureSession(sessionId);
			runtime.experimentsThisSession = 0;
			runtime.loopProgressThisTurn = false;
		});

		return Autoresearch.of({
			rehydrate,
			initExperiment,
			runExperiment,
			logExperiment,
			getViewData,
			getExecutionProfile,
			onAgentEnd,
			setMode,
			clearSession,
			recordAgentEndTokens,
			resetSessionCounters,
		});
	}),
);

// ------------------------------------------------------------------------------
// Validation helpers
// ------------------------------------------------------------------------------

function validateObservedStatus(
	status: ExperimentResult["status"],
	pendingRun: { checksPass: boolean | null; passed: boolean },
): string | null {
	if (pendingRun.checksPass === false) {
		return status === "checks_failed"
			? null
			: "benchmark checks failed for the pending run. Log it as checks_failed.";
	}
	if (!pendingRun.passed) {
		return status === "crash" ? null : "the pending benchmark failed. Log it as crash.";
	}
	return status === "keep" || status === "discard"
		? null
		: "the pending benchmark passed. Log it as keep or discard.";
}

function validateKeepPaths(
	_workDir: string,
	state: ExperimentState,
	_repo: AutoresearchStateRepo,
): Effect.Effect<{ committablePaths: string[] } | string, never, never> {
	if (state.scopePaths.length === 0) {
		return Effect.succeed("Files in Scope is empty for the current segment. Re-run init_experiment after fixing autoresearch.md.");
	}
	return Effect.succeed({ committablePaths: [...state.scopePaths, AUTORESEARCH_MD, AUTORESEARCH_SH, AUTORESEARCH_CHECKS_SH] });
}
