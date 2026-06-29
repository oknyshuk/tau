import { Effect, Layer } from "effect";

import {
	type ExecutionProfile,
	DEFAULT_EXECUTION_POLICY,
} from "../src/execution/schema.js";
import { DEFAULT_SANDBOX_CONFIG, type ResolvedSandboxConfig } from "../src/sandbox/config.js";
import { ExecutionRuntime } from "../src/services/execution-runtime.js";
import { emptyRalphLoopMetrics, type RalphLoopMetrics } from "../src/ralph/schema.js";
import { makeEmptyCapabilityContract, type RalphCapabilityContract } from "../src/ralph/contract.js";

export function makeExecutionProfile(overrides?: Partial<ExecutionProfile>): ExecutionProfile {
	return {
		model: "anthropic/claude-opus-4-5",
		thinking: "medium",
		policy: DEFAULT_EXECUTION_POLICY,
		...overrides,
	};
}

export function makeExecutionRuntimeStubLayer(profile: ExecutionProfile = makeExecutionProfile()) {
	return Layer.succeed(
		ExecutionRuntime,
		ExecutionRuntime.of({
			setup: Effect.void,
			captureCurrentExecutionProfile: () => Effect.succeed(profile),
			applyExecutionProfile: (nextProfile) =>
				Effect.succeed({
					applied: true as const,
					profile: nextProfile,
				}),
		}),
	);
}

export function makeSandboxProfile(): ResolvedSandboxConfig {
	return DEFAULT_SANDBOX_CONFIG;
}

export function makeRalphMetrics(): RalphLoopMetrics {
	return emptyRalphLoopMetrics();
}

export function makeCapabilityContract(): RalphCapabilityContract {
	return makeEmptyCapabilityContract();
}
