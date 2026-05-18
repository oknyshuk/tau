import { randomUUID } from "node:crypto";

import { Effect, Layer, Option, Schema } from "effect";

import {
	BacklogIssueCreatedEventSchema,
	BacklogIssueUpdatedEventSchema,
	type BacklogEvent,
} from "./contract.js";
import {
	BacklogCommandUsageError,
	BacklogContractValidationError,
	BacklogIssueNotFoundError,
	BacklogStorageError,
} from "./errors.js";
import { generateIssueIdEffect } from "./id.js";
import { filterIssues, type IssueQuery } from "./query.js";
import { BacklogInfrastructureLive } from "./repository.js";
import { decodeIssue, encodeIssue, type Comment, type Dependency, type Issue, type IssueStatus } from "./schema.js";
import {
	type AddCommentInput,
	type AddDependencyInput,
	type BacklogCommandMutationError,
	type BacklogCommandQueryError,
	BacklogCommandService,
	type BacklogStatusSummary,
	BacklogRepository,
	type CreateIssueInput,
	type RemoveDependencyInput,
	type SetIssueStatusInput,
	type UpdateIssueInput,
} from "./services.js";

type CreateIssueInputLegacy = {
	readonly title: string;
	readonly actor: string;
	readonly id?: string;
	readonly prefix?: string;
	readonly recorded_at?: string;
	readonly fields?: Readonly<Record<string, unknown>>;
};

type UpdateIssueInputLegacy = {
	readonly issueId: string;
	readonly actor: string;
	readonly recorded_at?: string;
	readonly setFields: Readonly<Record<string, unknown>>;
	readonly unsetFields?: ReadonlyArray<string>;
};

type StatusUpdateInputLegacy = {
	readonly issueId: string;
	readonly actor: string;
	readonly status: IssueStatus;
	readonly reason?: string;
	readonly recorded_at?: string;
};

type DependencyMutationInputLegacy = {
	readonly issueId: string;
	readonly actor: string;
	readonly dependsOnId: string;
	readonly type: string;
	readonly recorded_at?: string;
};

type RemoveDependencyInputLegacy = {
	readonly issueId: string;
	readonly actor: string;
	readonly dependsOnId: string;
	readonly type?: string;
	readonly recorded_at?: string;
};

type AddCommentInputLegacy = {
	readonly issueId: string;
	readonly actor: string;
	readonly text: string;
	readonly recorded_at?: string;
};

const decodeCreatedEventSchema = Schema.decodeUnknownEffect(BacklogIssueCreatedEventSchema);
const decodeUpdatedEventSchema = Schema.decodeUnknownEffect(BacklogIssueUpdatedEventSchema);

const decodeCreatedEvent = (
	value: unknown,
): Effect.Effect<Extract<BacklogEvent, { kind: "issue.created" }>, BacklogContractValidationError, never> =>
	decodeCreatedEventSchema(value).pipe(
		Effect.mapError(
			(error) =>
				new BacklogContractValidationError({
					reason: String(error),
					entity: "backlog.event",
				}),
		),
	);

const decodeUpdatedEvent = (
	value: unknown,
): Effect.Effect<Extract<BacklogEvent, { kind: "issue.updated" }>, BacklogContractValidationError, never> =>
	decodeUpdatedEventSchema(value).pipe(
		Effect.mapError(
			(error) =>
				new BacklogContractValidationError({
					reason: String(error),
					entity: "backlog.event",
				}),
		),
	);

const nowIso = (): string => new Date().toISOString();

const requireIssue = (
	issues: ReadonlyArray<Issue>,
	issueId: string,
): Effect.Effect<Issue, BacklogIssueNotFoundError, never> => {
	const issue = issues.find((candidate) => candidate.id === issueId);
	if (!issue) {
		return Effect.fail(new BacklogIssueNotFoundError({ issueId }));
	}
	return Effect.succeed(issue);
};

