import { spawnSync } from "node:child_process";

type SandboxPrereqCheckResult = {
	missingRequired: string[];
	missingOptional: string[];
};

type CommandExistsFn = (cmd: string) => boolean;

function defaultCommandExists(cmd: string): boolean {
	try {
		const res = spawnSync("which", [cmd], { stdio: "ignore" });
		return res.status === 0;
	} catch {
		return false;
	}
}

export function detectMissingSandboxDeps(opts: {
	platform: NodeJS.Platform;
	commandExists?: CommandExistsFn;
}): SandboxPrereqCheckResult {
	const commandExists = opts.commandExists ?? defaultCommandExists;

	const missingRequired: string[] = [];
	const missingOptional: string[] = [];

	if (opts.platform === "linux") {
		if (!commandExists("bwrap")) missingRequired.push("bwrap");
	}

	if (opts.platform === "darwin") {
		// Sandboxed execution is not implemented for macOS. bubblewrap (bwrap)
		// is Linux-only, and sandbox-exec wrapping is not implemented.
		// Report Darwin as unsupported so callers fall back to unsandboxed.
		missingRequired.push("sandboxed execution is not supported on macOS");
	}

	return { missingRequired, missingOptional };
}

export function formatMissingDepsMessage(result: SandboxPrereqCheckResult): string {
	const parts: string[] = [];
	if (result.missingRequired.length > 0) {
		parts.push(`missing required deps: ${result.missingRequired.join(", ")}`);
	}
	if (result.missingOptional.length > 0) {
		parts.push(`missing optional deps: ${result.missingOptional.join(", ")}`);
	}
	return parts.join("; ");
}
