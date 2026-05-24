import { Clock, Effect } from "effect";

/** Current wall-clock time as an ISO 8601 string, sourced from the Effect Clock. */
export const nowIso = Effect.gen(function* () {
	const millis = yield* Clock.currentTimeMillis;
	return new Date(millis).toISOString();
});