const uniqueLabels = (labels: ReadonlyArray<string> | undefined): ReadonlyArray<string> | undefined =>
	labels ? [...new Set(labels)] : undefined;

const statusSummary = (issues: ReadonlyArray<Issue>): BacklogStatusSummary => ({
	total: issues.length,
	open: issues.filter((issue) => issue.status === "open").length,
	inProgress: issues.filter((issue) => issue.status === "in_progress").length,
	closed: issues.filter((issue) => issue.status === "closed" || issue.status === "tombstone").length,
	blocked: filterIssues(issues, { blocked: true }).length,
	ready: filterIssues(issues, { ready: true }).length,
	deferred: issues.filter((issue) => issue.status === "deferred").length,
	pinned: issues.filter((issue) => issue.pinned === true).length,
});

export const BacklogCommandServiceLive = Layer.effect(
	BacklogCommandService,
	Effect.gen(function* () {
		const repository = yield* BacklogRepository;

		const loadCurrentIssuesForMutation = (): Effect.Effect<
			ReadonlyArray<Issue>,
			BacklogCommandMutationError | BacklogCommandQueryError,
			never
		> => repository.readMaterializedIssues();

		const loadCurrentIssuesForQuery = (): Effect.Effect<ReadonlyArray<Issue>, BacklogCommandQueryError, never> =>
			repository.withWriteLock(repository.readMaterializedIssues()).pipe(
				Effect.catchTag("BacklogLockError", (error) =>
					Effect.fail(
						new BacklogStorageError({
							operation: "query-read-lock",
							path: ".pi/backlog/cache/.lock",
							reason: "Failed to acquire write lock for backlog query read",
							cause: error,
						}),
					),
				),
			);

		const updateIssueUnlocked = (
			input: UpdateIssueInput,
		): Effect.Effect<Issue, BacklogCommandMutationError, never> =>
			Effect.gen(function* () {
				const issues = yield* loadCurrentIssuesForMutation();
				yield* requireIssue(issues, input.issueId);
				const recordedAt = Option.getOrElse(input.recordedAt, nowIso);
				const event = yield* decodeUpdatedEvent({
					schema_version: 1,
					event_id: `update-${randomUUID()}`,
					issue_id: input.issueId,
					recorded_at: recordedAt,
					actor: input.actor,
					kind: "issue.updated",
					set_fields: input.setFields,
					unset_fields: [...input.unsetFields],
				});
				yield* repository.appendEvent(event);
				const nextIssues = yield* repository.rebuildMaterializedIssues();
				return yield* requireIssue(nextIssues, input.issueId);
			});

		const create = (
			input: CreateIssueInput,
		): Effect.Effect<Issue, BacklogCommandMutationError, never> =>
			repository.withWriteLock(
				Effect.gen(function* () {
					const currentIssues = yield* loadCurrentIssuesForMutation();
					const existingIds = new Set(currentIssues.map((issue) => issue.id));

					if (Option.isNone(input.id) && Option.isNone(input.prefix)) {
						return yield* Effect.fail(
							new BacklogCommandUsageError({
								command: "create",
								usage: "create \"Title\" --id <id> | create \"Title\" --prefix <prefix>",
								reason: "create requires either an explicit id or a prefix for id generation",
							}),
						);
					}

					const issueId = yield* Option.match(input.id, {
						onSome: Effect.succeed,
						onNone: () =>
							Option.match(input.prefix, {
								onSome: (prefix) =>
									generateIssueIdEffect({
										prefix,
										title: input.title,
										description:
											typeof input.fields["description"] === "string" ? input.fields["description"] : "",
										creator: input.actor,
										timestamp: new Date(Option.getOrElse(input.recordedAt, nowIso)),
										existingIds,
										existingTopLevelCount: currentIssues.filter((issue) => !issue.id.includes(".")).length,
									}),
								onNone: () =>
									Effect.fail(
										new BacklogCommandUsageError({
											command: "create",
											usage: "create \"Title\" --id <id> | create \"Title\" --prefix <prefix>",
											reason: "Missing issue id and prefix",
										}),
									),
							}),
					});

					const recordedAt = Option.getOrElse(input.recordedAt, nowIso);
					const candidate = yield* decodeIssue({
						id: issueId,
						title: input.title,
						status: "open",
						priority: 2,
						issue_type: "task",
						created_at: recordedAt,
						created_by: input.actor,
						updated_at: recordedAt,
						...input.fields,
					});
					const encodedCandidate = yield* encodeIssue(candidate);
					const event = yield* decodeCreatedEvent({
						schema_version: 1,
						event_id: `create-${randomUUID()}`,
						issue_id: issueId,
						recorded_at: recordedAt,
						actor: input.actor,
						kind: "issue.created",
						fields: encodedCandidate,
					});

					yield* repository.appendEvent(event);
					const issues = yield* repository.rebuildMaterializedIssues();
					return yield* requireIssue(issues, issueId);
				}),
			);

		const update = (
			input: UpdateIssueInput,
		): Effect.Effect<Issue, BacklogCommandMutationError, never> =>
			repository.withWriteLock(updateIssueUnlocked(input));

		const setStatus = (
			input: SetIssueStatusInput,
		): Effect.Effect<Issue, BacklogCommandMutationError, never> => {
			const recordedAt = Option.getOrElse(input.recordedAt, nowIso);
			const setFields: Record<string, unknown> = {
				status: input.status,
				updated_at: recordedAt,
			};
			const unsetFields: string[] = [];

			if (input.status === "closed" || input.status === "tombstone") {
				setFields["closed_at"] = recordedAt;
				if (Option.isSome(input.reason)) {
					setFields["close_reason"] = input.reason.value;
				}
			} else {
				unsetFields.push("closed_at", "close_reason");
			}

			return update({
				issueId: input.issueId,
				actor: input.actor,
				recordedAt: Option.some(recordedAt),
				setFields,
				unsetFields,
			});
		};

		const addDependency = (
			input: AddDependencyInput,
		): Effect.Effect<Issue, BacklogCommandMutationError, never> =>
			repository.withWriteLock(
				Effect.gen(function* () {
					const issues = yield* loadCurrentIssuesForMutation();
					const issue = yield* requireIssue(issues, input.issueId);
					const dependsOnIssue = yield* requireIssue(issues, input.dependsOnId);

					if (
						input.dependencyType === "parent-child" &&
						dependsOnIssue.issue_type === "epic" &&
						(dependsOnIssue.status === "closed" || dependsOnIssue.status === "tombstone")
					) {
						return yield* Effect.fail(
							new BacklogCommandUsageError({
								command: "dep add",
								usage: "dep add <id> <target> --type parent-child",
								reason: `Cannot add ${issue.id} to closed epic ${dependsOnIssue.id}. Reopen the epic before adding child tasks.`,
							}),
						);
					}
					const recordedAt = Option.getOrElse(input.recordedAt, nowIso);
					const dependency: Dependency = {
						issue_id: input.issueId,
						depends_on_id: input.dependsOnId,
						type: input.dependencyType,
						created_at: recordedAt,
						created_by: input.actor,
					};

					const dependencies = [...(issue.dependencies ?? [])];
					if (
						!dependencies.some(
							(entry) =>
								entry.depends_on_id === dependency.depends_on_id && entry.type === dependency.type,
						)
					) {
						dependencies.push(dependency);
					}

					return yield* updateIssueUnlocked({
						issueId: input.issueId,
						actor: input.actor,
						recordedAt: Option.some(recordedAt),
						setFields: { dependencies, updated_at: recordedAt },
						unsetFields: [],
					});
				}),
			);

		const removeDependency = (
			input: RemoveDependencyInput,
		): Effect.Effect<Issue, BacklogCommandMutationError, never> =>
			repository.withWriteLock(
				Effect.gen(function* () {
					const issues = yield* loadCurrentIssuesForMutation();
					const issue = yield* requireIssue(issues, input.issueId);
					const recordedAt = Option.getOrElse(input.recordedAt, nowIso);
					const dependencies = (issue.dependencies ?? []).filter(
						(entry) =>
							!(
								entry.depends_on_id === input.dependsOnId &&
								(Option.isNone(input.dependencyType) || entry.type === input.dependencyType.value)
							),
					);

					return yield* updateIssueUnlocked({
						issueId: input.issueId,
						actor: input.actor,
						recordedAt: Option.some(recordedAt),
						setFields: { dependencies, updated_at: recordedAt },
						unsetFields: [],
					});
				}),
			);

		const addComment = (
			input: AddCommentInput,
		): Effect.Effect<Issue, BacklogCommandMutationError, never> =>
			repository.withWriteLock(
				Effect.gen(function* () {
					const issues = yield* loadCurrentIssuesForMutation();
					const issue = yield* requireIssue(issues, input.issueId);
					const recordedAt = Option.getOrElse(input.recordedAt, nowIso);
					const nextCommentId = Math.max(0, ...(issue.comments ?? []).map((comment) => comment.id)) + 1;
					const comments = [
						...(issue.comments ?? []),
						{
							id: nextCommentId,
							issue_id: input.issueId,
							author: input.actor,
							text: input.text,
							created_at: recordedAt,
						} satisfies Comment,
					];

					return yield* updateIssueUnlocked({
						issueId: input.issueId,
						actor: input.actor,
						recordedAt: Option.some(recordedAt),
						setFields: { comments, updated_at: recordedAt },
						unsetFields: [],
					});
				}),
			);

		const list = (
			query: IssueQuery,
		): Effect.Effect<ReadonlyArray<Issue>, BacklogCommandQueryError, never> =>
			loadCurrentIssuesForQuery().pipe(Effect.map((issues) => filterIssues(issues, query)));

		const show = (issueId: string): Effect.Effect<Issue, BacklogCommandQueryError, never> =>
			Effect.gen(function* () {
				const issues = yield* loadCurrentIssuesForQuery();
				return yield* requireIssue(issues, issueId);
			});

		const ready = (): Effect.Effect<ReadonlyArray<Issue>, BacklogCommandQueryError, never> =>
			list({ ready: true });

		const blocked = (): Effect.Effect<ReadonlyArray<Issue>, BacklogCommandQueryError, never> =>
			list({ blocked: true });

		const search = (
			text: string,
			limit: Option.Option<number>,
		): Effect.Effect<ReadonlyArray<Issue>, BacklogCommandQueryError, never> =>
			list({ text }).pipe(
				Effect.map((issues) =>
					Option.match(limit, {
						onNone: () => issues,
						onSome: (value) => issues.slice(0, value),
					}),
				),
			);

		const status = (): Effect.Effect<BacklogStatusSummary, BacklogCommandQueryError, never> =>
			loadCurrentIssuesForQuery().pipe(Effect.map((issues) => statusSummary(issues)));

		return BacklogCommandService.of({
			create,
			update,
			setStatus,
			addDependency,
			removeDependency,
			addComment,
			list,
			show,
			ready,
			blocked,
			search,
			status,
		});
	}),
);

