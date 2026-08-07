import { createHash } from "node:crypto";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import { logger, prompt, Snowflake } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { IrcBus, type IrcMessage } from "../irc/bus";
import parentIrcSteerTemplate from "../prompts/steering/parent-irc.md" with { type: "text" };
import ircAutoReplyTemplate from "../prompts/system/irc-autoreply.md" with { type: "text" };
import ircIncomingTemplate from "../prompts/system/irc-incoming.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import type { ISO8601, OperationId, Sha256Ref } from "../registry/persistent-agent-contracts.js";
import type { AgentSessionEvent } from "./agent-session-events";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";
import {
	buildTransientTaskHubWaitMessageCanonicalRecordV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptRequestV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptResultV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionInspectionV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionInspectRequestV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionReceiptV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionReceiptV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionRequestV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryExactMessageRequestV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationPermitV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationPlanV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationReceiptV1,
	type ConfidentialTransientTaskHubSendAwaitTargetSessionAppendInspectRequestV1,
	type ConfidentialTransientTaskHubWaitConsumedMessageV1,
	type ConfidentialTransientTaskHubWaitMessageSelectorInstallRequestV1,
	type ConfidentialTransientTaskHubWaitMessageSourceSelectionResultV1,
	canonicalRuntimeSha256,
	type TransientTaskHubWaitDurableMessageSelectorV1,
	type TransientTaskHubWaitSessionBufferSelectionBridgeV1,
} from "./workspace-runtime-contracts";

/** Capabilities the IRC bridge borrows from its owning session. */
export interface IrcBridgeHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	isDisposed(): boolean;
	getAgentId(): string;
	isStreaming(): boolean;
	planModeEnabled(): boolean;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	wakeForIrc(records: CustomMessage[]): Promise<void>;
	wakeAfterDurableIrc(record: CustomMessage): void;
	runEphemeralTurn(args: { promptText: string }): Promise<{ replyText: string }>;
}

/** Owns incoming IRC queues, injection, and side-channel auto-replies. */
export class IrcBridge implements TransientTaskHubWaitSessionBufferSelectionBridgeV1 {
	readonly #host: IrcBridgeHost;
	#interrupts: CustomMessage[] = [];
	#asides: CustomMessage[] = [];
	readonly #hubSendAwaitMaterializations = new Map<
		Sha256Ref,
		ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationReceiptV1
	>();

	constructor(host: IrcBridgeHost) {
		this.#host = host;
	}

	/** Whether an incoming peer message can interrupt a wait. */
	hasInterrupts(): boolean {
		return this.#interrupts.length > 0;
	}

	/** Whether any undelivered IRC record remains queued. */
	hasPending(): boolean {
		return this.#interrupts.length > 0 || this.#asides.length > 0;
	}

