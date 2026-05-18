import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Theme } from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth, type Component } from "@mariozechner/pi-tui";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { Data, Effect, Layer, Option, Result, Schema } from "effect";

import type { TauPersistedState } from "../shared/state.js";

const STATUS_MESSAGE_TYPE = "tau:status";

type StatusState = {
	fetchedAt: number;
	values: Record<string, { percentLeft: number }>;
};

class StatusBoundaryError extends Data.TaggedError("StatusBoundaryError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

function parseJson(text: string): Option.Option<unknown> {
	try {
		return Option.some(JSON.parse(text) as unknown);
	} catch {
		return Option.none();
	}
}

function buildStatusRow(data: {
	label: string;
	subLabel?: string | undefined;
	percentLeft?: number | undefined;
	resetsAt?: number | undefined;
	burnRatePerHour?: number | undefined;
	exhaustsAt?: number | undefined;
	exhaustsBeforeReset?: boolean | undefined;
	isDepleted?: boolean | undefined;
}): StatusRow {
	const row: StatusRow = { label: data.label };
	if (data.subLabel !== undefined) row.subLabel = data.subLabel;
	if (data.percentLeft !== undefined) row.percentLeft = data.percentLeft;
	if (data.resetsAt !== undefined) row.resetsAt = data.resetsAt;
	if (data.burnRatePerHour !== undefined) row.burnRatePerHour = data.burnRatePerHour;
	if (data.exhaustsAt !== undefined) row.exhaustsAt = data.exhaustsAt;
	if (data.exhaustsBeforeReset !== undefined) row.exhaustsBeforeReset = data.exhaustsBeforeReset;
	if (data.isDepleted !== undefined) row.isDepleted = data.isDepleted;
	return row;
}

type OpenAiUsagePayload = {
	plan_type?: string | undefined;
	rate_limit?:
		| {
				allowed?: boolean | undefined;
				limit_reached?: boolean | undefined;
				primary_window?: RateLimitWindowSnapshot | null | undefined;
				secondary_window?: RateLimitWindowSnapshot | null | undefined;
		  }
		| null
		| undefined;
	credits?:
		| {
				has_credits?: boolean | undefined;
				unlimited?: boolean | undefined;
				balance?: string | null | undefined;
		  }
		| null
		| undefined;
};

type RateLimitWindowSnapshot = {
	used_percent?: number | undefined;
	limit_window_seconds?: number | undefined;
	reset_at?: number | undefined;
	reset_after_seconds?: number | undefined;
};

type GeminiQuotaResponse = {
	buckets?:
		| ReadonlyArray<{
				remainingAmount?: string | undefined;
				remainingFraction?: number | undefined;
				resetTime?: string | undefined;
				tokenType?: string | undefined;
				modelId?: string | undefined;
		  }>
		| undefined;
};

type AntigravityUserStatus = {
	userStatus?:
		| {
				name?: string | undefined;
				email?: string | undefined;
				userTier?: { name?: string | undefined } | undefined;
				planStatus?:
					| {
							availablePromptCredits?: number | undefined;
							availableFlowCredits?: number | undefined;
							planInfo?:
								| {
										planName?: string | undefined;
										monthlyPromptCredits?: number | undefined;
										monthlyFlowCredits?: number | undefined;
								  }
								| undefined;
					  }
					| undefined;
				cascadeModelConfigData?:
					| {
							clientModelConfigs?:
								| ReadonlyArray<{
										label?: string | undefined;
										modelOrAlias?: { model?: string | undefined } | undefined;
										quotaInfo?:
											| {
													remainingFraction?: number | undefined;
													resetTime?: string | undefined;
											  }
											| undefined;
								  }>
								| undefined;
					  }
					| undefined;
		  }
		| undefined;
};

const OptionalString = Schema.optional(Schema.String);
const OptionalNumber = Schema.optional(Schema.Number);
const OptionalBoolean = Schema.optional(Schema.Boolean);

const GoogleProjectTokenSchema = Schema.Struct({
	token: Schema.String,
	projectId: Schema.String,
});

const RateLimitWindowSnapshotSchema = Schema.Struct({
	used_percent: OptionalNumber,
	limit_window_seconds: OptionalNumber,
	reset_at: OptionalNumber,
	reset_after_seconds: OptionalNumber,
});

const OpenAiUsagePayloadSchema = Schema.Struct({
	plan_type: OptionalString,
	rate_limit: Schema.optional(
		Schema.Union([
			Schema.Struct({
				allowed: OptionalBoolean,
				limit_reached: OptionalBoolean,
				primary_window: Schema.optional(
					Schema.Union([RateLimitWindowSnapshotSchema, Schema.Null]),
				),
				secondary_window: Schema.optional(
					Schema.Union([RateLimitWindowSnapshotSchema, Schema.Null]),
				),
			}),
			Schema.Null,
		]),
	),
	credits: Schema.optional(
		Schema.Union([
			Schema.Struct({
				has_credits: OptionalBoolean,
				unlimited: OptionalBoolean,
				balance: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
			}),
			Schema.Null,
		]),
	),
});

const GeminiQuotaResponseSchema = Schema.Struct({
	buckets: Schema.optional(
		Schema.Array(
			Schema.Struct({
				remainingAmount: OptionalString,
				remainingFraction: OptionalNumber,
				resetTime: OptionalString,
				tokenType: OptionalString,
				modelId: OptionalString,
			}),
		),
	),
});

const AntigravityUserStatusSchema = Schema.Struct({
	userStatus: Schema.optional(
		Schema.Struct({
			name: OptionalString,
			email: OptionalString,
			userTier: Schema.optional(
				Schema.Struct({
					name: OptionalString,
				}),
			),
			planStatus: Schema.optional(
				Schema.Struct({
					availablePromptCredits: OptionalNumber,
					availableFlowCredits: OptionalNumber,
					planInfo: Schema.optional(
						Schema.Struct({
							planName: OptionalString,
							monthlyPromptCredits: OptionalNumber,
							monthlyFlowCredits: OptionalNumber,
						}),
					),
				}),
			),
			cascadeModelConfigData: Schema.optional(
				Schema.Struct({
					clientModelConfigs: Schema.optional(
						Schema.Array(
							Schema.Struct({
								label: OptionalString,
								modelOrAlias: Schema.optional(
									Schema.Struct({
										model: OptionalString,
									}),
								),
								quotaInfo: Schema.optional(
									Schema.Struct({
										remainingFraction: OptionalNumber,
										resetTime: OptionalString,
									}),
								),
							}),
						),
					),
				}),
			),
		}),
	),
});

type StatusRow = {
	label: string;
	subLabel?: string | undefined;
	percentLeft?: number | undefined;
	resetsAt?: number | undefined;
	burnRatePerHour?: number | undefined;
	exhaustsAt?: number | undefined;
	exhaustsBeforeReset?: boolean | undefined;
	isDepleted?: boolean | undefined;
};

type StatusSectionData = {
	title: string;
	statusLine?: string;
	error?: string;
	notConfigured?: boolean;
	rows: StatusRow[];
};

type StatusMessageDetails = {
	sections: StatusSectionData[];
	fetchedAt: number;
};

function percentLeftFromUsedPercent(usedPercent: number | undefined): number | undefined {
	if (typeof usedPercent !== "number" || Number.isNaN(usedPercent)) return undefined;
	return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

function percentLeftFromRemainingFraction(frac: number | undefined): number | undefined {
	if (typeof frac !== "number" || Number.isNaN(frac)) return undefined;
	return Math.max(0, Math.min(100, frac * 100));
}

function parseIsoTimeSeconds(iso: string | undefined): number | undefined {
	if (!iso) return undefined;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return undefined;
	return Math.floor(t / 1000);
}

function computeBurnAndExhaust(
	prev: StatusState | undefined,
	key: string,
	fetchedAtMs: number,
	currentPercentLeft: number | undefined,
	resetsAt: number | undefined,
	windowSeconds?: number,
): {
	burnRatePerHour?: number | undefined;
	exhaustsAt?: number | undefined;
	exhaustsBeforeReset?: boolean | undefined;
} {
	if (typeof currentPercentLeft !== "number" || !Number.isFinite(currentPercentLeft)) return {};

	let burnRatePerHour: number | undefined;

	if (typeof windowSeconds === "number" && windowSeconds > 0 && typeof resetsAt === "number") {
		const windowStartMs = resetsAt * 1000 - windowSeconds * 1000;
		const elapsedMs = fetchedAtMs - windowStartMs;
		const elapsedHours = elapsedMs / (1000 * 60 * 60);
		if (elapsedHours > 0.01) {
			const usedPercent = 100 - currentPercentLeft;
			burnRatePerHour = usedPercent / elapsedHours;
		}
	}

	if ((burnRatePerHour === undefined || burnRatePerHour < 0.01) && prev) {
		const prevPercentLeft = prev.values[key]?.percentLeft;
		if (typeof prevPercentLeft === "number" && Number.isFinite(prevPercentLeft)) {
			const elapsedMs = fetchedAtMs - prev.fetchedAt;
			const elapsedHours = elapsedMs / (1000 * 60 * 60);
			if (elapsedHours > 0.01) {
				const usedPercent = prevPercentLeft - currentPercentLeft;
				if (usedPercent > 0) {
					burnRatePerHour = usedPercent / elapsedHours;
				}
			}
		}
	}

	if (
		typeof burnRatePerHour !== "number" ||
		!Number.isFinite(burnRatePerHour) ||
		burnRatePerHour < 0.01
	) {
		return {};
	}

	const exhaustHours = currentPercentLeft / burnRatePerHour;
	const exhaustsAtMs = fetchedAtMs + exhaustHours * 60 * 60 * 1000;
	const exhaustsAt = Math.floor(exhaustsAtMs / 1000);
	const exhaustsBeforeReset = typeof resetsAt === "number" ? exhaustsAt < resetsAt : undefined;

	return { burnRatePerHour, exhaustsAt, exhaustsBeforeReset };
}

function mapOpenAiRow(
	window: RateLimitWindowSnapshot | null | undefined,
	prev: StatusState | undefined,
	fetchedAtMs: number,
): StatusRow | undefined {
	if (!window) return undefined;

	const seconds =
		typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : undefined;
	const minutes = seconds && seconds > 0 ? Math.ceil(seconds / 60) : undefined;
	const label = (() => {
		if (minutes === 300) return "5h Limit";
		if (minutes === 10080) return "Weekly Limit";
		if (minutes === 43200) return "Monthly Limit";
		if (minutes) return `${minutes}m Limit`;
		return "Limit";
	})();

	const resetsAt = typeof window.reset_at === "number" ? window.reset_at : undefined;
	const usedPercent = typeof window.used_percent === "number" ? window.used_percent : undefined;
	const percentLeft = percentLeftFromUsedPercent(usedPercent);

	const metrics = computeBurnAndExhaust(
		prev,
		`openai:${label}`,
		fetchedAtMs,
		percentLeft,
		resetsAt,
		seconds,
	);

	return buildStatusRow({
		label,
		percentLeft,
		resetsAt,
		isDepleted: percentLeft === 0,
		...metrics,
	});
}

function renderProgressBar(percentLeft: number | undefined, width: number): string {
	if (typeof percentLeft !== "number") {
		return `[${"?".repeat(width)}]`;
	}

	const clamped = Math.max(0, Math.min(100, percentLeft));
	const filled = Math.round((clamped / 100) * width);
	const empty = Math.max(0, width - filled);
	return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

function formatTime(tsSeconds: number): { time: string; date?: string } {
	const d = new Date(tsSeconds * 1000);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const time = `${hh}:${mm}`;

	const now = new Date();
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	if (sameDay) return { time };

	const day = String(d.getDate()).padStart(2, "0");
	const month = d.toLocaleString("en", { month: "short" });
	return { time, date: `${day} ${month}` };
}

function buildStatusLines(
	section: StatusSectionData,
	width: number,
	th: Theme,
	_fetchedAtMs: number,
): string[] {
	const _innerWidth = Math.max(1, width - 2);
	const lines: string[] = [];

	if (section.error) {
		const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
		lines.push(
			`  ${section.notConfigured ? th.fg("dim", "Not configured") : `${th.fg("error", "Error:")} ${oneLine(section.error)}`}`,
		);
		return lines;
	}

	if (section.rows.length === 0 && section.notConfigured) {
		lines.push(`  ${th.fg("dim", "Not configured")}`);
		return lines;
	}

	for (let i = 0; i < section.rows.length; i++) {
		const row = section.rows[i]!;
		if (i > 0) lines.push("");

		lines.push(` ${row.label}${row.subLabel ? th.fg("dim", ` (${row.subLabel})`) : ""}`);

		const bar = renderProgressBar(row.percentLeft, 20);
		const pct = typeof row.percentLeft === "number" ? Math.round(row.percentLeft) : undefined;
		const percent = typeof pct === "number" ? `${pct}% Left` : "?% Left";
		const depletedText = row.isDepleted ? th.fg("error", " (Depleted)") : "";
		lines.push(` ${bar} ${percent}${depletedText}`);

		const metadata: string[] = [];
		if (typeof row.resetsAt === "number") {
			const fmt = formatTime(row.resetsAt);
			metadata.push(`Reset: ${fmt.date ? `${fmt.date} ${fmt.time}` : fmt.time}`);
		}

		if (typeof row.burnRatePerHour === "number" && Number.isFinite(row.burnRatePerHour)) {
			metadata.push(`Burn: ${row.burnRatePerHour.toFixed(1)}%/h`);
		}

		if (row.isDepleted) {
			metadata.push(th.fg("error", "Limit Reached. Waiting for reset."));
		} else if (typeof row.exhaustsAt === "number") {
			const fmt = formatTime(row.exhaustsAt);
			const base = fmt.date ? `${fmt.date} ${fmt.time}` : fmt.time;
			const color = row.exhaustsBeforeReset ? "error" : "success";
			const label = row.exhaustsBeforeReset ? "Depletes" : "Safe";
			metadata.push(`${label}: ${th.fg(color, base)}`);
		} else if (typeof row.percentLeft === "number" && row.percentLeft === 100) {
			metadata.push(th.fg("success", "Safe"));
		}

		if (metadata.length > 0) {
			lines.push(` ${th.fg("dim", "└─")} ${metadata.join(th.fg("dim", " · "))}`);
		}
	}

	return lines;
}

class StatusCard implements Component {
	private cachedWidth = -1;
	private cachedLines: string[] = [];

	constructor(
		private details: StatusMessageDetails,
		private theme: Theme,
	) {}

	render(width: number): string[] {
		if (width <= 0) return [""];
		if (this.cachedWidth === width && this.cachedLines.length > 0) return this.cachedLines;

		const th = this.theme;
		const innerWidth = Math.max(1, width - 2);
		const lines: string[] = [];

		const pad = (s: string, len: number) => {
			const w = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - w));
		};

		const drawBox = (section: StatusSectionData) => {
			const title = ` ${th.bold(section.title)}`;
			const status = section.statusLine ? `${section.statusLine} ` : "";
			const headerPadding = innerWidth - visibleWidth(title) - visibleWidth(status);

			lines.push(
				th.fg("border", "╭") +
					th.fg("border", "─".repeat(innerWidth)) +
					th.fg("border", "╮"),
			);
			lines.push(
				th.fg("border", "│") +
					title +
					" ".repeat(Math.max(0, headerPadding)) +
					status +
					th.fg("border", "│"),
			);
			lines.push(
				th.fg("border", "├") +
					th.fg("border", "─".repeat(innerWidth)) +
					th.fg("border", "┤"),
			);

			const content = buildStatusLines(section, width, th, this.details.fetchedAt);
			for (const line of content) {
				lines.push(th.fg("border", "│") + pad(line, innerWidth) + th.fg("border", "│"));
			}

			lines.push(
				th.fg("border", "╰") +
					th.fg("border", "─".repeat(innerWidth)) +
					th.fg("border", "╯"),
			);
		};

		for (let i = 0; i < this.details.sections.length; i++) {
			if (i > 0) lines.push("");
			drawBox(this.details.sections[i]!);
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedLines = [];
	}
}

// ---------------------------------------------------------------------------
// Schema decode helpers
// ---------------------------------------------------------------------------

function parseGoogleProjectToken(apiKey: string): Option.Option<{ token: string; projectId: string }> {
	const maybeJson = parseJson(apiKey);
	if (Option.isNone(maybeJson)) return Option.none();
	return Schema.decodeUnknownOption(GoogleProjectTokenSchema)(maybeJson.value);
}

// ---------------------------------------------------------------------------
// HTTP fetch as Effect
// ---------------------------------------------------------------------------

const RemoteHttpClientLive = NodeHttpClient.layerUndici;
const LocalHttpsClientLive = NodeHttpClient.layerNodeHttpNoAgent.pipe(
	Layer.provide(NodeHttpClient.layerAgentOptions({ rejectUnauthorized: false })),
);

function executeJsonRequest<S extends Schema.Decoder<unknown>>(
	request: HttpClientRequest.HttpClientRequest,
	schema: S,
	label: string,
) {
	return Effect.gen(function* () {
		const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
		const response = yield* client.execute(request).pipe(
			Effect.mapError(
				(cause) =>
					new StatusBoundaryError({
						message: `${label} request failed`,
						cause,
					}),
			),
		);

		const json = yield* response.json.pipe(
			Effect.mapError(
				(cause) =>
					new StatusBoundaryError({
						message: `${label}: failed to parse response body`,
						cause,
					}),
			),
		);

		const decoded = Schema.decodeUnknownExit(schema)(json);
		if (decoded._tag === "Failure") {
			return yield* Effect.fail(
				new StatusBoundaryError({
					message: `${label} response failed schema validation`,
					cause: decoded.cause,
				}),
			);
		}

		return decoded.value;
	});
}

function executeRemoteJsonRequest<S extends Schema.Decoder<unknown>>(
	request: HttpClientRequest.HttpClientRequest,
	schema: S,
	label: string,
): Effect.Effect<S["Type"], StatusBoundaryError> {
	return executeJsonRequest(request, schema, label).pipe(Effect.provide(RemoteHttpClientLive));
}

function executeLocalJsonRequest<S extends Schema.Decoder<unknown>>(
	request: HttpClientRequest.HttpClientRequest,
	schema: S,
	label: string,
): Effect.Effect<S["Type"], StatusBoundaryError> {
	return executeJsonRequest(request, schema, label).pipe(Effect.provide(LocalHttpsClientLive));
}

function fetchGeminiQuota(
	token: string,
	projectId: string,
): Effect.Effect<GeminiQuotaResponse, StatusBoundaryError> {
	const request = HttpClientRequest.post(
		"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
	).pipe(
		HttpClientRequest.acceptJson,
		HttpClientRequest.bearerToken(token),
		HttpClientRequest.setHeader("User-Agent", "google-api-nodejs-client/9.15.1"),
		HttpClientRequest.setHeader("X-Goog-Api-Client", "gl-node/22.17.0"),
		HttpClientRequest.setHeader(
			"Client-Metadata",
			"ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
		),
		HttpClientRequest.bodyJsonUnsafe({ project: projectId }),
	);

	return executeRemoteJsonRequest(request, GeminiQuotaResponseSchema, "Gemini quota");
}

function fetchOpenAiUsage(
	token: string,
	options: { accountId?: string | undefined },
): Effect.Effect<OpenAiUsagePayload, StatusBoundaryError> {
	let request = HttpClientRequest.get("https://chatgpt.com/backend-api/wham/usage").pipe(
		HttpClientRequest.acceptJson,
		HttpClientRequest.bearerToken(token),
		HttpClientRequest.setHeader("User-Agent", "pi"),
	);

	if (options.accountId) {
		request = HttpClientRequest.setHeader(
			request,
			"ChatGPT-Account-Id",
			options.accountId,
		);
	}

	return executeRemoteJsonRequest(request, OpenAiUsagePayloadSchema, "OpenAI usage");
}

// ---------------------------------------------------------------------------
// Antigravity (process discovery + localhost HTTPS)
// ---------------------------------------------------------------------------

type ExecSpec = { command: string; args: string[] };

function getPlatformProcessInfo(): { processName: string; exec: ExecSpec } {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === "win32") {
		const processName = "language_server_windows_x64.exe";
		const ps = `Get-CimInstance Win32_Process -Filter "name='${processName}'" | Select-Object ProcessId,CommandLine | ConvertTo-Json`;
		return {
			processName,
			exec: { command: "powershell", args: ["-NoProfile", "-Command", ps] },
		};
	}

	if (platform === "darwin") {
		const suffix = arch === "arm64" ? "_arm" : "";
		const processName = `language_server_macos${suffix}`;
		return { processName, exec: { command: "sh", args: ["-c", `pgrep -fl ${processName}`] } };
	}

	if (platform === "linux") {
		const suffix = arch === "arm64" ? "_arm" : "_x64";
		const processName = `language_server_linux${suffix}`;
		return { processName, exec: { command: "sh", args: ["-c", `pgrep -af ${processName}`] } };
	}

	return {
		processName: "language_server",
		exec: { command: "sh", args: ["-c", "pgrep -af language_server"] },
	};
}

function extractCsrfToken(cmdLine: string): string | null {
	const m = cmdLine.match(/--csrf_token[=\s]+([a-zA-Z0-9-]+)/);
	return m?.[1] ?? null;
}

function hasProcessIdAndCommandLine(item: unknown): item is { ProcessId: number; CommandLine: string } {
	if (typeof item !== "object" || item === null) return false;
	const candidate = item as Record<string, unknown>;
	return (
		typeof candidate["ProcessId"] === "number" &&
		Number.isFinite(candidate["ProcessId"]) &&
		typeof candidate["CommandLine"] === "string"
	);
}

function parseWindowsProcessJson(json: unknown): { pid: number; cmdLine: string } | null {
	const items = Array.isArray(json) ? json : [json];
	for (const item of items) {
		if (!hasProcessIdAndCommandLine(item)) continue;
		const cmdLine = item.CommandLine;
		const lower = cmdLine.toLowerCase();
		if (!lower.includes("antigravity")) continue;
		if (!cmdLine.includes("--csrf_token")) continue;
		return { pid: item.ProcessId, cmdLine };
	}
	return null;
}

function parseUnixProcessOutput(
	stdout: string,
	processName: string,
): { pid: number; cmdLine: string } | null {
	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		if (!line.includes(processName)) continue;
		if (!line.includes("--csrf_token")) continue;
		const firstSpace = line.search(/\s/);
		if (firstSpace <= 0) continue;
		const pidStr = line.slice(0, firstSpace);
		const cmdLine = line.slice(firstSpace + 1);
		const pid = Number.parseInt(pidStr, 10);
		if (!Number.isFinite(pid)) continue;
		return { pid, cmdLine };
	}
	return null;
}

