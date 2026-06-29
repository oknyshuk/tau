import * as fsSync from "node:fs";
import * as path from "node:path";

import { Effect, FileSystem, Schema } from "effect";

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("StorageError", {
	operation: Schema.String,
	path: Schema.String,
	reason: Schema.String,
	cause: Schema.Defect,
}) {}

export function toStorageError(
	operation: string,
	targetPath: string,
	reason: string,
	cause: unknown,
): StorageError {
	return new StorageError({
		operation,
		path: targetPath,
		reason,
		cause,
	});
}

export function atomicWriteFileStringSync(filePath: string, content: string): void {
	const parentDir = path.dirname(filePath);
	const tempPath = tempPathFor(filePath);

	try {
		fsSync.mkdirSync(parentDir, { recursive: true });
	} catch (cause) {
		throw toStorageError(
			"mkdir-parent",
			parentDir,
			`Failed to create parent directory for ${filePath}`,
			cause,
		);
	}

	try {
		fsSync.writeFileSync(tempPath, content, { encoding: "utf8", flag: "w" });
	} catch (cause) {
		throw toStorageError(
			"write-temp-file",
			tempPath,
			`Failed to write temp file ${tempPath}`,
			cause,
		);
	}

	let tempCleaned = false;
	const cleanupTempFile = (): void => {
		if (tempCleaned) {
			return;
		}
		tempCleaned = true;
		try {
			fsSync.rmSync(tempPath, { force: true });
		} catch {
			// Best-effort cleanup for temp files. The caller already receives the
			// original write/rename/sync failure; cleanup failure is not actionable here.
		}
	};

	try {
		const tempFd = fsSync.openSync(tempPath, "r");
		try {
			fsSync.fsyncSync(tempFd);
		} catch (cause) {
			throw toStorageError(
				"sync-temp-file",
				tempPath,
				`Failed to sync temp file ${tempPath}`,
				cause,
			);
		} finally {
			fsSync.closeSync(tempFd);
		}

		fsSync.renameSync(tempPath, filePath);

		const finalFd = fsSync.openSync(filePath, "r");
		try {
			fsSync.fsyncSync(finalFd);
		} catch (cause) {
			throw toStorageError(
				"sync-final-file",
				filePath,
				`Failed to sync final file ${filePath}`,
				cause,
			);
		} finally {
			fsSync.closeSync(finalFd);
		}

		tempCleaned = true;
	} catch (cause) {
		cleanupTempFile();
		if (cause instanceof StorageError) {
			throw cause;
		}
		throw toStorageError(
			"rename-file",
			filePath,
			`Failed to rename ${tempPath} to ${filePath}`,
			cause,
		);
	}
}

function tempPathFor(filePath: string): string {
	return path.join(
		path.dirname(filePath),
		`.tmp-${path.basename(filePath)}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	);
}

export const atomicWriteFileString = (
	fs: FileSystem.FileSystem,
	filePath: string,
	content: string,
): Effect.Effect<void, StorageError, never> => {
	const parentDir = path.dirname(filePath);
	const tempPath = tempPathFor(filePath);

	const cleanupTempFile = fs.remove(tempPath, { force: true }).pipe(
		// Best-effort cleanup for temp files. The caller already receives the
		// original write/rename failure; cleanup failure is not actionable here.
		Effect.catch((error) => Effect.logWarning("Atomic write temp file cleanup failed", error)),
	);

	return Effect.acquireUseRelease(
		fs.makeDirectory(parentDir, { recursive: true }).pipe(
			Effect.mapError((cause) =>
				toStorageError("mkdir-parent", parentDir, `Failed to create parent directory for ${filePath}`, cause),
			),
			Effect.as(tempPath),
		),
		() =>
			Effect.gen(function* () {
				yield* fs.writeFileString(tempPath, content, { flag: "w" }).pipe(
					Effect.mapError((cause) =>
						toStorageError("write-temp-file", tempPath, `Failed to write temp file ${tempPath}`, cause),
					),
				);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const tempFile = yield* fs.open(tempPath, { flag: "r" }).pipe(
							Effect.mapError((cause) =>
								toStorageError("open-temp-file", tempPath, `Failed to reopen temp file ${tempPath}`, cause),
							),
						);
						yield* tempFile.sync.pipe(
							Effect.mapError((cause) =>
								toStorageError("sync-temp-file", tempPath, `Failed to sync temp file ${tempPath}`, cause),
							),
						);
					}),
				);

				yield* fs.rename(tempPath, filePath).pipe(
					Effect.mapError((cause) =>
						toStorageError("rename-file", filePath, `Failed to rename ${tempPath} to ${filePath}`, cause),
					),
				);

				yield* Effect.scoped(
					Effect.gen(function* () {
						const finalFile = yield* fs.open(filePath, { flag: "r" }).pipe(
							Effect.mapError((cause) =>
								toStorageError("open-final-file", filePath, `Failed to reopen ${filePath} after rename`, cause),
							),
						);
						yield* finalFile.sync.pipe(
							Effect.mapError((cause) =>
								toStorageError("sync-final-file", filePath, `Failed to sync final file ${filePath}`, cause),
							),
						);
					}),
				);
			}),
		() => cleanupTempFile,
	);
};
