import { Buffer } from "node:buffer";
import type {
	ClientBridgeCreateTerminalParams,
	ClientBridgeTerminalHandle,
} from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ExecutionEnvironmentBridge } from "@oh-my-pi/pi-coding-agent/session/execution-environment";
import type {
	PersistentModelWorkspacePath,
	RuntimeAccessContext,
	RuntimeCommandInspectResult,
	RuntimeCommandRequest,
	RuntimeCommandSnapshot,
	RuntimeExecutionBridge,
	RuntimeFileStat,
	RuntimeLeaseRef,
	RuntimeListRequest,
	RuntimeListResult,
	RuntimeMutationContext,
	RuntimeReadBinaryRequest,
	RuntimeReadBinaryResult,
	RuntimeReadTextRequest,
	RuntimeReadTextResult,
	RuntimeSearchRequest,
	RuntimeSearchResult,
	RuntimeWriteResult,
	RuntimeWriteTextRequest,
} from "@oh-my-pi/pi-coding-agent/session/workspace-runtime-contracts";
import {
	type CloudflareRuntimeEffectTransportEnvelopeV1,
	type CloudflareRuntimeEffectTransportResultEnvelopeV1,
	type CloudflareRuntimeInspectionTransportEnvelopeV1,
	type CloudflareRuntimeInspectionTransportResultEnvelopeV1,
	CloudflareRuntimeProtocolErrorV1,
	cloudflareRuntimeRoutesV1,
	cloudOmpRoutes,
	type ExecRequest,
	type FileReadRequest,
} from "../protocol";
import { auditErrorCode, type CloudOmpAuditWriter } from "./audit";
import { CloudflareTerminalHandle } from "./environment-terminal";
import {
	createFilePayload,
	decodeCloudflareRuntimeEffectTransportResultWireV1,
	decodeCloudflareRuntimeInspectionTransportResultWireV1,
	decodeFilePayload,
	elapsedMs,
	encodeCloudflareRuntimeEffectTransportWireV1,
	encodeCloudflareRuntimeInspectionTransportWireV1,
	retryTransportOnce,
	sanitizeEnvironmentError,
	selectLines,
	toBoundaryPath,
	validateCommand,
	validateExecCreateResponse,
	validateTerminalParams,
} from "./environment-wire";
import { type CloudOmpJsonClient, CloudOmpProtocolError } from "./http";

type CommandId = RuntimeCommandRequest["commandId"];

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

export class CloudflareRuntimeBridge implements RuntimeExecutionBridge {
	readonly #http: CloudOmpJsonClient;
	readonly #lease: RuntimeLeaseRef;

	constructor(http: CloudOmpJsonClient, lease: RuntimeLeaseRef) {
		this.#http = http;
		this.#lease = lease;
		Object.freeze(this);
	}

	async readTextFile(request: RuntimeReadTextRequest): Promise<RuntimeReadTextResult> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "read_text_file",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#inspection(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "read_text_file") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async readBinaryFile(request: RuntimeReadBinaryRequest): Promise<RuntimeReadBinaryResult> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "read_binary_file",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#inspection(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "read_binary_file") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async writeTextFile(request: RuntimeWriteTextRequest): Promise<RuntimeWriteResult> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "write_text_file",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#effect(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "write_text_file") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async exists(request: RuntimeAccessContext & { path: PersistentModelWorkspacePath }): Promise<boolean> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "exists",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#inspection(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "exists") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async stat(request: RuntimeAccessContext & { path: PersistentModelWorkspacePath }): Promise<RuntimeFileStat> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "stat",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#inspection(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "stat") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async mkdir(
		request: RuntimeMutationContext & { path: PersistentModelWorkspacePath; recursive: boolean },
	): Promise<{ readonly status: "created" | "already_exists" }> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "mkdir",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#effect(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "mkdir") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async remove(
		request: RuntimeMutationContext & { path: PersistentModelWorkspacePath; recursive: boolean },
	): Promise<{ readonly status: "removed" | "already_absent" }> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "remove",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#effect(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "remove") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async rename(
		request: RuntimeMutationContext & { from: PersistentModelWorkspacePath; to: PersistentModelWorkspacePath },
	): Promise<{ readonly status: "renamed" | "already_renamed" }> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "rename",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#effect(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "rename") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async listFiles(request: RuntimeListRequest): Promise<RuntimeListResult> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "list_files",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#inspection(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "list_files") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async searchText(request: RuntimeSearchRequest): Promise<RuntimeSearchResult> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "search_text",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#inspection(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "search_text") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async submitCommand(request: RuntimeCommandRequest): Promise<RuntimeCommandSnapshot> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "submit_command",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#effect(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "submit_command") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async inspectCommand(
		request: RuntimeAccessContext & { commandId: CommandId },
	): Promise<RuntimeCommandInspectResult> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "inspect_command",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#inspection(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "inspect_command") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async cancelCommand(
		request: RuntimeMutationContext & {
			commandId: CommandId;
			signal: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP";
		},
	): Promise<RuntimeCommandSnapshot> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "cancel_command",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#effect(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "cancel_command") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	async disposeCommand(
		request: RuntimeMutationContext & { commandId: CommandId },
	): Promise<{ readonly status: "disposed" | "already_disposed"; readonly commandId: CommandId }> {
		this.#assertAuthority(request);
		const envelope = {
			schemaVersion: 1,
			family: "bridge",
			operation: "dispose_command",
			replica: this.#lease.replica,
			request,
		} as const;
		const response = await this.#effect(envelope);
		if (!("family" in response) || response.family !== "bridge" || response.operation !== "dispose_command") {
			throw new CloudflareRuntimeProtocolErrorV1("provider_response_invalid");
		}
		return response.result;
	}

	#assertAuthority(request: RuntimeAccessContext): void {
		const { replica } = this.#lease;
		if (
			request.workspaceId !== replica.workspaceId ||
			request.replicaId !== replica.replicaId ||
			request.leaseId !== this.#lease.leaseId ||
			request.expectedGeneration !== this.#lease.baseGeneration ||
			request.fence.fenceId !== this.#lease.fenceId ||
			request.fence.token.length === 0
		) {
			throw new CloudflareRuntimeProtocolErrorV1("request_identity_mismatch");
		}
	}

	async #effect(
		envelope: CloudflareRuntimeEffectTransportEnvelopeV1,
	): Promise<CloudflareRuntimeEffectTransportResultEnvelopeV1> {
		const bodyJson = await encodeCloudflareRuntimeEffectTransportWireV1(envelope);
		const value = await this.#http.requestJson<unknown>({
			method: "POST",
			path: cloudflareRuntimeRoutesV1.effect,
			bodyJson,
		});
		return decodeCloudflareRuntimeEffectTransportResultWireV1(value, envelope);
	}

	async #inspection(
		envelope: CloudflareRuntimeInspectionTransportEnvelopeV1,
	): Promise<CloudflareRuntimeInspectionTransportResultEnvelopeV1> {
		const bodyJson = await encodeCloudflareRuntimeInspectionTransportWireV1(envelope);
		const value = await this.#http.requestJson<unknown>({
			method: "POST",
			path: cloudflareRuntimeRoutesV1.inspect,
			bodyJson,
		});
		return decodeCloudflareRuntimeInspectionTransportResultWireV1(value, envelope);
	}
}
