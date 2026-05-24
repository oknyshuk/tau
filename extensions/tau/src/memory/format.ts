import { DateTime, Schema } from "effect";
import { nanoid } from "nanoid";

const MemoryScopeSchema = Schema.Union([
	Schema.Literal("project"),
	Schema.Literal("global"),
	Schema.Literal("user"),
]);

export type MemoryScope = typeof MemoryScopeSchema.Type;

const ID_SIZE = 12;
const SUMMARY_MAX_CHARS = 140;
const DEFAULT_SCOPE: MemoryScope = "global";
const DEFAULT_TYPE = "fact";

const NANO_ID_PATTERN = /^[A-Za-z0-9_-]{12,}$/u;
const MEMORY_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;

export const MemoryEntryId = Schema.String.check(
	Schema.makeFilter((value) => NANO_ID_PATTERN.test(value) || "expected a nanoid"),
).pipe(Schema.brand("MemoryEntryId"));

export type MemoryEntryId = typeof MemoryEntryId.Type;
type MemoryTimestamp = typeof Schema.DateTimeUtcFromString.Type;

const MemoryEntryContent = Schema.String.check(
	Schema.makeFilter(
		(value) => value.trim().length > 0 || "memory content must not be empty",
	),
);

const MemoryEntryTypeSchema = Schema.String.check(
	Schema.makeFilter(
		(value) => MEMORY_TYPE_PATTERN.test(value) || "expected a lowercase memory type",
	),
);

type MemoryEntryType = typeof MemoryEntryTypeSchema.Type;

const MemoryEntrySummary = Schema.String.check(
	Schema.makeFilter(
		(value) =>
			(value.trim().length > 0 && value.length <= SUMMARY_MAX_CHARS) ||
			`memory summary must be 1-${SUMMARY_MAX_CHARS} chars`,
	),
);

export class MemoryEntry extends Schema.Class<MemoryEntry>("MemoryEntry")({
	id: MemoryEntryId,
	scope: MemoryScopeSchema,
	type: MemoryEntryTypeSchema,
	summary: MemoryEntrySummary,
	content: MemoryEntryContent,
	createdAt: Schema.DateTimeUtcFromString,
	updatedAt: Schema.DateTimeUtcFromString,
}) {}

type MemoryEntryJson = typeof MemoryEntry.Encoded;

interface CreateMemoryEntryOptions {
	readonly id?: string;
	readonly scope?: MemoryScope;
	readonly type?: string;
	readonly summary: string;
	readonly now?: MemoryTimestamp;
	readonly createdAt?: MemoryTimestamp;
	readonly updatedAt?: MemoryTimestamp;
}

interface LegacyCreateMemoryEntryOptions {
	readonly id?: string;
	readonly scope?: MemoryScope;
	readonly type?: string;
	readonly summary?: string;
	readonly now?: MemoryTimestamp;
	readonly createdAt?: MemoryTimestamp;
	readonly updatedAt?: MemoryTimestamp;
}

interface LegacyMemoryMigrationOptions {
	readonly now?: MemoryTimestamp;
	readonly createId?: () => string;
	readonly scope?: MemoryScope;
	readonly type?: string;
}

interface ParseMemoryEntryOptions {
	readonly scope?: MemoryScope;
	readonly defaultType?: string;
}

interface ParseMemoryEntriesResult {
	readonly entries: MemoryEntry[];
	readonly migrated: boolean;
}

export interface MemoryBucketSnapshot {
	readonly bucket: MemoryScope;
	readonly path: string;
	readonly entries: readonly string[];
	readonly chars: number;
	readonly limitChars: number;
	readonly usagePercent: number;
}

export interface MemoryBucketEntriesSnapshot {
	readonly bucket: MemoryScope;
	readonly path: string;
	readonly entries: readonly MemoryEntry[];
	readonly chars: number;
	readonly limitChars: number;
	readonly usagePercent: number;
}

export interface MemorySnapshot {
	readonly project: MemoryBucketSnapshot;
	readonly global: MemoryBucketSnapshot;
	readonly user: MemoryBucketSnapshot;
}

