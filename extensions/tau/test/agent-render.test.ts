import { describe, expect, it } from "vitest";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";

import { renderAgentResult } from "../src/agent/render.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
} as unknown as Theme;

function renderToText(result: AgentToolResult<unknown>, options: ToolRenderResultOptions): string {
	const component = renderAgentResult(result, options, plainTheme);
	return component.render(400).join("\n");
}

describe("agent renderer", () => {
	it("shows full send message when expanded", () => {
		const fullMessage =
			"Create a DETAILED porting plan from service alpha to service beta with edge cases";
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				submission_id: "sub-66991234",
				agent_id: "fca68e1b9a",
				message: fullMessage,
			},
		} as unknown as AgentToolResult<unknown>;

		const rendered = renderToText(result, { expanded: true, isPartial: false });
		expect(rendered).toContain("submission: sub-6699");
		expect(rendered).toContain("to: fca68e1b");
		expect(rendered).toContain(`message: ${fullMessage}`);
	});

	it("keeps send message hidden in collapsed view", () => {
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				submission_id: "sub-66991234",
				agent_id: "fca68e1b9a",
				message: "this should not appear in collapsed view",
			},
		} as unknown as AgentToolResult<unknown>;

		const rendered = renderToText(result, { expanded: false, isPartial: false });
		expect(rendered).toContain("submission: sub-6699");
		expect(rendered).not.toContain("message:");
	});

	it("shows wait timeout using wait elapsed data and labels work time separately", () => {
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				status: {
					cD_HVp45dahK: {
						state: "running",
						turns: 21,
						toolCalls: 36,
						workedMs: 123000,
					},
				},
				timedOut: true,
				timeoutMs: 1_200_000,
				waitElapsedMs: 1_201_000,
				agentTypes: {
					cD_HVp45dahK: "oracle",
				},
			},
		} as unknown as AgentToolResult<unknown>;

		const rendered = renderToText(result, { expanded: false, isPartial: false });
		expect(rendered).toContain("Timed out waiting for agents after 20m 0s");
		expect(rendered).toContain("work:2m 3s");
	});
});
