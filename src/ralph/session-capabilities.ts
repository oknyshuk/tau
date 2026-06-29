type ActiveToolReader = {
	readonly getActiveTools: () => ReadonlyArray<string>;
};

type ActiveToolWriter = {
	readonly setActiveTools: (toolNames: string[]) => void;
};

const preRalphActiveToolsBySessionFile = new Map<string, ReadonlyArray<string>>();

function hasActiveToolReader(value: unknown): value is ActiveToolReader {
	return (
		typeof value === "object" &&
		value !== null &&
		"getActiveTools" in value &&
		typeof value.getActiveTools === "function"
	);
}

function hasActiveToolWriter(value: unknown): value is ActiveToolWriter {
	return (
		typeof value === "object" &&
		value !== null &&
		"setActiveTools" in value &&
		typeof value.setActiveTools === "function"
	);
}

export function capturePreRalphActiveTools(
	sessionFile: string | undefined,
	runtime: unknown,
): boolean {
	if (sessionFile === undefined || preRalphActiveToolsBySessionFile.has(sessionFile)) {
		return false;
	}
	if (!hasActiveToolReader(runtime)) {
		return false;
	}

	preRalphActiveToolsBySessionFile.set(sessionFile, [...runtime.getActiveTools()]);
	return true;
}

export function restorePreRalphActiveTools(
	sessionFile: string | undefined,
	runtime: unknown,
): boolean {
	if (sessionFile === undefined || !hasActiveToolWriter(runtime)) {
		return false;
	}

	const activeTools = preRalphActiveToolsBySessionFile.get(sessionFile);
	if (activeTools === undefined) {
		return false;
	}

	runtime.setActiveTools([...activeTools]);
	preRalphActiveToolsBySessionFile.delete(sessionFile);
	return true;
}

export function clearPreRalphActiveToolSnapshots(sessionFile?: string): void {
	if (sessionFile === undefined) {
		preRalphActiveToolsBySessionFile.clear();
		return;
	}
	preRalphActiveToolsBySessionFile.delete(sessionFile);
}
