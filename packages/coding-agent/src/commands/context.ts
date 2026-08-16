import * as path from "node:path";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { contextHelp as commandHelp } from "../cli/command-help";
import { approvalStatus, loadApprovedPolicy } from "../context/approved-policy";
import { diffContext, diffProtectedRepository } from "../context/diff";
import { explainContext, renderContextExplanation } from "../context/explain";
import { buildContextReleaseManifest } from "../context/manifest";

export default class Context extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Context action",
			required: true,
			options: ["manifest", "explain", "diff", "protected-delta"],
		}),
	};
	static flags = {
		json: Flags.boolean({ description: "Output JSON" }),
		target: Flags.string({ description: "Context target: main, subagent, or side_model" }),
		"include-content": Flags.boolean({ description: "Include full rendered or source content" }),
		base: Flags.string({ description: "Base Git ref" }),
		repository: Flags.string({ description: "Repository path (defaults to the current directory)" }),
		provider: Flags.string({ description: "Provider used to select actual instruction roles" }),
		model: Flags.string({ description: "Model label for the exported context" }),
		"approved-policy": Flags.string({ description: "Approved-policy path for offline candidate verification" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Context);
		if (args.action === "manifest") {
			if (flags["approved-policy"] && !path.isAbsolute(flags["approved-policy"])) {
				throw new Error("--approved-policy must be an absolute path");
			}
			const approvedPolicy = flags["approved-policy"]
				? await loadApprovedPolicy(flags["approved-policy"])
				: undefined;
			if (flags["approved-policy"] && !approvedPolicy) {
				throw new Error(`missing approved policy: ${flags["approved-policy"]}`);
			}
			const manifest = await buildContextReleaseManifest(process.cwd(), approvedPolicy?.candidates, {
				validateToolContracts: false,
			});
			if (flags["approved-policy"]) {
				const status = await approvalStatus(manifest, flags["approved-policy"]);
				if (status.status !== "approved") {
					throw new Error(`PROMPT_POLICY_REVIEW_REQUIRED: ${status.reasons.join("; ")}`);
				}
			}
			process.stdout.write(`${JSON.stringify(manifest, null, flags.json ? 2 : 2)}\n`);
			return;
		}
		if (args.action === "explain") {
			const target = flags.target ?? "main";
			if (target !== "main" && target !== "subagent" && target !== "side_model") {
				throw new Error("--target must be main, subagent, or side_model");
			}
			const explanation = await explainContext({
				target,
				includeContent: flags["include-content"],
				provider: flags.provider,
				model: flags.model,
			});
			process.stdout.write(
				flags.json ? `${JSON.stringify(explanation, null, 2)}\n` : renderContextExplanation(explanation),
			);
			return;
		}
		if (!flags.base || !flags.target) throw new Error(`context ${args.action} requires --base and --target Git refs`);
		if (args.action === "protected-delta") {
			const result = await diffProtectedRepository({
				repository: flags.repository ?? process.cwd(),
				base: flags.base,
				target: flags.target,
			});
			process.stdout.write(`${JSON.stringify(result, null, flags.json ? 2 : 2)}\n`);
			return;
		}
		const result = await diffContext({ base: flags.base, target: flags.target });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	}
}
