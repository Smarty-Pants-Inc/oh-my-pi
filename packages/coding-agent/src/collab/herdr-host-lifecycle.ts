import type { InteractiveModeContext } from "../modes/types";
import type { AgentSession } from "../session/agent-session";
import { discoverHerdrHostBridge, type HerdrHostBridgeBootstrap } from "./herdr-bridge-bootstrap";
import { CollabHost } from "./host";
import { createHostBridgeTransport } from "./local-transport";

export interface ManagedHerdrHostBridge extends HerdrHostBridgeBootstrap {
	role: "host";
	managed: true;
	routeGeneration: number;
}

type SessionChangeSource = Pick<AgentSession, "registerSessionChangeCallback" | "sessionManager">;

const ROUTE_BUSY_RETRY_DEADLINE_MS = 1_000;
const ROUTE_BUSY_RETRY_INITIAL_DELAY_MS = 25;
const ROUTE_BUSY_RETRY_MAX_DELAY_MS = 250;
const MAX_TERMINAL_REARMS = 1;

/** Keeps the private Herdr route aligned with the logical session active in one interactive OMP process. */
export class HerdrCollabHostLifecycle {
	readonly #ctx: InteractiveModeContext;
	readonly #session: SessionChangeSource;
	#bridge: ManagedHerdrHostBridge;
	#host: CollabHost | undefined;
	#activeSessionId: string | undefined;
	#committedSessionId: string | undefined;
	#tail: Promise<void> = Promise.resolve();
	#unregisterSessionChange: (() => void) | undefined;
	#started = false;
	#stopping = false;
	#suspended = false;
	#terminalRearmSessionId: string | undefined;
	#terminalRearmAttempts = 0;

	constructor(ctx: InteractiveModeContext, session: SessionChangeSource, bridge: ManagedHerdrHostBridge) {
		this.#ctx = ctx;
		this.#session = session;
		this.#bridge = bridge;
	}

