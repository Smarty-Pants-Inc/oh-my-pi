import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	dispatchRpcSkillPrompt,
	RpcExtensionUserMessageTracker,
	tryRunRpcSkillCommand,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type CustomMessage, SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("tryRunRpcSkillCommand", () => {
	test("dispatches registered /skill commands as skill prompt messages", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		let message: Pick<CustomMessage, "attribution" | "content" | "customType" | "details" | "display"> | undefined;
		let options: { streamingBehavior?: "steer" | "followUp"; queueChipText?: string } | undefined;

		const handled = await tryRunRpcSkillCommand(
			{
				skillsSettings: { enableSkillCommands: true },
				skills: [
					{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
				],
				async promptCustomMessage(nextMessage: typeof message, nextOptions?: typeof options) {
					message = nextMessage;
					options = nextOptions;
					return true;
				},
			},
			"/skill:reviewer focus on risks",
		);

		expect(handled).toEqual({ agentInvoked: true });
		expect(message?.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
		expect(message?.content).toContain("Review the supplied code carefully.");
		expect(message?.content).toContain(`[Skill directory: ${dir}]`);
		expect(message?.content).toContain("focus on risks");
		expect(message?.display).toBe(true);
		expect(message?.attribution).toBe("user");
		expect(options).toEqual({ streamingBehavior: "steer", queueChipText: "/skill:reviewer focus on risks" });

		await removeWithRetries(dir);
	});

	test("keeps the RPC /skill command compact in a streaming session queue chip", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		const command = "/skill:reviewer focus on risks";
		const skillBody = "Review the supplied code carefully.";
		const streamStarted = Promise.withResolvers<void>();
		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		try {
			await Bun.write(skillPath, `---\nname: reviewer\ndescription: Review code\n---\n\n${skillBody}\n`);
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled anthropic model");
			const mock = createMockModel({
				responses: [
					() => {
						streamStarted.resolve();
						return { content: ["working"], delayMs: 60_000 };
					},
				],
			});
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [] },
				streamFn: mock.stream,
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage),
				skills: [
					{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
				],
				skillsSettings: { enableSkillCommands: true },
			});

			const activePrompt = session.prompt("Keep the primary stream active");
			await streamStarted.promise;

			expect(await tryRunRpcSkillCommand(session, command)).toEqual({ agentInvoked: true });
			const queued = session.getQueuedPrompts();
			expect(queued).toEqual([
				{ id: expect.any(String), text: command, delivery: "steer", customType: SKILL_PROMPT_MESSAGE_TYPE },
			]);
			expect(JSON.stringify(queued)).not.toContain(skillBody);

			await session.abort();
			await activePrompt;
		} finally {
			await session?.dispose();
			authStorage.close();
			await removeWithRetries(dir);
		}
	});

	test("honors the RPC prompt streaming behavior for registered /skill commands", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		let options: { streamingBehavior?: "steer" | "followUp" | "aside" } | undefined;
		try {
			const handled = await tryRunRpcSkillCommand(
				{
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: skillPath,
							baseDir: dir,
							source: "project",
						},
					],
					async promptCustomMessage(nextMessage, nextOptions) {
						expect(nextMessage.customType).toBe(SKILL_PROMPT_MESSAGE_TYPE);
						options = nextOptions;
						return true;
					},
				},
				"/skill:reviewer wait for the current turn",
				"followUp",
			);

			expect(handled).toEqual({ agentInvoked: true });
			expect(options?.streamingBehavior).toBe("followUp");
		} finally {
			await removeWithRetries(dir);
		}
	});

	test("ignores unknown skill commands so normal prompt handling can continue", async () => {
		const handled = await tryRunRpcSkillCommand(
			{
				skillsSettings: { enableSkillCommands: true },
				skills: [],
				async promptCustomMessage() {
					throw new Error("should not dispatch unknown skills");
				},
			},
			"/skill:missing",
		);

		expect(handled).toBe(false);
	});

	test("does not steal builtin slash-command arguments that mention registered skills", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		let dispatched = false;
		try {
			const handled = await tryRunRpcSkillCommand(
				{
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: skillPath,
							baseDir: dir,
							source: "project",
						},
					],
					async promptCustomMessage() {
						dispatched = true;
						return true;
					},
				},
				"/compact /skill:reviewer",
			);

			expect(handled).toBe(false);
			expect(dispatched).toBe(false);
		} finally {
			await removeWithRetries(dir);
		}
	});
});

