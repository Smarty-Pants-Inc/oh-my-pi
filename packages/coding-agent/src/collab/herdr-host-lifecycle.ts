import type {
	RpcCanonicalAuthority,
	RpcControlFrame,
	RpcHerdrAgentdHostBridge,
	RpcPrepareHerdrAgentdRebindFrame,
} from "../modes/rpc/rpc-types";
import type { AgentSession } from "../session/agent-session";
import { CollabHost, type CollabHostContext } from "./host";
import { createHostBridgeTransport, type LocalCollabTransport, validateHerdrBridgeAddress } from "./local-transport";

export interface ManagedHerdrHostBridge extends RpcHerdrAgentdHostBridge {
	role: "host";
	managed: true;
	runtimeOwner: "agentd";
}

type SessionSource = Pick<AgentSession, "registerSessionChangeCallback" | "sessionManager">;

interface PreparedHerdrAgentdRebind {
	frame: RpcPrepareHerdrAgentdRebindFrame;
	expiresAt: number;
	expiryTimer?: NodeJS.Timeout;
	successorSessionId?: string;
}

const HERDR_AGENTD_REBIND_TTL_MS = 15_000;
const ROUTE_BUSY_RETRY_DELAY_MS = 25;

/** Rebinds the private Herdr route only after the session transaction commits. */
export class HerdrCollabHostLifecycle {
	#context: CollabHostContext;
	#session: SessionSource;
	#bridge: ManagedHerdrHostBridge | undefined;
	#rpcAuthority: Promise<RpcCanonicalAuthority> | undefined;
	#host: CollabHost | undefined;
	#candidate: { host: CollabHost; prepared: PreparedHerdrAgentdRebind; cancel: (reason: string) => void } | undefined;
	#prepared: PreparedHerdrAgentdRebind | undefined;
	#tail: Promise<void> = Promise.resolve();
	#unregister: (() => void) | undefined;
	#started = false;
	#stopped = false;
	#stopTask: Promise<void> | undefined;

	constructor(
		context: CollabHostContext,
		session: SessionSource,
		bridge: ManagedHerdrHostBridge,
		rpcAuthority?: Promise<RpcCanonicalAuthority>,
	) {
		this.#context = context;
		this.#session = session;
		this.#bridge = bridge;
		this.#rpcAuthority = rpcAuthority;
	}

