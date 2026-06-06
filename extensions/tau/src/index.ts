import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { installSqliteExperimentalWarningFilter } from "./shared/sqlite-warning.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(__dirname, "..", "skills");
const bundledSkillPaths = [
	"backlog-planning",
	"backlog",
	"code-review",
	"ralph-loop-creation",
].map((skillName) => join(skillsDir, skillName));

installSqliteExperimentalWarningFilter();

export default async function tau(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => ({
		skillPaths: bundledSkillPaths,
	}));

	const { startTau } = await import("./app.js");
	const { ready } = startTau(pi);
	await ready;
}
