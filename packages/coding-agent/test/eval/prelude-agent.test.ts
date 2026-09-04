import { describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";

/**
 * The eval `agent()` helper always returns an `AgentHandle` — spawning is
 * asynchronous, so callers get a recoverable `agent://<id>` handle and
 * resolve results through `wait()`/`output()` instead of a bare string.
 * These lock the bridge call shape, the handle surface, the positional-arg
 * order, the missing-id error contract, and schema-aware `wait()` parsing.
 *
 * The prelude source is executed verbatim in a throwaway VM context with only
 * the host bridge (`__omp_call_tool__`) stubbed — no worker, no kernel — so the
 * test runs against the real shipped helper, not a re-implementation.
 */
function loadPrelude(callTool: (name: string, args: unknown) => Promise<unknown>): Record<string, unknown> {
	const sandbox: Record<string, unknown> = { __omp_call_tool__: callTool };
	vm.createContext(sandbox);
	vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);
	return sandbox;
}

type AgentHelper = (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;

describe("eval js agent() handle", () => {
	it("returns an AgentHandle carrying the bridge id, agent name, and agent:// uri", async () => {
		let seenName: string | undefined;
		let seenArgs: Record<string, unknown> | undefined;
		const sandbox = loadPrelude(async (name, args) => {
			seenName = name;
			seenArgs = args as Record<string, unknown>;
			return { id: "abc123", agent: "task" };
		});
		const handle = (await (sandbox.agent as AgentHelper)("say hi", {
			label: "Greeter",
			model: ["p/first", "p/second"],
		})) as Record<string, unknown>;
		expect(seenArgs).toEqual({ prompt: "say hi", label: "Greeter", model: ["p/first", "p/second"] });
		expect(seenName).toBe("__agent__");
		expect(handle.kind).toBe("agent");
		expect(handle.id).toBe("abc123");
		expect(handle.agent).toBe("task");
		expect(handle.handle).toBe("agent://abc123");
	});

	it("maps positional args onto named options in order", async () => {
		let seenArgs: Record<string, unknown> | undefined;
		const sandbox = loadPrelude(async (_name, args) => {
			seenArgs = args as Record<string, unknown>;
			return { id: "legacy", agent: "reviewer" };
		});
		const positionalAgent = sandbox.agent as (
			prompt: string,
			options?: unknown,
			...rest: unknown[]
		) => Promise<unknown>;
		const schema = { type: "object", properties: { ok: { type: "boolean" } } };

		await positionalAgent("scout", "reviewer", "Legacy", schema, true, false, true, "strict", ["read"]);

		expect(seenArgs).toEqual({
			prompt: "scout",
			agent: "reviewer",
			label: "Legacy",
			schema,
			isolated: true,
			apply: false,
			merge: true,
			schemaMode: "strict",
			tools: ["read"],
		});
	});

	it("throws when the bridge omits the handle id", async () => {
		const sandbox = loadPrelude(async () => ({ text: "lonely" }));
		await expect((sandbox.agent as AgentHelper)("x")).rejects.toThrow("agent() did not return a handle");
	});

	it("parses wait output and records the resolved model on the handle", async () => {
		const sandbox = loadPrelude(async name => {
			if (name === "__agent__") return { id: "id-9", agent: "task" };
			if (name === "__wait__") {
				return {
					items: [{ status: "completed", text: '{"k":1}', model: "p/selected", modelFallback: true }],
				};
			}
			throw new Error(`unexpected bridge call ${name}`);
		});
		const withSchema = (await (sandbox.agent as AgentHelper)("emit", {
			schema: { type: "object" },
		})) as { wait(): Promise<unknown>; model?: string; modelFallback?: boolean };
		expect(await withSchema.wait()).toEqual({ k: 1 });
		expect(withSchema.model).toBe("p/selected");
		expect(withSchema.modelFallback).toBe(true);

		const plain = (await (sandbox.agent as AgentHelper)("emit")) as {
			wait(): Promise<unknown>;
		};
		expect(await plain.wait()).toBe('{"k":1}');
	});

	it("records model metadata before a failed wait throws", async () => {
		const sandbox = loadPrelude(async name => {
			if (name === "__agent__") return { id: "id-fail", agent: "task" };
			if (name === "__wait__") {
				return {
					items: [{ status: "failed", error: "boom", model: "p/parent", modelFallback: true }],
				};
			}
			throw new Error(`unexpected bridge call ${name}`);
		});
		const handle = (await (sandbox.agent as AgentHelper)("fail")) as {
			wait(): Promise<unknown>;
			model?: string;
			modelFallback?: boolean;
		};

		await expect(handle.wait()).rejects.toThrow("boom");
		expect(handle.model).toBe("p/parent");
		expect(handle.modelFallback).toBe(true);
	});
});

describe("eval js read() URI delegation", () => {
	it("appends line selectors to delegated URI paths", async () => {
		const calls: Array<{ name: string; args: unknown }> = [];
		const sandbox = loadPrelude(async (name, args) => {
			calls.push({ name, args });
			return { text: "resource contents" };
		});

		const result = await vm.runInContext(`read("mcp://server/resource", { offset: 10, limit: 5 })`, sandbox);

		expect(result).toBe("resource contents");
		expect(calls).toEqual([
			{
				name: "read",
				args: { path: "mcp://server/resource:10-14" },
			},
		]);
	});
});
