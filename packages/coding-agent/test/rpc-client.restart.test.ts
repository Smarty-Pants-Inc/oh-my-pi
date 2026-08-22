import { describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { RpcClient, RpcCommandError, RpcConcurrencyError } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { type ChildProcess, ptree, TempDir } from "@oh-my-pi/pi-utils";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("RpcClient lifecycle (issue #4079 B)", () => {
	test("auto-negotiates protocol v2 and reassembles an oversized response", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1" },
		});

		await client.start();
		const state = (await client.getState()) as unknown as { payload: string };
		expect(state.payload).toBe("😀".repeat(270_000));
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 },
		]);
	}, 20_000);

	test("waitForIdle resolves on an already-idle server with the negotiated barrier", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1" },
		});

		await client.start();
		await expect(client.waitForIdle(500)).resolves.toBeUndefined();
	}, 20_000);

	test("resolves repeated idle waits on an already-idle legacy server", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LOCAL_ONLY_PROMPT: "response" },
		});

		await client.start();
		await client.prompt("local-only prompt");
		await expect(client.waitForIdle(500)).resolves.toBeUndefined();
		await expect(client.waitForIdle(500)).resolves.toBeUndefined();
	}, 20_000);

	test("rebases a concurrent legacy waiter after an immediately rejected schedule", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_REJECT_QUEUED: "1" },
		});

		await client.start();
		const rejected = client.steer("rejected schedule");
		const idle = client.waitForIdle(500);
		await expect(rejected).rejects.toThrow("rejected command");
		await expect(idle).resolves.toBeUndefined();
	}, 20_000);

	test("follows overlapping legacy rollback aliases to their original idle cutoff", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_REJECT_QUEUED: "1" },
		});

		await client.start();
		const first = client.steer("rejected schedule A").catch(error => error);
		const second = client.followUp("rejected schedule B").catch(error => error);
		const idle = client.waitForIdle(500);
		expect(await first).toMatchObject({ message: "rejected command" });
		expect(await second).toMatchObject({ message: "rejected command" });
		await expect(idle).resolves.toBeUndefined();
	}, 20_000);

	test("falls back to terminal events when a v2 server omits idleBarrier", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_V2: "1",
				MOCK_RPC_LEGACY_V2: "1",
				MOCK_RPC_NON_TERMINAL_AGENT_END: "1",
			},
		});

		await client.start();
		const idle = client.waitForIdle();
		await client.prompt("legacy v2 prompt");
		await expect(idle).resolves.toBeUndefined();
	}, 20_000);

	test("treats agentInvoked false as idle without a v2 idle barrier", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_LEGACY_V2: "1", MOCK_RPC_LOCAL_ONLY_PROMPT: "response" },
		});

		await client.start();
		await client.prompt("local-only prompt");
		await expect(client.waitForIdle(500)).resolves.toBeUndefined();
	}, 20_000);

	test("wakes promptAndWait when a legacy server reports a local-only prompt_result", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LOCAL_ONLY_PROMPT: "result" },
		});

		await client.start();
		await expect(client.promptAndWait("async local-only prompt", undefined, 500)).resolves.toEqual([]);
	}, 20_000);

	test("an older local-only prompt_result cannot complete a newer active schedule", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_OVERLAPPING_LOCAL_PROMPT_RESULT: "1" },
		});

		await client.start();
		await client.prompt("local-only schedule A");
		await client.prompt("active schedule B");
		let idleSettled = false;
		const idle = client.waitForIdle(1_000);
		void idle.then(
			() => {
				idleSettled = true;
			},
			() => {
				idleSettled = true;
			},
		);
		const state = (await client.getState()) as unknown as { olderPromptResultSent: boolean };
		expect(state.olderPromptResultSent).toBe(true);
		await Promise.resolve();
		expect(idleSettled).toBe(false);

		await client.getMessages();
		await expect(idle).resolves.toBeUndefined();
	}, 20_000);

	test("does not use an idleBarrier advertisement without closureRejection acknowledgement", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_V2: "1",
				MOCK_RPC_IDLE_WITHOUT_CLOSURE_ACK: "1",
				MOCK_RPC_REJECT_IDLE_BARRIER: "1",
				MOCK_RPC_NON_TERMINAL_AGENT_END: "1",
			},
		});

		await client.start();
		await client.prompt("legacy capability prompt");
		await expect(client.waitForIdle()).resolves.toBeUndefined();
	}, 20_000);

	for (const command of ["prompt", "abort_and_prompt"] as const) {
		test(`surfaces a same-id late ${command} scheduling failure after the idle barrier`, async () => {
			using client = new RpcClient({
				cliPath: MOCK_AGENT,
				env: { MOCK_RPC_V2: "1", MOCK_RPC_LATE_FAILURE_COMMAND: command },
			});

			await client.start();
			if (command === "prompt") await client.prompt("late failure prompt");
			else await client.abortAndPrompt("late failure prompt");

			await expect(client.waitForIdle()).rejects.toMatchObject({
				name: "RpcCommandError",
				command,
				message: "late failure",
			});
		}, 20_000);
		test(`wakes a legacy waiter for a same-id late ${command} scheduling failure`, async () => {
			using client = new RpcClient({
				cliPath: MOCK_AGENT,
				env: { MOCK_RPC_LATE_FAILURE_COMMAND: command },
			});

			await client.start();
			if (command === "prompt") await client.prompt("late failure prompt");
			else await client.abortAndPrompt("late failure prompt");

			await expect(client.waitForIdle(500)).rejects.toMatchObject({
				name: "RpcCommandError",
				command,
				message: "late failure",
			});
		}, 20_000);
	}

	test("a v2 barrier follows a rejected successor rollback chain to the failed predecessor", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_V2: "1",
				MOCK_RPC_LATE_FAILURE_COMMAND: "prompt",
				MOCK_RPC_REJECT_QUEUED: "1",
			},
		});

		await client.start();
		await client.prompt("predecessor A");
		await client.getState();
		const rejectedB = client.steer("successor B");
		const rejectedC = client.followUp("successor C");
		const idle = client.waitForIdle();
		void rejectedB.catch(() => {});
		void rejectedC.catch(() => {});
		void idle.catch(() => {});
		await expect(rejectedB).rejects.toThrow("rejected command");
		await expect(rejectedC).rejects.toThrow("rejected command");
		await expect(idle).rejects.toMatchObject({
			name: "RpcCommandError",
			command: "prompt",
			message: "late failure",
		});
	}, 20_000);

	test("includes a written prompt in a v2 barrier cutoff before delayed acceptance", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_DELAYED_ACCEPTANCE_LATE_FAILURE: "1" },
		});

		await client.start();
		const prompt = client.prompt("delayed acceptance prompt");
		const idle = client.waitForIdle();
		await prompt;
		await expect(idle).rejects.toMatchObject({
			name: "RpcCommandError",
			command: "prompt",
			message: "late failure",
		});
	}, 20_000);

	test("includes a written prompt in a legacy idle cutoff before delayed acceptance", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_DELAYED_ACCEPTANCE_LATE_FAILURE: "1" },
		});

		await client.start();
		const prompt = client.prompt("delayed acceptance prompt");
		const idle = client.waitForIdle(500);
		await prompt;
		await expect(idle).rejects.toMatchObject({
			name: "RpcCommandError",
			command: "prompt",
			message: "late failure",
		});
	}, 20_000);

	test("a late failure cannot steal an overlapping prompt response", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_OVERLAPPING_LATE_PROMPT_FAILURE: "1" },
		});

		await client.start();
		await client.prompt("first prompt");
		await expect(client.prompt("second prompt")).resolves.toBeUndefined();
		await expect(client.waitForIdle()).rejects.toBeInstanceOf(RpcCommandError);
	}, 20_000);

	test("a held barrier excludes a later prompt failure outside its accepted schedule cutoff", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_HELD_BARRIER_FAILURES: "later" },
		});

		await client.start();
		await client.prompt("first prompt");
		const firstIdle = client.waitForIdle();
		await client.prompt("later prompt");

		await expect(firstIdle).resolves.toBeUndefined();
		await expect(client.waitForIdle()).rejects.toMatchObject({
			name: "RpcCommandError",
			command: "prompt",
			message: "later failure",
		});
	}, 20_000);

	test("a held barrier retains its earlier failure despite a later prompt failure", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_HELD_BARRIER_FAILURES: "earlier_and_later" },
		});

		await client.start();
		await client.prompt("first prompt");
		const firstIdle = client.waitForIdle();
		void firstIdle.catch(() => {});
		await client.prompt("later prompt");

		await expect(firstIdle).rejects.toMatchObject({
			name: "RpcCommandError",
			command: "prompt",
			message: "earlier failure",
		});
		await expect(client.waitForIdle()).rejects.toMatchObject({
			name: "RpcCommandError",
			command: "prompt",
			message: "later failure",
		});
	}, 20_000);

	test("prompt lifecycle collectors are single-flight", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_IDLE_DELAY_MS: "100" },
		});

		await client.start();
		const idle = client.waitForIdle();
		await expect(client.collectEvents(500)).rejects.toBeInstanceOf(RpcConcurrencyError);
		await expect(idle).resolves.toBeUndefined();
	}, 20_000);

	test("session replacement cancels the prior collector before new-session events arrive", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_PROMPT_AGENT_END: "1" },
		});
		await client.start();
		const replacements = [
			() => client.newSession(),
			() => client.switchSession("/tmp/next.jsonl"),
			() => client.branch("entry-1"),
			() => client.handoff(),
		];

		for (const replace of replacements) {
			const stale = client.collectEvents();
			void stale.catch(() => {});
			await replace();
			await expect(stale).rejects.toThrow("Client session replaced");

			const fresh = client.collectEvents();
			await client.prompt("new generation");
			await expect(fresh).resolves.toEqual([expect.objectContaining({ type: "agent_end" })]);
		}
	}, 20_000);

	test.each([
		["newSession", (client: RpcClient) => client.newSession()],
		["switchSession", (client: RpcClient) => client.switchSession("/tmp/next.jsonl")],
		["branch", (client: RpcClient) => client.branch("entry-1")],
		["handoff", (client: RpcClient) => client.handoff()],
	] as const)(
		"%s rejects a collector when an old barrier completes before its replacement response",
		async (_name, replace) => {
			using client = new RpcClient({
				cliPath: MOCK_AGENT,
				env: { MOCK_RPC_V2: "1", MOCK_RPC_SESSION_REPLACEMENT_RACE: "1" },
			});
			const oldTerminal = Promise.withResolvers<void>();
			client.onSessionEvent(event => {
				if (event.type === "agent_end") oldTerminal.resolve();
			});
			await client.start();
			const stale = client.waitForIdle();
			void stale.catch(() => {});
			const replacement = replace(client);
			await oldTerminal.promise;
			await client.getState();
			await replacement;
			await expect(stale).rejects.toThrow("Client session replaced");
		},
		20_000,
	);

	test("scheduled calls begun during replacement wait for its post-replacement generation", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_SESSION_REPLACEMENT_RACE: "1" },
		});
		await client.start();
		const replacement = client.newSession();
		const scheduled = Promise.all([
			client.prompt("post-replacement"),
			client.steer("steer"),
			client.followUp("follow-up"),
		]);
		const state = (await client.getState()) as unknown as { scheduledDuringReplacement: number };
		expect(state.scheduledDuringReplacement).toBe(0);
		await replacement;
		await expect(scheduled).resolves.toEqual([undefined, undefined, undefined]);
	}, 20_000);

	test("overlapping replacements serialize their lifecycle generations", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_SESSION_REPLACEMENT_RACE: "1" },
		});
		await client.start();
		const first = client.newSession();
		const second = client.switchSession("/tmp/next.jsonl");
		await client.getState();
		await expect(first).resolves.toEqual({ cancelled: false });
		await client.getState();
		await expect(second).resolves.toEqual({ cancelled: false });
	}, 20_000);

	test("stop and restart cancel the prior collector before the new generation starts", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_PROMPT_AGENT_END: "1" },
		});
		await client.start();
		const stale = client.collectEvents();
		void stale.catch(() => {});
		await client.stop();
		await expect(stale).rejects.toThrow("Client stopped");

		await client.start();
		const fresh = client.collectEvents();
		await client.prompt("after restart");
		await expect(fresh).resolves.toEqual([expect.objectContaining({ type: "agent_end" })]);
	}, 20_000);

	test("successful session replacement clears the prior terminal rejection", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_CLOSURE_REJECTED: "1" },
		});

		await client.start();
		const changes = [
			{ name: "newSession", run: async () => !(await client.newSession()).cancelled },
			{ name: "switchSession", run: async () => !(await client.switchSession("/tmp/next.jsonl")).cancelled },
			{ name: "branch", run: async () => !(await client.branch("entry-1")).cancelled },
			{ name: "handoff", run: async () => (await client.handoff()) !== null },
		];

		for (const change of changes) {
			await client.prompt(`before ${change.name}`);
			await expect(client.waitForIdle()).rejects.toThrow("Completion rejected");
			expect(await change.run()).toBe(true);
			await expect(client.waitForIdle()).resolves.toBeUndefined();
		}
	}, 20_000);

	test("successful session replacement retains a target closure emitted before its response", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_TARGET_CLOSURE_BEFORE_REPLACEMENT_RESPONSE: "1" },
		});

		await client.start();
		expect((await client.newSession()).cancelled).toBe(false);
		await expect(client.waitForIdle()).rejects.toThrow("Completion rejected: 1 incomplete todo item(s) remain.");
	}, 20_000);

	test("cancelled session changes retain the prior terminal rejection", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_V2: "1",
				MOCK_RPC_CLOSURE_REJECTED: "1",
				MOCK_RPC_CANCEL_SESSION_CHANGE: "1",
				MOCK_RPC_CANCEL_HANDOFF: "1",
			},
		});

		await client.start();
		await client.prompt("before cancelled replacement");
		await expect(client.waitForIdle()).rejects.toThrow("Completion rejected");
		expect((await client.newSession()).cancelled).toBe(true);
		await expect(client.waitForIdle()).rejects.toThrow("Completion rejected");
		expect(await client.handoff()).toBeNull();
		await expect(client.waitForIdle()).rejects.toThrow("Completion rejected");
	}, 20_000);

	test("forwards rejected terminal closures to every subscriber and rejects completion helpers", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_CLOSURE_REJECTED: "1" },
		});
		const firstSubscriber: unknown[] = [];
		const secondSubscriber: unknown[] = [];
		let unsubscribeFirst = () => {};
		unsubscribeFirst = client.onSessionEvent(event => {
			if (event.type !== "agent_end") return;
			firstSubscriber.push(event);
			unsubscribeFirst();
		});

		await client.start();
		client.onSessionEvent(event => {
			if (event.type === "agent_end") secondSubscriber.push(event);
		});
		await client.prompt("first prompt");
		expect(firstSubscriber).toHaveLength(1);
		expect(secondSubscriber).toHaveLength(1);

		// The closure frame is emitted before the prompt response, so this exact
		// documented sequence proves waitForIdle() consumes the terminal latch.
		await expect(client.waitForIdle()).rejects.toThrow("Completion rejected: 1 incomplete todo item(s) remain.");
		await expect(client.promptAndWait("second prompt")).rejects.toThrow(
			"Completion rejected: 1 incomplete todo item(s) remain.",
		);

		expect(secondSubscriber).toHaveLength(2);
		for (const event of [...firstSubscriber, ...secondSubscriber]) {
			expect(event).toEqual(
				expect.objectContaining({
					type: "agent_end",
					closureRejected: {
						reason: "stale_todos",
						todos: [{ content: "Finish RPC task", status: "pending" }],
					},
				}),
			);
		}
	}, 20_000);

	test("waits for a queued steer to settle instead of retaining a prior rejected closure", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_CLOSURE_REJECTED: "1", MOCK_RPC_QUEUED_TERMINAL: "1" },
		});

		await client.start();
		await client.prompt("first prompt");
		await expect(client.waitForIdle()).rejects.toThrow("Completion rejected: 1 incomplete todo item(s) remain.");

		await client.steer("Continue with the corrected request.");
		await expect(client.waitForIdle()).resolves.toBeUndefined();
	}, 20_000);

	test("waits for a queued follow-up to settle instead of retaining a prior rejected closure", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_CLOSURE_REJECTED: "1", MOCK_RPC_QUEUED_TERMINAL: "1" },
		});

		await client.start();
		await client.prompt("first prompt");
		await expect(client.waitForIdle()).rejects.toThrow("Completion rejected: 1 incomplete todo item(s) remain.");

		await client.followUp("Continue with the corrected request.");
		await expect(client.waitForIdle()).resolves.toBeUndefined();
	}, 20_000);

	test("retains a prior rejected closure when a queued command is rejected", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_CLOSURE_REJECTED: "1", MOCK_RPC_REJECT_QUEUED: "1" },
		});

		await client.start();
		await client.prompt("first prompt");
		await expect(client.waitForIdle()).rejects.toThrow("Completion rejected: 1 incomplete todo item(s) remain.");

		await expect(client.steer("rejected successor")).rejects.toThrow("rejected command");
		await expect(client.waitForIdle()).rejects.toThrow("Completion rejected: 1 incomplete todo item(s) remain.");
	}, 20_000);

	test("fails closed when closure capability was not negotiated", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_CLOSURE_REJECTED: "1" },
		});

		await client.start();
		await client.prompt("legacy prompt");
		await expect(client.waitForIdle(500)).rejects.toThrow("Timeout waiting for agent to become idle");
	}, 20_000);
	test("wait helpers ignore nonterminal agent_end frames", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_NON_TERMINAL_AGENT_END: "1" },
		});
		const terminalEvents: unknown[] = [];
		client.onSessionEvent(event => {
			if (event.type === "agent_end") terminalEvents.push(event);
		});

		await client.start();
		const idle = client.waitForIdle();
		await client.prompt("first prompt");
		await idle;
		expect(terminalEvents).toEqual([
			expect.objectContaining({ type: "agent_end", isTerminal: false }),
			expect.objectContaining({ type: "agent_end", isTerminal: true }),
		]);

		const events = client.collectEvents();
		await client.prompt("second prompt");
		expect(await events).toEqual([
			expect.objectContaining({ type: "agent_end", isTerminal: false }),
			expect.objectContaining({ type: "agent_end", isTerminal: true }),
		]);
	}, 20_000);

	test("normalizes omitted state fields and a runtime-invalid tokensPerSecond", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LEGACY_STATE: "1", MOCK_RPC_INVALID_TPS: "1" },
		});

		await client.start();
		const state = await client.getState();
		expect(state.fastModeEnabled).toBe(false);
		expect(state.fastModeActive).toBe(false);
		expect(state.tokensPerSecond).toBeNull();
	}, 20_000);

	test("preserves getMessages snapshot behavior while a v2 page walk is unavailable", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_PAGE_BUSY: "1" },
		});

		await client.start();
		await expect(client.getMessagesPage()).rejects.toThrow("Cannot page messages while the session is changing");
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
		]);
	}, 20_000);

	test("discards partial pages and falls back to get_messages when a cursor goes stale mid-walk", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_V2: "1", MOCK_RPC_PAGE_STALE: "1" },
		});

		await client.start();
		// Direct page walks stay strict: the stale cursor is surfaced to the caller.
		const firstPage = await client.getMessagesPage();
		expect(firstPage.nextCursor).toBe("second-page");
		await expect(client.getMessagesPage({ cursor: firstPage.nextCursor })).rejects.toThrow(
			"RPC message cursor is stale",
		);
		// The high-level drain discards the partial first page and takes the legacy snapshot.
		expect((await client.getMessages()) as unknown).toEqual([
			{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
		]);
	}, 20_000);

	test("start() succeeds a second time after stop() on the same instance", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
		});

		// First lifecycle: start + stop.
		await client.start();
		await client.stop();

		// Second start on the same instance must NOT reuse the aborted
		// controller from the previous stop(). Before the fix, this rejected
		// with "Agent process exited before ready" because the JSONL reader
		// short-circuited on the pre-aborted signal.
		await client.start();
		await client.stop();
	}, 20000);

	test("rebases a legacy waiter after an asynchronous scheduled flush failure", async () => {
		const exited = Promise.withResolvers<number>();
		let failFlush = false;
		const child = {
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			stdin: {
				write() {
					return 0;
				},
				flush() {
					return failFlush ? Promise.reject(new Error("flush failed")) : 0;
				},
			},
			exited: exited.promise,
			peekStderr: () => "",
			kill() {
				exited.resolve(0);
			},
		};
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => child as unknown as ChildProcess);

		try {
			using client = new RpcClient({ cliPath: MOCK_AGENT });
			await client.start();
			failFlush = true;
			const rejected = client.steer("flush failure");
			const idle = client.waitForIdle(500);
			await expect(rejected).rejects.toThrow("flush failed");
			await expect(idle).resolves.toBeUndefined();
		} finally {
			spawn.mockRestore();
		}
	});

	test("a v2 barrier retains a predecessor closure when its written successor flush fails", async () => {
		const exited = Promise.withResolvers<number>();
		const encoder = new TextEncoder();
		let output!: ReadableStreamDefaultController<Uint8Array>;
		let failNextFlush = false;
		const enqueue = (frame: unknown) => output.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
		const child = {
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					output = controller;
					enqueue({
						type: "ready",
						protocolVersion: 1,
						supportedProtocolVersions: [1, 2],
						maxFrameBytes: 1024 * 1024,
						maxReassembledFrameBytes: 64 * 1024 * 1024,
					});
				},
			}),
			stdin: {
				write(chunk: string | Uint8Array) {
					const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
					const frame = JSON.parse(text) as { id: string; type: string };
					if (frame.type === "negotiate_protocol") {
						enqueue({
							id: frame.id,
							type: "response",
							command: frame.type,
							success: true,
							data: { protocolVersion: 2, closureRejection: true, idleBarrier: true },
						});
					} else if (frame.type === "prompt") {
						enqueue({ id: frame.id, type: "response", command: frame.type, success: true, data: {} });
						enqueue({
							type: "agent_end",
							messages: [],
							closureRejected: {
								reason: "stale_todos",
								todos: [{ content: "Finish predecessor A", status: "pending" }],
							},
						});
					} else if (frame.type === "wait_for_idle") {
						queueMicrotask(() =>
							enqueue({ id: frame.id, type: "response", command: frame.type, success: true, data: {} }),
						);
					}
					return 0;
				},
				flush() {
					if (!failNextFlush) return 0;
					failNextFlush = false;
					return Promise.reject(new Error("flush failed"));
				},
			},
			exited: exited.promise,
			peekStderr: () => "",
			kill() {
				exited.resolve(0);
			},
		};
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => child as unknown as ChildProcess);

		try {
			using client = new RpcClient({ cliPath: MOCK_AGENT });
			const closureSeen = Promise.withResolvers<void>();
			client.onSessionEvent(event => {
				if (event.type === "agent_end" && event.closureRejected) closureSeen.resolve();
			});
			await client.start();
			await client.prompt("predecessor A");
			await closureSeen.promise;
			failNextFlush = true;
			const rejected = client.steer("successor B");
			const idle = client.waitForIdle(500);
			void idle.catch(() => {});

			await expect(rejected).rejects.toThrow("flush failed");
			await expect(idle).rejects.toThrow("Completion rejected");
		} finally {
			spawn.mockRestore();
		}
	});

	test("concurrent start calls spawn one worker and reject the other", async () => {
		const exited = Promise.withResolvers<number>();
		let spawnCount = 0;
		const child = {
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			stdin: { write: () => 0, flush: () => 0 },
			exited: exited.promise,
			peekStderr: () => "",
			kill() {
				exited.resolve(0);
			},
		};
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => {
			spawnCount += 1;
			return child as unknown as ChildProcess;
		});

		try {
			using client = new RpcClient({ cliPath: MOCK_AGENT });
			const starts = await Promise.allSettled([client.start(), client.start()]);
			expect(spawnCount).toBe(1);
			expect(starts).toContainEqual({ status: "fulfilled", value: undefined });
			expect(starts).toContainEqual({
				status: "rejected",
				reason: expect.objectContaining({ message: "Client already started" }),
			});
			await client.stop();
		} finally {
			spawn.mockRestore();
		}
	});

	test("stop cancels a start waiting to reap before it can spawn", async () => {
		const exited = Promise.withResolvers<number>();
		let spawnCount = 0;
		const child = {
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
				},
			}),
			stdin: { write: () => 0, flush: () => 0 },
			exited: exited.promise,
			peekStderr: () => "",
			kill() {},
		};
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => {
			spawnCount += 1;
			return child as unknown as ChildProcess;
		});

		try {
			using client = new RpcClient({ cliPath: MOCK_AGENT });
			await client.start();
			const firstStop = client.stop();
			const pendingStart = client.start();
			await Promise.resolve();
			const cancelledStop = client.stop();
			exited.resolve(0);
			await Promise.all([firstStop, cancelledStop]);
			await expect(pendingStart).rejects.toThrow("Client start cancelled");
			expect(spawnCount).toBe(1);
		} finally {
			spawn.mockRestore();
		}
	});

	test("start() waits for a signal-ignoring worker to be reaped after stop()", async () => {
		using tempDir = TempDir.createSync("@omp-rpc-stop-restart-");
		const pidFile = tempDir.join("pid");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_PID_FILE: pidFile,
				MOCK_RPC_IGNORE_SIGTERM: process.platform === "win32" ? "0" : "1",
			},
			terminationGraceMs: 10,
		});

		await client.start();
		const firstPid = Number(await Bun.file(pidFile).text());

		const stopped = client.stop();
		const restarted = client.start();
		await Promise.all([stopped, restarted]);

		const secondPid = Number(await Bun.file(pidFile).text());
		expect(secondPid).not.toBe(firstPid);
		expect(isProcessAlive(firstPid)).toBe(false);
		await client.stop();
	}, 20_000);

	test("start() may be retried after a failed start (child is cleaned up on failure)", async () => {
		const env: Record<string, string> = {
			MOCK_RPC_EXIT_BEFORE_READY: "17",
			MOCK_RPC_EXIT_STDERR: "fixture startup failed",
		};
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env,
			terminationGraceMs: 10,
		});

		await expect(client.start()).rejects.toThrow("fixture startup failed");

		// Before the fix, #process stayed set after the failed spawn so the
		// second start() rejected with "Client already started". A successful
		// retry proves both the child and the client lifecycle state were reset.
		delete env.MOCK_RPC_EXIT_BEFORE_READY;
		await client.start();
		await client.stop();
	}, 10_000);

	test("stop() rejects active requests instead of leaving them to time out", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_IGNORE_COMMANDS: "1" },
		});
		await client.start();

		const pending = client.getState();
		client.stop();

		await expect(pending).rejects.toThrow("Client stopped");
	});

	test("rejects queued replacements from a stopped worker before restarting", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_HOLD_SESSION_REPLACEMENT: "1" },
		});
		await client.start();
		const first = client.newSession();
		const queued = client.switchSession("/tmp/queued.jsonl");
		void first.catch(() => {});
		void queued.catch(() => {});

		await client.stop();
		await expect(first).rejects.toThrow("Client stopped");
		await expect(queued).rejects.toThrow("Client stopped");
		await client.start();
		await expect(client.getState()).resolves.toMatchObject({ fastModeEnabled: false, fastModeActive: false });
	}, 20_000);

	test("does not send a queued old replacement to a restarted worker after output failure", async () => {
		const encoder = new TextEncoder();
		const firstExit = Promise.withResolvers<number>();
		const secondExit = Promise.withResolvers<number>();
		const commands: Array<{ worker: number; type: string }> = [];
		let spawnCount = 0;
		let restarted: Promise<void> | undefined;
		let client: RpcClient;
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => {
			const worker = ++spawnCount;
			let output!: ReadableStreamDefaultController<Uint8Array>;
			return {
				stdout: new ReadableStream<Uint8Array>({
					start(controller) {
						output = controller;
						controller.enqueue(encoder.encode(`${JSON.stringify({ type: "ready" })}\n`));
					},
				}),
				stdin: {
					write(raw: string) {
						const frame = JSON.parse(raw) as { id?: unknown; type?: unknown };
						const type = typeof frame.type === "string" ? frame.type : "";
						commands.push({ worker, type });
						if (worker === 1) {
							output.enqueue(encoder.encode("{invalid-json\n"));
						} else {
							output.enqueue(
								encoder.encode(
									`${JSON.stringify({ id: frame.id, type: "response", command: type, success: true, data: {} })}\n`,
								),
							);
						}
						return 0;
					},
					flush() {
						return 0;
					},
				},
				exited: worker === 1 ? firstExit.promise : secondExit.promise,
				peekStderr() {
					return "";
				},
				kill() {
					if (worker === 1) {
						restarted ??= client.start();
						void restarted.catch(() => {});
						firstExit.resolve(0);
					} else secondExit.resolve(0);
				},
			} as unknown as ChildProcess;
		});

		try {
			client = new RpcClient({ cliPath: MOCK_AGENT });
			using activeClient = client;
			await activeClient.start();
			const first = activeClient.newSession();
			const queued = activeClient.switchSession("/tmp/queued.jsonl");
			void first.catch(() => {});
			void queued.catch(() => {});

			await expect(first).rejects.toThrow(/Agent output reader failed/);
			await expect(queued).rejects.toThrow(/Agent output reader failed/);
			await restarted;
			await activeClient.getState();
			expect(commands).toEqual([
				{ worker: 1, type: "new_session" },
				{ worker: 2, type: "get_state" },
			]);
		} finally {
			spawn.mockRestore();
		}
	}, 5_000);

	test("rejects pending requests and reaps the worker when stdout parsing fails", async () => {
		// This awaits the real child-process grace-to-hard-kill path; fake timers
		// cannot drive OS signal delivery or process reaping.
		using tempDir = TempDir.createSync("@omp-rpc-reader-failure-");
		const pidFile = tempDir.join("pid");
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_PID_FILE: pidFile,
				MOCK_RPC_INVALID_OUTPUT: "1",
				MOCK_RPC_IGNORE_SIGTERM: process.platform === "win32" ? "0" : "1",
			},
			terminationGraceMs: 10,
		});

		let pid = 0;
		try {
			await client.start();
			pid = Number(await Bun.file(pidFile).text());
			const collector = client.collectEvents();
			void collector.catch(() => {});

			await expect(client.getState()).rejects.toThrow(/Agent output reader failed/);
			await expect(collector).rejects.toThrow(/Agent output reader failed/);
			await expect(client.getState()).rejects.toThrow("Client not started");
			expect(isProcessAlive(pid)).toBe(false);
		} finally {
			if (pid > 0 && isProcessAlive(pid)) process.kill(pid, "SIGKILL");
		}
	}, 10_000);

	test("rejects pending requests and reaps a worker that closes stdout without exiting", async () => {
		let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
		let resolveExit: ((exitCode: number) => void) | undefined;
		let killCalls = 0;
		const exited = new Promise<number>(resolve => {
			resolveExit = resolve;
		});
		const stdout = new ReadableStream<Uint8Array>({
			start(controller) {
				stdoutController = controller;
				controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "ready" })}\n`));
			},
		});
		const fakeChild = {
			stdout,
			stdin: {
				write() {
					stdoutController?.close();
					stdoutController = undefined;
					return 0;
				},
				flush() {
					return 0;
				},
			},
			exited,
			peekStderr() {
				return "";
			},
			kill() {
				killCalls += 1;
				resolveExit?.(0);
			},
		};
		const spawn = spyOn(ptree, "spawn").mockImplementation(
			() => fakeChild as unknown as ReturnType<typeof ptree.spawn>,
		);

		try {
			using client = new RpcClient({ cliPath: MOCK_AGENT });
			await client.start();

			await expect(client.getState()).rejects.toThrow("Agent output stream ended unexpectedly");
			await expect(client.getState()).rejects.toThrow("Client not started");
			expect(killCalls).toBe(1);
		} finally {
			spawn.mockRestore();
		}
	}, 5_000);

	test("reports exit code and stderr when a ready worker exits", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: {
				MOCK_RPC_EXIT_ON_COMMAND: "23",
				MOCK_RPC_EXIT_STDERR: "fixture worker failed",
			},
		});
		await client.start();

		await expect(client.getState()).rejects.toThrow(
			"Agent process exited with code 23. Stderr: fixture worker failed",
		);
	});

	test("start() rejects instead of hanging when a pre-ready worker closes stdout and never exits", async () => {
		// The worker outlives its own stdout, so start() cannot learn an exit code
		// and must still fail: it waits a bounded time for the exit, then reports
		// the stream end. A regression stalls until the 30s ready timeout, which
		// this test's own timeout catches.
		let resolveExit: ((exitCode: number) => void) | undefined;
		let killCalls = 0;
		const fakeChild = {
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			stdin: { write: () => 0, flush: () => 0 },
			exited: new Promise<number>(resolve => {
				resolveExit = resolve;
			}),
			peekStderr: () => "worker went quiet",
			kill() {
				killCalls += 1;
				resolveExit?.(0);
			},
		};
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => fakeChild as unknown as ChildProcess);

		try {
			using client = new RpcClient({ cliPath: MOCK_AGENT, terminationGraceMs: 10 });
			await expect(client.start()).rejects.toThrow(
				"Agent output stream ended before ready. Stderr: worker went quiet",
			);
			// The failed start must also reap the orphan rather than leak it.
			expect(killCalls).toBe(1);
		} finally {
			spawn.mockRestore();
		}
	}, 5_000);
});
