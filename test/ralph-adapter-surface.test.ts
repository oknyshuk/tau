import * as fs from "node:fs";

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { RalphRepoLive } from "../src/ralph/repo.js";
import { LoopRepoLive } from "../src/loops/repo.js";
import { LoopEngineLive } from "../src/services/loop-engine.js";
import { Ralph, RalphLive } from "../src/services/ralph.js";

describe("ralph adapter surface", () => {
	it("does not expose legacy testing shims", async () => {
		const module = await import("../src/ralph/index.js");
		expect("__testing" in module).toBe(false);
	});

	it("keeps RalphService as a domain boundary without raw repo/ref primitives", async () => {
		const layer = RalphLive({
			hasActiveSubagents: () => Effect.succeed(false),
		}).pipe(
			Layer.provideMerge(RalphRepoLive),
			Layer.provideMerge(LoopEngineLive.pipe(Layer.provideMerge(LoopRepoLive))),
			Layer.provide(NodeFileSystem.layer),
		);

		const service = await Effect.runPromise(
			Effect.gen(function* () {
				return yield* Ralph;
			}).pipe(Effect.provide(layer)),
		);

		const exposed = Object.keys(service);
		expect(exposed).toContain("prepareLoopTask");
		expect(exposed).toContain("startLoopState");
		expect(exposed).toContain("pauseCurrentLoop");
		expect(exposed).not.toContain("loadState");
		expect(exposed).not.toContain("saveState");
		expect(exposed).not.toContain("writeTaskFile");
		expect(exposed).not.toContain("readTaskFile");
		expect(exposed).not.toContain("deleteState");
		expect(exposed).not.toContain("archiveLoop");
		expect(exposed).not.toContain("getCurrentLoop");
		expect(exposed).not.toContain("setCurrentLoop");
		expect(exposed).not.toContain("clearCurrentLoop");
	});

	it("does not register a ralph_create tool (task creation is skill-driven)", () => {
		const source = fs.readFileSync(new URL("../src/ralph/index.ts", import.meta.url), "utf-8");
		expect(source).not.toContain('name: "ralph_create"');
		expect(source).not.toContain('name: "ralph_start"');
		expect(source).not.toContain("ralph.writeTaskFile");
		expect(source).not.toContain("ralph.loadState");
	});
});