function parseListeningPorts(stdout: string): number[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];

	// Only attempt JSON parsing when the output looks like JSON.
	// This avoids catching legitimate parse errors as control flow.
	const looksLikeJson = trimmed.startsWith("[") || trimmed.startsWith("{") || /^-?\d+(\.\d+)?$/.test(trimmed);
	if (looksLikeJson) {
		const maybeJson = parseJson(trimmed);
		if (Option.isSome(maybeJson)) {
			const json = maybeJson.value;
			if (Array.isArray(json)) {
				const ports = json
					.map((v) => (typeof v === "number" ? v : undefined))
					.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
					.map((v) => Math.trunc(v));
				return Array.from(new Set(ports)).sort((a, b) => a - b);
			}
			if (typeof json === "number" && Number.isFinite(json)) {
				return [Math.trunc(json)];
			}
		}
	}

	const ports: number[] = [];
	const ssRegex = /LISTEN\s+\d+\s+\d+\s+(?:\*|[\d.]+|\[[\da-f:]*\]):(\d+)/i;
	const lsofRegex = /(?:TCP|UDP)\s+(?:\*|[\d.]+|\[[\da-f:]+\]):(\d+)\s+\(LISTEN\)/i;

	for (const line of stdout.split("\n")) {
		const ssMatch = line.match(ssRegex);
		if (ssMatch?.[1]) {
			const p = Number.parseInt(ssMatch[1], 10);
			if (Number.isFinite(p) && !ports.includes(p)) ports.push(p);
		}

		const lsofMatch = line.match(lsofRegex);
		if (lsofMatch?.[1]) {
			const p = Number.parseInt(lsofMatch[1], 10);
			if (Number.isFinite(p) && !ports.includes(p)) ports.push(p);
		}
	}

	ports.sort((a, b) => a - b);
	return ports;
}

