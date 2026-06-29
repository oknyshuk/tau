const SQLITE_WARNING_FILTER_KEY = Symbol.for("tau.sqlite-warning-filter-installed");

function isSuppressedSqliteExperimentalWarning(
	warning: string | Error,
	type: string | undefined,
): boolean {
	if (type !== "ExperimentalWarning") return false;
	const message = typeof warning === "string" ? warning : warning.message;
	return message.includes("SQLite is an experimental feature and might change at any time");
}

export function installSqliteExperimentalWarningFilter(): void {
	const globalState = globalThis as Record<symbol, boolean | undefined>;
	if (globalState[SQLITE_WARNING_FILTER_KEY] === true) return;
	globalState[SQLITE_WARNING_FILTER_KEY] = true;

	const originalEmitWarning = process.emitWarning.bind(process);
	process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
		const type = typeof args[0] === "string" ? args[0] : undefined;
		if (isSuppressedSqliteExperimentalWarning(warning, type)) {
			return;
		}
		originalEmitWarning(warning, ...(args as []));
	}) as typeof process.emitWarning;
}