export interface MemoryEntriesSnapshot {
	readonly project: MemoryBucketEntriesSnapshot;
	readonly global: MemoryBucketEntriesSnapshot;
	readonly user: MemoryBucketEntriesSnapshot;
}

interface MemoryIndexEntry {
	readonly id: MemoryEntryId;
	readonly scope: MemoryScope;
	readonly type: string;
	readonly summary: string;
}

export interface MemoryRepairIssue {
	readonly id: MemoryEntryId;
	readonly scope: MemoryScope;
	readonly summary: string;
	readonly content: string;
	readonly reason: "summary_matches_content";
}

export interface MemoryIndex {
	readonly project: readonly MemoryIndexEntry[];
	readonly global: readonly MemoryIndexEntry[];
	readonly user: readonly MemoryIndexEntry[];
}

export const ENTRY_DELIMITER = "\n§\n";

const decodeMemoryEntry = Schema.decodeUnknownSync(MemoryEntry);
const encodeMemoryEntry = Schema.encodeUnknownSync(MemoryEntry);

export function normalizeMemoryContent(value: string): string {
	return value.replace(/\r\n?/gu, "\n").trim();
}

function normalizeMemoryType(value: string): string {
	return value.trim().toLowerCase();
}

export function normalizeMemorySummary(value: string): string {
	const normalized = normalizeMemoryContent(value)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join(" ");

	if (normalized.length <= SUMMARY_MAX_CHARS) {
		return normalized;
	}

	return `${normalized.slice(0, Math.max(0, SUMMARY_MAX_CHARS - 1)).trimEnd()}…`;
}

function summarizeMemoryContent(content: string): string {
	return normalizeMemorySummary(content);
}

