import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

import { platform } from "node:process";

import type { FilesystemMode, NetworkMode } from "./config.js";
import { collectTempRoots, safeRealpath } from "../shared/fs.js";
import { WORKSPACE_PROTECTED_RULES } from "./workspace-path-policy.js";
import { getHomeDir } from "../shared/home.js";

/**
 * Check if bwrap is available on the system.
 */
export async function isAsrtAvailable(): Promise<boolean> {
	try {
		execSync("bwrap --version", { stdio: "ignore" });
		return true;
	} catch {
		// Command probing is expected to fail when bubblewrap is absent.
		return false;
	}
}

/**
 * Get error message if bwrap is missing.
 */
export function getAsrtLoadError(): string | null {
	return "bubblewrap (bwrap) is not installed or not in PATH. It is required for sandboxed execution.";
}

/**
 * Check if a path exists.
 */
function exists(p: string): boolean {
	try {
		fs.accessSync(p);
		return true;
	} catch {
		// Missing mount roots are normal across distros; treat them as absent.
		return false;
	}
}

type WrapCommandResult =
	| { success: true; file: string; args: string[]; home: string }
	| { success: false; error: string };

export type ShellInvocation = {
	readonly file: string;
	readonly args: readonly string[];
};

/**
 * Wrap a bash command with bwrap sandbox restrictions.
 *
 * Ported from erg/packages/core/src/sandbox/bwrap.ts
 */
