import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfigRootDir, isRecord } from "@oh-my-pi/pi-utils";
import {
	isRpcMutationContext,
	type RpcMutationCommand,
	type RpcMutationOperation,
	type RpcMutationReceipt,
	type RpcMutationSessionOutcome,
	type RpcResponse,
} from "./rpc-types";

const MAX_STORED_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_STORED_ERROR_LENGTH = 4096;

interface MutationRow {
	command_id: string;
	runtime_id: string;
	generation: number;
	operation: RpcMutationOperation;
	fingerprint: string;
	outcome_json: string | null;
}

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Mutation payload contains a non-finite number");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item ?? null)).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.filter(key => value[key] !== undefined)
			.sort()
			.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	throw new Error(`Mutation payload contains unsupported ${typeof value}`);
}

export function fingerprintRpcMutation(command: RpcMutationCommand): string {
	const { id: _id, mutation: _mutation, ...payload } = command;
	return new Bun.CryptoHasher("sha256").update(canonicalJson(payload)).digest("hex");
}

export function getRpcMutationDbPath(): string {
	return path.join(getConfigRootDir(), "rpc", "mutations.sqlite");
}

function mutationError(command: Pick<RpcMutationCommand, "id" | "type">, error: string, code: string): RpcResponse {
	return { id: command.id, type: "response", command: command.type, success: false, error, code };
}

function replayResponse(json: string, id: string | undefined, replayed: boolean): RpcResponse | undefined {
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!isRecord(parsed) || parsed.type !== "response" || typeof parsed.command !== "string") return undefined;
		const receipt = parsed.receipt;
		if (!isRecord(receipt)) return undefined;
		return { ...parsed, id, receipt: { ...receipt, replayed } } as RpcResponse;
	} catch {
		return undefined;
	}
}

function replayInFlightResponse(response: RpcResponse, id: string | undefined): RpcResponse {
	return response.receipt
		? ({ ...response, id, receipt: { ...response.receipt, replayed: true } } as RpcResponse)
		: { ...response, id };
}

function storedResponse(response: RpcResponse, receipt: RpcMutationReceipt): string {
	const normalized: RpcResponse = {
		...response,
		id: undefined,
		...(response.success
			? {}
			: {
					error:
						receipt.operation === "prompt"
							? "Prompt mutation was rejected"
							: response.error.slice(0, MAX_STORED_ERROR_LENGTH),
				}),
		receipt,
	} as RpcResponse;
	const json = JSON.stringify(normalized);
	if (Buffer.byteLength(json) > MAX_STORED_RESPONSE_BYTES) {
		throw new Error("RPC mutation terminal response exceeds the durable receipt limit");
	}
	return json;
}

function sessionOutcome(
	response: RpcResponse,
	beforeSessionId: string,
	afterSessionId: string,
): RpcMutationSessionOutcome {
	const cancelled =
		response.success &&
		"data" in response &&
		isRecord(response.data) &&
		"cancelled" in response.data &&
		response.data.cancelled === true;
	const status = response.success ? (cancelled ? "cancelled" : "completed") : "rejected";
	return {
		status,
		sessionId: afterSessionId,
		...(beforeSessionId !== afterSessionId ? { previousSessionId: beforeSessionId } : {}),
		...(response.success && response.command === "prompt" && response.data
			? { agentInvoked: response.data.agentInvoked }
			: {}),
	};
}

function restrictMutationLedgerFile(filePath: string): void {
	try {
		fs.chmodSync(filePath, 0o600);
	} catch (error) {
		if (!(error instanceof Error) || !isRecord(error) || error.code !== "ENOENT") throw error;
	}
}

/** Durable, cross-process OMP mutation intent and terminal-outcome ledger. */
export class RpcMutationLedger {
	#db: Database;
	#select;
	#insert;
	#update;
	#inFlight = new Map<
		string,
		{
			runtimeId: string;
			generation: number;
			operation: RpcMutationOperation;
			fingerprint: string;
			promise: Promise<RpcResponse>;
		}
	>();

	constructor(dbPath = getRpcMutationDbPath()) {
		const ledgerDir = path.dirname(dbPath);
		fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o700 });
		fs.chmodSync(ledgerDir, 0o700);
		this.#db = new Database(dbPath);
		restrictMutationLedgerFile(dbPath);
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;

