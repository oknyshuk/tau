import { Schema } from "effect";

const SandboxPreset = Schema.Literals(["read-only", "workspace-write", "full-access"]);
type SandboxPreset = Schema.Schema.Type<typeof SandboxPreset>;

const FilesystemMode = Schema.Literals([
	"read-only",
	"workspace-write",
	"danger-full-access",
]);
type FilesystemMode = Schema.Schema.Type<typeof FilesystemMode>;

const NetworkMode = Schema.Literals(["deny", "allow-all"]);
type NetworkMode = Schema.Schema.Type<typeof NetworkMode>;

const ApprovalPolicy = Schema.Literals([
	"never",
	"on-failure",
	"on-request",
	"unless-trusted",
]);
type ApprovalPolicy = Schema.Schema.Type<typeof ApprovalPolicy>;

export const ApprovalTimeoutSeconds = Schema.Number.check(
	Schema.isFinite(),
	Schema.isInt(),
	Schema.isGreaterThan(0),
);
export type ApprovalTimeoutSeconds = Schema.Schema.Type<typeof ApprovalTimeoutSeconds>;

/** User-facing sandbox config: preset-based */
export const SandboxConfig = Schema.Struct({
	preset: Schema.optional(SandboxPreset),
	subagent: Schema.optional(Schema.Boolean),
	// Legacy migration fields: used to infer preset when no preset is given
	filesystemMode: Schema.optional(FilesystemMode),
	networkMode: Schema.optional(NetworkMode),
	approvalPolicy: Schema.optional(ApprovalPolicy),
	approvalTimeoutSeconds: Schema.optional(ApprovalTimeoutSeconds),
});
export type SandboxConfig = Schema.Schema.Type<typeof SandboxConfig>;

/** Resolved internal config with all fields expanded */
export const SandboxConfigRequired = Schema.Struct({
	preset: SandboxPreset,
	filesystemMode: FilesystemMode,
	networkMode: NetworkMode,
	approvalPolicy: ApprovalPolicy,
	approvalTimeoutSeconds: ApprovalTimeoutSeconds,
	subagent: Schema.Boolean,
});
export type SandboxConfigRequired = Schema.Schema.Type<typeof SandboxConfigRequired>;
