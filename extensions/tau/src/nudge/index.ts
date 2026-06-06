import type {
	ExtensionAPI,
	ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { prependToLastUserMessage } from "../shared/message-injection.js";

type TrackedTool = "memory" | "skill_manage";

interface NudgePolicy {
	readonly thresholdTurns: number;
	readonly cooldownTurns: number;
	readonly text: string;
}

const POLICIES: Readonly<Record<TrackedTool, NudgePolicy>> = {
	memory: {
		thresholdTurns: 8,
		cooldownTurns: 8,
		text: "You haven't saved to memory recently. If the user shared preferences, corrections, or personal/environment details, save them with `memory` now.",
	},
	skill_manage: {
		thresholdTurns: 12,
		cooldownTurns: 12,
		text: "Consider whether any approach from this session should be saved or updated as a skill with `skill_manage`.",
	},
};

const TRACKED_TOOLS: readonly TrackedTool[] = ["memory", "skill_manage"] as const;

export const BASELINE_NUDGE =
	"\n\nWhen you learn durable facts about the user, environment, or project, save them with `memory`. When you discover or fix a reusable workflow, create or patch a skill with `skill_manage`. Skip temporary task state and one-offs.";

function isTrackedTool(name: string): name is TrackedTool {
	return name === "memory" || name === "skill_manage";
}

interface NudgeState {
	turn: number;
	lastUsedTurn: Record<TrackedTool, number>;
	lastNudgedTurn: Record<TrackedTool, number>;
}

function freshState(): NudgeState {
	return {
		turn: 0,
		lastUsedTurn: { memory: 0, skill_manage: 0 },
		lastNudgedTurn: { memory: 0, skill_manage: 0 },
	};
}

function hasUserMessage(messages: readonly { readonly role: string }[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") {
			return true;
		}
	}
	return false;
}

export default function initNudge(pi: ExtensionAPI): void {
	let state = freshState();

	pi.on("session_start", async () => {
		state = freshState();
	});

	pi.on("session_switch", async () => {
		state = freshState();
	});

	pi.on("turn_end", async () => {
		state.turn += 1;
	});

	pi.on("tool_result", async (event: ToolResultEvent) => {
		if (isTrackedTool(event.toolName)) {
			state.lastUsedTurn[event.toolName] = state.turn;
		}
	});

	pi.on("before_agent_start", async (event) => {
		const activeTools = pi.getActiveTools();
		const anyTracked = TRACKED_TOOLS.some((t) => activeTools.includes(t));
		if (!anyTracked) return;

		return { systemPrompt: event.systemPrompt + BASELINE_NUDGE };
	});

	pi.on("context", async (event) => {
		const activeTools = pi.getActiveTools();

		const dueTools = TRACKED_TOOLS.filter((tool) => {
			if (!activeTools.includes(tool)) return false;
			const policy = POLICIES[tool];
			const sinceLast = state.turn - state.lastUsedTurn[tool];
			const sinceNudge = state.turn - state.lastNudgedTurn[tool];
			return sinceLast >= policy.thresholdTurns && sinceNudge >= policy.cooldownTurns;
		});

		if (dueTools.length === 0) return;
		if (!hasUserMessage(event.messages)) return;

		for (const tool of dueTools) {
			state.lastNudgedTurn[tool] = state.turn;
		}

		const lines = dueTools.map((t) => `- ${POLICIES[t].text}`);
		const nudgeText = `[System reminder]\n${lines.join("\n")}\nIgnore if nothing durable or reusable was learned.`;

		return {
			messages: prependToLastUserMessage(event.messages, nudgeText),
		};
	});
}
