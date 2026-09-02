import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	getRpcHistoryChunk,
	getRpcHistoryPage,
	getRpcHistorySnapshot,
	RpcHistoryError,
} from "../src/modes/rpc/rpc-history";
import { RpcMutationLedger } from "../src/modes/rpc/rpc-mutation";
import { executeRpcSessionDataCommand, validateRpcMutationBeforeIntent } from "../src/modes/rpc/rpc-session-data";
import type { RpcCommand, RpcMutationCommand, RpcResponse } from "../src/modes/rpc/rpc-types";
import type { AgentSession } from "../src/session/agent-session";
import { BlobStore } from "../src/session/blob-store";
import { SessionManager } from "../src/session/session-manager";

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("omp-rpc-session-data-");
});

afterEach(() => {
	tempDir.removeSync();
});

function mutation(commandId: string) {
	return { commandId, runtimeId: "runtime-1", generation: 1 };
}

function requireResponse(response: RpcResponse | undefined): RpcResponse {
	if (!response) throw new Error("Expected the parity adapter to handle the command");
	return response;
}

function fakeSession(value: object): AgentSession {
	return value as AgentSession;
}

describe("RPC artifact and blob adapters", () => {
	it("writes an ArtifactManager artifact exactly once across durable replay", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const session = fakeSession({ sessionManager: manager });
		const command: Extract<RpcMutationCommand, { type: "artifact_write" }> = {
			id: "artifact-request-1",
			type: "artifact_write",
			content: "durable artifact",
			toolType: "agentd",
			mutation: mutation("artifact-command-1"),
		};
		expect(validateRpcMutationBeforeIntent(session, command)).toBeUndefined();
		const ledger = new RpcMutationLedger(path.join(tempDir.path(), "artifact-mutations.sqlite"));
		let executions = 0;
		const execute = async (): Promise<RpcResponse> => {
			executions++;
			return requireResponse(await executeRpcSessionDataCommand(session, command));
		};
		try {
			const first = await ledger.execute(command, () => manager.getSessionId(), execute);
			const replay = await ledger.execute(
				{ ...command, id: "artifact-request-2" },
				() => manager.getSessionId(),
				execute,
			);
			expect(executions).toBe(1);
			expect(first).toMatchObject({
				success: true,
				data: { size: 16 },
				receipt: { operation: "artifact_write", replayed: false },
			});
			expect(replay).toMatchObject({ id: "artifact-request-2", receipt: { replayed: true } });
			const list = requireResponse(await executeRpcSessionDataCommand(session, { type: "artifact_list" }));
			expect(list).toMatchObject({ success: true, data: { artifacts: [{ size: 16 }] } });
			if (!list.success || list.command !== "artifact_list") throw new Error("Expected artifact list data");
			const artifact = list.data.artifacts[0];
			if (!artifact) throw new Error("Expected written artifact");
			const read = await executeRpcSessionDataCommand(session, {
				type: "artifact_read",
				artifactId: artifact.id,
			});
			expect(read).toMatchObject({ success: true, data: { content: "durable artifact", size: 16 } });
		} finally {
			ledger.close();
		}
	});

	it("rejects malformed artifact writes and non-canonical IDs before storage", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const session = fakeSession({ sessionManager: manager });
		const invalidWrite: Extract<RpcMutationCommand, { type: "artifact_write" }> = {
			type: "artifact_write",
			content: "\ud800",
			mutation: mutation("artifact-invalid"),
		};
		expect(validateRpcMutationBeforeIntent(session, invalidWrite)).toMatchObject({
			success: false,
			code: "protocol-error",
		});
		expect(await executeRpcSessionDataCommand(session, { type: "artifact_read", artifactId: "../1" })).toMatchObject({
			success: false,
			code: "protocol-error",
		});
	});

	it("validates and stores canonical content-addressed blobs exactly once", async () => {
		const blobsDir = path.join(tempDir.path(), "blobs");
		const store = new BlobStore(blobsDir);
		const put = spyOn(store, "put");
		const session = fakeSession({ sessionManager: { getBlobStore: () => store } });
		const data = Buffer.from("canonical blob");
		const hash = new Bun.SHA256().update(data).digest("hex");
		const command: Extract<RpcMutationCommand, { type: "blob_write" }> = {
			type: "blob_write",
			hash,
			size: data.byteLength,
			content: data.toString("base64"),
			mutation: mutation("blob-command-1"),
		};
		expect(validateRpcMutationBeforeIntent(session, command)).toBeUndefined();
		const ledger = new RpcMutationLedger(path.join(tempDir.path(), "blob-mutations.sqlite"));
		try {
			const first = await ledger.execute(
				command,
				() => "session-1",
				async () => requireResponse(await executeRpcSessionDataCommand(session, command)),
			);
			const replay = await ledger.execute(
				command,
				() => "session-1",
				async () => {
					throw new Error("must not execute");
				},
			);
			expect(put).toHaveBeenCalledTimes(1);
			expect(first).toMatchObject({ success: true, data: { hash, size: data.byteLength } });
			expect(replay).toMatchObject({ success: true, receipt: { replayed: true } });
			expect(await executeRpcSessionDataCommand(session, { type: "blob_list" })).toMatchObject({
				success: true,
				data: { blobs: [{ hash, size: data.byteLength }] },
			});
			expect(await executeRpcSessionDataCommand(session, { type: "blob_read", hash })).toMatchObject({
				success: true,
				data: { hash, size: data.byteLength, encoding: "base64", content: data.toString("base64") },
			});
		} finally {
			ledger.close();
			put.mockRestore();
		}
	});

	it("rejects hash and size mismatches before a blob mutation intent", () => {
		const store = new BlobStore(path.join(tempDir.path(), "blobs"));
		const session = fakeSession({ sessionManager: { getBlobStore: () => store } });
		const command: Extract<RpcMutationCommand, { type: "blob_write" }> = {
			type: "blob_write",
			hash: "0".repeat(64),
			size: 1,
			content: Buffer.from("different").toString("base64"),
			mutation: mutation("blob-invalid"),
		};
		expect(validateRpcMutationBeforeIntent(session, command)).toMatchObject({
			success: false,
			code: "protocol-error",
		});
	});
});