function getPortListCommand(pid: number): ExecSpec {
	const platform = process.platform;
	if (platform === "win32") {
		const ps = `Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort | ConvertTo-Json`;
		return { command: "powershell", args: ["-NoProfile", "-Command", ps] };
	}

	if (platform === "darwin") {
		return { command: "sh", args: ["-c", `lsof -iTCP -sTCP:LISTEN -n -P -p ${pid}`] };
	}

	if (platform === "linux") {
		return {
			command: "sh",
			args: [
				"-c",
				`ss -tlnp 2>/dev/null | grep "pid=${pid}" || lsof -iTCP -sTCP:LISTEN -n -P -p ${pid} 2>/dev/null`,
			],
		};
	}

	return { command: "sh", args: ["-c", `lsof -iTCP -sTCP:LISTEN -n -P -p ${pid}`] };
}

function execSpec(
	pi: ExtensionAPI,
	spec: ExecSpec,
): Effect.Effect<{ stdout: string; stderr: string; code: number }, StatusBoundaryError> {
	return Effect.tryPromise({
		try: async () => {
			const result = await pi.exec(spec.command, spec.args, {});
			return {
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
				code: result.code ?? 0,
			};
		},
		catch: (err) =>
			new StatusBoundaryError({ message: `exec failed: ${spec.command}`, cause: err }),
	});
}

