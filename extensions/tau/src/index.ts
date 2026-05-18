import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { installSqliteExperimentalWarningFilter } from "./shared/sqlite-warning.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillsDir = join(__dirname, "..", "skills");

installSqliteExperimentalWarningFilter();

export default async function tau(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => ({
		skillPaths: [skillsDir],
	}));

	const { startTau } = await import("./app.js");
	const { ready } = startTau(pi);
	await ready;
}
