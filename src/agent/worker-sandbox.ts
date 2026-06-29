import type { ResolvedSandboxConfig } from "../sandbox/config.js";
import type { ExecutionSessionState } from "../execution/schema.js";
import type { TauPersistedState } from "../shared/state.js";
import { mergePersistedState } from "../shared/state.js";

export function withWorkerSandboxOverride(
	base: TauPersistedState,
	override: ResolvedSandboxConfig,
	executionState: ExecutionSessionState,
): TauPersistedState {
	const sandboxPatch: Record<string, unknown> = { sessionOverride: override };
	return mergePersistedState(base, {
		sandbox: sandboxPatch,
		execution: {
			policy: executionState.policy,
		},
	});
}
