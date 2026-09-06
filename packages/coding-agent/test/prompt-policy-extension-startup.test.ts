import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ContextReleaseManifest } from "@oh-my-pi/pi-coding-agent/context/manifest";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession, testSetApprovedStartupManifest } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROTECTED_EXTENSION_FACTORIES: Array<[string, ExtensionFactory]> = [
	["input", pi => pi.on("input", () => undefined)],
	["context", pi => pi.on("context", () => undefined)],
	["before_provider_request", pi => pi.on("before_provider_request", () => undefined)],
	["before_agent_start", pi => pi.on("before_agent_start", () => undefined)],
];

afterEach(() => testSetApprovedStartupManifest(undefined));

describe("prompt policy extension startup", () => {
	it("rejects each unapproved prompt-affecting extension before session construction completes", async () => {
		using tempDir = TempDir.createSync("@omp-prompt-policy-session-");
		testSetApprovedStartupManifest({ candidates: [] } as unknown as ContextReleaseManifest);
		for (const [event, factory] of PROTECTED_EXTENSION_FACTORIES) {
			const authStorage = await AuthStorage.create(":memory:");
			const sessionManager = SessionManager.inMemory(tempDir.path());
			try {
				await expect(
					createAgentSession({
						cwd: tempDir.path(),
						authStorage,
						modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${event}.yml`)),
						sessionManager,
						settings: Settings.isolated({ "marketplace.autoUpdate": "off" }),
						extensions: [factory],
						disableExtensionDiscovery: true,
						enableMCP: false,
						skills: [],
						rules: [],
						contextFiles: [],
					}),
					event,
				).rejects.toThrow("PROMPT_POLICY_REVIEW_REQUIRED: extension source is not approved: <inline-0>");
			} finally {
				authStorage.close();
				await sessionManager.close();
			}
		}
	});
});
