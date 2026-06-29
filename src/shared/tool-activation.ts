import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ToolActivationTransform = (toolNames: ReadonlyArray<string>) => ReadonlyArray<string>;

interface ToolActivationState {
	readonly transforms: Map<string, ToolActivationTransform>;
}

const toolActivationStates = new WeakMap<ExtensionAPI, ToolActivationState>();

function getToolActivationState(pi: ExtensionAPI): ToolActivationState {
	const existing = toolActivationStates.get(pi);
	if (existing) {
		return existing;
	}

	const created: ToolActivationState = {
		transforms: new Map(),
	};
	toolActivationStates.set(pi, created);
	return created;
}

function uniqueToolNames(toolNames: ReadonlyArray<string>): ReadonlyArray<string> {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const toolName of toolNames) {
		if (seen.has(toolName)) {
			continue;
		}
		seen.add(toolName);
		unique.push(toolName);
	}
	return unique;
}

function sameToolNames(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
	if (left.length !== right.length) {
		return false;
	}
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
}

function syncToolActivationTransforms(pi: ExtensionAPI): void {
	const state = getToolActivationState(pi);
	const activeTools = uniqueToolNames(pi.getActiveTools());
	const nextTools = [...state.transforms.values()].reduce<ReadonlyArray<string>>(
		(current, transform) => uniqueToolNames(transform(current)),
		activeTools,
	);
	if (!sameToolNames(activeTools, nextTools)) {
		pi.setActiveTools([...nextTools]);
	}
}

export function setToolActivationTransform(
	pi: ExtensionAPI,
	key: string,
	transform: ToolActivationTransform | undefined,
): void {
	const state = getToolActivationState(pi);
	if (transform === undefined) {
		state.transforms.delete(key);
	} else {
		state.transforms.set(key, transform);
	}
	syncToolActivationTransforms(pi);
}

export function setToolEnabled(pi: ExtensionAPI, toolName: string, enabled: boolean): void {
	const activeTools = pi.getActiveTools();
	const activeSet = new Set(activeTools);

	if (enabled) {
		if (activeSet.has(toolName)) return;
		pi.setActiveTools([...activeTools, toolName]);
		return;
	}

	if (!activeSet.has(toolName)) return;
	pi.setActiveTools(activeTools.filter((name) => name !== toolName));
}
