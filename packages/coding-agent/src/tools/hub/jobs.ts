/**
 * Hub jobs half — lifecycle control for async background jobs (bash scripts,
 * subagents) owned by the calling agent: wait/cancel/snapshot plus the
 * running-agents roster for activity with no job entry.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { AsyncJob, AsyncJobManager } from "../../async";
import { settings } from "../../config/settings";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { shimmerEnabled, shimmerText } from "../../modes/theme/shimmer";
import type { Theme } from "../../modes/theme/theme";
import type { OperationId } from "../../registry/persistent-agent-contracts";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import {
	type ConfidentialAsyncJobSettledRowInspectResultV1,
	type ConfidentialAsyncJobSettledRowV1,
	type ConfidentialTransientTaskDetachedSettlementAttemptV1,
	type ConfidentialTransientTaskDetachedSettlementCurrentAuthorityV1,
	type ConfidentialTransientTaskDetachedSettlementOperationReceiptV1,
	type ConfidentialTransientTaskDetachedSettlementOperationRequestV1,
	type ConfidentialTransientTaskDetachedSettlementReservationReceiptV1,
	type ConfidentialTransientTaskDetachedSettlementTerminalReceiptV1,
	deriveTransientTaskHubDetachedCommitAttemptV1,
	deriveTransientTaskHubDetachedReservationAttemptV1,
	type TransientTaskDetachedSettlementDispositionV1,
	type TransientTaskDetachedSettlementInspectRequestV1,
	type TransientTaskDetachedSettlementNotAppliedReceiptV1,
	type TransientTaskDetachedSettlementStoreV1,
} from "../../session/workspace-runtime-contracts";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../../tui";
import type { ToolSession } from "..";
import {
	formatBadge,
	formatDuration,
	formatEmptyMessage,
	formatStatusIcon,
	getPreviewLines,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
} from "../render-utils";
import type { AgentActivitySnapshot, CancelOutcome, CoordinationDetails, HubRenderArgs, JobSnapshot } from "./types";

const WAIT_DURATION_MS: Record<string, number> = {
	"5s": 5_000,
	"10s": 10_000,
	"30s": 30_000,
	"1m": 60_000,
	"5m": 5 * 60_000,
};

/**
 * A wait snapshot where every watched job is still running and nothing was
 * cancelled — pure "still waiting" noise once a newer wait exists. The TUI
 * keeps such a block un-finalized (displaceable) so a follow-up `hub` call
 * replaces it instead of stacking another waiting frame in the transcript.
 */
export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as CoordinationDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(job => job?.status === "running");
}

/** Poll window for a job-watching wait: `async.pollWaitDuration` fixed value or smart ladder. */
export function resolvePollWindow(
	session: ToolSession,
	manager: AsyncJobManager,
	ownerId: string | undefined,
): { waitMs: number; smart: boolean } {
	const pollSetting = session.settings.get("async.pollWaitDuration");
	const smart = pollSetting === "smart";
	const waitMs = smart
		? manager.nextPollWaitMs(ownerId)
		: ((pollSetting ? WAIT_DURATION_MS[pollSetting] : undefined) ?? WAIT_DURATION_MS["30s"]);
	return { waitMs, smart };
}

/**
 * Resolve a list of job ids to job records visible to the calling agent.
 * Drops missing ids and ids owned by other agents, so cross-agent inspection
 * via the hub is impossible.
 */
export function visibleJobs(manager: AsyncJobManager, ids: string[], ownerId: string | undefined): AsyncJob[] {
	const out: AsyncJob[] = [];
	for (const id of ids) {
		const job = manager.getJob(id);
		if (!job) continue;
		if (ownerId && job.ownerId !== ownerId) continue;
		out.push(job);
	}
	return out;
}

type ImmediateHubConsumptionDisposition = Extract<
	TransientTaskDetachedSettlementDispositionV1,
	"hub_jobs_consumption" | "hub_cancel_consumption"
>;
type HubConsumptionDisposition = ImmediateHubConsumptionDisposition | "hub_wait_consumption";
type HubReservationSelector =
	| { readonly disposition: ImmediateHubConsumptionDisposition }
	| { readonly disposition: "hub_wait_consumption"; readonly hubWaitInvocationId: OperationId };
type HubCurrentAuthority = Extract<
	ConfidentialTransientTaskDetachedSettlementCurrentAuthorityV1,
	{ readonly kind: "current_owner_epoch" }
>;
type HubDetachedOperation = Extract<
	ConfidentialTransientTaskDetachedSettlementOperationRequestV1,
	{ readonly stage: "reservation" | "terminal_commit" }
>;
type HubReservationReceipt = Extract<
	ConfidentialTransientTaskDetachedSettlementReservationReceiptV1,
	{ readonly disposition: HubConsumptionDisposition }
>;
type HubTerminalReceipt = Extract<
	ConfidentialTransientTaskDetachedSettlementTerminalReceiptV1,
	{ readonly disposition: HubConsumptionDisposition }
>;
type TransientSettledRow = Exclude<ConfidentialAsyncJobSettledRowV1, { readonly transientTaskCompletion: null }>;
type HubObservedCurrentAuthority = TransientSettledRow["transientTaskCompletion"]["currentAuthority"];

type HubAttemptRecovery =
	| {
			readonly status: "not_applied";
			readonly notAppliedReceipt: TransientTaskDetachedSettlementNotAppliedReceiptV1;
	  }
	| {
			readonly status: "applied";
			readonly receipt: ConfidentialTransientTaskDetachedSettlementOperationReceiptV1;
	  }
	| { readonly status: "blocked_indeterminate" };

function isHubReservationReceipt(
	receipt: ConfidentialTransientTaskDetachedSettlementOperationReceiptV1,
): receipt is HubReservationReceipt {
	return (
		"reservationId" in receipt &&
		(receipt.disposition === "hub_jobs_consumption" ||
			receipt.disposition === "hub_wait_consumption" ||
			receipt.disposition === "hub_cancel_consumption")
	);
}

