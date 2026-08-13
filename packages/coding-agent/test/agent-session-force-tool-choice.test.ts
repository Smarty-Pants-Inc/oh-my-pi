import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
let session: AgentSession;
let sessionManager: SessionManager;
let mock: MockModel;

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-agent-session-force-tool-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({ "compaction.enabled": false });
	sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

	const emptyObjectSchema = type("object");

	const bashTool: AgentTool = {
		name: "bash",
		label: "Bash",
		description: "Mock bash tool",
		parameters: emptyObjectSchema,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
	const writeTool: AgentTool = {
		name: "write",
		label: "Write",
		description: "Mock write tool",
		parameters: emptyObjectSchema,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};

	mock = createMockModel({ handler: () => ({ content: ["done"] }) });

	const agent = new Agent({
		getToolChoice: () => session.nextToolChoiceDirective(),
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [bashTool, writeTool],
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
	});

	session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map([
			[bashTool.name, bashTool],
			[writeTool.name, writeTool],
		]),
	});
});

afterEach(async () => {
	await session.dispose();
	authStorage?.close();
	authStorage = undefined;
	tempDir.removeSync();
});

async function deferForcedWrite(): Promise<void> {
	session.setForcedToolChoice("write");
	session.agent.setBeforeModelCall(() => ({ stop: true, reason: "session transition" }));
	await session.agent.prompt("defer");
	session.agent.setBeforeModelCall(undefined);
	expect(mock.calls).toHaveLength(0);
}

async function createTargetSessionPath(label: string): Promise<string> {
	const id = `${label}-${Bun.nanoseconds()}`;
	const targetPath = path.join(tempDir.path(), `${id}.jsonl`);
	await Bun.write(
		targetPath,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: new Date().toISOString(),
			cwd: tempDir.path(),
		})}\n`,
	);
	return targetPath;
}

function failTargetMaterialization(targetPath: string, failure: Error): void {
	const ensureOnDisk = sessionManager.ensureOnDisk.bind(sessionManager);
	vi.spyOn(sessionManager, "ensureOnDisk").mockImplementation(async () => {
		if (sessionManager.getSessionFile() === targetPath) throw failure;
		await ensureOnDisk();
	});
}

it("forces specific tool, then transitions to none, then clears", () => {
	session.setForcedToolChoice("write");

	const first = session.nextToolChoiceDirective();
	const second = session.nextToolChoiceDirective();
	const third = session.nextToolChoiceDirective();

	expect(first).toEqual({ type: "tool", name: "write" });
	// After the forced call, "none" prevents the loop from making more tool calls
	expect(second).toBe("none");
	// After "none" is consumed, override clears entirely
	expect(third).toBeUndefined();
});

it("drops an unavailable forced choice with the rest of its sequence", async () => {
	session.setForcedToolChoice("write");

	await session.setActiveToolsByName(["bash"]);
	expect(session.nextToolChoiceDirective()).toBeUndefined();
	expect(session.toolChoiceQueue.hasInFlight).toBe(false);
	expect(session.nextToolChoiceDirective()).toBeUndefined();

	await session.setActiveToolsByName(["bash", "write"]);
	expect(session.nextToolChoiceDirective()).toBeUndefined();
});

it("throws when forcing a non-active tool", () => {
	expect(() => session.setForcedToolChoice("read")).toThrow('Tool "read" is not currently active.');
});

it("drops a deferred forced choice when branching", async () => {
	const entryId = sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "branch target" }],
		timestamp: Date.now(),
	});
	await deferForcedWrite();

	await session.branch(entryId);
	await session.agent.prompt("new branch");

	expect(mock.calls).toHaveLength(1);
	expect(mock.calls[0]?.options?.toolChoice).toBeUndefined();
});

it("retains a deferred /force choice when target materialization rolls back", async () => {
	await deferForcedWrite();
	const targetPath = await createTargetSessionPath("force-rollback");
	const failure = new Error("target materialization failed");
	failTargetMaterialization(targetPath, failure);

	await expect(session.switchSession(targetPath)).rejects.toBe(failure);
	await session.agent.prompt("retry current session");

	expect(mock.calls).toHaveLength(1);
	expect(mock.calls[0]?.options?.toolChoice).toEqual({ type: "tool", name: "write" });
});

it("restores pending preview identity and soft-directive progress after materialization rollback", async () => {
	const retainedInvoker = (input: unknown) => input;
	session.toolChoiceQueue.registerPendingInvoker("preview-1", "ast_edit", retainedInvoker);
	session.agent.setBeforeModelCall(() => {
		return { stop: true, reason: "defer preview" };
	});
	await session.agent.prompt("stage preview");
	expect(mock.calls).toHaveLength(0);

	const targetPath = await createTargetSessionPath("preview-rollback");
	const failure = new Error("target materialization failed");
	failTargetMaterialization(targetPath, failure);
	await expect(session.switchSession(targetPath)).rejects.toBe(failure);
	expect(session.peekPendingInvoker()).toBe(retainedInvoker);

	let reminderCount = 0;
	session.agent.setBeforeModelCall(context => {
		reminderCount = context.messages.filter(message =>
			JSON.stringify(message.content).includes("xd://resolve"),
		).length;
		return { stop: true, reason: "inspect restored preview" };
	});
	await session.agent.prompt("retry preview");
	expect(reminderCount).toBe(1);
});

it("commits a clean target without retained /force or preview directives", async () => {
	await deferForcedWrite();
	session.toolChoiceQueue.registerPendingInvoker("preview-1", "ast_edit", input => input);
	const targetPath = await createTargetSessionPath("force-success");

	await expect(session.switchSession(targetPath)).resolves.toBe(true);
	expect(session.peekPendingInvoker()).toBeUndefined();
	await session.agent.prompt("target turn");

	expect(mock.calls).toHaveLength(1);
	expect(mock.calls[0]?.options?.toolChoice).toBeUndefined();
});
