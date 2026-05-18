/**
 * Approval flow for sandbox operations.
 *
 * Policies (matching Codex behavior):
 * - "never": Never prompt, run sandboxed, errors go to model
 * - "on-failure": Run sandboxed, prompt on sandbox failure to retry unsandboxed
 * - "on-request": Run sandboxed by default. Model can request escalation via `escalate` param
 * - "unless-trusted": Auto-approve safe commands, prompt for unsafe ones
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalPolicy } from "./config.js";
import { spawn } from "node:child_process";
import { classifySandboxFailure } from "./sandbox-diagnostics.js";
import { isSafeCommand } from "./safe-commands.js";
import type { ApprovalBroker } from "../agent/approval-broker.js";
import { stripAnsi } from "../shared/strip-ansi.js";

/** Result of an approval check */
type ApprovalResult =
	| { approved: true; runUnsandboxed?: boolean }
	| { approved: false; reason: string };

/** Options for approval check */
interface ApprovalOptions {
	/** Timeout in seconds (default: 60) */
	timeoutSeconds?: number;
	/** User-visible reason supplied by the model for escalation. */
	justification?: string;
	/** Optional command prefix rule proposed for future approvals. */
	prefixRule?: readonly string[];
}

function canPrompt(ctx: ExtensionContext, broker: ApprovalBroker | undefined): boolean {
	return Boolean(ctx.hasUI || broker);
}

function denial(reason: string): ApprovalResult {
	return { approved: false, reason };
}

/**
 * Send a desktop notification safely using spawn.
 * Fire-and-forget; uses detached spawn to avoid blocking the event loop.
 * Safe against command injection (arguments are not shell-expanded).
 */
function sendDesktopNotification(title: string, body: string): void {
	try {
		const child = spawn("notify-send", ["-u", "critical", title, body], {
			detached: true,
			stdio: "ignore",
		});
		child.on("error", () => {}); // Prevent crash if notify-send is missing
		child.unref();
	} catch {
		// ignore
	}
}

/**
 * Prompt user for approval with timeout.
 * Returns true if approved, false otherwise.
 */
async function promptForApproval(
	ctx: ExtensionContext,
	broker: ApprovalBroker | undefined,
	title: string,
	message: string,
	timeoutMs: number,
): Promise<boolean> {
	const canPromptLocally = Boolean(ctx.hasUI);
	if (!canPromptLocally && !broker) {
		return false;
	}

	if (canPromptLocally) {
		// Send desktop notification
		sendDesktopNotification("Sandbox Approval", title);
	}

	try {
		if (canPromptLocally) {
			return await ctx.ui.confirm(title, message, { timeout: timeoutMs });
		}
		return await broker!.confirm(title, message, { timeoutMs: timeoutMs });
	} catch (err) {
		// Log error instead of swallowing silently
		console.error("[Sandbox] Approval prompt failed:", err);
		return false;
	}
}

async function requestUnsandboxedApproval(
	ctx: ExtensionContext,
	broker: ApprovalBroker | undefined,
	commandPreview: string,
	timeoutMs: number,
	justification: string | undefined,
	prefixRule: readonly string[] | undefined,
): Promise<ApprovalResult> {
	if (!canPrompt(ctx, broker)) {
		return denial("Cannot prompt for escalation in headless mode");
	}

	const approved = await promptForApproval(
		ctx,
		broker,
		"Escalation requested",
		[
			"Model requests to run without sandbox:",
			"",
			commandPreview,
			...(justification ? ["", `Reason: ${justification}`] : []),
			...(prefixRule && prefixRule.length > 0
				? ["", `Suggested prefix rule: ${prefixRule.join(" ")}`]
				: []),
			"",
			"Allow?",
		].join("\n"),
		timeoutMs,
	);

	return approved
		? { approved: true, runUnsandboxed: true }
		: denial("Escalation not approved (declined or timed out)");
}

async function requestPolicyApproval(
	ctx: ExtensionContext,
	broker: ApprovalBroker | undefined,
	title: string,
	message: string,
	timeoutMs: number,
	deniedReason: string,
	success: ApprovalResult,
): Promise<ApprovalResult> {
	if (!canPrompt(ctx, broker)) {
		return denial("Cannot prompt for approval in headless mode");
	}

	const approved = await promptForApproval(ctx, broker, title, message, timeoutMs);
	return approved ? success : denial(deniedReason);
}

/**
 * Check if a bash command should be approved based on policy.
 *
 * @returns ApprovalResult with:
 *   - approved: true, runUnsandboxed: false → run in sandbox
 *   - approved: true, runUnsandboxed: true → run without sandbox (user approved escalation)
 *   - approved: false → block the command
 */