	async start(suspended = false): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		this.#committedSessionId = this.#session.sessionManager.getSessionId();
		if (suspended) this.#suspended = true;
		this.#unregisterSessionChange = this.#session.registerSessionChangeCallback(
			() => {
				this.#committedSessionId = this.#session.sessionManager.getSessionId();
				void this.#enqueueRearm(true).catch(() => {});
			},
			{
				onRollback: () => {
					this.#committedSessionId = this.#session.sessionManager.getSessionId();
					void this.#enqueueRearm(true, undefined, "after session rollback").catch(() => {});
				},
			},
		);
		try {
			await this.#enqueueRearm(false);
		} catch (error) {
			this.#unregisterSessionChange?.();
			this.#unregisterSessionChange = undefined;
			this.#started = false;
			throw error;
		}
	}

	whenIdle(): Promise<void> {
		return this.#tail;
	}

	async suspend(reason: string): Promise<void> {
		if (this.#stopping) return;
		this.#suspended = true;
		await this.#enqueueRearm(false, reason);
	}

	async resume(): Promise<void> {
		if (this.#stopping) return;
		this.#suspended = false;
		await this.#enqueueRearm(true, undefined, "while resuming the private route");
	}

	async stop(reason: string): Promise<void> {
		this.#stopping = true;
		this.#suspended = true;
		this.#unregisterSessionChange?.();
		this.#unregisterSessionChange = undefined;
		await this.#tail;
		await this.#deactivate(reason);
	}

	#enqueueRearm(
		reportFailure: boolean,
		suspendedReason?: string,
		failureContext = "after session change",
	): Promise<void> {
		const operation = this.#tail.then(
			() => this.#rearm(suspendedReason),
			() => this.#rearm(suspendedReason),
		);
		this.#tail = operation.catch(error => {
			if (!reportFailure || this.#stopping) return;
			this.#ctx.showError(
				`Herdr OMP bridge failed ${failureContext}: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
		return operation;
	}

	async #rearm(suspendedReason = "private route suspended"): Promise<void> {
		let routeBusyAttempts = 0;
		let routeBusySessionId: string | undefined;
		let routeBusyDeadline: number | undefined;
		let routeBusyDelayMs = ROUTE_BUSY_RETRY_INITIAL_DELAY_MS;
		let rediscovered = false;
		while (!this.#stopping) {
			if (this.#suspended || this.#ctx.collabGuest) {
				await this.#deactivate(suspendedReason);
				return;
			}
			const currentSessionId = this.#session.sessionManager.getSessionId();
			const sessionId = this.#committedSessionId ?? currentSessionId;
			if (currentSessionId !== sessionId) {
				await this.#deactivate("session transition pending");
				return;
			}
			if (this.#terminalRearmSessionId !== sessionId) {
				this.#terminalRearmSessionId = sessionId;
				this.#terminalRearmAttempts = 0;
			}
			if (routeBusySessionId !== sessionId) {
				routeBusySessionId = sessionId;
				routeBusyAttempts = 0;
				routeBusyDeadline = undefined;
				routeBusyDelayMs = ROUTE_BUSY_RETRY_INITIAL_DELAY_MS;
			}
			if (this.#host && this.#activeSessionId === sessionId) return;

			await this.#deactivate("session switched");
			if (this.#stopping || this.#suspended || this.#ctx.collabGuest) return;
			const refreshed = await discoverHerdrHostBridge(this.#bridge.discovery);
			this.#bridge = { ...this.#bridge, current: refreshed, routeGeneration: refreshed.routeGeneration };
			if (this.#stopping || this.#suspended || this.#ctx.collabGuest) return;
			const discoveredCurrentSessionId = this.#session.sessionManager.getSessionId();
			const discoveredSessionId = this.#committedSessionId ?? discoveredCurrentSessionId;
			if (discoveredCurrentSessionId !== sessionId || discoveredSessionId !== sessionId) continue;

			const next = new CollabHost(this.#ctx);
			let terminalReason: string | undefined;
			const transport = createHostBridgeTransport(
				refreshed.address,
				refreshed.token,
				refreshed.paneId,
				sessionId,
				this.#bridge.routeGeneration,
			);
			try {
				await next.startWithTransport(transport, {
					trustedLocal: true,
					privateHost: true,
					onTerminated: reason => {
						terminalReason = reason;
						this.#handleHostTermination(next, sessionId, reason);
					},
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (terminalReason !== undefined) throw error;
				if (message.startsWith("route_busy:")) {
					const now = Date.now();
					routeBusyAttempts += 1;
					routeBusyDeadline ??= now + ROUTE_BUSY_RETRY_DEADLINE_MS;
					const remaining = routeBusyDeadline - now;
					if (remaining <= 0) {
						throw new Error(
							`Herdr OMP bridge route remained busy after ${routeBusyAttempts} attempts over ${ROUTE_BUSY_RETRY_DEADLINE_MS}ms: ${message}`,
						);
					}
					await Bun.sleep(Math.min(routeBusyDelayMs, remaining));
					routeBusyDelayMs = Math.min(routeBusyDelayMs * 2, ROUTE_BUSY_RETRY_MAX_DELAY_MS);
					continue;
				}
				if (!rediscovered) {
					rediscovered = true;
					continue;
				}
				throw error;
			} finally {
				const routeGeneration = transport.routeGeneration;
				if (routeGeneration !== undefined) this.#bridge.routeGeneration = routeGeneration;
			}
			if (terminalReason !== undefined) throw new Error(terminalReason);
			if (this.#stopping || this.#suspended || this.#ctx.collabGuest) {
				await next.stop(this.#stopping ? "session stopped" : suspendedReason);
				return;
			}
			if (this.#session.sessionManager.getSessionId() !== sessionId) {
				await next.stop("session switched");
				continue;
			}
			this.#host = next;
			this.#activeSessionId = sessionId;
			this.#ctx.herdrCollabHost = next;
			return;
		}
	}

	#handleHostTermination(host: CollabHost, sessionId: string, reason: string): void {
		if (this.#host !== host) return;
		this.#host = undefined;
		this.#activeSessionId = undefined;
		if (this.#ctx.herdrCollabHost === host) this.#ctx.herdrCollabHost = undefined;
		if (this.#stopping || this.#suspended || this.#ctx.collabGuest) return;
		if (!this.#reserveTerminalRearm(sessionId, reason)) return;
		void this.#enqueueRearm(true, undefined, `after terminal close (${reason})`).catch(() => {});
	}

	#reserveTerminalRearm(sessionId: string, reason: string): boolean {
		if (this.#terminalRearmSessionId !== sessionId) {
			this.#terminalRearmSessionId = sessionId;
			this.#terminalRearmAttempts = 0;
		}
		if (this.#terminalRearmAttempts >= MAX_TERMINAL_REARMS) {
			this.#ctx.showError(`Herdr OMP bridge ended (${reason}); automatic rearm limit reached`);
			return false;
		}
		this.#terminalRearmAttempts += 1;
		return true;
	}

	async #deactivate(reason: string): Promise<void> {
		const host = this.#host;
		this.#host = undefined;
		this.#activeSessionId = undefined;
		if (host) await host.stop(reason);
		if (this.#ctx.herdrCollabHost === host) this.#ctx.herdrCollabHost = undefined;
	}
}
