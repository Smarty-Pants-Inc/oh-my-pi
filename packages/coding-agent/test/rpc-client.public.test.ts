import { describe, expect, spyOn, test } from "bun:test";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { Participant, RpcHerdrAgentdHostBridge } from "@oh-my-pi/pi-coding-agent/rpc";
import { type ChildProcess, ptree } from "@oh-my-pi/pi-utils";

const HOST_PARTICIPANT: Participant = { name: "owner", role: "host" };

interface RpcChildControl {
	closeOutput?: () => void;
	exit?: (code: number) => void;
	writeFailureCommand?: string;
	flushFailureCommand?: string;
	failureMessage?: string;
	emitFrame?: (frame: Record<string, unknown>) => void;
	flushGate?: Promise<void>;
}

function createRpcChild(
	received: Array<Record<string, unknown>>,
	control?: RpcChildControl,
	capabilities: string[] = ["mutation-receipts"],
): ChildProcess {
	let lastCommand: Record<string, unknown> | undefined;
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let resolveExit: ((exitCode: number) => void) | undefined;
	const closeOutput = (): void => {
		const activeController = controller;
		controller = undefined;
		activeController?.close();
	};
	const writeFrame = (frame: Record<string, unknown>): void => {
		controller?.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`));
	};
	const stdout = new ReadableStream<Uint8Array>({
		start(nextController) {
			controller = nextController;
			writeFrame({
				type: "ready",
				protocolVersion: 1,
				supportedProtocolVersions: [1, 2],
				maxFrameBytes: 1,
				maxReassembledFrameBytes: 1,
				buildId: "test-rpc-client",
				version: "test",
				capabilities,
				participant: HOST_PARTICIPANT,
			});
		},
	});
	const child = {
		stdout,
		stdin: {
			write(input: string) {
				const command = JSON.parse(input) as Record<string, unknown>;
				received.push(command);
				lastCommand = command;
				if (control?.writeFailureCommand === command.type)
					throw new Error(control?.failureMessage ?? "synthetic write failure");
				if (control?.flushFailureCommand === command.type) return input.length;
				if (command.type === "collab_ui_response") {
					if (command.mutation && typeof command.mutation === "object") {
						const mutation = command.mutation as { commandId: string; runtimeId: string; generation: number };
						writeFrame({
							id: command.id,
							type: "response",
							command: "collab_ui_response",
							success: true,
							receipt: {
								...mutation,
								owner: "omp",
								operation: "collab_ui_response",
								fingerprint: "b".repeat(64),
								replayed: false,
								session: { status: "completed", sessionId: "session-parent" },
							},
						});
					} else {
						writeFrame({
							id: command.id,
							type: "response",
							command: "collab_ui_response",
							success: false,
							error: "UI request is no longer pending",
							code: "not-found",
						});
					}
				} else if (command.type === "prompt" && command.mutation !== undefined) {
					writeFrame({ type: "collab_terminal", code: "unavailable", reason: "authoritative host closed" });
				} else if (command.type === "fork" && command.mutation && typeof command.mutation === "object") {
					const mutation = command.mutation as { commandId: string; runtimeId: string; generation: number };
					writeFrame({
						id: command.id,
						type: "response",
						command: "fork",
						success: true,
						data: { sessionId: "session-child", cancelled: false },
						receipt: {
							...mutation,
							owner: "omp",
							operation: "fork",
							fingerprint: "a".repeat(64),
							replayed: false,
							session: {
								status: "completed",
								sessionId: "session-child",
								previousSessionId: "session-parent",
							},
						},
					});
				} else {
					writeFrame({
						id: command.id,
						type: "response",
						command: command.type,
						success: true,
						data: {},
					});
				}
				return input.length;
			},
			flush() {
				if (control?.flushFailureCommand === lastCommand?.type)
					return Promise.reject(new Error(control?.failureMessage ?? "synthetic flush failure"));
				return control?.flushGate ?? 0;
			},
		},
		exited: new Promise<number>(resolve => {
			resolveExit = resolve;
		}),
		peekStderr() {
			return "";
		},
		kill() {
			closeOutput();
			resolveExit?.(0);
		},
	};
	if (control) {
		control.closeOutput = closeOutput;
		control.exit = code => resolveExit?.(code);
		control.emitFrame = writeFrame;
	}
	return child as unknown as ChildProcess;
}

describe("RpcClient public launch and request seams", () => {
	test("launches a supplied binary and hidden RPC guest command without adding a second RPC mode", async () => {
		const received: Array<Record<string, unknown>> = [];
		const launched: string[][] = [];
		const spawn = spyOn(ptree, "spawn").mockImplementation(command => {
			launched.push([...command]);
			return createRpcChild(received);
		});

		try {
			using client = new RpcClient({
				launchCommand: ["/opt/omp", "__collab-rpc-guest", "ws://collab.test", "room-1", "--token-env"],
				provider: "provider-1",
				model: "model-1",
				sessionDir: "/sessions/one",
				args: ["--no-color"],
			});
			await client.start();
			await client.stop();

			expect(launched).toEqual([
				[
					"/opt/omp",
					"__collab-rpc-guest",
					"ws://collab.test",
					"room-1",
					"--token-env",
					"--provider",
					"provider-1",
					"--model",
					"model-1",
					"--session-dir",
					"/sessions/one",
					"--no-color",
				],
			]);
		} finally {
			spawn.mockRestore();
		}
	});

	test("keeps the default Bun CLI launch argv byte-for-byte compatible", async () => {
		const received: Array<Record<string, unknown>> = [];
		const launched: string[][] = [];
		const spawn = spyOn(ptree, "spawn").mockImplementation(command => {
			launched.push([...command]);
			return createRpcChild(received);
		});

		try {
			using client = new RpcClient({
				cliPath: "/repo/dist/cli.js",
				provider: "provider-1",
				model: "model-1",
				sessionDir: "/sessions/one",
				args: ["--no-color"],
			});
			await client.start();
			await client.stop();

			expect(launched).toEqual([
				[
					"bun",
					"/repo/dist/cli.js",
					"--mode",
					"rpc",
					"--provider",
					"provider-1",
					"--model",
					"model-1",
					"--session-dir",
					"/sessions/one",
					"--no-color",
				],
			]);
		} finally {
			spawn.mockRestore();
		}
	});

	test.skipIf(process.platform === "win32")(
		"selects the hidden agentd host composition with an already-redeemed direct tuple",
		async () => {
			const received: Array<Record<string, unknown>> = [];
			let launched: string[] | undefined;
			let environment: Record<string, string | undefined> | undefined;
			const spawn = spyOn(ptree, "spawn").mockImplementation((command, options) => {
				launched = [...command];
				environment = options?.env;
				return createRpcChild(received, undefined, ["mutation-receipts", "herdr-agentd-host"]);
			});

			try {
				const bridge: RpcHerdrAgentdHostBridge = {
					address: "127.0.0.1:43123",
					paneId: "pane-7",
					routeGeneration: 3,
					token: "initial-agentd-token",
				};
				using client = new RpcClient({
					cliPath: "/repo/dist/cli.js",
					herdrAgentdHost: bridge,
					env: {
						HERDR_SOCKET_PATH: "/legacy/discovery.sock",
						HERDR_OMP_BRIDGE: "must-not-cross",
						HERDR_OMP_BRIDGE_TOKEN: "must-not-cross",
						HERDR_OMP_GUEST_BRIDGE_TOKEN: "must-not-cross",
					},
				});
				await client.start();
				await client.stop();

				expect(launched).toEqual(["bun", "/repo/dist/cli.js", "__collab-rpc-host"]);
				expect(environment?.HERDR_OMP_BRIDGE).toBe(bridge.address);
				expect(environment?.HERDR_OMP_BRIDGE_TOKEN).toBe(bridge.token);
				expect(environment?.HERDR_PANE_ID).toBe("pane-7");
				expect(environment?.HERDR_OMP_ROUTE_GENERATION).toBe("3");
				expect(environment?.HERDR_SOCKET_PATH).toBeUndefined();
				expect(environment?.HERDR_OMP_GUEST_BRIDGE_TOKEN).toBeUndefined();
			} finally {
				spawn.mockRestore();
			}
		},
	);

	test("rejects an invalid agentd host address before spawning", async () => {
		const spawn = spyOn(ptree, "spawn");
		try {
			using client = new RpcClient({
				herdrAgentdHost: { address: "relative.sock", paneId: "pane-7", routeGeneration: 1, token: "token" },
			});
			await expect(client.start()).rejects.toThrow("address is invalid");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
		}
	});

	test("redacts the initial direct token from launch failures", async () => {
		const token = "initial-launch-secret";
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => {
			throw new Error(`launch failed with ${token}`, { cause: new Error(`nested launch failure with ${token}`) });
		});
		try {
			using client = new RpcClient({
				herdrAgentdHost: { address: "127.0.0.1:43123", paneId: "pane-7", routeGeneration: 1, token },
			});
			const starting = client.start();
			await expect(starting).rejects.toThrow("launch failed with [REDACTED]");
			await starting.catch(error => {
				if (!(error instanceof Error)) throw new Error("Expected an Error");
				expect(String(error)).not.toContain(token);
				expect(error.cause).toBeUndefined();
				expect(Bun.inspect(error)).not.toContain(token);
			});
		} finally {
			spawn.mockRestore();
		}
	});

	test("rejects an empty supplied launch command before spawning", async () => {
		const spawn = spyOn(ptree, "spawn");
		try {
			using client = new RpcClient({ launchCommand: [] });
			await expect(client.start()).rejects.toThrow("RpcClient launchCommand must contain a non-empty executable");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
		}
	});

	test("assigns transport request IDs and keeps a durable request pending after terminal unavailability", async () => {
		const received: Array<Record<string, unknown>> = [];
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => createRpcChild(received));

		try {
			using client = new RpcClient({ cliPath: "/repo/dist/cli.js" });
			await client.start();

			expect(await client.request({ type: "get_state" })).toMatchObject({
				id: "req_1",
				command: "get_state",
				success: true,
			});
			expect(await client.request({ type: "get_state" })).toMatchObject({
				id: "req_2",
				command: "get_state",
				success: true,
			});

			const unavailable = Promise.withResolvers<void>();
			client.onUnavailable(() => unavailable.resolve());
			const pending = client.request({
				type: "prompt",
				message: "retry-safe prompt",
				mutation: { commandId: "authority-1", runtimeId: "runtime-1", generation: 1 },
			});
			let settled = false;
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await unavailable.promise;

			expect(received.map(command => command.id)).toEqual(["req_1", "req_2", "req_3"]);
			expect(settled).toBe(false);
			const stopped = client.stop();
			await expect(pending).rejects.toMatchObject({ command: "prompt", code: "ambiguous" });
			await stopped;
		} finally {
			spawn.mockRestore();
		}
	});

	test("forwards advisor_yielded through session event listeners", async () => {
		const received: Array<Record<string, unknown>> = [];
		const control: RpcChildControl = {};
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => createRpcChild(received, control));

		try {
			using client = new RpcClient({ cliPath: "/repo/dist/cli.js" });
			const yielded = Promise.withResolvers<void>();
			const events: string[] = [];
			client.onSessionEvent(event => {
				events.push(event.type);
				if (event.type === "advisor_yielded") yielded.resolve();
			});
			await client.start();
			if (!control.emitFrame) throw new Error("Expected RPC child frame emitter");
			control.emitFrame({ type: "advisor_yielded" });
			await yielded.promise;

			expect(events).toEqual(["advisor_yielded"]);
			await client.stop();
		} finally {
			spawn.mockRestore();
		}
	});

	test("preserves legacy void mutation signatures and owns durable Collab UI responses", async () => {
		const received: Array<Record<string, unknown>> = [];
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => createRpcChild(received));

		try {
			using client = new RpcClient({ cliPath: "/repo/dist/cli.js" });
			await client.start();
			const promptResult: void = await client.prompt("legacy prompt", { streamingBehavior: "steer" });
			const abortResult: void = await client.abort();
			expect(promptResult).toBeUndefined();
			expect(abortResult).toBeUndefined();
			expect(received[0]).toMatchObject({ type: "prompt", streamingBehavior: "steer" });
			await expect(client.respondToCollabUi(42)).rejects.toMatchObject({
				command: "collab_ui_response",
				code: "not-found",
			});
			const mutation = { commandId: "authority-ui", runtimeId: "runtime-1", generation: 1 };
			const receipt = await client.respondToCollabUi(43, "authoritative answer", mutation);
			expect(receipt).toMatchObject({ ...mutation, owner: "omp", operation: "collab_ui_response" });
			expect(received.at(-1)).toMatchObject({
				type: "collab_ui_response",
				reqId: 43,
				value: "authoritative answer",
				mutation,
			});
		} finally {
			spawn.mockRestore();
		}
	});

	test("flushes dedicated Herdr rebind controls, rejects transport failures without exposing tokens, and requires agentd hosting", async () => {
		const received: Array<Record<string, unknown>> = [];
		const control: RpcChildControl = {};
		const spawn = spyOn(ptree, "spawn").mockImplementation(() =>
			createRpcChild(received, control, ["mutation-receipts", "herdr-agentd-host"]),
		);
		const token = "one-use-super-secret";

		try {
			using client = new RpcClient({ cliPath: "/repo/dist/cli.js" });
			await client.start();

			const flush = Promise.withResolvers<void>();
			control.flushGate = flush.promise;
			const prepare = client.prepareHerdrAgentdRebind({
				address: "/private/agentd/successor.sock",
				paneId: "pane-7",
				routeGeneration: 1,
				token,
			});
			const clear = client.clearHerdrAgentdRebind();
			let settled = 0;
			void prepare.then(() => settled++);
			void clear.then(() => settled++);
			await Promise.resolve();
			expect(settled).toBe(0);
			expect(received).toEqual([
				{
					type: "prepare_herdr_agentd_rebind",
					address: "/private/agentd/successor.sock",
					paneId: "pane-7",
					routeGeneration: 1,
					token,
				},
				{ type: "clear_herdr_agentd_rebind" },
			]);
			flush.resolve();
			await Promise.all([prepare, clear]);
			expect(settled).toBe(2);

			control.flushGate = undefined;
			control.flushFailureCommand = "prepare_herdr_agentd_rebind";
			control.failureMessage = `could not flush ${token}`;
			const failed = client.prepareHerdrAgentdRebind({
				address: "/private/agentd/successor.sock",
				paneId: "pane-7",
				routeGeneration: 1,
				token,
			});
			await expect(failed).rejects.toThrow("could not flush [REDACTED]");
			await failed.catch(error => expect(String(error)).not.toContain(token));

			control.flushFailureCommand = "clear_herdr_agentd_rebind";
			control.failureMessage = `synthetic clear failure ${token}`;
			await expect(client.clearHerdrAgentdRebind()).rejects.toThrow("synthetic clear failure [REDACTED]");
		} finally {
			spawn.mockRestore();
		}

		const plainReceived: Array<Record<string, unknown>> = [];
		const plainSpawn = spyOn(ptree, "spawn").mockImplementation(() => createRpcChild(plainReceived));
		try {
			using client = new RpcClient({ cliPath: "/repo/dist/cli.js" });
			await client.start();
			await expect(
				client.prepareHerdrAgentdRebind({
					address: "/private/agentd/successor.sock",
					paneId: "pane-7",
					routeGeneration: 1,
					token,
				}),
			).rejects.toMatchObject({ command: "prepare_herdr_agentd_rebind", code: "protocol-error" });
			expect(plainReceived).toEqual([]);
		} finally {
			plainSpawn.mockRestore();
		}
	});

	test("sidechannel APIs resolve only after flush and reject transport failures", async () => {
		const received: Array<Record<string, unknown>> = [];
		const control: RpcChildControl = {};
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => createRpcChild(received, control));

		try {
			using client = new RpcClient({ cliPath: "/repo/dist/cli.js" });
			await client.start();
			const uriRequest = Promise.withResolvers<string>();
			client.onHostUriRequest(request => uriRequest.resolve(request.id));
			control.emitFrame?.({
				type: "host_uri_request",
				id: "uri-delayed",
				operation: "read",
				url: "test://delayed",
			});
			await uriRequest.promise;

			const flush = Promise.withResolvers<void>();
			control.flushGate = flush.promise;
			const writes = [
				client.respondToExtensionUI({ type: "extension_ui_response", id: "ui-delayed", confirmed: true }),
				client.sendHostToolUpdate({
					type: "host_tool_update",
					id: "tool-update-delayed",
					partialResult: { content: [] },
				}),
				client.sendHostToolResult({
					type: "host_tool_result",
					id: "tool-result-delayed",
					result: { content: [] },
				}),
				client.sendHostUriResult({ type: "host_uri_result", id: "uri-delayed", content: "ok" }),
			];
			let settled = 0;
			for (const write of writes) void write.then(() => settled++);
			await Promise.resolve();
			expect(settled).toBe(0);
			flush.resolve();
			await Promise.all(writes);
			expect(settled).toBe(4);

			control.flushGate = undefined;
			const failures: Array<{ type: string; send: () => Promise<void> }> = [
				{
					type: "extension_ui_response",
					send: () =>
						client.respondToExtensionUI({ type: "extension_ui_response", id: "ui-failed", cancelled: true }),
				},
				{
					type: "host_tool_update",
					send: () =>
						client.sendHostToolUpdate({
							type: "host_tool_update",
							id: "tool-update-failed",
							partialResult: { content: [] },
						}),
				},
				{
					type: "host_tool_result",
					send: () =>
						client.sendHostToolResult({
							type: "host_tool_result",
							id: "tool-result-failed",
							result: { content: [] },
						}),
				},
			];
			for (const failure of failures) {
				control.flushFailureCommand = failure.type;
				await expect(failure.send()).rejects.toThrow("synthetic flush failure");
			}
			const failedUriRequest = Promise.withResolvers<void>();
			const unsubscribeFailedUri = client.onHostUriRequest(request => {
				if (request.id === "uri-failed") failedUriRequest.resolve();
			});
			control.emitFrame?.({
				type: "host_uri_request",
				id: "uri-failed",
				operation: "read",
				url: "test://failed",
			});
			await failedUriRequest.promise;
			unsubscribeFailedUri();
			control.flushFailureCommand = "host_uri_result";
			await expect(
				client.sendHostUriResult({ type: "host_uri_result", id: "uri-failed", content: "nope" }),
			).rejects.toThrow("synthetic flush failure");
		} finally {
			spawn.mockRestore();
		}
	});

	test("forks at an exact canonical entry without changing the legacy overloads", async () => {
		const received: Array<Record<string, unknown>> = [];
		const spawn = spyOn(ptree, "spawn").mockImplementation(() =>
			createRpcChild(received, undefined, ["mutation-receipts", "fork", "fork-entry"]),
		);
		try {
			using client = new RpcClient({ cliPath: "/repo/dist/cli.js" });
			await client.start();
			const mutation = { commandId: "authority-fork-entry", runtimeId: "runtime-1", generation: 1 };
			await expect(client.fork({ entryId: "entry-7", mutation })).resolves.toMatchObject({
				sessionId: "session-child",
				cancelled: false,
				receipt: { operation: "fork", commandId: mutation.commandId },
			});
			expect(received).toHaveLength(1);
			expect(received[0]).toMatchObject({ type: "fork", entryId: "entry-7", mutation });
		} finally {
			spawn.mockRestore();
		}
	});

	test("reports an in-flight durable mutation as ambiguous when stdout and the process disappear", async () => {
		const received: Array<Record<string, unknown>> = [];
		const control: RpcChildControl = {};
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => createRpcChild(received, control));

		try {
			using client = new RpcClient({ cliPath: "/repo/dist/cli.js" });
			await client.start();
			const pending = client.request({
				type: "prompt",
				message: "transport loss",
				mutation: { commandId: "authority-loss", runtimeId: "runtime-1", generation: 1 },
			});
			control.closeOutput?.();
			control.exit?.(9);
			await expect(pending).rejects.toMatchObject({ command: "prompt", code: "ambiguous" });
		} finally {
			spawn.mockRestore();
		}
	});

	test("rejects a provenanced mutation before dispatch when the ready frame lacks receipts", async () => {
		const received: Array<Record<string, unknown>> = [];
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => createRpcChild(received, undefined, []));

		try {
			using client = new RpcClient({ cliPath: "/repo/dist/cli.js" });
			await client.start();
			await expect(
				client.request({
					type: "prompt",
					message: "must not dispatch",
					mutation: { commandId: "authority-no-receipt", runtimeId: "runtime-1", generation: 1 },
				}),
			).rejects.toMatchObject({ command: "prompt", code: "protocol-error" });
			expect(received).toEqual([]);
		} finally {
			spawn.mockRestore();
		}
	});

	test("rejects local durable serialization failures before any bytes reach the agent", async () => {
		const received: Array<Record<string, unknown>> = [];
		const spawn = spyOn(ptree, "spawn").mockImplementation(() => createRpcChild(received));

		try {
			using client = new RpcClient({ cliPath: "/repo/dist/cli.js" });
			await client.start();
			const cyclic: { self?: unknown } = {};
			cyclic.self = cyclic;
			for (const [name, details] of [
				["bigint", 1n],
				["cycle", cyclic],
			] as const) {
				await expect(
					client.sendCustomMessage(
						{ customType: "local-serialization", content: "must not dispatch", display: false, details },
						{ commandId: `authority-${name}`, runtimeId: "runtime-1", generation: 1 },
					),
				).rejects.toMatchObject({ command: "custom_message", code: "protocol-error" });
			}
			expect(received).toEqual([]);
			await expect(client.request({ type: "get_state" })).resolves.toMatchObject({ success: true });
		} finally {
			spawn.mockRestore();
		}
	});

	test("reports durable write and flush failures as ambiguous without retaining pending requests", async () => {
		for (const failure of ["write", "flush"] as const) {
			const received: Array<Record<string, unknown>> = [];
			const control: RpcChildControl =
				failure === "write" ? { writeFailureCommand: "prompt" } : { flushFailureCommand: "prompt" };
			const spawn = spyOn(ptree, "spawn").mockImplementation(() => createRpcChild(received, control));

			try {
				using client = new RpcClient({ cliPath: "/repo/dist/cli.js" });
				await client.start();
				await expect(
					client.request({
						type: "prompt",
						message: "receipt recovery",
						mutation: { commandId: `authority-${failure}`, runtimeId: "runtime-1", generation: 1 },
					}),
				).rejects.toMatchObject({ command: "prompt", code: "ambiguous" });
				await expect(client.request({ type: "get_state" })).resolves.toMatchObject({ success: true });
			} finally {
				spawn.mockRestore();
			}
		}
	});
});
