export type RunForkUsage = {
	readonly line: number;
	readonly column: number;
};

export function findRunForkUsages(sourceText: string, filePath: string): ReadonlyArray<RunForkUsage>;

export function collectRunForkViolations(projectRoot: string): ReadonlyArray<string>;
