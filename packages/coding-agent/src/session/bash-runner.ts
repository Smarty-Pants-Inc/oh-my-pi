import * as path from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { type BashPtyOptions, type BashResult, executeBash as executeBashCommand } from "../exec/bash-executor";
import type { ExtensionRunner } from "../extensibility/extensions";
import { outputMeta } from "../tools/output-meta";
import { clampTimeout } from "../tools/tool-timeouts";
import type { BashExecutionMessage } from "./messages";
import type { SessionManager } from "./session-manager";

/** Destination that owns a bash result after a session or branch transition. */
export type BashAppendDestination =
	| { kind: "current"; manager: SessionManager }
	| { kind: "detached"; manager: SessionManager }
	| { kind: "branch"; manager: SessionManager; parentId: string | null }
	| { kind: "discarded" };
type BashLiveAppendDestination = Exclude<BashAppendDestination, { kind: "discarded" }>;

const DISCARDED_BASH_DESTINATION: BashAppendDestination = { kind: "discarded" };

interface BashCommandLifetime {
	retainedSide: boolean;
}

/** Reference-counted session target captured when a bash execution starts. */
export interface BashSessionTarget {
	sessionId: string;
	refs: number;
	destination?: BashAppendDestination;
	pending?: Promise<BashAppendDestination>;
	pendingSettlements: Set<Promise<unknown>>;
	commandSettlements: Set<Promise<unknown>>;
	commandLifetimes: Set<BashCommandLifetime>;
	abortControllers: Set<AbortController>;
	discarded: boolean;
	appendError?: unknown;
}

interface PendingBashMessage {
	target: BashSessionTarget;
	message: BashExecutionMessage;
}

/** Ownership snapshot spanning a session or branch transition. */
export interface BashSessionTransition {
	oldTarget: BashSessionTarget;
	newTarget: BashSessionTarget;
	oldSessionId: string;
	oldSessionFile: string | undefined;
	oldLeafId: string | null;
	detachedManager: SessionManager | undefined;
	resolveOld: ((destination: BashAppendDestination) => void) | undefined;
	resolveNew: (destination: BashAppendDestination) => void;
}
interface BashSessionTransitionState {
	phase: "pending" | "preparing" | "prepared" | "finished";
	selection?: boolean;
	provisionalOldDestination?: BashLiveAppendDestination;
	provisionalNewDestination?: BashLiveAppendDestination;
	rollbackOldDestination?: BashLiveAppendDestination;
	provisionalMessages: Array<{ side: "old" | "new"; message: BashExecutionMessage }>;
	preparedOld?: {
		promise: Promise<BashAppendDestination>;
		resolve: (destination: BashAppendDestination) => void;
	};
	preparedNew?: {
		promise: Promise<BashAppendDestination>;
		resolve: (destination: BashAppendDestination) => void;
	};
}

interface BashTargetTransitionOwner {
	transition: BashSessionTransition;
	side: "old" | "new";
}

/** Capabilities the bash runner borrows from its owning session. */
export interface BashRunnerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	extensionRunner(): ExtensionRunner | undefined;
	isStreaming(): boolean;
}

/** Owns bash execution and preserves result ownership across transcript transitions. */
export class BashRunner {
	readonly #host: BashRunnerHost;
	#abortControllers = new Set<AbortController>();
	#pendingMessages: PendingBashMessage[] = [];
	#sessionTarget: BashSessionTarget;
	#sessionTransitions = new WeakMap<BashSessionTransition, BashSessionTransitionState>();
	#targetTransitionOwners = new WeakMap<BashSessionTarget, BashTargetTransitionOwner>();

