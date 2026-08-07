/**
 * Capability policy for one structured subagent runtime.
 *
 * The execution-environment binding deliberately does not participate in this
 * policy. It only supplies data-plane routing and path projection; callers must
 * resolve and pass a profile before the executor sees the binding.
 */

import type { ExecutionEnvironmentProvider } from "../session/execution-environment";

/** Minimum claimed runtime identity accepted by structured task execution. */
export interface TransientTaskRuntimeInjectionV1 {
	readonly taskId: string;
	readonly runId: string;
	readonly createId: string;
	readonly executionEnvironmentProvider: ExecutionEnvironmentProvider;
}

/** Validate the exact claimed runtime boundary without cloning or widening its authority. */
export function validateTransientTaskRuntimeInjectionV1<T extends TransientTaskRuntimeInjectionV1>(runtime: T): T {
	if (
		runtime === null ||
		typeof runtime !== "object" ||
		typeof runtime.taskId !== "string" ||
		runtime.taskId.length === 0 ||
		runtime.taskId.includes("\0") ||
		typeof runtime.runId !== "string" ||
		runtime.runId.length === 0 ||
		runtime.runId.includes("\0") ||
		typeof runtime.createId !== "string" ||
		runtime.createId.length === 0 ||
		runtime.createId.includes("\0") ||
		runtime.executionEnvironmentProvider === null ||
		typeof runtime.executionEnvironmentProvider !== "object" ||
		typeof runtime.executionEnvironmentProvider.acquire !== "function"
	) {
		throw new TypeError("Transient task runtime injection is invalid");
	}
	return runtime;
}

/** Executor capabilities which may widen a child beyond its base tool set. */
export const SUBAGENT_RUNTIME_CAPABILITIES = [
	"spawns",
	"prewalk",
	"lsp",
	"irc",
	"mcp",
	"extensions",
	"customTools",
	"sharedEvalState",
	"keepAlive",
	"revival",
] as const;

export type SubagentRuntimeCapability = (typeof SUBAGENT_RUNTIME_CAPABILITIES)[number];

export type SubagentToolPolicy = Readonly<{ mode: "agent" }> | Readonly<{ mode: "exact"; names: readonly string[] }>;

export interface SubagentRuntimeProfile {
	readonly tools: SubagentToolPolicy;
	readonly restrictToolNames: boolean;
	readonly bash: "inherit" | "enabled";
	readonly capabilities: Readonly<Record<SubagentRuntimeCapability, boolean>>;
}

export interface LocalSubagentRuntimeProfileOptions {
	readonly restrictToolNames?: boolean;
	readonly enableSpawns?: boolean;
	readonly enablePrewalk?: boolean;
	readonly enableLsp?: boolean;
	readonly enableIrc?: boolean;
	readonly enableMCP?: boolean;
	readonly enableExtensions?: boolean;
	readonly enableCustomTools?: boolean;
	readonly shareEvalState?: boolean;
	readonly keepAlive?: boolean;
	readonly enableRevival?: boolean;
}

function freezeProfile(profile: SubagentRuntimeProfile): SubagentRuntimeProfile {
	const tools =
		profile.tools.mode === "exact"
			? Object.freeze({ mode: "exact" as const, names: Object.freeze([...profile.tools.names]) })
			: Object.freeze({ mode: "agent" as const });
	return Object.freeze({
		tools,
		restrictToolNames: profile.restrictToolNames,
		bash: profile.bash,
		capabilities: Object.freeze({ ...profile.capabilities }),
	});
}

/**
 * Build the ordinary local profile. Defaults intentionally preserve the legacy
 * executor surface for direct callers which do not use structured preflight.
 */
export function createLocalSubagentRuntimeProfile(
	options: LocalSubagentRuntimeProfileOptions = {},
): SubagentRuntimeProfile {
	const restrictToolNames = options.restrictToolNames === true;
	const keepAlive = options.keepAlive !== false;
	return freezeProfile({
		tools: { mode: "agent" },
		restrictToolNames,
		bash: "inherit",
		capabilities: {
			spawns: options.enableSpawns !== false,
			prewalk: !restrictToolNames && options.enablePrewalk !== false,
			lsp: options.enableLsp !== false,
			irc: options.enableIrc !== false,
			mcp: !restrictToolNames && options.enableMCP !== false,
			extensions: !restrictToolNames && options.enableExtensions !== false,
			customTools: !restrictToolNames && options.enableCustomTools !== false,
			sharedEvalState: options.shareEvalState !== false,
			keepAlive,
			revival: keepAlive && options.enableRevival !== false,
		},
	});
}

/** The complete, canonical authority of an execution-environment child. */
export const ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE: SubagentRuntimeProfile = freezeProfile({
	tools: { mode: "exact", names: ["read", "write", "bash"] },
	restrictToolNames: true,
	bash: "enabled",
	capabilities: {
		spawns: false,
		prewalk: false,
		lsp: false,
		irc: false,
		mcp: false,
		extensions: false,
		customTools: false,
		sharedEvalState: false,
		keepAlive: false,
		revival: false,
	},
});

/** Missing or malformed capability entries deny access rather than widening it. */
export function subagentRuntimeAllows(profile: SubagentRuntimeProfile, capability: SubagentRuntimeCapability): boolean {
	return profile.capabilities?.[capability] === true;
}

/** Missing or malformed restriction state is treated as restricted. */
export function subagentRuntimeRestrictsToolNames(profile: SubagentRuntimeProfile): boolean {
	return profile.restrictToolNames !== false;
}

/** Resolve the profile's base tool names. Unknown policy shapes fail closed. */
export function resolveSubagentRuntimeToolNames(
	profile: SubagentRuntimeProfile,
	agentToolNames: readonly string[] | undefined,
): string[] | undefined {
	if (profile.tools?.mode === "exact") {
		return Array.isArray(profile.tools.names) ? [...profile.tools.names] : [];
	}
	if (profile.tools?.mode === "agent") {
		return agentToolNames && agentToolNames.length > 0 ? [...agentToolNames] : undefined;
	}
	return [];
}
