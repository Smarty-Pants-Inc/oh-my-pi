import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { runCommitCommand } from "@oh-my-pi/pi-coding-agent/commit";
import * as modelSelection from "@oh-my-pi/pi-coding-agent/commit/model-selection";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import * as systemPrompt from "@oh-my-pi/pi-coding-agent/system-prompt";
import { setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let authStorage: AuthStorage | undefined;
let project: TempDir | undefined;
let settingsState: SettingsTestState | undefined;

function assistantText(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	} as never;
}

function mockCompletions() {
	return vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
		const toolName = context.tools?.[0]?.name;
		if (toolName === "create_changelog_entries") return assistantText('{"entries":{}}');
		const systemPrompt = context.systemPrompt?.join("\n") ?? "";
		if (systemPrompt.includes("extracting grounded observations")) {
			return assistantText("# a.ts\n- retained cache setting");
		}
		if (systemPrompt.includes("commit message specialist")) {
			return assistantText("<summary>retained cache setting</summary>");
		}
		return assistantText("# fix: update\n\n- Retained cache setting.");
	});
}

async function setupLegacyCommit({
	cacheRetention,
	mapReduceThreshold = 5_000,
}: {
	cacheRetention: "long" | "none";
	mapReduceThreshold?: number;
}) {
	project = await TempDir.create("@commit-cache-retention-");
	setProjectDir(project.path());
	await Bun.write(project.join("CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Fixed\n");
	await $`git init --initial-branch=main`.cwd(project.path()).quiet();
	await $`git add CHANGELOG.md`.cwd(project.path()).quiet();
	await $`git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m baseline`
		.cwd(project.path())
		.quiet();
	await Bun.write(
		project.join("a.ts"),
		`${Array.from({ length: 201 }, (_, index) => `export const retained${index} = true;`).join("\n")}\n`,
	);

	authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await authStorage.reload();
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	vi.spyOn(Settings, "init").mockResolvedValue(
		Settings.isolated({
			"providers.cacheRetention": cacheRetention,
			"commit.mapReduceThreshold": mapReduceThreshold,
			"commit.cacheEnabled": false,
		}),
	);
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
	vi.spyOn(sdkModule, "loadCliExtensionProviders").mockResolvedValue(undefined);
	vi.spyOn(systemPrompt, "loadProjectContextFiles").mockResolvedValue([]);
	vi.spyOn(modelSelection, "resolvePrimaryModel").mockResolvedValue({ model, apiKey: "test-key" });
	vi.spyOn(modelSelection, "resolveSmolModel").mockResolvedValue({ model, apiKey: "test-key" });
	vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

beforeEach(() => {
	settingsState = beginSettingsTest();
});

afterEach(async () => {
	authStorage?.close();
	authStorage = undefined;
	await project?.remove();
	project = undefined;
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("legacy commit cache retention", () => {
	it("passes an explicit setting through direct analysis and summary completions", async () => {
		await setupLegacyCommit({ cacheRetention: "none" });
		const completionSpy = mockCompletions();

		const result = await runCommitCommand({ legacy: true, push: false, dryRun: true, noChangelog: false });

		expect(result).toEqual({ usedFallback: false });

		expect(completionSpy).toHaveBeenCalledTimes(2);
		for (const [, , options] of completionSpy.mock.calls) {
			expect(options?.cacheRetention).toBe("none");
		}
	});

	it("passes an explicit setting through map and reduce completions", async () => {
		await setupLegacyCommit({ cacheRetention: "long", mapReduceThreshold: 1 });
		const completionSpy = mockCompletions();

		const result = await runCommitCommand({ legacy: true, push: false, dryRun: true, noChangelog: true });

		expect(result).toEqual({ usedFallback: false });

		expect(completionSpy).toHaveBeenCalledTimes(3);
		for (const [, , options] of completionSpy.mock.calls) {
			expect(options?.cacheRetention).toBe("long");
		}
	});
});
