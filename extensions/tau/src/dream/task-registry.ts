import { Clock, Data, Effect, Fiber, Layer, Option, Ref, Context, Stream, SubscriptionRef } from "effect";
import { nanoid } from "nanoid";

import type { MemoryFileError, MemoryMutationError } from "../memory/errors.js";
import type {
	DreamProgressEvent,
	DreamRunRequest,
	DreamRunResult,
	DreamTaskHandle,
	DreamTaskId,
	DreamTaskState,
} from "./domain.js";
import type { DreamConfigError, DreamGateError, DreamLockError, DreamSubagentError } from "./errors.js";

export type DreamRunError =
	| DreamConfigError
	| DreamGateError
	| DreamLockError
	| DreamSubagentError
	| MemoryMutationError
	| MemoryFileError;

class DreamTaskNotFound extends Data.TaggedError("DreamTaskNotFound")<{
	readonly taskId: DreamTaskId;
}> {}

export interface DreamTaskRegistryApi {
	readonly create: (request: DreamRunRequest) => Effect.Effect<DreamTaskHandle>;
	readonly attach: (
		taskId: DreamTaskId,
		fiber: Fiber.Fiber<DreamRunResult, DreamRunError>,
	) => Effect.Effect<void>;
	readonly report: (taskId: DreamTaskId, event: DreamProgressEvent) => Effect.Effect<void>;
	readonly complete: (taskId: DreamTaskId, result: DreamRunResult) => Effect.Effect<void>;
	readonly fail: (taskId: DreamTaskId, cause: DreamRunError) => Effect.Effect<void>;
	readonly cancel: (taskId: DreamTaskId) => Effect.Effect<void>;
	readonly get: (taskId: DreamTaskId) => Effect.Effect<DreamTaskState, DreamTaskNotFound>;
	readonly watch: (taskId: DreamTaskId) => Stream.Stream<DreamTaskState, DreamTaskNotFound>;
}

export class DreamTaskRegistry extends Context.Service<DreamTaskRegistry, DreamTaskRegistryApi>()(
	"DreamTaskRegistry",
) {}

type DreamTaskFiber = Fiber.Fiber<DreamRunResult, DreamRunError>;

interface DreamTaskRecord {
	readonly state: DreamTaskState;
	readonly fiber: Option.Option<DreamTaskFiber>;
	readonly updates: SubscriptionRef.SubscriptionRef<DreamTaskState>;
}

const isTerminal = (state: DreamTaskState): boolean => state.status !== "running";

function formatRunErrorMessage(cause: DreamRunError): string {
	if ("reason" in cause && typeof cause.reason === "string" && cause.reason.length > 0) {
		return cause.reason;
	}

	if ("field" in cause && "value" in cause) {
		const field = String(cause.field);
		const value = String(cause.value);
		return `${cause._tag}: ${field}=${value}`;
	}

	if ("id" in cause && typeof cause.id === "string") {
		return `${cause._tag}: ${cause.id}`;
	}

	return cause._tag;
}

const applyProgressEvent = (
	state: DreamTaskState,
	event: DreamProgressEvent,
): DreamTaskState => {
	switch (event._tag) {
		case "PhaseChanged":
			return event.message === undefined
				? { ...state, phase: event.phase }
				: { ...state, phase: event.phase, latestMessage: event.message };
		case "SessionsDiscovered":
			return { ...state, sessionsDiscovered: event.total };
		case "MemoryMutation":
			return {
				...state,
				memoryMutations: state.memoryMutations + 1,
				latestMessage: `${event.action} ${event.scope}: ${event.summary}`,
			};
		case "Note":
			return { ...state, latestMessage: event.text };
	}
};

