import * as fs from "node:fs";
import * as path from "node:path";

import type { FilesystemMode } from "./config.js";
import { collectTempRoots, isPathInsideRoot, safeRealpath } from "../shared/fs.js";
import { classifyWorkspacePath } from "./workspace-path-policy.js";

type FsCheckResult = { allowed: true } | { allowed: false; reason: string };

function toAbsolutePath(targetPath: string, cwd: string): string {
	const absolute = path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
	return path.normalize(absolute);
}

function isMissingPathError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function uniquePaths(paths: readonly string[]): string[] {
	return Array.from(new Set(paths.map((candidate) => path.normalize(candidate))));
}

function isPathInsideRootLexical(targetPath: string, root: string): boolean {
	const normalizedTarget = path.normalize(targetPath);
	const normalizedRoot = path.normalize(root);
	return (
		normalizedTarget === normalizedRoot ||
		normalizedTarget.startsWith(normalizedRoot + path.sep)
	);
}

function findContainingRoot(targetPath: string, roots: readonly string[]): string | undefined {
	const sortedRoots = [...roots].sort((left, right) => right.length - left.length);
	return sortedRoots.find((root) => isPathInsideRootLexical(targetPath, root));
}

function findFirstNonExistentComponent(targetPath: string, cwd: string): string | null {
	const absoluteTargetPath = toAbsolutePath(targetPath, cwd);
	const relativeToRoot = path.relative(path.sep, absoluteTargetPath);
	if (relativeToRoot === "") {
		return null;
	}

	let currentPath: string = path.sep;
	for (const part of relativeToRoot.split(path.sep)) {
		if (part === "") {
			continue;
		}

		currentPath = path.join(currentPath, part);
		try {
			fs.lstatSync(currentPath);
		} catch (error) {
			if (isMissingPathError(error)) {
				return currentPath;
			}
			return null;
		}
	}

	return null;
}

function resolveFromNearestExistingAncestor(targetPath: string, cwd: string): string {
	const absoluteTargetPath = toAbsolutePath(targetPath, cwd);
	const firstMissingComponent = findFirstNonExistentComponent(absoluteTargetPath, cwd);

	if (!firstMissingComponent) {
		return safeRealpath(absoluteTargetPath);
	}

	const existingParent = path.dirname(firstMissingComponent);
	const missingSuffix = path.relative(existingParent, absoluteTargetPath);
	const resolvedParent = safeRealpath(existingParent);

	return missingSuffix === "" ? resolvedParent : path.join(resolvedParent, missingSuffix);
}

function checkSymlinkBoundary(opts: {
	targetPath: string;
	walkRoot: string;
	boundaryRoots: readonly string[];
	boundaryLabel: string;
	cwd: string;
}): FsCheckResult | null {
	const absoluteTargetPath = toAbsolutePath(opts.targetPath, opts.cwd);
	const absoluteWalkRoot = toAbsolutePath(opts.walkRoot, opts.cwd);
	const relative = path.relative(absoluteWalkRoot, absoluteTargetPath);

	if (
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return null;
	}

	if (relative === "") {
		return null;
	}

	let currentPath = absoluteWalkRoot;
	for (const part of relative.split(path.sep)) {
		if (part === "") {
			continue;
		}

		currentPath = path.join(currentPath, part);

		let metadata: fs.Stats;
		try {
			metadata = fs.lstatSync(currentPath);
		} catch (error) {
			if (isMissingPathError(error)) {
				break;
			}
			return {
				allowed: false,
				reason: `Write blocked: unable to inspect path component for symlink safety (path: ${currentPath}).`,
			};
		}

		if (!metadata.isSymbolicLink()) {
			continue;
		}

		let resolvedSymlinkPath: string;
		try {
			resolvedSymlinkPath = fs.realpathSync(currentPath);
		} catch {
			return {
				allowed: false,
				reason: `Write blocked: symlink component cannot be resolved safely (path: ${currentPath}).`,
			};
		}

		const resolvesInsideBoundary = opts.boundaryRoots.some((root) =>
			isPathInsideRoot(resolvedSymlinkPath, root),
		);
		if (!resolvesInsideBoundary) {
			return {
				allowed: false,
				reason: `Write blocked: symlink component resolves outside ${opts.boundaryLabel} (symlink: ${currentPath}, resolved: ${resolvedSymlinkPath}).`,
			};
		}
	}

	return null;
}

