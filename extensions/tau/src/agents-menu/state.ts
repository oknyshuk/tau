import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Option } from "effect";

import { findNearestWorkspaceRoot } from "../shared/discovery.js";
import { atomicWriteFileStringSync } from "../shared/atomic-write.js";
import { isRecord, type AnyRecord } from "../shared/json.js";
import { LOOPS_STATE_DIR } from "../loops/paths.js";
import { decodeLoopPersistedStateJsonSync } from "../loops/schema.js";
import { resolveLoopWorkspaceRoot } from "../loops/workspace-root.js";

type ProjectAgentState = {
	readonly disabledAgents: Set<string>;
	settings: AnyRecord | null;
	ralphEnabledAgents: ReadonlyArray<string> | undefined;
	dirty: boolean;
};

type SettingsReadResult =
	| { readonly _tag: "missing" }
	| { readonly _tag: "valid"; readonly settings: AnyRecord }
	| { readonly _tag: "invalid" };

const DEFAULT_RALPH_ENABLED_AGENTS = ["finder"] as const;
const RALPH_SESSION_CACHE_KEY_DELIMITER = "\u0000";
const ralphOwnedSessionCache = new Map<string, boolean>();

type RalphLoopMetadata = {
	readonly loopName: string;
	readonly activeTools: ReadonlyArray<string>;
	readonly enabledAgents: ReadonlyArray<string>;
	readonly deferredEnabledAgents?: ReadonlyArray<string>;
};

function findDeferredRalphEnabledAgents(
	mutations: ReadonlyArray<{ readonly kind: string }>,
): ReadonlyArray<string> | undefined {
	for (let index = mutations.length - 1; index >= 0; index -= 1) {
		const mutation = mutations[index];
		if (
			mutation?.kind === "capabilityContractAgents" &&
			"enabledNames" in mutation &&
			Array.isArray(mutation.enabledNames)
		) {
			return mutation.enabledNames.filter((value): value is string => typeof value === "string");
		}
	}
	return undefined;
}

const ralphLoopMetadataCache = new Map<string, RalphLoopMetadata>();

function createProjectAgentState(
	disabledAgents: Iterable<string>,
	dirty: boolean,
	settings: AnyRecord | null,
	ralphEnabledAgents: ReadonlyArray<string> | undefined,
): ProjectAgentState {
	return {
		disabledAgents: new Set(disabledAgents),
		settings,
		ralphEnabledAgents,
		dirty,
	};
}

function readEnabledAgentsFromSettings(
	settings: AnyRecord | null,
): ReadonlyArray<string> | undefined {
	if (settings === null) {
		return undefined;
	}

	const tau = settings["tau"];
	if (!isRecord(tau)) {
		return undefined;
	}

	const agents = tau["agents"];
	if (!isRecord(agents)) {
		return undefined;
	}

	const enabled = agents["enabled"];
	if (!Array.isArray(enabled)) {
		return undefined;
	}

	return enabled.filter((value): value is string => typeof value === "string");
}

function readRalphEnabledAgentsFromSettings(
	settings: AnyRecord | null,
): ReadonlyArray<string> | undefined {
	if (settings === null) {
		return undefined;
	}

	const tau = settings["tau"];
	if (!isRecord(tau)) {
		return undefined;
	}

	const ralph = tau["ralph"];
	if (!isRecord(ralph)) {
		return undefined;
	}

	const agents = ralph["agents"];
	if (!isRecord(agents)) {
		return undefined;
	}

	const enabled = agents["enabled"];
	if (!Array.isArray(enabled)) {
		return undefined;
	}

	return enabled.filter((value): value is string => typeof value === "string");
}

function buildStateFromEnabledAgents(
	availableAgents: ReadonlyArray<string>,
	enabledAgents: ReadonlyArray<string> | undefined,
	settings: AnyRecord | null,
	ralphEnabledAgents: ReadonlyArray<string> | undefined,
): ProjectAgentState {
	if (enabledAgents === undefined) {
		return createProjectAgentState([], false, settings, ralphEnabledAgents);
	}

	const enabled = new Set(enabledAgents.filter((name) => availableAgents.includes(name)));
	return createProjectAgentState(
		availableAgents.filter((name) => !enabled.has(name)),
		false,
		settings,
		ralphEnabledAgents,
	);
}

function pruneStateToAvailableAgents(
	state: ProjectAgentState,
	availableAgents: ReadonlyArray<string>,
	settings: AnyRecord | null,
	ralphEnabledAgents: ReadonlyArray<string> | undefined,
): ProjectAgentState {
	const available = new Set(availableAgents);
	return createProjectAgentState(
		Array.from(state.disabledAgents).filter((name) => available.has(name)),
		state.dirty,
		settings,
		ralphEnabledAgents,
	);
}

async function readSettingsFile(settingsPath: string): Promise<SettingsReadResult> {
	try {
		const raw = await fs.readFile(settingsPath, "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) {
			return { _tag: "invalid" };
		}
		return { _tag: "valid", settings: parsed };
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) {
			return { _tag: "missing" };
		}
		return { _tag: "invalid" };
	}
}

