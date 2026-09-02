import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type SessionHeader,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { getAgentDir, getTerminalSessionsDir, removeWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

interface JsonlMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user";
		content: string;
		timestamp: number;
	};
}

async function createSessionWithArtifacts(root: string): Promise<{
	cwd: string;
	sessionDir: string;
	sourceFile: string;
	sourceArtifactsDir: string;
}> {
	const cwd = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	const sourceFile = path.join(sessionDir, "source.jsonl");
	const sourceArtifactsDir = sourceFile.slice(0, -".jsonl".length);
	const sourceHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "source-with-artifacts",
		timestamp: new Date().toISOString(),
		cwd,
	};
	await fs.mkdir(path.join(sourceArtifactsDir, "nested"), { recursive: true });
	await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
	await Bun.write(path.join(sourceArtifactsDir, "1.read.log"), "tool output");
	await Bun.write(path.join(sourceArtifactsDir, "nested", "result.txt"), "nested output");
	return { cwd, sessionDir, sourceFile, sourceArtifactsDir };
}

class FailingForkStorage extends FileSessionStorage {
	readonly failure = new Error("target journal publish failed");
	failNextAtomicWrite = false;
	failedPath: string | undefined;
	targetArtifactWasPublished = false;

	override async writeTextAtomic(filePath: string, content: string, options?: WriteTextAtomicOptions): Promise<void> {
		if (this.failNextAtomicWrite) {
			this.failNextAtomicWrite = false;
			this.failedPath = filePath;
			this.targetArtifactWasPublished = await Bun.file(
				path.join(filePath.slice(0, -".jsonl".length), "0.bash.log"),
			).exists();
			throw this.failure;
		}
		await super.writeTextAtomic(filePath, content, options);
	}
}