	/** Takes every queued IRC record in interrupt-before-aside order. */
	drainPending(): CustomMessage[] {
		const records = [...this.#interrupts, ...this.#asides];
		this.#interrupts = [];
		this.#asides = [];
		return records;
	}

	/** Surfaces queued incoming records; destructive unless peek is requested. */
	drainInboxMessages(agentId: string, opts?: { from?: string; limit?: number; peek?: boolean }): IrcMessage[] {
		const messages: IrcMessage[] = [];
		const remainingInterrupts: CustomMessage[] = [];
		const remainingAsides: CustomMessage[] = [];
		const queues = [
			{ records: this.#interrupts, remaining: remainingInterrupts },
			{ records: this.#asides, remaining: remainingAsides },
		];
		for (const queue of queues) {
			for (const record of queue.records) {
				if (record.customType !== "irc:incoming") {
					queue.remaining.push(record);
					continue;
				}
				const details = record.details;
				if (!details || typeof details !== "object") {
					queue.remaining.push(record);
					continue;
				}
				const id = Reflect.get(details, "id");
				const from = Reflect.get(details, "from");
				const body = Reflect.get(details, "message");
				const replyTo = Reflect.get(details, "replyTo");
				if (typeof id !== "string" || typeof from !== "string" || typeof body !== "string") {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.from !== undefined && from !== opts.from) {
					queue.remaining.push(record);
					continue;
				}
				if (opts?.limit !== undefined && messages.length >= opts.limit) {
					queue.remaining.push(record);
					continue;
				}
				messages.push({
					id,
					from,
					to: agentId,
					body,
					ts: record.timestamp,
					...(typeof replyTo === "string" ? { replyTo } : {}),
				});
				if (opts?.peek) queue.remaining.push(record);
			}
		}
		this.#interrupts = remainingInterrupts;
		this.#asides = remainingAsides;
		return messages;
	}
	async selectPendingHubWaitMessage(
		selector: ConfidentialTransientTaskHubWaitMessageSelectorInstallRequestV1,
		select: TransientTaskHubWaitDurableMessageSelectorV1,
		signal?: AbortSignal,
	): Promise<ConfidentialTransientTaskHubWaitMessageSourceSelectionResultV1> {
		const key = selector.key;
		if (signal?.aborted) {
			return {
				status: "cancelled_before_selection",
				key,
				selectorInstallRequestSha256: selector.selectorInstallRequestSha256,
			};
		}
		const from = key.fromFilter ?? undefined;
		const queues = [this.#interrupts, this.#asides];
		let selectedQueue: CustomMessage[] | undefined;
		let selectedIndex = -1;
		let message: ConfidentialTransientTaskHubWaitConsumedMessageV1 | undefined;
		let selectedRecord: CustomMessage | undefined;
		for (const queue of queues) {
			for (let index = 0; index < queue.length; index++) {
				const record = queue[index];
				if (record.customType !== "irc:incoming") continue;
				const details = record.details;
				if (!details || typeof details !== "object") continue;
				const id = Reflect.get(details, "id");
				const source = Reflect.get(details, "from");
				const body = Reflect.get(details, "message");
				const replyTo = Reflect.get(details, "replyTo");
				if (typeof id !== "string" || typeof source !== "string" || typeof body !== "string") continue;
				if (from !== undefined && source !== from) continue;
				const core = {
					schemaVersion: 1 as const,
					id,
					from: source,
					to: key.senderId,
					body,
					ts: record.timestamp,
					replyTo: typeof replyTo === "string" ? replyTo : null,
				};
				message = {
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
				selectedQueue = queue;
				selectedIndex = index;
				selectedRecord = record;
				break;
			}
			if (message) break;
		}
		if (!message || !selectedQueue || !selectedRecord || selectedIndex < 0) {
			return { status: "no_candidate", key, selectorInstallRequestSha256: selector.selectorInstallRequestSha256 };
		}
		const decision = await select(message);
		if (decision.status === "selected" || decision.status === "already_selected" || decision.status === "adopted") {
			if (selectedQueue[selectedIndex] !== selectedRecord) {
				throw new Error("Hub-selected session IRC candidate changed before dequeue");
			}
			selectedQueue.splice(selectedIndex, 1);
		}
		return decision;
	}

	observeHubSendAwaitTargetWaiter(from: string): ReturnType<IrcBus["observeHubSendAwaitTargetWaiter"]> {
		return IrcBus.global().observeHubSendAwaitTargetWaiter(this.#host.getAgentId(), from);
	}

	buildHubSendAwaitTargetMaterializationPlan(
		request: ConfidentialTransientTaskHubSendAwaitTargetDeliveryExactMessageRequestV1,
		permit: ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationPermitV1,
		waiter: ReturnType<IrcBus["observeHubSendAwaitTargetWaiter"]>,
	): ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationPlanV1 {
		if (waiter.selector && waiter.preselectionClaimSha256 && waiter.currentAuthoritySha256) {
			return buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-source-materialization-plan",
				{
					schemaVersion: 1 as const,
					route: "waiter_selector" as const,
					sourcePermit: permit,
					selector: waiter.selector,
					preselectionClaimSha256: waiter.preselectionClaimSha256,
					currentAuthoritySha256: waiter.currentAuthoritySha256,
				},
			);
		}
		const targetSession = permit.targetSessionAuthority;
		if (targetSession) {
			const message = request.message;
			const streaming = this.#host.isStreaming();
			const autoReply =
				(streaming && !this.#host.settings.get("async.enabled")) || (!streaming && this.#host.planModeEnabled());
			const sessionEntry = {
				role: "custom" as const,
				customType: "irc:incoming" as const,
				content: prompt.render(ircIncomingTemplate, {
					from: message.from,
					message: message.body,
					replyTo: message.replyTo ?? "",
					autoReplied: autoReply,
					interrupting: streaming,
				}),
				display: true as const,
				details: {
					id: message.id,
					from: message.from,
					message: message.body,
					...(message.replyTo ? { replyTo: message.replyTo } : {}),
				},
				attribution: "agent" as const,
				timestamp: message.ts,
			};
			const sessionEntryId = Snowflake.next();
			const jsonlEntry = {
				type: "custom_message" as const,
				id: sessionEntryId,
				parentId: targetSession.targetSessionHeadEntryId,
				timestamp: new Date(message.ts).toISOString(),
				customType: sessionEntry.customType,
				content: sessionEntry.content,
				display: sessionEntry.display,
				details: sessionEntry.details,
				attribution: sessionEntry.attribution,
			};
			const sessionEntryJsonlUtf8 = `${JSON.stringify(jsonlEntry)}\n`;
			const appendRequest = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-session-append-request",
				{
					schemaVersion: 1 as const,
					appendOperationId: Snowflake.next() as OperationId,
					targetAgentId: permit.targetAgentId,
					targetSessionId: targetSession.targetSessionId,
					targetSessionGenerationSha256: targetSession.targetSessionGenerationSha256,
					targetBranchGenerationSha256: targetSession.targetBranchGenerationSha256,
					expectedHeadEntryId: targetSession.targetSessionHeadEntryId,
					appendParentEntryId: targetSession.targetSessionHeadEntryId,
					sessionEntryId,
					sessionEntry,
					sessionEntryJsonlUtf8,
					sessionEntryJsonlUtf8Sha256: `sha256:${createHash("sha256").update(sessionEntryJsonlUtf8, "utf8").digest("hex")}`,
					sessionEntryJsonlUtf8ByteLength: Buffer.byteLength(sessionEntryJsonlUtf8, "utf8"),
					requestedAt: permit.observedAt,
				},
			);
			return buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-source-materialization-plan",
				{
					schemaVersion: 1 as const,
					route: "session_append" as const,
					sourcePermit: permit,
					appendRequest,
				},
			);
		}
		const observationRequest = buildTransientTaskHubWaitMessageCanonicalRecordV1(
			"send-await-target-failed-observation-request",
			{
				sourcePermitSha256: permit.permitSha256,
				exactMessageRequestSha256: request.requestSha256,
				targetAgentId: permit.targetAgentId,
				error: "Target session authority is unavailable",
				observedAt: permit.observedAt,
			},
		);
		return buildTransientTaskHubWaitMessageCanonicalRecordV1(
			"send-await-target-delivery-source-materialization-plan",
			{
				schemaVersion: 1 as const,
				route: "failed_observation" as const,
				sourcePermit: permit,
				observationRequest,
			},
		);
	}

	async dispatchAcceptedHubSendAwaitMessage(
		transitionRequest: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionRequestV1,
		_transitionReceipt: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionReceiptV1,
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationReceiptV1> {
		const plan = transitionRequest.materializationPlan;
		const message = transitionRequest.plan.request.message;
		const materializedAt = new Date().toISOString() as ISO8601;
		let receipt: ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationReceiptV1;
		if (plan.route === "waiter_selector") {
			receipt = await IrcBus.global().dispatchExactHubSendAwaitTargetWaiter(
				plan,
				{
					id: message.id,
					from: message.from,
					to: message.to,
					body: message.body,
					ts: message.ts,
					...(message.replyTo ? { replyTo: message.replyTo } : {}),
				},
				materializedAt,
			);
		} else if (plan.route === "session_append") {
			const appended =
				await this.#host.sessionManager.transientPersistence.appendExactHubSendAwaitTargetSessionEntry(
					plan.appendRequest,
				);
			if (appended.status !== "appended" && appended.status !== "already_appended") {
				throw new Error(`Hub send-await target session append ${appended.status}`);
			}
			const sourceReceipt = {
				to: message.to,
				outcome: this.#activateDurablyAppendedMessage(message, plan.appendRequest.sessionEntry),
			};
			receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-source-materialization-receipt",
				{
					route: "session_append" as const,
					sourceReceipt,
					appendReceipt: appended.receipt,
					materializedAt,
				},
			);
		} else {
			await this.#host.sessionManager.transientPersistence.recordHubSendAwaitTargetFailedObservation(
				plan.observationRequest,
			);
			receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-source-materialization-receipt",
				{
					route: "failed_observation" as const,
					sourceReceipt: {
						to: message.to,
						outcome: "failed" as const,
						...(plan.observationRequest.error ? { error: plan.observationRequest.error } : {}),
					},
					observationRequest: plan.observationRequest,
					materializedAt,
				},
			);
		}
		this.#hubSendAwaitMaterializations.set(plan.planSha256, receipt);
		return receipt;
	}

	#hasActivatedDurableMessage(messageId: string): boolean {
		return this.#host.agent.state.messages.some(candidate => {
			if (candidate.role !== "custom" || candidate.customType !== "irc:incoming") return false;
			const details = candidate.details;
			return details !== null && typeof details === "object" && Reflect.get(details, "id") === messageId;
		});
	}

	#activateDurablyAppendedMessage(
		message: ConfidentialTransientTaskHubSendAwaitTargetDeliveryExactMessageRequestV1["message"],
		record: CustomMessage,
	): "injected" | "woken" {
		void this.#host.emitSessionEvent({ type: "irc_message", message: record });
		if (this.#host.isStreaming()) {
			const recipientParentId = AgentRegistry.global().get(message.to)?.parentId;
			if (recipientParentId === message.from) {
				this.#host.agent.steer({
					role: "user",
					content: prompt.render(parentIrcSteerTemplate, { from: message.from, message: message.body }),
					attribution: "agent",
					timestamp: message.ts,
					steering: true,
				});
			} else {
				this.#interrupts.push(record);
			}
			if (!this.#host.settings.get("async.enabled")) {
				void this.#runAutoReply({
					id: message.id,
					from: message.from,
					to: message.to,
					body: message.body,
					ts: message.ts,
					...(message.replyTo ? { replyTo: message.replyTo } : {}),
				});
			}
			return "injected";
		}
		this.#host.agent.appendMessage(record);
		if (this.#host.planModeEnabled()) {
			void this.#runAutoReply({
				id: message.id,
				from: message.from,
				to: message.to,
				body: message.body,
				ts: message.ts,
				...(message.replyTo ? { replyTo: message.replyTo } : {}),
			});
			return "injected";
		}
		this.#host.wakeAfterDurableIrc(record);
		return "woken";
	}

	#consumptionReceipt(
		request: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionInspectRequestV1,
		materializationReceipt: ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationReceiptV1,
		settledAt: ISO8601,
	): ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionReceiptV1 {
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-consumption-receipt", {
			plan: request.plan,
			transitionRequest: request.transitionRequest,
			transitionReceipt: request.transitionReceipt,
			materializationReceipt,
			sourceReceipt: materializationReceipt.sourceReceipt,
			settledAt,
		});
	}

	#matchingConsumptionInspection(
		request: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionInspectRequestV1,
		materializationReceipt: ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationReceiptV1,
	): ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionInspectionV1 {
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-consumption-inspection", {
			status: "matching_settled" as const,
			receipt: this.#consumptionReceipt(request, materializationReceipt, request.inspectedAt),
		});
	}

	#unknownConsumptionInspection(
		request: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionInspectRequestV1,
	): ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionInspectionV1 {
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-consumption-inspection", {
			status: "outcome_unknown" as const,
			inspectRequestSha256: request.requestSha256,
			planSha256: request.plan.planSha256,
			transitionRequestSha256: request.transitionRequest.requestSha256,
			transitionReceiptSha256: request.transitionReceipt.receiptSha256,
			inspectedAt: request.inspectedAt,
		});
	}

	async inspectAcceptedHubSendAwaitMessage(
		request: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionInspectRequestV1,
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionInspectionV1> {
		const plan = request.transitionRequest.materializationPlan;
		const remembered = this.#hubSendAwaitMaterializations.get(plan.planSha256);
		if (remembered) return this.#matchingConsumptionInspection(request, remembered);
		if (plan.route === "waiter_selector") {
			const inspected = IrcBus.global().inspectExactHubSendAwaitTargetWaiter(plan);
			if (inspected.receipt) return this.#matchingConsumptionInspection(request, inspected.receipt);
			if (
				inspected.authority.authoritySha256 !== plan.sourcePermit.waiterSelectorAuthority.authoritySha256 ||
				inspected.authority.revision !== plan.sourcePermit.waiterSelectorAuthority.revision
			)
				return this.#unknownConsumptionInspection(request);
			const routeAbsenceProof = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-source-materialization-route-absence",
				{
					route: "waiter_selector" as const,
					selectorInstallRequestSha256: plan.selector.selectorInstallRequestSha256,
					preselectionClaimSha256: plan.preselectionClaimSha256,
					unchangedWaiterSelectorAuthoritySha256: inspected.authority.authoritySha256,
					unchangedWaiterSelectorAuthorityRevision: inspected.authority.revision,
					exactSelectionAbsent: true as const,
				},
			);
			const proof = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-authoritative-absence",
				{
					inspectRequest: request,
					sourcePermit: plan.sourcePermit,
					unchangedSourcePermitSha256: plan.sourcePermit.permitSha256,
					routeAbsenceProof,
					provenAt: request.inspectedAt,
				},
			);
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-consumption-inspection", {
				status: "authoritative_absence" as const,
				proof,
			});
		}
		if (plan.route === "session_append") {
			const appendInspectRequest: ConfidentialTransientTaskHubSendAwaitTargetSessionAppendInspectRequestV1 =
				buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-session-append-inspect-request", {
					appendOperationId: plan.appendRequest.appendOperationId,
					sessionEntryId: plan.appendRequest.sessionEntryId,
					expectedAppendRequestSha256: plan.appendRequest.requestSha256,
					inspectedAt: request.inspectedAt,
				});
			const appendInspection =
				await this.#host.sessionManager.transientPersistence.inspectExactHubSendAwaitTargetSessionEntry(
					appendInspectRequest,
				);
			if (appendInspection.status === "matching") {
				const sourceOutcome = this.#hasActivatedDurableMessage(plan.appendRequest.sessionEntry.details.id)
					? ("injected" as const)
					: this.#activateDurablyAppendedMessage(request.plan.request.message, plan.appendRequest.sessionEntry);
				const materializationReceipt = buildTransientTaskHubWaitMessageCanonicalRecordV1(
					"send-await-target-delivery-source-materialization-receipt",
					{
						route: "session_append" as const,
						sourceReceipt: { to: plan.sourcePermit.targetAgentId, outcome: sourceOutcome },
						appendReceipt: appendInspection.receipt,
						materializedAt: request.inspectedAt,
					},
				);
				this.#hubSendAwaitMaterializations.set(plan.planSha256, materializationReceipt);
				return this.#matchingConsumptionInspection(request, materializationReceipt);
			}
			if (appendInspection.status !== "authoritative_absence") return this.#unknownConsumptionInspection(request);
			const routeAbsenceProof = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-source-materialization-route-absence",
				{ route: "session_append" as const, appendProof: appendInspection.proof },
			);
			const proof = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-authoritative-absence",
				{
					inspectRequest: request,
					sourcePermit: plan.sourcePermit,
					unchangedSourcePermitSha256: plan.sourcePermit.permitSha256,
					routeAbsenceProof,
					provenAt: request.inspectedAt,
				},
			);
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-consumption-inspection", {
				status: "authoritative_absence" as const,
				proof,
			});
		}
		const failed = this.#host.sessionManager.transientPersistence.inspectHubSendAwaitTargetFailedObservation(
			plan.observationRequest,
		);
		if (failed.request && JSON.stringify(failed.request) === JSON.stringify(plan.observationRequest)) {
			const materializationReceipt = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-source-materialization-receipt",
				{
					route: "failed_observation" as const,
					sourceReceipt: {
						to: plan.sourcePermit.targetAgentId,
						outcome: "failed" as const,
						...(plan.observationRequest.error ? { error: plan.observationRequest.error } : {}),
					},
					observationRequest: plan.observationRequest,
					materializedAt: request.inspectedAt,
				},
			);
			return this.#matchingConsumptionInspection(request, materializationReceipt);
		}
		if (
			failed.authority.authoritySha256 !== plan.sourcePermit.failedObservationAuthority.authoritySha256 ||
			failed.authority.revision !== plan.sourcePermit.failedObservationAuthority.revision
		)
			return this.#unknownConsumptionInspection(request);
		const routeAbsenceProof = buildTransientTaskHubWaitMessageCanonicalRecordV1(
			"send-await-target-delivery-source-materialization-route-absence",
			{
				route: "failed_observation" as const,
				failedObservationRequestSha256: plan.observationRequest.requestSha256,
				unchangedFailedObservationAuthoritySha256: failed.authority.authoritySha256,
				unchangedFailedObservationAuthorityRevision: failed.authority.revision,
				exactObservationAbsent: true as const,
			},
		);
		const proof = buildTransientTaskHubWaitMessageCanonicalRecordV1(
			"send-await-target-delivery-consumption-authoritative-absence",
			{
				inspectRequest: request,
				sourcePermit: plan.sourcePermit,
				unchangedSourcePermitSha256: plan.sourcePermit.permitSha256,
				routeAbsenceProof,
				provenAt: request.inspectedAt,
			},
		);
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-consumption-inspection", {
			status: "authoritative_absence" as const,
			proof,
		});
	}

	async adoptAcceptedHubSendAwaitMessage(
		request: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptRequestV1,
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptResultV1> {
		if (request.inspection.status === "matching_settled") {
			return { status: "settled", receipt: request.inspection.receipt };
		}
		if (request.inspection.status === "authoritative_absence") {
			const state = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-state",
				{ state: "not_applied" as const, plan: request.inspectRequest.plan },
			);
			if (state.state !== "not_applied") throw new Error("Hub send-await adoption produced the wrong state");
			return { status: "restored_not_applied", state };
		}
		if (request.inspection.status === "outcome_unknown") {
			const block = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-block",
				{
					plan: request.inspectRequest.plan,
					transitionRequest: request.inspectRequest.transitionRequest,
					transitionReceipt: request.inspectRequest.transitionReceipt,
					inspectRequest: request.inspectRequest,
					inspection: request.inspection,
					reason: "source_outcome_unknown" as const,
					blockedAt: request.adoptedAt,
				},
			);
			return { status: "blocked_indeterminate", block };
		}
		if (request.inspection.status === "conflict") {
			const block = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-block",
				{
					plan: request.inspectRequest.plan,
					transitionRequest: request.inspectRequest.transitionRequest,
					transitionReceipt: request.inspectRequest.transitionReceipt,
					inspectRequest: request.inspectRequest,
					inspection: request.inspection,
					reason: "source_conflict" as const,
					blockedAt: request.adoptedAt,
				},
			);
			return { status: "blocked_indeterminate", block };
		}
		const block = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-consumption-block", {
			plan: request.inspectRequest.plan,
			transitionRequest: request.inspectRequest.transitionRequest,
			transitionReceipt: request.inspectRequest.transitionReceipt,
			inspectRequest: request.inspectRequest,
			inspection: request.inspection,
			reason: "source_invalid" as const,
			blockedAt: request.adoptedAt,
		});
		return { status: "blocked_indeterminate", block };
	}

	/** Delivers an IRC message into the recipient session, awaiting idle wake dispatch but not turn completion. */
	async deliver(msg: IrcMessage, opts?: { expectsReply?: boolean }): Promise<"injected" | "woken"> {
		if (this.#host.isDisposed()) throw new Error("Recipient session is disposed.");
		const streaming = this.#host.isStreaming();
		const planModeIdle = !streaming && this.#host.planModeEnabled();
		const autoReply =
			(opts?.expectsReply ?? false) && ((streaming && !this.#host.settings.get("async.enabled")) || planModeIdle);
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: prompt.render(ircIncomingTemplate, {
				from: msg.from,
				message: msg.body,
				replyTo: msg.replyTo ?? "",
				autoReplied: autoReply,
				interrupting: streaming,
			}),
			display: true,
			details: { id: msg.id, from: msg.from, message: msg.body, ...(msg.replyTo ? { replyTo: msg.replyTo } : {}) },
			attribution: "agent",
			timestamp: msg.ts,
		};
		void this.#host.emitSessionEvent({ type: "irc_message", message: record });
		if (streaming) {
			const recipientParentId = AgentRegistry.global().get(msg.to)?.parentId;
			if (recipientParentId === msg.from) {
				this.#host.agent.steer({
					role: "user",
					content: prompt.render(parentIrcSteerTemplate, { from: msg.from, message: msg.body }),
					attribution: "agent",
					timestamp: msg.ts,
					steering: true,
				});
			} else {
				this.#interrupts.push(record);
			}
			if (autoReply) void this.#runAutoReply(msg);
			return "injected";
		}
		if (this.#host.planModeEnabled()) {
			this.#host.agent.appendMessage(record);
			this.#host.sessionManager.appendCustomMessageEntry(
				record.customType,
				record.content,
				record.display,
				record.details,
				record.attribution ?? "agent",
			);
			if (autoReply) void this.#runAutoReply(msg);
			return "injected";
		}
		await this.#host.wakeForIrc([record]);
		return "woken";
	}

	/** Emits an IRC relay observation for rendering without persisting it. */
	emitRelayObservation(record: CustomMessage): void {
		void this.#host.emitSessionEvent({ type: "irc_message", message: record });
	}

	/** Persists queued IRC records that missed their step-boundary injection. */
	flushPending(): void {
		for (const record of this.drainPending()) {
			this.#host.agent.emitExternalEvent({ type: "message_start", message: record });
			this.#host.agent.emitExternalEvent({ type: "message_end", message: record });
		}
	}

	async #runAutoReply(msg: IrcMessage): Promise<void> {
		try {
			const { replyText } = await this.#host.runEphemeralTurn({
				promptText: prompt.render(ircAutoReplyTemplate, {
					from: msg.from,
					message: msg.body,
					replyTo: msg.replyTo ?? "",
				}),
			});
			const body = replyText.trim();
			if (!body || this.#host.isDisposed()) return;
			const record: CustomMessage = {
				role: "custom",
				customType: "irc:autoreply",
				content: `[IRC you → \`${msg.from}\` (auto)]\n\n${body}`,
				display: true,
				details: { to: msg.from, body, replyTo: msg.id },
				attribution: "agent",
				timestamp: Date.now(),
			};
			void this.#host.emitSessionEvent({ type: "irc_message", message: record });
			this.#asides.push(record);
			const receipt = await IrcBus.global().send({ from: msg.to, to: msg.from, body, replyTo: msg.id });
			if (receipt.outcome === "failed") {
				logger.warn("IRC auto-reply delivery failed", { to: msg.from, error: receipt.error });
			}
		} catch (error) {
			logger.warn("IRC auto-reply turn failed", { from: msg.from, error: String(error) });
		}
	}
}
