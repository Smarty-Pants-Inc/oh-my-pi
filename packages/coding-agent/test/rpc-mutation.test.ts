import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	dispatchRpcCanonicalCommand,
	dispatchRpcInputFrame,
	executeRpcForkMutation,
	RpcInputDispatcher,
} from "../src/modes/rpc/rpc-mode";
import { fingerprintRpcMutation, RpcMutationLedger } from "../src/modes/rpc/rpc-mutation";
import {
	isRpcMutationCommand,
	RPC_COMMAND_CLASSIFICATION,
	type RpcCommand,
	type RpcMutationCommand,
	type RpcMutationContext,
	type RpcResponse,
} from "../src/modes/rpc/rpc-types";
import type { AgentSession } from "../src/session/agent-session";

function promptCommand(message = "secret prompt body"): Extract<RpcMutationCommand, { type: "prompt" }> {
	return {
		id: "request-1",
		type: "prompt",
		message,
		mutation: { commandId: "authority-command-1", runtimeId: "runtime-1", generation: 4 },
	};
}

function abortCommand(): Extract<RpcMutationCommand, { type: "abort" }> {
	return {
		id: "request-abort",
		type: "abort",
		mutation: { commandId: "authority-command-abort", runtimeId: "runtime-1", generation: 4 },
	};
}

function withoutReplayIdentity(response: RpcResponse): unknown {
	const { id: _id, receipt, ...rest } = response;
	if (!receipt) return rest;
	const { replayed: _replayed, ...stableReceipt } = receipt;
	return { ...rest, receipt: stableReceipt };
}