function fetchAntigravityUserStatusFromPort(
	port: number,
	csrfToken: string,
): Effect.Effect<AntigravityUserStatus, StatusBoundaryError> {
	const request = HttpClientRequest.post(
		`https://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`,
	).pipe(
		HttpClientRequest.acceptJson,
		HttpClientRequest.setHeader("Connect-Protocol-Version", "1"),
		HttpClientRequest.setHeader("X-Codeium-Csrf-Token", csrfToken),
		HttpClientRequest.bodyJsonUnsafe({
			metadata: {
				ideName: "codex",
				extensionName: "codex",
				locale: "en",
			},
		}),
	);

	return executeLocalJsonRequest(request, AntigravityUserStatusSchema, "Antigravity status");
}

function fetchAntigravityStatus(
	pi: ExtensionAPI,
): Effect.Effect<AntigravityUserStatus, StatusBoundaryError> {
	return Effect.gen(function* () {
		const { processName, exec } = getPlatformProcessInfo();
		const proc = yield* execSpec(pi, exec);
		const stdout = proc.stdout;

		if (!stdout.trim()) {
			return yield* Effect.fail(
				new StatusBoundaryError({
					message: "Antigravity language server process not found",
				}),
			);
		}

		let pid: number | undefined;
		let cmdLine: string | undefined;

		const maybeJson = parseJson(stdout.trim());
		if (Option.isSome(maybeJson)) {
			const parsed = parseWindowsProcessJson(maybeJson.value);
			if (parsed) {
				pid = parsed.pid;
				cmdLine = parsed.cmdLine;
			}
		}

		if (pid === undefined || cmdLine === undefined) {
			const parsed = parseUnixProcessOutput(stdout, processName);
			if (!parsed) {
				return yield* Effect.fail(
					new StatusBoundaryError({
						message: "Antigravity language server process not found",
					}),
				);
			}
			pid = parsed.pid;
			cmdLine = parsed.cmdLine;
		}

		const csrfToken = extractCsrfToken(cmdLine);
		if (!csrfToken) {
			return yield* Effect.fail(
				new StatusBoundaryError({
					message: "CSRF token not found in language server command line",
				}),
			);
		}

		const portExec = getPortListCommand(pid);
		const portsOut = yield* execSpec(pi, portExec);
		const ports = parseListeningPorts(portsOut.stdout);
		if (ports.length === 0) {
			return yield* Effect.fail(
				new StatusBoundaryError({
					message: "No listening ports found for language server",
				}),
			);
		}

		let lastError: StatusBoundaryError | undefined;
		for (const port of ports) {
			const result = yield* Effect.result(
				fetchAntigravityUserStatusFromPort(port, csrfToken),
			);
			if (Result.isSuccess(result)) {
				return result.success;
			}
			lastError = result.failure;
		}

		return yield* Effect.fail(
			new StatusBoundaryError({
				message: `Failed to connect to any language server port${lastError ? `: ${lastError.message}` : ""}`,
				cause: lastError,
			}),
		);
	});
}

