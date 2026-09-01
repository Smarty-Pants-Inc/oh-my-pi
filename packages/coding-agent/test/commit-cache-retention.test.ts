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
import * as gitModule from "@oh-my-pi/pi-coding-agent/utils/git";
import { setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 0000000..1111111 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -0,0 +1 @@
+export const retained = true;
`;

let authStorage: AuthStorage | undefined;
let project: TempDir | undefined;
let settingsState: SettingsTestState | undefined;

function assistantText(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
	} as never;
}

function mockCompletions() {
	return vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context) => {
		const toolName = context.tools?.[0]?.name;
		if (toolName === "create_changelog_entries") return assistantText('{"entries":{}}');
		if (toolName === "create_conventional_analysis") {
			return assistantText(
				'{"type":"fix","scope":null,"details":[{"text":"retain cache setting"}],"issue_refs":[]}',
			);
		}
		if (toolName === "create_commit_summary") return assistantText("retain cache setting");
		return assistantText("Observed the changed file.");
	});
}

async function setupLegacyCommit({
	cacheRetention,
	mapReduceMinFiles = 4,
}: {
	cacheRetention: "long" | "none";
	mapReduceMinFiles?: number;
}) {
	project = await TempDir.create("@commit-cache-retention-");
	setProjectDir(project.path());
	await Bun.write(project.join("CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n### Fixed\n");

	authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await authStorage.reload();
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	vi.spyOn(Settings, "init").mockResolvedValue(
		Settings.isolated({
			"providers.cacheRetention": cacheRetention,
			"commit.mapReduceMinFiles": mapReduceMinFiles,
		}),
	);
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
	vi.spyOn(sdkModule, "loadCliExtensionProviders").mockResolvedValue(undefined);
	vi.spyOn(systemPrompt, "loadProjectContextFiles").mockResolvedValue([]);
	vi.spyOn(modelSelection, "resolvePrimaryModel").mockResolvedValue({ model, apiKey: "test-key" });
	vi.spyOn(modelSelection, "resolveSmolModel").mockResolvedValue({ model, apiKey: "test-key" });
	const diffSpy = vi
		.spyOn(gitModule, "diff")
		.mockImplementation((async (_cwd, options = {}) =>
			options.stat ? " src/a.ts | 1 +\n" : DIFF) as typeof gitModule.diff);
	Object.assign(diffSpy, {
		changedFiles: vi.fn().mockResolvedValue(["src/a.ts"]),
		numstat: vi.fn().mockResolvedValue([{ path: "src/a.ts", additions: 1, deletions: 0 }]),
	});
	vi.spyOn(gitModule.log, "subjects").mockResolvedValue([]);
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
	it("passes an explicit setting to changelog, analysis, and summary completions", async () => {
		await setupLegacyCommit({ cacheRetention: "none" });
		const completionSpy = mockCompletions();

		const result = await runCommitCommand({ legacy: true, push: false, dryRun: true, noChangelog: false });

		expect(result).toEqual({ usedFallback: false });

		expect(completionSpy).toHaveBeenCalledTimes(3);
		for (const [, , options] of completionSpy.mock.calls) {
			expect(options?.cacheRetention).toBe("none");
		}
	});

	it("passes an explicit setting through map and reduce completions", async () => {
		process.env.PI_COMMIT_MAP_REDUCE = "true";
		Bun.env.PI_COMMIT_MAP_REDUCE = "true";
		await setupLegacyCommit({ cacheRetention: "long", mapReduceMinFiles: 1 });
		const completionSpy = mockCompletions();

		const result = await runCommitCommand({ legacy: true, push: false, dryRun: true, noChangelog: true });

		expect(result).toEqual({ usedFallback: false });

		expect(completionSpy).toHaveBeenCalledTimes(3);
		for (const [, , options] of completionSpy.mock.calls) {
			expect(options?.cacheRetention).toBe("long");
		}
	});
});
