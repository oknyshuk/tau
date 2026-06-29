import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { collectRunForkViolations, findRunForkUsages } from "./check-runfork-usage.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(THIS_FILE), "..");

describe("runFork guard", () => {
	it("flags Effect.runFork via an aliased Effect import", () => {
		const source = ['import { Effect as Fx } from "effect";', "Fx.runFork(Effect.void);"].join("\n");
		expect(findRunForkUsages(source, "src/feature.ts").map((usage) => usage.line)).toEqual([2]);
	});

	it("flags bracket-member runFork access", () => {
		const source = ['import { Effect } from "effect";', 'Effect["runFork"](Effect.void);'].join("\n");
		expect(findRunForkUsages(source, "src/feature.ts").map((usage) => usage.line)).toEqual([2]);
	});

	it("flags calls through aliases assigned from Effect.runFork", () => {
		const source = [
			'import { Effect } from "effect";',
			"const fork = Effect.runFork;",
			"fork(Effect.void);",
		].join("\n");
		expect(findRunForkUsages(source, "src/feature.ts").map((usage) => usage.line)).toEqual([3]);
	});

	it("does not flag runFork on a non-Effect receiver", () => {
		const source = ["const runtime = makeRuntime();", "runtime.runFork(program);"].join("\n");
		expect(findRunForkUsages(source, "src/feature.ts")).toEqual([]);
	});

	it("restricts Effect.runFork to src/app.ts across the real source tree", () => {
		expect(collectRunForkViolations(PROJECT_ROOT)).toEqual([]);
	});
});
