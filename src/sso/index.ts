/**
 * Auto-refreshes AWS SSO tokens for Bedrock.
 *
 * When `AWS_PROFILE` is set, refreshes the cached SSO token on session start
 * (except "reload") and before each provider request once it is within
 * {@link SSO_REFRESH_THRESHOLD_MS} of expiry: runs `aws sso login --no-browser`
 * and opens the verification URL with `xdg-open`. Skips silently when
 * `AWS_PROFILE` is unset, no `sso_start_url` resolves, or the token is fresh.
 *
 * Runs on the pi host process, not the tool sandbox: `aws sso login` must reach
 * the network and `xdg-open` must launch the user's browser. tau loads it
 * lazily (only when `AWS_PROFILE` is set) so non-AWS sessions pay no startup
 * cost — see `startTau` in `../app.ts`.
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

/** Run `aws sso login --no-browser`, opening the verification URL when it appears. */
function runRefresh(ui: ExtensionUIContext, profile: string): Promise<void> {
	return new Promise<void>((resolve) => {
		ui.setWorkingMessage("Refreshing AWS SSO token…");
		ui.setStatus(STATUS_KEY, "AWS SSO: refreshing");
		const child = spawn("aws", ["sso", "login", "--no-browser", "--profile", profile], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let opened = false;
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			const url = opened ? undefined : stdout.match(/https?:\/\/\S+/)?.[0];
			if (url === undefined) return;
			opened = true;
			ui.notify("Opening browser to complete AWS SSO login…", "info");
			openBrowser(url);
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const finish = (error?: string): void => {
			if (error !== undefined) ui.notify(`AWS SSO refresh failed: ${error}`, "error");
			ui.setWorkingMessage();
			ui.setStatus(STATUS_KEY, undefined);
			resolve();
		};
		child.on("error", (error) => finish(error.message));
		child.on("exit", (code) =>
			finish(code === 0 ? undefined : stderr.trim() || `exit ${code ?? "unknown"}`),
		);
	});
}

export default function initSso(pi: ExtensionAPI): void {
	let inFlight: Promise<void> | undefined;
	let resolved: { readonly profile: string; readonly startUrl: string | undefined } | undefined;

	// AWS_PROFILE and ~/.aws/config are fixed for a session, so resolve the
	// start URL once; only the (changing) token cache is re-read per request.
	const startUrlFor = (profile: string): string | undefined => {
		if (resolved?.profile !== profile) resolved = { profile, startUrl: readStartUrl(profile) };
		return resolved.startUrl;
	};

	const ensureFresh = (ui: ExtensionUIContext): Promise<void> => {
		const profile = process.env["AWS_PROFILE"];
		if (profile === undefined || profile.length === 0) return Promise.resolve();
		const startUrl = startUrlFor(profile);
		if (startUrl === undefined) return Promise.resolve();
		if (latestExpiry(readCacheEntries(), startUrl) - Date.now() >= SSO_REFRESH_THRESHOLD_MS) {
			return Promise.resolve();
		}
		inFlight ??= runRefresh(ui, profile).finally(() => {
			inFlight = undefined;
		});
		return inFlight;
	};

	pi.on("session_start", (event: SessionStartEvent, ctx) => {
		if (event.reason === "reload") return;
		return ensureFresh(ctx.ui);
	});
	pi.on("before_provider_request", (_event, ctx) => ensureFresh(ctx.ui));

	pi.registerCommand("sso", {
		description: "AWS SSO: /sso [refresh]",
		handler: async (args, ctx) => {
			const profile = process.env["AWS_PROFILE"];
			if (profile === undefined || profile.length === 0) {
				ctx.ui.notify("AWS_PROFILE not set.", "warning");
				return;
			}
			const startUrl = startUrlFor(profile);
			if (startUrl === undefined) {
				ctx.ui.notify(`No sso_start_url for '${profile}'.`, "warning");
				return;
			}
			if (args.trim() === "refresh") {
				await runRefresh(ctx.ui, profile);
				return;
			}
			const expiry = latestExpiry(readCacheEntries(), startUrl);
			if (!Number.isFinite(expiry)) {
				ctx.ui.notify(`${profile}: no cached token — would refresh.`, "warning");
				return;
			}
			const minutes = Math.round((expiry - Date.now()) / 60000);
			const stale = expiry - Date.now() < SSO_REFRESH_THRESHOLD_MS;
			ctx.ui.notify(
				`${profile}: ${minutes}m left ${stale ? "(would refresh)" : "(fresh)"}`,
				stale ? "warning" : "info",
			);
		},
	});
}