	constructor(host: BashRunnerHost) {
		this.#host = host;
		this.#sessionTarget = {
			sessionId: host.sessionManager.getSessionId(),
			refs: 0,
			destination: { kind: "current", manager: host.sessionManager },
			pendingSettlements: new Set(),
			commandSettlements: new Set(),
			commandLifetimes: new Set(),
			abortControllers: new Set(),
			discarded: false,
		};
	}

	/** Executes a bash command while retaining the session and branch that owned its start. */
	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean; pty?: BashPtyOptions },
	): Promise<BashResult> {
		const target = this.#captureSessionTarget();
		const lifetime: BashCommandLifetime = { retainedSide: false };
		target.commandLifetimes.add(lifetime);
		return this.#trackTargetCommandSettlement(
			target,
			lifetime,
			this.#executeBashForTarget(target, lifetime, command, onChunk, options),
		);
	}

	async #executeBashForTarget(
		target: BashSessionTarget,
		lifetime: BashCommandLifetime,
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean; pty?: BashPtyOptions },
	): Promise<BashResult> {
		let targetTransferred = false;
		const excludeFromContext = options?.excludeFromContext === true;
		const cwd = this.#host.sessionManager.getCwd();
		const abortController = new AbortController();
		this.#abortControllers.add(abortController);
		target.abortControllers.add(abortController);
		if (target.discarded) abortController.abort();
		try {
			const extensionRunner = this.#host.extensionRunner();
			if (extensionRunner?.hasHandlers("user_bash")) {
				const hookResult = await extensionRunner.emitUserBash({
					type: "user_bash",
					command,
					excludeFromContext,
					cwd,
				});
				if (hookResult?.result) {
					targetTransferred = true;
					await this.#recordResultForTarget(target, lifetime.retainedSide, command, hookResult.result, options);
					return hookResult.result;
				}
			}

			// The hook's adapter forwards only entries that differ from the baseline
			// it is handed, and the child shell starts from the (cached, filtered)
			// spawn env — NOT from live process.env. Diffing against process.env
			// cancels out any variable an extension both mirrors into process.env
			// and injects via its hook (e.g. the secretsd session token file), so
			// hand the hook the env the child will actually receive. Pass a copy:
			// this.#host.settings.getShellConfig().env is a cached, shared object,
			// and a legacy hook that mutates its context.env in place (a supported
			// pattern) would otherwise poison that cache for every later command.
			const shellEnv =
				options?.useUserShell === true
					? extensionRunner
							?.getRegisteredTool("bash")
							?.definition.shellEnv?.({ command, cwd, env: { ...this.#host.settings.getShellConfig().env } })
					: undefined;

			const result = await executeBashCommand(command, {
				onChunk,
				signal: abortController.signal,
				sessionKey: target.sessionId,
				cwd,
				timeout: clampTimeout("bash", undefined, this.#host.settings.get("tools.maxTimeout")) * 1000,
				onMinimizedSave: originalText => this.#saveOriginalArtifact(target, originalText),
				env: shellEnv,
				useUserShell: options?.useUserShell,
				pty: options?.pty,
			});
			targetTransferred = true;
			await this.#recordResultForTarget(target, lifetime.retainedSide, command, result, options);
			return result;
		} finally {
			target.abortControllers.delete(abortController);
			this.#abortControllers.delete(abortController);
			if (!targetTransferred) await this.#releaseSessionTarget(target);
		}
	}

	/** Records a bash result supplied outside executeBash in the current ownership scope. */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const target = this.#captureSessionTarget();
		const message = this.#createMessage(command, result, options);
		if (target.discarded) {
			const release = this.#releaseSessionTarget(target).catch(error => {
				target.appendError ??= error;
				throw error;
			});
			void this.#trackTargetSettlement(target, release).catch(error => {
				logger.error("Failed to release discarded bash result ownership", { error: String(error) });
			});
			return;
		}
		if (this.#host.isStreaming() && target === this.#sessionTarget) {
			this.#pendingMessages.push({ target, message });
			return;
		}
		if (target.destination) {
			try {
				this.#appendMessage(target.destination, message);
				const owner = this.#targetTransitionOwners.get(target);
				const transitionState = owner && this.#sessionTransitions.get(owner.transition);
				if (owner && transitionState?.phase === "preparing") {
					transitionState.provisionalMessages.push({ side: owner.side, message });
				}
			} catch (error) {
				target.appendError ??= error;
				throw error;
			} finally {
				const release = this.#releaseSessionTarget(target).catch(error => {
					target.appendError ??= error;
					throw error;
				});
				void this.#trackTargetSettlement(target, release).catch(error => {
					logger.error("Failed to release bash result ownership", { error: String(error) });
				});
			}
			return;
		}
		void this.#appendOwnedMessage(target, message).catch(error => {
			logger.error("Failed to record bash result in its owning session", { error: String(error) });
		});
	}

	/** Cancels every running bash command. */
	abort(): void {
		for (const abortController of this.#abortControllers) abortController.abort();
	}

	/** Whether a bash command is currently running. */
	get isRunning(): boolean {
		return this.#abortControllers.size > 0;
	}

	/** Whether bash results are waiting for a safe persistence boundary. */
	get hasPendingMessages(): boolean {
		return this.#pendingMessages.length > 0;
	}

	/** Flushes deferred bash results without changing their captured ownership. */
	async flushPending(): Promise<void> {
		if (this.#pendingMessages.length === 0) return;
		const pending = this.#pendingMessages;
		this.#pendingMessages = [];
		for (const { target, message } of pending) await this.#appendOwnedMessage(target, message);
	}

	/** Drain already-completed retained results, then atomically fence later Bash ownership. */
	async beginSessionTransitionAfterFlushingPending(options?: {
		persistDetached?: boolean;
	}): Promise<BashSessionTransition> {
		while (this.#pendingMessages.length > 0) await this.flushPending();
		return this.beginSessionTransition(options);
	}

	/** Runs a leaf rewrite while retaining in-flight bash on its originating branch. */
	withBranchTransition<T>(mutate: () => T): T {
		const transition = this.beginSessionTransition();
		let transitioned = false;
		try {
			const result = mutate();
			this.markSessionTransition(transition);
			transitioned = true;
			return result;
		} finally {
			this.finishSessionTransition(transition, transitioned);
		}
	}

	/** Snapshots the owner of in-flight bash before a session or branch transition. */
	beginSessionTransition(options?: { persistDetached?: boolean }): BashSessionTransition {
		const oldTarget = this.#sessionTarget;
		for (const lifetime of oldTarget.commandLifetimes) lifetime.retainedSide = true;
		let detachedManager: SessionManager | undefined;
		let resolveOld: ((destination: BashAppendDestination) => void) | undefined;
		if (oldTarget.refs > 0) {
			detachedManager = this.#host.sessionManager.cloneCurrentSession({ persist: options?.persistDetached });
			const pendingOld = Promise.withResolvers<BashAppendDestination>();
			oldTarget.destination = undefined;
			oldTarget.pending = pendingOld.promise;
			resolveOld = pendingOld.resolve;
		}
		const pendingNew = Promise.withResolvers<BashAppendDestination>();
		const transition: BashSessionTransition = {
			oldTarget,
			newTarget: {
				sessionId: this.#host.sessionManager.getSessionId(),
				refs: 0,
				pending: pendingNew.promise,
				pendingSettlements: new Set(),
				commandSettlements: new Set(),
				commandLifetimes: new Set(),
				abortControllers: new Set(),
				discarded: false,
			},
			oldSessionId: oldTarget.sessionId,
			oldSessionFile: this.#host.sessionManager.getSessionFile(),
			oldLeafId: this.#host.sessionManager.getLeafId(),
			detachedManager,
			resolveOld,
			resolveNew: pendingNew.resolve,
		};
		const state: BashSessionTransitionState = {
			phase: "pending",
			provisionalMessages: [],
		};
		this.#sessionTransitions.set(transition, state);
		this.#targetTransitionOwners.set(oldTarget, { transition, side: "old" });
		this.#targetTransitionOwners.set(transition.newTarget, { transition, side: "new" });
		return transition;
	}

	/** Adopts a transition's new target as the live bash owner. */
	markSessionTransition(transition: BashSessionTransition): void {
		transition.newTarget.sessionId = this.#host.sessionManager.getSessionId();
		this.#sessionTarget = transition.newTarget;
	}

	/**
	 * Provisionally settles Bash work that already completed without selecting the
	 * lifecycle outcome. Work completing after this barrier waits for commit or
	 * rollback, so artifact sealing and retained restoration remain authoritative.
	 */
	async prepareCommit(transition: BashSessionTransition): Promise<void> {
		const state = this.#sessionTransitions.get(transition);
		if (!state) throw new Error("Unknown Bash session transition");
		if (state.phase === "prepared") return;
		if (state.phase !== "pending") throw new Error("Bash session transition cannot be prepared now");

		state.phase = "preparing";
		if (transition.resolveOld) state.preparedOld = Promise.withResolvers<BashAppendDestination>();
		state.preparedNew = Promise.withResolvers<BashAppendDestination>();
		const provisional = this.#sessionTransitionDestinations(transition);
		state.provisionalOldDestination = provisional.oldDestination;
		state.provisionalNewDestination = provisional.newDestination;
		this.#resolveInitialSessionTransition(transition, provisional);

		const failures: unknown[] = [];
		while (true) {
			try {
				await this.awaitSessionTransition(transition);
			} catch (error) {
				failures.push(error);
			}
			const unsettled = [...transition.oldTarget.pendingSettlements, ...transition.newTarget.pendingSettlements];
			if (unsettled.length === 0) break;
			await Promise.allSettled(unsettled);
			if (transition.oldTarget.pendingSettlements.size === 0 && transition.newTarget.pendingSettlements.size === 0) {
				break;
			}
		}

		if (transition.resolveOld) {
			transition.oldTarget.destination = undefined;
			transition.oldTarget.pending = state.preparedOld!.promise;
		}
		if (transition.newTarget.discarded) {
			transition.newTarget.pending = undefined;
			transition.newTarget.destination = DISCARDED_BASH_DESTINATION;
			state.preparedNew!.resolve(DISCARDED_BASH_DESTINATION);
		} else {
			transition.newTarget.destination = undefined;
			transition.newTarget.pending = state.preparedNew!.promise;
		}
		state.phase = "prepared";

		const managers = new Set<SessionManager>();
		if (transition.resolveOld) managers.add(provisional.oldDestination.manager);
		managers.add(provisional.newDestination.manager);
		for (const manager of managers) {
			try {
				await manager.flush();
			} catch (error) {
				failures.push(error);
			}
		}

		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, "Bash result settlement failed during lifecycle preparation");
		}
	}

	/** Discards and settles only work owned by a transition's provisional target. */
	async prepareRollback(transition: BashSessionTransition): Promise<void> {
		const state = this.#sessionTransitions.get(transition);
		if (!state) throw new Error("Unknown Bash session transition");
		if (state.phase === "finished" && state.selection !== true) return;

		const target = transition.newTarget;
		target.discarded = true;
		target.pending = undefined;
		target.destination = DISCARDED_BASH_DESTINATION;
		transition.resolveNew(DISCARDED_BASH_DESTINATION);
		state.preparedNew?.resolve(DISCARDED_BASH_DESTINATION);
		for (const abortController of target.abortControllers) abortController.abort();

		const retainedPending: PendingBashMessage[] = [];
		for (const pending of this.#pendingMessages) {
			if (pending.target !== target) {
				retainedPending.push(pending);
				continue;
			}
			const release = this.#releaseSessionTarget(target).catch(error => {
				target.appendError ??= error;
				throw error;
			});
			void this.#trackTargetSettlement(target, release).catch(error => {
				logger.error("Failed to discard pending bash result ownership", { error: String(error) });
			});
		}
		this.#pendingMessages = retainedPending;

		while (target.commandSettlements.size > 0 || target.pendingSettlements.size > 0) {
			await Promise.allSettled([...target.commandSettlements, ...target.pendingSettlements]);
		}
		target.appendError = undefined;
	}

	/** Replay retained-side provisional Bash messages, then restore the retained owner. */
	async rollbackSessionTransition(transition: BashSessionTransition): Promise<void> {
		const state = this.#sessionTransitions.get(transition);
		const failures: unknown[] = [];
		const rollbackManagers = new Set<SessionManager>();
		try {
			await this.prepareRollback(transition);
		} catch (error) {
			failures.push(error);
		}
		if (state && (state.phase === "prepared" || (state.phase === "finished" && state.selection === true))) {
			const { oldDestination } = this.#sessionTransitionDestinations(transition);
			state.rollbackOldDestination = oldDestination;
			rollbackManagers.add(oldDestination.manager);
			for (const provisional of state.provisionalMessages) {
				if (provisional.side !== "old") continue;
				try {
					this.#appendMessage(oldDestination, provisional.message);
				} catch (error) {
					failures.push(error);
				}
			}
		}

		try {
			this.finishSessionTransition(transition, false);
			await this.awaitSessionTransition(transition);
		} catch (error) {
			failures.push(error);
		}
		for (const manager of rollbackManagers) {
			try {
				await manager.flush();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, "Bash lifecycle ownership rollback was incomplete");
		}
	}
	/** Selects a reversible destination before target sealing or after retained restoration. */
	finishSessionTransition(transition: BashSessionTransition, success: boolean): void {
		const state = this.#sessionTransitions.get(transition);
		if (!state) return;
		if (state.phase === "finished") {
			if (state.selection === success) return;
			if (state.selection !== true || success) {
				throw new Error("Bash session transition outcome is already selected");
			}
		}
		const liveDestinations = this.#sessionTransitionDestinations(transition);
		const oldDestination =
			success && state.phase === "prepared" && state.provisionalOldDestination
				? state.provisionalOldDestination
				: !success && state.phase === "prepared" && state.rollbackOldDestination
					? state.rollbackOldDestination
					: liveDestinations.oldDestination;
		const newDestination =
			success && state.phase === "prepared" && state.provisionalNewDestination
				? state.provisionalNewDestination
				: success
					? liveDestinations.newDestination
					: DISCARDED_BASH_DESTINATION;

		if (state.phase === "prepared") {
			if (transition.resolveOld) {
				transition.oldTarget.pending = undefined;
				transition.oldTarget.destination = oldDestination;
				state.preparedOld?.resolve(oldDestination);
			}
			transition.newTarget.pending = undefined;
			transition.newTarget.destination = newDestination;
			state.preparedNew?.resolve(newDestination);
		} else if (state.phase !== "finished") {
			if (transition.resolveOld) {
				transition.oldTarget.pending = undefined;
				transition.oldTarget.destination = oldDestination;
				transition.resolveOld(oldDestination);
			}
			transition.newTarget.pending = undefined;
			transition.newTarget.destination = newDestination;
			transition.resolveNew(newDestination);
		}
		if (!success) {
			transition.newTarget.discarded = true;
			transition.oldTarget.pending = undefined;
			transition.oldTarget.destination = oldDestination;
			this.#sessionTarget = transition.oldTarget;
		}
		state.phase = "finished";
		state.selection = success;

		if (transition.detachedManager && (oldDestination.kind !== "detached" || transition.oldTarget.refs === 0)) {
			void transition.detachedManager.close().catch(error => {
				logger.warn("Failed to close detached bash session writer", { error: String(error) });
			});
		}
	}

	/** Wait for results that had already entered append settlement when ownership was provisionally selected. */
	async awaitSessionTransition(transition: BashSessionTransition): Promise<void> {
		await Promise.allSettled([
			...transition.oldTarget.pendingSettlements,
			...transition.newTarget.pendingSettlements,
		]);
		const oldError = transition.oldTarget.appendError;
		const newError = transition.newTarget.appendError;
		transition.oldTarget.appendError = undefined;
		transition.newTarget.appendError = undefined;
		if (oldError !== undefined && newError !== undefined) {
			throw new AggregateError([oldError, newError], "Bash result settlement failed for both lifecycle owners");
		}
		if (oldError !== undefined) throw oldError;
		if (newError !== undefined) throw newError;
	}

	#sessionTransitionDestinations(transition: BashSessionTransition): {
		oldDestination: BashLiveAppendDestination;
		newDestination: BashLiveAppendDestination;
	} {
		const manager = this.#host.sessionManager;
		const currentDestination: BashLiveAppendDestination = { kind: "current", manager };
		let oldDestination: BashLiveAppendDestination = currentDestination;
		if (transition.resolveOld) {
			const currentFile = manager.getSessionFile();
			const sameFile =
				transition.oldSessionFile === currentFile ||
				(transition.oldSessionFile !== undefined &&
					currentFile !== undefined &&
					path.resolve(transition.oldSessionFile) === path.resolve(currentFile));
			const sameSession = transition.oldSessionId === manager.getSessionId() && sameFile;
			if (sameSession) {
				oldDestination = { kind: "branch", manager, parentId: transition.oldLeafId };
			} else if (transition.detachedManager) {
				oldDestination = { kind: "detached", manager: transition.detachedManager };
			}
		}
		return { oldDestination, newDestination: currentDestination };
	}

	#resolveInitialSessionTransition(
		transition: BashSessionTransition,
		destinations: { oldDestination: BashLiveAppendDestination; newDestination: BashLiveAppendDestination },
	): void {
		if (transition.resolveOld) {
			transition.oldTarget.pending = undefined;
			transition.oldTarget.destination = destinations.oldDestination;
			transition.resolveOld(destinations.oldDestination);
		}
		transition.newTarget.pending = undefined;
		transition.newTarget.destination = destinations.newDestination;
		transition.resolveNew(destinations.newDestination);
	}

	async #saveOriginalArtifact(target: BashSessionTarget, originalText: string): Promise<string | undefined> {
		try {
			if (target.discarded) return undefined;
			let destination = target.destination ?? (await target.pending);
			if (target.discarded || destination?.kind === "discarded") return undefined;
			const owner = this.#targetTransitionOwners.get(target);
			const transitionState = owner && this.#sessionTransitions.get(owner.transition);
			if (owner && (transitionState?.phase === "preparing" || transitionState?.phase === "prepared")) {
				const outcome = owner.side === "old" ? transitionState.preparedOld : transitionState.preparedNew;
				if (outcome) destination = await outcome.promise;
			}
			if (target.discarded || destination?.kind === "discarded") return undefined;
			return await destination?.manager.saveArtifact(originalText, "bash-original");
		} catch {
			return undefined;
		}
	}

	#createMessage(
		command: string,
		result: BashResult,
		options?: { excludeFromContext?: boolean },
	): BashExecutionMessage {
		const meta = outputMeta().truncationFromSummary(result, { direction: "tail" }).get();
		return {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			meta,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};
	}

	#captureSessionTarget(): BashSessionTarget {
		this.#sessionTarget.refs++;
		return this.#sessionTarget;
	}

	async #releaseSessionTarget(target: BashSessionTarget): Promise<void> {
		if (target.refs <= 0) throw new Error("Bash session target released more than once");
		target.refs--;
		if (target.refs === 0 && target.destination?.kind === "detached") await target.destination.manager.close();
	}

	#appendMessage(destination: BashAppendDestination, message: BashExecutionMessage): void {
		switch (destination.kind) {
			case "current":
				this.#host.agent.appendMessage(message);
				destination.manager.appendMessage(message);
				break;
			case "detached":
				destination.manager.appendMessage(message);
				break;
			case "branch":
				if (
					destination.manager === this.#host.sessionManager &&
					destination.parentId === destination.manager.getLeafId()
				) {
					this.#host.agent.appendMessage(message);
					destination.parentId = destination.manager.appendMessage(message);
				} else {
					destination.parentId = destination.manager.appendMessageToBranch(message, destination.parentId);
				}
				break;
			case "discarded":
				break;
		}
	}

	async #appendOwnedMessage(target: BashSessionTarget, message: BashExecutionMessage): Promise<void> {
		const append = (async () => {
			try {
				if (target.discarded) return;
				const destination = target.destination ?? (await target.pending);
				if (!destination) throw new Error("Bash session target has no append destination");
				if (target.discarded || destination.kind === "discarded") return;
				this.#appendMessage(destination, message);
				const owner = this.#targetTransitionOwners.get(target);
				const transitionState = owner && this.#sessionTransitions.get(owner.transition);
				if (owner && transitionState?.phase === "preparing") {
					transitionState.provisionalMessages.push({ side: owner.side, message });
				}
			} finally {
				await this.#releaseSessionTarget(target);
			}
		})();
		const trackedAppend = this.#trackTargetSettlement(
			target,
			append.catch(error => {
				target.appendError ??= error;
				throw error;
			}),
		);
		await trackedAppend;
	}

	#trackTargetSettlement<T>(target: BashSessionTarget, settlement: Promise<T>): Promise<T> {
		const tracked = settlement.finally(() => {
			target.pendingSettlements.delete(tracked);
		});
		target.pendingSettlements.add(tracked);
		return tracked;
	}

	#trackTargetCommandSettlement<T>(
		target: BashSessionTarget,
		lifetime: BashCommandLifetime,
		settlement: Promise<T>,
	): Promise<T> {
		const tracked = settlement.finally(() => {
			target.commandSettlements.delete(tracked);
			target.commandLifetimes.delete(lifetime);
		});
		target.commandSettlements.add(tracked);
		return tracked;
	}

	async #recordResultForTarget(
		target: BashSessionTarget,
		retainedSide: boolean,
		command: string,
		result: BashResult,
		options?: { excludeFromContext?: boolean },
	): Promise<void> {
		const message = this.#createMessage(command, result, options);
		if (!target.discarded && !retainedSide && this.#host.isStreaming() && target === this.#sessionTarget) {
			this.#pendingMessages.push({ target, message });
			return;
		}
		await this.#appendOwnedMessage(target, message);
	}
}