export function memorySummaryMatchesContent(summary: string, content: string): boolean {
	return normalizeMemorySummary(summary) === summarizeMemoryContent(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function readScope(record: Record<string, unknown>): MemoryScope | undefined {
	const value = record["scope"];
	if (value === "project" || value === "global" || value === "user") {
		return value;
	}
	return undefined;
}

function resolveScope(
	parsedScope: MemoryScope | undefined,
	requestedScope: MemoryScope | undefined,
): MemoryScope {
	return requestedScope ?? parsedScope ?? DEFAULT_SCOPE;
}

function normalizeParsedMemoryEntry(
	value: unknown,
	options: ParseMemoryEntryOptions,
): { readonly candidate: unknown; readonly migrated: boolean } {
	if (!isRecord(value)) {
		return { candidate: value, migrated: false };
	}

	const sourceContent = readString(value, "content");
	const normalizedContent = normalizeMemoryContent(sourceContent ?? "");
	const parsedScope = readScope(value);
	const scope = resolveScope(parsedScope, options.scope);
	const sourceType = readString(value, "type");
	const type = normalizeMemoryType(sourceType ?? options.defaultType ?? DEFAULT_TYPE);
	const sourceSummary = readString(value, "summary");
	const summary = normalizeMemorySummary(sourceSummary ?? summarizeMemoryContent(normalizedContent));

	const migrated =
		!("scope" in value) ||
		!("type" in value) ||
		!("summary" in value) ||
		parsedScope !== scope ||
		sourceType === undefined ||
		normalizeMemoryType(sourceType) !== type ||
		sourceSummary === undefined ||
		normalizeMemorySummary(sourceSummary) !== summary ||
		sourceContent === undefined ||
		normalizeMemoryContent(sourceContent) !== normalizedContent;

	const candidate = {
		id: value["id"],
		scope,
		type,
		summary,
		content: normalizedContent,
		createdAt: value["createdAt"],
		updatedAt: value["updatedAt"],
	};

	return { candidate, migrated };
}

function formatTimestamp(value: MemoryTimestamp): string {
	return DateTime.formatIso(value);
}

function buildMemoryEntryCandidate(
	content: string,
	options: LegacyCreateMemoryEntryOptions,
	deriveSummary: boolean,
): MemoryEntryJson {
	const createdAt = options.createdAt ?? options.now ?? DateTime.nowUnsafe();
	const updatedAt = options.updatedAt ?? createdAt;
	const normalizedContent = normalizeMemoryContent(content);
	const normalizedType = normalizeMemoryType(options.type ?? DEFAULT_TYPE);
	const resolvedSummary = deriveSummary
		? options.summary ?? summarizeMemoryContent(normalizedContent)
		: options.summary;

	if (resolvedSummary === undefined) {
		throw new Error("memory summary is required");
	}

	return {
		id: options.id ?? nanoid(ID_SIZE),
		scope: options.scope ?? DEFAULT_SCOPE,
		type: normalizedType,
		summary: normalizeMemorySummary(resolvedSummary),
		content: normalizedContent,
		createdAt: formatTimestamp(createdAt),
		updatedAt: formatTimestamp(updatedAt),
	};
}

export function createMemoryEntry(
	content: string,
	options: CreateMemoryEntryOptions,
): MemoryEntry {
	const candidate = buildMemoryEntryCandidate(content, options, false);
	if (memorySummaryMatchesContent(candidate.summary, candidate.content)) {
		throw new Error("memory summary must not duplicate full content");
	}
	return decodeMemoryEntry(candidate);
}

function createLegacyMemoryEntry(
	content: string,
	options: LegacyCreateMemoryEntryOptions = {},
): MemoryEntry {
	return decodeMemoryEntry(buildMemoryEntryCandidate(content, options, true));
}

export function cloneMemoryEntry(
	entry: MemoryEntry,
	overrides: Partial<MemoryEntryJson> = {},
): MemoryEntry {
	return decodeMemoryEntry({
		...encodeMemoryEntry(entry),
		...overrides,
	});
}

function serializeMemoryEntry(entry: MemoryEntry): string {
	return JSON.stringify(encodeMemoryEntry(entry));
}

export function serializeMemoryEntries(entries: readonly MemoryEntry[]): string {
	return entries.map(serializeMemoryEntry).join("\n");
}

function parseMemoryEntry(line: string): MemoryEntry {
	return parseMemoryEntryWithMigration(line).entry;
}

function parseMemoryEntryWithMigration(
	line: string,
	options: ParseMemoryEntryOptions = {},
): { readonly entry: MemoryEntry; readonly migrated: boolean } {
	const trimmed = line.trim();
	if (!trimmed) {
		throw new Error("Cannot parse an empty JSONL memory entry");
	}

	const parsed = JSON.parse(trimmed) as unknown;
	const normalized = normalizeParsedMemoryEntry(parsed, options);
	return {
		entry: decodeMemoryEntry(normalized.candidate),
		migrated: normalized.migrated,
	};
}

export function parseMemoryEntriesWithMigration(
	raw: string,
	options: ParseMemoryEntryOptions = {},
): ParseMemoryEntriesResult {
	if (!raw.trim()) {
		return { entries: [], migrated: false };
	}

	let migrated = false;
	const entries = raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const parsed = parseMemoryEntryWithMigration(line, options);
			if (parsed.migrated) {
				migrated = true;
			}
			return parsed.entry;
		});

	return { entries, migrated };
}

export function parseMemoryEntries(
	raw: string,
	options: ParseMemoryEntryOptions = {},
): MemoryEntry[] {
	return parseMemoryEntriesWithMigration(raw, options).entries;
}

export function migrateLegacyEntries(
	raw: string,
	options: LegacyMemoryMigrationOptions = {},
): MemoryEntry[] {
	const timestamp = options.now ?? DateTime.nowUnsafe();

	return parseEntries(raw).map((content) =>
		createLegacyMemoryEntry(content, {
			createdAt: timestamp,
			updatedAt: timestamp,
			...(options.scope !== undefined ? { scope: options.scope } : {}),
			...(options.type !== undefined ? { type: options.type } : {}),
			...(options.createId ? { id: options.createId() } : {}),
		}),
	);
}

export function migrateLegacyMarkdownToJsonl(
	raw: string,
	options: LegacyMemoryMigrationOptions = {},
): string {
	return serializeMemoryEntries(migrateLegacyEntries(raw, options));
}

