export type AnyRecord = Record<string, unknown>;

export function isRecord(v: unknown): v is AnyRecord {
	return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Deep merge for plain objects; arrays are replaced. */
export function deepMerge<T>(base: T, patch: unknown): T {
	if (patch === undefined) return base;
	if (base === undefined) return patch as T;
	if (!isRecord(base) || !isRecord(patch)) return patch as T;

	const out: AnyRecord = { ...base };

	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		out[k] = deepMerge(base[k], v);
	}

	return out as T;
}
