import { describe, expect, it } from "vitest";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { ApprovalBroker } from "../src/agent/approval-broker.js";
import { checkBashApproval } from "../src/sandbox/approval.js";

const headlessContext = { hasUI: false } as unknown as ExtensionContext;

describe("sandbox approval", () => {
	it("shows the full command in escalation prompts", async () => {
		const command =
			"cd /home/ribelo/projects/shareablee/csai && git pull --rebase && git push && git status";
		let capturedMessage = "";

		const broker: ApprovalBroker = {
			async confirm(_title, message, _options) {
				capturedMessage = message;
				return false;
			},
		};

		await checkBashApproval(
			headlessContext,
			"on-request",
			command,
			true,
			{ timeoutSeconds: 1, justification: "Landing the plane." },
			broker,
		);

		expect(capturedMessage).toContain(command);
		expect(capturedMessage).not.toContain("...");
	});
});