export async function wrapCommandWithSandbox(opts: {
	command: string;
	invocation?: ShellInvocation | undefined;
	workspaceRoot: string;
	filesystemMode: FilesystemMode;
	networkMode: NetworkMode;
}): Promise<WrapCommandResult> {
	const { command, workspaceRoot, filesystemMode, networkMode } = opts;
	const invocation = opts.invocation ?? { file: "bash", args: ["-lc", command] };

	// Sandboxed execution is Linux-only. bubblewrap (bwrap) requires Linux
	// namespaces; sandbox-exec on macOS is not implemented.
	if (platform === "darwin") {
		return {
			success: false,
			error:
				"Sandboxed execution is not supported on macOS (Darwin). Use Linux or run with --no-sandbox.",
		};
	}

	// Optimization: If full access is requested, skip sandbox entirely
	if (filesystemMode === "danger-full-access" && networkMode === "allow-all") {
		return {
			success: true,
			file: invocation.file,
			args: [...invocation.args],
			home: getHomeDir(),
		};
	}

	if (!(await isAsrtAvailable())) {
		return { success: false, error: getAsrtLoadError()! };
	}

	const resolvedWorkspace = safeRealpath(workspaceRoot);
	// Node.js spawn(file, args) prepends file as argv[0] automatically.
	// Do NOT include "bwrap" here — that would create a duplicate argv entry
	// that bwrap misinterprets as the command to execute inside the sandbox.
	const args: string[] = ["--new-session", "--die-with-parent"];

	// Minimal synthetic /dev (null, zero, full, random, urandom, tty) instead of
	// exposing all host devices. Isolate user/pid namespaces and mount fresh /proc.
	args.push("--dev", "/dev", "--proc", "/proc", "--unshare-user", "--unshare-pid", "--unshare-ipc");

	// /tmp handling: In workspace-write mode, bind the host /tmp so files persist
	// across tool calls. In read-only mode, use ephemeral tmpfs (writable scratch
	// space within a single call, but lost between calls).
	if (filesystemMode === "workspace-write") {
		for (const tmp of collectTempRoots()) {
			if (exists(tmp)) {
				args.push("--bind", tmp, tmp);
			}
		}
	} else {
		args.push("--tmpfs", "/tmp");
	}

	args.push("--tmpfs", "/run");

	// NixOS and other systems
	const bindPaths = [
		"/nix",
		"/bin",
		"/sbin",
		"/etc",
		"/run/current-system",
		"/lib64",
		"/usr",
		"/lib",
	];
	for (const p of bindPaths) {
		if (exists(p)) {
			args.push("--ro-bind", p, p);
		}
	}

	// Filesystem permissions
	// For read-only and workspace-write, we need the home directory readable
	const home = getHomeDir();
	const resolvedHome = safeRealpath(home);
	const resolvedHomeParent = path.dirname(resolvedHome);

	if (filesystemMode === "read-only") {
		// Bind the home parent read-only so writes to paths like /home/foo fail
		// instead of succeeding inside bubblewrap's synthetic parent directory.
		if (resolvedHomeParent !== "/" && exists(resolvedHomeParent)) {
			args.push("--ro-bind", resolvedHomeParent, resolvedHomeParent);
		} else {
			args.push("--ro-bind", resolvedHome, resolvedHome);
		}
		// Workspace binding comes after home so it takes precedence if workspace is under home
		if (!resolvedWorkspace.startsWith(resolvedHome)) {
			args.push("--ro-bind", resolvedWorkspace, resolvedWorkspace);
		}
	} else if (filesystemMode === "workspace-write") {
		// Bind the home parent read-only so writes to paths like /home/foo fail
		// instead of succeeding inside bubblewrap's synthetic parent directory.
		if (resolvedHomeParent !== "/" && exists(resolvedHomeParent)) {
			args.push("--ro-bind", resolvedHomeParent, resolvedHomeParent);
		} else {
			args.push("--ro-bind", resolvedHome, resolvedHome);
		}
		// Workspace binding comes after home so it takes precedence (writable overlay)
		args.push("--bind", resolvedWorkspace, resolvedWorkspace);
		// Protect sensitive subpaths as read-only within the writable workspace.
		// Instead of mounting each protected root as a whole and punching holes,
		// we mount every child recursively, skipping writable exceptions and paths
		// that contain them. This lets exceptions be created inside the sandbox
		// (via mkdir -p) even when they do not yet exist on the host.
		const allExceptions = WORKSPACE_PROTECTED_RULES.flatMap((rule) =>
			rule.writableExceptionSegments.map((exc) => path.join(resolvedWorkspace, exc)),
		);

		function roBindProtectedChildren(dirPath: string): void {
			if (!exists(dirPath)) return;
			let entries: string[];
			try {
				entries = fs.readdirSync(dirPath);
			} catch {
				// If the directory cannot be enumerated, skip granular binding here and
				// let the higher-level sandbox execution surface any later access error.
				return;
			}
			for (const entry of entries) {
				const childPath = path.join(dirPath, entry);
				const isException = allExceptions.some(
					(exc) => childPath === exc || childPath.startsWith(exc + path.sep),
				);
				const containsException = allExceptions.some(
					(exc) => exc.startsWith(childPath + path.sep),
				);
				if (isException) {
					// Skip — handled later (writable bind if it exists, otherwise
					// left unbound so it can be created inside the sandbox).
					continue;
				}
				if (containsException) {
					// Descend to bind this directory's other children.
					roBindProtectedChildren(childPath);
				} else {
					args.push("--ro-bind", childPath, childPath);
				}
			}
		}

		for (const rule of WORKSPACE_PROTECTED_RULES) {
			const rootPath = path.join(resolvedWorkspace, rule.rootSegment);
			const hasExistingException = rule.writableExceptionSegments.some((exc) =>
				exists(path.join(resolvedWorkspace, exc)),
			);
			if (hasExistingException) {
				// At least one writable exception exists on disk under this root.
				// Use granular child mounting so the exception stays writable and
				// missing exception paths can be created inside the sandbox.
				roBindProtectedChildren(rootPath);
			} else if (exists(rootPath)) {
				// No exceptions exist yet; mount the whole root read-only for safety.
				args.push("--ro-bind", rootPath, rootPath);
			}
		}

		// Writable exceptions must come AFTER any parent readonly binds.
		for (const excPath of allExceptions) {
			if (exists(excPath)) {
				args.push("--bind", excPath, excPath);
			}
		}
	} else if (filesystemMode === "danger-full-access") {
		args.push("--bind", "/", "/");
	}

	// Network permissions
	if (networkMode === "deny") {
		args.push("--unshare-net");
	}

	// Keep HOME as real home directory (read-only in sandbox)
	// Tools that try to write to ~/.config, ~/.cache will fail - that's intended

	// Final command assembly passed as argv to spawn (no shell string).
	args.push("--", invocation.file, ...invocation.args);

	return {
		success: true,
		file: "bwrap",
		args,
		home: resolvedHome,
	};
}
