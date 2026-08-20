import { Buffer } from "node:buffer";
import type { ExecutionEnvironmentBridge } from "@oh-my-pi/pi-coding-agent";
import type {
	ClientBridgeCreateTerminalParams,
	ClientBridgeTerminalHandle,
} from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { cloudOmpRoutes, type ExecRequest, type FileReadRequest } from "../protocol";
import { auditErrorCode, type CloudOmpAuditWriter } from "./audit";
import { CloudflareTerminalHandle } from "./environment-terminal";
import {
	createFilePayload,
	decodeFilePayload,
	elapsedMs,
	retryTransportOnce,
	sanitizeEnvironmentError,
	selectLines,
	toBoundaryPath,
	validateCommand,
	validateExecCreateResponse,
	validateTerminalParams,
} from "./environment-wire";
import { type CloudOmpJsonClient, CloudOmpProtocolError } from "./http";

export class CloudflareEnvironmentBridge implements ExecutionEnvironmentBridge {
	readonly #http: CloudOmpJsonClient;
	readonly #workspaceId: string;
	readonly #audit: CloudOmpAuditWriter;

	constructor(http: CloudOmpJsonClient, workspaceId: string, audit: CloudOmpAuditWriter) {
		this.#http = http;
		this.#workspaceId = workspaceId;
		this.#audit = audit;
		Object.freeze(this);
	}

	async readTextFile(params: { path: string; line?: number; limit?: number }): Promise<string> {
		const boundaryPath = toBoundaryPath(params.path);
		const startedAt = performance.now();
		try {
			const value = await retryTransportOnce(() =>
				this.#http.requestJson<unknown>({
					method: "POST",
					path: cloudOmpRoutes.fileRead(this.#workspaceId),
					body: { path: boundaryPath } satisfies FileReadRequest,
				}),
			);
			const content = decodeFilePayload(value, boundaryPath);
			await this.#audit.record({
				operation: "read",
				durationMs: elapsedMs(startedAt),
				outcome: "success",
				byteCount: Buffer.byteLength(content, "utf8"),
				fileCount: 1,
			});
			return selectLines(content, params.line, params.limit);
		} catch (error) {
			await this.#recordFailure("read", startedAt, error);
			throw sanitizeEnvironmentError(error, undefined, "read");
		}
	}

	async writeTextFile(params: { path: string; content: string }): Promise<void> {
		const boundaryPath = toBoundaryPath(params.path);
		const startedAt = performance.now();
		try {
			const payload = createFilePayload(boundaryPath, params.content);
			const value = await this.#http.requestJson<unknown>({
				method: "PUT",
				path: cloudOmpRoutes.files(this.#workspaceId),
				body: payload,
			});
			const content = decodeFilePayload(value, boundaryPath);
			if (content !== params.content) throw new CloudOmpProtocolError("WRITE_READBACK_MISMATCH");
			await this.#audit.record({
				operation: "write",
				durationMs: elapsedMs(startedAt),
				outcome: "success",
				byteCount: payload.byteLength,
				fileCount: 1,
			});
		} catch (error) {
			await this.#recordFailure("write", startedAt, error);
			throw sanitizeEnvironmentError(error, undefined, "write");
		}
	}

	async writeInternal(path: string, content: string, signal?: AbortSignal): Promise<void> {
		const payload = createFilePayload(path, content);
		const value = await this.#http.requestJson<unknown>({
			method: "PUT",
			path: cloudOmpRoutes.files(this.#workspaceId),
			body: payload,
			signal,
		});
		if (decodeFilePayload(value, path) !== content) throw new CloudOmpProtocolError("WRITE_READBACK_MISMATCH");
	}

	async createTerminal(params: ClientBridgeCreateTerminalParams): Promise<ClientBridgeTerminalHandle> {
		validateTerminalParams(params);
		const source = params.args![3]!;
		validateCommand(source);
		const request: ExecRequest = {
			source,
			cwd: params.cwd!,
			timeoutMs: params.timeoutMs!,
			outputByteLimit: params.outputByteLimit!,
		};
		const startedAt = performance.now();
		try {
			const value = await this.#http.requestJson<unknown>({
				method: "POST",
				path: cloudOmpRoutes.exec(this.#workspaceId),
				body: request,
			});
			const response = validateExecCreateResponse(value);
			const handle = new CloudflareTerminalHandle(
				this.#http,
				this.#workspaceId,
				response.execId,
				request.outputByteLimit,
				this.#audit,
			);
			try {
				await this.#audit.record({ operation: "exec_start", durationMs: elapsedMs(startedAt), outcome: "success" });
			} catch (error) {
				await handle.release().catch(() => {});
				throw error;
			}
			return handle;
		} catch (error) {
			await this.#recordFailure("exec_start", startedAt, error);
			throw sanitizeEnvironmentError(error, undefined, "exec_start");
		}
	}

	async #recordFailure(operation: "read" | "write" | "exec_start", startedAt: number, error: unknown): Promise<void> {
		await this.#audit
			.record({ operation, durationMs: elapsedMs(startedAt), outcome: "failed", errorCode: auditErrorCode(error) })
			.catch(() => {});
	}
}
