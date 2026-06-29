/**
 * Auto-refreshes AWS SSO tokens for Bedrock.
 *
 * When `AWS_PROFILE` is set, keeps the cached SSO token fresh by running
 * `aws sso login --no-browser` and opening the verification URL with
 * `xdg-open`. Refresh is triggered on session start (except "reload") and
 * before each provider request once the cached token for the profile's
 * `sso_start_url` is within {@link SSO_REFRESH_THRESHOLD_MS} of expiry.
 *
 * Blocking policy (these hooks are awaited by pi):
 * - A still-valid token is refreshed in the background — the session switch or
 *   provider request is NOT blocked.
 * - Only an already-expired/missing token blocks the provider request (it would
 *   otherwise fail), and even then the login is bounded by
 *   {@link SSO_LOGIN_TIMEOUT_MS} and a failure cooldown so it can never hang or
 *   retry-storm.
 *
 * Runs on the pi host process, not the tool sandbox: `aws sso login` must reach
 * the network and `xdg-open` must launch the user's browser.
 */

import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type {
	ExtensionAPI,
	ExtensionUIContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { getHomeDir } from "../shared/home.js";
import { isRecord } from "../shared/json.js";

/** Refresh once the cached token has this little time left (5 minutes). */
export const SSO_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

/** Kill an `aws sso login` attempt that has not completed within this long. */
const SSO_LOGIN_TIMEOUT_MS = 2 * 60 * 1000;

/** After a failed login, wait this long before attempting another. */
const SSO_FAILURE_COOLDOWN_MS = 60 * 1000;

const STATUS_KEY = "tau:sso";

/** Parse AWS INI config text into a `section name -> key/value` map. */
export function parseAwsConfig(raw: string): Map<string, Record<string, string>> {
	const sections = new Map<string, Record<string, string>>();
	let current: Record<string, string> | undefined;
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || /^[#;]/.test(trimmed)) continue;
		const header = trimmed.match(/^\[(.+)\]$/);
		if (header?.[1] !== undefined) {
			current = {};
			sections.set(header[1].trim(), current);
			continue;
		}
		const eq = current ? trimmed.indexOf("=") : -1;
		if (current && eq > 0) {
			current[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
		}
	}
	return sections;
}

/** Resolve a profile's `sso_start_url`, following `sso_session` indirection. */
export function resolveStartUrl(
	sections: Map<string, Record<string, string>>,
	profile: string,
): string | undefined {
	const section = sections.get(`profile ${profile}`) ?? sections.get(profile);
	const direct = section?.["sso_start_url"];
	if (direct !== undefined) return direct;
	const sessionName = section?.["sso_session"];
	return sessionName === undefined
		? undefined
		: sections.get(`sso-session ${sessionName}`)?.["sso_start_url"];
}

const normalizeUrl = (url: string): string => url.replace(/\/+$/, "");

/**
 * Latest expiry (epoch ms) among cache entries whose `startUrl` matches, or
 * `-Infinity` when none match.
 */
export function latestExpiry(entries: readonly unknown[], startUrl: string): number {
	const target = normalizeUrl(startUrl);
	let best = Number.NEGATIVE_INFINITY;
	for (const entry of entries) {
		if (!isRecord(entry)) continue;
		const url = entry["startUrl"];
		if (typeof url !== "string" || normalizeUrl(url) !== target) continue;
		const raw = entry["expiresAt"];
		const expiry = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
		if (Number.isFinite(expiry) && expiry > best) best = expiry;
	}
	return best;
}

const configPath = (): string => join(getHomeDir(), ".aws", "config");
const cacheDir = (): string => join(getHomeDir(), ".aws", "sso", "cache");

function readStartUrl(profile: string): string | undefined {
	let raw: string;
	try {
		raw = readFileSync(configPath(), "utf8");
	} catch {
		return undefined;
	}
	return resolveStartUrl(parseAwsConfig(raw), profile);
}

function readCacheEntries(): readonly unknown[] {
	let files: string[];
	try {
		files = readdirSync(cacheDir()).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	const entries: unknown[] = [];
	for (const file of files) {
		try {
			entries.push(JSON.parse(readFileSync(join(cacheDir(), file), "utf8")) as unknown);
		} catch {
			// Ignore non-token cache files (e.g. botocore client registration blobs).
		}
	}
	return entries;
}

function openBrowser(url: string): void {
	try {
		spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
	} catch {
		// Best-effort: the verification URL is still printed in the login output.
	}
}

/**
 * Run `aws sso login --no-browser`, opening the verification URL (printed to
 * stdout or stderr depending on the CLI build) when it appears. Resolves to
 * `true` on success; bounded by {@link SSO_LOGIN_TIMEOUT_MS}.
 */
function runRefresh(ui: ExtensionUIContext, profile: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		ui.setWorkingMessage("Refreshing AWS SSO token…");
		ui.setStatus(STATUS_KEY, "AWS SSO: refreshing");
		const child = spawn("aws", ["sso", "login", "--no-browser", "--profile", profile], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let opened = false;
		let combined = "";
		let stderr = "";
		let settled = false;

		const tryOpen = (): void => {
			if (opened) return;
			const url = combined.match(/https?:\/\/\S+/)?.[0];
			if (url === undefined) return;
			opened = true;
			// Transient progress only (cleared in finish), so nothing lingers once the
			// token is refreshed.
			ui.setWorkingMessage("Complete the AWS SSO login in your browser…");
			ui.setStatus(STATUS_KEY, "AWS SSO: awaiting browser login");
			openBrowser(url);
		};
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			combined += chunk;
			tryOpen();
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			combined += chunk;
			stderr += chunk;
			tryOpen();
		});

		const finish = (ok: boolean, error?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (!ok && error !== undefined) ui.notify(`AWS SSO refresh failed: ${error}`, "error");
			ui.setWorkingMessage();
			ui.setStatus(STATUS_KEY, undefined);
			resolve(ok);
		};
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {
				// Process may already have exited.
			}
			finish(false, `timed out after ${Math.round(SSO_LOGIN_TIMEOUT_MS / 1000)}s`);
		}, SSO_LOGIN_TIMEOUT_MS);

		child.on("error", (error) => finish(false, error.message));
		child.on("exit", (code) =>
			finish(code === 0, code === 0 ? undefined : stderr.trim() || `exit ${code ?? "unknown"}`),
		);
	});
}

