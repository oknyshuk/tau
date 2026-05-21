import { Effect, Layer, MutableRef, Schedule, Scope, Context, Stream } from "effect";

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import * as path from "node:path";

import { PiAPI } from "../effect/pi.js";
import { BacklogInfrastructureLive } from "../backlog/repository.js";
import { BacklogRepository } from "../backlog/services.js";
import type { Issue } from "../backlog/schema.js";
import { isRecord } from "../shared/json.js";
import { findNearestWorkspaceRoot } from "../shared/discovery.js";
import { Sandbox } from "./sandbox.js";
import { DEFAULT_SANDBOX_CONFIG } from "../sandbox/config.js";

export interface Footer {
	readonly setup: Effect.Effect<void, never, Scope.Scope>;
}

export const Footer = Context.Service<Footer>("Footer");

type GitLineDelta = { readonly added: number; readonly removed: number };

type FooterHygiene = {
	readonly gitLineDelta: GitLineDelta;
	readonly inProgressCount: number;
};

const EMPTY_FOOTER_HYGIENE: FooterHygiene = {
	gitLineDelta: { added: 0, removed: 0 },
	inProgressCount: 0,
};

export const makeFooterHygieneRef = () =>
	MutableRef.make<FooterHygiene>(EMPTY_FOOTER_HYGIENE);

export const readFooterHygiene = (ref: MutableRef.MutableRef<FooterHygiene>): FooterHygiene =>
	MutableRef.get(ref);

export function setFooterHygieneIfChanged(
	ref: MutableRef.MutableRef<FooterHygiene>,
	next: FooterHygiene,
): boolean {
	const current = MutableRef.get(ref);
	if (
		current.gitLineDelta.added === next.gitLineDelta.added &&
		current.gitLineDelta.removed === next.gitLineDelta.removed &&
		current.inProgressCount === next.inProgressCount
	) {
		return false;
	}

	MutableRef.set(ref, next);
	return true;
}

const FOOTER_PROVIDER_ALIASES: Record<string, string> = {
	"google-gemini-cli": "gemini-cli",
	"openai-codex": "codex",
};

const resolveFooterProviderLabel = (provider: string | null): string | null => {
	if (!provider) return null;
	return FOOTER_PROVIDER_ALIASES[provider] ?? provider;
};

const formatTokenWindow = (tokens: number): string => {
	if (tokens < 1000) {
		return `${tokens}`;
	}
	if (tokens % 1000 === 0) {
		return `${tokens / 1000}k`;
	}
	return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
};

const truncateMiddle = (text: string, width: number): string => {
	if (width <= 0) {
		return "";
	}
	if (visibleWidth(text) <= width) {
		return text;
	}
	if (width <= 3) {
		return truncateToWidth(text, width);
	}
	const keep = Math.floor((width - 3) / 2);
	const start = text.slice(0, keep);
	const end = text.slice(text.length - (width - 3 - keep));
	return `${start}...${end}`;
};

const parseGitNumstat = (output: string): GitLineDelta => {
	let added = 0;
	let removed = 0;

	for (const line of output.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const [rawAdded, rawRemoved] = trimmed.split("\t");
		if (!rawAdded || !rawRemoved || rawAdded === "-" || rawRemoved === "-") continue;
		const parsedAdded = Number(rawAdded);
		const parsedRemoved = Number(rawRemoved);
		if (!Number.isFinite(parsedAdded) || !Number.isFinite(parsedRemoved)) continue;
		added += parsedAdded;
		removed += parsedRemoved;
	}

	return { added, removed };
};

const runNumstat = async (pi: ExtensionAPI, cwd: string, args: string[]): Promise<GitLineDelta> => {
	try {
		const result = await pi.exec("git", args, {
			cwd,
			timeout: 15_000,
		});
		if (result.code !== 0) {
			return { added: 0, removed: 0 };
		}
		return parseGitNumstat(result.stdout ?? "");
	} catch {
		return { added: 0, removed: 0 };
	}
};

const collectGitLineDelta = async (pi: ExtensionAPI, cwd: string): Promise<GitLineDelta> => {
	const [unstaged, staged] = await Promise.all([
		runNumstat(pi, cwd, ["diff", "--numstat", "--no-ext-diff"]),
		runNumstat(pi, cwd, ["diff", "--cached", "--numstat", "--no-ext-diff"]),
	]);

	return {
		added: unstaged.added + staged.added,
		removed: unstaged.removed + staged.removed,
	};
};

export const countInProgressIssues = (issues: ReadonlyArray<Issue>): number =>
	issues.filter((issue) => issue.status === "in_progress").length;