async function withLedgerDb(run: (dbPath: string) => Promise<void>): Promise<void> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-mutations-"));
	try {
		await run(path.join(tempRoot, "mutations.sqlite"));
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

it("classifies every RPC command discriminator from one exhaustive table", () => {
	type MissingMutationContext = Exclude<RpcMutationCommand, { mutation?: RpcMutationContext }>;
	const mutationContextCoverage: MissingMutationContext extends never ? true : false = true;
	expect(mutationContextCoverage).toBe(true);
	for (const [type, classification] of Object.entries(RPC_COMMAND_CLASSIFICATION)) {
		expect(isRpcMutationCommand({ type } as RpcCommand)).toBe(classification === "mutation");
	}
});

it("includes prompt tool choice in durable fingerprints", () => {
	const prompt = promptCommand();
	expect(fingerprintRpcMutation({ ...prompt, toolChoice: "bash" })).not.toBe(
		fingerprintRpcMutation({ ...prompt, toolChoice: "write" }),
	);
});

it("includes the exact fork entry in durable fingerprints", () => {
	const fork: Extract<RpcMutationCommand, { type: "fork" }> = {
		type: "fork",
		entryId: "entry-a",
		mutation: { commandId: "authority-fork", runtimeId: "runtime-1", generation: 1 },
	};
	expect(fingerprintRpcMutation(fork)).not.toBe(fingerprintRpcMutation({ ...fork, entryId: "entry-b" }));
});

describe("RpcMutationLedger", () => {
	it("creates private ledger storage including SQLite sidecar files", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-ledger-permissions-"));
		const ledgerDir = path.join(tempRoot, "rpc");
		const dbPath = path.join(ledgerDir, "mutations.sqlite");
		await fs.mkdir(ledgerDir, { mode: 0o755 });
		const ledger = new RpcMutationLedger(dbPath);
		try {
			expect((await fs.stat(ledgerDir)).mode & 0o777).toBe(0o700);
			for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
				expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
			}
		} finally {
			ledger.close();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("replays the terminal response and rejects a command-id fingerprint collision", async () => {
		await withLedgerDb(async dbPath => {
			let executions = 0;
			const command = promptCommand();
			const execute = async (): Promise<RpcResponse> => {
				executions++;
				return {
					id: command.id,
					type: "response",
					command: "prompt",
					success: true,
					data: { agentInvoked: true },
				};
			};
			const firstLedger = new RpcMutationLedger(dbPath);
			const first = await firstLedger.execute(command, () => "session-1", execute);
			firstLedger.close();
			expect(first).toMatchObject({ success: true, receipt: { replayed: false, operation: "prompt" } });

			const secondLedger = new RpcMutationLedger(dbPath);
			const replay = await secondLedger.execute({ ...command, id: "request-2" }, () => "session-1", execute);
			const collision = await secondLedger.execute(promptCommand("different body"), () => "session-1", execute);
			secondLedger.close();
			expect(executions).toBe(1);
			expect(replay).toMatchObject({ id: "request-2", success: true, receipt: { replayed: true } });
			expect(collision).toMatchObject({ success: false, code: "protocol-error" });

			const db = new Database(dbPath, { readonly: true });
			const stored = db
				.query<{ fingerprint: string; outcome_json: string }, []>(
					"SELECT fingerprint, outcome_json FROM rpc_mutations",
				)
				.get();
			db.close();
			expect(stored?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
			expect(stored?.outcome_json).not.toContain(command.message);
		});
	});

	it("replays a terminal response larger than 64 KiB without stranding the mutation", async () => {
		await withLedgerDb(async dbPath => {
			const command = abortCommand();
			const payload = "x".repeat(128 * 1024);
			let executions = 0;
			const ledger = new RpcMutationLedger(dbPath);
			const first = await ledger.execute(
				command,
				() => "session-1",
				async () => {
					executions++;
					return {
						id: command.id,
						type: "response",
						command: "abort",
						success: true,
						data: { payload },
					} as RpcResponse;
				},
			);
			const replay = await ledger.execute(
				{ ...command, id: "large-replay" },
				() => "session-1",
				async () => {
					throw new Error("must not execute");
				},
			);
			ledger.close();
			expect(executions).toBe(1);
			expect(first).toMatchObject({ success: true, receipt: { replayed: false } });
			expect(replay).toMatchObject({ id: "large-replay", success: true, receipt: { replayed: true } });
			if (!("data" in replay)) throw new Error("Expected replay data");
			expect(replay.data as unknown).toEqual({ payload });
		});
	});

	it("redacts prompt text from a durable rejected outcome", async () => {
		await withLedgerDb(async dbPath => {
			const command = promptCommand("secret rejected prompt");
			const ledger = new RpcMutationLedger(dbPath);
			const first = await ledger.execute(
				command,
				() => "session-1",
				async () => {
					throw new Error(`provider rejected: ${command.message}`);
				},
			);
			const replay = await ledger.execute(
				{ ...command, id: "request-2" },
				() => "session-1",
				async () => {
					throw new Error("must not execute");
				},
			);
			ledger.close();
			expect(first).toMatchObject({
				success: false,
				code: "operation-error",
				error: "Prompt mutation was rejected",
				receipt: { replayed: false },
			});
			expect(replay).toMatchObject({
				success: false,
				error: "Prompt mutation was rejected",
				receipt: { replayed: true },
			});
			expect(withoutReplayIdentity(first)).toEqual(withoutReplayIdentity(replay));
			const db = new Database(dbPath, { readonly: true });
			const row = db.query<{ outcome_json: string }, []>("SELECT outcome_json FROM rpc_mutations").get();
			db.close();
			expect(row?.outcome_json).not.toContain(command.message);
		});
	});

	it("waits for a matching in-process mutation instead of reporting it ambiguous or executing twice", async () => {
		await withLedgerDb(async dbPath => {
			const ledger = new RpcMutationLedger(dbPath);
			const command = promptCommand();
			const gate = Promise.withResolvers<void>();
			let executions = 0;
			const firstPromise = ledger.execute(
				command,
				() => "session-1",
				async () => {
					executions++;
					await gate.promise;
					return {
						id: command.id,
						type: "response",
						command: "prompt",
						success: true,
						data: { agentInvoked: true },
					};
				},
			);
			await Promise.resolve();
			const retryPromise = ledger.execute(
				{ ...command, id: "request-concurrent" },
				() => "session-1",
				async () => {
					throw new Error("must not execute");
				},
			);
			gate.resolve();
			const [first, retry] = await Promise.all([firstPromise, retryPromise]);
			ledger.close();
			expect(executions).toBe(1);
			expect(first).toMatchObject({ receipt: { replayed: false } });
			expect(retry).toMatchObject({ id: "request-concurrent", receipt: { replayed: true } });
			expect(withoutReplayIdentity(first)).toEqual(withoutReplayIdentity(retry));
		});
	});

	it("returns ambiguous for an intent whose terminal outcome was lost and never re-executes", async () => {
		await withLedgerDb(async dbPath => {
			let executions = 0;
			const command = abortCommand();
			const firstLedger = new RpcMutationLedger(dbPath);
			await firstLedger.execute(
				command,
				() => "session-1",
				async () => {
					executions++;
					return { id: command.id, type: "response", command: "abort", success: true };
				},
			);
			firstLedger.close();

			const db = new Database(dbPath);
			db.run("UPDATE rpc_mutations SET outcome_json = NULL, completed_at = NULL WHERE command_id = ?", [
				command.mutation!.commandId,
			]);
			db.close();
			const retryLedger = new RpcMutationLedger(dbPath);
			const retry = await retryLedger.execute(
				command,
				() => "session-1",
				async () => {
					executions++;
					return { id: command.id, type: "response", command: "abort", success: true };
				},
			);
			retryLedger.close();
			expect(executions).toBe(1);
			expect(retry).toMatchObject({ success: false, code: "ambiguous" });
			expect("receipt" in retry).toBe(false);
		});
	});

	it("rejects a missing exact fork entry before recording mutation intent", async () => {
		await withLedgerDb(async dbPath => {
			const ledger = new RpcMutationLedger(dbPath);
			let executions = 0;
			const command: Extract<RpcMutationCommand, { type: "fork" }> = {
				id: "fork-missing",
				type: "fork",
				entryId: "missing-entry",
				mutation: { commandId: "authority-fork-missing", runtimeId: "runtime-1", generation: 1 },
			};
			const session = {
				sessionId: "session-parent",
				sessionManager: { getEntry: () => undefined },
			} as unknown as AgentSession;
			const response = await dispatchRpcCanonicalCommand(session, command, ledger, async () => {
				executions++;
				return {
					id: command.id,
					type: "response",
					command: "fork",
					success: true,
					data: { sessionId: "session-parent", cancelled: false },
				};
			});
			expect(response).toMatchObject({ success: false, code: "not-found" });
			expect(executions).toBe(0);
			ledger.close();
			const db = new Database(dbPath, { readonly: true });
			const row = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM rpc_mutations").get();
			db.close();
			expect(row?.count).toBe(0);
		});
	});

	it("calls canonical fork at the exact entry once across replay and rejects entry collisions", async () => {
		await withLedgerDb(async dbPath => {
			let sessionId = "session-parent";
			let forkCalls = 0;
			const entries: Array<string | undefined> = [];
			const session = {
				get sessionId() {
					return sessionId;
				},
				sessionManager: { getEntry: (entryId: string) => ({ id: entryId }) },
				async fork(
					deferSessionChange?: (publish: () => void | Promise<void>) => void,
					options?: { entryId?: string },
				) {
					forkCalls++;
					entries.push(options?.entryId);
					sessionId = "session-child";
					deferSessionChange?.(() => {});
					return true;
				},
			} as AgentSession;
			const command: Extract<RpcMutationCommand, { type: "fork" }> = {
				id: "fork-request-1",
				type: "fork",
				entryId: "entry-a",
				mutation: { commandId: "authority-fork-1", runtimeId: "runtime-1", generation: 4 },
			};
			const firstLedger = new RpcMutationLedger(dbPath);
			const first = await executeRpcForkMutation(session, command, firstLedger);
			firstLedger.close();
			const secondLedger = new RpcMutationLedger(dbPath);
			const replay = await executeRpcForkMutation(session, { ...command, id: "fork-request-2" }, secondLedger);
			const collision = await executeRpcForkMutation(
				session,
				{ ...command, id: "fork-request-3", entryId: "entry-b" },
				secondLedger,
			);
			secondLedger.close();
			expect(forkCalls).toBe(1);
			expect(entries).toEqual(["entry-a"]);
			expect(first.response).toMatchObject({
				data: { sessionId: "session-child", cancelled: false },
				receipt: { replayed: false },
			});
			expect(replay.response).toMatchObject({
				id: "fork-request-2",
				data: { sessionId: "session-child" },
				receipt: { replayed: true },
			});
			expect(collision.response).toMatchObject({ success: false, code: "protocol-error" });
		});
	});

	it("lets provenanced streaming prompts overtake an active prompt while ordinary prompts remain serialized", async () => {
		await withLedgerDb(async dbPath => {
			const ledger = new RpcMutationLedger(dbPath);
			const activeStarted = Promise.withResolvers<void>();
			const releaseActive = Promise.withResolvers<void>();
			const durableOutputs = Promise.withResolvers<void>();
			const outputs: RpcResponse[] = [];
			let ordinaryStarted = false;
			const dispatcher = new RpcInputDispatcher({
				deps: {
					handleCommand: async command => {
						if (command.type !== "prompt") throw new Error(`Unexpected command: ${command.type}`);
						if (command.mutation) {
							return ledger.execute(
								command,
								() => "session-1",
								async () => {
									if (command.message === "active") {
										activeStarted.resolve();
										await releaseActive.promise;
									}
									return {
										id: command.id,
										type: "response",
										command: "prompt",
										success: true,
										data: { agentInvoked: true },
									};
								},
							);
						}
						ordinaryStarted = true;
						return { id: command.id, type: "response", command: "prompt", success: true };
					},
					output: value => {
						const response = value as RpcResponse;
						outputs.push(response);
						if (outputs.filter(output => output.receipt).length === 2) durableOutputs.resolve();
					},
					errorResponse: (id, command, message) => ({
						id,
						type: "response",
						command,
						success: false,
						error: message,
					}),
					pendingExtensionRequests: new Map(),
					onHostToolResult: () => {},
					onHostToolUpdate: () => {},
					onHostUriResult: () => {},
				},
			});

			dispatcher.dispatch({
				id: "active",
				type: "prompt",
				message: "active",
				mutation: { commandId: "authority-active", runtimeId: "runtime-1", generation: 1 },
			});
			await activeStarted.promise;
			for (const [index, streamingBehavior] of (["steer", "followUp"] as const).entries()) {
				dispatcher.dispatch({
					id: `durable-${index}`,
					type: "prompt",
					message: streamingBehavior,
					streamingBehavior,
					mutation: {
						commandId: `authority-streaming-${index}`,
						runtimeId: "runtime-1",
						generation: 1,
					},
				});
			}
			dispatcher.dispatch({ id: "ordinary", type: "prompt", message: "ordinary" });
			await durableOutputs.promise;
			expect(ordinaryStarted).toBe(false);
			expect(outputs.filter(output => output.receipt).map(output => output.receipt?.operation)).toEqual([
				"prompt",
				"prompt",
			]);

			releaseActive.resolve();
			await dispatcher.drain();
			expect(ordinaryStarted).toBe(true);
			ledger.close();
		});
	});

	it("persists and flushes a fork response before publishing the session rebind", async () => {
		await withLedgerDb(async dbPath => {
			const ledger = new RpcMutationLedger(dbPath);
			const responseStarted = Promise.withResolvers<void>();
			const releaseFlush = Promise.withResolvers<void>();
			const order: string[] = [];
			let sessionId = "session-parent";
			const session = {
				get sessionId() {
					return sessionId;
				},
				async fork(deferSessionChange?: (publish: () => void | Promise<void>) => void) {
					sessionId = "session-child";
					deferSessionChange?.(() => {
						order.push("rebind");
					});
					return true;
				},
			} as AgentSession;
			const authorityCommandId = "authority-fork-order";
			const command: Extract<RpcMutationCommand, { type: "fork" }> = {
				id: "fork-order",
				type: "fork",
				mutation: { commandId: authorityCommandId, runtimeId: "runtime-1", generation: 1 },
			};
			const dispatched = dispatchRpcInputFrame(command, {
				handleCommand: request => executeRpcForkMutation(session, request as typeof command, ledger),
				output: async () => {
					const db = new Database(dbPath, { readonly: true });
					const row = db
						.query<{ outcome_json: string | null }, [string]>(
							"SELECT outcome_json FROM rpc_mutations WHERE command_id = ?",
						)
						.get(authorityCommandId);
					db.close();
					expect(row?.outcome_json).not.toBeNull();
					order.push("response-write");
					responseStarted.resolve();
					await releaseFlush.promise;
					order.push("response-flush");
				},
				errorResponse: (id, responseCommand, message) => ({
					id,
					type: "response",
					command: responseCommand,
					success: false,
					error: message,
				}),
				pendingExtensionRequests: new Map(),
				onHostToolResult: () => {},
				onHostToolUpdate: () => {},
				onHostUriResult: () => {},
			});
			if (!dispatched) throw new Error("Expected fork dispatch promise");
			await responseStarted.promise;
			expect(order).toEqual(["response-write"]);
			releaseFlush.resolve();
			await dispatched;
			expect(order).toEqual(["response-write", "response-flush", "rebind"]);
			ledger.close();
		});
	});
});
