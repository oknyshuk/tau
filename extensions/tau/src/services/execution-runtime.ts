import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer, Context } from "effect";

import { isExecutionThinkingLevel } from "../agent/model-spec.js";
import { PiAPI } from "../effect/pi.js";
import {
	type ExecutionProfile,
	makeExecutionProfile,
} from "../execution/schema.js";
import { readModelId } from "../prompt/profile.js";
import { parseProviderModel } from "../shared/model-id.js";
import { ExecutionState } from "./execution-state.js";

export type ExecutionApplyResult =
	| {
			readonly applied: true;
			readonly profile: ExecutionProfile;
	  }
	| {
			readonly applied: false;
			readonly reason: string;
	  };

export type ExecutionApplyOptions = {
	readonly notifyOnSuccess?: boolean;
	readonly persist?: boolean;
	readonly ephemeral?: boolean;
};

export interface ExecutionRuntime {
	readonly setup: Effect.Effect<void>;
	readonly captureCurrentExecutionProfile: (
		ctx: Pick<ExtensionContext, "model">,
	) => Effect.Effect<ExecutionProfile | null>;
	readonly applyExecutionProfile: (
		profile: ExecutionProfile,
		ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "ui">,
		options?: ExecutionApplyOptions,
	) => Effect.Effect<ExecutionApplyResult>;
}

export const ExecutionRuntime = Context.Service<ExecutionRuntime>("ExecutionRuntime");

function currentThinkingLevel(pi: ExtensionAPI): ThinkingLevel | undefined {
	const current = pi.getThinkingLevel();
	if (!isExecutionThinkingLevel(current)) {
		return undefined;
	}
	return current;
}

function makeApplyFailure(reason: string): ExecutionApplyResult {
	return { applied: false, reason };
}

export const ExecutionRuntimeLive = Layer.effect(
	ExecutionRuntime,
	Effect.gen(function* () {
		const pi = yield* PiAPI;
		const executionState = yield* ExecutionState;

		const applyExecutionState = (
			patch: Parameters<typeof executionState.update>[0],
			options?: { readonly persist?: boolean; readonly ephemeral?: boolean },
		): void => {
			if (options?.ephemeral === true) {
				return;
			}

			const apply = options?.persist === false ? executionState.hydrate : executionState.update;
			apply(patch);
		};

		const captureRuntimeProfile = (
			ctx: Pick<ExtensionContext, "model">,
		): ExecutionProfile | null => {
			const model = readModelId(ctx.model);
			if (model === undefined) {
				return null;
			}
			const thinking = currentThinkingLevel(pi);
			if (thinking === undefined) {
				return null;
			}
			return makeExecutionProfile({
				model,
				thinking,
				policy: executionState.getSnapshot().policy,
			});
		};

		const captureCurrentExecutionProfile: ExecutionRuntime["captureCurrentExecutionProfile"] = (ctx) =>
			Effect.sync(() => {
				return captureRuntimeProfile(ctx);
			});

		const notifyApplyFailure = (
			ctx: Pick<ExtensionContext, "ui">,
			reason: string,
		): ExecutionApplyResult => {
			ctx.ui.notify(reason, "error");
			return makeApplyFailure(reason);
		};

		const applyResolvedProfile = async (
			profile: ExecutionProfile,
			ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "ui">,
			options?: ExecutionApplyOptions,
		): Promise<ExecutionApplyResult> => {
			const currentModel = readModelId(ctx.model);
			const forceModelSelect = options?.ephemeral === true;
			if (forceModelSelect || currentModel !== profile.model) {
				const parsed = parseProviderModel(profile.model);
				if (!parsed) {
					return notifyApplyFailure(ctx, `Invalid execution model id: ${profile.model}`);
				}

				const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
				if (!model) {
					return notifyApplyFailure(
						ctx,
						`Execution model not found: ${profile.model}`,
					);
				}

				const ok = await pi.setModel(model);
				if (!ok) {
					return notifyApplyFailure(
						ctx,
						`No auth available for execution model: ${profile.model}`,
					);
				}
			}

			if (currentThinkingLevel(pi) !== profile.thinking) {
				pi.setThinkingLevel(profile.thinking);
			}

			const modeStateOptions =
				options === undefined
					? undefined
					: {
						...(options.persist === undefined ? {} : { persist: options.persist }),
						...(options.ephemeral === undefined
							? {}
							: { ephemeral: options.ephemeral }),
					  };

			applyExecutionState({ policy: profile.policy }, modeStateOptions);

			if (options?.notifyOnSuccess) {
				ctx.ui.notify(`Execution profile: ${profile.model} (${profile.thinking})`, "info");
			}

			return {
				applied: true,
				profile,
			};
		};

		const applyExecutionProfile: ExecutionRuntime["applyExecutionProfile"] =
			(profile, ctx, options) =>
				Effect.promise(() => applyResolvedProfile(profile, ctx, options));

		const setup = Effect.void;

		return ExecutionRuntime.of({
			setup,
			captureCurrentExecutionProfile,
			applyExecutionProfile,
		});
	}),
);
