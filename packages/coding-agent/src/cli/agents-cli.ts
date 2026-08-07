/**
 * Agents CLI command handlers.
 *
 * Preserves `omp agents unpack` and implements the bounded persistent-agent
 * lifecycle command family defined by the adaptive runtime contract.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir, isEnoent } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import chalk from "chalk";
import { Settings } from "../config/settings";
import { theme } from "../modes/theme/theme";
import {
	decodePersistentRuntimePolicyV1,
	materializePersistentRuntimePolicyV1,
	PERSISTENT_RUNTIME_POLICY_INTEGER_MAX_V1,
	type PersistentAgentHandle,
	type PersistentAgentRecoveryAction,
	type PersistentRuntimePolicy,
	type PersistentRuntimePolicyOverlayV1,
} from "../registry/persistent-agent-contracts.js";
import * as persistentSdk from "../sdk";
import { materializeWorkspaceRetentionPolicyV1 } from "../session/workspace-runtime-contracts.js";
import { loadBundledAgents } from "../task/agents";
import type { AgentDefinition } from "../task/types";

export const AGENTS_ACTIONS = [
	"unpack",
	"create",
	"open",
	"send",
	"status",
	"set-runtime-policy",
	"park",
	"release",
	"delete-workspace",
	"retry-cleanup",
	"purge-workspace",
	"recover",
] as const;

export type AgentsAction = (typeof AGENTS_ACTIONS)[number];

export const PERSISTENT_RUNTIME_POLICY_FLAG_NAMES = [
	"placement",
	"provider-id",
	"os",
	"arch",
	"min-cpu",
	"min-memory-mib",
	"network",
	"max-ready-latency-ms",
	"idle-runtime-ttl-ms",
] as const;

type PersistentRuntimePolicyFlagName = (typeof PERSISTENT_RUNTIME_POLICY_FLAG_NAMES)[number];

export interface AgentsCommandFlags {
	force?: boolean;
	json?: boolean;
	dir?: string;
	user?: boolean;
	project?: boolean;
	kind?: "main" | "sub";
	parent?: string;
	modelProfile?: string;
	empty?: boolean;
	copyFrom?: string;
	action?: PersistentAgentRecoveryAction;
	deleteWorkspace?: boolean;
	placement?: string;
	providerId?: string;
	os?: string;
	arch?: string;
	minCpu?: string;
	minMemoryMib?: string;
	network?: string;
	maxReadyLatencyMs?: string;
	idleRuntimeTtlMs?: string;
}

export interface AgentsCommandArgs {
	action: AgentsAction;
	args: string[];
	flags: AgentsCommandFlags;
}

interface UnpackResult {
	targetDir: string;
	total: number;
	written: string[];
	skipped: string[];
}

function writeStdout(line: string): void {
	process.stdout.write(`${line}\n`);
}

function resolveTargetDir(flags: AgentsCommandFlags): string {
	if (flags.dir && flags.dir.trim().length > 0) return path.resolve(getProjectDir(), flags.dir.trim());
	if (flags.user && flags.project) throw new Error("Choose either --user or --project, not both.");
	if (flags.project) return path.resolve(getProjectDir(), ".omp", "agents");
	return path.join(getAgentDir(), "agents");
}

function toFrontmatter(agent: AgentDefinition): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = { name: agent.name, description: agent.description };
	if (agent.tools && agent.tools.length > 0) frontmatter.tools = agent.tools;
	if (agent.spawns !== undefined) frontmatter.spawns = agent.spawns;
	if (agent.model && agent.model.length > 0) frontmatter.model = agent.model;
	if (agent.thinkingLevel) frontmatter.thinkingLevel = agent.thinkingLevel;
	if (agent.output !== undefined) frontmatter.output = agent.output;
	if (agent.blocking) frontmatter.blocking = true;
	return frontmatter;
}

function serializeAgent(agent: AgentDefinition): string {
	const frontmatter = YAML.stringify(toFrontmatter(agent), null, 2).trimEnd();
	return `---\n${frontmatter}\n---\n\n${agent.systemPrompt.trim()}\n`;
}

async function unpackBundledAgents(flags: AgentsCommandFlags): Promise<UnpackResult> {
	const targetDir = resolveTargetDir(flags);
	await fs.mkdir(targetDir, { recursive: true });
	const bundledAgents = [...loadBundledAgents()].sort((a, b) => a.name.localeCompare(b.name));
	const written: string[] = [];
	const skipped: string[] = [];
	for (const agent of bundledAgents) {
		const filePath = path.join(targetDir, `${agent.name}.md`);
		if (!flags.force) {
			try {
				await fs.stat(filePath);
				skipped.push(filePath);
				continue;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		await Bun.write(filePath, serializeAgent(agent));
		written.push(filePath);
	}
	return { targetDir, total: bundledAgents.length, written, skipped };
}

function requireCanonicalValue(value: string | undefined, label: string): string {
	if (!value || value.trim() !== value) throw new Error(`${label} must be a non-empty canonical value`);
	return value;
}

function parseIntegerLexeme(value: string | undefined, flag: string): number {
	if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
		throw new Error(`--${flag} must be an integer lexeme in 0..${PERSISTENT_RUNTIME_POLICY_INTEGER_MAX_V1}`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > PERSISTENT_RUNTIME_POLICY_INTEGER_MAX_V1) {
		throw new Error(`--${flag} must be an integer lexeme in 0..${PERSISTENT_RUNTIME_POLICY_INTEGER_MAX_V1}`);
	}
	return parsed;
}

function parseClosedValue<const Value extends string>(value: string, flag: string, values: readonly Value[]): Value {
	if (!values.includes(value as Value)) throw new Error(`--${flag} must be one of: ${values.join(", ")}`);
	return value as Value;
}

export function parsePersistentRuntimePolicyFlags(flags: AgentsCommandFlags): PersistentRuntimePolicyOverlayV1 {
	const overlay: PersistentRuntimePolicyOverlayV1 = {
		...(flags.placement === undefined
			? {}
			: { placement: parseClosedValue(flags.placement, "placement", ["local", "cloud", "auto"] as const) }),
		...(flags.providerId === undefined
			? {}
			: {
					providerId:
						flags.providerId === "null" ? null : requireCanonicalValue(flags.providerId, "--provider-id"),
				}),
		...(flags.os === undefined
			? {}
			: {
					os:
						flags.os === "any" ? null : parseClosedValue(flags.os, "os", ["darwin", "linux", "windows"] as const),
				}),
		...(flags.arch === undefined
			? {}
			: { arch: flags.arch === "any" ? null : parseClosedValue(flags.arch, "arch", ["arm64", "x64"] as const) }),
		...(flags.minCpu === undefined ? {} : { minCpu: parseIntegerLexeme(flags.minCpu, "min-cpu") }),
		...(flags.minMemoryMib === undefined
			? {}
			: { minMemoryMiB: parseIntegerLexeme(flags.minMemoryMib, "min-memory-mib") }),
		...(flags.network === undefined
			? {}
			: { network: parseClosedValue(flags.network, "network", ["none", "egress"] as const) }),
		...(flags.maxReadyLatencyMs === undefined
			? {}
			: {
					maxReadyLatencyMs:
						flags.maxReadyLatencyMs === "null"
							? null
							: parseIntegerLexeme(flags.maxReadyLatencyMs, "max-ready-latency-ms"),
				}),
		...(flags.idleRuntimeTtlMs === undefined
			? {}
			: { idleRuntimeTtlMs: parseIntegerLexeme(flags.idleRuntimeTtlMs, "idle-runtime-ttl-ms") }),
	};
	return overlay;
}

export function materializeCreateRuntimePolicy(
	settingsOverlay: PersistentRuntimePolicyOverlayV1,
	flags: AgentsCommandFlags,
): PersistentRuntimePolicy {
	return materializePersistentRuntimePolicyV1({ ...settingsOverlay, ...parsePersistentRuntimePolicyFlags(flags) });
}

export function materializeRuntimePolicyUpdate(
	current: PersistentRuntimePolicy,
	flags: AgentsCommandFlags,
): PersistentRuntimePolicy {
	const overlay = parsePersistentRuntimePolicyFlags(flags);
	if (Reflect.ownKeys(overlay).length === 0)
		throw new Error("set-runtime-policy requires at least one runtime policy flag");
	return decodePersistentRuntimePolicyV1({ ...current, ...overlay });
}

export function assertNoDuplicatePersistentRuntimePolicyFlags(argv: readonly string[]): void {
	const counts = new Map<PersistentRuntimePolicyFlagName, number>();
	for (const token of argv) {
		if (!token.startsWith("--")) continue;
		const name = token.slice(2).split("=", 1)[0] as PersistentRuntimePolicyFlagName;
		if (!PERSISTENT_RUNTIME_POLICY_FLAG_NAMES.includes(name)) continue;
		const count = (counts.get(name) ?? 0) + 1;
		if (count > 1) throw new Error(`--${name} may be supplied at most once`);
		counts.set(name, count);
	}
}

function requireAgentId(args: readonly string[], exactLength = 1): string {
	if (args.length !== exactLength) throw new Error("Expected exactly one AGENT_ID");
	return requireCanonicalValue(args[0], "AGENT_ID");
}

function printResult(result: unknown, json: boolean | undefined): void {
	writeStdout(JSON.stringify(result, null, json ? undefined : 2));
}

async function parkAfter(handle: PersistentAgentHandle, operation: () => Promise<unknown>) {
	try {
		await operation();
	} catch (error) {
		try {
			await handle.park();
		} catch (parkError) {
			throw new AggregateError([error, parkError], "Persistent agent operation and park both failed");
		}
		throw error;
	}
	return handle.park();
}

async function runPersistentAgentsCommand(cmd: AgentsCommandArgs): Promise<void> {
	const settings = await Settings.init();
	if (!settings.get("agents.persistent.enabled")) throw new Error("Persistent agents are disabled by settings");
	const agentId = requireAgentId(cmd.args, cmd.action === "send" ? cmd.args.length : 1);

	switch (cmd.action) {
		case "create": {
			if (!cmd.flags.kind) throw new Error("create requires --kind main|sub");
			const modelProfileId = requireCanonicalValue(cmd.flags.modelProfile, "--model-profile");
			const profiles = settings.get("modelConnections");
			if (!Object.hasOwn(profiles, modelProfileId))
				throw new Error(`Unknown model connection profile: ${modelProfileId}`);
			if (cmd.flags.empty === Boolean(cmd.flags.copyFrom))
				throw new Error("create requires exactly one of --empty or --copy-from");
			const runtimePolicy = materializeCreateRuntimePolicy(
				settings.get("agents.persistent.defaultRuntimePolicy"),
				cmd.flags,
			);
			const handle = await persistentSdk.createPersistentAgent({
				id: agentId,
				displayName: agentId,
				kind: cmd.flags.kind,
				...(cmd.flags.parent ? { parentAgentId: requireCanonicalValue(cmd.flags.parent, "--parent") } : {}),
				workspace: cmd.flags.empty
					? { kind: "empty" }
					: { kind: "copy", sourcePath: requireCanonicalValue(cmd.flags.copyFrom, "--copy-from") },
				modelProfileId,
				runtimePolicy,
			});
			printResult(await handle.park(), cmd.flags.json);
			return;
		}
		case "open":
		case "park": {
			const handle = await persistentSdk.openPersistentAgent(agentId);
			printResult(await handle.park(), cmd.flags.json);
			return;
		}
		case "send": {
			if (cmd.args.length < 2) throw new Error("send requires AGENT_ID and MESSAGE");
			const message = cmd.args.slice(1).join(" ");
			if (message.length === 0) throw new Error("send MESSAGE must be non-empty");
			const handle = await persistentSdk.openPersistentAgent(agentId);
			printResult(await parkAfter(handle, () => handle.send(message)), cmd.flags.json);
			return;
		}
		case "status":
			printResult(await persistentSdk.getPersistentAgentStatus(agentId), cmd.flags.json);
			return;
		case "set-runtime-policy": {
			const status = await persistentSdk.getPersistentAgentStatus(agentId);
			if (status.kind !== "present") throw new Error(`Persistent agent is ${status.kind}`);
			const policy = materializeRuntimePolicyUpdate(status.runtimePolicy, cmd.flags);
			printResult(await persistentSdk.setPersistentAgentRuntimePolicy(agentId, policy), cmd.flags.json);
			return;
		}
		case "release": {
			const retention = materializeWorkspaceRetentionPolicyV1(settings.get("agents.persistent.workspaceRetention"));
			const handle = await persistentSdk.openPersistentAgent(agentId);
			printResult(
				await handle.release({
					deleteWorkspace: cmd.flags.deleteWorkspace,
					deletedBytesGraceMs: retention.deletedBytesGraceMs,
				}),
				cmd.flags.json,
			);
			return;
		}
		case "delete-workspace": {
			const retention = materializeWorkspaceRetentionPolicyV1(settings.get("agents.persistent.workspaceRetention"));
			printResult(
				await persistentSdk.deletePersistentAgentWorkspace(agentId, {
					deletedBytesGraceMs: retention.deletedBytesGraceMs,
				}),
				cmd.flags.json,
			);
			return;
		}
		case "retry-cleanup":
			printResult(await persistentSdk.retryPersistentAgentWorkspaceCleanup(agentId), cmd.flags.json);
			return;
		case "purge-workspace":
			printResult(await persistentSdk.purgePersistentAgentWorkspace(agentId), cmd.flags.json);
			return;
		case "recover": {
			if (!cmd.flags.action) throw new Error("recover requires --action");
			if (cmd.flags.copyFrom && cmd.flags.action !== "retry-create") {
				throw new Error("--copy-from is accepted only with recover --action retry-create");
			}
			printResult(
				await persistentSdk.recoverPersistentAgent(agentId, {
					action: cmd.flags.action,
					...(cmd.flags.copyFrom ? { copySourcePath: cmd.flags.copyFrom } : {}),
				}),
				cmd.flags.json,
			);
			return;
		}
		case "unpack":
			throw new Error("unpack is not a persistent-agent command");
	}
}

export async function runAgentsCommand(cmd: AgentsCommandArgs): Promise<void> {
	if (cmd.action !== "unpack") return runPersistentAgentsCommand(cmd);
	if (cmd.args.length > 0) throw new Error("unpack does not accept positional arguments");
	const result = await unpackBundledAgents(cmd.flags);
	if (cmd.flags.json) {
		printResult(result, true);
		return;
	}
	writeStdout(chalk.bold(`Bundled agents: ${result.total}`));
	writeStdout(chalk.dim(`Target directory: ${result.targetDir}`));
	writeStdout(chalk.green(`${theme.status.success} Written: ${result.written.length}`));
	if (result.skipped.length > 0) {
		writeStdout(
			chalk.yellow(`${theme.status.warning} Skipped existing: ${result.skipped.length} (use --force to overwrite)`),
		);
	}
	for (const filePath of result.written) writeStdout(chalk.dim(`  + ${filePath}`));
	for (const filePath of result.skipped) writeStdout(chalk.dim(`  = ${filePath}`));
}
