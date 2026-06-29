import { describe, expect, it } from "vitest";

import { isSafeCommand } from "../src/sandbox/safe-commands.js";

describe("isSafeCommand: jj read-only inspection", () => {
	it("allows top-level read-only subcommands", () => {
		expect(isSafeCommand("jj status")).toBe(true);
		expect(isSafeCommand("jj st")).toBe(true);
		expect(isSafeCommand("jj log")).toBe(true);
		expect(isSafeCommand("jj log -n 5")).toBe(true);
		expect(isSafeCommand("jj diff")).toBe(true);
		expect(isSafeCommand("jj diff --stat")).toBe(true);
		expect(isSafeCommand("jj show @-")).toBe(true);
		expect(isSafeCommand("jj evolog -r @")).toBe(true);
		expect(isSafeCommand("jj interdiff")).toBe(true);
		expect(isSafeCommand("jj cat foo.txt")).toBe(true);
	});

	it("allows safe nested subcommands for dispatcher commands", () => {
		expect(isSafeCommand("jj bookmark list")).toBe(true);
		expect(isSafeCommand("jj b list")).toBe(true);
		expect(isSafeCommand("jj b l")).toBe(true);
		expect(isSafeCommand("jj op log")).toBe(true);
		expect(isSafeCommand("jj op show")).toBe(true);
		expect(isSafeCommand("jj operation log")).toBe(true);
		expect(isSafeCommand("jj workspace list")).toBe(true);
		expect(isSafeCommand("jj workspace root")).toBe(true);
		expect(isSafeCommand("jj file show src/foo.ts")).toBe(true);
		expect(isSafeCommand("jj file list")).toBe(true);
		expect(isSafeCommand("jj file annotate src/foo.ts")).toBe(true);
		expect(isSafeCommand("jj config list")).toBe(true);
		expect(isSafeCommand("jj config get user.name")).toBe(true);
	});

	it("rejects mutating top-level subcommands", () => {
		expect(isSafeCommand("jj describe -m foo")).toBe(false);
		expect(isSafeCommand("jj ci -m foo")).toBe(false);
		expect(isSafeCommand("jj commit -m foo")).toBe(false);
		expect(isSafeCommand("jj squash")).toBe(false);
		expect(isSafeCommand("jj split")).toBe(false);
		expect(isSafeCommand("jj rebase -d main")).toBe(false);
		expect(isSafeCommand("jj abandon")).toBe(false);
		expect(isSafeCommand("jj edit @-")).toBe(false);
		expect(isSafeCommand("jj new")).toBe(false);
		expect(isSafeCommand("jj absorb")).toBe(false);
		expect(isSafeCommand("jj undo")).toBe(false);
		expect(isSafeCommand("jj resolve")).toBe(false);
		expect(isSafeCommand("jj fix")).toBe(false);
		expect(isSafeCommand("jj duplicate")).toBe(false);
		expect(isSafeCommand("jj parallelize")).toBe(false);
		expect(isSafeCommand("jj restore")).toBe(false);
	});

	it("rejects mutating nested subcommands on dispatchers", () => {
		expect(isSafeCommand("jj bookmark set foo")).toBe(false);
		expect(isSafeCommand("jj b s foo")).toBe(false);
		expect(isSafeCommand("jj b a")).toBe(false);
		expect(isSafeCommand("jj b c bar")).toBe(false);
		expect(isSafeCommand("jj b d old")).toBe(false);
		expect(isSafeCommand("jj op restore xyz")).toBe(false);
		expect(isSafeCommand("jj op undo")).toBe(false);
		expect(isSafeCommand("jj workspace add ../other")).toBe(false);
		expect(isSafeCommand("jj workspace forget")).toBe(false);
		expect(isSafeCommand("jj file track foo")).toBe(false);
		expect(isSafeCommand("jj file untrack foo")).toBe(false);
		expect(isSafeCommand("jj config set user.name x")).toBe(false);
		expect(isSafeCommand("jj config edit")).toBe(false);
	});

	it("blocks all `jj git` even read-looking ones (push/fetch are network/mutating)", () => {
		expect(isSafeCommand("jj git push")).toBe(false);
		expect(isSafeCommand("jj git fetch")).toBe(false);
		expect(isSafeCommand("jj git push -c @")).toBe(false);
		expect(isSafeCommand("jj git remote list")).toBe(false);
	});

	it("rejects unsafe global flags regardless of subcommand", () => {
		expect(isSafeCommand("jj --config foo=bar log")).toBe(false);
		expect(isSafeCommand("jj --config-toml 'a=1' log")).toBe(false);
		expect(isSafeCommand("jj --at-op abc log")).toBe(false);
		expect(isSafeCommand("jj --ignore-immutable st")).toBe(false);
		expect(isSafeCommand("jj log --config=hooks.foo='rm -rf /'")).toBe(false);
		expect(isSafeCommand("jj log --config-toml='ui.editor=evil'")).toBe(false);
		expect(isSafeCommand("jj log --at-op=xyz")).toBe(false);
	});

	it("rejects bare `jj` and unknown subcommands", () => {
		expect(isSafeCommand("jj")).toBe(false);
		expect(isSafeCommand("jj wat")).toBe(false);
		expect(isSafeCommand("jj bookmark")).toBe(false);
		expect(isSafeCommand("jj op")).toBe(false);
	});

	it("rejects shell injection in jj args", () => {
		expect(isSafeCommand("jj log $(rm -rf /)")).toBe(false);
		expect(isSafeCommand("jj log `evil`")).toBe(false);
		expect(isSafeCommand("jj log > /tmp/out")).toBe(false);
	});

	it("allows piping jj log to grep (both segments safe)", () => {
		expect(isSafeCommand("jj log | grep main")).toBe(true);
	});

	it("rejects piping jj log to a mutating command", () => {
		expect(isSafeCommand("jj log | jj describe -m x")).toBe(false);
	});

	it("regression: existing git rules still work", () => {
		expect(isSafeCommand("git status")).toBe(true);
		expect(isSafeCommand("git diff")).toBe(true);
		expect(isSafeCommand("git commit -m foo")).toBe(false);
		expect(isSafeCommand("git push")).toBe(false);
	});
});
