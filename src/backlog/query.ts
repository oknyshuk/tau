import { Effect, Schema } from "effect";

import { BacklogContractValidationError } from "./errors.js";
import {
	IssueStatusSchema,
	IssueTypeSchema,
	type DependencyType,
	type Issue,
} from "./schema.js";

const SortFieldSchema = Schema.Union([
	Schema.Literal("priority"),
	Schema.Literal("created_at"),
	Schema.Literal("updated_at"),
] as const);
export type SortField = Schema.Schema.Type<typeof SortFieldSchema>;

const SortOrderSchema = Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")] as const);
export type SortOrder = Schema.Schema.Type<typeof SortOrderSchema>;

const IssueQuerySchema = Schema.Struct({
	status: Schema.optional(Schema.Union([IssueStatusSchema, Schema.Array(IssueStatusSchema)] as const)),
	type: Schema.optional(Schema.Union([IssueTypeSchema, Schema.Array(IssueTypeSchema)] as const)),
	priority: Schema.optional(Schema.Union([Schema.Number, Schema.Array(Schema.Number)] as const)),
	text: Schema.optional(Schema.String),
	ready: Schema.optional(Schema.Boolean),
	blocked: Schema.optional(Schema.Boolean),
	sortBy: Schema.optional(SortFieldSchema),
	order: Schema.optional(SortOrderSchema),
});
export type IssueQuery = Schema.Schema.Type<typeof IssueQuerySchema>;

const decodeIssueQuerySchema = Schema.decodeUnknownEffect(IssueQuerySchema);

export const decodeIssueQuery = (
	value: unknown,
): Effect.Effect<IssueQuery, BacklogContractValidationError, never> =>
	decodeIssueQuerySchema(value).pipe(
		Effect.mapError((error) =>
			new BacklogContractValidationError({
				reason: String(error),
				entity: "backlog.query",
			}),
		),
	);

const BlockingDependencyTypes = new Set<DependencyType>([
	"blocks",
	"parent-child",
	"conditional-blocks",
	"waits-for",
	"delegated-from",
]);

const normalizeFilter = <T>(value?: T | ReadonlyArray<T>): ReadonlyArray<T> | undefined => {
	if (value === undefined) {
		return undefined;
	}
	if (Array.isArray(value)) {
		return value;
	}
	return [value] as ReadonlyArray<T>;
};

const isClosedStatus = (status?: string): boolean => status === "closed" || status === "tombstone";

const isDeferredStatus = (status?: string): boolean => status === "deferred";

const isReadyCandidate = (status?: string): boolean => status === "open" || status === "in_progress";

const hasOpenBlockers = (issue: Issue, byId: ReadonlyMap<string, Issue>): boolean => {
	for (const dep of issue.dependencies ?? []) {
		if (!BlockingDependencyTypes.has(dep.type)) {
			continue;
		}
		const target = byId.get(dep.depends_on_id);
		if (!target) {
			return true;
		}
		if (!isClosedStatus(target.status) && !isDeferredStatus(target.status)) {
			return true;
		}
	}
	return false;
};

const matchesText = (issue: Issue, query: string): boolean => {
	const dependencyText = (issue.dependencies ?? [])
		.map((dependency) => `${dependency.issue_id} ${dependency.depends_on_id} ${dependency.type}`)
		.join(" ");
	const haystack = `${issue.id} ${issue.title} ${issue.description ?? ""} ${issue.notes ?? ""} ${dependencyText}`
		.toLowerCase()
		.trim();
	return haystack.includes(query.toLowerCase());
};

const toTimestamp = (value?: string): number => {
	if (!value) {
		return 0;
	}
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
};

export function filterIssues(
	issues: ReadonlyArray<Issue>,
	query: IssueQuery = {},
): ReadonlyArray<Issue> {
	const statusFilter = normalizeFilter(query.status);
	const typeFilter = normalizeFilter(query.type);
	const priorityFilter = normalizeFilter(query.priority);
	const text = query.text?.trim();
	const byId = new Map(issues.map((issue) => [issue.id, issue]));

	let filtered = issues.filter((issue) => {
		if (statusFilter && !statusFilter.includes(issue.status ?? "")) {
			return false;
		}
		if (typeFilter && !typeFilter.includes(issue.issue_type ?? "")) {
			return false;
		}
		if (priorityFilter && !priorityFilter.includes(issue.priority ?? Number.NaN)) {
			return false;
		}
		if (text && !matchesText(issue, text)) {
			return false;
		}

		if (query.ready === true) {
			if (!isReadyCandidate(issue.status)) {
				return false;
			}
			if (hasOpenBlockers(issue, byId)) {
				return false;
			}
		}

		if (query.blocked === true) {
			if (isClosedStatus(issue.status)) {
				return false;
			}
			if (!hasOpenBlockers(issue, byId)) {
				return false;
			}
		}

		return true;
	});

	const sortBy = query.sortBy ?? "priority";
	const order = query.order ?? "asc";

	filtered = [...filtered].sort((a, b) => {
		let cmp = 0;
		switch (sortBy) {
			case "priority": {
				const aPriority = a.priority ?? 999;
				const bPriority = b.priority ?? 999;
				cmp = aPriority - bPriority;
				break;
			}
			case "created_at": {
				cmp = toTimestamp(a.created_at) - toTimestamp(b.created_at);
				break;
			}
			case "updated_at": {
				cmp = toTimestamp(a.updated_at) - toTimestamp(b.updated_at);
				break;
			}
		}
		return order === "desc" ? -cmp : cmp;
	});

	return filtered;
}