function isHubTerminalReceipt(
	receipt: ConfidentialTransientTaskDetachedSettlementOperationReceiptV1,
): receipt is HubTerminalReceipt {
	return (
		"commitOperationId" in receipt &&
		(receipt.disposition === "hub_jobs_consumption" ||
			receipt.disposition === "hub_wait_consumption" ||
			receipt.disposition === "hub_cancel_consumption")
	);
}

function isHubCurrentAuthority(authority: HubObservedCurrentAuthority): authority is HubCurrentAuthority {
	return authority.kind === "current_owner_epoch" && "ownerSinkAuthoritySha256" in authority;
}

async function reconcileHubDetachedAttempt(
	store: TransientTaskDetachedSettlementStoreV1,
	operation: HubDetachedOperation,
	attempt: ConfidentialTransientTaskDetachedSettlementAttemptV1,
	inspectRequest: TransientTaskDetachedSettlementInspectRequestV1,
	currentAuthority: HubCurrentAuthority,
): Promise<HubAttemptRecovery> {
	try {
		const inspection = await store.inspect(inspectRequest);
		if (
			inspection.status !== "not_applied" &&
			inspection.status !== "outcome_unknown" &&
			inspection.status !== "matching"
		)
			return { status: "blocked_indeterminate" };
		const adopted = await store.adopt({
			...inspectRequest,
			expectedIdentity: operation.request.settlement.identity,
			expectedOperation: operation,
			expectedAttempt: attempt,
			expectedNotAppliedReceiptSha256: inspection.notAppliedReceiptSha256,
			expectedReceiptSha256: inspection.status === "matching" ? inspection.receiptSha256 : null,
			expectedCurrentAuthority: currentAuthority,
		});
		if (
			(adopted.status === "not_applied" || adopted.status === "outcome_unknown" || adopted.status === "adopted") &&
			adopted.attempt.attemptSha256 !== attempt.attemptSha256
		)
			return { status: "blocked_indeterminate" };
		if (adopted.status === "not_applied") {
			return { status: "not_applied", notAppliedReceipt: adopted.notAppliedReceipt };
		}
		if (adopted.status === "adopted") return { status: "applied", receipt: adopted.receipt };
		return { status: "blocked_indeterminate" };
	} catch {
		return { status: "blocked_indeterminate" };
	}
}

async function prepareHubDetachedAttempt(
	store: TransientTaskDetachedSettlementStoreV1,
	operation: HubDetachedOperation,
	attempt: ConfidentialTransientTaskDetachedSettlementAttemptV1,
	inspectRequest: TransientTaskDetachedSettlementInspectRequestV1,
	currentAuthority: HubCurrentAuthority,
): Promise<HubAttemptRecovery> {
	try {
		const prepared = await store.prepare({ attempt });
		if (prepared.status === "prepared" || prepared.status === "already_prepared") {
			if (
				prepared.attempt.attemptSha256 !== attempt.attemptSha256 ||
				prepared.notAppliedReceipt.attemptSha256 !== attempt.attemptSha256
			)
				return { status: "blocked_indeterminate" };
			return { status: "not_applied", notAppliedReceipt: prepared.notAppliedReceipt };
		}
		if (prepared.status !== "prepare_outcome_unknown") return { status: "blocked_indeterminate" };
	} catch {
		// Response loss is resolved below from the exact frozen attempt.
	}
	return reconcileHubDetachedAttempt(store, operation, attempt, inspectRequest, currentAuthority);
}

type HubReservationOutcome =
	| { readonly status: "reserved"; readonly receipt: HubReservationReceipt }
	| { readonly status: "terminal"; readonly disposition: TransientTaskDetachedSettlementDispositionV1 }
	| { readonly status: "blocked_indeterminate" };

async function reserveTransientJobResult(
	store: TransientTaskDetachedSettlementStoreV1,
	row: TransientSettledRow,
	selector: HubReservationSelector,
	currentAuthority: HubCurrentAuthority,
): Promise<HubReservationOutcome> {
	const common = {
		settlement: row.transientTaskCompletion.settlementRequest,
		currentAuthority,
		preparedAt: row.transientTaskCompletion.settledResultReceipt.publishedAt,
	};
	const derived =
		selector.disposition === "hub_wait_consumption"
			? deriveTransientTaskHubDetachedReservationAttemptV1({
					...common,
					disposition: "hub_wait_consumption",
					hubWaitInvocationId: selector.hubWaitInvocationId,
				})
			: deriveTransientTaskHubDetachedReservationAttemptV1({ ...common, disposition: selector.disposition });
	const disposition = selector.disposition;
	let prepared = await prepareHubDetachedAttempt(
		store,
		derived.operation,
		derived.attempt,
		derived.inspectRequest,
		currentAuthority,
	);
	if (prepared.status === "applied") {
		return isHubReservationReceipt(prepared.receipt) && prepared.receipt.disposition === disposition
			? { status: "reserved", receipt: prepared.receipt }
			: { status: "blocked_indeterminate" };
	}
	if (prepared.status === "blocked_indeterminate") return prepared;

	for (let pass = 0; pass < 2; pass += 1) {
		try {
			const result = await store.reserve({
				operation: derived.operation,
				expectedAttemptSha256: derived.attempt.attemptSha256,
				expectedNotAppliedReceiptSha256: prepared.notAppliedReceipt.receiptSha256,
			});
			if (result.status === "reserved" || result.status === "already_reserved") {
				return isHubReservationReceipt(result.receipt) && result.receipt.disposition === disposition
					? { status: "reserved", receipt: result.receipt }
					: { status: "blocked_indeterminate" };
			}
			if (result.status === "already_terminal") {
				return { status: "terminal", disposition: result.terminalDisposition };
			}
			if (result.status !== "reservation_outcome_unknown") return { status: "blocked_indeterminate" };
		} catch {
			// Inspect below; retry only when the exact attempt is proven not applied.
		}

		const recovered = await reconcileHubDetachedAttempt(
			store,
			derived.operation,
			derived.attempt,
			derived.inspectRequest,
			currentAuthority,
		);
		if (recovered.status === "applied") {
			return isHubReservationReceipt(recovered.receipt) && recovered.receipt.disposition === disposition
				? { status: "reserved", receipt: recovered.receipt }
				: { status: "blocked_indeterminate" };
		}
		if (recovered.status === "blocked_indeterminate") return recovered;
		prepared = recovered;
	}
	return { status: "blocked_indeterminate" };
}

