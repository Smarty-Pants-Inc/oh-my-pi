import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

registerMockApi();

async function createTestSession(tempDir: TempDir, extensions: ExtensionFactory[]) {
	const auth = await AuthStorage.create(tempDir.join("auth.db"));
	auth.setRuntimeApiKey("mock", "test-key");
	const model = createMockModel({ id: "text", handler: () => ({ content: ["ok"] }) });
	const sessionManager = SessionManager.inMemory(tempDir.path());
	try {
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: auth,
			modelRegistry: new ModelRegistry(auth, tempDir.join("models.yml")),
			model,
			settings: Settings.isolated({
				"async.enabled": false,
				"marketplace.autoUpdate": "off",
			}),
			sessionManager,
			disableExtensionDiscovery: true,
			extensions,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});
		return { ...result, auth, model, sessionManager };
	} catch (error) {
		auth.close();
		throw error;
	}
}

describe("extension system prompt builders", () => {
	it("owns the initial and rebuilt provider-facing base prompt", async () => {
		using tempDir = TempDir.createSync("@omp-system-prompt-builder-");
		const laterDir = tempDir.join("later");
		fs.mkdirSync(laterDir);
		let builds = 0;
		const extension: ExtensionFactory = pi => {
			pi.registerSystemPromptBuilder(({ options }) => {
				builds += 1;
				return {
					systemPrompt: [`builder:${options.cwd};roots:${options.additionalWorkspaceRoots?.join(",") ?? ""}`],
				};
			});
		};
		const { session, auth, model, sessionManager } = await createTestSession(tempDir, [extension]);
		try {
			expect(session.systemPrompt).toEqual([`builder:${tempDir.path()};roots:`]);
			await sessionManager.addWorkspaceDirectory(laterDir);
			await session.refreshBaseSystemPrompt();
			expect(session.systemPrompt).toEqual([`builder:${tempDir.path()};roots:${laterDir}`]);
			expect(builds).toBe(2);

			await session.prompt("noop");
			const providerPrompt = model.calls?.at(-1)?.context?.systemPrompt;
			expect(providerPrompt).toEqual(session.systemPrompt);
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	it("can render the stock pipeline with a complete modified template set", async () => {
		using tempDir = TempDir.createSync("@omp-system-prompt-templates-");
		const extension: ExtensionFactory = pi => {
			pi.registerSystemPromptBuilder(context =>
				context.build({
					...context.templates,
					project: `${context.templates.project}\n<builder-marker>{{cwd}}</builder-marker>`,
				}),
			);
		};
		const { session, auth } = await createTestSession(tempDir, [extension]);
		try {
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain("ROLE");
			expect(prompt).toContain(`<builder-marker>${tempDir.path()}</builder-marker>`);
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	it("fails closed when multiple extensions register builders", async () => {
		using tempDir = TempDir.createSync("@omp-system-prompt-conflict-");
		const extension: ExtensionFactory = pi => {
			pi.registerSystemPromptBuilder(() => ({ systemPrompt: ["builder"] }));
		};
		await expect(createTestSession(tempDir, [extension, extension])).rejects.toThrow(
			"Multiple system prompt builders registered",
		);
	});
});
