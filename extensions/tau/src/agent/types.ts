import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SandboxConfig } from "../sandbox/config.js";

export type AgentId = string;

export interface ModelSpec {
	readonly model: string; // "provider/model-id" or "inherit"
	readonly thinking?: ThinkingLevel | "inherit" | undefined;
}

export interface AgentDefinition {
	readonly name: string;
	readonly description: string;
	readonly models: readonly ModelSpec[];
	readonly tools?: readonly string[];
	readonly spawns?: readonly string[] | "*";
	readonly sandbox: SandboxConfig;
	readonly systemPrompt: string;
}