export type HubConsumptionOutcome = "consumed" | "already_terminal" | "blocked_indeterminate";

async function commitTransientJobResult(
	store: TransientTaskDetachedSettlementStoreV1,
	row: TransientSettledRow,
	disposition: HubConsumptionDisposition,
	currentAuthority: HubCurrentAuthority,
	reservation: HubReservationReceipt,
): Promise<HubConsumptionOutcome> {
	const derived = deriveTransientTaskHubDetachedCommitAttemptV1({
		settlement: row.transientTaskCompletion.settlementRequest,
		currentAuthority,
		reservation,
		preparedAt: row.transientTaskCompletion.settledResultReceipt.publishedAt,
	});
	let prepared = await prepareHubDetachedAttempt(
		store,
		derived.operation,
		derived.attempt,
		derived.inspectRequest,
		currentAuthority,
	);
	if (prepared.status === "applied") {
		if (!isHubTerminalReceipt(prepared.receipt)) return "blocked_indeterminate";
		if (prepared.receipt.disposition !== disposition) return "already_terminal";
		return prepared.receipt.reservationReceiptSha256 === reservation.receiptSha256
			? "consumed"
			: "blocked_indeterminate";
	}
	if (prepared.status === "blocked_indeterminate") return "blocked_indeterminate";

	for (let pass = 0; pass < 2; pass += 1) {
		try {
			const result = await store.commit({
				operation: derived.operation,
				expectedAttemptSha256: derived.attempt.attemptSha256,
				expectedNotAppliedReceiptSha256: prepared.notAppliedReceipt.receiptSha256,
			});
			if (
				result.status === "committed" ||
				result.status === "already_committed" ||
				result.status === "already_terminal"
			) {
				if (result.receipt.disposition !== disposition) return "already_terminal";
				return result.receipt.reservationReceiptSha256 === reservation.receiptSha256
					? "consumed"
					: "blocked_indeterminate";
			}
			if (result.status !== "commit_outcome_unknown") return "blocked_indeterminate";
		} catch {
			// Inspect below; retry only when the exact attempt is proven not applied.
		}

		const recovered = await reconcileHubDetachedAttempt(
			store,
			derived.operation,
			derived.attempt,
			derived.inspectRequest,
			currentAuthority,
		);
		if (recovered.status === "applied") {
			if (!isHubTerminalReceipt(recovered.receipt)) return "blocked_indeterminate";
			if (recovered.receipt.disposition !== disposition) return "already_terminal";
			return recovered.receipt.reservationReceiptSha256 === reservation.receiptSha256
				? "consumed"
				: "blocked_indeterminate";
		}
		if (recovered.status === "blocked_indeterminate") return "blocked_indeterminate";
		prepared = recovered;
	}
	return "blocked_indeterminate";
}

async function consumeTransientJobResult(
	manager: AsyncJobManager,
	job: AsyncJob,
	row: TransientSettledRow,
	disposition: ImmediateHubConsumptionDisposition,
): Promise<HubConsumptionOutcome> {
	const completion = row.transientTaskCompletion;
	const currentAuthority = completion.currentAuthority;
	const recovery = job.transientTaskRecoveryRecord;
	if (
		!isHubCurrentAuthority(currentAuthority) ||
		job.ownerId !== row.ownerId ||
		completion.ownerId !== row.ownerId ||
		completion.jobId !== row.jobId ||
		completion.settlementRequest.identity.ownerId !== row.ownerId ||
		completion.settlementRequest.identity.jobId !== row.jobId ||
		currentAuthority.ownerId !== row.ownerId ||
		currentAuthority.deliveryEpoch !== completion.settlementRequest.identity.deliveryEpoch ||
		!recovery ||
		recovery.recoveryState !== "handoff_ready" ||
		recovery.recoveryRecordSha256 !== row.transientTaskRecoveryRecordSha256 ||
		recovery.transientTaskCompletion?.handoffSha256 !== completion.handoffSha256 ||
		recovery.coordinates.jobId !== row.jobId ||
		recovery.coordinates.ownerSessionIndex.ownerId !== row.ownerId ||
		recovery.coordinates.ownerSessionIndex.deliveryEpoch !== currentAuthority.deliveryEpoch
	)
		return "blocked_indeterminate";
	const resolved = manager.resolveTransientTaskParentResultDeliveryStore(recovery.coordinates.ownerSessionIndex);
	if (resolved.status !== "resolved") return "blocked_indeterminate";
	const store = resolved.store.detachedSettlement;
	const reservation = await reserveTransientJobResult(store, row, { disposition }, currentAuthority);
	if (reservation.status === "terminal") {
		return reservation.disposition === disposition ? "consumed" : "already_terminal";
	}
	if (reservation.status !== "reserved") return "blocked_indeterminate";
	return commitTransientJobResult(store, row, disposition, currentAuthority, reservation.receipt);
}

export type HubWaitTransientJobReservationResultV1 =
	| { readonly status: "not_settled" | "plain_job" | "cancelled" | "blocked_indeterminate" | "already_terminal" }
	| { readonly status: "already_consumed" }
	| {
			readonly status: "reserved";
			commit(): Promise<HubConsumptionOutcome>;
	  };

/**
 * Freezes one settled managed-job reservation for a specific Hub wait. The
 * winner store serializes this reservation against message capture by the same
 * invocation id. Plain/running jobs retain their ordinary AsyncJobManager path.
 */
