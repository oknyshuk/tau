import * as os from "node:os";

/**
 * Tau-internal home directory resolver.
 *
 * Reads `process.env.HOME` (or `TAU_HOME`, the explicit test/runtime override)
 * afresh on every call. Falls back to `os.homedir()` if neither env var is set.
 *
 * Why this exists: Bun 1.3.14+ caches `os.homedir()` at process start. Tests
 * that use `vi.stubEnv("HOME", ...)` mutate `process.env.HOME` but never see
 * `os.homedir()` change, so any tau code that reaches for `os.homedir()`
 * silently uses the wrong path. This resolver re-reads the env each call so
 * `vi.stubEnv("HOME", ...)` Just Works.
 *
 * On Windows, `process.env.USERPROFILE` is consulted before falling back to
 * `os.homedir()`. Tau is not currently exercised on Windows, but covering the
 * common cross-platform shape costs nothing.
 *
 * Resolution order:
 *   1. TAU_HOME (explicit override)
 *   2. HOME (POSIX)
 *   3. USERPROFILE (Windows)
 *   4. os.homedir() (final fallback)
 */
export function getHomeDir(): string {
	const tauHome = process.env["TAU_HOME"];
	if (tauHome && tauHome.length > 0) return tauHome;

	const home = process.env["HOME"];
	if (home && home.length > 0) return home;

	const userProfile = process.env["USERPROFILE"];
	if (userProfile && userProfile.length > 0) return userProfile;

	return os.homedir();
}
