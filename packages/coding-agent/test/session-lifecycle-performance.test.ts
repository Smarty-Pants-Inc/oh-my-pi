import { describe, expect, it } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

describe("session lifecycle checkpoint performance contracts", () => {
	it("borrows a journal already owned by a durable preimage instead of cloning transcript content", async () => {
		const manager = SessionManager.create("/workspace", "/sessions", new MemorySessionStorage());
		try {
			manager.appendMessage({ role: "user", content: "retained", timestamp: Date.now() });
			await manager.ensureOnDisk();
			const copied = manager.captureState();
			const borrowed = manager.captureState({ copyJournal: false });
			const currentEntry = manager.getEntries()[0];
			const currentHeader = manager.getHeader();
			if (!currentHeader) throw new Error("Expected an initialized session header");

			expect(copied.journalCopied).toBe(true);
			expect(copied.entries[0]).not.toBe(currentEntry);
			expect(borrowed.journalCopied).toBe(false);
			expect(borrowed.entries[0]).toBe(currentEntry);
			expect(borrowed.header).toBe(currentHeader);
		} finally {
			await manager.close();
		}
	});

	it("reloads exact durable bytes before publishing rollback from a borrowed journal", async () => {
		const manager = SessionManager.create("/workspace", "/sessions", new MemorySessionStorage());
		try {
			manager.appendMessage({ role: "user", content: "retained", timestamp: Date.now() });
			await manager.ensureOnDisk();
			const persisted = await manager.capturePersistedSessionFile();
			expect(persisted?.content).toBeDefined();
			const state = manager.captureState({ copyJournal: false });

			manager.appendMessage({ role: "user", content: "provisional", timestamp: Date.now() });
			manager.restoreState(state);
			await manager.restorePersistedSessionFile(persisted, {
				preserveNewerMutations: false,
				reloadJournal: true,
			});
			manager.restoreState(state, { preserveCurrentJournal: true });

			expect(
				manager
					.getEntries()
					.map(entry =>
						entry.type === "message" && entry.message.role === "user" ? entry.message.content : undefined,
					),
			).toEqual(["retained"]);
		} finally {
			await manager.close();
		}
	});
});
