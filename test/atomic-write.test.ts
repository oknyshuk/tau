import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, FileSystem } from "effect";

import {
	StorageError,
	atomicWriteFileString,
	atomicWriteFileStringSync,
} from "../src/shared/atomic-write.js";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "tau-atomic-write-"));
}

describe("atomicWriteFileString", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("writes content to the target path and leaves no temp files behind", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const targetPath = path.join(cwd, "nested", "state.json");

		await Effect.runPromise(
			Effect.gen(function* () {
				const fileSystem = yield* FileSystem.FileSystem;
				yield* atomicWriteFileString(fileSystem, targetPath, '{"ok":true}\n');
			}).pipe(Effect.provide(NodeFileSystem.layer)),
		);

		expect(fs.readFileSync(targetPath, "utf8")).toBe('{"ok":true}\n');
		expect(
			fs.readdirSync(path.dirname(targetPath)).filter((entry) => entry.startsWith(".tmp-")),
		).toEqual([]);
	});

	it("cleans up the temp file when the final rename fails", async () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const targetPath = path.join(cwd, "target-dir");
		fs.mkdirSync(targetPath, { recursive: true });

		await expect(
			Effect.runPromise(
				Effect.gen(function* () {
					const fileSystem = yield* FileSystem.FileSystem;
					yield* atomicWriteFileString(fileSystem, targetPath, "content\n");
				}).pipe(Effect.provide(NodeFileSystem.layer)),
			),
		).rejects.toMatchObject({
			_tag: "StorageError",
			operation: "rename-file",
			path: targetPath,
		});

		expect(fs.readdirSync(cwd).sort()).toEqual(["target-dir"]);
	});

	it("exposes failures as StorageError", () => {
		const error = new StorageError({
			operation: "write-file",
			path: "/tmp/test",
			reason: "Failed to write file",
			cause: new Error("boom"),
		});

		expect(error._tag).toBe("StorageError");
		expect(error.path).toBe("/tmp/test");
	});

	it("supports sync atomic writes for non-Effect callers", () => {
		const cwd = makeTempDir();
		tempDirs.push(cwd);
		const targetPath = path.join(cwd, "sync", "state.json");

		atomicWriteFileStringSync(targetPath, '{"sync":true}\n');

		expect(fs.readFileSync(targetPath, "utf8")).toBe('{"sync":true}\n');
		expect(
			fs.readdirSync(path.dirname(targetPath)).filter((entry) => entry.startsWith(".tmp-")),
		).toEqual([]);
	});
});