// ---------------------------------------------------------------------------
// Section builders — each returns Effect<StatusSectionData, never>
// (errors are caught and mapped to error sections)
// ---------------------------------------------------------------------------

type SectionContext = {
	readonly pi: ExtensionAPI;
	readonly modelRegistry: {
		readonly authStorage: { get(provider: string): unknown };
		readonly getApiKeyForProvider: (provider: string) => Promise<string | undefined>;
	};
	readonly fetchedAt: number;
	readonly prevState: StatusState | undefined;
	readonly nextState: StatusState;
};

const OpenAiCredSchema = Schema.Struct({
	type: Schema.String,
	access: Schema.optional(Schema.String),
	accountId: Schema.optional(Schema.String),
	email: Schema.optional(Schema.String),
});

function buildOpenAiSection(
	sctx: SectionContext,
): Effect.Effect<StatusSectionData, StatusBoundaryError> {
	return Effect.gen(function* () {
		const rawCred = sctx.modelRegistry.authStorage.get("openai-codex");
		const credOpt = Schema.decodeUnknownOption(OpenAiCredSchema)(rawCred);
		const cred = Option.isSome(credOpt) ? credOpt.value : undefined;
		const token = yield* Effect.promise(() =>
			sctx.modelRegistry.getApiKeyForProvider("openai-codex"),
		);
		if (!token) {
			return { title: "OpenAI", notConfigured: true, rows: [] };
		}

		const accountIdOpts: { accountId?: string } = {};
		if (cred?.accountId) accountIdOpts.accountId = cred.accountId;
		const usage = yield* fetchOpenAiUsage(token, accountIdOpts);
		const plan = formatPlanType(usage.plan_type);
		const hasKey = Boolean(process.env["OPENAI_API_KEY"]);
		const statusLine = `[${plan ?? "Pro"}] [Key: ${hasKey ? "Configured" : "Not set"}]`;

		const rows: StatusRow[] = [];
		const p = mapOpenAiRow(usage.rate_limit?.primary_window, sctx.prevState, sctx.fetchedAt);
		if (p) rows.push(p);
		const s = mapOpenAiRow(usage.rate_limit?.secondary_window, sctx.prevState, sctx.fetchedAt);
		if (s) rows.push(s);

		for (const r of rows) {
			if (typeof r.percentLeft === "number") {
				sctx.nextState.values[`openai:${r.label}`] = { percentLeft: r.percentLeft };
			}
		}

		return { title: "OpenAI", statusLine, rows };
	});
}