export const DreamTaskRegistryLive = Layer.effect(
	DreamTaskRegistry,
	Effect.gen(function* () {
		const tasksRef = yield* Ref.make(new Map<DreamTaskId, DreamTaskRecord>());

		const getRecordOption = Effect.fn("DreamTaskRegistry.getRecordOption")(
			function* (taskId: DreamTaskId) {
				const tasks = yield* Ref.get(tasksRef);
				const record = tasks.get(taskId);
				return record === undefined ? Option.none<DreamTaskRecord>() : Option.some(record);
			},
		);

		const setRecord = Effect.fn("DreamTaskRegistry.setRecord")(
			function* (taskId: DreamTaskId, record: DreamTaskRecord) {
				yield* Ref.update(tasksRef, (tasks) => {
					const next = new Map(tasks);
					next.set(taskId, record);
					return next;
				});
			},
		);

		const create: DreamTaskRegistryApi["create"] = Effect.fn("DreamTaskRegistry.create")(
			function* (request) {
				const startedAt = yield* Clock.currentTimeMillis;
				const taskId: DreamTaskId = nanoid();
				const state: DreamTaskState = {
					id: taskId,
					type: "dream",
					mode: request.mode,
					status: "running",
					phase: "queued",
					startedAt,
					sessionsDiscovered: 0,
					sessionsReviewed: 0,
					memoryMutations: 0,
					cancellable: true,
				};

				const updates = yield* SubscriptionRef.make(state);
				const record: DreamTaskRecord = {
					state,
					fiber: Option.none(),
					updates,
				};

				yield* Ref.update(tasksRef, (tasks) => {
					const next = new Map(tasks);
					next.set(taskId, record);
					return next;
				});

				return { taskId } satisfies DreamTaskHandle;
			},
		);

		const attach: DreamTaskRegistryApi["attach"] = Effect.fn("DreamTaskRegistry.attach")(
			function* (taskId, fiber) {
				const recordOption = yield* getRecordOption(taskId);
				if (Option.isNone(recordOption)) {
					return;
				}

				const record = recordOption.value;
				yield* setRecord(taskId, {
					...record,
					fiber: Option.some(fiber),
				});
			},
		);

		const report: DreamTaskRegistryApi["report"] = Effect.fn("DreamTaskRegistry.report")(
			function* (taskId, event) {
				const recordOption = yield* getRecordOption(taskId);
				if (Option.isNone(recordOption)) {
					return;
				}

				const record = recordOption.value;
				if (isTerminal(record.state)) {
					return;
				}

				const nextState = applyProgressEvent(record.state, event);
				yield* setRecord(taskId, {
					...record,
					state: nextState,
				});
				yield* SubscriptionRef.set(record.updates, nextState);
			},
		);

		const complete: DreamTaskRegistryApi["complete"] = Effect.fn("DreamTaskRegistry.complete")(
			function* (taskId, result) {
				const recordOption = yield* getRecordOption(taskId);
				if (Option.isNone(recordOption)) {
					return;
				}

				const record = recordOption.value;
				if (isTerminal(record.state)) {
					return;
				}

				const nextState: DreamTaskState = {
					...record.state,
					status: "completed",
					phase: "done",
					finishedAt: result.finishedAt,
					sessionsReviewed: result.reviewedSessions.length,
					memoryMutations: result.memoryMutations,
					latestMessage: result.summary,
					cancellable: false,
				};

				yield* setRecord(taskId, {
					...record,
					state: nextState,
					fiber: Option.none(),
				});
				yield* SubscriptionRef.set(record.updates, nextState);
			},
		);

		const fail: DreamTaskRegistryApi["fail"] = Effect.fn("DreamTaskRegistry.fail")(
			function* (taskId, cause) {
				const finishedAt = yield* Clock.currentTimeMillis;
				const recordOption = yield* getRecordOption(taskId);
				if (Option.isNone(recordOption)) {
					return;
				}

				const record = recordOption.value;
				if (isTerminal(record.state)) {
					return;
				}

				const nextState: DreamTaskState = {
					...record.state,
					status: "failed",
					finishedAt,
					latestMessage: formatRunErrorMessage(cause),
					cancellable: false,
				};

				yield* setRecord(taskId, {
					...record,
					state: nextState,
					fiber: Option.none(),
				});
				yield* SubscriptionRef.set(record.updates, nextState);
			},
		);

		const cancel: DreamTaskRegistryApi["cancel"] = Effect.fn("DreamTaskRegistry.cancel")(
			function* (taskId) {
				const finishedAt = yield* Clock.currentTimeMillis;
				const recordOption = yield* getRecordOption(taskId);
				if (Option.isNone(recordOption)) {
					return;
				}

				const record = recordOption.value;
				if (isTerminal(record.state)) {
					return;
				}

				const nextState: DreamTaskState = {
					...record.state,
					status: "cancelled",
					finishedAt,
					cancellable: false,
				};

				yield* setRecord(taskId, {
					...record,
					state: nextState,
					fiber: Option.none(),
				});
				yield* SubscriptionRef.set(record.updates, nextState);

				if (Option.isSome(record.fiber)) {
					yield* Fiber.interrupt(record.fiber.value);
				}
			},
		);

		const get: DreamTaskRegistryApi["get"] = Effect.fn("DreamTaskRegistry.get")(
			function* (taskId) {
				const recordOption = yield* getRecordOption(taskId);
				if (Option.isNone(recordOption)) {
					return yield* Effect.fail(new DreamTaskNotFound({ taskId }));
				}

				return recordOption.value.state;
			},
		);

		const watch: DreamTaskRegistryApi["watch"] = (taskId) =>
			Stream.unwrap(
				getRecordOption(taskId).pipe(
					Effect.flatMap((recordOption: Option.Option<DreamTaskRecord>) =>
						Option.match(recordOption, {
							onNone: () => Effect.fail(new DreamTaskNotFound({ taskId })),
							onSome: (record: DreamTaskRecord) =>
								Effect.succeed(SubscriptionRef.changes(record.updates)),
						}),
					),
				),
			);

		return DreamTaskRegistry.of({
			create,
			attach,
			report,
			complete,
			fail,
			cancel,
			get,
			watch,
		});
	}),
);
