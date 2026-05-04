import { describe, expect, it } from "vitest";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { __test__ } from "../src/sandbox/apply-patch.js";

async function withTempDir<A>(fn: (dir: string) => Promise<A>): Promise<A> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tau-apply-patch-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function patchContent(fileName: string, input: string, patchText: string): Promise<string> {
	return withTempDir(async (cwd) => {
		const filePath = path.join(cwd, fileName);
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		await fs.writeFile(filePath, input, "utf8");
		const operations = __test__.rewriteInputToOperations(cwd, patchText);
		await __test__.applyResolvedPatch(operations, cwd);
		return fs.readFile(filePath, "utf8");
	});
}

function patchContentDirect(input: string, patchText: string): string {
	const parsed = __test__.parsePatch(patchText);
	if (parsed.hunks.length !== 1 || parsed.hunks[0]?.type !== "update") {
		throw new Error("patchContentDirect requires a single update hunk");
	}
	return __test__.derivePatchedContent(input, parsed.hunks[0].chunks);
}

describe("apply_patch", () => {
	describe("parser", () => {
		it("adds a new file", async () => {
			await withTempDir(async (cwd) => {
				const operations = __test__.rewriteInputToOperations(
					cwd,
					[
						"*** Begin Patch",
						"*** Add File: hello.txt",
						"+hello",
						"+world",
						"*** End Patch",
					].join("\n"),
				);

				const summary = await __test__.applyResolvedPatch(operations, cwd);
				expect(summary.added).toEqual(["hello.txt"]);
				expect(summary.modified).toEqual([]);
				expect(summary.deleted).toEqual([]);
				expect(summary.diffs).toHaveLength(1);
				expect(summary.diffs[0]?.filePath).toBe("hello.txt");
				expect(await fs.readFile(path.join(cwd, "hello.txt"), "utf8")).toBe("hello\nworld\n");
			});
		});

		it("updates and moves a file", async () => {
			await withTempDir(async (cwd) => {
				await fs.writeFile(path.join(cwd, "src.txt"), "line\n", "utf8");

				const operations = __test__.rewriteInputToOperations(
					cwd,
					[
						"*** Begin Patch",
						"*** Update File: src.txt",
						"*** Move to: dst.txt",
						"@@",
						"-line",
						"+line2",
						"*** End Patch",
					].join("\n"),
				);

				const summary = await __test__.applyResolvedPatch(operations, cwd);
				expect(summary.added).toEqual([]);
				expect(summary.modified).toEqual(["dst.txt"]);
				expect(summary.deleted).toEqual([]);
				expect(summary.diffs).toHaveLength(1);
				expect(summary.diffs[0]?.filePath).toBe("dst.txt");
				expect(await fs.readFile(path.join(cwd, "dst.txt"), "utf8")).toBe("line2\n");
				await expect(fs.stat(path.join(cwd, "src.txt"))).rejects.toThrow();
			});
		});

		it("deletes a file", async () => {
			await withTempDir(async (cwd) => {
				await fs.writeFile(path.join(cwd, "dead.txt"), "gone\n", "utf8");

				const operations = __test__.rewriteInputToOperations(
					cwd,
					[
						"*** Begin Patch",
						"*** Delete File: dead.txt",
						"*** End Patch",
					].join("\n"),
				);

				const summary = await __test__.applyResolvedPatch(operations, cwd);
				expect(summary.added).toEqual([]);
				expect(summary.modified).toEqual([]);
				expect(summary.deleted).toEqual(["dead.txt"]);
				expect(summary.diffs).toHaveLength(1);
				expect(summary.diffs[0]?.filePath).toBe("dead.txt");
				await expect(fs.stat(path.join(cwd, "dead.txt"))).rejects.toThrow();
			});
		});

		it("fails fast on invalid absolute paths", async () => {
			await withTempDir(async (cwd) => {
				expect(() =>
					__test__.rewriteInputToOperations(
						cwd,
						[
							"*** Begin Patch",
							"*** Add File: /tmp/nope.txt",
							"+bad",
							"*** End Patch",
						].join("\n"),
					),
				).toThrow(/file paths must be relative/);
			});
		});

		it("preserves leading @ in scoped-package paths", async () => {
			await withTempDir(async (cwd) => {
				const operations = __test__.rewriteInputToOperations(
					cwd,
					[
						"*** Begin Patch",
						"*** Add File: @types/node/index.d.ts",
						"+declare module 'node';",
						"*** End Patch",
					].join("\n"),
				);

				const summary = await __test__.applyResolvedPatch(operations, cwd);
				expect(summary.added).toEqual(["@types/node/index.d.ts"]);
				expect(summary.modified).toEqual([]);
				expect(summary.deleted).toEqual([]);
				expect(summary.diffs).toHaveLength(1);
				expect(summary.diffs[0]?.filePath).toBe("@types/node/index.d.ts");
				expect(
					await fs.readFile(path.join(cwd, "@types/node/index.d.ts"), "utf8"),
				).toBe("declare module 'node';\n");
			});
		});

		it("inserts lines at context position, not EOF", async () => {
			await withTempDir(async (cwd) => {
				await fs.writeFile(
					path.join(cwd, "src.ts"),
					["import { a } from 'a';", "", "const x = 1;", ""].join("\n"),
					"utf8",
				);

				const operations = __test__.rewriteInputToOperations(
					cwd,
					[
						"*** Begin Patch",
						"*** Update File: src.ts",
						"@@ import { a } from 'a';",
						"+import { b } from 'b';",
						"*** End Patch",
					].join("\n"),
				);

				const summary = await __test__.applyResolvedPatch(operations, cwd);
				expect(summary.modified).toEqual(["src.ts"]);
				const contents = await fs.readFile(path.join(cwd, "src.ts"), "utf8");
				const lines = contents.split("\n");
				expect(lines[1]).toBe("import { b } from 'b';");
			});
		});

		it("rejects add-file when target already exists", async () => {
			await withTempDir(async (cwd) => {
				await fs.writeFile(path.join(cwd, "existing.txt"), "original\n", "utf8");

				const operations = __test__.rewriteInputToOperations(
					cwd,
					[
						"*** Begin Patch",
						"*** Add File: existing.txt",
						"+overwritten",
						"*** End Patch",
					].join("\n"),
				);

				await expect(__test__.applyResolvedPatch(operations, cwd)).rejects.toThrow(
					/file already exists/,
				);
				expect(await fs.readFile(path.join(cwd, "existing.txt"), "utf8")).toBe("original\n");
			});
		});

		it("parses wrapped patches without an end marker at EOF", () => {
			const result = __test__.parsePatch(
				[
					"*** Begin Patch",
					"*** Update File: src/ExaSearch.ts",
					"@@",
					" export class ExaSearch extends Context.Service<",
					"   ExaSearch,",
					"   {",
					"-    search(query: string): Effect.Effect<Array<SearchResponse<{}>>, ExaError>",
					"+    search(query: string): Effect.Effect<SearchResponse<{}>, ExaError>",
					"   }",
					' >()("clanka/ExaSearch") {}',
				].join("\n"),
			);
			expect(result.hunks).toEqual([
				{
					type: "update",
					path: "src/ExaSearch.ts",
					chunks: [
						{
							oldLines: [
								"export class ExaSearch extends Context.Service<",
								"  ExaSearch,",
								"  {",
								"    search(query: string): Effect.Effect<Array<SearchResponse<{}>>, ExaError>",
								"  }",
								'>()("clanka/ExaSearch") {}',
							],
							newLines: [
								"export class ExaSearch extends Context.Service<",
								"  ExaSearch,",
								"  {",
								"    search(query: string): Effect.Effect<SearchResponse<{}>, ExaError>",
								"  }",
								'>()("clanka/ExaSearch") {}',
							],
							isEndOfFile: false,
						},
					],
				},
			]);
		});

		it("parses multi-file wrapped patches", () => {
			const result = __test__.parsePatch(
				[
					"*** Begin Patch",
					"*** Add File: hello.txt",
					"+Hello world",
					"*** Update File: src/app.ts",
					"*** Move to: src/main.ts",
					"@@ keep",
					" keep",
					"-old",
					"+new",
					"*** Delete File: obsolete.txt",
					"*** End Patch",
				].join("\n"),
			);
			expect(result.hunks).toEqual([
				{
					type: "add",
					path: "hello.txt",
					contents: "Hello world\n",
				},
				{
					type: "update",
					path: "src/app.ts",
					movePath: "src/main.ts",
					chunks: [
						{
							changeContext: "keep",
							oldLines: ["keep", "old"],
							newLines: ["keep", "new"],
							isEndOfFile: false,
						},
					],
				},
				{
					type: "delete",
					path: "obsolete.txt",
				},
			]);
		});

		it("parses wrapped patches when hunks contain marker text", () => {
			const result = __test__.parsePatch(
				[
					"*** Begin Patch",
					"*** Update File: src/app.ts",
					"@@",
					" *** End Patch",
					"-old",
					"+new",
					"*** Delete File: obsolete.txt",
					"*** End Patch",
				].join("\n"),
			);
			expect(result.hunks).toEqual([
				{
					type: "update",
					path: "src/app.ts",
					chunks: [
						{
							oldLines: ["*** End Patch", "old"],
							newLines: ["*** End Patch", "new"],
							isEndOfFile: false,
						},
					],
				},
				{
					type: "delete",
					path: "obsolete.txt",
				},
			]);
		});

		it("parses multi-file git diffs with add, rename, and delete", () => {
			const result = __test__.parsePatch(
				[
					"diff --git a/src/app.ts b/src/app.ts",
					"--- a/src/app.ts",
					"+++ b/src/app.ts",
					"@@ -1 +1 @@",
					"-old",
					"+new",
					"diff --git a/obsolete.txt b/obsolete.txt",
					"deleted file mode 100644",
					"--- a/obsolete.txt",
					"+++ /dev/null",
					"diff --git a/src/old.ts b/src/new.ts",
					"similarity index 100%",
					"rename from src/old.ts",
					"rename to src/new.ts",
					"--- a/src/old.ts",
					"+++ b/src/new.ts",
					"@@ -1 +1 @@",
					"-before",
					"+after",
					"diff --git a/dev/null b/notes/hello.txt",
					"new file mode 100644",
					"--- /dev/null",
					"+++ b/notes/hello.txt",
					"@@ -0,0 +1 @@",
					"+Hello world",
				].join("\n"),
			);
			expect(result.hunks).toEqual([
				{
					type: "update",
					path: "src/app.ts",
					chunks: [
						{
							oldLines: ["old"],
							newLines: ["new"],
							isEndOfFile: false,
						},
					],
				},
				{
					type: "delete",
					path: "obsolete.txt",
				},
				{
					type: "update",
					path: "src/old.ts",
					movePath: "src/new.ts",
					chunks: [
						{
							oldLines: ["before"],
							newLines: ["after"],
							isEndOfFile: false,
						},
					],
				},
				{
					type: "add",
					path: "notes/hello.txt",
					contents: "Hello world\n",
				},
			]);
		});

		it("parses unified diffs without a diff --git header", () => {
			const result = __test__.parsePatch(
				[
					"--- a/sample.txt",
					"+++ b/sample.txt",
					"@@ -1 +1,2 @@",
					" alpha",
					"+beta",
				].join("\n"),
			);
			expect(result.hunks).toEqual([
				{
					type: "update",
					path: "sample.txt",
					chunks: [
						{
							oldLines: ["alpha"],
							newLines: ["alpha", "beta"],
							isEndOfFile: false,
						},
					],
				},
			]);
		});

		it("parses larger realistic multi-file unified diffs", () => {
			const result = __test__.parsePatch(
				[
					"diff --git a/dist/index.js b/dist/index.js",
					"index f33510a..e887a60 100644",
					"--- a/dist/index.js",
					"+++ b/dist/index.js",
					"@@ -1,7 +1,12 @@",
					" if (reasoningStarted && !textStarted) {",
					"   controller.enqueue({",
					'     type: "reasoning-end",',
					"-    id: reasoningId || generateId()",
					"+    id: reasoningId || generateId(),",
					"+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
					"+      openrouter: {",
					"+        reasoning_details: accumulatedReasoningDetails",
					"+      }",
					"+    } : undefined",
					"   });",
					" }",
					"@@ -20,7 +25,12 @@",
					" if (reasoningStarted) {",
					"   controller.enqueue({",
					'     type: "reasoning-end",',
					"-    id: reasoningId || generateId()",
					"+    id: reasoningId || generateId(),",
					"+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
					"+      openrouter: {",
					"+        reasoning_details: accumulatedReasoningDetails",
					"+      }",
					"+    } : undefined",
					"   });",
					" }",
					"diff --git a/dist/index.mjs b/dist/index.mjs",
					"index 8a68833..6310cb8 100644",
					"--- a/dist/index.mjs",
					"+++ b/dist/index.mjs",
					"@@ -1,7 +1,12 @@",
					" if (reasoningStarted && !textStarted) {",
					"   controller.enqueue({",
					'     type: "reasoning-end",',
					"-    id: reasoningId || generateId()",
					"+    id: reasoningId || generateId(),",
					"+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
					"+      openrouter: {",
					"+        reasoning_details: accumulatedReasoningDetails",
					"+      }",
					"+    } : undefined",
					"   });",
					" }",
					"@@ -20,7 +25,12 @@",
					" if (reasoningStarted) {",
					"   controller.enqueue({",
					'     type: "reasoning-end",',
					"-    id: reasoningId || generateId()",
					"+    id: reasoningId || generateId(),",
					"+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
					"+      openrouter: {",
					"+        reasoning_details: accumulatedReasoningDetails",
					"+      }",
					"+    } : undefined",
					"   });",
					" }",
					"diff --git a/dist/internal/index.js b/dist/internal/index.js",
					"index d40fa66..8dd86d1 100644",
					"--- a/dist/internal/index.js",
					"+++ b/dist/internal/index.js",
					"@@ -1,7 +1,12 @@",
					" if (reasoningStarted && !textStarted) {",
					"   controller.enqueue({",
					'     type: "reasoning-end",',
					"-    id: reasoningId || generateId()",
					"+    id: reasoningId || generateId(),",
					"+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
					"+      openrouter: {",
					"+        reasoning_details: accumulatedReasoningDetails",
					"+      }",
					"+    } : undefined",
					"   });",
					" }",
					"@@ -20,7 +25,12 @@",
					" if (reasoningStarted) {",
					"   controller.enqueue({",
					'     type: "reasoning-end",',
					"-    id: reasoningId || generateId()",
					"+    id: reasoningId || generateId(),",
					"+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
					"+      openrouter: {",
					"+        reasoning_details: accumulatedReasoningDetails",
					"+      }",
					"+    } : undefined",
					"   });",
					" }",
					"diff --git a/dist/internal/index.mjs b/dist/internal/index.mjs",
					"index b0ed9d1..5695930 100644",
					"--- a/dist/internal/index.mjs",
					"+++ b/dist/internal/index.mjs",
					"@@ -1,7 +1,12 @@",
					" if (reasoningStarted && !textStarted) {",
					"   controller.enqueue({",
					'     type: "reasoning-end",',
					"-    id: reasoningId || generateId()",
					"+    id: reasoningId || generateId(),",
					"+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
					"+      openrouter: {",
					"+        reasoning_details: accumulatedReasoningDetails",
					"+      }",
					"+    } : undefined",
					"   });",
					" }",
					"@@ -20,7 +25,12 @@",
					" if (reasoningStarted) {",
					"   controller.enqueue({",
					'     type: "reasoning-end",',
					"-    id: reasoningId || generateId()",
					"+    id: reasoningId || generateId(),",
					"+    providerMetadata: accumulatedReasoningDetails.length > 0 ? {",
					"+      openrouter: {",
					"+        reasoning_details: accumulatedReasoningDetails",
					"+      }",
					"+    } : undefined",
					"   });",
					" }",
				].join("\n"),
			);
			expect(result.hunks).toHaveLength(4);
			for (const hunk of result.hunks) {
				expect(hunk.type).toBe("update");
			}
			expect(result.hunks[0]?.path).toBe("dist/index.js");
			expect(result.hunks[1]?.path).toBe("dist/index.mjs");
			expect(result.hunks[2]?.path).toBe("dist/internal/index.js");
			expect(result.hunks[3]?.path).toBe("dist/internal/index.mjs");
			expect((result.hunks[0] as Extract<typeof result.hunks[0], { type: "update" }>).chunks).toHaveLength(2);
			expect((result.hunks[1] as Extract<typeof result.hunks[1], { type: "update" }>).chunks).toHaveLength(2);
			expect((result.hunks[2] as Extract<typeof result.hunks[2], { type: "update" }>).chunks).toHaveLength(2);
			expect((result.hunks[3] as Extract<typeof result.hunks[3], { type: "update" }>).chunks).toHaveLength(2);
		});

		it("parses heredoc-wrapped hunks", () => {
			const result = patchContentDirect("old\n", "<<'EOF'\n@@\n-old\n+new\nEOF");
			expect(result).toBe("new\n");
		});

		it("rejects malformed multi-file git diffs without hunks", () => {
			expect(() =>
				__test__.parsePatch(
					[
						"diff --git a/src/app.ts b/src/app.ts",
						"--- a/src/app.ts",
						"+++ b/src/app.ts",
					].join("\n"),
				),
			).toThrow("no hunks found for src/app.ts");
		});
	});

	describe("matcher", () => {
		it("applies raw hunks", () => {
			const result = patchContentDirect("line1\nline2\n", "@@\n-line2\n+changed");
			expect(result).toBe("line1\nchanged\n");
		});

		it("does not treat raw marker text as a wrapped patch", () => {
			const result = patchContentDirect(
				"*** Begin Patch\nfinish\n",
				"@@\n-*** Begin Patch\n+*** End Patch",
			);
			expect(result).toBe("*** End Patch\nfinish\n");
		});

		it("parses wrapped single-file patches", () => {
			const result = patchContentDirect(
				"alpha\nomega\n",
				"*** Begin Patch\n*** Update File: ignored.txt\n@@\n alpha\n+beta\n omega\n*** End Patch",
			);
			expect(result).toBe("alpha\nbeta\nomega\n");
		});

		it("matches lines after trimming trailing whitespace", () => {
			const result = patchContentDirect("old  \n", "@@\n-old\n+new");
			expect(result).toBe("new\n");
		});

		it("matches lines after trimming surrounding whitespace", () => {
			const result = patchContentDirect("  old\n", "@@\n-old\n+new");
			expect(result).toBe("new\n");
		});

		it("matches lines after normalizing Unicode punctuation", () => {
			const result = patchContentDirect(
				"Don't wait…\n",
				"@@\n-Don't wait...\n+Done",
			);
			expect(result).toBe("Done\n");
		});

		it("uses context to disambiguate repeated nearby matches", () => {
			const result = patchContentDirect(
				["before", "target", "old", "between", "target", "old", "after", ""].join("\n"),
				["@@ target", " target", "-old", "+new"].join("\n"),
			);
			expect(result).toBe("before\ntarget\nold\nbetween\ntarget\nnew\nafter\n");
		});

		it("matches EOF hunks from the end of the file", () => {
			const result = patchContentDirect(
				"start\nmarker\nend\nmiddle\nmarker\nend\n",
				"@@\n-marker\n-end\n+marker-changed\n+end\n*** End of File",
			);
			expect(result).toBe("start\nmarker\nend\nmiddle\nmarker-changed\nend\n");
		});

		it("preserves CRLF files", () => {
			const result = patchContentDirect("old\r\n", "@@\n-old\n+new");
			expect(result).toBe("new\r\n");
		});
	});

	describe("applyResolvedPatch", () => {
		it("composes multiple operations on the same file", async () => {
			await withTempDir(async (cwd) => {
				await fs.writeFile(path.join(cwd, "a.ts"), ["line1", "line2", "line3", ""].join("\n"), "utf8");

				const operations = __test__.rewriteInputToOperations(
					cwd,
					[
						"*** Begin Patch",
						"*** Update File: a.ts",
						"@@",
						"-line1",
						"+line1-changed",
						"*** Update File: a.ts",
						"@@",
						"-line3",
						"+line3-changed",
						"*** End Patch",
					].join("\n"),
				);

				const summary = await __test__.applyResolvedPatch(operations, cwd);
				expect(summary.modified).toEqual(["a.ts"]);
				const contents = await fs.readFile(path.join(cwd, "a.ts"), "utf8");
				expect(contents).toBe(["line1-changed", "line2", "line3-changed", ""].join("\n"));
			});
		});

		it("rejects delete when target does not exist", async () => {
			await withTempDir(async (cwd) => {
				const operations = __test__.rewriteInputToOperations(
					cwd,
					[
						"*** Begin Patch",
						"*** Delete File: missing.txt",
						"*** End Patch",
					].join("\n"),
				);

				await expect(__test__.applyResolvedPatch(operations, cwd)).rejects.toThrow(
					/missing.txt/,
				);
			});
		});

		it("allows delete then add same path in same patch", async () => {
			await withTempDir(async (cwd) => {
				const filePath = path.join(cwd, "foo.txt");
				await fs.writeFile(filePath, "old\n", "utf8");

				const operations = [
					{ type: "delete" as const, absolutePath: filePath },
					{ type: "add" as const, absolutePath: filePath, contents: "new\n" },
				];

				const summary = await __test__.applyResolvedPatch(operations, cwd);
				// Deduplication keeps the last operation per path (add wins).
				expect(summary.added).toEqual(["foo.txt"]);
				expect(await fs.readFile(filePath, "utf8")).toBe("new\n");
			});
		});

		it("allows move then add back original path in same patch", async () => {
			await withTempDir(async (cwd) => {
				const fileA = path.join(cwd, "a.txt");
				const fileB = path.join(cwd, "b.txt");
				await fs.writeFile(fileA, "a content\n", "utf8");

				const operations = [
					{
						type: "update" as const,
						absolutePath: fileA,
						movePath: fileB,
						chunks: [{ oldLines: ["a content"], newLines: ["b content"], isEndOfFile: false }],
					},
					{ type: "add" as const, absolutePath: fileA, contents: "new a\n" },
				];

				const summary = await __test__.applyResolvedPatch(operations, cwd);
				expect(summary.modified).toEqual(["b.txt"]);
				expect(summary.added).toEqual(["a.txt"]);
				expect(await fs.readFile(fileB, "utf8")).toBe("b content\n");
				expect(await fs.readFile(fileA, "utf8")).toBe("new a\n");
			});
		});

		it("allows delete destination then move to it in same patch", async () => {
			await withTempDir(async (cwd) => {
				const fileA = path.join(cwd, "a.txt");
				const fileB = path.join(cwd, "b.txt");
				await fs.writeFile(fileA, "a content\n", "utf8");
				await fs.writeFile(fileB, "b content\n", "utf8");

				const operations = [
					{ type: "delete" as const, absolutePath: fileB },
					{
						type: "update" as const,
						absolutePath: fileA,
						movePath: fileB,
						chunks: [{ oldLines: ["a content"], newLines: ["c content"], isEndOfFile: false }],
					},
				];

				const summary = await __test__.applyResolvedPatch(operations, cwd);
				// Deduplication keeps the last operation per path (move wins).
				expect(summary.modified).toEqual(["b.txt"]);
				expect(await fs.readFile(fileB, "utf8")).toBe("c content\n");
				await expect(fs.stat(fileA)).rejects.toThrow();
			});
		});

		it("deletes move source even when destination is updated later in same patch", async () => {
			await withTempDir(async (cwd) => {
				const fileA = path.join(cwd, "a.txt");
				const fileB = path.join(cwd, "b.txt");
				await fs.writeFile(fileA, "a content\n", "utf8");
				await fs.writeFile(fileB, "b content\n", "utf8");

				const operations = [
					{
						type: "update" as const,
						absolutePath: fileA,
						movePath: fileB,
						chunks: [{ oldLines: ["a content"], newLines: ["a moved"], isEndOfFile: false }],
					},
					{
						type: "update" as const,
						absolutePath: fileB,
						chunks: [{ oldLines: ["a moved"], newLines: ["b updated"], isEndOfFile: false }],
					},
				];

				const summary = await __test__.applyResolvedPatch(operations, cwd);
				expect(summary.modified).toEqual(["b.txt"]);
				expect(await fs.readFile(fileB, "utf8")).toBe("b updated\n");
				await expect(fs.stat(fileA)).rejects.toThrow();
			});
		});

		it("creates parent directories for updates on newly added files in same patch", async () => {
			await withTempDir(async (cwd) => {
				const filePath = path.join(cwd, "newdir", "file.txt");

				const operations = [
					{ type: "add" as const, absolutePath: filePath, contents: "initial\n" },
					{
						type: "update" as const,
						absolutePath: filePath,
						chunks: [{ oldLines: ["initial"], newLines: ["updated"], isEndOfFile: false }],
					},
				];

				const summary = await __test__.applyResolvedPatch(operations, cwd);
				expect(summary.modified).toEqual(["newdir/file.txt"]);
				expect(await fs.readFile(filePath, "utf8")).toBe("updated\n");
			});
		});
	});
});
