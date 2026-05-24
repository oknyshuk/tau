import { isRecord } from "../shared/json.js";

type MemoryMutationAction = "add" | "update" | "remove";

export function readMemoryToolAction(params: unknown): string | undefined {
	if (!isRecord(params)) {
		return undefined;
	}

	const action = params["action"];
	return typeof action === "string" ? action : undefined;
}

function isMemoryMutationAction(
	action: string | undefined,
): action is MemoryMutationAction {
	return action === "add" || action === "update" || action === "remove";
}

export function didMemoryToolSucceed(result: unknown): boolean {
	if (!isRecord(result) || result["isError"] === true) {
		return false;
	}

	const details = result["details"];
	if (!isRecord(details)) {
		return false;
	}

	return details["success"] === true;
}

export function shouldCountMemoryMutation(
	action: string | undefined,
	result: unknown,
): action is MemoryMutationAction {
	return isMemoryMutationAction(action) && didMemoryToolSucceed(result);
}