describe("RPC exact history", () => {
	it("preserves canonical order, detects stale cursors, and reconstructs the exact digest bytes", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const session = fakeSession({ sessionManager: manager, isStreaming: false, isCompacting: false });
		const snapshot = getRpcHistorySnapshot(session);
		expect(snapshot.entries).toEqual(manager.getEntries());
		expect(snapshot.branch).toEqual(manager.getBranch());
		const firstPage = getRpcHistoryPage(session, { limit: 1 });
		expect(firstPage.entries).toEqual([manager.getEntries()[0]]);
		expect(firstPage.nextCursor).toBeDefined();

		let cursor: string | undefined;
		const chunks: Buffer[] = [];
		do {
			const chunk = getRpcHistoryChunk(session, { cursor, limit: 32 });
			chunks.push(Buffer.from(chunk.data, "base64"));
			cursor = chunk.nextCursor;
		} while (cursor);
		const exactBytes = Buffer.concat(chunks);
		expect(new Bun.SHA256().update(exactBytes).digest("hex")).toBe(snapshot.digest.value);
		expect(JSON.parse(exactBytes.toString("utf8"))).toEqual({
			header: snapshot.header,
			entries: snapshot.entries,
			branch: snapshot.branch,
			leafId: snapshot.leafId,
		});

		manager.appendMessage({ role: "user", content: "changed", timestamp: 3 });
		expect(() => getRpcHistoryPage(session, { cursor: firstPage.nextCursor })).toThrow(RpcHistoryError);
	});

	it("rejects exact reads while the authoritative session is changing", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		const session = fakeSession({ sessionManager: manager, isStreaming: true, isCompacting: false });
		expect(() => getRpcHistorySnapshot(session)).toThrow(
			"Cannot inspect exact history while the session is changing",
		);
	});
});