const GeminiCredSchema = Schema.Struct({
	type: Schema.String,
	email: Schema.optional(Schema.String),
});

function buildGeminiSection(
	sctx: SectionContext,
): Effect.Effect<StatusSectionData, StatusBoundaryError> {
	return Effect.gen(function* () {
		let provider: "google-gemini-cli" | "google-antigravity" = "google-gemini-cli";
		let apiKey = yield* Effect.promise(() =>
			sctx.modelRegistry.getApiKeyForProvider(provider),
		);
		if (!apiKey) {
			provider = "google-antigravity";
			apiKey = yield* Effect.promise(() =>
				sctx.modelRegistry.getApiKeyForProvider(provider),
			);
		}

		const rawCred = sctx.modelRegistry.authStorage.get(provider);
		const credOpt = Schema.decodeUnknownOption(GeminiCredSchema)(rawCred);
		const cred = Option.isSome(credOpt) ? credOpt.value : undefined;
		const statusLine = `[${cred?.email ? cred.email : "Not logged in"}]`;

		if (!apiKey) {
			return { title: "Gemini CLI", notConfigured: true, rows: [], statusLine };
		}

		const parsedOpt = parseGoogleProjectToken(apiKey);
		if (Option.isNone(parsedOpt)) {
			return {
				title: "Gemini CLI",
				error: "Missing Google projectId",
				rows: [],
				statusLine,
			};
		}
		const parsed = parsedOpt.value;

		const quota = yield* fetchGeminiQuota(parsed.token, parsed.projectId);
		const buckets = quota.buckets ?? [];

		const groupRows: StatusRow[] = [];
		const tiers = [
			{
				label: "Flash Tier",
				subLabel: "2.0, 2.5, 3-Pre",
				pattern: /flash/i,
				exclude: /lite/i as RegExp | undefined,
			},
			{ label: "Pro Tier", subLabel: "2.5, 3-Pre", pattern: /pro/i, exclude: undefined as RegExp | undefined },
			{ label: "Lite Tier", subLabel: "2.5-Lite", pattern: /lite/i, exclude: undefined as RegExp | undefined },
		];

		for (const tier of tiers) {
			const tierBuckets = buckets.filter(
				(b) =>
					b.modelId &&
					tier.pattern.test(b.modelId) &&
					(!tier.exclude || !tier.exclude.test(b.modelId)),
			);
			if (tierBuckets.length > 0) {
				const b = tierBuckets[0]!;
				const percentLeft =
					percentLeftFromRemainingFraction(b.remainingFraction) ?? 0;
				const resetsAt = parseIsoTimeSeconds(b.resetTime);
				const metrics = computeBurnAndExhaust(
					sctx.prevState,
					`gemini-cli:${tier.label}`,
					sctx.fetchedAt,
					percentLeft,
					resetsAt,
					86400,
				);
				groupRows.push(
					buildStatusRow({
						label: tier.label,
						subLabel: tier.subLabel,
						percentLeft,
						resetsAt,
						isDepleted: percentLeft === 0,
						...metrics,
					}),
				);
				sctx.nextState.values[`gemini-cli:${tier.label}`] = { percentLeft };
			}
		}

		return { title: "Gemini CLI", statusLine, rows: groupRows };
	});
}