export async function reserveTransientJobResultForHubWait(
	manager: AsyncJobManager,
	job: AsyncJob,
	hubWaitInvocationId: OperationId,
): Promise<HubWaitTransientJobReservationResultV1> {
	let inspected: ConfidentialAsyncJobSettledRowInspectResultV1;
	try {
		inspected = await manager.inspectSettledRow({ jobId: job.id, ownerId: job.ownerId ?? null });
	} catch {
		return { status: "blocked_indeterminate" };
	}
	if (inspected.status === "running") return { status: "not_settled" };
	if (inspected.status === "cancelled") return { status: "cancelled" };
	if (inspected.status === "blocked_indeterminate") return { status: "blocked_indeterminate" };
	if (inspected.status !== "settled") return { status: "blocked_indeterminate" };
	if (inspected.row.transientTaskCompletion === null) return { status: "plain_job" };
	const row = inspected.row;
	const completion = row.transientTaskCompletion;
	const currentAuthority = completion.currentAuthority;
	const recovery = job.transientTaskRecoveryRecord;
	if (
		!isHubCurrentAuthority(currentAuthority) ||
		job.ownerId !== row.ownerId ||
		completion.ownerId !== row.ownerId ||
		completion.jobId !== row.jobId ||
		completion.settlementRequest.identity.ownerId !== row.ownerId ||
		completion.settlementRequest.identity.jobId !== row.jobId ||
		currentAuthority.ownerId !== row.ownerId ||
		currentAuthority.deliveryEpoch !== completion.settlementRequest.identity.deliveryEpoch ||
		!recovery ||
		recovery.recoveryState !== "handoff_ready" ||
		recovery.recoveryRecordSha256 !== row.transientTaskRecoveryRecordSha256 ||
		recovery.transientTaskCompletion?.handoffSha256 !== completion.handoffSha256 ||
		recovery.coordinates.jobId !== row.jobId ||
		recovery.coordinates.ownerSessionIndex.ownerId !== row.ownerId ||
		recovery.coordinates.ownerSessionIndex.deliveryEpoch !== currentAuthority.deliveryEpoch
	)
		return { status: "blocked_indeterminate" };
	const resolved = manager.resolveTransientTaskParentResultDeliveryStore(recovery.coordinates.ownerSessionIndex);
	if (resolved.status !== "resolved") return { status: "blocked_indeterminate" };
	const store = resolved.store.detachedSettlement;
	const reserved = await reserveTransientJobResult(
		store,
		row,
		{ disposition: "hub_wait_consumption", hubWaitInvocationId },
		currentAuthority,
	);
	if (reserved.status === "terminal") {
		return reserved.disposition === "hub_wait_consumption"
			? { status: "already_consumed" }
			: { status: "already_terminal" };
	}
	if (reserved.status !== "reserved") return { status: "blocked_indeterminate" };
	return {
		status: "reserved",
		commit: () => commitTransientJobResult(store, row, "hub_wait_consumption", currentAuthority, reserved.receipt),
	};
}

async function jobsAuthorizedForHubResult(
	manager: AsyncJobManager,
	jobs: AsyncJob[],
	disposition: ImmediateHubConsumptionDisposition,
	alreadyConsumed: ReadonlySet<string> = new Set<string>(),
): Promise<AsyncJob[]> {
	const authorized: AsyncJob[] = [];
	for (const job of jobs) {
		let inspected: ConfidentialAsyncJobSettledRowInspectResultV1;
		try {
			inspected = await manager.inspectSettledRow({ jobId: job.id, ownerId: job.ownerId ?? null });
		} catch {
			continue;
		}
		if (
			inspected.status === "running" ||
			inspected.status === "cancelled" ||
			inspected.status === "blocked_indeterminate"
		) {
			authorized.push(job);
			continue;
		}
		if (inspected.status !== "settled") continue;
		if (inspected.row.transientTaskCompletion === null) {
			authorized.push(job);
			continue;
		}
		const consumption = alreadyConsumed.has(job.id)
			? "consumed"
			: await consumeTransientJobResult(manager, job, inspected.row, disposition);
		if (consumption === "consumed") authorized.push(job);
	}
	return authorized;
}

/**
 * Running subagents from the registry that are not covered by one of the
 * caller's running jobs. Agents woken via hub messaging (idle wake / park
 * revival) and spawns owned by another agent run with no AsyncJobManager
 * entry, yet the UI's agent badge counts them — a snapshot must account for
 * that activity instead of implying the system is quiet. Existence is
 * already public via the peer roster, so listing ids here leaks nothing new;
 * job *control* stays owner-scoped.
 */
export function runningAgentsOutsideJobs(session: ToolSession): AgentActivitySnapshot[] {
	const registry = session.agentRegistry;
	if (!registry) return [];
	const selfId = session.getAgentId?.() ?? undefined;
	// Cover = the caller's RUNNING jobs only. A settled job still sitting in
	// delivery retention must not hide its agent if that agent was re-woken
	// (e.g. via a hub message) and is running again without a job.
	const covered = new Set<string>();
	const manager = session.asyncJobManager;
	if (manager) {
		for (const job of manager.getRunningJobs(selfId ? { ownerId: selfId } : undefined)) {
			covered.add(job.id);
			if (job.agentId) covered.add(job.agentId);
		}
	}
	const now = Date.now();
	const out: AgentActivitySnapshot[] = [];
	for (const ref of registry.list()) {
		if (ref.kind !== "sub" || ref.status !== "running") continue;
		if (ref.id === selfId || covered.has(ref.id)) continue;
		out.push({
			id: ref.id,
			...(ref.parentId ? { parentId: ref.parentId } : {}),
			...(ref.activity ? { activity: ref.activity } : {}),
			ageMs: Math.max(0, now - ref.createdAt),
		});
	}
	return out;
}

/** Model-facing lines for the running-agents section shared by `jobs` and empty-wait results. */
function describeAgents(agents: AgentActivitySnapshot[]): string[] {
	const lines = [`## Running Agents (${agents.length}) — not job-backed\n`];
	for (const agent of agents) {
		const parent = agent.parentId ? ` (spawned by \`${agent.parentId}\`)` : "";
		const activity = agent.activity ? ` — ${agent.activity}` : "";
		lines.push(`- \`${agent.id}\`${parent} — up ${formatDuration(agent.ageMs)}${activity}`);
	}
	lines.push("", "These agents have no job entry; message them via `hub` send, transcripts at `history://<id>`.");
	return lines;
}

