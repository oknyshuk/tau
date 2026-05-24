import * as crypto from "node:crypto";

import {
	AUTORESEARCH_MD,
	AUTORESEARCH_SH,
	AUTORESEARCH_CHECKS_SH,
} from "./paths.js";

interface AutoresearchBenchmarkContract {
	command: string | null;
	primaryMetric: string | null;
	metricUnit: string;
	direction: "lower" | "higher" | null;
	secondaryMetrics: string[];
}

export interface AutoresearchContract {
	benchmark: AutoresearchBenchmarkContract;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
}

interface AutoresearchContractLoadResult {
	contract: AutoresearchContract;
	errors: string[];
	path: string;
}

interface AutoresearchScriptSnapshot {
	benchmarkScript: string;
	benchmarkScriptPath: string;
	checksScript: string | null;
	checksScriptPath: string;
	errors: string[];
}

const HEADING_REGEX = /^##\s+(.+?)\s*$/;
const LIST_ITEM_REGEX = /^\s*[-*]\s+(.*)$/;
const KEY_VALUE_REGEX = /^\s*[-*]\s+([^:]+):\s*(.*)$/;

function readAutoresearchContract(workDir: string): AutoresearchContractLoadResult {
	// This is a synchronous boundary; caller maps it into Effect if needed.
	// We accept the content as a parameter in tests, so the exported helper
	// for the runtime is readAutoresearchContractFromContent.
	const contractPath = `${workDir}/${AUTORESEARCH_MD}`;
	// Note: actual file reading is done by the repo layer. This module works on content strings.
	return {
		contract: createEmptyAutoresearchContract(),
		errors: ["Use readAutoresearchContractFromContent(content, path) instead."],
		path: contractPath,
	};
}

export function readAutoresearchContractFromContent(
	content: string,
	contractPath: string,
): AutoresearchContractLoadResult {
	const contract = parseAutoresearchContract(content);
	const errors = validateAutoresearchContract(contract);
	return { contract, errors, path: contractPath };
}

function parseAutoresearchContract(markdown: string): AutoresearchContract {
	const sections = extractSections(markdown);
	return {
		benchmark: parseBenchmarkSection(sections.get("benchmark") ?? ""),
		scopePaths: parseListSection(sections.get("files in scope") ?? "", normalizeContractPathSpec),
		offLimits: parseListSection(sections.get("off limits") ?? "", normalizeContractPathSpec),
		constraints: parseListSection(sections.get("constraints") ?? ""),
	};
}

function validateAutoresearchContract(contract: AutoresearchContract): string[] {
	const errors: string[] = [];
	if (!contract.benchmark.command) {
		errors.push("Benchmark.command is required in autoresearch.md.");
	}
	if (!contract.benchmark.primaryMetric) {
		errors.push("Benchmark.primary metric is required in autoresearch.md.");
	}
	if (!contract.benchmark.direction) {
		errors.push("Benchmark.direction must be `lower` or `higher` in autoresearch.md.");
	}
	if (contract.scopePaths.length === 0) {
		errors.push("Files in Scope must contain at least one path in autoresearch.md.");
	}
	for (const scopePath of contract.scopePaths) {
		if (isUnsafeContractPathSpec(scopePath)) {
			errors.push(`Files in Scope contains an invalid path: ${scopePath}`);
		}
	}
	for (const offLimitsPath of contract.offLimits) {
		if (isUnsafeContractPathSpec(offLimitsPath)) {
			errors.push(`Off Limits contains an invalid path: ${offLimitsPath}`);
		}
	}
	return errors;
}