describe("SessionManager forks", () => {
	it("suppresses terminal breadcrumbs while preserving source history under a new parented session", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-");
		const previousAgentDir = getAgentDir();
		const previousTermSessionId = process.env.TERM_SESSION_ID;
		setAgentDir(path.join(tempDir.path(), "agent"));
		process.env.TERM_SESSION_ID = "omp-fork-test";
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const timestamp = new Date().toISOString();
			const sourceHeader: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "source-session",
				timestamp,
				cwd,
			};
			const sourceMessage: JsonlMessageEntry = {
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "hello", timestamp: Date.now() },
			};
			const sourceText = `${JSON.stringify(sourceHeader)}\n${JSON.stringify(sourceMessage)}\n`;
			await Bun.write(sourceFile, sourceText);
			const sourceArtifactsDir = sourceFile.slice(0, -".jsonl".length);
			await fs.mkdir(path.join(sourceArtifactsDir, "local", "nested"), { recursive: true });
			await fs.writeFile(path.join(sourceArtifactsDir, "0.bash.log"), "tool output");
			await fs.writeFile(path.join(sourceArtifactsDir, "local", "nested", "state.json"), "durable state");

			const terminalId = getTerminalId();
			expect(terminalId).toBeString();
			const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId ?? "missing");
			await removeWithRetries(breadcrumbFile);

			const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
				suppressBreadcrumb: true,
			});
			const cloneFile = forked.getSessionFile();
			expect(cloneFile).toBeString();
			if (!cloneFile) throw new Error("expected forked session file");

			expect(await Bun.file(sourceFile).text()).toBe(sourceText);
			expect(await Bun.file(breadcrumbFile).exists()).toBe(false);
			expect(cloneFile).not.toBe(sourceFile);

			const cloneEntries = await loadEntriesFromFile(cloneFile);
			const cloneHeader = cloneEntries.find((entry): entry is SessionHeader => entry.type === "session");
			const cloneMessage = cloneEntries.find((entry): entry is SessionMessageEntry => entry.type === "message");
			expect(cloneHeader?.id).not.toBe(sourceHeader.id);
			expect(cloneHeader?.parentSession).toBe(sourceHeader.id);
			expect(cloneHeader?.cwd).toBe(cwd);
			if (cloneMessage?.message.role !== "user") throw new Error("expected forked user message");
			const cloneArtifactsDir = cloneFile.slice(0, -".jsonl".length);
			expect(await fs.readFile(path.join(cloneArtifactsDir, "0.bash.log"), "utf8")).toBe("tool output");
			expect(await fs.readFile(path.join(cloneArtifactsDir, "local", "nested", "state.json"), "utf8")).toBe(
				"durable state",
			);
			expect(cloneMessage.message.content).toBe("hello");
		} finally {
			if (previousTermSessionId === undefined) {
				delete process.env.TERM_SESSION_ID;
			} else {
				process.env.TERM_SESSION_ID = previousTermSessionId;
			}
			setAgentDir(previousAgentDir);
		}
	});

	it("copies source artifacts recursively into the fork by default", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-artifacts-");
		const { cwd, sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(tempDir.path());

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "1.read.log")).text()).toBe("tool output");
		expect(await Bun.file(path.join(forkArtifactsDir, "nested", "result.txt")).text()).toBe("nested output");
		expect(await Bun.file(path.join(sourceArtifactsDir, "1.read.log")).text()).toBe("tool output");
	});

	it("does not copy artifacts when the caller opts out", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-no-artifacts-");
		const { cwd, sessionDir, sourceFile } = await createSessionWithArtifacts(tempDir.path());

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "1.read.log")).exists()).toBe(false);
	});

	it("does not treat an extensionless source's parent directory as artifacts", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-extensionless-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const forkDir = path.join(tempDir.path(), "forks");
		const sourceFile = path.join(sessionDir, "source");
		const unrelatedFile = path.join(sessionDir, "unrelated.txt");
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "extensionless-source",
			timestamp: new Date().toISOString(),
			cwd,
		};
		await fs.mkdir(sessionDir, { recursive: true });
		await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
		await Bun.write(unrelatedFile, "must not be copied");

		const forked = await SessionManager.forkFrom(sourceFile, cwd, forkDir, undefined, {
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "unrelated.txt")).exists()).toBe(false);
		expect(await Bun.file(unrelatedFile).text()).toBe("must not be copied");
	});

	it("clones artifacts for a direct in-place fork", async () => {
		using tempDir = TempDir.createSync("@omp-session-direct-fork-");
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(cwd, { recursive: true });
			const manager = SessionManager.create(cwd, sessionDir);
			const artifactId = await manager.saveArtifact("direct fork artifact", "bash");
			await manager.ensureOnDisk();
			const sourceFile = manager.getSessionFile();
			if (!sourceFile || artifactId === undefined) throw new Error("expected persisted source session");

			const result = await manager.fork();
			if (!result) throw new Error("expected persisted fork");
			const currentSessionFile = manager.getSessionFile();
			if (!currentSessionFile) throw new Error("expected active fork session file");
			expect(result.oldSessionFile).toBe(sourceFile);
			expect(result.newSessionFile).toBe(currentSessionFile);
			expect(
				await fs.readFile(path.join(result.oldSessionFile.slice(0, -6), `${artifactId}.bash.log`), "utf8"),
			).toBe("direct fork artifact");
			expect(
				await fs.readFile(path.join(result.newSessionFile.slice(0, -6), `${artifactId}.bash.log`), "utf8"),
			).toBe("direct fork artifact");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("removes a published artifact clone when the target journal never materializes", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-rollback-");
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(cwd, { recursive: true });
			const storage = new FailingForkStorage();
			const manager = SessionManager.create(cwd, sessionDir, storage);
			await manager.saveArtifact("rollback artifact", "bash");
			await manager.ensureOnDisk();
			const sourceFile = manager.getSessionFile();
			if (!sourceFile) throw new Error("expected persisted source session");
			storage.failNextAtomicWrite = true;

			await expect(manager.fork()).rejects.toBe(storage.failure);

			const failedPath = storage.failedPath;
			if (!failedPath) throw new Error("expected attempted target journal path");
			expect(storage.targetArtifactWasPublished).toBe(true);
			expect(manager.getSessionFile()).toBe(sourceFile);
			await expect(fs.stat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(failedPath.slice(0, -".jsonl".length))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await fs.readFile(path.join(sourceFile.slice(0, -6), "0.bash.log"), "utf8")).toBe("rollback artifact");
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("zeroes inherited cost while preserving token counts only when reset is requested", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-cost-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "cost-source",
			timestamp,
			cwd,
		};
		const assistantEntry = {
			type: "message",
			id: "assistant-1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "stop",
				timestamp: Date.now(),
				usage: {
					input: 100,
					output: 50,
					cacheRead: 10,
					cacheWrite: 5,
					totalTokens: 165,
					premiumRequests: 2,
					credits: { cost: 3, committedCost: 3, acuCost: 1 },
					cost: { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 0.5, total: 6 },
				},
			},
		};
		await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n${JSON.stringify(assistantEntry)}\n`);

		const findAssistant = async (file: string) => {
			const entries = await loadEntriesFromFile(file);
			const entry = entries.find((e): e is SessionMessageEntry => e.type === "message");
			if (entry?.message.role !== "assistant") throw new Error("expected assistant message");
			return entry.message;
		};

		const preserved = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "keep"), undefined, {
			suppressBreadcrumb: true,
		});
		const preservedFile = preserved.getSessionFile();
		if (!preservedFile) throw new Error("expected preserved fork file");
		const preservedMessage = await findAssistant(preservedFile);
		expect(preservedMessage.usage.cost.total).toBe(6);
		expect(preservedMessage.usage.premiumRequests).toBe(2);

		const reset = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "reset"), undefined, {
			suppressBreadcrumb: true,
			resetInheritedCost: true,
		});
		const resetFile = reset.getSessionFile();
		if (!resetFile) throw new Error("expected reset fork file");
		const resetMessage = await findAssistant(resetFile);
		expect(resetMessage.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		expect(resetMessage.usage.credits).toBeUndefined();
		expect(resetMessage.usage.premiumRequests).toBeUndefined();
		// Token counts are context, not spend — compaction anchors depend on them.
		expect(resetMessage.usage.input).toBe(100);
		expect(resetMessage.usage.output).toBe(50);
		expect(resetMessage.usage.totalTokens).toBe(165);
	});
});
