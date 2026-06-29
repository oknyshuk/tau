/**
 * Process-global registry of tau ManagedRuntimes.
 *
 * pi re-runs the extension factory (`startTau`) on every session replacement
 * (`/new`, `/resume`, `/fork`, `switchSession`, `/reload`), each time building a
 * fresh `ManagedRuntime` bound to the new session's `pi` instance (the services
 * capture `pi` and register `pi.on` handlers at layer construction, so a runtime
 * cannot be reused across `pi` instances). Without cleanup the prior runtimes —
 * their layer stacks, the `Effect.never` root fiber, and forked daemon loops —
 * accumulate for the whole process lifetime and keep ticking against a stale
 * `pi`.
 *
 * The prior runtime cannot simply be disposed on `session_shutdown`: a Ralph
 * loop runs as a single `runPromise` anchored to the runtime that started it and
 * spans many replacements (it drives each new session through `withSession`).
 * Disposing it mid-loop would interrupt Ralph.
 *
 * This registry tracks in-flight `runPromise` work per runtime and, on each
 * `session_shutdown`, reaps every non-current runtime with no in-flight work, so
 * idle orphans are reclaimed (bounded to roughly the current runtime plus one)
 * instead of growing without bound. Background `runFork` daemons (e.g. the goal
 * ticker's `while (true)` loop) are intentionally NOT tracked — they never
 * settle and are meant to die when their runtime is disposed.
 */

const REGISTRY_KEY = Symbol.for("tau/runtime-registry");

/** Minimal structural view of a ManagedRuntime — only disposal is needed here. */
interface DisposableRuntime {
	readonly dispose: () => Promise<void>;
}

export interface RuntimeEntry {
	readonly runtime: DisposableRuntime;
	inFlight: number;
	disposed: boolean;
}

interface RuntimeRegistry {
	entries: RuntimeEntry[];
	current: RuntimeEntry | undefined;
}

function registry(): RuntimeRegistry {
	const store = globalThis as Record<symbol, RuntimeRegistry | undefined>;
	return (store[REGISTRY_KEY] ??= { entries: [], current: undefined });
}

/** Register a freshly created runtime and mark it the current (active) one. */
export function registerTauRuntime(runtime: DisposableRuntime): RuntimeEntry {
	const reg = registry();
	const entry: RuntimeEntry = { runtime, inFlight: 0, disposed: false };
	reg.entries.push(entry);
	reg.current = entry;
	return entry;
}

/**
 * Run a promise while counting it as in-flight work on `entry`'s runtime, so a
 * sweep never disposes a runtime that still has a pending `runPromise` (e.g. a
 * running Ralph loop). Only `runPromise` edges are tracked; `runFork` daemons
 * are deliberately excluded.
 */
export function trackRunPromise<A>(entry: RuntimeEntry, run: () => Promise<A>): Promise<A> {
	entry.inFlight += 1;
	let promise: Promise<A>;
	try {
		promise = run();
	} catch (error) {
		entry.inFlight -= 1;
		throw error;
	}
	return promise.finally(() => {
		entry.inFlight -= 1;
	});
}

function disposeEntry(entry: RuntimeEntry): void {
	if (entry.disposed) return;
	// Mark + unregister synchronously so a concurrent sweep or the quit path
	// cannot double-dispose; the async dispose itself is fire-and-forget.
	entry.disposed = true;
	const reg = registry();
	reg.entries = reg.entries.filter((candidate) => candidate !== entry);
	if (reg.current === entry) reg.current = undefined;
	void entry.runtime.dispose().catch(() => undefined);
}

/**
 * Dispose every non-current runtime that has no in-flight `runPromise` work.
 * Called from the `session_shutdown` handler for replacement reasons.
 */
export function sweepTauRuntimes(): void {
	const reg = registry();
	for (const entry of [...reg.entries]) {
		if (entry === reg.current || entry.inFlight > 0) continue;
		disposeEntry(entry);
	}
}

/** Dispose all registered runtimes. Used on terminal quit (and test cleanup). */
export function disposeAllTauRuntimes(): void {
	const reg = registry();
	for (const entry of [...reg.entries]) disposeEntry(entry);
	reg.current = undefined;
}

/** Count of live (registered, not-yet-disposed) runtimes. For tests/diagnostics. */
export function liveTauRuntimeCount(): number {
	return registry().entries.length;
}
