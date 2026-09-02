import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Context, Message, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function wireText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return (message.content as (TextContent | { type: string })[])
		.map(b => (b.type === "text" ? (b as TextContent).text : ""))
		.join("");
}

describe("agentLoop with owned in-band tool calls", () => {
	it("executes <tool_call> text, strips native tools from the wire, and re-encodes history as text", async () => {
		const echoArgs: Array<{ msg: string }> = [];
		const toolSchema = type({ msg: "string" });
		const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a message back",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				echoArgs.push(params);
				return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
			},
		};

		const captured: Context[] = [];
		const mock = createMockModel({
			responses: [
				context => {
					captured.push(context);
					return {
						content: [
							"on it\n<tool_call>echo\n<arg_key>msg</arg_key>\n<arg_value>hello world</arg_value>\n</tool_call>",
						],
					};
				},
				context => {
					captured.push(context);
					return { content: ["all done"] };
				},
			],
		});

		const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, dialect: "glm" };

		const messages = await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();

		// The tool was actually executed with the parsed (verbatim) argument.
		expect(echoArgs).toEqual([{ msg: "hello world" }]);
		expect(captured).toHaveLength(2);

		// First request: no native tools on the wire; catalog + grammar injected.
		expect(captured[0].tools).toBeUndefined();
		const sys0 = captured[0].systemPrompt ?? [];
		expect(sys0[0]).toBe("BASE PROMPT");
		const promptSection = sys0.join("\n");
		expect(promptSection).toContain("<tools>");
		expect(promptSection).toContain('"name":"echo"');
		expect(promptSection).toContain("<arg_key>name</arg_key>");

		// Second request: the wire carries NO native tool blocks — prior call/result
		// are plain <tool_call> / <tool_response> text, and tools are still stripped.
		const wire2 = captured[1].messages;
		expect(captured[1].tools).toBeUndefined();
		for (const m of wire2) {
			expect(m.role).not.toBe("toolResult");
			if (m.role === "assistant") {
				expect((m.content as { type: string }[]).some(b => b.type === "toolCall")).toBe(false);
			}
		}
		const wireAssistant = wire2.find(m => m.role === "assistant");
		expect(wireAssistant).toBeDefined();
		const at = wireText(wireAssistant!);
		expect(at).toContain("on it");
		expect(at).toContain("<tool_call>echo");
		expect(at).toContain("<arg_value>hello world</arg_value>");
		const resultsText = wire2
			.filter(m => m.role === "user")
			.map(wireText)
			.join("\n");
		expect(resultsText).toContain("<tool_response>");
		expect(resultsText).toContain("echoed:hello world");

		// The internal store stays canonical: native toolCall block + toolResult message.
		const internalAssistant = messages.find(
			(m): m is AssistantMessage => m.role === "assistant" && m.content.some(b => b.type === "toolCall"),
		);
		expect(internalAssistant).toBeDefined();
		const internalResult = messages.find((m): m is ToolResultMessage => m.role === "toolResult");
		expect(internalResult).toBeDefined();
		expect(internalResult!.toolName).toBe("echo");
		expect(wireText(internalResult!)).toBe("echoed:hello world");
	});

	it("enforces a named hard choice locally for owned dialects", async () => {
		let todoRuns = 0;
		let choiceCalls = 0;
		const todoSchema = type({ op: "string" });
		const todoTool: AgentTool<typeof todoSchema, { op: string }> = {
			name: "todo",
			label: "Todo",
			description: "Update task state",
			parameters: todoSchema,
			async execute(_toolCallId, params) {
				todoRuns++;
				return { content: [{ type: "text", text: "updated" }], details: params };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: ["finished without reconciling"] },
				{
					content: ["<tool_call>todo\n<arg_key>op</arg_key>\n<arg_value>view</arg_value>\n</tool_call>"],
				},
				{ content: ["done"] },
			],
		});
		const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [todoTool] };
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			dialect: "glm",
			getToolChoice: () => (++choiceCalls === 1 ? { type: "tool", name: "todo" } : undefined),
		};

		await agentLoop([createUserMessage("finish")], context, config, undefined, mock.stream).result();

		expect(todoRuns).toBe(1);
		expect(choiceCalls).toBe(2);
		expect(mock.calls).toHaveLength(3);
		expect(mock.calls.every(call => call.options?.toolChoice === undefined)).toBe(true);
	});

	it("preserves a conflicting hard choice over a soft requirement in owned dialects", async () => {
		let todoRuns = 0;
		let resolveRuns = 0;
		let resolvePending = true;
		const schema = type({ op: "string" });
		const todoTool: AgentTool<typeof schema, { op: string }> = {
			name: "todo",
			label: "Todo",
			description: "Hard-required tool",
			parameters: schema,
			async execute(_toolCallId, params) {
				todoRuns++;
				config.toolChoice = undefined;
				return { content: [{ type: "text", text: "todo updated" }], details: params };
			},
		};
		const resolveTool: AgentTool<typeof schema, { op: string }> = {
			name: "resolve",
			label: "Resolve",
			description: "Soft-required tool",
			parameters: schema,
			async execute(_toolCallId, params) {
				resolveRuns++;
				resolvePending = false;
				return { content: [{ type: "text", text: "resolved" }], details: params };
			},
		};
		const mock = createMockModel({
			responses: [
				{
					content: ["<tool_call>todo\n<arg_key>op</arg_key>\n<arg_value>done</arg_value>\n</tool_call>"],
				},
				{
					content: ["<tool_call>resolve\n<arg_key>op</arg_key>\n<arg_value>apply</arg_value>\n</tool_call>"],
				},
				{ content: ["done"] },
			],
		});
		const reminder = createUserMessage("<system-reminder>Resolve the pending preview.</system-reminder>");
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			dialect: "glm",
			toolChoice: { type: "tool", name: "todo" },
			getToolChoice: () =>
				resolvePending
					? { soft: true as const, id: "preview", toolName: "resolve", reminder: [reminder] }
					: undefined,
		};
		const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [todoTool, resolveTool] };

		await agentLoop([createUserMessage("finish")], context, config, undefined, mock.stream).result();

		expect(todoRuns).toBe(1);
		expect(resolveRuns).toBe(1);
		expect(mock.calls).toHaveLength(3);
		expect(mock.calls.every(call => call.options?.toolChoice === undefined)).toBe(true);
	});

	it("prunes native tool descriptions from the wire when pruneToolDescriptions is set", async () => {
		const toolSchema = type({ msg: type("string").describe("the message to echo") });
		const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a message back",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
			},
		};
		const captured: Context[] = [];
		const mock = createMockModel({
			responses: [
				context => {
					captured.push(context);
					return { content: ["done"] };
				},
			],
		});
		const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			pruneToolDescriptions: true,
		};
		await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();

		const wireTools = captured[0]?.tools;
		expect(wireTools).toHaveLength(1);
		expect(wireTools?.[0].name).toBe("echo");
		// Native tool calling: spec ships with no description text (top-level or nested).
		expect(wireTools?.[0].description).toBe("");
		expect(JSON.stringify(wireTools?.[0].parameters)).not.toContain("the message to echo");
	});

	it("keeps in-band tool descriptions for owned dialects even when pruneToolDescriptions is set", async () => {
		const toolSchema = type({ msg: "string" });
		const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a message back",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
			},
		};
		const captured: Context[] = [];
		const mock = createMockModel({
			responses: [
				context => {
					captured.push(context);
					return { content: ["done"] };
				},
			],
		});
		const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			dialect: "glm",
			pruneToolDescriptions: true,
		};
		await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();

		// Owned dialect carries the catalog in the prompt as text and sends no native
		// tools, so pruning must not strip its descriptions.
		expect(captured[0]?.tools).toBeUndefined();
		const promptSection = (captured[0]?.systemPrompt ?? []).join("\n");
		expect(promptSection).toContain("<tools>");
		expect(promptSection).toContain("Echo a message back");
	});

	it("observes final owned-dialect contracts after the awaited provider hook", async () => {
		const schema = type({ msg: type("string").describe("message to echo") });
		const tool: AgentTool<typeof schema, { msg: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a message back",
			parameters: schema,
			examples: [{ caption: "Echo once", call: { msg: "hello" } }],
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: params.msg }], details: params };
			},
		};
		const events: string[] = [];
		let observed: unknown;
		const mock = createMockModel({
			responses: [
				async (_context, options) => {
					await options?.onPayload?.({ provider: "hostile-transform" }, mock.model);
					await options?.onToolContracts?.({ tools: [] }, mock.model);
					return { content: ["done"] };
				},
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			dialect: "glm",
			intentTracing: true,
			onPayload: async payload => {
				events.push("hook-start");
				await Promise.resolve();
				events.push("hook-end");
				return { ...(payload as Record<string, unknown>), guarded: true };
			},
			onToolContracts: payload => {
				events.push("contracts");
				observed = payload;
			},
		};

		await agentLoop(
			[createUserMessage("say hi")],
			{ systemPrompt: ["BASE PROMPT"], messages: [], tools: [tool] },
			config,
			undefined,
			mock.stream,
		).result();

		expect(events).toEqual(["hook-start", "hook-end", "contracts"]);
		const observedTool = (observed as { tools: Context["tools"] }).tools?.[0];
		expect(observedTool?.description).toContain("Echo a message back");
		expect(observedTool?.description).toContain("<examples>");
		expect(observedTool?.description).toContain('i="…"');
		expect(JSON.stringify(observedTool?.parameters)).toContain('"i"');
	});

	it("executes Hermes/Qwen JSON tool calls when that dialect is selected", async () => {
		const echoArgs: Array<{ msg: string }> = [];
		const toolSchema = type({ msg: "string" });
		const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo a message back",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				echoArgs.push(params);
				return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
			},
		};

		const captured: Context[] = [];
		const mock = createMockModel({
			responses: [
				context => {
					captured.push(context);
					return { content: ['<tool_call>\n{"name":"echo","arguments":{"msg":"hi"}}\n</tool_call>'] };
				},
				context => {
					captured.push(context);
					return { content: ["done"] };
				},
			],
		});

		const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter, dialect: "hermes" };

		await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();

		expect(echoArgs).toEqual([{ msg: "hi" }]);
		expect(captured[0].tools).toBeUndefined();
		expect((captured[0].systemPrompt ?? []).join("\n")).toContain('"name":"function_name","arguments"');
		const resultsText = captured[1].messages
			.filter(m => m.role === "user")
			.map(wireText)
			.join("\n");
		expect(resultsText).toContain("<tool_response>");
		expect(resultsText).toContain("echoed:hi");
	});

	it("uses PI_DIALECT=minimax when config.dialect is unset", async () => {
		const before = Bun.env.PI_DIALECT;
		Bun.env.PI_DIALECT = "minimax";
		try {
			const echoArgs: Array<{ msg: string }> = [];
			const toolSchema = type({ msg: "string" });
			const echoTool: AgentTool<typeof toolSchema, { msg: string }> = {
				name: "echo",
				label: "Echo",
				description: "Echo a message back",
				parameters: toolSchema,
				async execute(_toolCallId, params) {
					echoArgs.push(params);
					return { content: [{ type: "text", text: `echoed:${params.msg}` }], details: params };
				},
			};

			const captured: Context[] = [];
			const mock = createMockModel({
				responses: [
					context => {
						captured.push(context);
						return {
							content: [
								'<minimax:tool_call>\n<invoke name="echo"><parameter name="msg">from env</parameter></invoke>\n</minimax:tool_call>',
							],
						};
					},
					context => {
						captured.push(context);
						return { content: ["done"] };
					},
				],
			});

			const context: AgentContext = { systemPrompt: ["BASE PROMPT"], messages: [], tools: [echoTool] };
			const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };

			await agentLoop([createUserMessage("say hi")], context, config, undefined, mock.stream).result();

			expect(echoArgs).toEqual([{ msg: "from env" }]);
			expect(captured[0].tools).toBeUndefined();
			expect((captured[0].systemPrompt ?? []).join("\n")).toContain("<minimax:tool_call>");
		} finally {
			if (before === undefined) delete Bun.env.PI_DIALECT;
			else Bun.env.PI_DIALECT = before;
		}
	});
});
