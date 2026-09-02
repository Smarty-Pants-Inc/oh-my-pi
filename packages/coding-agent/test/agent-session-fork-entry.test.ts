import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import type { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession exact-entry fork", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let manager: SessionManager;

	beforeEach(() => {
		tempDir = TempDir.createSync("omp-fork-entry-");
		authStorage = createInMemoryAuthStorage();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model");
		manager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: manager,
			settings: Settings.isolated({ "advisor.enabled": false, "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			advisorTools: [],
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		await tempDir.remove().catch(() => {});
	});

	it("materializes only the requested branch, copies artifacts, and defers publication", async () => {
		manager.appendMessage({ role: "user", content: "keep", timestamp: 1 });
		const entryId = manager.getLeafId();
		if (!entryId) throw new Error("Expected exact fork entry");
		manager.appendMessage({ role: "user", content: "drop", timestamp: 2 });
		session.agent.replaceMessages(manager.buildSessionContext().messages);
		await manager.flush();
		const sourceSessionFile = manager.getSessionFile();
		if (!sourceSessionFile) throw new Error("Expected persisted source session");
		const sourceArtifacts = manager.getArtifactManager();
		if (!sourceArtifacts) throw new Error("Expected source artifact manager");
		const artifactId = await sourceArtifacts.save("artifact payload", "test");

		let sessionChanges = 0;
		const unregister = session.registerSessionChangeCallback(() => sessionChanges++);
		let publish: (() => void) | undefined;
		try {
			expect(
				await session.fork(
					next => {
						publish = next;
					},
					{ entryId },
				),
			).toBe(true);
			expect(sessionChanges).toBe(0);
			expect(publish).toBeDefined();
			expect(manager.getSessionFile()).not.toBe(sourceSessionFile);
			expect(manager.getBranch().map(entry => entry.id)).toContain(entryId);
			expect(
				manager
					.getEntries()
					.some(
						entry => entry.type === "message" && "content" in entry.message && entry.message.content === "drop",
					),
			).toBe(false);
			expect(session.messages).toEqual([{ role: "user", content: "keep", timestamp: 1 }]);
			expect(manager.snapshotForReplication().header.parentSession).toBe(sourceSessionFile);

			const forkArtifacts = manager.getArtifactManager();
			if (!forkArtifacts) throw new Error("Expected fork artifact manager");
			const artifactPath = await forkArtifacts.getPath(artifactId);
			if (!artifactPath) throw new Error("Expected copied artifact");
			expect(await fs.readFile(artifactPath, "utf8")).toBe("artifact payload");

			publish?.();
			expect(sessionChanges).toBe(1);
		} finally {
			unregister();
		}
	});
});