async function writeSettingsFile(settingsPath: string, settings: AnyRecord): Promise<void> {
	atomicWriteFileStringSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

export function getAgentSettingsPath(cwd: string): string {
	return path.join(findNearestWorkspaceRoot(cwd), ".pi", "settings.json");
}

function getRalphStateDirectory(cwd: string): string {
	return path.join(resolveLoopWorkspaceRoot(cwd), LOOPS_STATE_DIR);
}

function makeRalphOwnedSessionCacheKey(cwd: string, sessionFile: string): string {
	return `${resolveLoopWorkspaceRoot(cwd)}${RALPH_SESSION_CACHE_KEY_DELIMITER}${sessionFile}`;
}

function isNodeError(err: unknown, code: string): boolean {
	return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

export function clearRalphOwnedSessionCache(cwd?: string): void {
	if (cwd === undefined) {
		ralphOwnedSessionCache.clear();
		ralphLoopMetadataCache.clear();
		return;
	}

	const prefix = `${resolveLoopWorkspaceRoot(cwd)}${RALPH_SESSION_CACHE_KEY_DELIMITER}`;
	for (const key of ralphOwnedSessionCache.keys()) {
		if (key.startsWith(prefix)) {
			ralphOwnedSessionCache.delete(key);
		}
	}
	for (const key of ralphLoopMetadataCache.keys()) {
		if (key.startsWith(prefix)) {
			ralphLoopMetadataCache.delete(key);
		}
	}
}

export function clearRalphOwnedSessionCacheEntry(cwd: string, sessionFile: string): void {
	const key = makeRalphOwnedSessionCacheKey(cwd, sessionFile);
	ralphOwnedSessionCache.delete(key);
	ralphLoopMetadataCache.delete(key);
}

export async function preloadRalphOwnedSessionCache(
	cwd: string,
	sessionFile: string | undefined,
): Promise<boolean> {
	if (sessionFile === undefined) {
		return false;
	}

	const cacheKey = makeRalphOwnedSessionCacheKey(cwd, sessionFile);
	const stateDir = getRalphStateDirectory(cwd);
	let entries: ReadonlyArray<string>;
	try {
		entries = await fs.readdir(stateDir);
	} catch (error: unknown) {
		if (isNodeError(error, "ENOENT")) {
			ralphOwnedSessionCache.delete(cacheKey);
			ralphLoopMetadataCache.delete(cacheKey);
			return false;
		}
		ralphOwnedSessionCache.delete(cacheKey);
		ralphLoopMetadataCache.delete(cacheKey);
		return false;
	}

	for (const entry of entries) {
		if (!entry.endsWith(".json")) {
			continue;
		}
		const filePath = path.join(stateDir, entry);
		try {
			const raw = await fs.readFile(filePath, "utf-8");
			const state = decodeLoopPersistedStateJsonSync(raw);
			if (stateOwnsSessionFile(sessionFile, state)) {
				ralphOwnedSessionCache.set(cacheKey, true);
				if (state.kind === "ralph") {
					const deferredEnabledAgents = findDeferredRalphEnabledAgents(
						state.ralph.deferredConfigMutations,
					);
					ralphLoopMetadataCache.set(cacheKey, {
						loopName: state.taskId,
						activeTools: state.ralph.capabilityContract.tools.activeNames,
						enabledAgents: state.ralph.capabilityContract.agents.enabledNames,
						...(deferredEnabledAgents === undefined ? {} : { deferredEnabledAgents }),
					});
				}
				return true;
			}
		} catch {
			continue;
		}
	}

	ralphOwnedSessionCache.delete(cacheKey);
	ralphLoopMetadataCache.delete(cacheKey);
	return false;
}

function stateOwnsSessionFile(
	sessionFile: string,
	state: ReturnType<typeof decodeLoopPersistedStateJsonSync>,
): boolean {
	if (state.kind !== "ralph") {
		return false;
	}
	if (state.lifecycle === "completed" || state.lifecycle === "archived") {
		return false;
	}

	const controllerMatches = Option.match(state.ownership.controller, {
		onNone: () => false,
		onSome: (controller) => controller.sessionFile === sessionFile,
	});
	if (controllerMatches) {
		return true;
	}

	return Option.match(state.ownership.child, {
		onNone: () => false,
		onSome: (child) => child.sessionFile === sessionFile,
	});
}

export function isRalphOwnedSession(cwd: string, sessionFile: string | undefined): boolean {
	if (sessionFile === undefined) {
		return false;
	}

	const cacheKey = makeRalphOwnedSessionCacheKey(cwd, sessionFile);
	return ralphOwnedSessionCache.get(cacheKey) ?? false;
}

export function getRalphLoopMetadata(
	cwd: string,
	sessionFile: string | undefined,
): RalphLoopMetadata | undefined {
	if (sessionFile === undefined) {
		return undefined;
	}
	const cacheKey = makeRalphOwnedSessionCacheKey(cwd, sessionFile);
	return ralphLoopMetadataCache.get(cacheKey);
}

export function setRalphLoopMetadata(
	cwd: string,
	sessionFile: string,
	meta: RalphLoopMetadata,
): void {
	const cacheKey = makeRalphOwnedSessionCacheKey(cwd, sessionFile);
	ralphOwnedSessionCache.set(cacheKey, true);
	ralphLoopMetadataCache.set(cacheKey, meta);
}

function isDisabledByRalphPolicy(
	_ralphEnabledAgents: ReadonlyArray<string> | undefined,
	cwd: string,
	sessionFile: string | undefined,
	name: string,
): boolean {
	if (!isRalphOwnedSession(cwd, sessionFile)) {
		return false;
	}

	const meta = getRalphLoopMetadata(cwd, sessionFile);
	const enabledAgents = meta?.enabledAgents ?? _ralphEnabledAgents ?? DEFAULT_RALPH_ENABLED_AGENTS;
	return !enabledAgents.includes(name);
}

export class AgentSelectionStore {
	private readonly states = new Map<string, ProjectAgentState>();

	async activate(cwd: string, availableAgents: ReadonlyArray<string>): Promise<void> {
		const settingsPath = getAgentSettingsPath(cwd);
		const settingsReadResult = await readSettingsFile(settingsPath);

		if (settingsReadResult._tag === "invalid") {
			this.states.set(
				settingsPath,
				createProjectAgentState(availableAgents, false, null, []),
			);
			return;
		}

		const settings =
			settingsReadResult._tag === "valid" ? settingsReadResult.settings : null;
		const ralphEnabledAgents = readRalphEnabledAgentsFromSettings(settings);

		const existing = this.states.get(settingsPath);
		if (existing !== undefined && existing.dirty) {
			this.states.set(
				settingsPath,
				pruneStateToAvailableAgents(existing, availableAgents, settings, ralphEnabledAgents),
			);
			return;
		}

		const enabledAgents = readEnabledAgentsFromSettings(settings);
		this.states.set(
			settingsPath,
			buildStateFromEnabledAgents(availableAgents, enabledAgents, settings, ralphEnabledAgents),
		);
	}

	isDisabledForCwd(cwd: string, name: string): boolean {
		const settingsPath = getAgentSettingsPath(cwd);
		const existing = this.states.get(settingsPath);
		return existing?.disabledAgents.has(name) ?? false;
	}

	isDisabledForSession(cwd: string, sessionFile: string | undefined, name: string): boolean {
		const state = this.getStateForCwdOrUndefined(cwd);
		if (isRalphOwnedSession(cwd, sessionFile)) {
			return isDisabledByRalphPolicy(state?.ralphEnabledAgents, cwd, sessionFile, name);
		}
		return this.isDisabledForCwd(cwd, name);
	}

	async resolveEnabledAgentsForSession(
		cwd: string,
		sessionFile: string | undefined,
		availableAgents: ReadonlyArray<string>,
	): Promise<ReadonlyArray<string>> {
		await this.activate(cwd, availableAgents);
		await preloadRalphOwnedSessionCache(cwd, sessionFile);
		return availableAgents.filter((name) => !this.isDisabledForSession(cwd, sessionFile, name));
	}

	setEnabledForCwd(cwd: string, name: string, enabled: boolean): void {
		const state = this.getStateForCwd(cwd);
		if (enabled) {
			state.disabledAgents.delete(name);
		} else {
			state.disabledAgents.add(name);
		}
		state.dirty = true;
	}

	isDirtyForCwd(cwd: string): boolean {
		return this.getStateForCwdOrUndefined(cwd)?.dirty ?? false;
	}

	async persistForCwd(cwd: string, availableAgents: ReadonlyArray<string>): Promise<string> {
		const settingsPath = getAgentSettingsPath(cwd);
		const state = this.getStateForCwd(cwd);
		const current = state.settings ?? {};
		const tau = isRecord(current["tau"]) ? { ...current["tau"] } : {};
		const agents = isRecord(tau["agents"]) ? { ...tau["agents"] } : {};
		const enabledAgents = availableAgents.filter((name) => !state.disabledAgents.has(name));

		agents["enabled"] = enabledAgents;
		tau["agents"] = agents;

		const next: AnyRecord = {
			...current,
			tau,
		};
		await writeSettingsFile(settingsPath, next);

		state.settings = next;
		state.ralphEnabledAgents = readRalphEnabledAgentsFromSettings(next);
		state.dirty = false;
		return settingsPath;
	}

	private getStateForCwd(cwd: string): ProjectAgentState {
		const state = this.getStateForCwdOrUndefined(cwd);
		if (state === undefined) {
			throw new Error(`No agent selection state for ${cwd}`);
		}
		return state;
	}

	private getStateForCwdOrUndefined(cwd: string): ProjectAgentState | undefined {
		return this.states.get(getAgentSettingsPath(cwd));
	}
}
