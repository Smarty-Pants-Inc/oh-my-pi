import { Buffer } from "node:buffer";
import type {
	ClientBridgeTerminalExitStatus,
	ClientBridgeTerminalHandle,
	ClientBridgeTerminalOutput,
} from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { cloudOmpRoutes, type ExecSnapshot } from "../protocol";
import { auditErrorCode, type CloudOmpAuditWriter } from "./audit";
import {
	elapsedMs,
	isTerminal,
	POLL_INTERVAL_MS,
	retryTransportOnce,
	sanitizeEnvironmentError,
	sleep,
	terminalExitStatus,
	validateExecSnapshot,
} from "./environment-wire";
import type { CloudOmpJsonClient } from "./http";

export class CloudflareTerminalHandle implements ClientBridgeTerminalHandle {
	readonly terminalId: string;

	readonly #http: CloudOmpJsonClient;
	readonly #workspaceId: string;
	readonly #outputByteLimit: number;
	readonly #audit: CloudOmpAuditWriter;
	#snapshotRequest?: Promise<ExecSnapshot>;
	#waitPromise?: Promise<ClientBridgeTerminalExitStatus>;
	#killPromise?: Promise<void>;
	#releasePromise?: Promise<void>;
	#completionAudited = false;

	constructor(
		http: CloudOmpJsonClient,
		workspaceId: string,
		execId: string,
		outputByteLimit: number,
		audit: CloudOmpAuditWriter,
	) {
		this.#http = http;
		this.#workspaceId = workspaceId;
		this.terminalId = execId;
		this.#outputByteLimit = outputByteLimit;
		this.#audit = audit;
		Object.freeze(this);
	}

	waitForExit(): Promise<ClientBridgeTerminalExitStatus> {
		this.#waitPromise ??= this.#pollUntilTerminal();
		return this.#waitPromise;
	}

	async currentOutput(): Promise<ClientBridgeTerminalOutput> {
		const snapshot = await this.#snapshot();
		return {
			output: snapshot.output,
			truncated: snapshot.truncated,
			...(isTerminal(snapshot) ? { exitStatus: terminalExitStatus(snapshot) } : {}),
		};
	}

	kill(): Promise<void> {
		this.#killPromise ??= this.#performKill();
		return this.#killPromise;
	}

	release(): Promise<void> {
		this.#releasePromise ??= this.#performRelease();
		return this.#releasePromise;
	}

	async #pollUntilTerminal(): Promise<ClientBridgeTerminalExitStatus> {
		const startedAt = performance.now();
		for (;;) {
			const snapshot = await this.#snapshot();
			if (isTerminal(snapshot)) {
				if (!this.#completionAudited) {
					this.#completionAudited = true;
					await this.#audit.record({
						operation: "exec_complete",
						durationMs: elapsedMs(startedAt),
						outcome:
							snapshot.status === "completed"
								? "success"
								: snapshot.status === "cancelled"
									? "cancelled"
									: "failed",
						byteCount: Buffer.byteLength(snapshot.output, "utf8"),
						exitCode: snapshot.exitCode,
						signal: snapshot.signal,
						truncated: snapshot.truncated,
						...(snapshot.status === "completed" ? {} : { errorCode: "EXECUTION_FAILED" }),
					});
				}
				return terminalExitStatus(snapshot);
			}
			await sleep(POLL_INTERVAL_MS);
		}
	}

	async #performKill(): Promise<void> {
		const startedAt = performance.now();
		try {
			const value = await retryTransportOnce(() =>
				this.#http.requestJson<unknown>({
					method: "POST",
					path: cloudOmpRoutes.execKill(this.#workspaceId, this.terminalId),
				}),
			);
			validateExecSnapshot(value, this.terminalId, this.#outputByteLimit);
			await this.#audit.record({ operation: "exec_kill", durationMs: elapsedMs(startedAt), outcome: "cancelled" });
		} catch (error) {
			await this.#audit
				.record({
					operation: "exec_kill",
					durationMs: elapsedMs(startedAt),
					outcome: "failed",
					errorCode: auditErrorCode(error),
				})
				.catch(() => {});
			throw sanitizeEnvironmentError(error, undefined, "exec_kill");
		}
	}

	async #performRelease(): Promise<void> {
		const startedAt = performance.now();
		try {
			await retryTransportOnce(() =>
				this.#http.requestEmpty({
					method: "DELETE",
					path: cloudOmpRoutes.execSnapshot(this.#workspaceId, this.terminalId),
				}),
			);
			await this.#audit.record({
				operation: "exec_dispose",
				durationMs: elapsedMs(startedAt),
				outcome: "success",
				cleanupState: "completed",
			});
		} catch (error) {
			await this.#audit
				.record({
					operation: "exec_dispose",
					durationMs: elapsedMs(startedAt),
					outcome: "failed",
					cleanupState: "failed",
					errorCode: auditErrorCode(error),
				})
				.catch(() => {});
			throw sanitizeEnvironmentError(error, undefined, "exec_dispose");
		}
	}

	#snapshot(): Promise<ExecSnapshot> {
		if (!this.#snapshotRequest) {
			this.#snapshotRequest = retryTransportOnce(() =>
				this.#http.requestJson<unknown>({
					method: "GET",
					path: cloudOmpRoutes.execSnapshot(this.#workspaceId, this.terminalId),
				}),
			)
				.then(value => validateExecSnapshot(value, this.terminalId, this.#outputByteLimit))
				.catch(error => {
					throw sanitizeEnvironmentError(error, undefined, "exec_poll");
				})
				.finally(() => {
					this.#snapshotRequest = undefined;
				});
		}
		return this.#snapshotRequest;
	}
}
