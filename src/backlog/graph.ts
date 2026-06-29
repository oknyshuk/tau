import { Effect } from "effect";

import { BacklogDependencyCycleError } from "./errors.js";
import type { DependencyType, Issue } from "./schema.js";

type Graph = ReadonlyMap<string, ReadonlySet<string>>;

const CycleEdgeTypes = new Set<DependencyType>([
	"blocks",
	"parent-child",
	"conditional-blocks",
	"waits-for",
	"delegated-from",
]);

const isCycleEdgeType = (depType: DependencyType): boolean => CycleEdgeTypes.has(depType);

export const buildGraph = (issues: ReadonlyArray<Issue>): Graph => {
	const graph = new Map<string, Set<string>>();

	for (const issue of issues) {
		const deps = issue.dependencies ?? [];
		if (!graph.has(issue.id)) {
			graph.set(issue.id, new Set());
		}
		const targets = graph.get(issue.id);
		if (!targets) {
			continue;
		}
		for (const dep of deps) {
			if (!isCycleEdgeType(dep.type)) {
				continue;
			}
			targets.add(dep.depends_on_id);
		}
	}

	return graph;
};

export const hasPath = (graph: Graph, from: string, to: string): boolean => {
	if (from === to) {
		return true;
	}

	const visited = new Set<string>();
	const stack: string[] = [from];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}
		if (current === to) {
			return true;
		}
		if (visited.has(current)) {
			continue;
		}
		visited.add(current);
		const next = graph.get(current);
		if (!next) {
			continue;
		}
		for (const target of next) {
			if (!visited.has(target)) {
				stack.push(target);
			}
		}
	}

	return false;
};

export const wouldCreateCycle = (graph: Graph, issueId: string, dependsOnId: string): boolean => {
	if (issueId === dependsOnId) {
		return true;
	}
	return hasPath(graph, dependsOnId, issueId);
};

export function listDependencies(issueId: string, issues: ReadonlyArray<Issue>): ReadonlyArray<Issue> {
	const byId = new Map(issues.map((issue) => [issue.id, issue]));
	const issue = byId.get(issueId);
	if (!issue) {
		return [];
	}

	const related: Issue[] = [];
	for (const dep of issue.dependencies ?? []) {
		const target = byId.get(dep.depends_on_id);
		if (target) {
			related.push(target);
		}
	}
	return related;
}

export function listDependents(issueId: string, issues: ReadonlyArray<Issue>): ReadonlyArray<Issue> {
	const related: Issue[] = [];
	for (const issue of issues) {
		if (issue.id === issueId) {
			continue;
		}
		for (const dep of issue.dependencies ?? []) {
			if (dep.depends_on_id === issueId) {
				related.push(issue);
				break;
			}
		}
	}
	return related;
}

export const assertNoDependencyCycles = (
	issues: ReadonlyArray<Issue>,
): Effect.Effect<void, BacklogDependencyCycleError, never> =>
	Effect.gen(function* () {
		const graph = buildGraph(issues);
		for (const [issueId, targets] of graph.entries()) {
			for (const target of targets) {
				if (wouldCreateCycle(graph, issueId, target)) {
					return yield* Effect.fail(
						new BacklogDependencyCycleError({
							issueId,
							dependsOnId: target,
							dependencyType: "blocks",
						}),
					);
				}
			}
		}
	});