function isInTempDir(resolvedTargetPath: string, tempRoots: readonly string[]): boolean {
	for (const tmpDir of tempRoots) {
		if (isPathInsideRoot(resolvedTargetPath, tmpDir)) {
			return true;
		}
	}

	return false;
}

export function checkWriteAllowed(opts: {
	targetPath: string;
	cwd: string;
	workspaceRoot: string;
	filesystemMode: FilesystemMode;
}): FsCheckResult {
	const { targetPath, cwd, workspaceRoot, filesystemMode } = opts;

	if (filesystemMode === "danger-full-access") {
		return { allowed: true };
	}

	const absoluteTargetPath = toAbsolutePath(targetPath, cwd);
	const absoluteWorkspaceRoot = toAbsolutePath(workspaceRoot, cwd);
	const resolvedWorkspaceRoot = safeRealpath(absoluteWorkspaceRoot);

	const tempWalkRoots = uniquePaths(
		collectTempRoots().map((tempRoot) => toAbsolutePath(tempRoot, cwd)),
	);
	const resolvedTempRoots = uniquePaths(
		tempWalkRoots.map((tempRoot) => safeRealpath(tempRoot)),
	);

	const workspaceWalkRoots = uniquePaths([absoluteWorkspaceRoot, resolvedWorkspaceRoot]);
	const workspaceWalkRoot = findContainingRoot(absoluteTargetPath, workspaceWalkRoots);
	if (workspaceWalkRoot) {
		const workspaceSymlinkCheck = checkSymlinkBoundary({
			targetPath: absoluteTargetPath,
			walkRoot: workspaceWalkRoot,
			boundaryRoots: [resolvedWorkspaceRoot],
			boundaryLabel: `workspace root (${resolvedWorkspaceRoot})`,
			cwd,
		});
		if (workspaceSymlinkCheck) {
			return workspaceSymlinkCheck;
		}
	} else {
		const tempWalkRoot = findContainingRoot(absoluteTargetPath, tempWalkRoots);
		if (tempWalkRoot) {
			const boundaryRoots =
				filesystemMode === "workspace-write"
					? uniquePaths([resolvedWorkspaceRoot, ...resolvedTempRoots])
					: resolvedTempRoots;
			const tempSymlinkCheck = checkSymlinkBoundary({
				targetPath: absoluteTargetPath,
				walkRoot: tempWalkRoot,
				boundaryRoots,
				boundaryLabel: "allowed writable roots",
				cwd,
			});
			if (tempSymlinkCheck) {
				return tempSymlinkCheck;
			}
		}
	}

	const resolvedTargetPath = resolveFromNearestExistingAncestor(absoluteTargetPath, cwd);

	const classification = classifyWorkspacePath(resolvedTargetPath, resolvedWorkspaceRoot);
	if (classification.kind === "protected") {
		if (classification.root.endsWith(`${path.sep}.git`) || classification.root.endsWith(".git")) {
			return {
				allowed: false,
				reason: `Write to .git/ is blocked for security (path: ${resolvedTargetPath}). Use /sandbox to enable danger-full-access mode if needed.`,
			};
		}
		return {
			allowed: false,
			reason: `Write to protected workspace metadata under .pi/ is blocked (path: ${resolvedTargetPath}). Use /sandbox to enable danger-full-access mode if needed.`,
		};
	}

	switch (filesystemMode) {
		case "workspace-write":
			if (isPathInsideRoot(resolvedTargetPath, resolvedWorkspaceRoot)) {
				return { allowed: true };
			}
			if (isInTempDir(resolvedTargetPath, resolvedTempRoots)) {
				return { allowed: true };
			}
			return {
				allowed: false,
				reason: `Write outside workspace is blocked (path: ${resolvedTargetPath}, workspace: ${resolvedWorkspaceRoot}). Use /sandbox to change filesystem mode.`,
			};

		case "read-only":
			if (isInTempDir(resolvedTargetPath, resolvedTempRoots)) {
				return { allowed: true };
			}
			return {
				allowed: false,
				reason: `Filesystem is read-only (path: ${resolvedTargetPath}). Use /sandbox to change filesystem mode.`,
			};

		default:
			return {
				allowed: false,
				reason: `Unknown filesystem mode: ${filesystemMode}`,
			};
	}
}
