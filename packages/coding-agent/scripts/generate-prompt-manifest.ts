import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import { canonicalJson, sha256 } from "../src/context/canonical";
import { computeImplementationSources } from "../src/context/implementation-sources";
import type { ContextRole, ContextTarget, ContextVisibility, PromptRegistryEntry } from "../src/context/registry";

const packageRoot = path.resolve(import.meta.dir, "..");
const sourceRoot = path.join(packageRoot, "src");
const registryPath = path.join(sourceRoot, "prompt-registry.yml");
const behaviorPath = path.join(sourceRoot, "agent-behavior.yml");
const generatedSourcesPath = path.join(sourceRoot, "context/prompt-sources.generated.ts");
const manifestPath = path.join(packageRoot, "generated/prompt-manifest.json");
const toolContractsPath = path.join(packageRoot, "generated/tool-contracts.json");
const repositoryRoot = path.resolve(packageRoot, "../..");

async function writeOrCheck(filePath: string, content: string, check: boolean): Promise<void> {
	if (!check) {
		await Bun.write(filePath, content);
		return;
	}
	const file = Bun.file(filePath);
	if (!(await file.exists()) || (await file.text()) !== content) {
		throw new Error(`generated artifact is stale: ${path.relative(packageRoot, filePath)}`);
	}
}

const NON_MODEL_DOCUMENTATION = new Set(["modes/components/snapcompact-shape-preview-doc.md"]);
const TRIGGERS = [
	"startup",
	"tool_available",
	"optional_mode",
	"side_request",
	"active_goal",
	"active_goal_idle",
	"goal_updated",
	"goal_budget_limited",
	"todos_present",
	"recovery",
	"compaction",
	"steering",
	"subagent_start",
	"subagent_result",
	"async_result",
	"extension_event",
	"user_selected_skill",
	"provider_request",
	"checkpoint_active",
] as const;

const SPECIAL_IDS: Readonly<Record<string, string>> = {
	"prompts/system/system-prompt.md": "system.base",
	"prompts/system/project-prompt.md": "system.project_context",
	"prompts/system/custom-system-prompt.md": "system.custom",
	"prompts/system/subagent-system-prompt.md": "subagent.base",
	"prompts/providers/internal-context.md": "provider.internal_context",
	"prompts/goals/goal-mode-active.md": "goal.active",
	"prompts/goals/goal-continuation.md": "goal.continuation",
	"prompts/goals/goal-budget-limit.md": "goal.budget_limited",
	"prompts/goals/goal-objective-updated.md": "goal.objective_updated",
	"prompts/todos/current.md": "todo.snapshot",
	"prompts/skills/smarty-mergify-policy.md": "skill.smarty_mergify_policy",
	"prompts/advisor/mission-context.md": "goal.advisor_mission",
	"prompts/system/checkpoint-active-notice.md": "system.checkpoint-active-notice",
	"prompts/system/date-cwd-reminder.md": "system.date-cwd-reminder",
};

const SPECIAL_ORDERS: Readonly<Record<string, number>> = {
	"provider.internal_context": 90,
	"system.base": 100,
	"subagent.base": 100,
	"goal.active": 490,
	"goal.continuation": 500,
	"todo.snapshot": 510,
	"goal.advisor_mission": 995,
	"system.checkpoint-active-notice": 1310,
	"system.date-cwd-reminder": 1350,
	"skill.smarty_mergify_policy": 520,
};

function promptId(sourcePath: string): string {
	if (sourcePath.startsWith("_agent/")) return sourcePath.slice(1).replace(/\.md$/, "").replaceAll("/", ".");
	const special = SPECIAL_IDS[sourcePath];
	if (special) return special;
	const withoutExtension = sourcePath.replace(/\.md$/, "");
	const segments = withoutExtension.split("/").filter(segment => segment !== "prompts" && segment !== "system");
	if (segments[0] === "tools") segments[0] = "tool";
	return segments.join(".").replaceAll("_", "-");
}

