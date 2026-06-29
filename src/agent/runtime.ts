import { Effect, Fiber, Layer, Context } from "effect";

import { AgentControl } from "./services.js";
import { createAgentToolDef, type AgentToolContext, type AgentToolDef } from "./tool.js";
import type { ExecutionState } from "../services/execution-state.js";

export type RunAgentControlPromise = <A, E, R extends AgentControl | ExecutionState>(
	effect: Effect.Effect<A, E, R>,
) => Promise<A>;

export type RunAgentControlFork = <A, E, R extends AgentControl | ExecutionState>(
	effect: Effect.Effect<A, E, R>,
) => Fiber.Fiber<A, E>;

export interface AgentRuntimeBridgeService {
	readonly runPromise: RunAgentControlPromise;
	readonly runFork: RunAgentControlFork;
	readonly closeAll: () => Promise<void>;
}

export class AgentRuntimeBridge extends Context.Service<
	AgentRuntimeBridge,
	AgentRuntimeBridgeService
>()("AgentRuntimeBridge") {}

export const AgentRuntimeBridgeLive = (
	runPromise: RunAgentControlPromise,
	runFork: RunAgentControlFork,
) =>
	Layer.succeed(
		AgentRuntimeBridge,
		AgentRuntimeBridge.of({
			runPromise,
			runFork,
			closeAll: () =>
				runPromise(
					Effect.gen(function* () {
						const control = yield* AgentControl;
						yield* control.closeAll;
					}),
				),
		}),
	);

export function createWorkerAgentTool(
	runPromise: RunAgentControlPromise,
	context: AgentToolContext,
	description: string,
): AgentToolDef {
	return createAgentToolDef(
		(effect) => runPromise(effect),
		() => context,
		description,
	);
}