async function settleUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await Bun.sleep(1);
	}
	if (!condition()) throw new Error("condition not met while settling");
}

describe("dispatchRpcSkillPrompt", () => {
	test("answers the prompt command before the skill dispatch completes", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: reviewer\ndescription: Review code\n---\n\nReview the supplied code carefully.\n",
		);

		const dispatchGate = Promise.withResolvers<void>();
		let promptCustomMessageCalls = 0;
		const result = await dispatchRpcSkillPrompt({
			id: "cmd-1",
			session: {
				skillsSettings: { enableSkillCommands: true },
				skills: [
					{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
				],
				async promptCustomMessage() {
					promptCustomMessageCalls += 1;
					await dispatchGate.promise;
					return true;
				},
			},
			message: "/skill:reviewer go",
			streamingBehavior: undefined,
			output: () => {},
			onError: () => {},
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		});

		// The answer does not wait for the dispatch pipeline: with the gate
		// closed, awaiting the pipeline (usage preflight, compaction, provider
		// calls) would hang this call forever — it returns regardless.
		expect(result).toEqual({ agentInvoked: true });

		dispatchGate.resolve();
		await settleUntil(() => promptCustomMessageCalls === 1);
		expect(promptCustomMessageCalls).toBe(1);

		await removeWithRetries(dir);
	});

	test("returns null for non-skill messages", async () => {
		const result = await dispatchRpcSkillPrompt({
			id: "cmd-2",
			session: {
				skillsSettings: { enableSkillCommands: true },
				skills: [],
				async promptCustomMessage() {
					return true;
				},
			},
			message: "just a normal prompt",
			streamingBehavior: undefined,
			output: () => {},
			onError: () => {},
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		});
		expect(result).toBeNull();
	});

	test("a late dispatch failure surfaces through onError, not the answer", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(skillPath, "---\nname: reviewer\ndescription: Review code\n---\n\nBody.\n");

		const errors: Error[] = [];
		await dispatchRpcSkillPrompt({
			id: "cmd-3",
			session: {
				skillsSettings: { enableSkillCommands: true },
				skills: [
					{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
				],
				async promptCustomMessage() {
					throw new Error("dispatch pipeline exploded");
				},
			},
			message: "/skill:reviewer go",
			streamingBehavior: undefined,
			output: () => {},
			onError: error => errors.push(error),
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		});

		await settleUntil(() => errors.length === 1);
		expect(errors.map(error => error.message)).toEqual(["dispatch pipeline exploded"]);

		await removeWithRetries(dir);
	});

	test("rejects before answering when the skill file cannot be read", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const missingSkillPath = path.join(dir, "SKILL.md");

		let promptCustomMessageCalls = 0;
		await expect(
			dispatchRpcSkillPrompt({
				id: "cmd-4",
				session: {
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "reviewer",
							description: "Review code",
							filePath: missingSkillPath,
							baseDir: dir,
							source: "project",
						},
					],
					async promptCustomMessage() {
						promptCustomMessageCalls += 1;
						return true;
					},
				},
				message: "/skill:reviewer go",
				streamingBehavior: undefined,
				output: () => {},
				onError: () => {},
				extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
			}),
		).rejects.toThrow();
		expect(promptCustomMessageCalls).toBe(0);

		await removeWithRetries(dir);
	});

	test("emits a non-invoked completion frame when the dispatch bails before the turn starts", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-rpc-skill-${Snowflake.next()}-`));
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(skillPath, "---\nname: reviewer\ndescription: Review code\n---\n\nBody.\n");

		const frames: object[] = [];
		const result = await dispatchRpcSkillPrompt({
			id: "cmd-5",
			session: {
				skillsSettings: { enableSkillCommands: true },
				skills: [
					{ name: "reviewer", description: "Review code", filePath: skillPath, baseDir: dir, source: "project" },
				],
				// Simulates the abort-overtakes-preflight race: promptCustomMessage
				// bails before agent.prompt() runs, so no agent_end is ever emitted.
				async promptCustomMessage() {
					return false;
				},
			},
			message: "/skill:reviewer go",
			streamingBehavior: undefined,
			output: frame => frames.push(frame),
			onError: () => {},
			extensionUserMessageTracker: new RpcExtensionUserMessageTracker(),
		});

		expect(result).toEqual({ agentInvoked: true });
		await settleUntil(() => frames.length === 1);
		expect(frames).toEqual([{ type: "prompt_result", id: "cmd-5", agentInvoked: false }]);

		await removeWithRetries(dir);
	});
});
