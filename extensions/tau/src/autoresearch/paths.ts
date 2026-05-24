export const AUTORESEARCH_DIR = ".autoresearch";
const AUTORESEARCH_RUNS_DIR = ".autoresearch/runs";
export const AUTORESEARCH_JSONL = "autoresearch.jsonl";
export const AUTORESEARCH_MD = "autoresearch.md";
export const AUTORESEARCH_SH = "autoresearch.sh";
export const AUTORESEARCH_CHECKS_SH = "autoresearch.checks.sh";
export const AUTORESEARCH_IDEAS_MD = "autoresearch.ideas.md";
export const AUTORESEARCH_CONFIG_JSON = "autoresearch.config.json";
const AUTORESEARCH_PROGRAM_MD = "autoresearch.program.md";

const AUTORESEARCH_COMMITTABLE_FILES = [
	AUTORESEARCH_MD,
	AUTORESEARCH_PROGRAM_MD,
	AUTORESEARCH_SH,
	AUTORESEARCH_CHECKS_SH,
	AUTORESEARCH_IDEAS_MD,
] as const;

const AUTORESEARCH_LOCAL_STATE_FILES = [AUTORESEARCH_JSONL] as const;
const AUTORESEARCH_LOCAL_STATE_DIRECTORIES = [AUTORESEARCH_DIR] as const;