export const BacklogCommandServiceForWorkspace = (workspaceRoot: string) =>
	BacklogCommandServiceLive.pipe(Layer.provide(BacklogInfrastructureLive(workspaceRoot)));

const withCommands = <A, E>(
	workspaceRoot: string,
	effect: Effect.Effect<A, E, BacklogCommandService>,
): Effect.Effect<A, E, never> =>
	effect.pipe(Effect.provide(BacklogCommandServiceForWorkspace(workspaceRoot)));

export const createIssue = (
	workspaceRoot: string,
	input: CreateIssueInputLegacy,
): Effect.Effect<Issue, BacklogCommandMutationError, never> =>
	withCommands(
		workspaceRoot,
		Effect.gen(function* () {
			const commands = yield* BacklogCommandService;
			return yield* commands.create({
				title: input.title,
				actor: input.actor,
				id: Option.fromNullishOr(input.id),
				prefix: Option.fromNullishOr(input.prefix),
				recordedAt: Option.fromNullishOr(input.recorded_at),
				fields: input.fields ?? {},
			});
		}),
	);

export const updateIssue = (
	workspaceRoot: string,
	input: UpdateIssueInputLegacy,
): Effect.Effect<Issue, BacklogCommandMutationError, never> =>
	withCommands(
		workspaceRoot,
		Effect.gen(function* () {
			const commands = yield* BacklogCommandService;
			return yield* commands.update({
				issueId: input.issueId,
				actor: input.actor,
				recordedAt: Option.fromNullishOr(input.recorded_at),
				setFields: input.setFields,
				unsetFields: [...(input.unsetFields ?? [])],
			});
		}),
	);