function buildAntigravitySection(
	sctx: SectionContext,
): Effect.Effect<StatusSectionData, StatusBoundaryError> {
	return Effect.gen(function* () {
		const status = yield* fetchAntigravityStatus(sctx.pi);
		const user = status.userStatus;
		const email = user?.email ?? "Unknown";
		const planName = user?.planStatus?.planInfo?.planName;
		const tierName = user?.userTier?.name;
		const plan =
			[planName, tierName].filter(Boolean).join(" (") +
			(planName && tierName ? ")" : "");
		const statusLine = `[${email}]${plan ? ` [${plan}]` : ""}`;

		const configs = user?.cascadeModelConfigData?.clientModelConfigs ?? [];

		const rows: StatusRow[] = [];

		const proConfigs = configs.filter((c) =>
			c.label?.toLowerCase().includes("pro"),
		);
		if (proConfigs.length > 0) {
			const c = proConfigs[0]!;
			const percentLeft =
				percentLeftFromRemainingFraction(c.quotaInfo?.remainingFraction) ?? 0;
			const resetsAt = parseIsoTimeSeconds(c.quotaInfo?.resetTime);
			const metrics = computeBurnAndExhaust(
				sctx.prevState,
				`antigravity:Pro`,
				sctx.fetchedAt,
				percentLeft,
				resetsAt,
				18000,
			);
			rows.push(
				buildStatusRow({
					label: "Gemini 3 Pro",
					subLabel: "High/Low",
					percentLeft,
					resetsAt,
					isDepleted: percentLeft === 0,
					...metrics,
				}),
			);
			sctx.nextState.values[`antigravity:Pro`] = { percentLeft };
		}

		const flashConfigs = configs.filter((c) =>
			c.label?.toLowerCase().includes("flash"),
		);
		if (flashConfigs.length > 0) {
			const c = flashConfigs[0]!;
			const percentLeft =
				percentLeftFromRemainingFraction(c.quotaInfo?.remainingFraction) ?? 0;
			const resetsAt = parseIsoTimeSeconds(c.quotaInfo?.resetTime);
			const metrics = computeBurnAndExhaust(
				sctx.prevState,
				`antigravity:Flash`,
				sctx.fetchedAt,
				percentLeft,
				resetsAt,
				18000,
			);
			rows.push(
				buildStatusRow({
					label: "Gemini 3 Flash",
					percentLeft,
					resetsAt,
					isDepleted: percentLeft === 0,
					...metrics,
				}),
			);
			sctx.nextState.values[`antigravity:Flash`] = { percentLeft };
		} else {
			rows.push(
				buildStatusRow({
					label: "Gemini 3 Flash",
					percentLeft: 0,
					isDepleted: true,
				}),
			);
		}

		return { title: "Antigravity", statusLine, rows };
	});
}

