/**
 * Explicit field classification inventory for every Ralph persisted-state field.
 *
 * This file serves as documentation and a guard: any new field added to
 * Ralph loop state should be classified here. A test can import this
 * inventory and assert that every schema field has a matching classification.
 *
 * Classifications:
 * - "configurable": Can be mutated through /ralph configure
 * - "runtime": Managed by the loop engine / runtime; not user-editable
 * - "system": Core loop identity and lifecycle; never mutated by config UI
 */

import type { RalphLoopStateDetails } from "../loops/schema.js";

type FieldClassification = "configurable" | "runtime" | "system";

interface FieldClassificationEntry {
	readonly field: keyof RalphLoopStateDetails;
	readonly classification: FieldClassification;
	readonly description: string;
}

export const RALPH_FIELD_CLASSIFICATIONS: ReadonlyArray<FieldClassificationEntry> = [
	// System fields
	{ field: "iteration", classification: "system", description: "Current loop iteration counter" },
	{ field: "metrics", classification: "system", description: "Token cost and runtime metrics" },
	{ field: "pendingDecision", classification: "runtime", description: "Continue/finish decision from current iteration" },
	{ field: "lastReflectionAt", classification: "runtime", description: "Iteration of last reflection checkpoint" },
	{ field: "pinnedExecutionProfile", classification: "configurable", description: "Pinned model/thinking execution profile" },
	{ field: "sandboxProfile", classification: "configurable", description: "Pinned sandbox preset and overrides" },

	// Configurable fields
	{ field: "maxIterations", classification: "configurable", description: "Maximum iterations before auto-pause" },
	{ field: "itemsPerIteration", classification: "configurable", description: "Suggested work items per iteration" },
	{ field: "reflectEvery", classification: "configurable", description: "Reflection checkpoint frequency in iterations" },
	{ field: "reflectInstructions", classification: "configurable", description: "Custom reflection prompt instructions" },
	{ field: "capabilityContract", classification: "configurable", description: "Versioned tool/agent capability contract" },
] as const;

const CLASSIFIED_FIELDS = new Set(
	RALPH_FIELD_CLASSIFICATIONS.map((entry) => entry.field),
);

/**
 * Returns true if every key of RalphLoopStateDetails is present in the
 * classification inventory. Use this in tests to enforce that new fields
 * require intentional classification.
 */
export function allRalphFieldsAreClassified(): boolean {
	const expectedFields: ReadonlyArray<keyof RalphLoopStateDetails> = [
		"iteration",
		"maxIterations",
		"itemsPerIteration",
		"reflectEvery",
		"reflectInstructions",
		"lastReflectionAt",
		"pendingDecision",
		"pinnedExecutionProfile",
		"sandboxProfile",
		"metrics",
		"capabilityContract",
	];
	return expectedFields.every((field) => CLASSIFIED_FIELDS.has(field));
}

/**
 * Get the classification for a specific field, or undefined if not classified.
 */
export function getRalphFieldClassification(
	field: keyof RalphLoopStateDetails,
): FieldClassification | undefined {
	return RALPH_FIELD_CLASSIFICATIONS.find((entry) => entry.field === field)?.classification;
}
