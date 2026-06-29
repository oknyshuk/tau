import { describe, expect, it } from "vitest";

import type { ExtensionAPI, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component, Text, TUI } from "@earendil-works/pi-tui";

import initRequestUserInput from "../src/request-user-input/index.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

type QuestionInput = {
	id: string;
	header: string;
	question: string;
	options: Array<{ label: string; description: string }>;
};

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
};

type DisposableComponent = Component & {
	dispose?(): void;
};

type RequestUserInputTool = {
	execute(
		toolCallId: string,
		params: { questions: QuestionInput[] },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult>;
	renderResult(
		result: ToolResult,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: unknown,
	): Text;
};

function registeredTool(): RequestUserInputTool {
	let tool: unknown;
	initRequestUserInput({
		registerTool(registered: unknown) {
			tool = registered;
		},
	} as unknown as ExtensionAPI);
	return tool as RequestUserInputTool;
}

function normalizeRendered(text: Text): string {
	return text
		.render(160)
		.map((line) => line.trimEnd())
		.join("\n");
}

function createContext(drive: (component: Component) => void): ExtensionContext {
	const custom = async <T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: unknown,
			done: (result: T) => void,
		) => DisposableComponent | Promise<DisposableComponent>,
	): Promise<T> => {
		let settled: T | undefined;
		const component = await factory(
			{ requestRender: () => undefined } as unknown as TUI,
			plainTheme,
			undefined,
			(result) => {
				settled = result;
			},
		);
		expect(component.render(120).join("\n")).toContain("Tab to add notes");
		drive(component);
		component.dispose?.();
		if (settled === undefined) {
			throw new Error("custom UI did not settle");
		}
		return settled;
	};

	return {
		hasUI: true,
		ui: { custom },
	} as unknown as ExtensionContext;
}

describe("request_user_input", () => {
	it("submits selected option with notes added via tab", async () => {
		const tool = registeredTool();
		const ctx = createContext((component) => {
			component.handleInput?.("\t");
			for (const ch of "ship after tests") {
				component.handleInput?.(ch);
			}
			component.handleInput?.("\r");
		});

		const result = await tool.execute(
			"call-1",
			{
				questions: [
					{
						id: "scope",
						header: "Scope",
						question: "What should I do?",
						options: [{ label: "Implement", description: "Make the code change." }],
					},
				],
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.details).toEqual({
			scope: { answers: ["Implement", "user_note: ship after tests"] },
		});
		expect(result.content[0]?.text).toContain('"user_note: ship after tests"');
	});

	it("renders notes in the completed result", () => {
		const tool = registeredTool();
		const rendered = tool.renderResult(
			{
				content: [],
				details: {
					scope: { answers: ["Implement", "user_note: ship after tests"] },
				},
			},
			{ expanded: false, isPartial: false },
			plainTheme,
			undefined,
		);

		expect(normalizeRendered(rendered)).toContain("scope: Implement · user_note: ship after tests");
	});
});