export const setIssueStatus = (
	workspaceRoot: string,
	input: StatusUpdateInputLegacy,
): Effect.Effect<Issue, BacklogCommandMutationError, never> =>
	withCommands(
		workspaceRoot,
		Effect.gen(function* () {
			const commands = yield* BacklogCommandService;
			return yield* commands.setStatus({
				issueId: input.issueId,
				actor: input.actor,
				status: input.status,
				reason: Option.fromNullishOr(input.reason),
				recordedAt: Option.fromNullishOr(input.recorded_at),
			});
		}),
	);

export const addIssueDependency = (
	workspaceRoot: string,
	input: DependencyMutationInputLegacy,
): Effect.Effect<Issue, BacklogCommandMutationError, never> =>
	withCommands(
		workspaceRoot,
		Effect.gen(function* () {
			const commands = yield* BacklogCommandService;
			return yield* commands.addDependency({
				issueId: input.issueId,
				actor: input.actor,
				dependsOnId: input.dependsOnId,
				dependencyType: input.type,
				recordedAt: Option.fromNullishOr(input.recorded_at),
			});
		}),
	);

export const removeIssueDependency = (
	workspaceRoot: string,
	input: RemoveDependencyInputLegacy,
): Effect.Effect<Issue, BacklogCommandMutationError, never> =>
	withCommands(
		workspaceRoot,
		Effect.gen(function* () {
			const commands = yield* BacklogCommandService;
			return yield* commands.removeDependency({
				issueId: input.issueId,
				actor: input.actor,
				dependsOnId: input.dependsOnId,
				dependencyType: Option.fromNullishOr(input.type),
				recordedAt: Option.fromNullishOr(input.recorded_at),
			});
		}),
	);