CREATE TABLE IF NOT EXISTS rpc_mutations (
	command_id TEXT PRIMARY KEY,
	runtime_id TEXT NOT NULL,
	generation INTEGER NOT NULL,
	operation TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	outcome_json TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch()),
	completed_at INTEGER
);
`);
		restrictMutationLedgerFile(dbPath);
		restrictMutationLedgerFile(`${dbPath}-wal`);
		restrictMutationLedgerFile(`${dbPath}-shm`);
		this.#select = this.#db.query<MutationRow, [string]>(
			"SELECT command_id, runtime_id, generation, operation, fingerprint, outcome_json FROM rpc_mutations WHERE command_id = ?",
		);
		this.#insert = this.#db.prepare(
			"INSERT INTO rpc_mutations (command_id, runtime_id, generation, operation, fingerprint) VALUES (?, ?, ?, ?, ?)",
		);
		this.#update = this.#db.prepare(
			"UPDATE rpc_mutations SET outcome_json = ?, completed_at = unixepoch() WHERE command_id = ? AND outcome_json IS NULL",
		);
	}

	close(): void {
		this.#db.close();
	}

	async execute(
		command: RpcMutationCommand,
		getSessionId: () => string,
		execute: () => Promise<RpcResponse>,
	): Promise<RpcResponse> {
		if (!isRpcMutationContext(command.mutation)) {
			return mutationError(command, "A valid mutation context is required", "protocol-error");
		}
		let fingerprint: string;
		try {
			fingerprint = fingerprintRpcMutation(command);
		} catch (error) {
			return mutationError(command, error instanceof Error ? error.message : String(error), "protocol-error");
		}
		const context = command.mutation;
		const claim = this.#db.transaction(() => {
			const existing = this.#select.get(context.commandId);
			if (existing) return existing;
			this.#insert.run(context.commandId, context.runtimeId, context.generation, command.type, fingerprint);
			return null;
		});
		const existing = claim.immediate();
		if (existing) {
			if (
				existing.runtime_id !== context.runtimeId ||
				existing.generation !== context.generation ||
				existing.operation !== command.type ||
				existing.fingerprint !== fingerprint
			) {
				return mutationError(command, "Mutation command ID was reused with a different request", "protocol-error");
			}
			if (existing.outcome_json) {
				return (
					replayResponse(existing.outcome_json, command.id, true) ??
					mutationError(command, "Mutation terminal outcome is unreadable", "ambiguous")
				);
			}
			const inFlight = this.#inFlight.get(context.commandId);
			if (
				inFlight &&
				inFlight.runtimeId === context.runtimeId &&
				inFlight.generation === context.generation &&
				inFlight.operation === command.type &&
				inFlight.fingerprint === fingerprint
			) {
				return replayInFlightResponse(await inFlight.promise, command.id);
			}
			return mutationError(command, "Mutation intent exists without a durable terminal outcome", "ambiguous");
		}

		const promise = this.#executeClaimed(command, getSessionId, execute);
		this.#inFlight.set(context.commandId, {
			runtimeId: context.runtimeId,
			generation: context.generation,
			operation: command.type,
			fingerprint,
			promise,
		});
		try {
			return await promise;
		} finally {
			if (this.#inFlight.get(context.commandId)?.promise === promise) this.#inFlight.delete(context.commandId);
		}
	}

	async #executeClaimed(
		command: RpcMutationCommand,
		getSessionId: () => string,
		execute: () => Promise<RpcResponse>,
	): Promise<RpcResponse> {
		const beforeSessionId = getSessionId();
		let response: RpcResponse;
		try {
			response = await execute();
		} catch (error) {
			response = mutationError(command, error instanceof Error ? error.message : String(error), "operation-error");
		}
		const afterSessionId = getSessionId();
		const context = command.mutation;
		if (!isRpcMutationContext(context)) {
			return mutationError(command, "A valid mutation context is required", "protocol-error");
		}
		const receipt: RpcMutationReceipt = {
			...context,
			owner: "omp",
			operation: command.type,
			fingerprint: fingerprintRpcMutation(command),
			replayed: false,
			session: sessionOutcome(response, beforeSessionId, afterSessionId),
		};
		try {
			const outcomeJson = storedResponse(response, receipt);
			const complete = this.#db.transaction(() => {
				const row = this.#select.get(context.commandId);
				if (!row) throw new Error("RPC mutation intent disappeared before terminal persistence");
				if (row.outcome_json) return row.outcome_json;
				this.#update.run(outcomeJson, context.commandId);
				return outcomeJson;
			});
			const persisted = complete.immediate();
			return (
				replayResponse(persisted, command.id, false) ??
				mutationError(command, "Mutation terminal outcome is unreadable", "ambiguous")
			);
		} catch {
			return mutationError(command, "Mutation may have executed without a durable terminal outcome", "ambiguous");
		}
	}
}