function targetFor(sourcePath: string): ContextTarget[] {
	if (sourcePath === "prompts/system/checkpoint-active-notice.md") return ["main", "subagent"];
	if (sourcePath === "prompts/system/date-cwd-reminder.md") return ["main", "subagent", "side_model"];
	if (
		sourcePath === "_agent/compaction/prompts/branch-summary-context.md" ||
		sourcePath === "_agent/compaction/prompts/compaction-summary-context.md"
	) {
		return ["main", "subagent"];
	}
	if (sourcePath.startsWith("_agent/compaction/")) return ["side_model"];
	if (sourcePath === "prompts/skills/smarty-mergify-policy.md") return ["main", "subagent"];
	if (sourcePath === "prompts/providers/internal-context.md") return ["main", "subagent", "side_model"];
	if (sourcePath.includes("subagent") || sourcePath.startsWith("prompts/agents/") || sourcePath.startsWith("task/")) {
		return ["subagent"];
	}
	if (
		/^(advisor|auto-thinking|cleanse|commit|compress|live|memories|tiny|tts)\//.test(sourcePath) ||
		sourcePath.startsWith("prompts/advisor/") ||
		sourcePath.startsWith("prompts/bench") ||
		sourcePath.startsWith("prompts/memories/") ||
		(sourcePath.includes("-system.md") && sourcePath.startsWith("prompts/tools/"))
	) {
		return ["side_model"];
	}
	if (sourcePath.startsWith("prompts/tools/")) return ["main", "subagent"];
	return ["main"];
}

function roleFor(sourcePath: string): ContextRole {
	if (
		sourcePath === "prompts/advisor/mission-context.md" ||
		sourcePath === "prompts/system/checkpoint-active-notice.md" ||
		sourcePath === "prompts/system/date-cwd-reminder.md" ||
		sourcePath === "prompts/system/subagent-system-prompt.md" ||
		sourcePath === "prompts/system/subagent-user-prompt.md"
	) {
		return "internal_context";
	}
	if (sourcePath.startsWith("_agent/compaction/")) {
		return sourcePath.endsWith("summarization-system.md") ? "system" : "internal_context";
	}
	if (
		sourcePath === "prompts/providers/internal-context.md" ||
		sourcePath === "prompts/skills/smarty-mergify-policy.md" ||
		sourcePath.includes("goal-") ||
		sourcePath.includes("/goals/") ||
		sourcePath.includes("/todos/") ||
		sourcePath.includes("steering") ||
		sourcePath.endsWith("-user.md") ||
		sourcePath.endsWith("-request.md") ||
		sourcePath.endsWith("/request.md") ||
		sourcePath.endsWith("/input.md")
	) {
		return "internal_context";
	}
	return "system";
}

function triggerFor(sourcePath: string): (typeof TRIGGERS)[number] {
	if (sourcePath === "prompts/advisor/mission-context.md") return "goal_updated";
	if (sourcePath === "prompts/system/checkpoint-active-notice.md") return "checkpoint_active";
	if (sourcePath === "prompts/system/date-cwd-reminder.md") return "provider_request";
	if (sourcePath.startsWith("_agent/compaction/")) return "compaction";
	if (sourcePath === "prompts/skills/smarty-mergify-policy.md") return "user_selected_skill";
	if (sourcePath.includes("goal-continuation")) return "active_goal_idle";
	if (sourcePath.includes("goal-objective-updated")) return "goal_updated";
	if (sourcePath.includes("goal-budget")) return "goal_budget_limited";
	if (sourcePath.includes("goal-") || sourcePath.includes("/goals/")) return "active_goal";
	if (sourcePath.includes("/todos/")) return "todos_present";
	if (sourcePath.startsWith("prompts/tools/")) return "tool_available";
	if (
		sourcePath === "prompts/system/subagent-system-prompt.md" ||
		sourcePath === "prompts/system/subagent-user-prompt.md" ||
		sourcePath.startsWith("prompts/agents/")
	) {
		return "subagent_start";
	}
	if (sourcePath.includes("task-summary") || sourcePath.includes("subagent-async")) return "subagent_result";
	if (sourcePath.includes("async-result")) return "async_result";
	if (sourcePath.includes("compact") || sourcePath.startsWith("compress/")) return "compaction";
	if (sourcePath.includes("steering") || sourcePath.includes("irc-")) return "steering";
	if (sourcePath.includes("retry") || sourcePath.includes("redirect") || sourcePath.includes("reminder")) {
		return "recovery";
	}
	if (targetFor(sourcePath).includes("side_model")) return "side_request";
	if (sourcePath === "prompts/system/system-prompt.md" || sourcePath === "prompts/system/project-prompt.md") {
		return "startup";
	}
	return "optional_mode";
}

