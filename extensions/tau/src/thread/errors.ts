import { Data } from "effect";

export class ThreadCatalogError extends Data.TaggedError("ThreadCatalogError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export class ThreadNotFoundError extends Data.TaggedError("ThreadNotFoundError")<{
	readonly threadID: string;
}> {}

export class ThreadAmbiguousError extends Data.TaggedError("ThreadAmbiguousError")<{
	readonly threadID: string;
	readonly matches: ReadonlyArray<{ readonly id: string; readonly path: string }>;
}> {}

class SessionParseError extends Data.TaggedError("SessionParseError")<{
	readonly path: string;
	readonly cause: unknown;
}> {}
