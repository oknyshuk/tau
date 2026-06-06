import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { Deferred, Effect, SubscriptionRef } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { Status } from "../src/agent/status.js";
import { WorkerSessionController } from "../src/agent/worker/session-controller.js";
import { createWorkerTrackingState } from "../src/agent/worker/status.js";

type SessionListener = (event: AgentSessionEvent) => void;

class FakeAgentSession {
	readonly listeners: SessionListener[] = [];
	sessionId = "session-1";

	subscribe(listener: SessionListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) {
				this.listeners.splice(index, 1);
			}
		};
	}

	abort(): Promise<void> {
		return Promise.resolve();
	}

	dispose(): void {}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}

	asAgentSession(): AgentSession {
		return this as unknown as AgentSession;
	}
}

async function makeController() {
	const statusRef = await Effect.runPromise(SubscriptionRef.make<Status>({ state: "pending" }));
	const tracking = createWorkerTrackingState();

	return {
		controller: new WorkerSessionController({
			tracking,
			spawnBackground: (effect) => Effect.runFork(effect),
			publishRunningStatus: vi.fn(),
			publishRunningStatusIfNotFinal: vi.fn(),
			publishCompleted: vi.fn(),
			publishFailed: vi.fn(),
			statusRef,
		}),
		statusRef,
	};
}

describe("WorkerSessionController", () => {
	it("replaces the previous session subscription when attaching a new session", async () => {
		const { controller } = await makeController();
		const firstSession = new FakeAgentSession();
		const secondSession = new FakeAgentSession();

		controller.attach(firstSession.asAgentSession());
		expect(firstSession.listeners).toHaveLength(1);

		controller.attach(secondSession.asAgentSession());

		expect(firstSession.listeners).toHaveLength(0);
		expect(secondSession.listeners).toHaveLength(1);
	});

	it("interrupts the previous background fiber before replacing it", async () => {
		const { controller } = await makeController();
		const interrupted = await Effect.runPromise(Deferred.make<void>());
		const blockingEffect = Effect.callback<void>(() =>
			Deferred.succeed(interrupted, undefined),
		);

		await Effect.runPromise(controller.replaceBackground(blockingEffect));

		await Effect.runPromise(controller.replaceBackground(Effect.void));
		await Effect.runPromise(Deferred.await(interrupted));
	});

	it("shutdown interrupts background work, unsubscribes, and publishes shutdown status", async () => {
		const { controller, statusRef } = await makeController();
		const session = new FakeAgentSession();
		const interrupted = await Effect.runPromise(Deferred.make<void>());
		const blockingEffect = Effect.callback<void>(() =>
			Deferred.succeed(interrupted, undefined),
		);

		controller.attach(session.asAgentSession());
		await Effect.runPromise(controller.replaceBackground(blockingEffect));

		await Effect.runPromise(
			controller.shutdown(session.asAgentSession(), { abortSession: true }),
		);
		await Effect.runPromise(Deferred.await(interrupted));

		expect(session.listeners).toHaveLength(0);
		expect(Effect.runSync(SubscriptionRef.get(statusRef))).toEqual({ state: "shutdown" });
	});
});
