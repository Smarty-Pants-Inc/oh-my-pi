/** Manage bundled definitions and persistent agents. */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import {
	AGENTS_ACTIONS,
	type AgentsAction,
	type AgentsCommandArgs,
	assertNoDuplicatePersistentRuntimePolicyFlags,
	runAgentsCommand,
} from "../cli/agents-cli";
import { agentsHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "../modes/theme/theme";

const RECOVERY_ACTIONS = [
	"retry-create",
	"resume",
	"finish-park",
	"finish-fork",
	"finish-release",
	"discard-creation",
	"discard-runtime-changes",
] as const;

export default class Agents extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({ description: "Agents action", required: false, options: [...AGENTS_ACTIONS] }),
		values: Args.string({ description: "AGENT_ID and optional MESSAGE", required: false, multiple: true }),
	};

	static flags = {
		force: Flags.boolean({ char: "f", description: "Overwrite existing unpacked agent files" }),
		json: Flags.boolean({ description: "Output the exact public result as JSON" }),
		dir: Flags.string({ description: "Unpack output directory (overrides --user/--project)" }),
		user: Flags.boolean({ description: "Unpack into ~/.omp/agent/agents (default)" }),
		project: Flags.boolean({ description: "Unpack into ./.omp/agents" }),
		kind: Flags.string({ description: "Persistent agent kind", options: ["main", "sub"] }),
		parent: Flags.string({ description: "Parent persistent agent id" }),
		"model-profile": Flags.string({ description: "Model connection profile id" }),
		empty: Flags.boolean({ description: "Create an empty managed workspace" }),
		"copy-from": Flags.string({ description: "Trusted source path for create or retry-create recovery" }),
		action: Flags.string({ description: "Recovery action", options: [...RECOVERY_ACTIONS] }),
		"delete-workspace": Flags.boolean({ description: "Delete the workspace while releasing the agent" }),
		placement: Flags.string({ description: "Runtime placement", options: ["local", "cloud", "auto"] }),
		"provider-id": Flags.string({ description: "Runtime provider id or null" }),
		os: Flags.string({ description: "Runtime OS or any", options: ["darwin", "linux", "windows", "any"] }),
		arch: Flags.string({ description: "Runtime architecture or any", options: ["arm64", "x64", "any"] }),
		"min-cpu": Flags.string({ description: "Minimum CPU count" }),
		"min-memory-mib": Flags.string({ description: "Minimum memory in MiB" }),
		network: Flags.string({ description: "Runtime network policy", options: ["none", "egress"] }),
		"max-ready-latency-ms": Flags.string({ description: "Maximum ready latency in milliseconds or null" }),
		"idle-runtime-ttl-ms": Flags.string({ description: "Idle runtime TTL in milliseconds" }),
	};

	static examples = [
		"omp agents unpack --project --force",
		"omp agents create BuildKeeper --kind main --model-profile cliproxyapi-default --empty",
		'omp agents send BuildKeeper "Run the build" --json',
		"omp agents set-runtime-policy BuildKeeper --network egress",
		"omp agents release BuildKeeper --delete-workspace",
	];

	async run(): Promise<void> {
		assertNoDuplicatePersistentRuntimePolicyFlags(this.argv);
		const { args, flags } = await this.parse(Agents);
		if (!args.action) {
			renderCommandHelp("omp", "agents", Agents);
			return;
		}
		const values = Array.isArray(args.values) ? args.values : args.values ? [args.values] : [];
		const cmd: AgentsCommandArgs = {
			action: args.action as AgentsAction,
			args: values,
			flags: {
				force: flags.force,
				json: flags.json,
				dir: flags.dir,
				user: flags.user,
				project: flags.project,
				kind: flags.kind as "main" | "sub" | undefined,
				parent: flags.parent,
				modelProfile: flags["model-profile"],
				empty: flags.empty,
				copyFrom: flags["copy-from"],
				action: flags.action as AgentsCommandArgs["flags"]["action"],
				deleteWorkspace: flags["delete-workspace"],
				placement: flags.placement,
				providerId: flags["provider-id"],
				os: flags.os,
				arch: flags.arch,
				minCpu: flags["min-cpu"],
				minMemoryMib: flags["min-memory-mib"],
				network: flags.network,
				maxReadyLatencyMs: flags["max-ready-latency-ms"],
				idleRuntimeTtlMs: flags["idle-runtime-ttl-ms"],
			},
		};
		await initTheme();
		await runAgentsCommand(cmd);
	}
}