export function parseEntries(raw: string): string[] {
	if (!raw.trim()) {
		return [];
	}

	return raw
		.split(ENTRY_DELIMITER)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export function joinEntries(entries: readonly string[]): string {
	return entries.join(ENTRY_DELIMITER);
}

export function charCount(entries: readonly string[]): number {
	return joinEntries(entries).length;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function bucketTag(bucket: MemoryScope): string {
	return `${bucket}_memory`;
}

function snapshotBuckets(snapshot: MemorySnapshot): readonly MemoryBucketSnapshot[] {
	return [snapshot.project, snapshot.global, snapshot.user];
}

function renderBucketXml(bucket: MemoryBucketSnapshot): string {
	const lines = [
		`<${bucketTag(bucket.bucket)} path="${escapeXml(bucket.path)}" entries="${bucket.entries.length}" chars="${bucket.chars}" limit="${bucket.limitChars}" usage_percent="${bucket.usagePercent}">`,
	];
	const content = joinEntries(bucket.entries);
	if (content.length > 0) {
		lines.push(escapeXml(content));
	}
	lines.push(`</${bucketTag(bucket.bucket)}>`);
	return lines.join("\n");
}

export function renderMemorySnapshotXml(
	snapshot: MemorySnapshot,
	options: { readonly includeEmpty?: boolean } = {},
): string {
	const includeEmpty = options.includeEmpty ?? false;
	const buckets = snapshotBuckets(snapshot).filter((bucket) => includeEmpty || bucket.entries.length > 0);
	if (buckets.length === 0) {
		return "";
	}

	return ["<memory_snapshot>", ...buckets.map(renderBucketXml), "</memory_snapshot>"].join("\n");
}

function renderIndexEntryXml(entry: MemoryIndexEntry): string {
	return `  <entry id="${escapeXml(entry.id)}" scope="${entry.scope}" type="${escapeXml(entry.type)}">${escapeXml(entry.summary)}</entry>`;
}

function renderBucketIndexXml(bucket: MemoryScope, entries: readonly MemoryIndexEntry[]): string {
	if (entries.length === 0) {
		return "";
	}
	const lines = [`<${bucketTag(bucket)}>`];
	for (const entry of entries) {
		lines.push(renderIndexEntryXml(entry));
	}
	lines.push(`</${bucketTag(bucket)}>`);
	return lines.join("\n");
}

export function renderMemoryIndexXml(index: MemoryIndex): string {
	const project = renderBucketIndexXml("project", index.project);
	const global = renderBucketIndexXml("global", index.global);
	const user = renderBucketIndexXml("user", index.user);

	const parts = [project, global, user].filter((part) => part.length > 0);
	if (parts.length === 0) {
		return "";
	}

	return ["<memory_index>", ...parts, "</memory_index>"].join("\n");
}

function indexEntries(entries: readonly MemoryEntry[]): readonly MemoryIndexEntry[] {
	return entries.flatMap((entry) =>
		memorySummaryMatchesContent(entry.summary, entry.content)
			? []
			: [
				{
					id: entry.id,
					scope: entry.scope,
					type: entry.type,
					summary: entry.summary,
				},
			],
	);
}

export function makeMemoryIndex(snapshot: MemoryEntriesSnapshot): MemoryIndex {
	return {
		project: indexEntries(snapshot.project.entries),
		global: indexEntries(snapshot.global.entries),
		user: indexEntries(snapshot.user.entries),
	};
}

export function findMemoryRepairIssues(snapshot: MemoryEntriesSnapshot): readonly MemoryRepairIssue[] {
	return [snapshot.project, snapshot.global, snapshot.user].flatMap((bucket) =>
		bucket.entries.flatMap((entry) =>
			memorySummaryMatchesContent(entry.summary, entry.content)
				? [
					{
						id: entry.id,
						scope: entry.scope,
						summary: entry.summary,
						content: entry.content,
						reason: "summary_matches_content" as const,
					},
				]
				: [],
		),
	);
}
