/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient via the global
 * AgentRegistry — parked agents are revived through the
 * AgentLifecycleManager, idle agents are woken with a real turn, and busy
 * agents receive the message as a non-interrupting aside at the next step
 * boundary (see AgentSession.deliverIrcMessage). Replies are real turns by
 * the recipient, observed via `wait` — with one exception: when the sender
 * awaits a reply and the recipient cannot run a real reply turn in time
 * (mid-turn with async execution disabled — possibly blocked in a
 * synchronous task spawn whose batch includes the sender — or idle in plan
 * mode, where autonomous wake turns are suppressed), the recipient session
 * generates an ephemeral side-channel auto-reply.
 */

import { createHash } from "node:crypto";
import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { ISO8601, Sha256Ref } from "../registry/persistent-agent-contracts.js";
import type { CustomMessage } from "../session/messages";
import {
	buildTransientTaskHubWaitMessageCanonicalRecordV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationPlanV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationReceiptV1,
	type ConfidentialTransientTaskHubWaitConsumedMessageV1,
	type ConfidentialTransientTaskHubWaitDurableMessageSelectorDecisionV1,
	type ConfidentialTransientTaskHubWaitMessageSelectorInstallRequestV1,
	type ConfidentialTransientTaskHubWaitMessageSourceSelectionResultV1,
	canonicalRuntimeSha256,
	type TransientTaskHubWaitDurableMessageSelectorV1,
	type TransientTaskHubWaitIrcBusSelectionBridgeV1,
} from "../session/workspace-runtime-contracts";

export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
}

export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}

interface IrcWaiter {
	from?: string;
	offered: boolean;
	hubSelector?: ConfidentialTransientTaskHubWaitMessageSelectorInstallRequestV1;
	preselectionClaimSha256?: Sha256Ref;
	currentAuthoritySha256?: Sha256Ref;
	decision?: ConfidentialTransientTaskHubWaitDurableMessageSelectorDecisionV1;
	offer: (msg: IrcMessage) => Promise<"consumed" | "pass" | "blocked">;
	cancel: () => void;
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

export class IrcBus implements TransientTaskHubWaitIrcBusSelectionBridgeV1 {
	static #global: IrcBus | undefined;