describe("RPC generic custom messages and preflight validation", () => {
	it("injects an any-state generic custom message exactly once", async () => {
		const sent: Array<{ message: unknown; options: unknown }> = [];
		let flushes = 0;
		const session = fakeSession({
			sessionManager: {
				ensureOnDisk: async () => {
					flushes++;
				},
			},
			sendCustomMessage: async (message: unknown, options: unknown) => {
				sent.push({ message, options });
				return { status: "accepted", delivery: "plain_append" };
			},
		});
		const command: Extract<RpcMutationCommand, { type: "custom_message" }> = {
			type: "custom_message",
			customType: "agentd-context",
			content: "bounded context",
			display: false,
			details: { source: "gateway" },
			when: "any",
			mutation: mutation("custom-message-1"),
		};
		expect(validateRpcMutationBeforeIntent(session, command)).toBeUndefined();
		const ledger = new RpcMutationLedger(path.join(tempDir.path(), "custom-mutations.sqlite"));
		try {
			const first = await ledger.execute(
				command,
				() => "session-1",
				async () => requireResponse(await executeRpcSessionDataCommand(session, command)),
			);
			const replay = await ledger.execute(
				command,
				() => "session-1",
				async () => {
					throw new Error("must not execute");
				},
			);
			expect(sent).toEqual([
				{
					message: {
						customType: "agentd-context",
						content: "bounded context",
						display: false,
						details: { source: "gateway" },
					},
					options: { deliveryMode: "steer", when: "any" },
				},
			]);
			expect(first).toMatchObject({
				success: true,
				data: { accepted: true },
				receipt: { operation: "custom_message", replayed: false },
			});
			expect(replay).toMatchObject({ success: true, receipt: { replayed: true } });
			expect(flushes).toBe(1);
		} finally {
			ledger.close();
		}
	});

	it("durably rejects idle-only custom messages while busy without injection", async () => {
		let attempts = 0;
		const session = fakeSession({
			sessionManager: {
				ensureOnDisk: async () => {
					throw new Error("busy rejection must not flush an injected message");
				},
			},
			sendCustomMessage: async (_message: unknown, options: unknown) => {
				attempts++;
				expect(options).toEqual({ deliveryMode: "steer", when: "idle" });
				return { status: "unavailable", reason: "session_busy" };
			},
		});
		const command: Extract<RpcMutationCommand, { type: "custom_message" }> = {
			type: "custom_message",
			customType: "context",
			content: "idle only",
			display: false,
			when: "idle",
			mutation: mutation("custom-idle-busy"),
		};
		const ledger = new RpcMutationLedger(path.join(tempDir.path(), "custom-busy-mutations.sqlite"));
		try {
			const first = await ledger.execute(
				command,
				() => "session-1",
				async () => requireResponse(await executeRpcSessionDataCommand(session, command)),
			);
			const replay = await ledger.execute(
				{ ...command, id: "replay" },
				() => "session-1",
				async () => {
					throw new Error("must not execute");
				},
			);
			const changedPolicy = await ledger.execute(
				{ ...command, id: "changed", when: "any" },
				() => "session-1",
				async () => {
					throw new Error("must not execute");
				},
			);
			expect(attempts).toBe(1);
			expect(first).toMatchObject({
				success: false,
				code: "session_busy",
				error: "Session is busy",
				receipt: { operation: "custom_message", replayed: false },
			});
			expect(replay).toMatchObject({ success: false, code: "session_busy", receipt: { replayed: true } });
			expect(changedPolicy).toMatchObject({ success: false, code: "protocol-error" });
		} finally {
			ledger.close();
		}
	});

	it("requires provenance and rejects cyclic details before custom-message execution", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		const session = fakeSession({});
		const missingMutation = {
			type: "custom_message",
			customType: "context",
			content: "text",
			display: true,
		} as RpcCommand as RpcMutationCommand;
		expect(validateRpcMutationBeforeIntent(session, missingMutation)).toMatchObject({
			success: false,
			code: "protocol-error",
		});
		const invalid: Extract<RpcMutationCommand, { type: "custom_message" }> = {
			type: "custom_message",
			customType: "context",
			content: "text",
			display: true,
			details: cyclic,
			mutation: mutation("custom-invalid"),
		};
		expect(validateRpcMutationBeforeIntent(session, invalid)).toMatchObject({
			success: false,
			code: "protocol-error",
		});
		const invalidWhen = {
			type: "custom_message",
			customType: "context",
			content: "text",
			display: true,
			when: "later",
			mutation: mutation("custom-invalid-when"),
		} as unknown as RpcCommand as RpcMutationCommand;
		expect(validateRpcMutationBeforeIntent(session, invalidWhen)).toMatchObject({
			success: false,
			code: "protocol-error",
		});
	});

	it("validates an exact fork entry before recording a durable intent", () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "branch point", timestamp: 1 });
		const entryId = manager.getLeafId();
		if (!entryId) throw new Error("Expected a branch point");
		const session = fakeSession({ sessionManager: manager });
		const base = { type: "fork", entryId } as const;
		expect(validateRpcMutationBeforeIntent(session, base as RpcMutationCommand)).toMatchObject({
			success: false,
			code: "protocol-error",
		});
		expect(
			validateRpcMutationBeforeIntent(session, {
				...base,
				entryId: "x".repeat(257),
				mutation: mutation("fork-too-long"),
			}),
		).toMatchObject({ success: false, code: "protocol-error" });
		expect(
			validateRpcMutationBeforeIntent(session, {
				...base,
				entryId: "missing-entry",
				mutation: mutation("fork-missing"),
			}),
		).toMatchObject({ success: false, code: "not-found" });
		expect(validateRpcMutationBeforeIntent(session, { ...base, mutation: mutation("fork-valid") })).toBeUndefined();
	});

	it("requires durable exact tool choice before side effects", () => {
		const session = fakeSession({
			getActiveToolNames: () => ["bash"],
			resolveNamedToolChoice: (name: string) => {
				if (name !== "bash") throw new Error("inactive");
				return { type: "function", name };
			},
		});
		const prompt = { type: "prompt", message: "run", toolChoice: "bash" } as RpcCommand as RpcMutationCommand;
		expect(validateRpcMutationBeforeIntent(session, prompt)).toMatchObject({
			success: false,
			code: "protocol-error",
		});
	});
});