export const addIssueComment = (
	workspaceRoot: string,
	input: AddCommentInputLegacy,
): Effect.Effect<Issue, BacklogCommandMutationError, never> =>
	withCommands(
		workspaceRoot,
		Effect.gen(function* () {
			const commands = yield* BacklogCommandService;
			return yield* commands.addComment({
				issueId: input.issueId,
				actor: input.actor,
				text: input.text,
				recordedAt: Option.fromNullishOr(input.recorded_at),
			});
		}),
	);

export const updateIssueFields = (
	workspaceRoot: string,
	issueId: string,
	actor: string,
	patch: Partial<Issue>,
	options?: { readonly unsetFields?: ReadonlyArray<string>; readonly recorded_at?: string },
): Effect.Effect<Issue, BacklogCommandMutationError, never> => {
	const recordedAt = options?.recorded_at ?? nowIso();
	const setFields: Record<string, unknown> = { ...patch, updated_at: recordedAt };
	if ("labels" in setFields && Array.isArray(setFields["labels"])) {
		setFields["labels"] = uniqueLabels(setFields["labels"] as ReadonlyArray<string>);
	}

	return updateIssue(workspaceRoot, {
		issueId,
		actor,
		recorded_at: recordedAt,
		setFields,
		...(options?.unsetFields ? { unsetFields: options.unsetFields } : {}),
	});
};