interface TrackedJobLike {
	id: string;
	type: "bash" | "task";
	status: string;
	label: string;
	startTime: number;
	latestDetails?: Record<string, unknown>;
	transientTaskSettlementManaged?: boolean;
	resultText?: string;
	errorText?: string;
}

export function snapshotJobs(session: ToolSession, jobs: TrackedJobLike[]): JobSnapshot[] {
	const now = Date.now();
	return jobs.map(j => {
		const current = session.asyncJobManager?.getJob(j.id);
		const latest = current ?? j;
		let resolvedModel: string | undefined;
		if (latest.type === "task") {
			const progressValue = latest.latestDetails?.progress;
			if (Array.isArray(progressValue)) {
				let progressRecord: Record<string, unknown> | undefined;
				for (const item of progressValue) {
					if (!item || typeof item !== "object") continue;
					const candidate = item as Record<string, unknown>;
					if (!progressRecord) progressRecord = candidate;
					if (candidate.id === latest.id) {
						progressRecord = candidate;
						break;
					}
				}
				const modelValue = progressRecord?.resolvedModel;
				if (typeof modelValue === "string") {
					const trimmed = modelValue.trim();
					if (trimmed) resolvedModel = trimmed;
				}
			}
		}
		return {
			id: latest.id,
			type: latest.type,
			status: latest.status as JobSnapshot["status"],
			label: latest.label,
			durationMs: Math.max(0, now - latest.startTime),
			...(resolvedModel ? { resolvedModel } : {}),
			...(latest.resultText ? { resultText: latest.resultText } : {}),
			...(latest.errorText ? { errorText: latest.errorText } : {}),
		};
	});
}

export function buildJobResult(
	session: ToolSession,
	manager: AsyncJobManager,
	op: "wait" | "cancel" | "jobs",
	jobs: TrackedJobLike[],
	cancelOutcomes: CancelOutcome[],
	agents: AgentActivitySnapshot[] = [],
): AgentToolResult<CoordinationDetails> {
	// Deduplicate by id (cancelled jobs may also appear in the watched set).
	const seen = new Set<string>();
	const uniqueJobs = jobs.filter(j => {
		if (seen.has(j.id)) return false;
		seen.add(j.id);
		return true;
	});
	const jobResults = snapshotJobs(session, uniqueJobs);

	manager.acknowledgeDeliveries(
		uniqueJobs
			.filter(
				(job, index) =>
					jobResults[index]?.status !== "running" &&
					job.transientTaskSettlementManaged !== true &&
					manager.getJob(job.id)?.transientTaskSettlementManaged !== true,
			)
			.map(job => job.id),
	);

	const completed = jobResults.filter(j => j.status !== "running");
	const running = jobResults.filter(j => j.status === "running");

	const lines: string[] = [];

	if (cancelOutcomes.length > 0) {
		lines.push(`## Cancelled (${cancelOutcomes.length})\n`);
		for (const o of cancelOutcomes) lines.push(`- ${o.message}`);
		lines.push("");
	}

	if (completed.length > 0) {
		lines.push(`## Completed (${completed.length})\n`);
		for (const j of completed) {
			lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
			lines.push(`Label: ${j.label}`);
			if (j.resultText) {
				lines.push("```", j.resultText, "```");
			}
			if (j.errorText) {
				lines.push(`Error: ${j.errorText}`);
			}
			lines.push("");
		}
	}

	if (running.length > 0) {
		lines.push(`## Still Running (${running.length})\n`);
		for (const j of running) {
			lines.push(`- \`${j.id}\` [${j.type}] — ${j.label}`);
		}
	}

	if (agents.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(...describeAgents(agents));
	}

	// A tool result must never be empty text — the model cannot tell "no
	// jobs" from a malfunction (reported exactly that way in QA).
	if (lines.length === 0) {
		lines.push("No background jobs.");
	}

	const details: CoordinationDetails = {
		op,
		jobs: jobResults,
		...(cancelOutcomes.length ? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) } : {}),
		...(agents.length ? { agents } : {}),
	};
	return {
		content: [{ type: "text", text: lines.join("\n").trimEnd() }],
		details,
		// A wait where everything is still running carries no new information
		// once a later wait exists — same predicate the TUI uses to displace
		// stale waiting frames.
		...(isWaitingPollDetails(details) ? { useless: true } : {}),
	};
}

/** `wait` with explicit ids that matched nothing visible: correct the caller, surface live agents. */
export function noMatchingJobsResult(session: ToolSession, ids: string[]): AgentToolResult<CoordinationDetails> {
	// Zero pollable jobs is not necessarily "nothing running": agents woken
	// via hub messages or owned by another agent run with no job entry.
	// Report them so the snapshot matches the UI's running-agent count
	// (task job ids are agent ids, so a stale id often names one).
	const agents = runningAgentsOutsideJobs(session);
	const lines: string[] = [`No matching jobs found for IDs: ${ids.join(", ")}`];
	const registry = session.agentRegistry;
	for (const id of ids) {
		const ref = registry?.get(id);
		if (!ref) continue;
		lines.push(
			ref.status === "running"
				? `- \`${id}\` is a running agent with no job entry — message it via \`hub\` send; transcript at history://${id}`
				: `- \`${id}\` is a ${ref.status} agent (its job is gone) — transcript at history://${id}`,
		);
	}
	if (agents.length > 0) {
		lines.push("", ...describeAgents(agents));
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "wait", jobs: [], ...(agents.length ? { agents } : {}) },
		// Nothing found is noise once consumed — the follow-up call has already
		// corrected course. Running agents are real state the model may act on,
		// so keep those results.
		...(agents.length === 0 ? { useless: true } : {}),
	};
}

/** Bare `wait` with no running jobs and nobody who could message: nothing to block on. */
export function nothingToWaitForResult(session: ToolSession): AgentToolResult<CoordinationDetails> {
	const agents = runningAgentsOutsideJobs(session);
	const lines: string[] = ["No running background jobs to wait for."];
	if (agents.length > 0) {
		lines.push("", ...describeAgents(agents));
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "wait", jobs: [], ...(agents.length ? { agents } : {}) },
		...(agents.length === 0 ? { useless: true } : {}),
	};
}