function visibilityFor(sourcePath: string): ContextVisibility {
	if (sourcePath.startsWith("_agent/compaction/")) return "conditional";
	return sourcePath.includes("optional") ? "conditional" : "model";
}

function defaultEnabledFor(sourcePath: string): boolean {
	return (
		sourcePath === "prompts/system/system-prompt.md" ||
		sourcePath === "prompts/system/project-prompt.md" ||
		sourcePath.startsWith("prompts/tools/")
	);
}

async function markdownPaths(): Promise<string[]> {
	const paths: string[] = [];
	for await (const absolutePath of new Bun.Glob("**/*.md").scan({
		cwd: sourceRoot,
		absolute: true,
		onlyFiles: true,
	})) {
		paths.push(path.relative(sourceRoot, absolutePath).replaceAll(path.sep, "/"));
	}
	for await (const absolutePath of new Bun.Glob("compaction/prompts/**/*.md").scan({
		cwd: path.join(repositoryRoot, "packages/agent/src"),
		absolute: true,
		onlyFiles: true,
	})) {
		paths.push(
			`_agent/${path.relative(path.join(repositoryRoot, "packages/agent/src"), absolutePath).replaceAll(path.sep, "/")}`,
		);
	}
	return paths.sort((left, right) => left.localeCompare(right));
}

function repositoryPathForPrompt(sourcePath: string): string {
	return sourcePath.startsWith("_agent/")
		? `packages/agent/src/${sourcePath.slice("_agent/".length)}`
		: `packages/coding-agent/src/${sourcePath}`;
}

function absolutePromptPath(sourcePath: string): string {
	return path.join(repositoryRoot, repositoryPathForPrompt(sourcePath));
}

function registryEntries(paths: readonly string[]): PromptRegistryEntry[] {
	const registered = paths.filter(sourcePath => !NON_MODEL_DOCUMENTATION.has(sourcePath));
	const entries = registered.map((sourcePath, index) => ({
		id: promptId(sourcePath),
		path: sourcePath,
		role: roleFor(sourcePath),
		target: targetFor(sourcePath),
		trigger: triggerFor(sourcePath),
		visibility: visibilityFor(sourcePath),
		defaultEnabled: defaultEnabledFor(sourcePath),
		order: SPECIAL_ORDERS[promptId(sourcePath)] ?? 100 + index * 10,
	}));
	const ids = new Set<string>();
	for (const entry of entries) {
		if (ids.has(entry.id)) throw new Error(`generated duplicate prompt id: ${entry.id}`);
		ids.add(entry.id);
	}
	return entries;
}

function formatRegistry(entries: readonly PromptRegistryEntry[], documentation: readonly string[]): string {
	const lines = ["version: 1", "", "triggers:", ...TRIGGERS.map(trigger => `  - ${trigger}`), "", "prompts:"];
	for (const entry of entries) {
		lines.push(
			`  - id: ${entry.id}`,
			`    path: ${entry.path}`,
			`    role: ${entry.role}`,
			`    target: [${entry.target.join(", ")}]`,
			`    trigger: ${entry.trigger}`,
			`    visibility: ${entry.visibility}`,
			`    defaultEnabled: ${entry.defaultEnabled}`,
			`    order: ${entry.order}`,
		);
	}
	lines.push("", "nonModelDocumentation:", ...documentation.map(item => `  - ${item}`), "");
	return lines.join("\n");
}

