import { Data, Effect, Layer, ManagedRuntime, Schema, Context } from "effect";
import {
	getMarkdownTheme,
	type ExtensionAPI,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { defineDecodedTool, textToolResult } from "../shared/decoded-tool.js";

// =============================================================================
// Errors
// =============================================================================

class ExaApiError extends Data.TaggedError("ExaApiError")<{
	readonly message: string;
	readonly status: number;
	readonly details: unknown;
}> {}

class ExaConfigError extends Data.TaggedError("ExaConfigError")<{
	readonly message: string;
}> {}

// =============================================================================
// Schemas - using plain optional fields for simplicity
// =============================================================================

// Helper to handle API returning null or undefined for optional fields
// Accepts string | null | undefined - treat null as undefined at usage
const OptionalString = Schema.optional(Schema.Union([Schema.String, Schema.Null]));
const OptionalNumber = Schema.optional(Schema.Union([Schema.Number, Schema.Null]));
const OptionalArray = <S extends Schema.Top>(schema: S) =>
	Schema.optional(Schema.Union([Schema.Array(schema), Schema.Null]));

const ExaSearchResult = Schema.Struct({
	id: OptionalString,
	url: OptionalString,
	title: OptionalString,
	score: OptionalNumber,
	publishedDate: OptionalString,
	author: OptionalString,
	text: OptionalString,
	highlights: OptionalArray(Schema.String),
});
type ExaSearchResult = Schema.Schema.Type<typeof ExaSearchResult>;

const ExaSearchResponse = Schema.Struct({
	requestId: OptionalString,
	results: Schema.Array(ExaSearchResult),
	resolvedSearchType: OptionalString,
	context: OptionalString,
	searchTime: OptionalNumber,
	costDollars: Schema.optional(Schema.Unknown),
});
type ExaSearchResponse = Schema.Schema.Type<typeof ExaSearchResponse>;

const ExaContentsResult = Schema.Struct({
	id: OptionalString,
	url: OptionalString,
	title: OptionalString,
	author: OptionalString,
	publishedDate: OptionalString,
	text: OptionalString,
	highlights: OptionalArray(Schema.String),
	highlightScores: OptionalArray(Schema.Number),
	summary: OptionalString,
	subpages: OptionalArray(Schema.Unknown),
	extras: Schema.optional(Schema.Unknown),
});
type ExaContentsResult = Schema.Schema.Type<typeof ExaContentsResult>;

const ExaContentsResponse = Schema.Struct({
	requestId: OptionalString,
	results: Schema.Array(ExaContentsResult),
	context: OptionalString,
	statuses: OptionalArray(Schema.Unknown),
	costDollars: Schema.optional(Schema.Unknown),
});
type ExaContentsResponse = Schema.Schema.Type<typeof ExaContentsResponse>;

const ExaContextResponse = Schema.Struct({
	requestId: OptionalString,
	query: OptionalString,
	response: OptionalString,
	resultsCount: OptionalNumber,
	costDollars: Schema.optional(Schema.Unknown),
	searchTime: OptionalNumber,
	outputTokens: OptionalNumber,
});
type ExaContextResponse = Schema.Schema.Type<typeof ExaContextResponse>;

// =============================================================================
// Config
// =============================================================================

interface ExaConfig {
	readonly baseUrl: string;
	readonly apiKey: string;
}

class ExaConfigService extends Context.Service<ExaConfigService, ExaConfig>()("ExaConfigService") {}

const ExaConfigLive = Layer.effect(
	ExaConfigService,
	Effect.gen(function* () {
		const apiKey = process.env["EXA_API_KEY"]?.trim();
		if (!apiKey) {
			return yield* new ExaConfigError({
				message:
					"EXA_API_KEY is not set. Set it in your environment before using Exa tools (e.g. export EXA_API_KEY=...).",
			});
		}
		const baseUrl = (process.env["EXA_API_BASE_URL"] ?? "https://api.exa.ai").replace(
			/\/+$/,
			"",
		);
		return {
			baseUrl,
			apiKey,
		} satisfies ExaConfig;
	}),
);

const exaRuntime = ManagedRuntime.make(ExaConfigLive);

const runExaEffect = <A, E>(effect: Effect.Effect<A, E, ExaConfigService>): Promise<A> =>
	exaRuntime.runPromise(effect);

// =============================================================================
// API Client
// =============================================================================

const exaPost = <S extends Schema.Decoder<unknown>>(
	path: string,
	body: unknown,
	schema: S,
	signal: AbortSignal | undefined,
): Effect.Effect<S["Type"], ExaApiError | ExaConfigError, ExaConfigService> =>

	Effect.gen(function* () {
		const config = yield* ExaConfigService;
		const url = `${config.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;

		const res = yield* Effect.tryPromise({
			try: () =>
				fetch(url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-api-key": config.apiKey,
						authorization: `Bearer ${config.apiKey}`,
					},
					body: JSON.stringify(body),
					signal: signal ?? null,
				}),
			catch: (error): ExaApiError =>
				new ExaApiError({
					message: error instanceof Error ? error.message : String(error),
					status: 0,
					details: error,
				}),
		});

		if (!res.ok) {
			const text = yield* Effect.tryPromise(() => res.text()).pipe(
				Effect.orElseSucceed(() => "(could not read response body)"),
			);
			return yield* new ExaApiError({
				message: `Exa API error (${res.status} ${res.statusText}): ${text}`,
				status: res.status,
				details: text,
			});
		}

		const json = yield* Effect.tryPromise({
			try: () => res.json(),
			catch: (error): ExaApiError =>
				new ExaApiError({
					message: `Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}`,
					status: res.status,
					details: error,
				}),
		});

		return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
			Effect.mapError(
				(parseError) =>
					new ExaApiError({
						message: `Failed to decode response: ${String(parseError)}`,
						status: res.status,
						details: parseError,
					}),
			),
		);
	});

// =============================================================================
// Service Interface
// =============================================================================

interface ExaService {
	readonly search: (
		params: WebSearchParams,
		signal: AbortSignal | undefined,
	) => Effect.Effect<ExaSearchResponse, ExaApiError | ExaConfigError, ExaConfigService>;
	readonly crawl: (
		params: CrawlingParams,
		signal: AbortSignal | undefined,
	) => Effect.Effect<ExaContentsResponse, ExaApiError | ExaConfigError, ExaConfigService>;
	readonly codeContext: (
		params: CodeContextParams,
		signal: AbortSignal | undefined,
	) => Effect.Effect<ExaContextResponse, ExaApiError | ExaConfigError, ExaConfigService>;
}

// =============================================================================
// Helpers
// =============================================================================

const MAX_TEXT_CHARS = 2000;
const MAX_HIGHLIGHTS = 5;
const MAX_HIGHLIGHT_CHARS = 240;

const truncate = (s: string, max: number): string =>
	s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

const compactSearchResults = (results: ReadonlyArray<ExaSearchResult>): Array<ExaSearchResult> =>
	results.map((r) => ({
		...r,
		text: r.text != null ? truncate(r.text, MAX_TEXT_CHARS) : undefined,
		highlights:
			r.highlights != null
				? r.highlights
						.slice(0, MAX_HIGHLIGHTS)
						.map((h) => truncate(oneLine(h), MAX_HIGHLIGHT_CHARS))
				: undefined,
	}));

const compactContentsResults = (
	results: ReadonlyArray<ExaContentsResult>,
): Array<ExaContentsResult> =>
	results.map((r) => ({
		...r,
		summary: r.summary != null ? truncate(oneLine(r.summary), 2000) : undefined,
		text: r.text != null ? truncate(r.text, 6000) : undefined,
		highlights:
			r.highlights != null
				? r.highlights.slice(0, 8).map((h) => truncate(oneLine(h), MAX_HIGHLIGHT_CHARS))
				: undefined,
	}));

// =============================================================================
// Search
// =============================================================================

interface WebSearchParams {
	readonly query: string;
	readonly type?: "auto" | "neural" | "fast" | "deep" | undefined;
	readonly additionalQueries?: ReadonlyArray<string> | undefined;
	readonly category?: string | undefined;
	readonly userLocation?: string | undefined;
	readonly numResults?: number | undefined;
	readonly text?: boolean | undefined;
	readonly context?: boolean | undefined;
	readonly includeDomains?: ReadonlyArray<string> | undefined;
	readonly excludeDomains?: ReadonlyArray<string> | undefined;
	readonly startCrawlDate?: string | undefined;
	readonly endCrawlDate?: string | undefined;
	readonly startPublishedDate?: string | undefined;
	readonly endPublishedDate?: string | undefined;
	readonly includeText?: ReadonlyArray<string> | undefined;
	readonly excludeText?: ReadonlyArray<string> | undefined;
	readonly moderation?: boolean | undefined;
}

const makeSearchBody = (params: WebSearchParams): Record<string, unknown> => {
	const body: Record<string, unknown> = { query: params.query };
	if (params.type !== undefined) body["type"] = params.type;
	if (params.additionalQueries !== undefined && params.additionalQueries.length > 0)
		body["additionalQueries"] = params.additionalQueries;
	if (params.category !== undefined) body["category"] = params.category;
	if (params.userLocation !== undefined) body["userLocation"] = params.userLocation;
	if (params.numResults !== undefined) body["numResults"] = params.numResults;
	if (params.text !== undefined) body["text"] = params.text;
	if (params.context !== undefined) body["context"] = params.context;
	if (params.includeDomains !== undefined && params.includeDomains.length > 0)
		body["includeDomains"] = params.includeDomains;
	if (params.excludeDomains !== undefined && params.excludeDomains.length > 0)
		body["excludeDomains"] = params.excludeDomains;
	if (params.startCrawlDate !== undefined) body["startCrawlDate"] = params.startCrawlDate;
	if (params.endCrawlDate !== undefined) body["endCrawlDate"] = params.endCrawlDate;
	if (params.startPublishedDate !== undefined)
		body["startPublishedDate"] = params.startPublishedDate;
	if (params.endPublishedDate !== undefined) body["endPublishedDate"] = params.endPublishedDate;
	if (params.includeText !== undefined && params.includeText.length > 0)
		body["includeText"] = params.includeText;
	if (params.excludeText !== undefined && params.excludeText.length > 0)
		body["excludeText"] = params.excludeText;
	if (params.moderation !== undefined) body["moderation"] = params.moderation;
	return body;
};

// =============================================================================
// Crawl
// =============================================================================

interface CrawlingParams {
	readonly urls: ReadonlyArray<string>;
	readonly text?: boolean | undefined;
	readonly highlights?: boolean | undefined;
	readonly summary?: boolean | undefined;
	readonly context?: boolean | undefined;
	readonly livecrawl?: "never" | "fallback" | "preferred" | "always" | undefined;
	readonly livecrawlTimeout?: number | undefined;
	readonly subpages?: number | undefined;
	readonly subpageTarget?: ReadonlyArray<string> | undefined;
}

const makeCrawlBody = (params: CrawlingParams): Record<string, unknown> => {
	const body: Record<string, unknown> = {
		urls: params.urls,
		text: params.text ?? true,
	};
	if (params.context !== undefined) body["context"] = params.context;
	if (params.highlights !== undefined) body["highlights"] = params.highlights;
	if (params.summary !== undefined) body["summary"] = params.summary;
	if (params.livecrawl !== undefined) body["livecrawl"] = params.livecrawl;
	if (params.livecrawlTimeout !== undefined) body["livecrawlTimeout"] = params.livecrawlTimeout;
	if (params.subpages !== undefined) body["subpages"] = params.subpages;
	if (params.subpageTarget !== undefined && params.subpageTarget.length > 0)
		body["subpageTarget"] = params.subpageTarget;
	return body;
};

// =============================================================================
// Code Context
// =============================================================================

interface CodeContextParams {
	readonly query: string;
	readonly tokensNum?: "dynamic" | string | undefined;
}

const makeCodeContextBody = (params: CodeContextParams): Record<string, unknown> => {
	const body: Record<string, unknown> = { query: params.query };
	const tokensNum = params.tokensNum;
	if (tokensNum === undefined || tokensNum === "dynamic") {
		body["tokensNum"] = "dynamic";
	} else if (/^\d+$/.test(tokensNum)) {
		const n = Number(tokensNum);
		if (Number.isFinite(n) && n >= 50 && n <= 100000) {
			body["tokensNum"] = n;
		} else {
			body["tokensNum"] = "dynamic";
		}
	} else {
		body["tokensNum"] = "dynamic";
	}
	return body;
};

// =============================================================================
// Live Implementation
// =============================================================================

const ExaServiceLive: ExaService = {
	search: (params, signal) =>
		Effect.gen(function* () {
			const body = makeSearchBody(params);
			const response = yield* exaPost("/search", body, ExaSearchResponse, signal);
			return {
				...response,
				results: compactSearchResults(response.results),
			};
		}),

	crawl: (params, signal) =>
		Effect.gen(function* () {
			if (params.urls.length === 0) {
				return yield* new ExaApiError({
					message: "crawling_exa requires at least one url",
					status: 400,
					details: null,
				});
			}
			const body = makeCrawlBody(params);
			const response = yield* exaPost("/contents", body, ExaContentsResponse, signal);
			return {
				...response,
				results: compactContentsResults(response.results),
			};
		}),

	codeContext: (params, signal) =>
		Effect.gen(function* () {
			const body = makeCodeContextBody(params);
			return yield* exaPost("/context", body, ExaContextResponse, signal);
		}),
};

// =============================================================================
// TypeBox Parameters (for LLM tool interface - SDK requirement)
// =============================================================================

const WebSearchTypeBox = Type.Object({
	query: Type.String({
		description: "The query string for the search.",
		minLength: 1,
		maxLength: 2000,
	}),
	type: Type.Optional(
		Type.Union(
			[
				Type.Literal("auto"),
				Type.Literal("neural"),
				Type.Literal("fast"),
				Type.Literal("deep"),
			],
			{
				description: "Search type. Options: auto (default), neural, fast, deep.",
			},
		),
	),
	additionalQueries: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Additional query variations for deep search (only works with type=deep).",
		}),
	),
	category: Type.Optional(
		Type.String({
			description:
				"Optional category filter. Common options include: company, research paper, news, pdf, github, tweet, personal site, financial report, people.",
		}),
	),
	userLocation: Type.Optional(
		Type.String({
			description: "Two-letter ISO country code of the user (e.g. 'US').",
			minLength: 2,
			maxLength: 2,
		}),
	),
	numResults: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 100,
			description: "Number of results to return (default 10; max 100 depending on type).",
		}),
	),
	text: Type.Optional(
		Type.Boolean({
			description:
				"If true, include extracted text snippets in each result (can be large). Best practice: leave off unless needed; use exa.crawl for full text.",
		}),
	),
	context: Type.Optional(
		Type.Boolean({
			description:
				"If true, also return a combined context string for LLM/RAG usage (can be large).",
		}),
	),
	includeDomains: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Only return results from these domains.",
		}),
	),
	excludeDomains: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Exclude results from these domains.",
		}),
	),
	startCrawlDate: Type.Optional(
		Type.String({
			description:
				"Only include links crawled after this ISO 8601 date-time (e.g. 2023-01-01T00:00:00.000Z).",
		}),
	),
	endCrawlDate: Type.Optional(
		Type.String({
			description: "Only include links crawled before this ISO 8601 date-time.",
		}),
	),
	startPublishedDate: Type.Optional(
		Type.String({
			description:
				"Only include links published after this ISO 8601 date-time (e.g. 2023-01-01T00:00:00.000Z).",
		}),
	),
	endPublishedDate: Type.Optional(
		Type.String({
			description: "Only include links published before this ISO 8601 date-time.",
		}),
	),
	includeText: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Strings that must be present in the result page text (Exa currently supports 1 string of up to ~5 words).",
		}),
	),
	excludeText: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Strings that must NOT be present in the result page text (Exa currently supports 1 string of up to ~5 words).",
		}),
	),
	moderation: Type.Optional(
		Type.Boolean({ description: "Enable content moderation to filter unsafe content." }),
	),
});

const CrawlingTypeBox = Type.Object({
	urls: Type.Array(Type.String({ minLength: 1 }), {
		description: "URLs to fetch.",
		minItems: 1,
	}),
	text: Type.Optional(
		Type.Boolean({
			description:
				"If true, return extracted page text (can be large). If false, disable text.",
		}),
	),
	highlights: Type.Optional(
		Type.Boolean({
			description: "If true, include default highlights (relevant snippets) for each page.",
		}),
	),
	summary: Type.Optional(
		Type.Boolean({ description: "If true, include a default summary for each page." }),
	),
	context: Type.Optional(
		Type.Boolean({
			description:
				"If true, include a combined context string (often useful for RAG, but can be very large).",
		}),
	),
	livecrawl: Type.Optional(
		Type.Union(
			[
				Type.Literal("never"),
				Type.Literal("fallback"),
				Type.Literal("preferred"),
				Type.Literal("always"),
			],
			{
				description:
					"Livecrawl mode: never (default), fallback, preferred, always. Use 'always' only if you cannot tolerate cached content.",
			},
		),
	),
	livecrawlTimeout: Type.Optional(
		Type.Integer({
			description: "Livecrawl timeout in milliseconds (default 10000).",
			minimum: 1,
		}),
	),
	subpages: Type.Optional(
		Type.Integer({
			description: "Number of subpages to crawl (default 0).",
			minimum: 0,
		}),
	),
	subpageTarget: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description:
				"Keywords to target specific subpages. Exa also accepts a single string; here pass a one-element array.",
		}),
	),
});

const CodeContextTypeBox = Type.Object({
	query: Type.String({
		description: "Search query to find relevant code snippets.",
		minLength: 1,
		maxLength: 2000,
	}),
	tokensNum: Type.Optional(
		Type.String({
			description:
				"Optional. Defaults to 'dynamic' (recommended). Use 'dynamic' or an integer between 50 and 100000 (as a string).",
		}),
	),
});

function decodeWebSearchParams(rawParams: unknown): WebSearchParams {
	return Value.Parse(WebSearchTypeBox, rawParams);
}

function decodeCrawlingParams(rawParams: unknown): CrawlingParams {
	return Value.Parse(CrawlingTypeBox, rawParams);
}

function decodeCodeContextParams(rawParams: unknown): CodeContextParams {
	return Value.Parse(CodeContextTypeBox, rawParams);
}

// =============================================================================
// Rendering Helpers
// =============================================================================

const truncateValue = (v: unknown): string => {
	if (v === undefined) return "(default)";
	if (v === null) return "null";
	if (typeof v === "string") return JSON.stringify(v);
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (Array.isArray(v)) {
		return `[${v
			.slice(0, 4)
			.map((x) => truncateValue(x))
			.join(", ")}${v.length > 4 ? ", …" : ""}]`;
	}
	if (typeof v === "object") return "{…}";
	return String(v);
};

const renderSearchCall = (args: unknown, theme: Theme): string => {
	const typedArgs = args as WebSearchParams;
	const query = typedArgs.query ?? "";
	let out = theme.fg("toolTitle", theme.bold("exa.web_search"));
	if (query) out += ` ${theme.fg("toolOutput", truncate(oneLine(query), 140))}`;

	const extras: Array<[string, unknown]> = [
		["type", typedArgs.type],
		["category", typedArgs.category],
		["userLocation", typedArgs.userLocation],
		["numResults", typedArgs.numResults],
		["text", typedArgs.text],
		["context", typedArgs.context],
		["includeDomains", typedArgs.includeDomains],
		["excludeDomains", typedArgs.excludeDomains],
		["startCrawlDate", typedArgs.startCrawlDate],
		["endCrawlDate", typedArgs.endCrawlDate],
		["startPublishedDate", typedArgs.startPublishedDate],
		["endPublishedDate", typedArgs.endPublishedDate],
		["includeText", typedArgs.includeText],
		["excludeText", typedArgs.excludeText],
		["moderation", typedArgs.moderation],
	];

	for (const [k, v] of extras) {
		if (v === undefined) continue;
		out += `\n${theme.fg("muted", k + ":")} ${theme.fg("dim", truncateValue(v))}`;
	}
	return out;
};

const renderCrawlCall = (args: unknown, theme: Theme): string => {
	const typedArgs = args as CrawlingParams;
	let out = theme.fg("toolTitle", theme.bold("exa.crawl"));
	const urls = typedArgs.urls ?? [];
	if (urls.length > 0) out += ` ${theme.fg("dim", truncateValue(urls))}`;

	const extras: Array<[string, unknown]> = [
		["text", typedArgs.text],
		["highlights", typedArgs.highlights],
		["summary", typedArgs.summary],
		["context", typedArgs.context],
		["livecrawl", typedArgs.livecrawl],
		["livecrawlTimeout", typedArgs.livecrawlTimeout],
		["subpages", typedArgs.subpages],
		["subpageTarget", typedArgs.subpageTarget],
	];

	for (const [k, v] of extras) {
		if (v === undefined) continue;
		out += `\n${theme.fg("muted", k + ":")} ${theme.fg("dim", truncateValue(v))}`;
	}
	return out;
};

const renderCodeContextCall = (args: unknown, theme: Theme): string => {
	const typedArgs = args as CodeContextParams;
	let out = theme.fg("toolTitle", theme.bold("exa.code_context"));
	const query = typedArgs.query ?? "";
	if (query) out += ` ${theme.fg("toolOutput", truncate(oneLine(query), 140))}`;

	const tokensNum = typedArgs.tokensNum;
	if (typeof tokensNum === "string" && tokensNum.trim().length > 0) {
		out += `\n${theme.fg("muted", "tokensNum:")} ${theme.fg("dim", truncateValue(tokensNum.trim()))}`;
	}
	return out;
};

const formatSearchResultText = (r: ExaSearchResult, index: number): string => {
	const title = r.title ?? r.url ?? "(no title)";
	const url = r.url ?? "(no url)";
	let out = `[${index + 1}] ${title}\nURL: ${url}`;

	if (r.publishedDate != null) out += `\nPublished: ${r.publishedDate}`;
	if (r.author != null) out += `\nAuthor: ${r.author}`;
	if (r.text != null) out += `\nSnippet: ${r.text}`;
	if (r.highlights != null && r.highlights.length > 0) {
		out += `\nHighlights: ${r.highlights.join(" | ")}`;
	}
	return out;
};

const formatCrawlResultText = (r: ExaContentsResult, index: number): string => {
	const title = r.title ?? r.url ?? "(no title)";
	const url = r.url ?? "(no url)";
	let out = `[${index + 1}] ${title}\nURL: ${url}`;

	if (r.summary != null) out += `\nSummary: ${r.summary}`;
	if (r.text != null) out += `\nContent: ${r.text}`;
	if (r.highlights != null && r.highlights.length > 0) {
		out += `\nHighlights: ${r.highlights.join(" | ")}`;
	}
	return out;
};

const renderSearchResult = (result: ExaSearchResponse, expanded: boolean, theme: Theme): string => {
	const results = result.results;
	const shown = expanded ? results : results.slice(0, 3);

	const separator =
		"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
	let out = theme.fg("dim", separator);

	if (result.requestId != null || result.resolvedSearchType != null) {
		if (result.requestId != null)
			out += `\n${theme.fg("muted", "requestId:")} ${theme.fg("dim", String(result.requestId))}`;
		if (result.resolvedSearchType != null)
			out += `\n${theme.fg("muted", "resolvedSearchType:")} ${theme.fg("dim", String(result.resolvedSearchType))}`;
	}

	for (let i = 0; i < shown.length; i++) {
		const r = shown[i]!;
		const title = r.title ?? r.url ?? "(no title)";
		out += `\n\n  ${theme.fg("accent", theme.bold(String(i + 1) + "."))} ${theme.fg("toolOutput", truncate(oneLine(title), 160))}`;

		if (r.url != null) out += `\n     ${theme.fg("dim", r.url)}`;

		const meta: string[] = [];
		if (r.author != null) meta.push(r.author);
		if (r.publishedDate != null) meta.push(r.publishedDate);
		if (typeof r.score === "number") meta.push(`score ${r.score.toFixed(3)}`);
		if (meta.length > 0) out += `\n     ${theme.fg("muted", meta.join(" · "))}`;

		const snippetSource = r.text ?? (r.highlights != null ? r.highlights.join(" \n") : "");
		const snippet = snippetSource ? truncate(oneLine(snippetSource), expanded ? 400 : 200) : "";
		if (snippet) out += `\n     ${theme.fg("toolOutput", snippet)}`;
	}

	if (!expanded && results.length > shown.length) {
		out += `\n\n  ${theme.fg("dim", `… ${results.length - shown.length} more (expand to view)`)}`;
	}
	if (shown.length === 0) out += `\n  ${theme.fg("dim", "(no results)")}`;

	return out;
};

const renderCrawlResult = (
	result: ExaContentsResponse,
	expanded: boolean,
	theme: Theme,
): string => {
	const results = result.results;
	const shown = expanded ? results : results.slice(0, 2);

	const separator =
		"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
	let out = theme.fg("dim", separator);

	if (result.requestId != null)
		out += `\n${theme.fg("muted", "requestId:")} ${theme.fg("dim", String(result.requestId))}`;

	for (let i = 0; i < shown.length; i++) {
		const r = shown[i]!;
		const title = r.title ?? r.url ?? r.id ?? "(no title)";
		out += `\n\n  ${theme.fg("accent", theme.bold(String(i + 1) + "."))} ${theme.fg("toolOutput", truncate(oneLine(title), 160))}`;

		if (r.url != null) out += `\n     ${theme.fg("dim", r.url)}`;

		const meta: string[] = [];
		if (r.author != null) meta.push(r.author);
		if (r.publishedDate != null) meta.push(r.publishedDate);
		if (meta.length > 0) out += `\n     ${theme.fg("muted", meta.join(" · "))}`;

		if (typeof r.summary === "string" && r.summary.trim().length > 0) {
			out += `\n     ${theme.fg("muted", "summary:")} ${theme.fg("toolOutput", truncate(oneLine(r.summary), expanded ? 400 : 200))}`;
		}

		if (typeof r.text === "string" && r.text.trim().length > 0) {
			out += `\n     ${theme.fg("muted", "text:")} ${theme.fg("dim", truncate(oneLine(r.text), expanded ? 260 : 120))}`;
		}

		if (r.highlights != null && r.highlights.length > 0) {
			out += `\n     ${theme.fg("muted", `highlights: ${r.highlights.length}`)}`;
		}
	}

	if (!expanded && results.length > shown.length) {
		out += `\n\n  ${theme.fg("dim", `… ${results.length - shown.length} more (expand to view)`)}`;
	}
	if (shown.length === 0) out += `\n  ${theme.fg("dim", "(no results)")}`;

	return out;
};

const renderCodeContextResult = (
	result: ExaContextResponse,
	expanded: boolean,
	theme: Theme,
): string => {
	const responseText = result.response ?? "";
	if (!responseText) return theme.fg("dim", "(no response)");

	const separator =
		"━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";
	if (expanded) {
		return `${theme.fg("dim", separator)}\n${responseText}`;
	}

	const lines = responseText.split("\n");
	const head = lines.slice(0, 20).join("\n");
	let out = `${theme.fg("dim", separator)}\n${theme.fg("toolOutput", head)}`;
	if (lines.length > 20) out += `\n\n${theme.fg("dim", "… (expand to view full context)")}`;
	return out;
};

// =============================================================================
// Tool Registration
// =============================================================================

const formatToolErrorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const emptySearchResponse: ExaSearchResponse = { results: [] };
const emptyContentsResponse: ExaContentsResponse = { results: [] };
const emptyContextResponse: ExaContextResponse = {};

export function createExaToolDefinitions(): readonly ToolDefinition[] {
	const searchTool = defineDecodedTool<typeof WebSearchTypeBox, WebSearchParams, ExaSearchResponse>({
			name: "web_search_exa",
			label: "exa.web_search",
			description:
				"Search the Exa index (web, papers, GitHub, news, etc.). Use this to find relevant URLs. Best practices: keep numResults small (3-10), use filters (includeDomains/category/date ranges) to narrow results, and only request text when you need snippets.",
			promptSnippet: "Search the Exa index (web, papers, GitHub, news, etc.)",
			parameters: WebSearchTypeBox,
			decodeParams: decodeWebSearchParams,
			formatInvalidParamsResult: (message) =>
				textToolResult(message, emptySearchResponse, { isError: true }),
			formatExecuteErrorResult: (error) =>
				textToolResult(formatToolErrorText(error), emptySearchResponse, { isError: true }),

			renderCall(args, theme) {
				return new Text(renderSearchCall(args, theme), 0, 0);
			},

			renderResult(result, options, theme) {
				if (options.isPartial) {
					return new Text(theme.fg("warning", "Searching Exa…"), 0, 0);
				}

				// Result comes from details field
				const details = (result as { details?: ExaSearchResponse }).details;
				if (!details) {
					return new Text(theme.fg("dim", "(no results)"), 0, 0);
				}

				return new Text(renderSearchResult(details, options.expanded, theme), 0, 0);
			},

			async execute(params, { signal, onUpdate }) {
				onUpdate?.({
					content: [{ type: "text", text: "Searching Exa…" }],
					details: emptySearchResponse,
				});
				const program = ExaServiceLive.search(params, signal);

				const result = await runExaEffect(program);

				// Format text content
				const textContent = result.results
					.map((r, i) => formatSearchResultText(r, i))
					.join("\n\n");

				return {
					content: [{ type: "text", text: textContent || "No results found." }],
					details: result,
				};
			},
		});

	const crawlTool = defineDecodedTool<typeof CrawlingTypeBox, CrawlingParams, ExaContentsResponse>({
			name: "crawling_exa",
			label: "exa.crawl",
			description:
				"Fetch page contents via Exa (/contents). Use this when you already have URLs and need text, highlights, or summaries. Best practice: request only what you need (summary/highlights vs full text) to keep tool output small.",
			promptSnippet: "Fetch page contents via Exa (/contents) when you already have URLs",
			parameters: CrawlingTypeBox,
			decodeParams: decodeCrawlingParams,
			formatInvalidParamsResult: (message) =>
				textToolResult(message, emptyContentsResponse, { isError: true }),
			formatExecuteErrorResult: (error) =>
				textToolResult(formatToolErrorText(error), emptyContentsResponse, { isError: true }),

			renderCall(args, theme) {
				return new Text(renderCrawlCall(args, theme), 0, 0);
			},

			renderResult(result, options, theme) {
				if (options.isPartial) {
					return new Text(theme.fg("warning", "Fetching contents from Exa…"), 0, 0);
				}

				const details = (result as { details?: ExaContentsResponse }).details;
				if (!details) {
					return new Text(theme.fg("dim", "(no results)"), 0, 0);
				}

				return new Text(renderCrawlResult(details, options.expanded, theme), 0, 0);
			},

			async execute(params, { signal, onUpdate }) {
				onUpdate?.({
					content: [{ type: "text", text: "Fetching contents from Exa…" }],
					details: emptyContentsResponse,
				});
				const program = ExaServiceLive.crawl(params, signal);

				const result = await runExaEffect(program);

				const textContent = result.results
					.map((r, i) => formatCrawlResultText(r, i))
					.join("\n\n");

				return {
					content: [{ type: "text", text: textContent || "No results found." }],
					details: result,
				};
			},
		});

	const codeContextTool = defineDecodedTool<typeof CodeContextTypeBox, CodeContextParams, ExaContextResponse>({
			name: "get_code_context_exa",
			label: "exa.code_context",
			description:
				"Get relevant code snippets and examples via Exa Context API (Exa Code). Best practice: start with tokensNum omitted (defaults to 'dynamic') for token-efficient results; use '5000' (or '10000' if needed) when you want a fixed size.",
			promptSnippet: "Get relevant code snippets and examples via Exa Context API (Exa Code)",
			parameters: CodeContextTypeBox,
			decodeParams: decodeCodeContextParams,
			formatInvalidParamsResult: (message) =>
				textToolResult(message, emptyContextResponse, { isError: true }),
			formatExecuteErrorResult: (error) => {
				const message = formatToolErrorText(error);
				return textToolResult(message, emptyContextResponse, { isError: true });
			},

			renderCall(args, theme) {
				return new Text(renderCodeContextCall(args, theme), 0, 0);
			},

			renderResult(result, options, theme) {
				if (options.isPartial) {
					return new Text(theme.fg("warning", "Getting code context from Exa…"), 0, 0);
				}

				const details = (result as { details?: ExaContextResponse }).details;
				if (!details) {
					return new Text(theme.fg("dim", "(no response)"), 0, 0);
				}

				const out = renderCodeContextResult(details, options.expanded, theme);

				if (options.expanded) {
					const mdTheme = getMarkdownTheme();
					return new Markdown(out, 0, 0, mdTheme);
				}
				return new Text(out, 0, 0);
			},

			async execute(params, { signal, onUpdate }) {
				onUpdate?.({
					content: [{ type: "text", text: "Getting code context from Exa…" }],
					details: emptyContextResponse,
				});
				const program = ExaServiceLive.codeContext(params, signal);

				const result = await runExaEffect(program);

				return {
					content: [{ type: "text", text: result.response ?? "(no response)" }],
					details: result,
				};
			},
		});

	return [searchTool, crawlTool, codeContextTool];
}

export default function initExa(pi: ExtensionAPI): void {
	for (const tool of createExaToolDefinitions()) {
		pi.registerTool(tool);
	}
}
