import * as path from "node:path";

import { getHomeDir } from "../shared/home.js";

export function dreamTranscriptRoot(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(getPiAgentDir(), "sessions", safePath);
}

function getPiAgentDir(): string {
	const envDir = process.env["PI_CODING_AGENT_DIR"];
	if (envDir === undefined) {
		return path.join(getHomeDir(), ".pi", "agent");
	}

	if (envDir === "~") {
		return getHomeDir();
	}

	if (envDir.startsWith("~/")) {
		return path.join(getHomeDir(), envDir.slice(2));
	}

	return envDir;
}

export function isDreamTranscriptFile(fileName: string): boolean {
	return fileName.endsWith(".jsonl");
}

export function parseDreamTranscriptSessionId(filePath: string): string | null {
	const baseName = path.basename(filePath, ".jsonl");
	const separatorIndex = baseName.indexOf("_");

	if (separatorIndex <= 0 || separatorIndex >= baseName.length - 1) {
		return null;
	}

	return baseName.slice(separatorIndex + 1);
}
