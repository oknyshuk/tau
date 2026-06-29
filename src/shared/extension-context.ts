import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Detect the pi 0.70+ stale-extension-context error.
 *
 * Pi invalidates captured `ctx`/`pi` after `ctx.newSession`/`ctx.fork`/
 * `ctx.switchSession`/`ctx.reload`. Subsequent session-bound accesses on the
 * old ctx throw with this message. Helpers in this module use the predicate to
 * tolerate stale-ctx access in best-effort code paths (notifications, session
 * file lookup, etc.) while keeping unrelated errors observable.
 */
export function isStaleExtensionContextError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("This extension ctx is stale after session replacement or reload");
}

/**
 * Detect tau's ManagedRuntime disposal error. Effect interrupts in-flight
 * fibers when the runtime is disposed (process quit), surfacing either
 * "ManagedRuntime disposed" or "All fibers interrupted without error".
 */
export function isManagedRuntimeDisposedError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("ManagedRuntime disposed") ||
		message.includes("All fibers interrupted without error")
	);
}

/** Combined predicate for "session ctx no longer usable" — stale or disposed. */
export function isIgnorableSessionContextError(error: unknown): boolean {
	return isManagedRuntimeDisposedError(error) || isStaleExtensionContextError(error);
}

/** Read `sessionManager.getSessionFile()`; return undefined if ctx is stale or disposed. */
export function sessionFileFromContextIfLive(
	ctx: Pick<ExtensionContext, "sessionManager">,
): string | undefined {
	try {
		return typeof ctx.sessionManager.getSessionFile === "function"
			? ctx.sessionManager.getSessionFile()
			: undefined;
	} catch (error) {
		if (isIgnorableSessionContextError(error)) return undefined;
		throw error;
	}
}

/** Read `ctx.cwd`; return undefined if ctx is stale or disposed. */
export function cwdFromContextIfLive(ctx: Pick<ExtensionContext, "cwd">): string | undefined {
	try {
		return ctx.cwd;
	} catch (error) {
		if (isIgnorableSessionContextError(error)) return undefined;
		throw error;
	}
}
