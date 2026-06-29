import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const QuestionOption = Type.Object({
	label: Type.String({ description: "User-facing label (1-5 words)." }),
	description: Type.String({
		description: "One short sentence explaining impact/tradeoff if selected.",
	}),
});

const Question = Type.Object({
	id: Type.String({
		description: "Stable identifier for mapping answers (snake_case).",
	}),
	header: Type.String({
		description: "Short header label shown in the UI (12 or fewer chars).",
	}),
	question: Type.String({
		description: "Single-sentence prompt shown to the user.",
	}),
	options: Type.Array(QuestionOption, {
		description:
			'Provide 2-4 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". An "Other" free-form option is added automatically.',
	}),
});

const RequestUserInputParams = Type.Object({
	questions: Type.Array(Question, {
		description: "Questions to show the user. Prefer 1 and do not exceed 3.",
	}),
});

type QuestionInput = {
	id: string;
	header: string;
	question: string;
	options: Array<{ label: string; description: string }>;
};

type AnswerEntry = {
	answers: string[];
};

type AnswersMap = Record<string, AnswerEntry>;

type QuestionAnswer = {
	label: string;
	note: string;
};

const OTHER_OPTION_LABEL = "None of the above";
const OTHER_OPTION_DESCRIPTION = "Optionally, add details in notes (tab).";

function answerToEntries(answer: QuestionAnswer): string[] {
	const entries = [answer.label];
	const note = answer.note.trim();
	if (note.length > 0) {
		entries.push(`user_note: ${note}`);
	}
	return entries;
}

function renderAnswer(answer: AnswerEntry): string {
	return answer.answers.join(" · ");
}

async function askQuestionWithNotes(
	ctx: ExtensionContext,
	question: QuestionInput,
	signal: AbortSignal | undefined,
): Promise<QuestionAnswer | undefined> {
	if (signal?.aborted) return undefined;

	return ctx.ui.custom<QuestionAnswer | undefined>((tui, theme, _kb, done) => {
		const options = [
			...question.options,
			{ label: OTHER_OPTION_LABEL, description: OTHER_OPTION_DESCRIPTION },
		];
		let optionIndex = 0;
		let notesMode = false;
		let cachedLines: string[] | undefined;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function selectedLabel(): string {
			return options[optionIndex]?.label ?? OTHER_OPTION_LABEL;
		}

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(note: string) {
			done({ label: selectedLabel(), note });
		}

		const onAbort = () => {
			done(undefined);
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		editor.onSubmit = (value) => {
			submit(value);
		};

		return {
			render(width: number): string[] {
				if (cachedLines) return cachedLines;

				const lines: string[] = [];
				const add = (line: string) => lines.push(truncateToWidth(line, width));
				const border = theme.fg("accent", "─".repeat(width));

				add(border);
				add(`${theme.fg("accent", question.header + ":")} ${theme.fg("text", question.question)}`);
				lines.push("");

				for (let i = 0; i < options.length; i++) {
					const option = options[i];
					if (!option) continue;
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const label = selected ? theme.fg("accent", option.label) : theme.fg("text", option.label);
					add(`${prefix}${i + 1}. ${label}`);
					add(`     ${theme.fg("muted", option.description)}`);
				}

				if (notesMode) {
					lines.push("");
					add(theme.fg("muted", " Notes:"));
					for (const line of editor.render(Math.max(1, width - 2))) {
						add(` ${line}`);
					}
				}

				lines.push("");
				if (notesMode) {
					add(theme.fg("dim", " Enter to submit answer • Esc to clear notes"));
				} else {
					add(theme.fg("dim", " ↑↓ navigate • Tab to add notes • Enter to submit answer • Esc to cancel"));
				}
				add(border);

				cachedLines = lines;
				return lines;
			},
			invalidate() {
				cachedLines = undefined;
			},
			handleInput(data: string) {
				if (notesMode) {
					if (matchesKey(data, Key.escape)) {
						notesMode = false;
						editor.setText("");
						refresh();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				if (matchesKey(data, Key.up) || data === "k") {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}

				if (matchesKey(data, Key.down) || data === "j") {
					optionIndex = Math.min(options.length - 1, optionIndex + 1);
					refresh();
					return;
				}

				if (matchesKey(data, Key.tab)) {
					notesMode = true;
					refresh();
					return;
				}

				if (matchesKey(data, Key.enter)) {
					submit("");
					return;
				}

				if (matchesKey(data, Key.escape)) {
					done(undefined);
				}
			},
			dispose() {
				signal?.removeEventListener("abort", onAbort);
			},
		};
	});
}

export default function initRequestUserInput(pi: ExtensionAPI) {
	pi.registerTool({
		name: "request_user_input",
		label: "request_user_input",
		description:
			"Request user input for one to three short questions with multiple-choice options and wait for the response. Use for decisions that materially change the plan, for confirming important assumptions, or for information that cannot be discovered via non-mutating exploration.",
		promptSnippet:
			"request_user_input: Present structured multiple-choice questions to the user for decisions and tradeoffs.",
		parameters: RequestUserInputParams,

		renderCall(args, theme) {
			const questions = (args as { questions?: QuestionInput[] }).questions ?? [];
			let out = theme.fg("toolTitle", theme.bold("request_user_input"));
			if (questions.length > 0) {
				out += ` ${theme.fg("dim", `${questions.length} question${questions.length > 1 ? "s" : ""}`)}`;
			}

			for (const q of questions) {
				out += `\n  ${theme.fg("accent", q.header + ":")} ${theme.fg("toolOutput", q.question)}`;
				for (const opt of q.options) {
					out += `\n    ${theme.fg("muted", "·")} ${opt.label} ${theme.fg("dim", `— ${opt.description}`)}`;
				}
			}
			return new Text(out, 0, 0);
		},

		renderResult(result, options, theme) {
			if (options.isPartial) {
				return new Text(theme.fg("warning", "Waiting for user input…"), 0, 0);
			}

			const answers = result.details as AnswersMap | undefined;
			if (!answers || Object.keys(answers).length === 0) {
				return new Text(theme.fg("dim", "(no answers)"), 0, 0);
			}

			const entries = Object.entries(answers);
			let out = "";
			for (let i = 0; i < entries.length; i++) {
				const [id, answer] = entries[i]!;
				if (i > 0) out += "\n";
				out += `  ${theme.fg("accent", id + ":")} ${theme.fg("toolOutput", renderAnswer(answer))}`;
			}
			return new Text(out, 0, 0);
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text: "request_user_input is unavailable without a UI.",
						},
					],
					details: undefined,
				};
			}

			const answers: AnswersMap = {};

			for (const question of params.questions) {
				if (signal?.aborted) {
					return {
						content: [
							{
								type: "text" as const,
								text: "request_user_input was cancelled.",
							},
						],
						details: undefined,
					};
				}

				const answer = await askQuestionWithNotes(ctx, question, signal);

				if (answer === undefined) {
					return {
						content: [
							{
								type: "text" as const,
								text: "request_user_input was cancelled before receiving a response.",
							},
						],
						details: undefined,
					};
				}

				answers[question.id] = { answers: answerToEntries(answer) };
			}

			const result = JSON.stringify({ answers }, null, 2);
			return {
				content: [{ type: "text" as const, text: result }],
				details: answers,
			};
		},
	});
}