// ---------------------------------------------------------------------------
// Settle helper: run an Effect, catch errors into StatusSectionData
// ---------------------------------------------------------------------------

function settleSection(
	effect: Effect.Effect<StatusSectionData, StatusBoundaryError>,
	fallbackTitle: string,
): Effect.Effect<StatusSectionData> {
	return Effect.result(effect).pipe(
		Effect.map((result) => {
			if (Result.isSuccess(result)) return result.success;
			const err = result.failure;
			const msg = err instanceof Error ? err.message : String(err);
			const notConfigured =
				/process not found|language server process not found|not logged in/i.test(msg);
			return { title: fallbackTitle, error: msg, notConfigured, rows: [] };
		}),
	);
}

function formatPlanType(planType: string | undefined): string | undefined {
	if (!planType) return undefined;
	const t = planType.trim();
	if (!t) return undefined;
	return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------------------------------------------------------------------------
// Public API: registers renderer + /status command
// ---------------------------------------------------------------------------

export type StatusPersistence = {
	readonly getSnapshot: () => TauPersistedState;
	readonly update: (patch: Partial<TauPersistedState>) => void;
};

export function initStatus(pi: ExtensionAPI, persistence: StatusPersistence): void {
	pi.registerMessageRenderer<StatusMessageDetails>(
		STATUS_MESSAGE_TYPE,
		(message, _options, theme) => {
			if (
				message.details !== null &&
				typeof message.details === "object" &&
				"sections" in message.details &&
				Array.isArray((message.details as Record<string, unknown>)["sections"])
			) {
				return new StatusCard(message.details as StatusMessageDetails, theme);
			}
			const text = typeof message.content === "string" ? message.content : "";
			return new Text(text, 0, 0);
		},
	);

	pi.on("context", async (event) => {
		const filtered = event.messages.filter(
			(m) => !(m?.role === "custom" && m?.customType === STATUS_MESSAGE_TYPE),
		);
		return { messages: filtered };
	});

	pi.registerCommand("status", {
		description: "Show quotas and limits (OpenAI, Gemini CLI, Antigravity)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				return;
			}

			ctx.ui.setStatus("tau:status", "Fetching quotas...");
			try {
				await ctx.waitForIdle();

				const fetchedAt = Date.now();
				const prevState = persistence.getSnapshot().status;

				const nextState: StatusState = { fetchedAt, values: {} };

				const sctx: SectionContext = {
					pi,
					modelRegistry: ctx.modelRegistry,
					fetchedAt,
					prevState,
					nextState,
				};

				const [openai, gemini, antigravity] = await Effect.runPromise(
					Effect.all(
						[
							settleSection(buildOpenAiSection(sctx), "OpenAI"),
							settleSection(buildGeminiSection(sctx), "Gemini CLI"),
							settleSection(buildAntigravitySection(sctx), "Antigravity"),
						],
						{ concurrency: "unbounded" },
					),
				);

				const sections: StatusSectionData[] = [openai, gemini, antigravity];

				if (Object.keys(nextState.values).length > 0) {
					persistence.update({ status: nextState });
				}

				pi.sendMessage(
					{
						customType: STATUS_MESSAGE_TYPE,
						content: "",
						display: true,
						details: {
							sections,
							fetchedAt,
						} satisfies StatusMessageDetails,
					},
					{ triggerTurn: false },
				);
			} finally {
				ctx.ui.setStatus("tau:status", undefined);
			}
		},
	});
}
