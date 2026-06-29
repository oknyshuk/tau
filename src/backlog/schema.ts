import { Effect, Schema } from "effect";

import { BacklogContractValidationError } from "./errors.js";

export const IssueStatusSchema = Schema.String.check(Schema.isMinLength(1));
export type IssueStatus = Schema.Schema.Type<typeof IssueStatusSchema>;

export const IssueTypeSchema = Schema.String.check(Schema.isMinLength(1));
type IssueType = Schema.Schema.Type<typeof IssueTypeSchema>;

const DependencyTypeSchema = Schema.String.check(Schema.isMinLength(1)).check(
	Schema.isMaxLength(50),
);
export type DependencyType = Schema.Schema.Type<typeof DependencyTypeSchema>;

const DependencySchema = Schema.Struct({
	issue_id: Schema.NonEmptyString,
	depends_on_id: Schema.NonEmptyString,
	type: DependencyTypeSchema,
	created_at: Schema.String,
	created_by: Schema.optional(Schema.String),
	metadata: Schema.optional(Schema.Unknown),
	thread_id: Schema.optional(Schema.String),
});
export type Dependency = Schema.Schema.Type<typeof DependencySchema>;

const CommentSchema = Schema.Struct({
	id: Schema.Number,
	issue_id: Schema.NonEmptyString,
	author: Schema.String,
	text: Schema.String,
	created_at: Schema.String,
});
export type Comment = Schema.Schema.Type<typeof CommentSchema>;

const IssueExtraFields = Schema.Record(Schema.String, Schema.Unknown);

const IssueKnownFieldsSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	title: Schema.NonEmptyString,
	description: Schema.optional(Schema.String),
	design: Schema.optional(Schema.String),
	acceptance_criteria: Schema.optional(Schema.String),
	notes: Schema.optional(Schema.String),
	status: Schema.optional(IssueStatusSchema),
	priority: Schema.optional(Schema.Number),
	issue_type: Schema.optional(IssueTypeSchema),
	assignee: Schema.optional(Schema.String),
	owner: Schema.optional(Schema.String),
	estimated_minutes: Schema.optional(Schema.Number),
	created_at: Schema.optional(Schema.String),
	created_by: Schema.optional(Schema.String),
	updated_at: Schema.optional(Schema.String),
	closed_at: Schema.optional(Schema.String),
	close_reason: Schema.optional(Schema.String),
	closed_by_session: Schema.optional(Schema.String),
	due_at: Schema.optional(Schema.String),
	defer_until: Schema.optional(Schema.String),
	external_ref: Schema.optional(Schema.String),
	source_system: Schema.optional(Schema.String),
	compaction_level: Schema.optional(Schema.Number),
	compacted_at: Schema.optional(Schema.String),
	compacted_at_commit: Schema.optional(Schema.String),
	original_size: Schema.optional(Schema.Number),
	labels: Schema.optional(Schema.Array(Schema.String)),
	dependencies: Schema.optional(Schema.Array(DependencySchema)),
	comments: Schema.optional(Schema.Array(CommentSchema)),
	deleted_at: Schema.optional(Schema.String),
	deleted_by: Schema.optional(Schema.String),
	delete_reason: Schema.optional(Schema.String),
	original_type: Schema.optional(Schema.String),
	sender: Schema.optional(Schema.String),
	ephemeral: Schema.optional(Schema.Boolean),
	pinned: Schema.optional(Schema.Boolean),
	is_template: Schema.optional(Schema.Boolean),
});

const IssueFieldsSchema = Schema.StructWithRest(IssueKnownFieldsSchema, [IssueExtraFields]);
export type Issue = Schema.Schema.Type<typeof IssueFieldsSchema>;

export type EncodedIssue = Schema.Codec.Encoded<typeof IssueFieldsSchema>;

const decodeIssueSchema = Schema.decodeUnknownEffect(IssueFieldsSchema);
const encodeIssueSchema = Schema.encodeUnknownEffect(IssueFieldsSchema);

export const decodeIssue = (
	value: unknown,
): Effect.Effect<Issue, BacklogContractValidationError, never> =>
	decodeIssueSchema(value).pipe(
		Effect.mapError((error) =>
			new BacklogContractValidationError({
				reason: String(error),
				entity: "backlog.issue",
			}),
		),
	);

export const encodeIssue = (
	issue: Issue,
): Effect.Effect<EncodedIssue, BacklogContractValidationError, never> =>
	encodeIssueSchema(issue).pipe(
		Effect.mapError((error) =>
			new BacklogContractValidationError({
				reason: String(error),
				entity: "backlog.issue",
			}),
		),
	);