	static global(): IrcBus {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	#hubWaiterRevision = 0;
	readonly #hubWaiterSelections = new Map<
		string,
		ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationReceiptV1
	>();
	readonly #waiters = new Map<string, IrcWaiter[]>();

	constructor(registry: AgentRegistry = AgentRegistry.global(), lifecycle?: AgentLifecycleManager) {
		this.#registry = registry;
		// Lazy: the lifecycle global self-constructs against the global registry,
		// so only touch it when a parked recipient actually needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.global();
	}

	/**
	 * Fire-and-forget delivery. Never blocks on the recipient generating
	 * anything: the receipt reports how the message reached the recipient
	 * (waiter/aside = "injected", idle wake = "woken", park revival =
	 * "revived"), not what they did with it.
	 *
	 * Mailbox semantics: a successfully delivered message never lingers in
	 * the recipient's mailbox — injection/wake puts the full body into their
	 * context, so buffering it too would double-deliver via a later
	 * `wait`/`inbox` and inflate unread counts. Only a failed live hand-off
	 * is buffered for the recipient to drain later.
	 *
	 * `opts.expectsReply` marks sends whose caller is blocked on an answer
	 * (`send await:true`). It is forwarded to the recipient session so a
	 * mid-turn recipient that cannot reach a step boundary (async execution
	 * disabled — e.g. blocked in a synchronous task spawn awaiting the
	 * sender's own batch) can generate an ephemeral side-channel auto-reply
	 * instead of stranding the sender until timeout.
	 *
	 * `opts.suppressRelay` skips the display-only main-UI relay for this leg.
	 * Set by broadcast fan-out when the same broadcast also targets the main
	 * agent directly: the main agent then already sees the body as its own
	 * incoming card, so relaying the sibling legs would duplicate it.
	 */
	async send(
		msg: Omit<IrcMessage, "id" | "ts">,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryReceipt> {
		const message: IrcMessage = { ...msg, id: Snowflake.next(), ts: Date.now() };
		const ref = this.#registry.get(message.to);
		if (!ref) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Unknown agent "${message.to}" — check \`irc list\` for live peers.`,
			};
		}
		if (ref.status === "aborted") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" was hard-aborted and cannot be messaged or revived. Its transcript remains readable at history://${message.to}.`,
			};
		}
		// Advisor refs are observability-only transcripts, never messageable peers.
		if (ref.kind === "advisor") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}

		// A `parked` recipient always needs the lifecycle to revive it — this is
		// read from *this* bus's registry, so it holds for any registry. The
		// mid-park / adopted checks below query the lifecycle's own state, which
		// only describes the registry it manages: consult them only when the
		// lifecycle owns this bus's registry, otherwise a custom-registry bus
		// (fallen back to the global manager) would gate a live recipient on
		// unrelated global park state. Main/non-adopted live peers skip the gate,
		// and pending waiters still win without a session.
		const lifecycle = this.#lifecycle();
		const lifecycleOwnsRegistry = lifecycle.manages(this.#registry);
		const needsLifecycleGate =
			ref.status === "parked" ||
			(lifecycleOwnsRegistry && (lifecycle.isParking(message.to) || lifecycle.has(message.to)));

		const priorSession = ref.session;
		let revived = false;
		if (needsLifecycleGate) {
			try {
				const liveSession = await lifecycle.ensureLive(message.to);
				// Revival = we did not keep the same live instance (parked start, or
				// park completed and a fresh session was rebuilt).
				revived = !priorSession || liveSession !== priorSession;
			} catch (error) {
				// Not revivable / released / revive failed. Do not buffer: a permanent
				// failure must not inflate unread counts or pretend delivery is pending.
				return {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		// A pending waiter receives first refusal, but source ownership is retained
		// until its offer resolves. Durable Hub waiters run their selector before
		// this method acknowledges, removes, relays, or hands the candidate onward.
		const waiter = this.#claimMatchingWaiter(message.to, message.from);
		if (waiter) {
			let disposition: "consumed" | "pass" | "blocked";
			try {
				disposition = await waiter.offer(message);
			} catch (error) {
				this.#enqueue(message);
				return {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
			if (disposition === "consumed") {
				if (!opts?.suppressRelay) this.#relayToMainUi(message);
				return { to: message.to, outcome: revived ? "revived" : "injected" };
			}
			if (disposition === "blocked") {
				this.#enqueue(message);
				return { to: message.to, outcome: "failed", error: "Hub message selection is durably indeterminate." };
			}
		}

		const session = this.#registry.get(message.to)?.session;
		if (!session) {
			return { to: message.to, outcome: "failed", error: `Agent "${message.to}" has no live session.` };
		}

		try {
			const delivery = await session.deliverIrcMessage(message, opts);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : delivery };
		} catch (error) {
			// Live hand-off failed (e.g. recipient disposed mid-shutdown): buffer
			// the message so a later `wait`/`inbox` from the recipient can still
			// pick it up. The receipt stays "failed" — the recipient has not
			// seen it.
			this.#enqueue(message);
			return {
				to: message.to,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Block until a message for `agentId` (optionally from `filter.from`)
	 * arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: { from?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean; liveness?: { registry: AgentRegistry; senderId: string } },
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.#takeFromMailbox(agentId, filter.from);
			if (pending) return pending;
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		let unsubscribeLiveness: (() => void) | undefined;

		const liveness = options?.liveness;
		const livenessReason = filter.from
			? `IRC wait aborted: agent "${filter.from}" is not running`
			: "IRC wait aborted: no running peers remain";

		const settle = (
			outcome: { kind: "message"; msg: IrcMessage } | { kind: "timeout" } | { kind: "abort"; error: Error },
		): void => {
			cleanup();
			if (outcome.kind === "message") {
				resolve(outcome.msg);
			} else if (outcome.kind === "timeout") {
				resolve(null);
			} else {
				reject(outcome.error);
			}
		};

		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			unsubscribeLiveness?.();
		};

		const waiter: IrcWaiter = {
			from: filter.from,
			offered: false,
			offer: async msg => {
				settle({ kind: "message", msg });
				return "consumed";
			},
			cancel: () => cleanup(),
		};

		if (signal) {
			onAbort = () =>
				settle({
					kind: "abort",
					error: signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"),
				});
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
			timer.unref?.();
		}

		let waiters = this.#waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(agentId, waiters);
		}
		waiters.push(waiter);

		if (liveness) {
			const { registry, senderId } = liveness;
			const hasRunningSender = (from?: string): boolean =>
				registry.listVisibleTo(senderId).some(ref => ref.status === "running" && (!from || ref.id === from));
			const check = filter.from ? () => hasRunningSender(filter.from) : () => hasRunningSender();
			unsubscribeLiveness = registry.onChange(() => {
				if (!check()) {
					settle({ kind: "abort", error: new Error(livenessReason) });
				}
			});
			if (!check()) {
				settle({ kind: "abort", error: new Error(livenessReason) });
			}
		}

		return promise;
	}

	/** Drain (or peek) pending messages for `agentId`. */
	inbox(agentId: string, opts?: { peek?: boolean }): IrcMessage[] {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox || mailbox.length === 0) return [];
		if (opts?.peek) return [...mailbox];
		this.#mailboxes.delete(agentId);
		return mailbox;
	}

	unreadCount(agentId: string): number {
		return this.#mailboxes.get(agentId)?.length ?? 0;
	}

	#enqueue(message: IrcMessage): void {
		let mailbox = this.#mailboxes.get(message.to);
		if (!mailbox) {
			mailbox = [];
			this.#mailboxes.set(message.to, mailbox);
		}
		mailbox.push(message);
		if (mailbox.length > MAILBOX_CAP) {
			const dropped = mailbox.shift();
			logger.debug("IrcBus: mailbox full, dropped oldest message", {
				agentId: message.to,
				droppedId: dropped?.id,
				droppedFrom: dropped?.from,
			});
		}
	}

	/** Claim the oldest matching waiter without removing it before its offer settles. */
	#claimMatchingWaiter(agentId: string, from: string): IrcWaiter | undefined {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return undefined;
		const waiter = waiters.find(candidate => !candidate.offered && (!candidate.from || candidate.from === from));
		if (!waiter) return undefined;
		waiter.offered = true;
		this.#hubWaiterRevision += 1;
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		this.#hubWaiterRevision += 1;
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#peekFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox || mailbox.length === 0) return undefined;
		return from ? mailbox.find(message => message.from === from) : mailbox[0];
	}

	#removeMailboxMessage(agentId: string, expected: IrcMessage): boolean {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return false;
		const index = mailbox.indexOf(expected);
		if (index === -1) return false;
		mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return true;
	}

	async #hubCandidate(message: IrcMessage): Promise<ConfidentialTransientTaskHubWaitConsumedMessageV1> {
		const core = {
			schemaVersion: 1 as const,
			id: message.id,
			from: message.from,
			to: message.to,
			body: message.body,
			ts: message.ts,
			replyTo: message.replyTo ?? null,
		};
		return {
			...core,
			messageSha256: `sha256:${await canonicalRuntimeSha256([
				"omp-transient-task-hub-wait-v1",
				"hub_wait_consumed_message",
				1,
				core.id,
				core.from,
				core.to,
				core.body,
				core.ts,
				core.replyTo,
			])}`,
		};
	}

	async waitForHubMessageWithDurableSelection(
		selector: ConfidentialTransientTaskHubWaitMessageSelectorInstallRequestV1,
		preselectionClaimSha256: Sha256Ref,
		currentAuthoritySha256: Sha256Ref,
		timeoutMs: number,
		select: TransientTaskHubWaitDurableMessageSelectorV1,
		signal?: AbortSignal,
	): Promise<ConfidentialTransientTaskHubWaitMessageSourceSelectionResultV1> {
		const agentId = selector.key.senderId;
		const from = selector.key.fromFilter ?? undefined;
		const closeWithoutCandidate = (
			status: "timeout_before_selection" | "cancelled_before_selection",
		): ConfidentialTransientTaskHubWaitMessageSourceSelectionResultV1 => ({
			status,
			key: selector.key,
			selectorInstallRequestSha256: selector.selectorInstallRequestSha256,
		});
		if (signal?.aborted) return closeWithoutCandidate("cancelled_before_selection");

		const pending = this.#peekFromMailbox(agentId, from);
		if (pending) {
			const decision = await select(await this.#hubCandidate(pending));
			if (
				decision.status === "selected" ||
				decision.status === "already_selected" ||
				decision.status === "adopted"
			) {
				if (!this.#removeMailboxMessage(agentId, pending)) {
					throw new Error("Hub-selected IRC mailbox candidate changed before dequeue");
				}
			}
			return decision;
		}

		const { promise, resolve, reject } =
			Promise.withResolvers<ConfidentialTransientTaskHubWaitMessageSourceSelectionResultV1>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		let unsubscribeLiveness: (() => void) | undefined;
		let settled = false;
		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			unsubscribeLiveness?.();
		};
		const finish = (result: ConfidentialTransientTaskHubWaitMessageSourceSelectionResultV1): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const waiter: IrcWaiter = {
			from,
			offered: false,
			offer: async message => {
				let decision: ConfidentialTransientTaskHubWaitDurableMessageSelectorDecisionV1;
				try {
					decision = await select(await this.#hubCandidate(message));
				} catch (error) {
					fail(error);
					throw error;
				}
				waiter.decision = decision;
				finish(decision);
				return decision.status === "selected" ||
					decision.status === "already_selected" ||
					decision.status === "adopted"
					? "consumed"
					: decision.status === "blocked_indeterminate"
						? "blocked"
						: "pass";
			},
			hubSelector: selector,
			preselectionClaimSha256,
			currentAuthoritySha256,
			cancel: () => finish(closeWithoutCandidate("cancelled_before_selection")),
		};
		let waiters = this.#waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(agentId, waiters);
		}
		waiters.push(waiter);
		this.#hubWaiterRevision += 1;
		if (signal) {
			onAbort = () => finish(closeWithoutCandidate("cancelled_before_selection"));
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => finish(closeWithoutCandidate("timeout_before_selection")), timeoutMs);
			timer.unref?.();
		}
		const hasRunningSender = (candidate?: string): boolean =>
			this.#registry
				.listVisibleTo(agentId)
				.some(ref => ref.status === "running" && (!candidate || ref.id === candidate));
		const checkLiveness = (): void => {
			if (from ? hasRunningSender(from) : hasRunningSender()) return;
			if (from) {
				const errorTextUtf8 = `IRC wait aborted: agent "${from}" is not running` as const;
				finish({
					status: "peer_liveness_ended_before_selection",
					peerLivenessExit: {
						reason: "filtered_sender_not_running",
						fromFilter: from,
						errorTextUtf8,
						errorTextUtf8Sha256: `sha256:${createHash("sha256").update(errorTextUtf8, "utf8").digest("hex")}`,
						errorTextUtf8ByteLength: Buffer.byteLength(errorTextUtf8, "utf8"),
					},
					key: selector.key,
					selectorInstallRequestSha256: selector.selectorInstallRequestSha256,
				});
				return;
			}
			const errorTextUtf8 = "IRC wait aborted: no running peers remain" as const;
			finish({
				status: "peer_liveness_ended_before_selection",
				peerLivenessExit: {
					reason: "no_running_peers",
					fromFilter: null,
					errorTextUtf8,
					errorTextUtf8Sha256: `sha256:${createHash("sha256").update(errorTextUtf8, "utf8").digest("hex")}`,
					errorTextUtf8ByteLength: Buffer.byteLength(errorTextUtf8, "utf8"),
				},
				key: selector.key,
				selectorInstallRequestSha256: selector.selectorInstallRequestSha256,
			});
		};
		unsubscribeLiveness = this.#registry.onChange(checkLiveness);
		checkLiveness();
		return promise;
	}

	#hubWaiterAuthority(agentId: string): { readonly authoritySha256: Sha256Ref; readonly revision: number } {
		const members = (this.#waiters.get(agentId) ?? [])
			.filter(waiter => waiter.hubSelector && waiter.preselectionClaimSha256 && waiter.currentAuthoritySha256)
			.map(
				waiter =>
					[
						waiter.hubSelector!.selectorInstallRequestSha256,
						waiter.preselectionClaimSha256!,
						waiter.currentAuthoritySha256!,
						waiter.offered,
					] as const,
			)
			.sort((left, right) => left[0].localeCompare(right[0]));
		return {
			authoritySha256: `sha256:${createHash("sha256")
				.update(
					JSON.stringify([
						"omp-hub-send-await-outbound-v1",
						"waiter-selector-authority",
						1,
						agentId,
						this.#hubWaiterRevision,
						members,
					]),
					"utf8",
				)
				.digest("hex")}`,
			revision: this.#hubWaiterRevision,
		};
	}

	observeHubSendAwaitTargetWaiter(
		agentId: string,
		from: string,
	): {
		readonly authority: { readonly authoritySha256: Sha256Ref; readonly revision: number };
		readonly selector: ConfidentialTransientTaskHubWaitMessageSelectorInstallRequestV1 | null;
		readonly preselectionClaimSha256: Sha256Ref | null;
		readonly currentAuthoritySha256: Sha256Ref | null;
	} {
		const waiter = (this.#waiters.get(agentId) ?? []).find(
			candidate =>
				!candidate.offered &&
				candidate.hubSelector !== undefined &&
				candidate.preselectionClaimSha256 !== undefined &&
				candidate.currentAuthoritySha256 !== undefined &&
				(candidate.from === undefined || candidate.from === from),
		);
		return {
			authority: this.#hubWaiterAuthority(agentId),
			selector: waiter?.hubSelector ?? null,
			preselectionClaimSha256: waiter?.preselectionClaimSha256 ?? null,
			currentAuthoritySha256: waiter?.currentAuthoritySha256 ?? null,
		};
	}

	hasExactHubWaiterOwnership(
		agentId: string,
		selectorInstallRequestSha256: string,
		preselectionClaimSha256: Sha256Ref,
		currentAuthoritySha256: Sha256Ref,
	): boolean {
		return (this.#waiters.get(agentId) ?? []).some(
			waiter =>
				waiter.hubSelector?.selectorInstallRequestSha256 === selectorInstallRequestSha256 &&
				waiter.preselectionClaimSha256 === preselectionClaimSha256 &&
				waiter.currentAuthoritySha256 === currentAuthoritySha256,
		);
	}

	async dispatchExactHubSendAwaitTargetWaiter(
		plan: Extract<
			ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationPlanV1,
			{ route: "waiter_selector" }
		>,
		message: IrcMessage,
		materializedAt: ISO8601,
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationReceiptV1> {
		const current = this.#hubWaiterAuthority(message.to);
		if (
			current.authoritySha256 !== plan.sourcePermit.waiterSelectorAuthority.authoritySha256 ||
			current.revision !== plan.sourcePermit.waiterSelectorAuthority.revision
		) {
			throw new Error("Hub send-await target waiter authority changed before dispatch");
		}
		const waiter = (this.#waiters.get(message.to) ?? []).find(
			candidate =>
				!candidate.offered &&
				candidate.hubSelector?.selectorInstallRequestSha256 === plan.selector.selectorInstallRequestSha256 &&
				candidate.preselectionClaimSha256 === plan.preselectionClaimSha256 &&
				candidate.currentAuthoritySha256 === plan.currentAuthoritySha256 &&
				(candidate.from === undefined || candidate.from === message.from),
		);
		if (!waiter) throw new Error("Hub send-await target waiter is unavailable");
		waiter.offered = true;
		this.#hubWaiterRevision += 1;
		const disposition = await waiter.offer(message);
		const decision = waiter.decision;
		if (
			disposition !== "consumed" ||
			!decision ||
			(decision.status !== "selected" && decision.status !== "already_selected" && decision.status !== "adopted")
		) {
			throw new Error("Hub send-await target waiter did not durably select the message");
		}
		const receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1(
			"send-await-target-delivery-source-materialization-receipt",
			{
				route: "waiter_selector" as const,
				sourceReceipt: { to: message.to, outcome: "injected" as const },
				selectionReceipt: decision.selectionReceipt,
				materializedAt,
			},
		);
		this.#hubWaiterSelections.set(plan.planSha256, receipt);
		return receipt;
	}

	inspectExactHubSendAwaitTargetWaiter(
		plan: Extract<
			ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationPlanV1,
			{ route: "waiter_selector" }
		>,
	): {
		readonly receipt: ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationReceiptV1 | null;
		readonly authority: { readonly authoritySha256: Sha256Ref; readonly revision: number };
	} {
		return {
			receipt: this.#hubWaiterSelections.get(plan.planSha256) ?? null,
			authority: this.#hubWaiterAuthority(plan.sourcePermit.targetAgentId),
		};
	}

	#takeFromMailbox(agentId: string, from?: string): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = from ? mailbox.findIndex(msg => msg.from === from) : 0;
		if (index === -1 || mailbox.length === 0) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return message;
	}

	/**
	 * Surface agent↔agent traffic as a display-only card on the main session
	 * UI. Skipped when the main agent is either endpoint: as recipient its
	 * own `deliverIrcMessage` (or `wait` tool result) already shows the
	 * message, and as sender the irc send tool call already rendered the
	 * outbound body — relaying it again would duplicate it in the transcript.
	 */
	#relayToMainUi(message: IrcMessage): void {
		if (message.to === MAIN_AGENT_ID || message.from === MAIN_AGENT_ID) return;
		const mainSession = this.#registry.get(MAIN_AGENT_ID)?.session;
		if (!mainSession) return;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: { from: message.from, to: message.to, body: message.body },
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			mainSession.emitIrcRelayObservation(record);
		} catch (error) {
			// Display-only forwarding must never affect delivery semantics.
			logger.debug("IrcBus: main UI relay failed", { to: message.to, error: String(error) });
		}
	}
}