/** `cancel`: kill the named jobs; returns immediately with outcomes + snapshots. */
export async function executeCancel(
	session: ToolSession,
	manager: AsyncJobManager,
	ownerId: string | undefined,
	ids: string[],
): Promise<AgentToolResult<CoordinationDetails>> {
	const ownerFilter = ownerId ? { ownerId } : undefined;
	const cancelOutcomes: CancelOutcome[] = [];
	const consumedTransientIds = new Set<string>();
	for (const id of ids) {
		const existing = manager.getJob(id);
		if (!existing || (ownerId && existing.ownerId !== ownerId)) {
			// No job by this id (or it belongs to another agent): a budget-aborted
			// keep-alive subagent may still have a cancellable registration.
			cancelOutcomes.push(await cancelAgentRegistration(session, ownerId, id));
			continue;
		}

		let inspected: ConfidentialAsyncJobSettledRowInspectResultV1;
		try {
			inspected = await manager.inspectSettledRow({ jobId: id, ownerId: existing.ownerId ?? null });
		} catch {
			cancelOutcomes.push({
				id,
				status: "already_completed",
				message: `Background job ${id} could not be authoritatively inspected; no cancellation was applied.`,
			});
			continue;
		}

		if (inspected.status === "blocked_indeterminate") {
			cancelOutcomes.push({
				id,
				status: "already_completed",
				message: `Background job ${id} has an indeterminate durable settlement; cancellation was rejected and the recovery state was preserved.`,
			});
			continue;
		}

		if (inspected.status === "settled") {
			if (inspected.row.transientTaskCompletion !== null) {
				const consumption = await consumeTransientJobResult(
					manager,
					existing,
					inspected.row,
					"hub_cancel_consumption",
				);
				if (consumption === "blocked_indeterminate") {
					cancelOutcomes.push({
						id,
						status: "already_completed",
						message: `Background job ${id} is already settled; its durable result could not be authoritatively resolved, so recovery state was preserved.`,
					});
					continue;
				}
				if (consumption === "consumed") consumedTransientIds.add(id);
			}
			// A settled task registration can remain idle or parked after its job row.
			const regOutcome = await cancelAgentRegistration(session, ownerId, id);
			cancelOutcomes.push(
				regOutcome.status === "cancelled"
					? regOutcome
					: {
							id,
							status: "already_completed",
							message: `Background job ${id} is already ${existing.status}.`,
						},
			);
			continue;
		}

		if (inspected.status === "cancelled") {
			if (existing.transientTaskSettlementManaged) {
				cancelOutcomes.push({
					id,
					status: "already_completed",
					message: `Background job ${id} cancellation is already settling durably.`,
				});
				continue;
			}
			const regOutcome = await cancelAgentRegistration(session, ownerId, id);
			cancelOutcomes.push(
				regOutcome.status === "cancelled"
					? regOutcome
					: { id, status: "already_completed", message: `Background job ${id} is already cancelled.` },
			);
			continue;
		}

		if (inspected.status !== "running") {
			const notFound = inspected.status === "absent" || inspected.status === "owner_mismatch";
			cancelOutcomes.push({
				id,
				status: notFound ? "not_found" : "already_completed",
				message: notFound
					? `Background job not found: ${id}`
					: `Background job ${id} could not be authoritatively verified; no cancellation was applied.`,
			});
			continue;
		}

		const cancelled = manager.cancel(id, ownerFilter);
		cancelOutcomes.push(
			cancelled
				? { id, status: "cancelled", message: `Cancelled background job ${id}.` }
				: { id, status: "already_completed", message: `Background job ${id} is already completed.` },
		);
	}
	const jobs = await jobsAuthorizedForHubResult(
		manager,
		visibleJobs(manager, ids, ownerId),
		"hub_cancel_consumption",
		consumedTransientIds,
	);
	return buildJobResult(session, manager, "cancel", jobs, cancelOutcomes);
}

/**
 * Kill a non-job-backed agent registration named by `id`: abort any in-flight
 * turn, then release it from the lifecycle (dispose session + unregister). This
 * is the only kill path for a keep-alive subagent that was budget-aborted, went
 * `idle`/`parked`, and outlived its job row — otherwise it is unstoppable short
 * of a broker restart (issue #6315). Scoped to the caller's own descendants so
 * cross-agent kills stay impossible; a bare test/SDK caller (no owner id) may
 * target any sub. Never touches Main, the caller, or advisor transcripts.
 */