function formatSourceModule(entries: readonly PromptRegistryEntry[]): string {
	const imports = entries.map((entry, index) =>
		entry.path.startsWith("_agent/")
			? `import source${index} from "../../../agent/src/${entry.path.slice("_agent/".length)}" with { type: "text" };`
			: `import source${index} from "../${entry.path}" with { type: "text" };`,
	);
	const mappings = entries.map((entry, index) => `\t${JSON.stringify(entry.path)}: source${index},`);
	return [
		"// Generated by scripts/generate-prompt-manifest.ts. Do not edit.",
		"// biome-ignore-all assist/source/organizeImports: import identifiers are paired with generated mappings.",
		...imports,
		"",
		"export const PROMPT_SOURCES: Readonly<Record<string, string>> = Object.freeze({",
		...mappings,
		"});",
		"",
	].join("\n");
}

async function main(): Promise<void> {
	const paths = await markdownPaths();
	const entries = registryEntries(paths);
	const initialize = process.argv.includes("--initialize-registry");
	const check = process.argv.includes("--check");
	if (initialize && check) throw new Error("--initialize-registry and --check are mutually exclusive");
	if (initialize) {
		await Bun.write(
			registryPath,
			formatRegistry(
				entries,
				paths.filter(sourcePath => NON_MODEL_DOCUMENTATION.has(sourcePath)),
			),
		);
	}

	const registryText = await Bun.file(registryPath).text();
	const parsed = YAML.parse(registryText) as { prompts?: PromptRegistryEntry[]; nonModelDocumentation?: string[] };
	const registeredEntries = parsed.prompts ?? [];
	const registeredPaths = new Set(registeredEntries.map(entry => entry.path));
	const classified = new Set(parsed.nonModelDocumentation ?? []);
	for (const sourcePath of paths) {
		if (!registeredPaths.has(sourcePath) && !classified.has(sourcePath)) {
			throw new Error(`unregistered Markdown prompt: ${sourcePath}`);
		}
	}
	for (const sourcePath of [...registeredPaths, ...classified]) {
		if (!paths.includes(sourcePath)) throw new Error(`registered Markdown path is missing: ${sourcePath}`);
	}
	await writeOrCheck(generatedSourcesPath, formatSourceModule(registeredEntries), check);
	// Live generation captures exact contracts once. Check/offline paths verify
	// the canonical sidecar without importing native-backed tool modules.
	const { buildGeneratedToolContractManifest, buildToolContractSnapshot } = await import(
		"../src/context/tool-contracts"
	);
	let toolSchemas: Array<{ id: string; descriptionSha256: string; schemaSha256: string }>;
	if (!check) {
		const snapshot = await buildToolContractSnapshot();
		await writeOrCheck(toolContractsPath, `${JSON.stringify(snapshot, null, 2)}\n`, false);
		toolSchemas = snapshot.tools.map(tool => ({
			id: tool.id,
			descriptionSha256: sha256(tool.description),
			schemaSha256: sha256(canonicalJson(tool.schema as never)),
		}));
	} else {
		toolSchemas = buildGeneratedToolContractManifest();
	}

	const prompts = await Promise.all(
		registeredEntries.map(async entry => ({
			...entry,
			path: repositoryPathForPrompt(entry.path),
			sha256: sha256(await Bun.file(absolutePromptPath(entry.path)).text()),
		})),
	);
	prompts.sort((a, b) => a.id.localeCompare(b.id));
	const behaviorSource = await Bun.file(behaviorPath).text();
	const payload = {
		schema: "omp.prompt_manifest.v1",
		prompts,
		toolSchemas,
		providerMappings: [
			{
				id: "internal_context.developer",
				semanticRole: "internal_context",
				actualRole: "developer",
				when: "provider_supports_developer_role",
				wrapperPromptId: "provider.internal_context",
			},
			{
				id: "internal_context.system_fallback",
				semanticRole: "internal_context",
				actualRole: "system",
				when: "provider_lacks_developer_role",
				wrapperPromptId: "provider.internal_context",
			},
		],
		implementationSources: await computeImplementationSources(repositoryRoot),
		behaviorSha256: sha256(behaviorSource),
	};
	const manifest = { ...payload, rootSha256: sha256(canonicalJson(payload as never)) };
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await writeOrCheck(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, check);
}

await main();
