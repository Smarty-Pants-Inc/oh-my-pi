import { afterEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { loadSessionMessagesReadOnly, parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

interface Harness {
	tempDir: TempDir;
	session: AgentSession;
	sessionManager: SessionManager;
	extensionRunner: ExtensionRunner;
}

interface SeededTree {
	rootUserId: string;
	olderLeafId: string;
	lastBranchLeafId: string;
}

const sessions: AgentSession[] = [];
const authStores: AuthStorage[] = [];
const tempDirs: TempDir[] = [];
const openedManagers: SessionManager[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	while (sessions.length > 0) await sessions.pop()?.dispose();
	while (openedManagers.length > 0) await openedManagers.pop()?.close();
	while (authStores.length > 0) authStores.pop()?.close();
	while (tempDirs.length > 0)
		await tempDirs
			.pop()
			?.remove()
			.catch(() => {});
});

async function createHarness(): Promise<Harness> {
	const tempDir = TempDir.createSync("@pi-tree-leaf-persistence-");
	tempDirs.push(tempDir);
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStores.push(authStorage);
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Anthropic model");
	const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
	});
	const extensionRunner = new ExtensionRunner(
		[],
		new ExtensionRuntime(),
		tempDir.path(),
		sessionManager,
		modelRegistry,
	);
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		extensionRunner,
	});
	session.subscribe(() => {});
	sessions.push(session);
	return { tempDir, session, sessionManager, extensionRunner };
}

async function seedTwoBranches(harness: Harness): Promise<SeededTree> {
	const { session, sessionManager } = harness;
	const rootUserId = sessionManager.appendMessage(userMsg("root prompt"));
	const commonAssistantId = sessionManager.appendMessage(assistantMsg("common reply"));
	sessionManager.appendMessage(userMsg("older branch prompt"));
	const olderLeafId = sessionManager.appendMessage(assistantMsg("older branch reply"));
	sessionManager.branch(commonAssistantId);
	sessionManager.appendMessage(userMsg("last branch prompt"));
	const lastBranchLeafId = sessionManager.appendMessage(assistantMsg("last branch reply"));
	session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	await sessionManager.ensureOnDisk();
	await sessionManager.flush();
	return { rootUserId, olderLeafId, lastBranchLeafId };
}

for (const scenario of [
	{ name: "an older branch", target: (tree: SeededTree) => tree.olderLeafId },
	{ name: "root", target: (tree: SeededTree) => tree.rootUserId },
]) {
	it(`reopens the exact published leaf after navigating from the last branch to ${scenario.name}`, async () => {
		const harness = await createHarness();
		const { session, sessionManager, extensionRunner, tempDir } = harness;
		const tree = await seedTwoBranches(harness);
		expect(sessionManager.getLeafId()).toBe(tree.lastBranchLeafId);
		const targetId = scenario.target(tree);
		const expectedLeafId = targetId === tree.rootUserId ? null : targetId;
		let published:
			| { leafId: string | null; branchIds: string[]; context: SessionContext; messages: AgentMessage[] }
			| undefined;
		vi.spyOn(extensionRunner, "hasHandlers").mockImplementation(type => type === "session_tree");
		const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
		vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
			async (event, finalizeBeforeHostCompletion) => {
				if (event.type === "session_tree") {
					published = {
						leafId: event.newLeafId,
						branchIds: sessionManager.getBranch().map(entry => entry.id),
						context: structuredClone(sessionManager.buildSessionContext()),
						messages: structuredClone(session.messages),
					};
				}
				return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
			},
		);

		await expect(session.navigateTree(targetId, { summarize: false })).resolves.toMatchObject({ cancelled: false });
		if (!published) throw new Error("Expected tree publication snapshot");
		expect(published.leafId).toBe(expectedLeafId);
		expect(sessionManager.getLeafId()).toBe(expectedLeafId);
		expect(sessionManager.getEntries()).toHaveLength(6);

		const sessionFile = session.sessionFile;
		if (!sessionFile) throw new Error("Expected persisted session file");
		const records = parseSessionEntries(await Bun.file(sessionFile).text());
		expect(records.filter(entry => entry.type === "message")).toHaveLength(6);
		expect(records.at(-1)).toEqual({ type: "session_leaf", leafId: expectedLeafId });
		expect(await loadSessionMessagesReadOnly(sessionFile)).toEqual(published.messages);
		const pendingNodes = [...sessionManager.getTree()];
		const treeEntryIds: string[] = [];
		while (pendingNodes.length > 0) {
			const node = pendingNodes.pop()!;
			treeEntryIds.push(node.entry.id);
			pendingNodes.push(...node.children);
		}
		expect(treeEntryIds.sort()).toEqual(
			sessionManager
				.getEntries()
				.map(entry => entry.id)
				.sort(),
		);

		await sessionManager.close();
		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		openedManagers.push(reopened);
		expect(reopened.getLeafId()).toBe(published.leafId);
		expect(reopened.getBranch().map(entry => entry.id)).toEqual(published.branchIds);
		expect(reopened.buildSessionContext()).toEqual(published.context);
		expect(reopened.buildSessionContext().messages).toEqual(published.messages);
		expect(reopened.getEntries()).toHaveLength(6);
	});
}

