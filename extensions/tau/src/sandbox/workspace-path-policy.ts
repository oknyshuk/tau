import * as path from "node:path";

import { safeRealpath, isPathInsideRoot } from "../shared/fs.js";

interface ProtectedPathRule {
	readonly rootSegment: string;
	readonly writableExceptionSegments: readonly string[];
}

export const WORKSPACE_PROTECTED_RULES: ProtectedPathRule[] = [
	{ rootSegment: ".git", writableExceptionSegments: [] },
	{ rootSegment: ".pi", writableExceptionSegments: [".pi/loops/tasks"] },
];

interface ResolvedProtectedPathRule {
	readonly root: string;
	readonly writableExceptions: readonly string[];
}

function resolveProtectedRulePaths(workspaceRoot: string): ResolvedProtectedPathRule[] {
	const resolvedRoot = safeRealpath(workspaceRoot);
	return WORKSPACE_PROTECTED_RULES.map((rule) => ({
		root: safeRealpath(path.join(resolvedRoot, rule.rootSegment)),
		writableExceptions: rule.writableExceptionSegments.map((exc) =>
			safeRealpath(path.join(resolvedRoot, exc)),
		),
	}));
}

type PathClassification =
	| { readonly kind: "protected"; readonly root: string }
	| { readonly kind: "writableException"; readonly root: string }
	| { readonly kind: "normal" };

export function classifyWorkspacePath(
	targetPath: string,
	workspaceRoot: string,
): PathClassification {
	const absoluteTarget = path.isAbsolute(targetPath)
		? targetPath
		: path.resolve(workspaceRoot, targetPath);
	const resolvedTarget = safeRealpath(absoluteTarget);
	const rules = resolveProtectedRulePaths(workspaceRoot);

	for (const rule of rules) {
		const isInside =
			isPathInsideRoot(resolvedTarget, rule.root) || resolvedTarget === rule.root;
		if (!isInside) {
			continue;
		}

		for (const exc of rule.writableExceptions) {
			const isException =
				isPathInsideRoot(resolvedTarget, exc) || resolvedTarget === exc;
			if (isException) {
				return { kind: "writableException", root: exc };
			}
		}

		return { kind: "protected", root: rule.root };
	}

	return { kind: "normal" };
}
