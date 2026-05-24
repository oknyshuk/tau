import * as path from "node:path";

import type { ASIData, MetricDirection, NumericMetricMap } from "./schema.js";

type ASIValue = string | number | boolean | null | ASIValue[] | { [key: string]: ASIValue };
import { AUTORESEARCH_DIR } from "./paths.js";

const METRIC_LINE_PREFIX = "METRIC";
const ASI_LINE_PREFIX = "ASI";
export const EXPERIMENT_MAX_LINES = 10;
export const EXPERIMENT_MAX_BYTES = 4 * 1024;

const DENIED_KEY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function parseMetricLines(output: string): Map<string, number> {
	const metrics = new Map<string, number>();
	const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ-]+)=(\\S+)\\s*$`, "gm");
	let match = regex.exec(output);
	while (match !== null) {
		const name = match[1];
		if (name && !DENIED_KEY_NAMES.has(name)) {
			const value = Number(match[2]);
			if (Number.isFinite(value)) {
				metrics.set(name, value);
			}
		}
		match = regex.exec(output);
	}
	return metrics;
}

export function parseAsiLines(output: string): ASIData | null {
	const asi: Record<string, ASIValue> = {};
	const regex = new RegExp(`^${ASI_LINE_PREFIX}\\s+([\\w.-]+)=(.+)\\s*$`, "gm");
	let match = regex.exec(output);
	while (match !== null) {
		const key = match[1];
		if (key && !DENIED_KEY_NAMES.has(key)) {
			asi[key] = parseAsiValue(match[2] ?? "");
		}
		match = regex.exec(output);
	}
	return Object.keys(asi).length > 0 ? (asi as ASIData) : null;
}

function isValidAsiValue(v: unknown): v is ASIValue {
	if (v === null) return true;
	if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return true;
	if (Array.isArray(v)) return v.every(isValidAsiValue);
	if (typeof v === "object" && v !== null) {
		return Object.values(v).every(isValidAsiValue);
	}
	return false;
}

function parseAsiValue(raw: string): ASIValue {
	const value = raw.trim();
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;
	if (/^-?\d+(?:\.\d+)?$/.test(value)) {
		const numberValue = Number(value);
		if (Number.isFinite(numberValue)) return numberValue;
	}
	if (value.startsWith("{") || value.startsWith("[") || value.startsWith('"')) {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (isValidAsiValue(parsed)) return parsed;
			return value;
		} catch {
			return value;
		}
	}
	return value;
}

export function mergeAsi(base: ASIData | null, override: ASIData | undefined): ASIData | undefined {
	if (!base && !override) return undefined;
	return {
		...(base ?? {}),
		...(override ?? {}),
	};
}

function commas(value: number): string {
	const sign = value < 0 ? "-" : "";
	const digits = String(Math.trunc(Math.abs(value)));
	const groups: string[] = [];
	for (let index = digits.length; index > 0; index -= 3) {
		groups.unshift(digits.slice(Math.max(0, index - 3), index));
	}
	return sign + groups.join(",");
}

function fmtNum(value: number, decimals = 0): string {
	if (decimals <= 0) return commas(Math.round(value));
	const absolute = Math.abs(value);
	const whole = Math.floor(absolute);
	const fraction = (absolute - whole).toFixed(decimals).slice(1);
	return `${value < 0 ? "-" : ""}${commas(whole)}${fraction}`;
}

export function formatNum(value: number | null, unit: string): string {
	if (value === null) return "-";
	if (Number.isInteger(value)) return `${fmtNum(value)}${unit}`;
	return `${fmtNum(value, 2)}${unit}`;
}

export function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}

export function getAutoresearchRunDirectory(workDir: string, runNumber: number): string {
	return path.join(workDir, AUTORESEARCH_DIR, "runs", String(runNumber).padStart(4, "0"));
}

export function isAutoresearchShCommand(command: string): boolean {
	let normalized = command.trim();
	normalized = normalized.replace(/^(?:\w+=\S*\s+)+/, "");

	let previous = "";
	while (previous !== normalized) {
		previous = normalized;
		normalized = normalized.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)?\s+/, "");
	}
	if (/[;&|<>]/.test(normalized)) {
		return false;
	}

	const tokens = normalized.split(/\s+/);
	if (tokens.length === 0) return false;

	let index = 0;
	if (tokens[index] === "bash" || tokens[index] === "sh") {
		index += 1;
		while (index < tokens.length && tokens[index]?.startsWith("-")) {
			if (tokens[index]?.includes("c")) {
				return false;
			}
			index += 1;
		}
	}

	const scriptToken = tokens[index];
	if (!scriptToken || !/^(?:\.\/|\/[\w/.-]*\/)?autoresearch\.sh$/.test(scriptToken)) {
		return false;
	}

	for (const token of tokens.slice(index + 1)) {
		if (
			token === "&&" ||
			token === "||" ||
			token === ";" ||
			token === "|" ||
			token === ">" ||
			token === "<"
		) {
			return false;
		}
	}

	return true;
}

export function isBetter(current: number, best: number, direction: MetricDirection): boolean {
	return direction === "lower" ? current < best : current > best;
}

export function inferMetricUnitFromName(name: string): string {
	if (name.endsWith("µs") || name.endsWith("_µs")) return "µs";
	if (name.endsWith("ms") || name.endsWith("_ms")) return "ms";
	if (name.endsWith("_s") || name.endsWith("_sec") || name.endsWith("_secs")) return "s";
	if (name.endsWith("_kb") || name.endsWith("kb")) return "kb";
	if (name.endsWith("_mb") || name.endsWith("mb")) return "mb";
	return "";
}