export async function checkBashApproval(
	ctx: ExtensionContext,
	policy: ApprovalPolicy,
	command: string,
	escalate: boolean,
	options?: ApprovalOptions,
	broker?: ApprovalBroker,
): Promise<ApprovalResult> {
	const timeoutMs = (options?.timeoutSeconds ?? 60) * 1000;

	// "never" - always run sandboxed, no prompts
	if (policy === "never") {
		return { approved: true, runUnsandboxed: false };
	}

	// "on-failure" - run sandboxed, handle failure separately
	if (policy === "on-failure") {
		return { approved: true, runUnsandboxed: false };
	}

	// Strip ANSI codes for display
	const cleanCmd = stripAnsi(command);

	// "on-request" - run sandboxed unless model requests escalation
	if (policy === "on-request") {
		if (!escalate) {
			// No escalation requested, run sandboxed
			return { approved: true, runUnsandboxed: false };
		}

		return requestUnsandboxedApproval(
			ctx,
			broker,
			cleanCmd,
			timeoutMs,
			options?.justification,
			options?.prefixRule,
		);
	}

	// "unless-trusted" - auto-approve safe commands, prompt for unsafe
	if (policy === "unless-trusted") {
		// If model explicitly requests escalation, prompt
		if (escalate) {
			return requestUnsandboxedApproval(
				ctx,
				broker,
				cleanCmd,
				timeoutMs,
				options?.justification,
				options?.prefixRule,
			);
		}

		// Check if command is safe
		if (isSafeCommand(command)) {
			// Safe command - run sandboxed without prompt
			return { approved: true, runUnsandboxed: false };
		}

		// Unsafe command - prompt user
		if (!canPrompt(ctx, broker)) {
			return denial("Unsafe command in headless mode");
		}

		return requestPolicyApproval(
			ctx,
			broker,
			"Command requires approval",
			`This command is not in the safe list:\n\n${cleanCmd}\n\nAllow?`,
			timeoutMs,
			"Command not approved (declined or timed out)",
			{ approved: true, runUnsandboxed: false },
		);
	}

	// Unknown policy - deny
	return { approved: false, reason: `Unknown approval policy: ${policy}` };
}

/**
 * Check if a filesystem operation should be approved.
 * Used for edit/write tools when path is outside allowed area.
 */
export async function checkFilesystemApproval(
	ctx: ExtensionContext,
	policy: ApprovalPolicy,
	targetPath: string,
	tool: string,
	options?: ApprovalOptions,
	broker?: ApprovalBroker,
): Promise<ApprovalResult> {
	const timeoutMs = (options?.timeoutSeconds ?? 60) * 1000;

	// "never" - deny without prompt
	if (policy === "never") {
		return {
			approved: false,
			reason: "Policy 'never' denies filesystem operations outside allowed paths",
		};
	}

	// "on-failure" - for edit/write, we pre-check so this acts like prompt
	// "on-request" / "unless-trusted" - prompt for filesystem operations
	return requestPolicyApproval(
		ctx,
		broker,
		`${tool}: path outside workspace`,
		`Tool: ${tool}\nPath: ${targetPath}\n\nAllow this operation?`,
		timeoutMs,
		"Not approved (declined or timed out)",
		{ approved: true },
	);
}

/**
 * Check if a failure looks like a sandbox policy violation.
 * Used for "on-failure" policy to decide whether to prompt.
 */
export function looksLikePolicyViolation(error: string): boolean {
	const classification = classifySandboxFailure(error);
	return classification.kind !== "unknown";
}

/**
 * Request approval after a sandbox failure (for "on-failure" policy).
 * Returns whether user approves retry without sandbox.
 */
export async function requestApprovalAfterFailure(
	ctx: ExtensionContext,
	command: string,
	error: string,
	options?: ApprovalOptions,
	broker?: ApprovalBroker,
): Promise<ApprovalResult> {
	const timeoutMs = (options?.timeoutSeconds ?? 60) * 1000;

	if (!ctx.hasUI && !broker) {
		return { approved: false, reason: "Cannot prompt in headless mode" };
	}

	// Strip ANSI codes to prevent TUI crashes
	const cleanCmd = stripAnsi(command);
	const cleanErr = stripAnsi(error);

	const errPreview = cleanErr.length > 200 ? cleanErr.slice(-200) : cleanErr;

	const approved = await promptForApproval(
		ctx,
		broker,
		"Command blocked by sandbox",
		`Command: ${cleanCmd}\n\nError: ${errPreview}\n\nRetry without sandbox?`,
		timeoutMs,
	);

	if (approved) {
		return { approved: true, runUnsandboxed: true };
	}
	return { approved: false, reason: "Retry not approved (declined or timed out)" };
}
