import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { Effect, Fiber, SubscriptionRef } from "effect";

import type { Status } from "../status.js";
import { setWorkerApprovalBroker } from "../approval-broker.js";
import { subscribeToWorkerSession } from "./session-subscription.js";
import { buildShutdownStatus, type WorkerTrackingState } from "./status.js";

export interface WorkerSessionControllerOptions {
	readonly tracking: WorkerTrackingState;
	readonly spawnBackground: (effect: Effect.Effect<void, never>) => Fiber.Fiber<void, never>;
	readonly publishRunningStatus: () => void;
	readonly publishRunningStatusIfNotFinal: () => void;
	readonly publishCompleted: (message: string | undefined) => void;
	readonly publishFailed: (reason: string) => void;
	readonly statusRef: SubscriptionRef.SubscriptionRef<Status>;
}

export class WorkerSessionController {
	private sessionUnsubscribe: (() => void) | undefined = undefined;
	private activeFiber: Fiber.Fiber<void, never> | undefined = undefined;

	constructor(private readonly options: WorkerSessionControllerOptions) {}

	attach(session: AgentSession): void {
		this.clearSubscription();

		this.sessionUnsubscribe = subscribeToWorkerSession({
			session,
			tracking: this.options.tracking,
			publishRunningStatus: this.options.publishRunningStatus,
			publishRunningStatusIfNotFinal: this.options.publishRunningStatusIfNotFinal,
			publishCompleted: this.options.publishCompleted,
			publishFailed: this.options.publishFailed,
		});
	}

	releaseSession(sessionId: string): void {
		this.clearSubscription();
		setWorkerApprovalBroker(sessionId, undefined);
	}

	replaceBackground(effect: Effect.Effect<void, never>): Effect.Effect<void> {
		return this.interruptBackground().pipe(
			Effect.andThen(
				Effect.sync(() => {
					this.activeFiber = this.options.spawnBackground(effect);
				}),
			),
		);
	}

	interruptBackground(): Effect.Effect<void> {
		const activeFiber = this.activeFiber;
		this.activeFiber = undefined;
		return activeFiber ? Fiber.interrupt(activeFiber) : Effect.void;
	}

	shutdown(
		session: AgentSession,
		options: { readonly abortSession: boolean },
	): Effect.Effect<void> {
		return this.interruptBackground().pipe(
			Effect.andThen(
				options.abortSession ? Effect.promise(() => session.abort()) : Effect.void,
			),
			Effect.andThen(
				Effect.sync(() => {
					this.releaseSession(session.sessionId);
					session.dispose();
				}),
			),
			Effect.andThen(SubscriptionRef.set(this.options.statusRef, buildShutdownStatus())),
		);
	}

	private clearSubscription(): void {
		if (this.sessionUnsubscribe) {
			this.sessionUnsubscribe();
			this.sessionUnsubscribe = undefined;
		}
	}
}