export default function initSso(pi: ExtensionAPI): void {
	let inFlight: Promise<void> | undefined;
	let lastFailureAt: number | undefined;
	let resolved: { readonly profile: string; readonly startUrl: string | undefined } | undefined;

	// AWS_PROFILE and ~/.aws/config are fixed for a session, so resolve the
	// start URL once; only the (changing) token cache is re-read per request.
	const startUrlFor = (profile: string): string | undefined => {
		if (resolved?.profile !== profile) resolved = { profile, startUrl: readStartUrl(profile) };
		return resolved.startUrl;
	};

	const target = (): { readonly profile: string; readonly startUrl: string } | undefined => {
		const profile = process.env["AWS_PROFILE"];
		if (profile === undefined || profile.length === 0) return undefined;
		const startUrl = startUrlFor(profile);
		return startUrl === undefined ? undefined : { profile, startUrl };
	};

	// Single-flight + failure-cooldown. Returns the in-progress login so callers
	// can await it when blocking is required.
	const launchRefresh = (ui: ExtensionUIContext, profile: string, force = false): Promise<void> => {
		if (
			!force &&
			lastFailureAt !== undefined &&
			Date.now() - lastFailureAt < SSO_FAILURE_COOLDOWN_MS
		) {
			return Promise.resolve();
		}
		inFlight ??= runRefresh(ui, profile)
			.then((ok) => {
				lastFailureAt = ok ? undefined : Date.now();
			})
			.finally(() => {
				inFlight = undefined;
			});
		return inFlight;
	};

	// Refresh when the token is within the threshold. Blocks the caller ONLY when
	// the token is already expired/missing (the request would otherwise fail); a
	// still-valid token is refreshed in the background.
	const refreshTick = (ui: ExtensionUIContext): Promise<void> => {
		const t = target();
		if (t === undefined) return Promise.resolve();
		const msLeft = latestExpiry(readCacheEntries(), t.startUrl) - Date.now();
		if (msLeft >= SSO_REFRESH_THRESHOLD_MS) return Promise.resolve();
		const refresh = launchRefresh(ui, t.profile);
		if (msLeft <= 0) return refresh;
		void refresh;
		return Promise.resolve();
	};

	pi.on("session_start", (event: SessionStartEvent, ctx) => {
		// Never block a session switch on an interactive login; kick a background
		// refresh so a resumed Bedrock session is ready by the first turn.
		if (event.reason === "reload") return;
		void refreshTick(ctx.ui);
	});
	pi.on("before_provider_request", (_event, ctx) => refreshTick(ctx.ui));

	pi.registerCommand("sso", {
		description: "AWS SSO: /sso [refresh]",
		handler: async (args, ctx) => {
			const t = target();
			if (t === undefined) {
				const profile = process.env["AWS_PROFILE"];
				ctx.ui.notify(
					profile === undefined || profile.length === 0
						? "AWS_PROFILE not set."
						: `No sso_start_url for '${profile}'.`,
					"warning",
				);
				return;
			}
			if (args.trim() === "refresh") {
				await launchRefresh(ctx.ui, t.profile, true);
			}
			const expiry = latestExpiry(readCacheEntries(), t.startUrl);
			if (!Number.isFinite(expiry)) {
				ctx.ui.notify(`${t.profile}: no cached token — would refresh.`, "warning");
				return;
			}
			const minutes = Math.round((expiry - Date.now()) / 60000);
			const stale = expiry - Date.now() < SSO_REFRESH_THRESHOLD_MS;
			ctx.ui.notify(
				`${t.profile}: ${minutes}m left ${stale ? "(would refresh)" : "(fresh)"}`,
				stale ? "warning" : "info",
			);
		},
	});
}