async function cancelAgentRegistration(
	session: ToolSession,
	ownerId: string | undefined,
	id: string,
): Promise<CancelOutcome> {
	const registry = session.agentRegistry;
	const ref = registry?.get(id);
	if (ref?.kind !== "sub") {
		return { id, status: "not_found", message: `Background job not found: ${id}` };
	}
	if (id === ownerId) {
		return { id, status: "not_found", message: `Cannot cancel yourself (${id}).` };
	}
	if (ownerId && ref.parentId !== ownerId) {
		return { id, status: "not_found", message: `Agent ${id} was not spawned by you and cannot be cancelled.` };
	}
	const lifecycle = session.agentLifecycle?.();
	try {
		if (ref.status === "running" && ref.session) {
			await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		if (lifecycle) {
			await lifecycle.release(id);
		} else {
			await ref.session?.dispose();
			registry?.unregister(id);
		}
	} catch (error) {
		return {
			id,
			status: "already_completed",
			message: `Agent ${id} could not be fully cancelled: ${error instanceof Error ? error.message : String(error)}.`,
		};
	}
	return { id, status: "cancelled", message: `Cancelled agent ${id} (killed session, dropped registration).` };
}

/** `jobs`: consumes settled transient handoffs durably; plain jobs retain legacy acknowledgement. */
export async function executeJobsSnapshot(
	session: ToolSession,
	manager: AsyncJobManager,
	ownerId: string | undefined,
): Promise<AgentToolResult<CoordinationDetails>> {
	const jobs = await jobsAuthorizedForHubResult(
		manager,
		manager.getAllJobs(ownerId ? { ownerId } : undefined),
		"hub_jobs_consumption",
	);
	return buildJobResult(session, manager, "jobs", jobs, [], runningAgentsOutsideJobs(session));
}

// =============================================================================
// TUI Renderer (jobs half)
// =============================================================================

interface JobRenderArgs {
	poll?: string[];
	cancel?: string[];
	list?: boolean;
}

/** Hub args → legacy job-renderer arg shape, preserving the exact frame titles. */
function toJobRenderArgs(args: HubRenderArgs | undefined): JobRenderArgs | undefined {
	if (!args) return undefined;
	switch (args.op) {
		case "wait":
			return { poll: args.ids };
		case "cancel":
			return { cancel: args.ids ?? [] };
		case "jobs":
			return { list: true };
		default:
			return {};
	}
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;
const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const LABEL_LINES_COLLAPSED = 1;
const LABEL_LINES_EXPANDED = 3;
const PREVIEW_LINE_WIDTH = 80;
const MODEL_BADGE_MAX_WIDTH = 48;

function statusToIcon(status: JobSnapshot["status"]): ToolUIStatus {
	switch (status) {
		case "completed":
			return "done";
		case "failed":
			return "error";
		case "cancelled":
			return "aborted";
		case "running":
			return "running";
	}
}

function statusToColor(status: JobSnapshot["status"]): ToolUIColor {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "warning";
		case "running":
			return "accent";
	}
}

/**
 * Task job results are delivered in the model-facing `<task-result>` envelope
 * (prompts/tools/task-summary.md) so the parent agent can parse status and the
 * `agent://` pointer. The wrapper markup is noise to a human — preview the
 * inner <output>/<preview> body instead.
 */
function stripTaskResultEnvelope(text: string): string {
	if (!text.startsWith("<task-result")) return text;
	const body = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(text)?.[2];
	return body?.trim() || text;
}

/**
 * Pretty-printed JSON output wastes the collapsed one-line preview on a lone
 * "{" — flatten structured-looking bodies onto a single line. Slice first:
 * downstream truncation keeps at most a few hundred columns, so collapsing
 * whitespace across a multi-KB body would be pure waste.
 */
function flattenStructuredPreview(text: string): string {
	const first = text[0];
	if (first !== "{" && first !== "[") return text;
	return text.slice(0, PREVIEW_LINES_EXPANDED * PREVIEW_LINE_WIDTH * 2).replace(/\s+/g, " ");
}

function describeTarget(args: JobRenderArgs | undefined): string {
	if (args?.list) return "background jobs";
	const poll = args?.poll ?? [];
	const cancel = args?.cancel ?? [];
	const parts: string[] = [];
	if (cancel.length > 0) {
		parts.push(cancel.length === 1 ? `cancel ${cancel[0]}` : `cancel ${cancel.length} jobs`);
	}
	if (poll.length > 0) {
		parts.push(poll.length === 1 ? `poll ${poll[0]}` : `poll ${poll.length} jobs`);
	}
	if (parts.length === 0) return "all running jobs";
	return parts.join(", ");
}

/** Pending-call frame for job ops (wait/cancel/jobs). */
export function jobsRenderCall(args: HubRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
	const text = renderStatusLine({ icon: "pending", title: describeTarget(toJobRenderArgs(args)) || "Job" }, uiTheme);
	return new Text(text, 0, 0);
}

/** Result frame for job snapshots (wait/cancel/jobs and the agents roster). */
export function jobsRenderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: CoordinationDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme,
	hubArgs?: HubRenderArgs,
): Component {
	const args = toJobRenderArgs(hubArgs);
	let jobs = result.details?.jobs ?? [];
	const agents = result.details?.agents ?? [];

	if (jobs.length === 0 && agents.length === 0) {
		const fallback = result.content?.find(c => c.type === "text")?.text || "No jobs to process";
		const header = renderStatusLine({ icon: "warning", title: describeTarget(args) || "Job" }, uiTheme);
		return new Text([header, formatEmptyMessage(fallback, uiTheme)].join("\n"), 0, 0);
	}

	const isPollCall = args ? !args.list && (!args.cancel || args.cancel.length === 0 || args.poll !== undefined) : true;

	// Agent-carrying results (jobs snapshot / empty-wait roster) are real
	// snapshots, not displaceable waiting frames — only agentless waits
	// collapse their still-running rows once sealed.
	if (!options.isPartial && isPollCall && agents.length === 0) {
		jobs = jobs.filter(job => job.status !== "running");
		if (jobs.length === 0) {
			return new Text("", 0, 0);
		}
	}

	const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
	for (const job of jobs) counts[job.status]++;

	// The title already carries the running count, so meta lists only the
	// settled categories — "waiting on 19 of 19 · 19 running" read awkward.
	const meta: string[] = [];
	if (counts.completed > 0) meta.push(uiTheme.fg("success", `${counts.completed} done`));
	if (counts.failed > 0) meta.push(uiTheme.fg("error", `${counts.failed} failed`));
	if (counts.cancelled > 0) meta.push(uiTheme.fg("warning", `${counts.cancelled} cancelled`));
	if (agents.length > 0 && jobs.length > 0) {
		meta.push(uiTheme.fg("accent", `${agents.length} agent${agents.length === 1 ? "" : "s"}`));
	}

	const headerIcon: ToolUIStatus =
		counts.failed > 0 ? "warning" : counts.running > 0 || agents.length > 0 ? "info" : "success";
	const jobsNoun = jobs.length === 1 ? "job" : "jobs";
	const description =
		jobs.length === 0
			? `${agents.length} running agent${agents.length === 1 ? "" : "s"} — no jobs`
			: counts.running > 0
				? counts.running === jobs.length
					? `waiting on ${jobs.length} ${jobsNoun}`
					: `waiting on ${counts.running} of ${jobs.length} ${jobsNoun}`
				: `${jobs.length} ${jobsNoun} settled`;

	const header = renderStatusLine(
		{
			icon: headerIcon,
			spinnerFrame: counts.running > 0 || agents.length > 0 ? options.spinnerFrame : undefined,
			title: description,
			meta,
		},
		uiTheme,
	);

	// Sort: running first (so user sees what's still pending), then failed, then completed/cancelled.
	const statusOrder: Record<JobSnapshot["status"], number> = {
		running: 0,
		failed: 1,
		cancelled: 2,
		completed: 3,
	};
	const sortedJobs = [...jobs].sort((a, b) => {
		const diff = statusOrder[a.status] - statusOrder[b.status];
		if (diff !== 0) return diff;
		return b.durationMs - a.durationMs;
	});

	let cached: RenderCache | undefined;
	return {
		render(width: number): readonly string[] {
			const expanded = options.expanded;
			const spinnerFrame = options.spinnerFrame ?? 0;
			// Running-job labels shimmer while the wait block is live; the band
			// phase is Date.now()-sampled at render time, so serving cached bytes
			// would pin it to the ~12.5fps spinner-glyph cadence instead of the
			// 30fps redraw. Bypass the cache while any row animates, and key on
			// the animation state so a sealed block never hits stale shimmered
			// bytes (spinnerFrame falls back to 0 on both sides of the seal).
			const shimmerActive = counts.running > 0 && options.spinnerFrame !== undefined && shimmerEnabled();
			const key = new Hasher().bool(expanded).u32(width).u32(spinnerFrame).bool(shimmerActive).digest();
			if (!shimmerActive && cached?.key === key) return cached.lines;

			const itemLines = renderTreeList<JobSnapshot>(
				{
					items: sortedJobs,
					expanded,
					maxCollapsed: COLLAPSED_LIST_LIMIT,
					itemType: "job",
					renderItem: job => {
						const lines: string[] = [];
						const icon = formatStatusIcon(
							statusToIcon(job.status),
							uiTheme,
							job.status === "running" ? options.spinnerFrame : undefined,
						);
						const typeBadge = formatBadge(job.type, statusToColor(job.status), uiTheme);
						// Task jobs label themselves with their agent id, which is also
						// the job id — drop the id column instead of stuttering it twice.
						const idPart = job.label.trim() === job.id ? "" : ` ${uiTheme.fg("muted", job.id)}`;
						const rawLabelLines = (job.label || "(no label)").split(/\r?\n/);
						const maxLabelLines = expanded ? LABEL_LINES_EXPANDED : LABEL_LINES_COLLAPSED;
						const visibleLabelLines = rawLabelLines
							.slice(0, maxLabelLines)
							.map(l => truncateToWidth(replaceTabs(l), LABEL_MAX_WIDTH, Ellipsis.Unicode));
						if (rawLabelLines.length > maxLabelLines && visibleLabelLines.length > 0) {
							const last = visibleLabelLines[visibleLabelLines.length - 1]!;
							visibleLabelLines[visibleLabelLines.length - 1] = `${last} …`;
						}
						const durationText = uiTheme.fg("dim", formatDuration(job.durationMs));
						const modelText =
							job.type === "task" &&
							typeof job.resolvedModel === "string" &&
							job.resolvedModel.trim() &&
							settings.get("task.showResolvedModelBadge")
								? `${uiTheme.sep.dot}${uiTheme.fg(
										"dim",
										truncateToWidth(
											replaceTabs(job.resolvedModel.trim()),
											MODEL_BADGE_MAX_WIDTH,
											Ellipsis.Unicode,
										),
									)}`
								: "";
						// Running rows in a live block shimmer their label; once the block
						// stops animating (sealed, or a settled snapshot — spinnerFrame
						// cleared) they render static so scrollback never keeps a mid-sweep
						// shimmer band.
						const live = job.status === "running" && options.spinnerFrame !== undefined;
						const headRaw = visibleLabelLines[0] ?? "";
						const headLabel = live
							? shimmerEnabled()
								? shimmerText(headRaw, uiTheme)
								: uiTheme.fg("accent", headRaw)
							: uiTheme.fg("toolOutput", headRaw);
						lines.push(
							`${icon}${idPart} ${typeBadge} ${headLabel}${modelText}${modelText ? uiTheme.sep.dot : " "}${durationText}`,
						);
						for (let i = 1; i < visibleLabelLines.length; i++) {
							lines.push(`  ${uiTheme.fg("toolOutput", visibleLabelLines[i]!)}`);
						}

						const preview = flattenStructuredPreview(
							stripTaskResultEnvelope(job.errorText?.trim() || job.resultText?.trim() || ""),
						);
						if (preview) {
							const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
							const previewLines = getPreviewLines(preview, maxLines, PREVIEW_LINE_WIDTH, Ellipsis.Unicode);
							const tone = job.errorText ? "error" : "dim";
							for (const pl of previewLines) {
								lines.push(`  ${uiTheme.fg(tone, pl)}`);
							}
						}
						return lines;
					},
				},
				uiTheme,
			);

			// Agents run outside job control; render them as their own tree so
			// they never skew the job counts or the "waiting on N jobs" title.
			const agentLines =
				agents.length === 0
					? []
					: renderTreeList<AgentActivitySnapshot>(
							{
								items: agents,
								expanded,
								maxCollapsed: COLLAPSED_LIST_LIMIT,
								itemType: "agent",
								renderItem: agent => {
									const icon = formatStatusIcon("running", uiTheme, options.spinnerFrame);
									const badge = formatBadge("agent", "accent", uiTheme);
									const gist = agent.activity
										? ` ${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(agent.activity), LABEL_MAX_WIDTH, Ellipsis.Unicode))}`
										: "";
									const parent = agent.parentId ? uiTheme.fg("dim", ` ← ${agent.parentId}`) : "";
									const age = uiTheme.fg("dim", formatDuration(agent.ageMs));
									return [`${icon} ${uiTheme.fg("muted", agent.id)} ${badge}${gist} ${age}${parent}`];
								},
							},
							uiTheme,
						);

			const all = [header, ...itemLines, ...agentLines].map(l => truncateToWidth(l, width, Ellipsis.Unicode));
			cached = { key, lines: all };
			return all;
		},
		invalidate() {
			cached = undefined;
		},
	};
}