it("removes a stale leaf record when navigating back to the physical last entry", async () => {
	const harness = await createHarness();
	const { session, sessionManager, tempDir } = harness;
	const tree = await seedTwoBranches(harness);
	const sessionFile = session.sessionFile;
	if (!sessionFile) throw new Error("Expected persisted session file");
	await session.navigateTree(tree.olderLeafId, { summarize: false });
	let records = parseSessionEntries(await Bun.file(sessionFile).text());
	expect(records.at(-1)).toEqual({ type: "session_leaf", leafId: tree.olderLeafId });

	await session.navigateTree(tree.lastBranchLeafId, { summarize: false });
	records = parseSessionEntries(await Bun.file(sessionFile).text());
	expect(records.filter(entry => entry.type === "session_leaf")).toHaveLength(0);
	expect(records.at(-1)).toMatchObject({ type: "message", id: tree.lastBranchLeafId });
	await sessionManager.close();
	const reopened = await SessionManager.open(sessionFile, tempDir.path());
	openedManagers.push(reopened);
	expect(reopened.getLeafId()).toBe(tree.lastBranchLeafId);
	expect(
		reopened
			.getBranch()
			.map(entry => entry.id)
			.at(-1),
	).toBe(tree.lastBranchLeafId);
});

it("falls back to the last appended entry when a legacy JSONL has no leaf record", async () => {
	const tempDir = TempDir.createSync("@pi-tree-leaf-legacy-");
	tempDirs.push(tempDir);
	const sessionFile = path.join(tempDir.path(), "legacy.jsonl");
	const entries = [
		{ type: "session", version: 3, id: "legacy-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempDir.path() },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: userMsg("legacy prompt"),
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: assistantMsg("legacy reply"),
		},
	];
	await Bun.write(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);

	const reopened = await SessionManager.open(sessionFile, tempDir.path());
	openedManagers.push(reopened);
	expect(reopened.getLeafId()).toBe("a1");
	expect(reopened.getBranch().map(entry => entry.id)).toEqual(["u1", "a1"]);
	expect(reopened.buildSessionContext().messages.map(message => message.role)).toEqual(["user", "assistant"]);
});

it("fails closed before target publication and restores exact bytes and leaf when leaf persistence fails", async () => {
	const harness = await createHarness();
	const { session, sessionManager, extensionRunner, tempDir } = harness;
	const tree = await seedTwoBranches(harness);
	const sessionFile = session.sessionFile;
	if (!sessionFile) throw new Error("Expected persisted session file");
	const retainedRaw = await Bun.file(sessionFile).text();
	const retainedLeafId = sessionManager.getLeafId();
	const retainedBranchIds = sessionManager.getBranch().map(entry => entry.id);
	const retainedContext = structuredClone(sessionManager.buildSessionContext());
	const retainedMessages = structuredClone(session.messages);
	const retainedEntries = structuredClone(sessionManager.getEntries());

	vi.spyOn(extensionRunner, "hasHandlers").mockImplementation(type => type === "session_tree");
	let targetPublished = false;
	let rollbackPublished: { leafId: string | null; raw: string } | undefined;
	const emitWithHostCompletion = extensionRunner.emitWithHostCompletion.bind(extensionRunner);
	vi.spyOn(extensionRunner, "emitWithHostCompletion").mockImplementation(
		async (event, finalizeBeforeHostCompletion) => {
			if (event.type === "session_tree") targetPublished = true;
			if (event.type === "session_rollback") {
				rollbackPublished = {
					leafId: sessionManager.getLeafId(),
					raw: await Bun.file(sessionFile).text(),
				};
			}
			return emitWithHostCompletion(event, finalizeBeforeHostCompletion);
		},
	);
	const persistenceFailure = new Error("synthetic active leaf persistence failure");
	const persistActiveLeaf = sessionManager.persistActiveLeaf.bind(sessionManager);
	vi.spyOn(sessionManager, "persistActiveLeaf").mockImplementation(async () => {
		await persistActiveLeaf();
		throw persistenceFailure;
	});

	await expect(session.navigateTree(tree.rootUserId, { summarize: false })).rejects.toBe(persistenceFailure);
	expect(targetPublished).toBe(false);
	expect(await Bun.file(sessionFile).text()).toBe(retainedRaw);
	expect(rollbackPublished).toEqual({ leafId: retainedLeafId, raw: retainedRaw });
	expect(sessionManager.getLeafId()).toBe(retainedLeafId);
	expect(sessionManager.getBranch().map(entry => entry.id)).toEqual(retainedBranchIds);
	expect(sessionManager.buildSessionContext()).toEqual(retainedContext);
	expect(session.messages).toEqual(retainedMessages);
	expect(sessionManager.getEntries()).toEqual(retainedEntries);

	await sessionManager.close();
	const reopened = await SessionManager.open(sessionFile, tempDir.path());
	openedManagers.push(reopened);
	expect(reopened.getLeafId()).toBe(retainedLeafId);
	expect(reopened.getBranch().map(entry => entry.id)).toEqual(retainedBranchIds);
	expect(reopened.buildSessionContext()).toEqual(retainedContext);
});
