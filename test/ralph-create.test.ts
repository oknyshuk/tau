import { afterEach, describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Layer, ManagedRuntime } from "effect";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import initRalph from "../src/ralph/index.js";
import { RalphRepoLive } from "../src/ralph/repo.js";
import { LoopRepoLive } from "../src/loops/repo.js";
import { LoopEngineLive } from "../src/services/loop-engine.js";
import {
	Ralph,
	RalphLive,
	resetRalphIterationSignalBridgeForTests,
} from "../src/services/ralph.js";
import { ExecutionRuntime } from "../src/services/execution-runtime.js";
import { Effect } from "effect";
import { makeExecutionRuntimeStubLayer } from "./ralph-test-helpers.js";
import { makeFakeCommandContext } from "./fake-command-context.js";

type RalphCommand = {
	readonly handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

const runtimes: Array<{ dispose: () => Promise<void> }> = [];

/**
 * `/ralph create` only checks for an existing task file and delegates authoring
 * to the model via pi.sendUserMessage; it never mutates loop state. The handler
 * still syncs handshake tools through the runtime in its `finally`, so a real
 * (empty) Ralph runtime is provided: with no loops under the temp cwd it
 * resolves to "no active loop" cleanly.
 */
function makeRalphRun(): <A, E>(
	effect: Effect.Effect<A, E, Ralph | ExecutionRuntime>,
) => Promise<A> {
	const layer = RalphLive({
		hasActiveSubagents: () => Effect.succeed(false),
	}).pipe(
		Layer.provideMerge(RalphRepoLive),
		Layer.provideMerge(LoopEngineLive.pipe(Layer.provideMerge(LoopRepoLive))),
		Layer.provideMerge(makeExecutionRuntimeStubLayer()),
		Layer.provide(NodeFileSystem.layer),
	);
	const runtime = ManagedRuntime.make(layer);
	runtimes.push({ dispose: () => runtime.dispose() });
	return (effect) => runtime.runPromise(effect);
}

function makeRalphPiHarness(): {
	readonly pi: ExtensionAPI;
	readonly command: () => RalphCommand;
	readonly sentUserMessages: string[];
} {
	const commands = new Map<string, RalphCommand>();
	const sentUserMessages: string[] = [];
	const base = {
		on: () => undefined,
		registerCommand: (name: string, command: RalphCommand) => {
			commands.set(name, command);
		},
		registerTool: () => undefined,
		registerShortcut: () => undefined,
		registerFlag: () => undefined,
		registerMessageRenderer: () => undefined,
		sendUserMessage: (content: string) => {
			sentUserMessages.push(content);
		},
		sendMessage: () => undefined,
		appendEntry: () => undefined,
		getActiveTools: () => [],
		setActiveTools: () => undefined,
		getAllTools: () => [],
		getCommands: () => [],
		refreshTools: () => undefined,
		events: { emit: () => undefined, on: () => () => undefined },
	};
	const pi = new Proxy(base, {
		get(target, prop, receiver) {
			if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
			return () => undefined;
		},
	}) as unknown as ExtensionAPI;
	return {
		pi,
		command: () => {
			const command = commands.get("ralph");
			if (command === undefined) throw new Error("ralph command not registered");
			return command;
		},
		sentUserMessages,
	};
}

describe("/ralph create", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		resetRalphIterationSignalBridgeForTests();
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		for (const runtime of runtimes.splice(0)) {
			await runtime.dispose();
		}
	});

	function makeCwd(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tau-ralph-create-"));
		tempDirs.push(dir);
		return dir;
	}

	it("delegates task-file authoring to the current model for a fresh name", async () => {
		const harness = makeRalphPiHarness();
		initRalph(harness.pi, makeRalphRun());
		const cwd = makeCwd();
		const fake = makeFakeCommandContext({ cwd });

		await harness.command().handler("create my-feature draft the thing", fake.ctx);

		expect(harness.sentUserMessages).toHaveLength(1);
		const prompt = harness.sentUserMessages[0] ?? "";
		expect(prompt).toContain(path.join(".pi", "loops", "tasks", "my-feature.md"));
		expect(prompt).toContain("ralph-loop-creation");
		expect(prompt).toContain("backlog show my-feature");
		expect(prompt).toContain("/ralph start my-feature");
		expect(prompt).toContain("draft the thing");

		expect(fake.notifications.some((n) => n.level === "info")).toBe(true);
	});

	it("refuses to overwrite an existing task file", async () => {
		const harness = makeRalphPiHarness();
		initRalph(harness.pi, makeRalphRun());
		const cwd = makeCwd();
		const taskDir = path.join(cwd, ".pi", "loops", "tasks");
		fs.mkdirSync(taskDir, { recursive: true });
		fs.writeFileSync(path.join(taskDir, "exists.md"), "# existing\n", "utf-8");
		const fake = makeFakeCommandContext({ cwd });

		await harness.command().handler("create exists", fake.ctx);

		expect(harness.sentUserMessages).toHaveLength(0);
		expect(
			fake.notifications.some(
				(n) => n.level === "warning" && n.message.includes("already exists"),
			),
		).toBe(true);
	});

	it("reports usage when no name is given", async () => {
		const harness = makeRalphPiHarness();
		initRalph(harness.pi, makeRalphRun());
		const cwd = makeCwd();
		const fake = makeFakeCommandContext({ cwd });

		await harness.command().handler("create", fake.ctx);

		expect(harness.sentUserMessages).toHaveLength(0);
		expect(
			fake.notifications.some((n) => n.level === "warning" && n.message.includes("Usage:")),
		).toBe(true);
	});
});
