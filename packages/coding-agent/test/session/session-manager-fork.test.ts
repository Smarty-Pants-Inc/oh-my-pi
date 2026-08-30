import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isSafeResponseAnchorId, responseAnchorIdForEntry } from "@oh-my-pi/pi-coding-agent/session/response-anchor";
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

	it("hydrates distinct stable response anchors for equal-timestamp legacy assistants on load and import", async () => {
		using tempDir = TempDir.createSync("@omp-legacy-response-anchors-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const sourceFile = path.join(sessionDir, "legacy.jsonl");
		const timestamp = new Date().toISOString();
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(sessionDir, { recursive: true });
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "legacy-response-anchor-source",
			timestamp,
			cwd,
		};
		const legacyAssistant = (
			id: string,
			parentId: string | null,
			text: string,
			responseAnchorId?: string,
		): SessionMessageEntry => {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 777,
				responseAnchorTerminal: true,
				...(responseAnchorId === undefined ? {} : { responseAnchorId }),
			};
			return { type: "message", id, parentId, timestamp, message };
		};
		const firstAssistant = legacyAssistant("legacy-anchor-a", null, "first legacy answer", "shared-response-anchor");
		const duplicateAssistant = legacyAssistant(
			"legacy-anchor-b",
			"legacy-anchor-a",
			"second legacy answer",
			"shared-response-anchor",
		);
		const missingAnchorAssistant = legacyAssistant("legacy-anchor-c", "legacy-anchor-b", "third legacy answer");
		const sourceText = `${[
			JSON.stringify(header),
			JSON.stringify(firstAssistant),
			JSON.stringify(duplicateAssistant),
			JSON.stringify(missingAnchorAssistant),
		].join("\n")}\n`;
		await Bun.write(sourceFile, sourceText);

		const anchorsFor = (manager: SessionManager): string[] => {
			const anchors: string[] = [];
			for (const message of manager.buildSessionContext({ transcript: true }).messages) {
				if (message.role !== "assistant") continue;
				if (!message.responseAnchorId) throw new Error("Expected hydrated response anchor id");
				anchors.push(message.responseAnchorId);
			}
			return anchors;
		};

		const loaded = await SessionManager.open(sourceFile);
		const loadedAnchors = anchorsFor(loaded);
		expect(loadedAnchors).toEqual([
			"shared-response-anchor",
			responseAnchorIdForEntry("legacy-anchor-b"),
			responseAnchorIdForEntry("legacy-anchor-c"),
		]);
		expect(new Set(loadedAnchors).size).toBe(3);
		expect(loadedAnchors.every(isSafeResponseAnchorId)).toBe(true);
		expect(await Bun.file(sourceFile).text()).toBe(sourceText);

		const imported = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		expect(anchorsFor(imported)).toEqual(loadedAnchors);
		const importedFile = imported.getSessionFile();
		if (!importedFile) throw new Error("Expected imported session file");
		const persistedAnchors = (await loadEntriesFromFile(importedFile)).flatMap(entry =>
			entry.type === "message" && entry.message.role === "assistant" ? [entry.message.responseAnchorId] : [],
		);
		expect(persistedAnchors).toEqual(loadedAnchors);
		expect(await Bun.file(sourceFile).text()).toBe(sourceText);
		await Promise.all([loaded.close(), imported.close()]);
	});

	it("keeps absent legacy terminality unanchored for synthesized and preexisting response ids", async () => {
		using tempDir = TempDir.createSync("@omp-legacy-response-terminality-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const sourceFile = path.join(sessionDir, "legacy.jsonl");
		const timestamp = new Date().toISOString();
		const preexistingAnchorId = crypto.randomUUID();
		await fs.mkdir(cwd, { recursive: true });
		await fs.mkdir(sessionDir, { recursive: true });
		const message = (text: string, responseAnchorId?: string): AssistantMessage => ({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 777,
			...(responseAnchorId === undefined ? {} : { responseAnchorId }),
		});
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "legacy-response-terminality-source",
			timestamp,
			cwd,
		};
		await Bun.write(
			sourceFile,
			`${[
				JSON.stringify(header),
				JSON.stringify({
					type: "message",
					id: "legacy-synthesized",
					parentId: null,
					timestamp,
					message: message("synthesized intermediate"),
				}),
				JSON.stringify({
					type: "message",
					id: "legacy-preexisting",
					parentId: "legacy-synthesized",
					timestamp,
					message: message("preexisting-id intermediate", preexistingAnchorId),
				}),
				JSON.stringify({
					type: "message",
					id: "legacy-final",
					parentId: "legacy-preexisting",
					timestamp,
					message: { ...message("final", "feature-final-anchor"), responseAnchorTerminal: true },
				}),
			].join("\n")}\n`,
		);

		const expectTerminality = (manager: SessionManager) => {
			const synthesized = manager.getEntry("legacy-synthesized");
			const preexisting = manager.getEntry("legacy-preexisting");
			const final = manager.getEntry("legacy-final");
			if (synthesized?.type !== "message" || synthesized.message.role !== "assistant") {
				throw new Error("Expected synthesized legacy assistant");
			}
			if (preexisting?.type !== "message" || preexisting.message.role !== "assistant") {
				throw new Error("Expected preexisting-id legacy assistant");
			}
			if (final?.type !== "message" || final.message.role !== "assistant") {
				throw new Error("Expected final legacy assistant");
			}
			expect(synthesized.message.responseAnchorId).toBeUndefined();
			expect(synthesized.message.responseAnchorTerminal).toBeUndefined();
			expect(preexisting.message.responseAnchorId).toBe(preexistingAnchorId);
			expect(preexisting.message.responseAnchorTerminal).toBeUndefined();
			expect(final.message.responseAnchorTerminal).toBe(true);
		};

		const firstLoad = await SessionManager.open(sourceFile);
		expectTerminality(firstLoad);
		await firstLoad.rewriteEntries();
		await firstLoad.close();

		const secondLoad = await SessionManager.open(sourceFile);
		expectTerminality(secondLoad);
		await secondLoad.close();
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
});