export async function readFooterBacklogInProgressCount(cwd: string): Promise<number> {
	const workspaceRoot = findNearestWorkspaceRoot(cwd);
	const inProgressCount = await Effect.runPromise(
		Effect.gen(function* () {
			const repository = yield* BacklogRepository;
			const issues = yield* repository.withWriteLock(repository.readMaterializedIssues());
			return countInProgressIssues(issues);
		}).pipe(Effect.provide(BacklogInfrastructureLive(workspaceRoot))),
	);
	return inProgressCount;
}

const computeTotalCost = (ctx: ExtensionContext): number => {
	let totalCost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (!isRecord(entry)) continue;
		if (entry["type"] !== "message") continue;
		const message = entry["message"];
		if (!isRecord(message)) continue;
		if (message["role"] !== "assistant") continue;
		const usage = message["usage"];
		if (!isRecord(usage)) continue;
		const cost = usage["cost"];
		if (!isRecord(cost)) continue;
		const total = cost["total"];
		if (typeof total !== "number" || !Number.isFinite(total)) continue;
		totalCost += total;
	}
	return totalCost;
};

const finiteNumberOrUndefined = (value: number | null | undefined): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readContextUsage = (ctx: ExtensionContext) =>
	typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined;

export const FooterLive = Layer.effect(
	Footer,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const sandbox = yield* Sandbox;
		const currentHygieneRef = makeFooterHygieneRef();
		let currentTotalCost = 0;
		let currentSandboxConfig = yield* sandbox.getConfig;
		let currentCwd: string | undefined;
		let currentProvider: string | null = null;
		let currentModel = "no-model";
		let currentThinking = "off";
		let currentContextPercent: number | undefined;
		let currentContextWindow: number | undefined;

		const emitFooterChanged = () => pi.events.emit("tau:footer:changed", null);

		const refreshFooterHygieneOnce = Effect.gen(function* () {
			const cwd = currentCwd;
			if (cwd === undefined) {
				return;
			}
			const gitLineDelta = yield* Effect.promise(() => collectGitLineDelta(pi, cwd));

			const inProgressCount = yield* Effect.promise(() => readFooterBacklogInProgressCount(cwd));
			if (currentCwd !== cwd) {
				return;
			}

			const changed = setFooterHygieneIfChanged(currentHygieneRef, {
				gitLineDelta,
				inProgressCount,
			});
			if (!changed) {
				return;
			}

			yield* Effect.sync(() => emitFooterChanged());
		});

		const refreshFooterHygieneSafe = refreshFooterHygieneOnce.pipe(
			Effect.catch((error) => Effect.logWarning("Footer hygiene refresh failed", error)),
		);
		const refreshFooterHygieneLoop = refreshFooterHygieneSafe.pipe(
			Effect.repeat(Schedule.spaced("5 seconds")),
		);

		return Footer.of({
			setup: Effect.gen(function* () {
				yield* refreshFooterHygieneLoop.pipe(Effect.forkScoped);
				yield* sandbox.changes.pipe(
					Stream.runForEach((config) =>
						Effect.sync(() => {
							currentSandboxConfig = config;
							emitFooterChanged();
						}),
					),
					Effect.forkScoped,
				);
				yield* Effect.sync(() => {
					const updateSessionFooterState = (_event: unknown, ctx: ExtensionContext) => {
						const cwdChanged = currentCwd !== undefined && currentCwd !== ctx.cwd;
						currentCwd = ctx.cwd;
						currentTotalCost = computeTotalCost(ctx);
						currentProvider = ctx.model?.provider ?? null;
						currentModel = ctx.model?.id ?? "no-model";
						currentThinking = pi.getThinkingLevel() ?? "off";
						const usage = readContextUsage(ctx);
						currentContextPercent = finiteNumberOrUndefined(usage?.percent);
						currentContextWindow = finiteNumberOrUndefined(usage?.contextWindow);
						if (cwdChanged) {
							setFooterHygieneIfChanged(currentHygieneRef, EMPTY_FOOTER_HYGIENE);
						}
						emitFooterChanged();
					};

					pi.on("session_switch", updateSessionFooterState);
					pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
						updateSessionFooterState(null, ctx);
						ctx.ui.setFooter(
							(tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
								const unsubBranch = footerData.onBranchChange(() =>
									tui.requestRender(),
								);
								const unsubFooter = pi.events.on("tau:footer:changed", () =>
									tui.requestRender(),
								);

								return {
									dispose() {
										unsubBranch();
										unsubFooter();
									},
									invalidate() {},
									render(width: number): string[] {
										const sandboxConfig = currentSandboxConfig;
										const hygiene = readFooterHygiene(currentHygieneRef);
										const totalCost = currentTotalCost;
										// Single sandbox mode dot (matches codex behavior)
										const fsMode =
											sandboxConfig.filesystemMode ??
											DEFAULT_SANDBOX_CONFIG.filesystemMode;
										const dotColor =
											fsMode === "danger-full-access"
												? ("error" as const)
												: fsMode === "read-only"
													? ("success" as const)
													: ("warning" as const);
										const dots = [theme.fg(dotColor, "•")];

										const cwd = currentCwd ?? process.cwd();
										const repoName = path.basename(cwd);
										const branch = footerData.getGitBranch();
										const repoLine = branch
											? `${repoName}:${branch}`
											: repoName;

										const gitLineDeltaText = `Δ+${hygiene.gitLineDelta.added}/-${hygiene.gitLineDelta.removed}`;
										const gitLineDeltaPart = theme.fg("dim", gitLineDeltaText);

										const inProgressText = `ρ${hygiene.inProgressCount}`;
										const inProgressPart = theme.fg("dim", inProgressText);

										const left =
											dots.join(" ") +
											"  " +
											theme.fg("dim", repoLine) +
											" " +
											gitLineDeltaPart +
											" " +
											inProgressPart;

										const providerLabel = resolveFooterProviderLabel(currentProvider);
										const model = currentModel;
										const thinkingLabel = currentThinking;
										const thinkingStr = ` • ${thinkingLabel}`;
										const modelAndMetaRaw = `${model}${thinkingStr}`;
										const middleRaw = providerLabel
											? `${providerLabel} • ${modelAndMetaRaw}`
											: modelAndMetaRaw;
										const middle = theme.fg("dim", middleRaw);

										const costStr = `$${totalCost.toFixed(3)}`;

										const contextWindow = currentContextWindow;
										const contextStr =
											typeof contextWindow === "number" &&
											Number.isFinite(contextWindow) &&
											contextWindow > 0
												? `${Math.round(currentContextPercent ?? 0)}%/${formatTokenWindow(contextWindow)}`
												: null;

										const rightParts = [costStr, contextStr].filter(
											(part): part is string =>
												typeof part === "string" && part.length > 0,
										);
										const right = theme.fg("dim", rightParts.join(" "));

										const leftWidth = visibleWidth(left);
										const middleWidth = visibleWidth(middleRaw);
										const rightWidth = visibleWidth(right);

										let statsLine = left;
										if (Number.isFinite(width) && width > 0) {
											const minGap = 2;
											const fullRequired =
												leftWidth + middleWidth + rightWidth + minGap * 2;

											if (fullRequired <= width) {
												const free = width - fullRequired;
												const leftGap = minGap + Math.floor(free / 2);
												const rightGap = minGap + Math.ceil(free / 2);
												statsLine = `${left}${" ".repeat(leftGap)}${middle}${" ".repeat(rightGap)}${right}`;
											} else {
												const middleBudget =
													width - leftWidth - rightWidth - minGap * 2;
												if (middleBudget > 0) {
													const compactMiddleRaw = modelAndMetaRaw;
													const preferredMiddleRaw =
														providerLabel &&
														visibleWidth(compactMiddleRaw) <=
															middleBudget
															? compactMiddleRaw
															: middleRaw;
													const renderedMiddleRaw =
														visibleWidth(preferredMiddleRaw) <=
														middleBudget
															? preferredMiddleRaw
															: truncateMiddle(
																	preferredMiddleRaw,
																	middleBudget,
																);
													const renderedMiddle = theme.fg(
														"dim",
														renderedMiddleRaw,
													);
													const consumed =
														leftWidth +
														visibleWidth(renderedMiddleRaw) +
														rightWidth +
														minGap * 2;
													const free = Math.max(0, width - consumed);
													const leftGap = minGap + Math.floor(free / 2);
													const rightGap = minGap + Math.ceil(free / 2);
													statsLine = `${left}${" ".repeat(leftGap)}${renderedMiddle}${" ".repeat(rightGap)}${right}`;
												} else {
													const padding = " ".repeat(
														Math.max(1, width - leftWidth - rightWidth),
													);
													statsLine = `${left}${padding}${right}`;
												}
											}
										} else {
											statsLine = `${left}  ${middle}  ${right}`;
										}

										return [truncateToWidth(statsLine, width)];
									},
								};
							},
						);
					});

					pi.on("turn_end", (_event: unknown, ctx: ExtensionContext) => {
						currentCwd = ctx.cwd;
						currentTotalCost = computeTotalCost(ctx);
						currentProvider = ctx.model?.provider ?? null;
						currentModel = ctx.model?.id ?? "no-model";
						currentThinking = pi.getThinkingLevel() ?? "off";
						const usage = readContextUsage(ctx);
						currentContextPercent = finiteNumberOrUndefined(usage?.percent);
						currentContextWindow = finiteNumberOrUndefined(usage?.contextWindow);
						emitFooterChanged();
					});
					pi.on("session_tree", () => emitFooterChanged());
					pi.on("session_fork", () => emitFooterChanged());
					pi.on("model_select", () => emitFooterChanged());
				});
			}),
		});
	}),
);