	async start(): Promise<void> {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		this.#unregister = this.#session.registerSessionChangeCallback(() => {
			const sessionId = this.#session.sessionManager.getSessionId();
			const prepared = this.#reservePrepared(sessionId);
			void this.#enqueueRebind(() => this.#rebindSuccessor(sessionId, prepared)).catch(() => {});
		});
		try {
			await this.#enqueueRebind(() => this.#startInitialRoute());
			// A committed fork can land during initial route startup. Its queued successor
			// route must settle before RPC readiness exposes this process.
			await this.#tail;
		} catch (error) {
			this.#unregister?.();
			this.#unregister = undefined;
			this.#started = false;
			throw error;
		}
	}

	whenIdle(): Promise<void> {
		return this.#tail;
	}

	/** Accept only the two agentd-owned transient rebind controls. */
	handleControlFrame(frame: RpcControlFrame): boolean {
		if (frame.type === "clear_herdr_agentd_rebind") {
			this.clearHerdrAgentdRebind();
			return true;
		}
		if (frame.type !== "prepare_herdr_agentd_rebind") return false;
		this.#stagePrepared(frame);
		return true;
	}

	/** Wipe a staged successor route without affecting the active predecessor route. */
	clearHerdrAgentdRebind(): void {
		this.#discardPrepared(this.#prepared, "prepared Herdr rebind cleared");
	}

	stop(reason: string): Promise<void> {
		if (this.#stopTask) return this.#stopTask;
		this.#stopped = true;
		this.#unregister?.();
		this.#unregister = undefined;
		const bridge = this.#bridge;
		this.#bridge = undefined;
		if (bridge) {
			bridge.address = "";
			bridge.paneId = "";
			bridge.routeGeneration = 0;
			bridge.token = "";
		}
		this.#discardPrepared(this.#prepared, reason);
		this.#stopTask = this.#stopAfterRebind(reason);
		return this.#stopTask;
	}

	async #stopAfterRebind(reason: string): Promise<void> {
		await this.#tail;
		const host = this.#host;
		this.#host = undefined;
		await host?.stop(reason);
	}

	#enqueueRebind(operation: () => Promise<void>): Promise<void> {
		const task = this.#tail.then(operation, operation);
		this.#tail = task.catch(() => {});
		return task;
	}

	async #startInitialRoute(): Promise<void> {
		if (this.#stopped) return;
		const sessionId = this.#session.sessionManager.getSessionId();
		const bridge = this.#bridge;
		this.#bridge = undefined;
		if (!bridge) throw new Error("Initial Herdr agentd host bridge is unavailable");
		let transport: LocalCollabTransport;
		try {
			transport = createHostBridgeTransport(
				bridge.address,
				bridge.token,
				bridge.paneId,
				sessionId,
				bridge.routeGeneration,
			);
		} finally {
			bridge.address = "";
			bridge.paneId = "";
			bridge.routeGeneration = 0;
			bridge.token = "";
		}
		if (this.#stopped || this.#session.sessionManager.getSessionId() !== sessionId) {
			transport.close();
			return;
		}
		const host = new CollabHost(this.#context);
		await host.startWithTransport(transport, { agentdManagedHost: true, rpcAuthority: this.#rpcAuthority });
		if (this.#stopped || this.#session.sessionManager.getSessionId() !== sessionId) {
			await host.stop("session switched");
			return;
		}
		this.#host = host;
	}

	async #rebindSuccessor(sessionId: string, prepared: PreparedHerdrAgentdRebind | undefined): Promise<void> {
		const prior = this.#host;
		this.#host = undefined;
		await prior?.stop("session switched");
		if (this.#stopped || this.#session.sessionManager.getSessionId() !== sessionId) {
			this.#discardPrepared(prepared, "successor session changed");
			return;
		}
		if (!this.#preparedIsUsable(prepared, sessionId)) {
			this.#discardPrepared(prepared, "prepared Herdr rebind unavailable");
			throw new Error("Committed session transition has no valid prepared Herdr agentd rebind");
		}

		let retriedRouteBusy = false;
		for (;;) {
			const next = new CollabHost(this.#context);
			const cancelled = Promise.withResolvers<string>();
			this.#candidate = { host: next, prepared, cancel: cancelled.resolve };
			try {
				await Promise.race([
					next.startWithTransport(
						createHostBridgeTransport(
							prepared.frame.address,
							prepared.frame.token,
							prepared.frame.paneId,
							sessionId,
							prepared.frame.routeGeneration,
						),
						{ agentdManagedHost: true, rpcAuthority: this.#rpcAuthority },
					),
					cancelled.promise.then(reason => {
						throw new Error(reason);
					}),
				]);
			} catch (error) {
				if (this.#candidate?.host === next) this.#candidate = undefined;
				const message = error instanceof Error ? error.message : String(error);
				const routeBusy = message === "route_busy";
				const remaining = prepared.expiresAt - Date.now();
				if (routeBusy && !retriedRouteBusy && remaining > 0 && this.#preparedIsUsable(prepared, sessionId)) {
					retriedRouteBusy = true;
					await Bun.sleep(Math.min(ROUTE_BUSY_RETRY_DELAY_MS, remaining));
					if (this.#preparedIsUsable(prepared, sessionId)) continue;
				}
				this.#discardPrepared(prepared, "prepared Herdr rebind failed");
				throw error;
			}
			if (this.#candidate?.host === next) this.#candidate = undefined;
			if (!this.#preparedIsUsable(prepared, sessionId)) {
				await next.stop("prepared Herdr rebind expired or cleared");
				this.#discardPrepared(prepared, "prepared Herdr rebind expired or cleared");
				throw new Error("Prepared Herdr agentd rebind expired or was cleared before readiness");
			}

			// Readiness is the consumption point: route_busy may reuse this exact tuple
			// once before here, but no later transition can ever observe it.
			this.#consumePrepared(prepared);
			if (this.#stopped || this.#session.sessionManager.getSessionId() !== sessionId) {
				await next.stop("session switched");
				return;
			}
			this.#host = next;
			return;
		}
	}

	#stagePrepared(frame: RpcPrepareHerdrAgentdRebindFrame): void {
		this.#discardPrepared(this.#prepared, "prepared Herdr rebind replaced");
		try {
			validateHerdrBridgeAddress(frame.address);
		} catch {
			return;
		}
		if (
			this.#stopped ||
			process.platform === "win32" ||
			!frame.paneId ||
			frame.paneId.trim() !== frame.paneId ||
			frame.paneId.includes("\0") ||
			frame.paneId.length > 256 ||
			frame.routeGeneration !== 1 ||
			!frame.token ||
			frame.token.trim() !== frame.token ||
			frame.token.includes("\0")
		) {
			return;
		}
		const prepared: PreparedHerdrAgentdRebind = {
			frame: { ...frame },
			expiresAt: Date.now() + HERDR_AGENTD_REBIND_TTL_MS,
		};
		prepared.expiryTimer = setTimeout(() => {
			this.#discardPrepared(prepared, "prepared Herdr rebind expired");
		}, HERDR_AGENTD_REBIND_TTL_MS);
		prepared.expiryTimer.unref();
		this.#prepared = prepared;
	}

	#reservePrepared(sessionId: string): PreparedHerdrAgentdRebind | undefined {
		const prepared = this.#prepared;
		if (!prepared) return undefined;
		if (prepared.successorSessionId !== undefined || !this.#preparedIsUsable(prepared)) {
			this.#discardPrepared(prepared, "prepared Herdr rebind rejected");
			return undefined;
		}
		prepared.successorSessionId = sessionId;
		return prepared;
	}

	#preparedIsUsable(
		prepared: PreparedHerdrAgentdRebind | undefined,
		sessionId?: string,
	): prepared is PreparedHerdrAgentdRebind {
		return (
			prepared !== undefined &&
			this.#prepared === prepared &&
			prepared.expiresAt > Date.now() &&
			prepared.frame.routeGeneration === 1 &&
			(sessionId === undefined || prepared.successorSessionId === sessionId)
		);
	}

	#consumePrepared(prepared: PreparedHerdrAgentdRebind): void {
		if (this.#prepared !== prepared) return;
		clearTimeout(prepared.expiryTimer);
		this.#prepared = undefined;
		this.#wipePrepared(prepared);
	}

	#discardPrepared(prepared: PreparedHerdrAgentdRebind | undefined, reason: string): void {
		if (!prepared || this.#prepared !== prepared) return;
		clearTimeout(prepared.expiryTimer);
		this.#prepared = undefined;
		const candidate = this.#candidate;
		if (candidate?.prepared === prepared) {
			this.#candidate = undefined;
			candidate.cancel(reason);
			void candidate.host.stop(reason);
		}
		this.#wipePrepared(prepared);
	}

	#wipePrepared(prepared: PreparedHerdrAgentdRebind): void {
		prepared.frame.address = "";
		prepared.frame.paneId = "";
		prepared.frame.routeGeneration = 0;
		prepared.frame.token = "";
		prepared.successorSessionId = undefined;
	}
}