export function buildAutoresearchSegmentFingerprint(
	contract: AutoresearchContract,
	scripts: {
		benchmarkScript: string;
		checksScript: string | null;
	},
): string {
	const payload = {
		benchmark: contract.benchmark,
		scopePaths: contract.scopePaths,
		offLimits: contract.offLimits,
		constraints: contract.constraints,
		scripts,
	};
	return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function normalizeAutoresearchList(values: readonly string[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const trimmed = value.trim();
		if (trimmed.length === 0) continue;
		if (seen.has(trimmed)) continue;
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	return normalized;
}

function normalizeContractPathSpec(value: string): string {
	const normalized = value.trim().replaceAll("\\", "/");
	if (normalized === "." || normalized === "./") return ".";
	return normalized.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function pathMatchesContractPath(pathValue: string, specValue: string): boolean {
	const normalizedPath = normalizeContractPathSpec(pathValue);
	const normalizedSpec = normalizeContractPathSpec(specValue);
	if (normalizedSpec === ".") return true;
	return normalizedPath === normalizedSpec || normalizedPath.startsWith(`${normalizedSpec}/`);
}

export function contractListsEqual(left: readonly string[], right: readonly string[]): boolean {
	const normalizedLeft = normalizeAutoresearchList(left);
	const normalizedRight = normalizeAutoresearchList(right);
	if (normalizedLeft.length !== normalizedRight.length) return false;
	return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function contractPathListsEqual(left: readonly string[], right: readonly string[]): boolean {
	const normalizedLeft = normalizeContractPathList(left);
	const normalizedRight = normalizeContractPathList(right);
	if (normalizedLeft.length !== normalizedRight.length) return false;
	return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function createEmptyAutoresearchContract(): AutoresearchContract {
	return {
		benchmark: {
			command: null,
			primaryMetric: null,
			metricUnit: "",
			direction: null,
			secondaryMetrics: [],
		},
		scopePaths: [],
		offLimits: [],
		constraints: [],
	};
}

function normalizeContractPathList(values: readonly string[]): string[] {
	return normalizeAutoresearchList(values.map(normalizeContractPathSpec)).sort((left, right) =>
		left.localeCompare(right),
	);
}

function extractSections(markdown: string): Map<string, string> {
	const sections = new Map<string, string>();
	const lines = markdown.split("\n");
	let currentHeading: string | null = null;
	let currentLines: string[] = [];

	for (const line of lines) {
		const headingMatch = line.match(HEADING_REGEX);
		if (headingMatch) {
			if (currentHeading) {
				sections.set(currentHeading, currentLines.join("\n").trim());
			}
			currentHeading = headingMatch[1]?.trim().toLowerCase() ?? null;
			currentLines = [];
			continue;
		}
		if (currentHeading) {
			currentLines.push(line);
		}
	}

	if (currentHeading) {
		sections.set(currentHeading, currentLines.join("\n").trim());
	}
	return sections;
}

function parseBenchmarkSection(section: string): AutoresearchBenchmarkContract {
	const entries = new Map<string, string>();
	const lines = section.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const rawLine = lines[index] ?? "";
		const match = rawLine.match(KEY_VALUE_REGEX);
		if (!match) continue;
		const key = normalizeKey(match[1] ?? "");
		let value = (match[2] ?? "").trim();
		if (key === "secondarymetrics") {
			const nestedItems: string[] = [];
			for (let nestedIndex = index + 1; nestedIndex < lines.length; nestedIndex += 1) {
				const nestedLine = lines[nestedIndex] ?? "";
				if (nestedLine.match(KEY_VALUE_REGEX)) break;
				const nestedMatch = nestedLine.match(/^\s{2,}[-*]\s+(.*)$/);
				if (!nestedMatch) {
					if (nestedLine.trim().length > 0) break;
					continue;
				}
				nestedItems.push((nestedMatch[1] ?? "").trim());
				index = nestedIndex;
			}
			if (nestedItems.length > 0) {
				value = [value, ...nestedItems].filter(Boolean).join(", ");
			}
		}
		entries.set(key, value);
	}

	const direction = parseDirection(entries.get("direction"));
	return {
		command: readNullableEntry(entries.get("command")),
		primaryMetric: readNullableEntry(entries.get("primarymetric")),
		metricUnit: entries.get("metricunit")?.trim() ?? "",
		direction,
		secondaryMetrics: parseSecondaryMetrics(entries.get("secondarymetrics")),
	};
}

function parseListSection(section: string, normalizeItem?: (value: string) => string): string[] {
	const items: string[] = [];
	let activeItem: string | null = null;
	for (const rawLine of section.split("\n")) {
		const line = rawLine.trimEnd();
		if (line.trim().length === 0) continue;
		const match = rawLine.match(LIST_ITEM_REGEX);
		if (match) {
			if (activeItem) items.push(activeItem);
			activeItem = (match[1] ?? "").trim();
			continue;
		}
		if (activeItem && /^\s{2,}\S/.test(rawLine)) {
			activeItem = `${activeItem} ${line.trim()}`;
			continue;
		}
		if (activeItem) {
			items.push(activeItem);
			activeItem = null;
		}
		items.push(line.trim());
	}
	if (activeItem) {
		items.push(activeItem);
	}
	const normalizedItems = normalizeAutoresearchList(items);
	return normalizeItem ? normalizedItems.map(normalizeItem) : normalizedItems;
}

function normalizeKey(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseDirection(value: string | undefined): "lower" | "higher" | null {
	if (value === "lower" || value === "higher") return value;
	return null;
}

function readNullableEntry(value: string | undefined): string | null {
	const trimmed = value?.trim() ?? "";
	return trimmed.length > 0 ? trimmed : null;
}

function parseSecondaryMetrics(value: string | undefined): string[] {
	if (!value) return [];
	return normalizeAutoresearchList(
		value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
}

function isUnsafeContractPathSpec(value: string): boolean {
	return value.startsWith("/") || value === ".." || value.startsWith("../");
}
