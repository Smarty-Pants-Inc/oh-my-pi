import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isProxy } from "node:util/types";
import type {
	ImageContent,
	Message,
	MessageAttribution,
	ServiceTierByFamily,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@oh-my-pi/pi-ai";
import {
	directoryExists,
	getBlobsDir,
	getProjectDir,
	getSessionsDir,
	isEnoent,
	logger,
	toError,
} from "@oh-my-pi/pi-utils";
import type { ISO8601, OperationId, Sha256Hex, Sha256Ref } from "../registry/persistent-agent-contracts";
import {
	type StructuredSubagentSchemaMode,
	validateAndProjectTransientTaskForegroundSourceAgentToolResultV1,
} from "../task/types";
import { ArtifactManager } from "./artifacts";
import { type AsyncResultEntry, buildAsyncResultBatchMessage } from "./async-job-delivery";
import { type BlobPutOptions, type BlobPutResult, BlobStore } from "./blob-store";
import {
	type BashExecutionMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	normalizeCustomMessagePayload,
	type PythonExecutionMessage,
	sanitizeRehydratedOpenAIResponsesAssistantMessage,
	stripInternalDetailsFields,
} from "./messages";
import { type BuildSessionContextOptions, buildSessionContext, type SessionContext } from "./session-context";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type CredentialPinEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	type LabelEntry,
	type ModeChangeEntry,
	type ModelChangeEntry,
	type NewSessionOptions,
	type ResetBoundaryEntry,
	type ServiceTierChangeEntry,
	type SessionEntry,
	type SessionHeader,
	type SessionInitEntry,
	type SessionMessageEntry,
	type SessionTitleSource,
	type SessionTreeNode,
	type ThinkingLevelChangeEntry,
	TITLE_CHANGE_ENTRY_TYPE,
	type TitleChangeEntry,
	type TtsrInjectionEntry,
	type UsageStatistics,
} from "./session-entries";
import type {
	CanonicalSessionEntryProjectionV1,
	CanonicalSessionProjectionV1,
	PrimarySessionDurabilityReceipt,
	SessionJournalReplaceReason,
	SessionJournalService,
	SessionJournalStreamDescriptorV1,
	SessionJournalStreamHandle,
} from "./session-journal-contracts.js";
import { findMostRecentSession, listAllSessions, listSessions, type SessionInfo } from "./session-listing";
import { loadEntriesFromFile, readTitleSlotFromFile, resolveBlobRefsInEntries } from "./session-loader";
import { generateId, migrateToCurrentVersion } from "./session-migrations";
import {
	computeDefaultSessionDir,
	readTerminalBreadcrumbEntry,
	resolveManagedSessionRoot,
	writeTerminalBreadcrumb,
} from "./session-paths";
import {
	type CanonicalSessionPersistenceProjection,
	projectSessionEntryForPersistence,
	projectSessionForPersistence,
} from "./session-persistence";
import {
	createPrimarySessionDurabilityReceipt,
	FileSessionStorage,
	MemorySessionStorage,
	type SessionStorage,
	type SessionStorageWriter,
} from "./session-storage";
import { type SessionTitleUpdate, serializeTitleSlot } from "./session-title-slot";
import {
	additionalWorkspaceDirectories,
	normalizeSessionWorkspace,
	normalizeWorkspaceDirectory,
} from "./session-workspace";
import {
	type AgentSessionToolResultPersistenceSerializerV1,
	type ConfidentialAgentSessionToolResultPrimaryPersistenceReceiptV1,
	buildTransientTaskHubWaitMessageCanonicalRecordV1,
	type ConfidentialAgentSessionJournalGenerationAuthorityResultV1,
	type ConfidentialTransientTaskDetachedPrimarySessionAppendAbsenceProofV1,
	type ConfidentialTransientTaskDetachedPrimarySessionAppendAdoptRequestV1,
	type ConfidentialTransientTaskDetachedPrimarySessionAppendAdoptResultV1,
	type ConfidentialTransientTaskDetachedPrimarySessionAppendInspectRequestV1,
	type ConfidentialTransientTaskDetachedPrimarySessionAppendInspectResultV1,
	type ConfidentialTransientTaskDetachedPrimarySessionAppendPlanPrepareRequestV1,
	type ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1,
	type ConfidentialTransientTaskDetachedPrimarySessionAppendRequestV1,
	type ConfidentialTransientTaskDetachedPrimarySessionAppendResultV1,
	type ConfidentialTransientTaskDetachedPrimarySessionMessageV1,
	type ConfidentialTransientTaskDetachedPrimarySessionPendingPlanEnumerateRequestV1,
	type ConfidentialTransientTaskDetachedPrimarySessionPersistenceReceiptV1,
	type ConfidentialTransientTaskDetachedSessionOutboxMemberV1,
	type ConfidentialTransientTaskDetachedSessionOutboxReceiptV1,
	type ConfidentialTransientTaskForegroundBeforeReturnAdoptionReceiptV1,
	type ConfidentialTransientTaskForegroundBeforeReturnRecordV1,
	type ConfidentialTransientTaskForegroundBeforeReturnRecoveryKeyV1,
	type ConfidentialTransientTaskForegroundBeforeReturnSuspensionV1,
	type ConfidentialTransientTaskForegroundResultHandoffBatchV1,
	type ConfidentialTransientTaskForegroundRenderedGateV1,
	type ConfidentialTransientTaskForegroundTtsrInjectionAppendReceiptV1,
	type ConfidentialTransientTaskForegroundTtsrOverlayCommitReceiptV1,
	type ConfidentialTransientTaskForegroundTtsrOverlaySnapshotV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptRequestV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptResultV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionPlanV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionReceiptV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionStateV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionReceiptV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionRequestV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryEffectResultV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryExactMessageRequestV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryInspectionV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryInspectRequestV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerPermitV1,
	type ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationPermitV1,
	type ConfidentialTransientTaskHubSendAwaitTargetFailedObservationRequestV1,
	type ConfidentialTransientTaskHubSendAwaitTargetSessionAppendAdoptRequestV1,
	type ConfidentialTransientTaskHubSendAwaitTargetSessionAppendAdoptResultV1,
	type ConfidentialTransientTaskHubSendAwaitTargetSessionAppendInspectionV1,
	type ConfidentialTransientTaskHubSendAwaitTargetSessionAppendInspectRequestV1,
	type ConfidentialTransientTaskHubSendAwaitTargetSessionAppendReceiptV1,
	type ConfidentialTransientTaskHubSendAwaitTargetSessionAppendRequestV1,
	type ConfidentialTransientTaskParentDeliveryEffectIdentityDerivationDescriptorV1,
	type ConfidentialTransientTaskPendingCaptureRecordV1,
	canonicalTransientTaskSourceObservationDigestV1,
	decodeTransientTaskPendingCaptureIndexKeyV1,
	deriveTransientTaskEffectOperationIdV1,
	deriveTransientTaskForegroundAppendBatchKeyV1,
	type SessionManagerJournalGenerationAuthorityResolverV1,
	type TransientTaskDetachedPrimarySessionAppendBridgeV1,
	type TransientTaskDetachedSettlementIdentityV1,
	type TransientTaskForegroundBeforeReturnRecoveryBridgeV1,
	type TransientTaskForegroundPendingTtsrOverlayStoreV1,
	type TransientTaskForegroundTtsrOverlayCommitResultV1,
	type TransientTaskForegroundTtsrOverlaySnapshotAdapterV1,
	type TransientTaskForegroundSessionAppendBridgeV1,
	type TransientTaskHubSendAwaitTargetSessionAppendResultV1,
	type TransientTaskLifecycleGateStoreV1,
	validateTransientTaskHubWaitMessageCanonicalRecordV1,
} from "./workspace-runtime-contracts";

const JSONL_SUFFIX_LENGTH = ".jsonl".length;
const DRAFT_ONLY_SESSION_MARKER = ".draft-only-session";
const DETACHED_PRIMARY_APPEND_STATE_CUSTOM_TYPE = "transient-task-detached-primary-session-append-v1";
const TRANSIENT_RUNTIME_STATE_CUSTOM_TYPE = "transient-task-session-manager-runtime-v1";

function isSessionManagerTransientStateEntry(entry: SessionEntry): entry is CustomEntry {
	return entry.type === "custom" && entry.customType === TRANSIENT_RUNTIME_STATE_CUSTOM_TYPE;
}

function isSessionManagerSidecarEntry(entry: SessionEntry): entry is CustomEntry {
	return isDetachedPrimaryAppendStateEntry(entry) || isSessionManagerTransientStateEntry(entry);
}
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;

function isDetachedPrimaryAppendStateEntry(entry: SessionEntry): entry is CustomEntry {
	return entry.type === "custom" && entry.customType === DETACHED_PRIMARY_APPEND_STATE_CUSTOM_TYPE;
}

type DetachedPrimaryAppendPreparedStateV1 = {
	readonly schemaVersion: 1;
	readonly state: "not_applied";
	readonly plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1;
	readonly orderedOutboxReceipts: readonly [
		ConfidentialTransientTaskDetachedSessionOutboxReceiptV1,
		...ConfidentialTransientTaskDetachedSessionOutboxReceiptV1[],
	];
};

type DetachedPrimaryAppendOutcomeUnknownStateV1 = {
	readonly schemaVersion: 1;
	readonly state: "outcome_unknown";
	readonly primaryAppendPlanSha256: Sha256Ref;
	readonly primaryAppendRequestSha256: Sha256Ref;
};

type DetachedPrimaryAppendCommittedStateV1 = {
	readonly schemaVersion: 1;
	readonly state: "committed";
	readonly receipt: ConfidentialTransientTaskDetachedPrimarySessionPersistenceReceiptV1;
};

type DetachedPrimaryAppendRestoredStateV1 = {
	readonly schemaVersion: 1;
	readonly state: "restored_not_applied";
	readonly primaryAppendPlanSha256: Sha256Ref;
	readonly primaryAppendRequestSha256: Sha256Ref;
	readonly inspectionSha256: Sha256Ref;
	readonly authoritativeAbsenceProof: ConfidentialTransientTaskDetachedPrimarySessionAppendAbsenceProofV1;
};

type DetachedPrimaryAppendStateEntryDataV1 =
	| DetachedPrimaryAppendPreparedStateV1
	| DetachedPrimaryAppendOutcomeUnknownStateV1
	| DetachedPrimaryAppendCommittedStateV1
	| DetachedPrimaryAppendRestoredStateV1;

interface DetachedPrimaryAppendRuntimeStateV1 {
	readonly plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1;
	readonly orderedOutboxReceipts: readonly [
		ConfidentialTransientTaskDetachedSessionOutboxReceiptV1,
		...ConfidentialTransientTaskDetachedSessionOutboxReceiptV1[],
	];
	status: "not_applied" | "outcome_unknown" | "committed";
	primaryAppendRequestSha256: Sha256Ref | null;
	receipt: ConfidentialTransientTaskDetachedPrimarySessionPersistenceReceiptV1 | null;
	restoredInspectionSha256: Sha256Ref | null;
}

interface DetachedPrimaryAppendStateProjectionV1 {
	readonly valid: boolean;
	readonly plans: Map<Sha256Ref, DetachedPrimaryAppendRuntimeStateV1>;
	readonly batchKeys: Map<Sha256Ref, DetachedPrimaryAppendRuntimeStateV1>;
	readonly memberSha256s: Map<Sha256Ref, DetachedPrimaryAppendRuntimeStateV1>;
}

function detachedStrictRecord<const Key extends string>(
	input: unknown,
	keys: readonly Key[],
): input is Record<Key, unknown> {
	if (input === null || typeof input !== "object" || Array.isArray(input) || isProxy(input)) return false;
	try {
		const prototype = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const actual = Reflect.ownKeys(input);
		const descriptors = Object.getOwnPropertyDescriptors(input);
		return (
			actual.length === keys.length &&
			actual.every(key => {
				if (typeof key !== "string" || !keys.some(expected => expected === key)) return false;
				const descriptor = descriptors[key];
				return descriptor?.enumerable === true && "value" in descriptor;
			})
		);
	} catch {
		return false;
	}
}

function detachedStrictArray(input: unknown): input is unknown[] {
	if (!Array.isArray(input) || isProxy(input)) return false;
	try {
		const descriptors = Object.getOwnPropertyDescriptors(input);
		for (let index = 0; index < input.length; index++) {
			const descriptor = descriptors[String(index)];
			if (descriptor?.enumerable !== true || !("value" in descriptor)) return false;
		}
		return Reflect.ownKeys(input).every(key => key === "length" || (typeof key === "string" && /^\d+$/.test(key)));
	} catch {
		return false;
	}
}

function detachedString(input: unknown, allowEmpty = false): input is string {
	if (typeof input !== "string" || (!allowEmpty && input.length === 0)) return false;
	for (let index = 0; index < input.length; index++) {
		const codeUnit = input.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = input.charCodeAt(++index);
			if (next < 0xdc00 || next > 0xdfff) return false;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
	}
	return true;
}

function detachedIdentity(input: unknown): input is string {
	return detachedString(input) && !input.includes("\0");
}

function detachedInteger(input: unknown, minimum = 0): input is number {
	return typeof input === "number" && Number.isSafeInteger(input) && !Object.is(input, -0) && input >= minimum;
}

function detachedIso8601(input: unknown): input is ISO8601 {
	return (
		typeof input === "string" &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input) &&
		new Date(input).toISOString() === input
	);
}

function detachedSha256Hex(input: unknown): input is Sha256Hex {
	return typeof input === "string" && SHA256_HEX.test(input);
}

function detachedSha256Ref(input: unknown): input is Sha256Ref {
	return typeof input === "string" && SHA256_REF.test(input);
}

function detachedTupleSha256Ref(tuple: readonly unknown[]): Sha256Ref {
	return `sha256:${createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex")}` as Sha256Ref;
}

function detachedUtf8Sha256Ref(input: string): Sha256Ref {
	return `sha256:${createHash("sha256").update(input, "utf8").digest("hex")}` as Sha256Ref;
}

type DetachedTaggedValueV1 =
	| { readonly t: "undefined" | "null" }
	| { readonly t: "boolean" | "number" | "string"; readonly v: boolean | number | string }
	| { readonly t: "array"; readonly v: readonly DetachedTaggedValueV1[] }
	| {
			readonly t: "object";
			readonly p: "object" | "null";
			readonly v: readonly (readonly [string, DetachedTaggedValueV1])[];
	  };

function encodeDetachedTaggedValue(input: unknown): DetachedTaggedValueV1 {
	if (input === undefined) return { t: "undefined" };
	if (input === null) return { t: "null" };
	if (typeof input === "boolean") return { t: "boolean", v: input };
	if (typeof input === "number") {
		if (!Number.isFinite(input) || Object.is(input, -0)) throw new TypeError("invalid_detached_number");
		return { t: "number", v: input };
	}
	if (typeof input === "string") {
		if (!detachedString(input, true)) throw new TypeError("invalid_detached_string");
		return { t: "string", v: input };
	}
	if (typeof input !== "object" || isProxy(input)) throw new TypeError("invalid_detached_value");
	if (Array.isArray(input)) {
		if (!detachedStrictArray(input)) throw new TypeError("invalid_detached_array");
		return { t: "array", v: input.map(encodeDetachedTaggedValue) };
	}
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) throw new TypeError("invalid_detached_object");
	const entries: Array<readonly [string, DetachedTaggedValueV1]> = [];
	for (const key of Reflect.ownKeys(input)) {
		if (typeof key !== "string" || !detachedString(key, true)) throw new TypeError("invalid_detached_key");
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (descriptor?.enumerable !== true || !("value" in descriptor)) throw new TypeError("invalid_detached_property");
		entries.push([key, encodeDetachedTaggedValue(descriptor.value)]);
	}
	return { t: "object", p: prototype === null ? "null" : "object", v: entries };
}

function detachedExactJson(left: unknown, right: unknown): boolean {
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}
function detachedCanonicalData(input: unknown): boolean {
	try {
		encodeDetachedTaggedValue(input);
		return true;
	} catch {
		return false;
	}
}
function detachedCanonicalRecord(input: unknown): input is Record<string, unknown> {
	return (
		input !== null &&
		typeof input === "object" &&
		!Array.isArray(input) &&
		!isProxy(input) &&
		detachedCanonicalData(input)
	);
}
function detachedControllerDigest(label: string, input: unknown): Sha256Ref {
	const tagged = encodeDetachedTaggedValue(["omp-transient-task-detached-store-v1", label, input]);
	return `sha256:${createHash("sha256").update(JSON.stringify(tagged), "utf8").digest("hex")}` as Sha256Ref;
}

type PendingOverlayFirstRequestV1 = Parameters<
	TransientTaskForegroundPendingTtsrOverlayStoreV1["prepareFirstVersionAndIndexStartedCapture"]
>[0];
type PendingOverlayVersionV1 = Parameters<
	TransientTaskForegroundPendingTtsrOverlayStoreV1["prepareSubsequentVersion"]
>[0];
type PendingOverlayFinalizeRequestV1 = Parameters<
	TransientTaskForegroundPendingTtsrOverlayStoreV1["finalizePendingOverlay"]
>[0];
type PendingOverlayInspectRequestV1 = Parameters<
	TransientTaskForegroundPendingTtsrOverlayStoreV1["inspectPendingOverlay"]
>[0];
type PendingOverlayAdoptRequestV1 = Parameters<
	TransientTaskForegroundPendingTtsrOverlayStoreV1["adoptPendingOverlay"]
>[0];
type PendingOverlayTerminalRequestV1 = Parameters<
	TransientTaskForegroundPendingTtsrOverlayStoreV1["recordCaptureTerminal"]
>[0];
type PendingOverlayTerminalInspectRequestV1 = Parameters<
	TransientTaskForegroundPendingTtsrOverlayStoreV1["inspectCaptureTerminal"]
>[0];
type PendingOverlayTerminalAdoptRequestV1 = Parameters<
	TransientTaskForegroundPendingTtsrOverlayStoreV1["adoptCaptureTerminal"]
>[0];
type PendingOverlayAnchorBindRequestV1 = Parameters<
	TransientTaskForegroundPendingTtsrOverlayStoreV1["bindPendingOverlayToAssistantAnchor"]
>[0];
type PendingOverlaySnapshotV1 = Extract<
	Awaited<ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["finalizePendingOverlay"]>>,
	{ readonly snapshot: unknown }
>["snapshot"];
type PendingOverlayPreDispatchBindingV1 = Extract<
	Awaited<ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["finalizePendingOverlay"]>>,
	{ readonly binding: unknown }
>["binding"];
type PendingOverlayBindingV1 = Extract<
	Awaited<ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["bindPendingOverlayToAssistantAnchor"]>>,
	{ readonly binding: unknown }
>["binding"];
type PendingOverlayTerminalReceiptV1 = Extract<
	Awaited<ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["recordCaptureTerminal"]>>,
	{ readonly receipt: unknown }
>["receipt"];

type LifecyclePrepareRequestV1 = Parameters<TransientTaskLifecycleGateStoreV1["prepareLifecycleGate"]>[0];
type LifecycleEnumerateRequestV1 = Parameters<TransientTaskLifecycleGateStoreV1["enumerateLifecycleGates"]>[0];
type LifecycleInspectRequestV1 = Parameters<TransientTaskLifecycleGateStoreV1["inspectLifecycleGate"]>[0];
type LifecycleAdoptRequestV1 = Parameters<TransientTaskLifecycleGateStoreV1["adoptLifecycleGate"]>[0];
type LifecycleResumeRequestV1 = Parameters<TransientTaskLifecycleGateStoreV1["resumeLifecycleGate"]>[0];
type LifecycleTerminalizeRequestV1 = Parameters<TransientTaskLifecycleGateStoreV1["terminalizeLifecycleGate"]>[0];
type LifecycleMarkerInspectRequestV1 = Parameters<
	TransientTaskLifecycleGateStoreV1["inspectLifecycleTerminalMarker"]
>[0];
type LifecycleMarkerAdoptRequestV1 = Parameters<TransientTaskLifecycleGateStoreV1["adoptLifecycleTerminalMarker"]>[0];
type LifecycleStateV1 =
	| Extract<
			Awaited<ReturnType<TransientTaskLifecycleGateStoreV1["prepareLifecycleGate"]>>,
			{ readonly state: unknown }
	  >["state"]
	| Extract<
			Awaited<ReturnType<TransientTaskLifecycleGateStoreV1["terminalizeLifecycleGate"]>>,
			{ readonly state: unknown }
	  >["state"];
type LifecycleAwaitingStateV1 = Extract<LifecycleStateV1, { readonly core: { readonly state: "awaiting_primary" } }>;
type LifecycleSuspendedStateV1 = Extract<LifecycleStateV1, { readonly core: { readonly state: "suspended" } }>;
type LifecycleTerminalizedStateV1 = Extract<LifecycleStateV1, { readonly core: { readonly state: "terminalized" } }>;
type LifecyclePreparedStateV1 = LifecycleAwaitingStateV1 | LifecycleSuspendedStateV1;

function lifecycleAwaitingState(state: LifecycleStateV1): state is LifecycleAwaitingStateV1 {
	return state.core.state === "awaiting_primary";
}

function lifecycleSuspendedState(state: LifecycleStateV1): state is LifecycleSuspendedStateV1 {
	return state.core.state === "suspended";
}

function lifecycleTerminalizedState(state: LifecycleStateV1): state is LifecycleTerminalizedStateV1 {
	return state.core.state === "terminalized";
}

function lifecyclePreparedState(state: LifecycleStateV1): state is LifecyclePreparedStateV1 {
	return lifecycleAwaitingState(state) || lifecycleSuspendedState(state);
}
type LifecycleMarkerV1 = Extract<
	Awaited<ReturnType<TransientTaskLifecycleGateStoreV1["adoptLifecycleTerminalMarker"]>>,
	{ readonly marker: unknown }
>["marker"];

type SerializerAllocationRequestV1 = Parameters<
	AgentSessionToolResultPersistenceSerializerV1["allocateOrReuseTicketBeforeEmission"]
>[0];
type SerializerAllocationReceiptV1 = Extract<
	Awaited<ReturnType<AgentSessionToolResultPersistenceSerializerV1["allocateOrReuseTicketBeforeEmission"]>>,
	{ readonly receipt: unknown }
>["receipt"];
type SerializerQueueStateV1 = SerializerAllocationReceiptV1["core"]["registeredSerializerQueueState"];
type SerializerTicketInputV1 = Extract<
	SerializerAllocationRequestV1,
	{ readonly core: { readonly mode: "allocate" } }
>["core"]["ticketInput"];
type SerializerTicketV1 = SerializerAllocationReceiptV1["core"]["ticket"];
type SerializerTicketCoreV1 = SerializerTicketV1["core"];
type ForegroundSerializerTicketInputV1 = Extract<
	SerializerTicketInputV1,
	{ readonly route: "task_foreground_delivery" }
>;
type NoHandoffSerializerTicketInputV1 = Extract<SerializerTicketInputV1, { readonly route: "task_no_handoff_result" }>;
type OrdinarySerializerTicketInputV1 = Extract<SerializerTicketInputV1, { readonly route: "non_task_ordinary" }>;
type SerializerHeadRequestV1 = Parameters<
	AgentSessionToolResultPersistenceSerializerV1["waitForHeadAndResolveCurrentPriorLeaf"]
>[0];
type SerializerHeadPermitV1 = Extract<
	Awaited<ReturnType<AgentSessionToolResultPersistenceSerializerV1["waitForHeadAndResolveCurrentPriorLeaf"]>>,
	{ readonly permit: unknown }
>["permit"];
type PrimaryCommitAttemptV1 = Parameters<
	AgentSessionToolResultPersistenceSerializerV1["preparePrimaryCommitAtHead"]
>[0];
type PrimaryCommitTransitionV1 = Extract<
	Awaited<ReturnType<AgentSessionToolResultPersistenceSerializerV1["transitionPrimaryCommitToOutcomeUnknownAtHead"]>>,
	{ readonly receipt: unknown }
>["receipt"];
type PrimaryCommitEffectV1 = Parameters<AgentSessionToolResultPersistenceSerializerV1["appendOrAdoptPrimaryAtHead"]>[0];
type PrimaryCommitReceiptV1 = Extract<
	Awaited<ReturnType<AgentSessionToolResultPersistenceSerializerV1["appendOrAdoptPrimaryAtHead"]>>,
	{ readonly receipt: unknown }
>["receipt"];
type PrimaryPersistenceReceiptV1 = PrimaryCommitReceiptV1["core"]["primaryPersistenceReceipt"];
type PrimaryInspectRequestV1 = Parameters<AgentSessionToolResultPersistenceSerializerV1["inspectPrimaryCommit"]>[0];
type PrimaryAdoptRequestV1 = Parameters<AgentSessionToolResultPersistenceSerializerV1["adoptPrimaryCommit"]>[0];
type PrimaryInspectResultV1 = Awaited<
	ReturnType<AgentSessionToolResultPersistenceSerializerV1["inspectPrimaryCommit"]>
>;
type PrimaryAbsenceInspectionV1 = Extract<PrimaryInspectResultV1, { readonly status: "authoritative_absence" }>;
type PrimaryAbsenceProofV1 = PrimaryAbsenceInspectionV1["proof"];
type PrimaryCommittedInspectionV1 = Extract<PrimaryInspectResultV1, { readonly status: "committed" }>;
type OrdinaryMatchingInspectionV1 = NonNullable<PrimaryCommittedInspectionV1["ordinaryAppendInspection"]>;
type OrdinaryAbsenceInspectionV1 = NonNullable<PrimaryAbsenceInspectionV1["ordinaryAppendInspection"]>;
type PrimaryAdoptResultV1 = Awaited<ReturnType<AgentSessionToolResultPersistenceSerializerV1["adoptPrimaryCommit"]>>;
type OrdinaryCommittedAdoptionV1 = NonNullable<
	Extract<PrimaryAdoptResultV1, { readonly status: "adopted" | "already_adopted" }>["ordinaryAppendAdoption"]
>;
type OrdinaryRestoredAdoptionV1 = NonNullable<
	Extract<
		PrimaryAdoptResultV1,
		{ readonly status: "restored_not_applied" | "already_restored_not_applied" }
	>["ordinaryAppendAdoption"]
>;
type PrimaryExpectedPhysicalEntryV1 = PrimaryAbsenceProofV1["core"]["expectedRouteEntriesInDispatchOrder"][number];
type PrimaryPhysicalCandidateV1 = SessionMessageEntry | TtsrInjectionEntry;
type PrimaryRoutePhysicalPlanV1 = {
	readonly candidates: readonly [PrimaryPhysicalCandidateV1, ...PrimaryPhysicalCandidateV1[]];
	readonly expected: readonly [PrimaryExpectedPhysicalEntryV1, ...PrimaryExpectedPhysicalEntryV1[]];
	readonly ordinaryAppendRequest: OrdinaryAppendRequestV1 | null;
};
type ForegroundPrimaryCommitReceiptV1 = Extract<
	PrimaryCommitReceiptV1,
	{ readonly core: { readonly route: "task_foreground_delivery" } }
>;
type NoHandoffPrimaryCommitReceiptV1 = Extract<
	PrimaryCommitReceiptV1,
	{ readonly core: { readonly route: "task_no_handoff_result" } }
>;
type OrdinaryPrimaryCommitReceiptV1 = Extract<
	PrimaryCommitReceiptV1,
	{ readonly core: { readonly route: "non_task_ordinary" } }
>;
type HubPrimaryCommitReceiptV1 = Extract<
	PrimaryCommitReceiptV1,
	{ readonly core: { readonly route: "hub_wait_message_return" } }
>;
type HubInjectionResultPersistenceReceiptV1 = Extract<
	PrimaryPersistenceReceiptV1,
	{ readonly core: { readonly route: "hub_wait_message_return" } }
>["core"]["hubWaitMessageInjectionResultReceipt"];

function isForegroundPrimaryPersistenceReceiptV1(
	receipt: PrimaryPersistenceReceiptV1,
): receipt is ForegroundPrimaryPersistenceReceiptV1 {
	return receipt.core.route === "task_foreground_delivery";
}

function isNoHandoffPrimaryPersistenceReceiptV1(
	receipt: PrimaryPersistenceReceiptV1,
): receipt is NoHandoffPrimaryPersistenceReceiptV1 {
	return receipt.core.route === "task_no_handoff_result";
}

function isOrdinaryPrimaryPersistenceReceiptV1(
	receipt: PrimaryPersistenceReceiptV1,
): receipt is OrdinaryPrimaryPersistenceReceiptV1 {
	return receipt.core.route === "non_task_ordinary";
}

function isHubPrimaryPersistenceReceiptV1(
	receipt: PrimaryPersistenceReceiptV1,
): receipt is HubPrimaryPersistenceReceiptV1 {
	return receipt.core.route === "hub_wait_message_return";
}
type SerializerQueueInspectRequestV1 = Parameters<
	AgentSessionToolResultPersistenceSerializerV1["inspectQueueForRestart"]
>[0];
type SerializerQueueAdoptRequestV1 = Parameters<
	AgentSessionToolResultPersistenceSerializerV1["adoptQueueForRestart"]
>[0];
type SerializerQueueMatchingInspectionV1 = Extract<
	Awaited<ReturnType<AgentSessionToolResultPersistenceSerializerV1["inspectQueueForRestart"]>>,
	{ readonly status: "matching" }
>;
type NoHandoffAttemptV1 = Parameters<AgentSessionToolResultPersistenceSerializerV1["prepareNoHandoffAppend"]>[0];
type NoHandoffTransitionV1 = Extract<
	Awaited<ReturnType<AgentSessionToolResultPersistenceSerializerV1["transitionNoHandoffAppendToOutcomeUnknown"]>>,
	{ readonly receipt: unknown }
>["receipt"];
type NoHandoffReceiptV1 = Extract<
	Awaited<ReturnType<AgentSessionToolResultPersistenceSerializerV1["appendOrAdoptNoHandoffResult"]>>,
	{ readonly receipt: unknown }
>["receipt"];
type NoHandoffInspectRequestV1 = Parameters<AgentSessionToolResultPersistenceSerializerV1["inspectNoHandoffAppend"]>[0];
type NoHandoffAdoptRequestV1 = Parameters<AgentSessionToolResultPersistenceSerializerV1["adoptNoHandoffAppend"]>[0];

type ForegroundPreallocationRequestV1 = Parameters<
	TransientTaskForegroundSessionAppendBridgeV1["preallocateExactToolResultEntry"]
>[0];
type ForegroundSessionAppendRequestV1 = Parameters<
	TransientTaskForegroundSessionAppendBridgeV1["appendExactToolResult"]
>[0];
type ForegroundSessionAppendReceiptV1 = Extract<
	Awaited<ReturnType<TransientTaskForegroundSessionAppendBridgeV1["appendExactToolResult"]>>,
	{ readonly receipt: unknown }
>["receipt"];
type ForegroundPrimaryPersistenceReceiptV1 = Extract<
	PrimaryPersistenceReceiptV1,
	{ readonly core: { readonly route: "task_foreground_delivery" } }
>;
type NoHandoffPrimaryRequestV1 = Extract<
	PrimaryCommitAttemptV1["core"]["request"],
	{ readonly core: { readonly route: "task_no_handoff_result" } }
>;
type NoHandoffPrimaryPersistenceReceiptV1 = Extract<
	PrimaryPersistenceReceiptV1,
	{ readonly core: { readonly route: "task_no_handoff_result" } }
>;
type OrdinaryPrimaryPersistenceReceiptV1 = Extract<
	PrimaryPersistenceReceiptV1,
	{ readonly core: { readonly route: "non_task_ordinary" } }
>;
type HubPrimaryPersistenceReceiptV1 = Extract<
	PrimaryPersistenceReceiptV1,
	{ readonly core: { readonly route: "hub_wait_message_return" } }
>;
type ForegroundSessionAppendInspectRequestV1 = Parameters<
	TransientTaskForegroundSessionAppendBridgeV1["inspectExactToolResult"]
>[0];

type ForegroundPrimaryRequestV1 = Extract<
	PrimaryCommitAttemptV1["core"]["request"],
	{ readonly core: { readonly route: "task_foreground_delivery" } }
>;
type InjectionAppendRequestV1 = ForegroundPrimaryRequestV1["core"]["injectionAppendRequest"];
type InjectionAppendReceiptV1 = Extract<
	PrimaryPersistenceReceiptV1,
	{ readonly core: { readonly route: "task_foreground_delivery" } }
>["core"]["injectionAppendReceipt"];
type ForegroundInjectionContentPlanV1 = ConfidentialTransientTaskForegroundRenderedGateV1["ttsrInjectionContentPlan"];
type ForegroundOverlayCommitReceiptCoreV1 =
	ConfidentialTransientTaskForegroundTtsrOverlayCommitReceiptV1 extends infer Receipt
		? Receipt extends { readonly receiptSha256: Sha256Ref }
			? Omit<Receipt, "receiptSha256">
			: never
		: never;
type ExactInjectionAppendRequestV1 = Extract<
	InjectionAppendRequestV1,
	{ readonly core: { readonly disposition: "exact_entry" } }
>;
type OrdinaryPrimaryRequestV1 = Extract<
	PrimaryCommitAttemptV1["core"]["request"],
	{ readonly core: { readonly route: "non_task_ordinary" } }
>;
type HubPrimaryRequestV1 = Extract<
	PrimaryCommitAttemptV1["core"]["request"],
	{ readonly core: { readonly route: "hub_wait_message_return" } }
>;
type OrdinaryAppendRequestV1 = OrdinaryPrimaryRequestV1["core"]["ordinaryAppendRequest"];
type OrdinaryAppendReceiptV1 = Extract<
	PrimaryPersistenceReceiptV1,
	{ readonly core: { readonly route: "non_task_ordinary" } }
>["core"]["ordinaryAppendReceipt"];

type InjectionAppendAttemptV1 = {
	readonly core: {
		readonly state: "not_applied";
		readonly request: InjectionAppendRequestV1;
		readonly preparedAt: ISO8601;
	};
	readonly attemptSha256: Sha256Ref;
};
type InjectionAppendTransitionV1 = NonNullable<InjectionAppendReceiptV1["core"]["transitionReceipt"]>;

interface PendingOverlayRuntimeRowV1 {
	keySha256: Sha256Ref;
	versions: PendingOverlayVersionV1[];
	pendingRecord: ConfidentialTransientTaskPendingCaptureRecordV1 | null;
	startedReceipt:
		| Extract<
				Awaited<
					ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["prepareFirstVersionAndIndexStartedCapture"]>
				>,
				{ readonly receipt: unknown }
		  >["receipt"]
		| null;
	snapshot: PendingOverlaySnapshotV1 | null;
	preDispatchBinding: PendingOverlayPreDispatchBindingV1 | null;
	anchoredBinding: PendingOverlayBindingV1 | null;
	terminalRequest: PendingOverlayTerminalRequestV1 | null;
	terminalReceipt: PendingOverlayTerminalReceiptV1 | null;
	overlayCommitReceipt?: ConfidentialTransientTaskForegroundTtsrOverlayCommitReceiptV1 | null;
	adoptedInspectionSha256s: Sha256Ref[];
	adoptedTerminalInspectionSha256s: Sha256Ref[];
}

interface PrimaryCommitRuntimeRowV1 {
	attempt: PrimaryCommitAttemptV1;
	status: "not_applied" | "outcome_unknown" | "committed";
	transitionReceipt: PrimaryCommitTransitionV1 | null;
	commitReceipt: PrimaryCommitReceiptV1 | null;
	restoredInspectionSha256: Sha256Ref | null;
}

interface NoHandoffRuntimeRowV1 {
	attempt: NoHandoffAttemptV1;
	status: "not_applied" | "outcome_unknown" | "committed";
	transitionReceipt: NoHandoffTransitionV1 | null;
	receipt: NoHandoffReceiptV1 | null;
	restoredInspectionSha256: Sha256Ref | null;
}

interface InjectionAppendRuntimeRowV1 {
	requestSha256: Sha256Ref;
	attempt: InjectionAppendAttemptV1;
	status: "not_applied" | "outcome_unknown" | "committed";
	transitionReceipt: InjectionAppendTransitionV1 | null;
	receipt: InjectionAppendReceiptV1 | null;
	restoredInspectionSha256: Sha256Ref | null;
}

type BeforeReturnEnumerateRequestV1 = Parameters<
	TransientTaskForegroundBeforeReturnRecoveryBridgeV1["enumeratePendingBeforeReturn"]
>[0];
type BeforeReturnInspectRequestV1 = Parameters<
	TransientTaskForegroundBeforeReturnRecoveryBridgeV1["inspectPendingBeforeReturn"]
>[0];
type BeforeReturnAdoptRequestV1 = Parameters<
	TransientTaskForegroundBeforeReturnRecoveryBridgeV1["adoptPendingBeforeReturn"]
>[0];

interface BeforeReturnRuntimeRowV1 {
	recoveryKey: ConfidentialTransientTaskForegroundBeforeReturnRecoveryKeyV1;
	record: ConfidentialTransientTaskForegroundBeforeReturnRecordV1;
	suspension: ConfidentialTransientTaskForegroundBeforeReturnSuspensionV1 | null;
	handoffBatch: ConfidentialTransientTaskForegroundResultHandoffBatchV1 | null;
	enumerationInspectionSha256s: Sha256Ref[];
	inspectionEnumerationJoins: Array<{ inspectionSha256: Sha256Ref; enumerationInspectionSha256: Sha256Ref }>;
	adoptionRequestSha256: Sha256Hex | null;
	adoptionReceipt: ConfidentialTransientTaskForegroundBeforeReturnAdoptionReceiptV1 | null;
}

interface HubSendAwaitTargetSessionAppendRuntimeRowV1 {
	request: ConfidentialTransientTaskHubSendAwaitTargetSessionAppendRequestV1;
	status: "not_applied" | "outcome_unknown" | "appended";
	receipt: ConfidentialTransientTaskHubSendAwaitTargetSessionAppendReceiptV1 | null;
	restoredInspectionSha256: Sha256Ref | null;
}

interface HubSendAwaitTargetDeliveryLedgerRuntimeV1 {
	incarnationSha256: Sha256Ref;
	revision: number;
	entries: ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1[];
	failedObservations: ConfidentialTransientTaskHubSendAwaitTargetFailedObservationRequestV1[];
}
type HubTargetNotAppliedConsumptionStateV1 = Extract<
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionStateV1,
	{ readonly state: "not_applied" }
>;
type HubTargetOutcomeUnknownConsumptionStateV1 = Extract<
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionStateV1,
	{ readonly state: "outcome_unknown" }
>;
type HubTargetSettledConsumptionStateV1 = Extract<
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionStateV1,
	{ readonly state: "settled" }
>;
type HubTargetBlockedConsumptionStateV1 = Extract<
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionStateV1,
	{ readonly state: "blocked_indeterminate" }
>;
type HubTargetAcceptedLedgerEntryV1 = Extract<
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1,
	{ readonly state: "accepted_pending_delivery" }
>;
type HubTargetSettledLedgerEntryV1 = Extract<
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1,
	{ readonly state: "settled" }
>;
type HubTargetBlockedLedgerEntryV1 = Extract<
	ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1,
	{ readonly state: "blocked_indeterminate" }
>;

function buildHubTargetNotAppliedConsumptionStateV1(
	plan: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionPlanV1,
): HubTargetNotAppliedConsumptionStateV1 {
	const state = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-consumption-state", {
		state: "not_applied",
		plan,
	});
	if (state.state !== "not_applied") throw new Error("Hub target not-applied state correlation failed");
	return state;
}

function buildHubTargetOutcomeUnknownConsumptionStateV1(
	plan: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionPlanV1,
	transitionRequest: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionRequestV1,
	transitionReceipt: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionReceiptV1,
): HubTargetOutcomeUnknownConsumptionStateV1 {
	const state = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-consumption-state", {
		state: "outcome_unknown",
		plan,
		transitionRequest,
		transitionReceipt,
	});
	if (state.state !== "outcome_unknown") throw new Error("Hub target outcome-unknown state correlation failed");
	return state;
}

function buildHubTargetSettledConsumptionStateV1(
	receipt: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionReceiptV1,
): HubTargetSettledConsumptionStateV1 {
	const state = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-consumption-state", {
		state: "settled",
		receipt,
	});
	if (state.state !== "settled") throw new Error("Hub target settled state correlation failed");
	return state;
}

function buildHubTargetBlockedConsumptionStateV1(
	block: HubTargetBlockedConsumptionStateV1["block"],
): HubTargetBlockedConsumptionStateV1 {
	const state = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-consumption-state", {
		state: "blocked_indeterminate",
		block,
	});
	if (state.state !== "blocked_indeterminate") throw new Error("Hub target blocked state correlation failed");
	return state;
}

function buildHubTargetAcceptedLedgerEntryV1(
	core: Omit<HubTargetAcceptedLedgerEntryV1, "entrySha256">,
): HubTargetAcceptedLedgerEntryV1 {
	const entry = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-ledger-entry", core);
	if (entry.state !== "accepted_pending_delivery") throw new Error("Hub target accepted entry correlation failed");
	return entry;
}

function buildHubTargetSettledLedgerEntryV1(
	core: Omit<HubTargetSettledLedgerEntryV1, "entrySha256">,
): HubTargetSettledLedgerEntryV1 {
	const entry = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-ledger-entry", core);
	if (entry.state !== "settled") throw new Error("Hub target settled entry correlation failed");
	return entry;
}

function buildHubTargetBlockedLedgerEntryV1(
	core: Omit<HubTargetBlockedLedgerEntryV1, "entrySha256">,
): HubTargetBlockedLedgerEntryV1 {
	const entry = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-ledger-entry", core);
	if (entry.state !== "blocked_indeterminate") throw new Error("Hub target blocked entry correlation failed");
	return entry;
}

interface SessionManagerTransientRuntimeStateCoreV1 {
	schemaVersion: 1;
	previousStateSha256: Sha256Ref | null;
	overlays: PendingOverlayRuntimeRowV1[];
	lifecycleStates: LifecycleStateV1[];
	lifecycleMarkers: LifecycleMarkerV1[];
	lifecycleAdoptions: Sha256Ref[];
	lifecycleMarkerAdoptions: Sha256Ref[];
	serializerQueues: SerializerQueueStateV1[];
	serializerAllocations: SerializerAllocationReceiptV1[];
	primaryCommits: PrimaryCommitRuntimeRowV1[];
	noHandoffCommits: NoHandoffRuntimeRowV1[];
	injectionAppends: InjectionAppendRuntimeRowV1[];
	foregroundPreallocations: Array<{ request: ForegroundPreallocationRequestV1; toolResultEntryId: string }>;
	beforeReturnRows: BeforeReturnRuntimeRowV1[];
	foregroundAppends: Array<{ request: ForegroundSessionAppendRequestV1; receipt: ForegroundSessionAppendReceiptV1 }>;
	queueInspections: Array<{
		request: SerializerQueueInspectRequestV1;
		inspection: SerializerQueueMatchingInspectionV1;
	}>;
	queueAdoptions: Sha256Ref[];
	primaryAdoptions: Sha256Ref[];
	hubSendAwaitTargetSessionAppends: HubSendAwaitTargetSessionAppendRuntimeRowV1[];
	hubSendAwaitTargetDeliveryLedger: HubSendAwaitTargetDeliveryLedgerRuntimeV1 | null;
	updatedAt: ISO8601;
}

interface SessionManagerTransientRuntimeStateV1 extends SessionManagerTransientRuntimeStateCoreV1 {
	stateSha256: Sha256Ref;
}

function transientRuntimeStateDigest(core: unknown): Sha256Ref {
	const tagged = encodeDetachedTaggedValue(["omp-session-manager-transient-runtime-v1", "state", 1, core]);
	return `sha256:${createHash("sha256").update(JSON.stringify(tagged), "utf8").digest("hex")}` as Sha256Ref;
}

function emptyTransientRuntimeState(
	previousStateSha256: Sha256Ref | null,
	updatedAt: ISO8601,
): SessionManagerTransientRuntimeStateV1 {
	const core: SessionManagerTransientRuntimeStateCoreV1 = {
		schemaVersion: 1,
		previousStateSha256,
		overlays: [],
		lifecycleStates: [],
		lifecycleMarkers: [],
		lifecycleAdoptions: [],
		lifecycleMarkerAdoptions: [],
		serializerQueues: [],
		serializerAllocations: [],
		primaryCommits: [],
		noHandoffCommits: [],
		injectionAppends: [],
		foregroundPreallocations: [],
		beforeReturnRows: [],
		foregroundAppends: [],
		queueInspections: [],
		queueAdoptions: [],
		primaryAdoptions: [],
		hubSendAwaitTargetSessionAppends: [],
		hubSendAwaitTargetDeliveryLedger: null,
		updatedAt,
	};
	return { ...core, stateSha256: transientRuntimeStateDigest(core) };
}

function validTransientRuntimeStateSnapshot(
	input: unknown,
	expectedPreviousStateSha256: Sha256Ref | null,
): input is SessionManagerTransientRuntimeStateV1 {
	if (
		!detachedStrictRecord(input, [
			"schemaVersion",
			"previousStateSha256",
			"overlays",
			"lifecycleStates",
			"lifecycleMarkers",
			"lifecycleAdoptions",
			"lifecycleMarkerAdoptions",
			"serializerQueues",
			"serializerAllocations",
			"primaryCommits",
			"noHandoffCommits",
			"injectionAppends",
			"foregroundPreallocations",
			"beforeReturnRows",
			"foregroundAppends",
			"queueInspections",
			"queueAdoptions",
			"primaryAdoptions",
			"hubSendAwaitTargetSessionAppends",
			"hubSendAwaitTargetDeliveryLedger",
			"updatedAt",
			"stateSha256",
		]) ||
		input.schemaVersion !== 1 ||
		input.previousStateSha256 !== expectedPreviousStateSha256 ||
		!detachedStrictArray(input.overlays) ||
		!detachedStrictArray(input.lifecycleStates) ||
		!detachedStrictArray(input.lifecycleMarkers) ||
		!detachedStrictArray(input.lifecycleAdoptions) ||
		!detachedStrictArray(input.lifecycleMarkerAdoptions) ||
		!detachedStrictArray(input.serializerQueues) ||
		!detachedStrictArray(input.serializerAllocations) ||
		!detachedStrictArray(input.primaryCommits) ||
		!detachedStrictArray(input.noHandoffCommits) ||
		!detachedStrictArray(input.injectionAppends) ||
		!detachedStrictArray(input.beforeReturnRows) ||
		!detachedStrictArray(input.foregroundPreallocations) ||
		!detachedStrictArray(input.foregroundAppends) ||
		!detachedStrictArray(input.queueInspections) ||
		!detachedStrictArray(input.queueAdoptions) ||
		!detachedStrictArray(input.primaryAdoptions) ||
		!detachedStrictArray(input.hubSendAwaitTargetSessionAppends) ||
		!(
			input.hubSendAwaitTargetDeliveryLedger === null ||
			detachedStrictRecord(input.hubSendAwaitTargetDeliveryLedger, [
				"incarnationSha256",
				"revision",
				"entries",
				"failedObservations",
			])
		) ||
		!detachedIso8601(input.updatedAt) ||
		!detachedSha256Ref(input.stateSha256) ||
		!input.beforeReturnRows.every(validBeforeReturnRuntimeRow)
	)
		return false;
	const { stateSha256: _stateSha256, ...core } = input;
	try {
		return input.stateSha256 === transientRuntimeStateDigest(core);
	} catch {
		return false;
	}
}

function validOverlayKey(input: unknown): input is PendingOverlayVersionV1["key"] {
	return Boolean(
		detachedStrictRecord(input, [
			"schemaVersion",
			"parentSessionId",
			"parentSessionGenerationSha256",
			"preAssistantBranchGenerationSha256",
			"preAssistantAnchorEntryId",
			"toolCallId",
			"toolName",
			"captureGeneration",
			"assistantStreamSha256",
			"keySha256",
		]) &&
			input.schemaVersion === 1 &&
			detachedIdentity(input.parentSessionId) &&
			detachedSha256Ref(input.parentSessionGenerationSha256) &&
			detachedSha256Ref(input.preAssistantBranchGenerationSha256) &&
			(input.preAssistantAnchorEntryId === null || detachedIdentity(input.preAssistantAnchorEntryId)) &&
			detachedIdentity(input.toolCallId) &&
			input.toolName === "task" &&
			detachedInteger(input.captureGeneration) &&
			detachedSha256Ref(input.assistantStreamSha256) &&
			input.keySha256 ===
				detachedTupleSha256Ref([
					"omp-transient-task-foreground-settlement-v1",
					"pending-ttsr-key-core",
					1,
					input.parentSessionId,
					input.parentSessionGenerationSha256,
					input.preAssistantBranchGenerationSha256,
					input.preAssistantAnchorEntryId,
					input.toolCallId,
					"task",
					input.captureGeneration,
					input.assistantStreamSha256,
				]),
	);
}

function validOverlayOutcome(
	input: unknown,
	expectedCaptureInputSha256: Sha256Ref,
): input is PendingOverlayVersionV1["outcome"] {
	if (
		!detachedCanonicalRecord(input) ||
		(input.status !== "matched" && input.status !== "no_match" && input.status !== "suppressed_same_stream") ||
		input.captureInputSha256 !== expectedCaptureInputSha256 ||
		!detachedSha256Ref(input.outcomeSha256) ||
		!detachedCanonicalData(input.overlaySnapshot)
	)
		return false;
	const reason = input.status === "no_match" ? input.reason : null;
	const ruleNames =
		input.status === "matched"
			? input.matchedRuleNames
			: input.status === "suppressed_same_stream"
				? input.suppressedRuleNames
				: [];
	if (!detachedStrictArray(ruleNames) || (input.status !== "no_match" && ruleNames.length === 0)) return false;
	const digest = detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"pending-ttsr-capture-outcome-core",
		1,
		input.status,
		input.captureInputSha256,
		reason,
		ruleNames,
		input.status === "matched" ? input.provisionalClaim : null,
		input.status === "suppressed_same_stream" ? input.assistantStreamSha256 : null,
		input.status === "suppressed_same_stream" ? input.provisionalPredecessor : null,
		input.overlaySnapshot,
	]);
	return input.outcomeSha256 === digest;
}

function validOverlayVersion(input: unknown): input is PendingOverlayVersionV1 {
	if (
		!detachedStrictRecord(input, [
			"schemaVersion",
			"key",
			"version",
			"priorVersionSha256",
			"captureRequest",
			"outcome",
			"capturedAt",
			"versionSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validOverlayKey(input.key) ||
		!detachedInteger(input.version) ||
		(input.priorVersionSha256 !== null && !detachedSha256Ref(input.priorVersionSha256)) ||
		!detachedStrictRecord(input.captureRequest, [
			"schemaVersion",
			"key",
			"captureRevision",
			"input",
			"captureInputSha256",
			"requestSha256",
		]) ||
		input.captureRequest.schemaVersion !== 1 ||
		!detachedExactJson(input.captureRequest.key, input.key) ||
		input.captureRequest.captureRevision !== input.version ||
		!detachedCanonicalRecord(input.captureRequest.input) ||
		input.captureRequest.input.captureInputSha256 !== input.captureRequest.captureInputSha256 ||
		!detachedSha256Ref(input.captureRequest.captureInputSha256) ||
		input.captureRequest.requestSha256 !==
			detachedTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-capture-core",
				1,
				input.key,
				input.version,
				input.captureRequest.input,
				input.captureRequest.captureInputSha256,
			]) ||
		!validOverlayOutcome(input.outcome, input.captureRequest.captureInputSha256) ||
		!detachedIso8601(input.capturedAt) ||
		!detachedSha256Ref(input.versionSha256) ||
		input.versionSha256 !==
			detachedTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"pending-ttsr-version-core",
				1,
				input.key,
				input.version,
				input.priorVersionSha256,
				input.captureRequest,
				input.outcome,
				input.capturedAt,
			])
	)
		return false;
	return true;
}

function overlaySnapshotDigest(snapshot: Omit<PendingOverlaySnapshotV1, "pendingOverlaySnapshotSha256">): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"pending-ttsr-snapshot-core",
		1,
		snapshot.key,
		snapshot.finalVersion,
		snapshot.finalVersionSha256,
		snapshot.orderedCaptureOutcomes,
		snapshot.captureOutcomeHistorySha256,
		snapshot.finalCaptureOutcomeSha256,
		snapshot.overlaySnapshot,
		snapshot.finalizedAt,
	]);
}

function overlayPreDispatchBindingDigest(
	binding: Omit<PendingOverlayPreDispatchBindingV1, "bindingSha256">,
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"pending-ttsr-pre-dispatch-binding-core",
		1,
		binding.keySha256,
		binding.finalVersion,
		binding.finalVersionSha256,
		binding.captureOutcomeHistorySha256,
		binding.finalCaptureOutcomeSha256,
		binding.pendingOverlaySnapshotSha256,
	]);
}

function overlayBindingDigest(binding: Omit<PendingOverlayBindingV1, "bindingSha256">): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"pending-ttsr-anchor-binding-core",
		1,
		binding.preDispatchBinding,
		binding.parentBranchGenerationSha256,
		binding.parentBranchAnchorEntryId,
	]);
}

const BEFORE_RETURN_IDENTITY_CORE_KEYS = [
	"taskId",
	"runId",
	"schemaVersion",
	"createId",
	"resultPublicationId",
	"resultPublicationTargetId",
	"resultPublicationTargetCleanupId",
	"effectIdentityManifestSha256",
	"deliveryOperationId",
	"appendOperationId",
	"foregroundMemberIndex",
	"foregroundMemberCount",
	"parentSessionId",
	"parentSessionGenerationSha256",
	"parentBranchGenerationSha256",
	"parentBranchAnchorEntryId",
	"toolCallId",
	"toolResultSerializerKeySha256",
	"sourceToolCallOrdinal",
	"entryPreallocationOperationId",
	"toolResultEntryId",
	"returnedAgentToolResultUtf8Sha256",
	"returnedAgentToolResultUtf8ByteLength",
	"returnedSourceResultSnapshotSha256",
	"returnedSourceResultSnapshotByteLength",
] as const;
type BeforeReturnIdentityV1 =
	ConfidentialTransientTaskForegroundBeforeReturnRecordV1["orderedPreReturnIdentities"][number];
type BeforeReturnBatchKeyInputV1 = ConfidentialTransientTaskForegroundBeforeReturnRecordV1["batchKeyInput"];
type BeforeReturnPreallocationRequestV1 =
	ConfidentialTransientTaskForegroundBeforeReturnRecordV1["preallocationRequest"];
type BeforeReturnDispatchClassificationV1 =
	ConfidentialTransientTaskForegroundBeforeReturnRecordV1["dispatchClassification"];

function validBeforeReturnBatchKeyInput(input: unknown): input is BeforeReturnBatchKeyInputV1 {
	return (
		detachedStrictRecord(input, [
			"parentSessionId",
			"parentSessionGenerationSha256",
			"parentBranchGenerationSha256",
			"parentBranchAnchorEntryId",
			"toolCallId",
			"orderedPreReturnIdentitySha256s",
		]) &&
		detachedIdentity(input.parentSessionId) &&
		detachedSha256Ref(input.parentSessionGenerationSha256) &&
		detachedSha256Ref(input.parentBranchGenerationSha256) &&
		detachedIdentity(input.parentBranchAnchorEntryId) &&
		detachedIdentity(input.toolCallId) &&
		detachedStrictArray(input.orderedPreReturnIdentitySha256s) &&
		input.orderedPreReturnIdentitySha256s.length > 0 &&
		input.orderedPreReturnIdentitySha256s.every(detachedSha256Ref)
	);
}

function validBeforeReturnPreallocationRequest(input: unknown): input is BeforeReturnPreallocationRequestV1 {
	return (
		detachedStrictRecord(input, [
			"schemaVersion",
			"entryPreallocationOperationId",
			"expectedToolResultEntryId",
			"foregroundAppendBatchKeySha256",
			"parentSessionId",
			"parentSessionGenerationSha256",
			"parentBranchGenerationSha256",
			"parentBranchAnchorEntryId",
			"toolCallId",
			"orderedPreReturnIdentitySha256s",
		]) &&
		input.schemaVersion === 1 &&
		detachedIdentity(input.entryPreallocationOperationId) &&
		detachedIdentity(input.expectedToolResultEntryId) &&
		detachedSha256Ref(input.foregroundAppendBatchKeySha256) &&
		detachedIdentity(input.parentSessionId) &&
		detachedSha256Ref(input.parentSessionGenerationSha256) &&
		detachedSha256Ref(input.parentBranchGenerationSha256) &&
		detachedIdentity(input.parentBranchAnchorEntryId) &&
		detachedIdentity(input.toolCallId) &&
		detachedStrictArray(input.orderedPreReturnIdentitySha256s) &&
		input.orderedPreReturnIdentitySha256s.length > 0 &&
		input.orderedPreReturnIdentitySha256s.every(detachedSha256Ref)
	);
}

function validBeforeReturnDispatchClassification(input: unknown): input is BeforeReturnDispatchClassificationV1 {
	if (
		!detachedStrictRecord(input, ["core", "classificationSha256"]) ||
		!detachedStrictRecord(input.core, [
			"schemaVersion",
			"classification",
			"blockingChildCount",
			"asyncChildCount",
			"effectiveTaskArgumentsSha256",
			"effectiveArgumentRevisionChainSha256",
			"classifiedAt",
		]) ||
		input.core.schemaVersion !== 1 ||
		input.core.classification !== "foreground_present" ||
		!detachedInteger(input.core.blockingChildCount, 1) ||
		!detachedInteger(input.core.asyncChildCount) ||
		!detachedSha256Ref(input.core.effectiveTaskArgumentsSha256) ||
		!detachedSha256Ref(input.core.effectiveArgumentRevisionChainSha256) ||
		!detachedIso8601(input.core.classifiedAt) ||
		!detachedSha256Ref(input.classificationSha256)
	)
		return false;
	return (
		input.classificationSha256 ===
		detachedTupleSha256Ref([
			"omp-transient-task-foreground-route-v1",
			"classification-core",
			1,
			input.core.classification,
			input.core.blockingChildCount,
			input.core.asyncChildCount,
			input.core.effectiveTaskArgumentsSha256,
			input.core.effectiveArgumentRevisionChainSha256,
			input.core.classifiedAt,
		])
	);
}

function validBeforeReturnPreDispatchBinding(input: unknown): input is PendingOverlayPreDispatchBindingV1 {
	if (
		!detachedStrictRecord(input, [
			"keySha256",
			"finalVersion",
			"finalVersionSha256",
			"captureOutcomeHistorySha256",
			"finalCaptureOutcomeSha256",
			"pendingOverlaySnapshotSha256",
			"bindingSha256",
		]) ||
		!detachedSha256Ref(input.keySha256) ||
		!detachedInteger(input.finalVersion) ||
		!detachedSha256Ref(input.finalVersionSha256) ||
		!detachedSha256Ref(input.captureOutcomeHistorySha256) ||
		!detachedSha256Ref(input.finalCaptureOutcomeSha256) ||
		!detachedSha256Ref(input.pendingOverlaySnapshotSha256) ||
		!detachedSha256Ref(input.bindingSha256)
	)
		return false;
	const bindingCore: Omit<PendingOverlayPreDispatchBindingV1, "bindingSha256"> = {
		keySha256: input.keySha256,
		finalVersion: input.finalVersion,
		finalVersionSha256: input.finalVersionSha256,
		captureOutcomeHistorySha256: input.captureOutcomeHistorySha256,
		finalCaptureOutcomeSha256: input.finalCaptureOutcomeSha256,
		pendingOverlaySnapshotSha256: input.pendingOverlaySnapshotSha256,
	};
	return input.bindingSha256 === overlayPreDispatchBindingDigest(bindingCore);
}

function validBeforeReturnPendingOverlayBinding(input: unknown): input is PendingOverlayBindingV1 {
	if (
		!detachedStrictRecord(input, [
			"preDispatchBinding",
			"parentBranchGenerationSha256",
			"parentBranchAnchorEntryId",
			"bindingSha256",
		]) ||
		!validBeforeReturnPreDispatchBinding(input.preDispatchBinding) ||
		!detachedSha256Ref(input.parentBranchGenerationSha256) ||
		!detachedIdentity(input.parentBranchAnchorEntryId) ||
		!detachedSha256Ref(input.bindingSha256)
	)
		return false;
	const bindingCore: Omit<PendingOverlayBindingV1, "bindingSha256"> = {
		preDispatchBinding: input.preDispatchBinding,
		parentBranchGenerationSha256: input.parentBranchGenerationSha256,
		parentBranchAnchorEntryId: input.parentBranchAnchorEntryId,
	};
	return input.bindingSha256 === overlayBindingDigest(bindingCore);
}

function beforeReturnTargetTuple(core: Record<string, unknown>): readonly unknown[] {
	return [
		core.taskId,
		core.runId,
		core.createId,
		core.resultPublicationId,
		core.resultPublicationTargetId,
		core.resultPublicationTargetCleanupId,
	];
}

function validBeforeReturnIdentity(input: unknown, index: number, count: number): input is BeforeReturnIdentityV1 {
	if (
		!detachedStrictRecord(input, ["core", "preReturnIdentitySha256"]) ||
		!detachedStrictRecord(input.core, BEFORE_RETURN_IDENTITY_CORE_KEYS) ||
		input.core.schemaVersion !== 1 ||
		!detachedIdentity(input.core.taskId) ||
		!detachedIdentity(input.core.runId) ||
		!detachedIdentity(input.core.createId) ||
		!detachedIdentity(input.core.resultPublicationId) ||
		!detachedIdentity(input.core.resultPublicationTargetId) ||
		Buffer.byteLength(input.core.resultPublicationTargetId, "utf8") > 256 ||
		!detachedIdentity(input.core.resultPublicationTargetCleanupId) ||
		!detachedSha256Ref(input.core.effectIdentityManifestSha256) ||
		!detachedIdentity(input.core.deliveryOperationId) ||
		!detachedIdentity(input.core.appendOperationId) ||
		input.core.foregroundMemberIndex !== index ||
		input.core.foregroundMemberCount !== count ||
		!detachedIdentity(input.core.parentSessionId) ||
		!detachedSha256Ref(input.core.parentSessionGenerationSha256) ||
		!detachedSha256Ref(input.core.parentBranchGenerationSha256) ||
		!detachedIdentity(input.core.parentBranchAnchorEntryId) ||
		!detachedIdentity(input.core.toolCallId) ||
		!detachedSha256Ref(input.core.toolResultSerializerKeySha256) ||
		!detachedInteger(input.core.sourceToolCallOrdinal) ||
		!detachedIdentity(input.core.entryPreallocationOperationId) ||
		!detachedIdentity(input.core.toolResultEntryId) ||
		!detachedSha256Ref(input.core.returnedAgentToolResultUtf8Sha256) ||
		!detachedInteger(input.core.returnedAgentToolResultUtf8ByteLength) ||
		!detachedSha256Ref(input.core.returnedSourceResultSnapshotSha256) ||
		!detachedInteger(input.core.returnedSourceResultSnapshotByteLength) ||
		!detachedSha256Ref(input.preReturnIdentitySha256)
	)
		return false;
	return (
		input.preReturnIdentitySha256 ===
		detachedTupleSha256Ref([
			"omp-transient-task-foreground-settlement-v1",
			"pre-return-identity-core",
			1,
			beforeReturnTargetTuple(input.core),
			input.core.effectIdentityManifestSha256,
			input.core.deliveryOperationId,
			input.core.appendOperationId,
			input.core.foregroundMemberIndex,
			input.core.foregroundMemberCount,
			input.core.parentSessionId,
			input.core.parentSessionGenerationSha256,
			input.core.parentBranchGenerationSha256,
			input.core.parentBranchAnchorEntryId,
			input.core.toolCallId,
			input.core.toolResultSerializerKeySha256,
			input.core.sourceToolCallOrdinal,
			input.core.entryPreallocationOperationId,
			input.core.toolResultEntryId,
			input.core.returnedAgentToolResultUtf8Sha256,
			input.core.returnedAgentToolResultUtf8ByteLength,
			input.core.returnedSourceResultSnapshotSha256,
			input.core.returnedSourceResultSnapshotByteLength,
		])
	);
}

function beforeReturnRecordDigest(record: ConfidentialTransientTaskForegroundBeforeReturnRecordV1): Sha256Ref {
	const batch = record.batchKeyInput;
	const preallocation = record.preallocationRequest;
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"before-return-core",
		1,
		record.dispatchClassification,
		record.toolResultSerializerKeySha256,
		record.sourceToolCallOrdinal,
		[
			"omp-transient-task-foreground-settlement-v1",
			"batch-key-core",
			1,
			batch.parentSessionId,
			batch.parentSessionGenerationSha256,
			batch.parentBranchGenerationSha256,
			batch.parentBranchAnchorEntryId,
			batch.toolCallId,
			batch.orderedPreReturnIdentitySha256s,
		],
		[
			"omp-transient-task-foreground-settlement-v1",
			"entry-preallocation-core",
			1,
			preallocation.entryPreallocationOperationId,
			preallocation.expectedToolResultEntryId,
			preallocation.foregroundAppendBatchKeySha256,
			preallocation.parentSessionId,
			preallocation.parentSessionGenerationSha256,
			preallocation.parentBranchGenerationSha256,
			preallocation.parentBranchAnchorEntryId,
			preallocation.toolCallId,
			preallocation.orderedPreReturnIdentitySha256s,
		],
		record.pendingOverlayBinding,
		record.returnedAgentToolResult,
		record.returnedSourceResultSnapshot,
		record.returnedAgentToolResultWire,
		record.returnedAgentToolResultUtf8,
		record.orderedPreReturnIdentities,
		record.orderedPreReturnIdentitySha256s,
		record.frozenBeforeReturnAt,
	]);
}

function validBeforeReturnRecord(record: unknown): record is ConfidentialTransientTaskForegroundBeforeReturnRecordV1 {
	if (
		!detachedStrictRecord(record, [
			"schemaVersion",
			"dispatchClassification",
			"toolResultSerializerKeySha256",
			"sourceToolCallOrdinal",
			"batchKeyInput",
			"preallocationRequest",
			"pendingOverlayBinding",
			"returnedAgentToolResult",
			"returnedSourceResultSnapshot",
			"returnedAgentToolResultWire",
			"returnedAgentToolResultUtf8",
			"orderedPreReturnIdentities",
			"orderedPreReturnIdentitySha256s",
			"frozenBeforeReturnAt",
			"recordSha256",
		]) ||
		record.schemaVersion !== 1 ||
		!detachedCanonicalData(record) ||
		!detachedStrictArray(record.orderedPreReturnIdentities) ||
		!detachedStrictArray(record.orderedPreReturnIdentitySha256s) ||
		record.orderedPreReturnIdentities.length === 0 ||
		record.orderedPreReturnIdentities.length !== record.orderedPreReturnIdentitySha256s.length ||
		!record.orderedPreReturnIdentitySha256s.every(detachedSha256Ref) ||
		!detachedSha256Ref(record.toolResultSerializerKeySha256) ||
		!detachedInteger(record.sourceToolCallOrdinal) ||
		!detachedIso8601(record.frozenBeforeReturnAt) ||
		!detachedString(record.returnedAgentToolResultUtf8, true) ||
		!detachedSha256Ref(record.recordSha256)
	)
		return false;
	const batch = record.batchKeyInput;
	const preallocation = record.preallocationRequest;
	if (
		!validBeforeReturnBatchKeyInput(batch) ||
		!validBeforeReturnPreallocationRequest(preallocation) ||
		!detachedExactJson(batch.orderedPreReturnIdentitySha256s, record.orderedPreReturnIdentitySha256s) ||
		!detachedExactJson(preallocation.orderedPreReturnIdentitySha256s, record.orderedPreReturnIdentitySha256s) ||
		preallocation.parentSessionId !== batch.parentSessionId ||
		preallocation.parentSessionGenerationSha256 !== batch.parentSessionGenerationSha256 ||
		preallocation.parentBranchGenerationSha256 !== batch.parentBranchGenerationSha256 ||
		preallocation.parentBranchAnchorEntryId !== batch.parentBranchAnchorEntryId ||
		preallocation.toolCallId !== batch.toolCallId ||
		preallocation.foregroundAppendBatchKeySha256 !== deriveTransientTaskForegroundAppendBatchKeyV1(batch) ||
		preallocation.expectedToolResultEntryId !== foregroundPreallocationId(preallocation.entryPreallocationOperationId)
	)
		return false;
	const classification = record.dispatchClassification;
	const binding = record.pendingOverlayBinding;
	if (
		!validBeforeReturnDispatchClassification(classification) ||
		!validBeforeReturnPendingOverlayBinding(binding) ||
		binding.parentBranchGenerationSha256 !== batch.parentBranchGenerationSha256 ||
		binding.parentBranchAnchorEntryId !== batch.parentBranchAnchorEntryId
	)
		return false;
	const validatedIdentities: BeforeReturnIdentityV1[] = [];
	for (let index = 0; index < record.orderedPreReturnIdentities.length; index++) {
		const identity = record.orderedPreReturnIdentities[index];
		if (
			!validBeforeReturnIdentity(identity, index, record.orderedPreReturnIdentities.length) ||
			identity.preReturnIdentitySha256 !== record.orderedPreReturnIdentitySha256s[index] ||
			identity.core.parentSessionId !== batch.parentSessionId ||
			identity.core.parentSessionGenerationSha256 !== batch.parentSessionGenerationSha256 ||
			identity.core.parentBranchGenerationSha256 !== batch.parentBranchGenerationSha256 ||
			identity.core.parentBranchAnchorEntryId !== batch.parentBranchAnchorEntryId ||
			identity.core.toolCallId !== batch.toolCallId ||
			identity.core.toolResultSerializerKeySha256 !== record.toolResultSerializerKeySha256 ||
			identity.core.sourceToolCallOrdinal !== record.sourceToolCallOrdinal ||
			identity.core.entryPreallocationOperationId !== preallocation.entryPreallocationOperationId ||
			identity.core.toolResultEntryId !== preallocation.expectedToolResultEntryId
		)
			return false;
		validatedIdentities.push(identity);
	}
	const projected = validateAndProjectTransientTaskForegroundSourceAgentToolResultV1(record.returnedAgentToolResult);
	if (
		projected.status !== "projected" ||
		!detachedExactJson(projected.projection.core.sourceResultSnapshot, record.returnedSourceResultSnapshot) ||
		!detachedExactJson(projected.projection.core.wireResult, record.returnedAgentToolResultWire) ||
		projected.projection.core.resultUtf8 !== record.returnedAgentToolResultUtf8 ||
		validatedIdentities.some(
			identity =>
				identity.core.returnedAgentToolResultUtf8Sha256 !== projected.projection.core.resultUtf8Sha256 ||
				identity.core.returnedAgentToolResultUtf8ByteLength !== projected.projection.core.resultUtf8ByteLength ||
				identity.core.returnedSourceResultSnapshotSha256 !==
					projected.projection.core.sourceResultSnapshot.sourceSnapshotUtf8Sha256 ||
				identity.core.returnedSourceResultSnapshotByteLength !==
					projected.projection.core.sourceResultSnapshot.sourceSnapshotUtf8ByteLength,
		)
	)
		return false;
	const [firstIdentity, ...remainingIdentities] = validatedIdentities;
	if (!firstIdentity) return false;
	const orderedPreReturnIdentities: ConfidentialTransientTaskForegroundBeforeReturnRecordV1["orderedPreReturnIdentities"] =
		[firstIdentity, ...remainingIdentities];
	const orderedPreReturnIdentitySha256s: ConfidentialTransientTaskForegroundBeforeReturnRecordV1["orderedPreReturnIdentitySha256s"] =
		[firstIdentity.preReturnIdentitySha256, ...remainingIdentities.map(identity => identity.preReturnIdentitySha256)];
	const validatedRecord: ConfidentialTransientTaskForegroundBeforeReturnRecordV1 = {
		schemaVersion: 1,
		dispatchClassification: classification,
		toolResultSerializerKeySha256: record.toolResultSerializerKeySha256,
		sourceToolCallOrdinal: record.sourceToolCallOrdinal,
		batchKeyInput: batch,
		preallocationRequest: preallocation,
		pendingOverlayBinding: binding,
		returnedAgentToolResult: projected.sourceResult,
		returnedSourceResultSnapshot: projected.projection.core.sourceResultSnapshot,
		returnedAgentToolResultWire: projected.projection.core.wireResult,
		returnedAgentToolResultUtf8: projected.projection.core.resultUtf8,
		orderedPreReturnIdentities,
		orderedPreReturnIdentitySha256s,
		frozenBeforeReturnAt: record.frozenBeforeReturnAt,
		recordSha256: record.recordSha256,
	};
	return record.recordSha256 === beforeReturnRecordDigest(validatedRecord);
}

type BeforeReturnPendingOverlaySnapshotIdentityV1 = Pick<
	PendingOverlaySnapshotV1,
	| "pendingOverlaySnapshotSha256"
	| "finalVersion"
	| "finalVersionSha256"
	| "captureOutcomeHistorySha256"
	| "finalCaptureOutcomeSha256"
>;

function beforeReturnRecoveryKey(
	record: ConfidentialTransientTaskForegroundBeforeReturnRecordV1,
	snapshot: BeforeReturnPendingOverlaySnapshotIdentityV1,
): ConfidentialTransientTaskForegroundBeforeReturnRecoveryKeyV1 {
	const batch = record.batchKeyInput;
	const core = {
		schemaVersion: 1 as const,
		parentSessionId: batch.parentSessionId,
		parentSessionGenerationSha256: batch.parentSessionGenerationSha256,
		parentBranchGenerationSha256: batch.parentBranchGenerationSha256,
		parentBranchAnchorEntryId: batch.parentBranchAnchorEntryId,
		toolCallId: batch.toolCallId,
		foregroundAppendBatchKeySha256: record.preallocationRequest.foregroundAppendBatchKeySha256,
		beforeReturnRecordSha256: record.recordSha256,
		pendingOverlayBindingSha256: record.pendingOverlayBinding.bindingSha256,
		pendingOverlaySnapshotSha256: snapshot.pendingOverlaySnapshotSha256,
		pendingOverlayFinalVersion: snapshot.finalVersion,
		pendingOverlayFinalVersionSha256: snapshot.finalVersionSha256,
		pendingOverlayCaptureOutcomeHistorySha256: snapshot.captureOutcomeHistorySha256,
		pendingOverlayFinalCaptureOutcomeSha256: snapshot.finalCaptureOutcomeSha256,
		returnedSourceResultSnapshotSha256: record.returnedSourceResultSnapshot.sourceSnapshotUtf8Sha256,
		returnedSourceResultSnapshotByteLength: record.returnedSourceResultSnapshot.sourceSnapshotUtf8ByteLength,
		returnedAgentToolResultUtf8Sha256: detachedUtf8Sha256Ref(record.returnedAgentToolResultUtf8),
		returnedAgentToolResultUtf8ByteLength: Buffer.byteLength(record.returnedAgentToolResultUtf8, "utf8"),
		orderedPreReturnIdentitySha256s: record.orderedPreReturnIdentitySha256s,
	};
	return {
		...core,
		recoveryKeySha256: detachedTupleSha256Ref([
			"omp-transient-task-foreground-settlement-v1",
			"before-return-recovery-key-core",
			1,
			core.parentSessionId,
			core.parentSessionGenerationSha256,
			core.parentBranchGenerationSha256,
			core.parentBranchAnchorEntryId,
			core.toolCallId,
			core.foregroundAppendBatchKeySha256,
			core.beforeReturnRecordSha256,
			core.pendingOverlayBindingSha256,
			core.pendingOverlaySnapshotSha256,
			core.pendingOverlayFinalVersion,
			core.pendingOverlayFinalVersionSha256,
			core.pendingOverlayCaptureOutcomeHistorySha256,
			core.pendingOverlayFinalCaptureOutcomeSha256,
			core.returnedSourceResultSnapshotSha256,
			core.returnedSourceResultSnapshotByteLength,
			core.returnedAgentToolResultUtf8Sha256,
			core.returnedAgentToolResultUtf8ByteLength,
			core.orderedPreReturnIdentitySha256s,
		]),
	};
}

function beforeReturnHexDigest(tuple: readonly unknown[]): Sha256Hex {
	return createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex") as Sha256Hex;
}

function validBeforeReturnSuspension(
	input: unknown,
): input is ConfidentialTransientTaskForegroundBeforeReturnSuspensionV1 {
	if (
		!detachedStrictRecord(input, [
			"schemaVersion",
			"record",
			"projection",
			"reason",
			"suspendedAt",
			"suspensionSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!validBeforeReturnRecord(input.record) ||
		!detachedStrictRecord(input.projection, [
			"schemaVersion",
			"state",
			"foregroundAppendBatchKeySha256",
			"beforeReturnRecordSha256",
			"returnedSourceResultSnapshotSha256",
			"reason",
		]) ||
		input.projection.schemaVersion !== 1 ||
		input.projection.state !== "before_return_suspended" ||
		!detachedString(input.reason) ||
		![
			"record_prepare_response_lost",
			"settlement_store_unavailable",
			"preallocation_response_lost",
			"session_manager_unavailable",
			"handoff_prepare_response_lost",
			"pending_overlay_missing",
			"pending_overlay_conflict",
			"session_generation_replaced",
			"branch_generation_replaced",
			"branch_anchor_missing",
			"conflict",
			"invalid",
		].includes(input.reason) ||
		input.projection.foregroundAppendBatchKeySha256 !==
			input.record.preallocationRequest.foregroundAppendBatchKeySha256 ||
		input.projection.beforeReturnRecordSha256 !== input.record.recordSha256 ||
		input.projection.returnedSourceResultSnapshotSha256 !==
			input.record.returnedSourceResultSnapshot.sourceSnapshotUtf8Sha256 ||
		input.projection.reason !== input.reason ||
		!detachedIso8601(input.suspendedAt) ||
		!detachedSha256Ref(input.suspensionSha256)
	)
		return false;
	return (
		input.suspensionSha256 ===
		detachedTupleSha256Ref([
			"omp-transient-task-foreground-settlement-v1",
			"before-return-suspension-core",
			1,
			input.record,
			input.projection.foregroundAppendBatchKeySha256,
			input.projection.returnedSourceResultSnapshotSha256,
			input.reason,
			input.suspendedAt,
		])
	);
}

function validBeforeReturnHandoff(batch: unknown): batch is ConfidentialTransientTaskForegroundResultHandoffBatchV1 {
	if (
		!detachedStrictRecord(batch, [
			"schemaVersion",
			"parentSessionId",
			"toolCallId",
			"toolResultSerializerKeySha256",
			"sourceToolCallOrdinal",
			"foregroundAppendBatchKeySha256",
			"toolResultEntryId",
			"pendingOverlayBinding",
			"orderedAppendOperationIds",
			"orderedPreReturnIdentities",
			"orderedPreReturnIdentitySha256s",
			"returnedAgentToolResultUtf8Sha256",
			"returnedAgentToolResultUtf8ByteLength",
			"returnedSourceResultSnapshotSha256",
			"returnedSourceResultSnapshotByteLength",
			"handoffs",
			"handoffBatchSha256",
		]) ||
		batch.schemaVersion !== 1 ||
		!detachedCanonicalData(batch) ||
		!detachedIdentity(batch.parentSessionId) ||
		!detachedIdentity(batch.toolCallId) ||
		!detachedSha256Ref(batch.toolResultSerializerKeySha256) ||
		!detachedInteger(batch.sourceToolCallOrdinal) ||
		!detachedSha256Ref(batch.foregroundAppendBatchKeySha256) ||
		!detachedIdentity(batch.toolResultEntryId) ||
		!detachedSha256Ref(batch.returnedAgentToolResultUtf8Sha256) ||
		!detachedInteger(batch.returnedAgentToolResultUtf8ByteLength) ||
		!detachedSha256Ref(batch.returnedSourceResultSnapshotSha256) ||
		!detachedInteger(batch.returnedSourceResultSnapshotByteLength) ||
		!detachedSha256Ref(batch.handoffBatchSha256) ||
		!detachedStrictArray(batch.handoffs) ||
		!detachedStrictArray(batch.orderedAppendOperationIds) ||
		!batch.orderedAppendOperationIds.every(detachedIdentity) ||
		!detachedStrictArray(batch.orderedPreReturnIdentities) ||
		!detachedStrictArray(batch.orderedPreReturnIdentitySha256s) ||
		!batch.orderedPreReturnIdentitySha256s.every(detachedSha256Ref) ||
		batch.handoffs.length === 0 ||
		batch.handoffs.length !== batch.orderedAppendOperationIds.length ||
		batch.handoffs.length !== batch.orderedPreReturnIdentities.length ||
		batch.handoffs.length !== batch.orderedPreReturnIdentitySha256s.length
	)
		return false;
	for (let index = 0; index < batch.handoffs.length; index++) {
		const identity = batch.orderedPreReturnIdentities[index];
		const handoff = batch.handoffs[index];
		if (
			!validBeforeReturnIdentity(identity, index, batch.handoffs.length) ||
			identity.preReturnIdentitySha256 !== batch.orderedPreReturnIdentitySha256s[index] ||
			identity.core.appendOperationId !== batch.orderedAppendOperationIds[index] ||
			!detachedStrictRecord(handoff, [
				"schemaVersion",
				"preReturnIdentity",
				"pendingOverlayBinding",
				"returnedAgentToolResult",
				"returnedSourceResultSnapshot",
				"returnedAgentToolResultWire",
				"returnedAgentToolResultUtf8",
				"preparedBeforeReturnAt",
				"handoffSha256",
			]) ||
			handoff.schemaVersion !== 1 ||
			!detachedExactJson(handoff.preReturnIdentity, identity) ||
			!detachedExactJson(handoff.pendingOverlayBinding, batch.pendingOverlayBinding) ||
			!detachedIso8601(handoff.preparedBeforeReturnAt) ||
			handoff.handoffSha256 !==
				detachedTupleSha256Ref([
					"omp-transient-task-foreground-settlement-v1",
					"handoff-core",
					1,
					handoff.preReturnIdentity,
					handoff.pendingOverlayBinding,
					handoff.returnedAgentToolResult,
					handoff.returnedSourceResultSnapshot,
					handoff.returnedAgentToolResultWire,
					handoff.returnedAgentToolResultUtf8,
					handoff.preparedBeforeReturnAt,
				])
		)
			return false;
	}
	return (
		batch.handoffBatchSha256 ===
		detachedTupleSha256Ref([
			"omp-transient-task-foreground-settlement-v1",
			"handoff-batch-core",
			1,
			batch.parentSessionId,
			batch.toolCallId,
			batch.toolResultSerializerKeySha256,
			batch.sourceToolCallOrdinal,
			batch.foregroundAppendBatchKeySha256,
			batch.toolResultEntryId,
			batch.pendingOverlayBinding,
			batch.orderedAppendOperationIds,
			batch.orderedPreReturnIdentities,
			batch.orderedPreReturnIdentitySha256s,
			batch.returnedAgentToolResultUtf8Sha256,
			batch.returnedAgentToolResultUtf8ByteLength,
			batch.returnedSourceResultSnapshotSha256,
			batch.returnedSourceResultSnapshotByteLength,
			batch.handoffs,
		])
	);
}
function beforeReturnHandoffMatchesRecord(
	batch: ConfidentialTransientTaskForegroundResultHandoffBatchV1,
	record: ConfidentialTransientTaskForegroundBeforeReturnRecordV1,
	key: ConfidentialTransientTaskForegroundBeforeReturnRecoveryKeyV1,
): boolean {
	return (
		batch.parentSessionId === record.batchKeyInput.parentSessionId &&
		batch.toolCallId === record.batchKeyInput.toolCallId &&
		batch.toolResultSerializerKeySha256 === record.toolResultSerializerKeySha256 &&
		batch.sourceToolCallOrdinal === record.sourceToolCallOrdinal &&
		batch.foregroundAppendBatchKeySha256 === key.foregroundAppendBatchKeySha256 &&
		batch.toolResultEntryId === record.preallocationRequest.expectedToolResultEntryId &&
		detachedExactJson(batch.pendingOverlayBinding, record.pendingOverlayBinding) &&
		detachedExactJson(batch.orderedPreReturnIdentities, record.orderedPreReturnIdentities) &&
		detachedExactJson(batch.orderedPreReturnIdentitySha256s, record.orderedPreReturnIdentitySha256s) &&
		batch.returnedAgentToolResultUtf8Sha256 === key.returnedAgentToolResultUtf8Sha256 &&
		batch.returnedAgentToolResultUtf8ByteLength === key.returnedAgentToolResultUtf8ByteLength &&
		batch.returnedSourceResultSnapshotSha256 === key.returnedSourceResultSnapshotSha256 &&
		batch.returnedSourceResultSnapshotByteLength === key.returnedSourceResultSnapshotByteLength &&
		batch.handoffs.every(
			(handoff, index) =>
				detachedExactJson(handoff.preReturnIdentity, record.orderedPreReturnIdentities[index]) &&
				detachedExactJson(handoff.pendingOverlayBinding, record.pendingOverlayBinding) &&
				detachedExactJson(handoff.returnedAgentToolResult, record.returnedAgentToolResult) &&
				detachedExactJson(handoff.returnedSourceResultSnapshot, record.returnedSourceResultSnapshot) &&
				detachedExactJson(handoff.returnedAgentToolResultWire, record.returnedAgentToolResultWire) &&
				handoff.returnedAgentToolResultUtf8 === record.returnedAgentToolResultUtf8,
		)
	);
}

function beforeReturnEnumerationRequestDigest(request: BeforeReturnEnumerateRequestV1): Sha256Hex {
	return beforeReturnHexDigest([
		"omp-transient-task-foreground-settlement-v1",
		"before-return-enumerate-core",
		1,
		request.parentSessionId,
		request.parentSessionGenerationSha256,
		request.parentBranchGenerationSha256,
		request.parentBranchAnchorEntryId,
		request.toolCallId,
		request.requestedAt,
	]);
}

function beforeReturnInspectRequestDigest(request: BeforeReturnInspectRequestV1): Sha256Hex {
	return beforeReturnHexDigest([
		"omp-transient-task-foreground-settlement-v1",
		"before-return-inspect-core",
		1,
		request.recoveryKey,
		request.expectedEnumerationInspectionSha256,
		request.requestedAt,
	]);
}

function beforeReturnAdoptRequestDigest(request: BeforeReturnAdoptRequestV1): Sha256Hex {
	return beforeReturnHexDigest([
		"omp-transient-task-foreground-settlement-v1",
		"before-return-adopt-core",
		1,
		request.inspection,
		request.expectedInspectionSha256,
		request.requestedAt,
	]);
}

function beforeReturnPendingDigest(row: BeforeReturnRuntimeRowV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"before-return-pending-core",
		1,
		row.recoveryKey,
		row.handoffBatch ? "handoff_prepared" : row.suspension ? "suspended" : "recorded",
		row.suspension?.suspensionSha256 ?? null,
		row.handoffBatch?.handoffBatchSha256 ?? null,
	]);
}
function validBeforeReturnRecoveryKey(
	input: unknown,
): input is ConfidentialTransientTaskForegroundBeforeReturnRecoveryKeyV1 {
	return (
		detachedStrictRecord(input, [
			"schemaVersion",
			"parentSessionId",
			"parentSessionGenerationSha256",
			"parentBranchGenerationSha256",
			"parentBranchAnchorEntryId",
			"toolCallId",
			"foregroundAppendBatchKeySha256",
			"beforeReturnRecordSha256",
			"pendingOverlayBindingSha256",
			"pendingOverlaySnapshotSha256",
			"pendingOverlayFinalVersion",
			"pendingOverlayFinalVersionSha256",
			"pendingOverlayCaptureOutcomeHistorySha256",
			"pendingOverlayFinalCaptureOutcomeSha256",
			"returnedSourceResultSnapshotSha256",
			"returnedSourceResultSnapshotByteLength",
			"returnedAgentToolResultUtf8Sha256",
			"returnedAgentToolResultUtf8ByteLength",
			"orderedPreReturnIdentitySha256s",
			"recoveryKeySha256",
		]) &&
		input.schemaVersion === 1 &&
		detachedIdentity(input.parentSessionId) &&
		detachedSha256Ref(input.parentSessionGenerationSha256) &&
		detachedSha256Ref(input.parentBranchGenerationSha256) &&
		detachedIdentity(input.parentBranchAnchorEntryId) &&
		detachedIdentity(input.toolCallId) &&
		detachedSha256Ref(input.foregroundAppendBatchKeySha256) &&
		detachedSha256Ref(input.beforeReturnRecordSha256) &&
		detachedSha256Ref(input.pendingOverlayBindingSha256) &&
		detachedSha256Ref(input.pendingOverlaySnapshotSha256) &&
		detachedInteger(input.pendingOverlayFinalVersion) &&
		detachedSha256Ref(input.pendingOverlayFinalVersionSha256) &&
		detachedSha256Ref(input.pendingOverlayCaptureOutcomeHistorySha256) &&
		detachedSha256Ref(input.pendingOverlayFinalCaptureOutcomeSha256) &&
		detachedSha256Ref(input.returnedSourceResultSnapshotSha256) &&
		detachedInteger(input.returnedSourceResultSnapshotByteLength) &&
		detachedSha256Ref(input.returnedAgentToolResultUtf8Sha256) &&
		detachedInteger(input.returnedAgentToolResultUtf8ByteLength) &&
		detachedStrictArray(input.orderedPreReturnIdentitySha256s) &&
		input.orderedPreReturnIdentitySha256s.length > 0 &&
		input.orderedPreReturnIdentitySha256s.every(detachedSha256Ref) &&
		detachedSha256Ref(input.recoveryKeySha256)
	);
}

function validBeforeReturnInspectionEnumerationJoin(
	input: unknown,
): input is BeforeReturnRuntimeRowV1["inspectionEnumerationJoins"][number] {
	return (
		detachedStrictRecord(input, ["inspectionSha256", "enumerationInspectionSha256"]) &&
		detachedSha256Ref(input.inspectionSha256) &&
		detachedSha256Ref(input.enumerationInspectionSha256)
	);
}

function validBeforeReturnRuntimeRow(input: unknown): input is BeforeReturnRuntimeRowV1 {
	if (
		!detachedStrictRecord(input, [
			"recoveryKey",
			"record",
			"suspension",
			"handoffBatch",
			"enumerationInspectionSha256s",
			"inspectionEnumerationJoins",
			"adoptionRequestSha256",
			"adoptionReceipt",
		]) ||
		!validBeforeReturnRecord(input.record) ||
		!detachedStrictArray(input.enumerationInspectionSha256s) ||
		!input.enumerationInspectionSha256s.every(detachedSha256Ref) ||
		!detachedStrictArray(input.inspectionEnumerationJoins) ||
		!input.inspectionEnumerationJoins.every(validBeforeReturnInspectionEnumerationJoin) ||
		(input.suspension !== null && !validBeforeReturnSuspension(input.suspension)) ||
		(input.handoffBatch !== null && !validBeforeReturnHandoff(input.handoffBatch)) ||
		(input.adoptionRequestSha256 !== null && !detachedSha256Hex(input.adoptionRequestSha256)) ||
		(input.adoptionReceipt !== null && !detachedCanonicalData(input.adoptionReceipt))
	)
		return false;
	const key = input.recoveryKey;
	const record = input.record;
	const batch = record.batchKeyInput;
	const binding = record.pendingOverlayBinding.preDispatchBinding;
	if (
		!validBeforeReturnRecoveryKey(key) ||
		key.parentSessionId !== batch.parentSessionId ||
		key.parentSessionGenerationSha256 !== batch.parentSessionGenerationSha256 ||
		key.parentBranchGenerationSha256 !== batch.parentBranchGenerationSha256 ||
		key.parentBranchAnchorEntryId !== batch.parentBranchAnchorEntryId ||
		key.toolCallId !== batch.toolCallId ||
		key.foregroundAppendBatchKeySha256 !== record.preallocationRequest.foregroundAppendBatchKeySha256 ||
		key.beforeReturnRecordSha256 !== record.recordSha256 ||
		key.pendingOverlayBindingSha256 !== record.pendingOverlayBinding.bindingSha256 ||
		key.pendingOverlaySnapshotSha256 !== binding.pendingOverlaySnapshotSha256 ||
		key.pendingOverlayFinalVersion !== binding.finalVersion ||
		key.pendingOverlayFinalVersionSha256 !== binding.finalVersionSha256 ||
		key.pendingOverlayCaptureOutcomeHistorySha256 !== binding.captureOutcomeHistorySha256 ||
		key.pendingOverlayFinalCaptureOutcomeSha256 !== binding.finalCaptureOutcomeSha256 ||
		key.returnedSourceResultSnapshotSha256 !== record.returnedSourceResultSnapshot.sourceSnapshotUtf8Sha256 ||
		key.returnedSourceResultSnapshotByteLength !== record.returnedSourceResultSnapshot.sourceSnapshotUtf8ByteLength ||
		key.returnedAgentToolResultUtf8Sha256 !== detachedUtf8Sha256Ref(record.returnedAgentToolResultUtf8) ||
		key.returnedAgentToolResultUtf8ByteLength !== Buffer.byteLength(record.returnedAgentToolResultUtf8, "utf8") ||
		!detachedExactJson(key.orderedPreReturnIdentitySha256s, record.orderedPreReturnIdentitySha256s) ||
		(input.suspension !== null && !detachedExactJson(input.suspension.record, record)) ||
		(input.handoffBatch !== null && !beforeReturnHandoffMatchesRecord(input.handoffBatch, record, key))
	)
		return false;
	const pendingOverlaySnapshot: BeforeReturnPendingOverlaySnapshotIdentityV1 = {
		pendingOverlaySnapshotSha256: binding.pendingOverlaySnapshotSha256,
		finalVersion: binding.finalVersion,
		finalVersionSha256: binding.finalVersionSha256,
		captureOutcomeHistorySha256: binding.captureOutcomeHistorySha256,
		finalCaptureOutcomeSha256: binding.finalCaptureOutcomeSha256,
	};
	const expected = beforeReturnRecoveryKey(record, pendingOverlaySnapshot);
	if (
		key.recoveryKeySha256 !== expected.recoveryKeySha256 ||
		(input.adoptionReceipt === null) !== (input.adoptionRequestSha256 === null)
	)
		return false;
	const validatedRow: BeforeReturnRuntimeRowV1 = {
		recoveryKey: key,
		record,
		suspension: input.suspension,
		handoffBatch: input.handoffBatch,
		enumerationInspectionSha256s: input.enumerationInspectionSha256s,
		inspectionEnumerationJoins: input.inspectionEnumerationJoins,
		adoptionRequestSha256: input.adoptionRequestSha256,
		adoptionReceipt: null,
	};
	return input.adoptionReceipt === null || validBeforeReturnAdoptionReceipt(input.adoptionReceipt, validatedRow);
}

function validBeforeReturnAdoptionReceipt(
	receipt: unknown,
	row: BeforeReturnRuntimeRowV1,
): receipt is ConfidentialTransientTaskForegroundBeforeReturnAdoptionReceiptV1 {
	if (
		!detachedStrictRecord(receipt, [
			"schemaVersion",
			"recoveryKeySha256",
			"beforeReturnRecordSha256",
			"suspensionSha256",
			"handoffBatchSha256",
			"pendingOverlayBindingSha256",
			"pendingOverlaySnapshotSha256",
			"pendingOverlayFinalVersion",
			"pendingOverlayFinalVersionSha256",
			"pendingOverlayCaptureOutcomeHistorySha256",
			"pendingOverlayFinalCaptureOutcomeSha256",
			"returnedSourceResultSnapshotSha256",
			"returnedSourceResultSnapshotByteLength",
			"returnedAgentToolResultUtf8Sha256",
			"orderedPreReturnIdentitySha256s",
			"enumerationInspectionSha256",
			"exactInspectionSha256",
			"adoptedAt",
			"receiptSha256",
		]) ||
		receipt.schemaVersion !== 1 ||
		receipt.recoveryKeySha256 !== row.recoveryKey.recoveryKeySha256 ||
		receipt.beforeReturnRecordSha256 !== row.record.recordSha256 ||
		receipt.suspensionSha256 !== (row.suspension?.suspensionSha256 ?? null) ||
		receipt.handoffBatchSha256 !== (row.handoffBatch?.handoffBatchSha256 ?? null) ||
		receipt.pendingOverlayBindingSha256 !== row.recoveryKey.pendingOverlayBindingSha256 ||
		receipt.pendingOverlaySnapshotSha256 !== row.recoveryKey.pendingOverlaySnapshotSha256 ||
		receipt.pendingOverlayFinalVersion !== row.recoveryKey.pendingOverlayFinalVersion ||
		receipt.pendingOverlayFinalVersionSha256 !== row.recoveryKey.pendingOverlayFinalVersionSha256 ||
		receipt.pendingOverlayCaptureOutcomeHistorySha256 !== row.recoveryKey.pendingOverlayCaptureOutcomeHistorySha256 ||
		receipt.pendingOverlayFinalCaptureOutcomeSha256 !== row.recoveryKey.pendingOverlayFinalCaptureOutcomeSha256 ||
		receipt.returnedSourceResultSnapshotSha256 !== row.recoveryKey.returnedSourceResultSnapshotSha256 ||
		receipt.returnedSourceResultSnapshotByteLength !== row.recoveryKey.returnedSourceResultSnapshotByteLength ||
		receipt.returnedAgentToolResultUtf8Sha256 !== row.recoveryKey.returnedAgentToolResultUtf8Sha256 ||
		!detachedExactJson(receipt.orderedPreReturnIdentitySha256s, row.recoveryKey.orderedPreReturnIdentitySha256s) ||
		!row.inspectionEnumerationJoins.some(
			join =>
				join.inspectionSha256 === receipt.exactInspectionSha256 &&
				join.enumerationInspectionSha256 === receipt.enumerationInspectionSha256,
		) ||
		!detachedIso8601(receipt.adoptedAt)
	)
		return false;
	return (
		receipt.receiptSha256 ===
		detachedTupleSha256Ref([
			"omp-transient-task-foreground-settlement-v1",
			"before-return-adoption-core",
			1,
			receipt.recoveryKeySha256,
			receipt.beforeReturnRecordSha256,
			receipt.suspensionSha256,
			receipt.handoffBatchSha256,
			receipt.pendingOverlayBindingSha256,
			receipt.pendingOverlaySnapshotSha256,
			receipt.pendingOverlayFinalVersion,
			receipt.pendingOverlayFinalVersionSha256,
			receipt.pendingOverlayCaptureOutcomeHistorySha256,
			receipt.pendingOverlayFinalCaptureOutcomeSha256,
			receipt.returnedSourceResultSnapshotSha256,
			receipt.returnedSourceResultSnapshotByteLength,
			receipt.returnedAgentToolResultUtf8Sha256,
			receipt.orderedPreReturnIdentitySha256s,
			receipt.enumerationInspectionSha256,
			receipt.exactInspectionSha256,
			receipt.adoptedAt,
		])
	);
}

function lifecycleStateDigest(core: LifecycleStateV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-lifecycle-gate-v1",
		"state",
		1,
		core.key,
		core.state,
		core.acceptedObservation,
		core.observationReceipt,
		core.pendingCaptureRecordSha256,
		core.route,
		core.gateResult,
		core.suspension,
		core.resumeRequest,
		core.terminalCaptureReceipt,
		core.terminalMarker,
		core.gateResultRecordedAt,
	]);
}

function lifecyclePreparedStateForRequest(request: LifecyclePrepareRequestV1): LifecyclePreparedStateV1 {
	if (request.core.desiredState === "suspended") {
		const core: LifecycleSuspendedStateV1["core"] = {
			key: request.core.key,
			state: "suspended",
			acceptedObservation: request.core.acceptedObservation,
			observationReceipt: request.core.observationReceipt,
			pendingCaptureRecordSha256: request.core.pendingCaptureRecordSha256,
			route: request.core.route,
			gateResult: {
				status: "suspended",
				resultExposure: "blocked",
				terminalization: null,
				observationReceiptSha256: null,
				terminalReceiptSha256: null,
				suspension: request.core.suspension,
				resumeRequest: request.core.resumeRequest,
			},
			suspension: request.core.suspension,
			resumeRequest: request.core.resumeRequest,
			terminalCaptureReceipt: null,
			terminalMarker: null,
			gateResultRecordedAt: request.core.gateResultRecordedAt,
		};
		return { core, stateSha256: lifecycleStateDigest(core) };
	}
	const core: LifecycleAwaitingStateV1["core"] = {
		key: request.core.key,
		state: "awaiting_primary",
		acceptedObservation: request.core.acceptedObservation,
		observationReceipt: request.core.observationReceipt,
		pendingCaptureRecordSha256: request.core.pendingCaptureRecordSha256,
		route: request.core.route,
		gateResult: {
			status: "observation_durable",
			resultExposure: "continue_original_emission",
			terminalization: "awaiting_message_end_primary_persistence",
			observationReceiptSha256: request.core.observationReceipt.receiptSha256,
			terminalReceiptSha256: null,
			suspension: null,
			resumeRequest: null,
		},
		suspension: null,
		resumeRequest: null,
		terminalCaptureReceipt: null,
		terminalMarker: null,
		gateResultRecordedAt: request.core.gateResultRecordedAt,
	};
	return { core, stateSha256: lifecycleStateDigest(core) };
}

function validLifecyclePrepareRequest(input: unknown): input is LifecyclePrepareRequestV1 {
	if (
		!detachedStrictRecord(input, ["core", "requestSha256"]) ||
		!detachedStrictRecord(input.core, [
			"desiredState",
			"key",
			"acceptedObservation",
			"observationReceipt",
			"pendingCaptureRecordSha256",
			"route",
			"suspension",
			"resumeRequest",
			"gateResultRecordedAt",
		]) ||
		(input.core.desiredState !== "awaiting_primary" && input.core.desiredState !== "suspended") ||
		!detachedStrictRecord(input.core.key, ["core", "keySha256"]) ||
		!detachedStrictRecord(input.core.key.core, [
			"schemaVersion",
			"indexKeySha256",
			"observationSha256",
			"observationReceiptSha256",
			"lifecycleOrdinal",
		]) ||
		input.core.key.core.schemaVersion !== 1 ||
		!detachedSha256Ref(input.core.key.core.indexKeySha256) ||
		!detachedSha256Ref(input.core.key.core.observationSha256) ||
		!detachedSha256Ref(input.core.key.core.observationReceiptSha256) ||
		!detachedInteger(input.core.key.core.lifecycleOrdinal) ||
		input.core.key.keySha256 !==
			detachedTupleSha256Ref([
				"omp-transient-task-lifecycle-gate-v1",
				"key",
				1,
				input.core.key.core.indexKeySha256,
				input.core.key.core.observationSha256,
				input.core.key.core.observationReceiptSha256,
				input.core.key.core.lifecycleOrdinal,
			]) ||
		!detachedStrictRecord(input.core.acceptedObservation, ["core", "observationSha256"]) ||
		input.core.acceptedObservation.observationSha256 !== input.core.key.core.observationSha256 ||
		input.core.acceptedObservation.observationSha256 !==
			canonicalTransientTaskSourceObservationDigestV1(
				"source_observation_record",
				input.core.acceptedObservation.core,
			) ||
		!detachedStrictRecord(input.core.observationReceipt, ["core", "receiptSha256"]) ||
		!detachedCanonicalRecord(input.core.observationReceipt.core) ||
		input.core.observationReceipt.receiptSha256 !== input.core.key.core.observationReceiptSha256 ||
		input.core.observationReceipt.receiptSha256 !==
			canonicalTransientTaskSourceObservationDigestV1(
				"source_observation_receipt",
				input.core.observationReceipt.core,
			) ||
		input.core.observationReceipt.core.indexKeySha256 !== input.core.key.core.indexKeySha256 ||
		input.core.observationReceipt.core.lifecycleOrdinal !== input.core.key.core.lifecycleOrdinal ||
		!detachedSha256Ref(input.core.pendingCaptureRecordSha256) ||
		!detachedIso8601(input.core.gateResultRecordedAt) ||
		!detachedSha256Ref(input.requestSha256) ||
		input.requestSha256 !==
			detachedTupleSha256Ref([
				"omp-transient-task-lifecycle-gate-v1",
				"prepare",
				1,
				input.core.desiredState,
				input.core.key,
				input.core.acceptedObservation,
				input.core.observationReceipt,
				input.core.pendingCaptureRecordSha256,
				input.core.route,
				input.core.suspension,
				input.core.resumeRequest,
				input.core.gateResultRecordedAt,
			])
	)
		return false;
	return input.core.desiredState === "suspended"
		? input.core.suspension !== null && input.core.resumeRequest !== null
		: input.core.suspension === null && input.core.resumeRequest === null;
}

function overlayFinalizeRequestDigest(request: PendingOverlayFinalizeRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"pending-ttsr-finalize-core",
		1,
		request.key,
		request.expectedFinalVersion,
		request.expectedFinalVersionSha256,
		request.expectedCaptureOutcomeHistorySha256,
		request.finalizedAt,
	]);
}

function overlayInspectRequestDigest(request: PendingOverlayInspectRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"pending-ttsr-inspect-core",
		1,
		request.key,
		request.expectedBinding,
		request.requestedAt,
	]);
}

function overlayInspectionDigest(
	request: PendingOverlayInspectRequestV1,
	snapshot: PendingOverlaySnapshotV1,
	binding: PendingOverlayPreDispatchBindingV1,
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"pending-ttsr-inspection",
		1,
		request,
		"matching",
		snapshot,
		binding,
		request.requestedAt,
	]);
}

function overlayAdoptRequestDigest(request: PendingOverlayAdoptRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"pending-ttsr-adopt-core",
		1,
		request.inspection,
		request.expectedInspectionSha256,
		request.requestedAt,
	]);
}

function overlayAnchorBindRequestDigest(request: PendingOverlayAnchorBindRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"pending-ttsr-anchor-bind-core",
		1,
		request.snapshot,
		request.preDispatchBinding,
		request.parentBranchGenerationSha256,
		request.parentBranchAnchorEntryId,
		request.toolCallId,
		request.requestedAt,
	]);
}

function captureTerminalObservationDigest(request: PendingOverlayTerminalRequestV1): Sha256Ref {
	const core = request.core.observation.core;
	return detachedTupleSha256Ref([
		"omp-transient-task-capture-terminal-v1",
		"observation-core",
		1,
		core.key,
		core.observedStreamedToolCallEventCount,
		core.registeredMessageUpdateCaptureCount,
		core.orderedStreamedObservations,
		core.orderedPreparedVersions,
		core.highestPreparedVersion,
		core.highestPreparedVersionSha256,
		core.finalizedSnapshot,
		core.preDispatchBinding,
	]);
}

function captureTerminalDispositionDigest(request: PendingOverlayTerminalRequestV1): Sha256Ref {
	const core = request.core.disposition.core;
	return detachedTupleSha256Ref([
		"omp-transient-task-capture-terminal-v1",
		"disposition-core",
		1,
		core.kind,
		core.route,
		core.sourceObservationReceipt,
		core.provisionalClaimDisposition,
	]);
}

function captureTerminalRequestDigest(request: PendingOverlayTerminalRequestV1): Sha256Ref {
	const core = request.core;
	return detachedTupleSha256Ref([
		"omp-transient-task-capture-terminal-v1",
		"request-core",
		1,
		core.key,
		core.observation,
		core.disposition,
		core.sourceObservationAdoption,
		core.primaryPersistenceReceipt,
		core.orderedProvisionalClaimSha256sToRelease,
		core.requestedAt,
	]);
}

function captureTerminalReceiptDigest(core: PendingOverlayTerminalReceiptV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-capture-terminal-v1",
		"receipt-core",
		1,
		core.keySha256,
		core.requestSha256,
		core.observationSha256,
		core.dispositionSha256,
		core.sourceObservationReceiptSha256,
		core.sourceObservationAdoptionReceiptSha256,
		core.primaryPersistenceReceiptSha256,
		core.finalVersionSha256,
		core.pendingOverlaySnapshotSha256,
		core.releasedProvisionalClaimSha256s,
		core.terminalizedAt,
	]);
}

function captureTerminalInspectRequestDigest(request: PendingOverlayTerminalInspectRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-capture-terminal-v1",
		"inspect-request-core",
		1,
		request.core.key,
		request.core.expectedTerminalRequestSha256,
		request.core.requestedAt,
	]);
}

function captureTerminalAdoptRequestDigest(request: PendingOverlayTerminalAdoptRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-capture-terminal-v1",
		"adopt-request-core",
		1,
		request.core.inspection,
		request.core.expectedInspectionSha256,
		request.core.requestedAt,
	]);
}

function lifecycleEnumerateRequestDigest(request: LifecycleEnumerateRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-lifecycle-gate-v1",
		"enumerate",
		1,
		request.parentSessionId,
		request.parentSessionGenerationSha256,
		request.parentBranchAnchorEntryId,
		request.parentBranchGenerationSha256,
		request.indexKey,
		request.requestedAt,
	]);
}

function lifecycleEnumerationInspectionDigest(
	request: LifecycleEnumerateRequestV1,
	unresolved: readonly {
		readonly keySha256: Sha256Ref;
		readonly stateSha256: Sha256Ref;
		readonly lifecycleOrdinal: number;
	}[],
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-lifecycle-gate-v1",
		"enumeration-inspection",
		1,
		request,
		request.requestSha256,
		"matching",
		unresolved.map(member => [member.keySha256, member.stateSha256, member.lifecycleOrdinal]),
		request.requestedAt,
	]);
}

function lifecycleInspectRequestDigest(request: LifecycleInspectRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-lifecycle-gate-v1",
		"inspect",
		1,
		request.enumerationInspection,
		request.enumerationInspection.inspectionSha256,
		request.memberIndex,
		request.requestedAt,
	]);
}

function lifecycleInspectionDigest(request: LifecycleInspectRequestV1, state: LifecycleStateV1 | null): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-lifecycle-gate-v1",
		"inspection",
		1,
		request,
		request.requestSha256,
		state === null ? ["absent"] : ["matching", state.core.key.keySha256, state.stateSha256],
	]);
}

function lifecycleAdoptRequestDigest(request: LifecycleAdoptRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-lifecycle-gate-v1",
		"adopt",
		1,
		request.inspection,
		request.expectedInspectionSha256,
		request.adoptedAt,
	]);
}

function lifecycleResumeRequestDigest(request: LifecycleResumeRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-lifecycle-gate-v1",
		"resume",
		1,
		request.core.expectedSuspendedStateSha256,
		request.core.resumeRequest,
		request.core.gateResult,
		request.core.terminalCaptureReceipt,
		request.core.terminalMarker,
		request.core.resumedAt,
	]);
}

function lifecycleTerminalizeRequestDigest(request: LifecycleTerminalizeRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-lifecycle-gate-v1",
		"terminalize",
		1,
		request.expectedAwaitingStateSha256,
		request.terminalCaptureReceipt,
		request.terminalMarker,
		request.terminalizedAt,
	]);
}

function lifecycleMarkerDigest(marker: LifecycleMarkerV1): Sha256Ref {
	const core = marker.core;
	return detachedTupleSha256Ref([
		"omp-transient-task-pending-capture-v1",
		"terminal-marker-core",
		1,
		core.indexKey,
		core.route,
		core.sourceObservationReceipt,
		core.terminalCaptureReceipt,
		core.terminalAuthority,
		core.terminalAt,
	]);
}

function lifecycleMarkerInspectRequestDigest(request: LifecycleMarkerInspectRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-lifecycle-gate-v1",
		"terminal-marker-inspect",
		1,
		request.indexKeySha256,
		request.expectedMarkerSha256,
		request.parentSessionGenerationSha256,
		request.requestedAt,
	]);
}

function lifecycleMarkerAdoptRequestDigest(request: LifecycleMarkerAdoptRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-lifecycle-gate-v1",
		"terminal-marker-adopt",
		1,
		request.inspection,
		request.expectedInspectionSha256,
		request.adoptedAt,
	]);
}

function serializerKeyDigest(key: SerializerQueueStateV1["core"]["serializerKey"]): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"key-core",
		1,
		key.parentSessionId,
		key.parentSessionGenerationSha256,
		key.parentBranchGenerationSha256,
		key.assistantAnchorEntryId,
	]);
}

function serializerTicketRouteTuple(core: SerializerTicketCoreV1): readonly unknown[] {
	if (core.route === "task_foreground_delivery")
		return [
			core.handoffBatch,
			core.renderedGate,
			core.taskToolResultMessage,
			core.taskToolResultSessionWire,
			core.taskToolResultMessageUtf8,
			core.taskToolResultMessageUtf8Sha256,
			core.taskToolResultMessageUtf8ByteLength,
			core.ttsrInjectionContentPlan,
		];
	if (core.route === "task_no_handoff_result") return [core.continuation];
	return [core.ordinaryPersistence];
}

function serializerTicketDigest(core: SerializerTicketCoreV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"ticket-core",
		1,
		core.serializerKey,
		core.completionOrdinal,
		core.toolCallId,
		core.toolName,
		core.exactToolResultMessage,
		core.exactToolResultMessageSha256,
		core.registeredBeforeEmissionAt,
		core.route,
		serializerTicketRouteTuple(core),
	]);
}

function serializerTicketFromInput(
	input: SerializerTicketInputV1,
	completionOrdinal: number,
	registeredBeforeEmissionAt: ISO8601,
): SerializerTicketV1 {
	if (input.route === "task_foreground_delivery") {
		const foreground: ForegroundSerializerTicketInputV1 = input;
		const core: Extract<SerializerTicketCoreV1, { readonly route: "task_foreground_delivery" }> = {
			...foreground,
			completionOrdinal,
			registeredBeforeEmissionAt,
		};
		return { core, ticketSha256: serializerTicketDigest(core) };
	}
	if (input.route === "task_no_handoff_result") {
		const noHandoff: NoHandoffSerializerTicketInputV1 = input;
		const core: Extract<SerializerTicketCoreV1, { readonly route: "task_no_handoff_result" }> = {
			...noHandoff,
			completionOrdinal,
			registeredBeforeEmissionAt,
		};
		return { core, ticketSha256: serializerTicketDigest(core) };
	}
	const ordinary: OrdinarySerializerTicketInputV1 = input;
	const core: Extract<SerializerTicketCoreV1, { readonly route: "non_task_ordinary" }> = {
		...ordinary,
		completionOrdinal,
		registeredBeforeEmissionAt,
	};
	return { core, ticketSha256: serializerTicketDigest(core) };
}

function serializerQueueDigest(core: SerializerQueueStateV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"queue-state-core",
		1,
		core.serializerKey,
		core.orderedTickets,
		core.committedTicketCount,
		core.previousPrimaryReceiptSha256,
		core.updatedAt,
	]);
}

function serializerAllocationRequestDigest(request: SerializerAllocationRequestV1): Sha256Ref {
	if (request.core.mode === "allocate") {
		return detachedTupleSha256Ref([1, "allocate", null, request.core.ticketInput, request.core.requestedAt]);
	}
	return detachedTupleSha256Ref([
		1,
		"reuse_selected_hub",
		request.core.serializerKey,
		request.core.toolCallId,
		request.core.completionReceipt,
		request.core.exactToolResultMessage,
		request.core.requestedAt,
	]);
}

function serializerAllocationReceiptDigest(core: SerializerAllocationReceiptV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		core.allocationRequestSha256,
		core.ticket,
		core.previousSerializerQueueState,
		core.registeredSerializerQueueState,
		core.previousAllocatedTicketCount,
		core.allocatedTicketCount,
		core.allocatedAt,
	]);
}

function serializerHeadPermitDigest(core: SerializerHeadPermitV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"head-permit-core",
		1,
		core.serializerKeySha256,
		core.ticketSha256,
		core.completionOrdinal,
		core.currentPriorLeafEntryId,
		core.previousPrimaryReceiptSha256,
		core.resolvedAt,
	]);
}

function injectionAppendRequestDigest(request: InjectionAppendRequestV1): Sha256Ref {
	const core = request.core;
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"ttsr-injection-append-request-core",
		1,
		core.disposition,
		core.contentPlan,
		core.headPermit,
		core.currentPriorLeafEntryId,
		core.disposition === "exact_entry" ? core.deterministicEntryId : null,
		core.entry,
		core.nextTaskResultAppendParentEntryId,
		core.requestedAt,
	]);
}

function injectionAppendAttemptDigest(attempt: InjectionAppendAttemptV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"ttsr-injection-append-attempt-core",
		1,
		"not_applied",
		attempt.core.request,
		attempt.core.preparedAt,
	]);
}

function injectionAppendTransitionDigest(core: InjectionAppendTransitionV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"ttsr-injection-append-transition-core",
		1,
		core.attemptSha256,
		core.requestSha256,
		"not_applied",
		"outcome_unknown",
		core.transitionedImmediatelyBeforeDispatchAt,
	]);
}

function injectionAppendReceiptDigest(core: InjectionAppendReceiptV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"ttsr-injection-append-receipt-core",
		1,
		core.disposition,
		core.requestSha256,
		core.attemptSha256,
		core.transitionReceipt,
		core.entry,
		core.currentPriorLeafEntryId,
		core.nextTaskResultAppendParentEntryId,
		core.committedAt,
	]);
}

function noHandoffRequestDigest(request: NoHandoffAttemptV1["core"]["request"]): Sha256Ref {
	const core = request.core;
	return detachedTupleSha256Ref([
		"omp-transient-task-no-handoff-persistence-v1",
		"append-request-core",
		1,
		core.continuation,
		core.headPermit,
		core.injectionAppendRequest,
		core.taskResultEntry,
		core.requestedAt,
	]);
}

function noHandoffAttemptDigest(attempt: NoHandoffAttemptV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-no-handoff-persistence-v1",
		"append-attempt-core",
		1,
		"not_applied",
		attempt.core.request,
		attempt.core.preparedAt,
	]);
}

function noHandoffTransitionDigest(core: NoHandoffTransitionV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-no-handoff-persistence-v1",
		"append-transition-core",
		1,
		core.attemptSha256,
		core.requestSha256,
		"not_applied",
		"outcome_unknown",
		core.transitionedImmediatelyBeforeDispatchAt,
	]);
}

function noHandoffReceiptDigest(core: NoHandoffReceiptV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-no-handoff-persistence-v1",
		"append-receipt-core",
		1,
		core.requestSha256,
		core.attemptSha256,
		core.transitionReceiptSha256,
		core.injectionAppendReceipt,
		core.taskResultEntry,
		core.nextPriorLeafEntryId,
		core.committedAt,
	]);
}

function primaryRequestRouteTuple(request: PrimaryCommitAttemptV1["core"]["request"]): readonly unknown[] {
	const core = request.core;
	if (core.route === "task_foreground_delivery") return [core.injectionAppendRequest, core.foregroundAppendBatch];
	if (core.route === "task_no_handoff_result") return [core.noHandoffAppendAttempt];
	if (core.route === "non_task_ordinary") return [core.ordinaryAppendRequest];
	return [core.injectionRegistrationReceipt, core.injectionAppendRequest, core.ordinaryAppendRequest];
}

function primaryRequestDigest(request: PrimaryCommitAttemptV1["core"]["request"]): Sha256Ref {
	const core = request.core;
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"primary-request-core",
		1,
		core.route,
		core.ticket,
		core.headPermit,
		primaryRequestRouteTuple(request),
	]);
}

function primaryAttemptDigest(attempt: PrimaryCommitAttemptV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"primary-attempt-core",
		1,
		"not_applied",
		attempt.core.request,
		attempt.core.preparedAt,
	]);
}

function primaryTransitionDigest(core: PrimaryCommitTransitionV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"primary-transition-core",
		1,
		core.attemptSha256,
		core.requestSha256,
		"not_applied",
		"outcome_unknown",
		core.foregroundBatchTransitionReceiptSha256,
		core.transitionedImmediatelyBeforeDispatchAt,
	]);
}

function primaryEffectDigest(effect: PrimaryCommitEffectV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"primary-effect-core",
		1,
		effect.core.attempt,
		effect.core.transitionReceipt,
	]);
}

function primaryPersistenceRouteTuple(receipt: {
	readonly core: PrimaryPersistenceReceiptV1["core"];
}): readonly unknown[] {
	const core = receipt.core;
	if (core.route === "task_foreground_delivery") return [core.foregroundPrimaryReceipt, core.injectionAppendReceipt];
	if (core.route === "task_no_handoff_result")
		return [core.continuationSha256, core.pendingCaptureIndexKeySha256, core.noHandoffAppendReceipt];
	if (core.route === "non_task_ordinary") return [core.ordinaryAppendReceipt];
	return [core.hubWaitMessageInjectionResultReceipt];
}

function primaryPersistenceReceiptDigest(receipt: { readonly core: PrimaryPersistenceReceiptV1["core"] }): Sha256Ref {
	const core = receipt.core;
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"primary-persistence-receipt-core",
		1,
		core.route,
		core.requestSha256,
		core.transitionReceiptSha256,
		primaryPersistenceRouteTuple(receipt),
		core.nextPriorLeafEntryId,
		core.committedAt,
	]);
}

function foregroundRenderedGateDigest(
	gate: Omit<ConfidentialTransientTaskForegroundRenderedGateV1, "renderedGateSha256">,
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"rendered-gate-core",
		1,
		gate.preOverlayGateSha256,
		gate.foregroundAppendBatchKeySha256,
		gate.overlaySnapshotSha256,
		gate.renderedResult,
		gate.ttsrInjectionContentPlan,
		gate.appendedAt,
	]);
}

function foregroundOverlayCommitReceiptDigest(receipt: ForegroundOverlayCommitReceiptCoreV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"ttsr-overlay-commit-core",
		1,
		receipt.disposition,
		receipt.preOverlayGateSha256,
		receipt.renderedGateSha256,
		receipt.overlaySnapshotSha256,
		receipt.pendingOverlaySnapshotSha256,
		receipt.pendingOverlayFinalVersion,
		receipt.pendingOverlayFinalVersionSha256,
		receipt.pendingOverlayCaptureOutcomeHistorySha256,
		receipt.pendingOverlayFinalCaptureOutcomeSha256,
		receipt.injectionContentPlanSha256,
		receipt.injectionAppendRequestSha256,
		receipt.injectionAppendReceiptSha256,
		receipt.primaryPersistenceReceiptSha256,
		receipt.injectedRuleNames,
		receipt.ttsrInjectionEntry,
		receipt.committedAt,
	]);
}

function foregroundTtsrContentPlanMatchesSnapshot(
	contentPlan: ForegroundInjectionContentPlanV1,
	snapshot: ConfidentialTransientTaskForegroundTtsrOverlaySnapshotV1,
): boolean {
	if (
		!validateTransientTaskHubWaitMessageCanonicalRecordV1("foreground-ttsr-overlay-snapshot", snapshot) ||
		!validateTransientTaskHubWaitMessageCanonicalRecordV1("foreground-ttsr-injection-content-plan", contentPlan)
	)
		return false;
	if (snapshot.mode === "none") {
		return (
			contentPlan.disposition === "no_entry" &&
			snapshot.injectedRuleNames.length === 0 &&
			snapshot.renderedReminderUtf8 === ""
		);
	}
	return (
		contentPlan.disposition === "exact_entry" &&
		contentPlan.overlaySnapshotSha256 === snapshot.snapshotSha256 &&
		detachedExactJson(contentPlan.injectedRuleNames, snapshot.injectedRuleNames)
	);
}

function validForegroundRenderedGateForOverlay(
	gate: ConfidentialTransientTaskForegroundRenderedGateV1,
	snapshot: ConfidentialTransientTaskForegroundTtsrOverlaySnapshotV1,
): boolean {
	const { renderedGateSha256: _renderedGateSha256, ...core } = gate;
	return (
		detachedCanonicalData(gate) &&
		gate.schemaVersion === 1 &&
		detachedSha256Ref(gate.preOverlayGateSha256) &&
		detachedSha256Ref(gate.foregroundAppendBatchKeySha256) &&
		detachedSha256Ref(gate.overlaySnapshotSha256) &&
		detachedSha256Ref(gate.renderedResult.renderedResultSha256) &&
		detachedIso8601(gate.appendedAt) &&
		detachedSha256Ref(gate.renderedGateSha256) &&
		gate.overlaySnapshotSha256 === snapshot.snapshotSha256 &&
		gate.renderedResult.foregroundAppendBatchKeySha256 === gate.foregroundAppendBatchKeySha256 &&
		gate.renderedResult.preOverlayGateSha256 === gate.preOverlayGateSha256 &&
		gate.renderedResult.ttsrOverlaySnapshotSha256 === snapshot.snapshotSha256 &&
		foregroundTtsrContentPlanMatchesSnapshot(gate.ttsrInjectionContentPlan, snapshot) &&
		gate.renderedGateSha256 === foregroundRenderedGateDigest(core)
	);
}

function primaryCommitReceiptDigest(core: PrimaryCommitReceiptV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"primary-commit-receipt-core",
		1,
		core.route,
		core.requestSha256,
		core.attemptSha256,
		core.transitionReceiptSha256,
		core.primaryPersistenceReceipt,
		core.previousSerializerQueueState,
		core.advancedSerializerQueueState,
		core.previousSerializerQueueStateSha256,
		core.advancedSerializerQueueStateSha256,
		core.previousCommittedTicketCount,
		core.committedTicketCount,
		core.previousPrimaryPersistenceReceiptSha256,
		core.newPrimaryPersistenceReceiptSha256,
		core.nextPriorLeafEntryId,
		core.nextHeadTicketSha256,
		core.committedAt,
	]);
}

function primaryInspectRequestDigest(request: PrimaryInspectRequestV1): Sha256Ref {
	const core = request.core;
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"inspect-core",
		1,
		core.serializerKey,
		core.ticketSha256,
		core.expectedRequestSha256,
		core.expectedAttemptSha256,
		core.requestedAt,
	]);
}

function primaryAdoptRequestDigest(request: PrimaryAdoptRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"adopt-core",
		1,
		request.core.inspection,
		request.core.expectedInspectionSha256,
		request.core.requestedAt,
	]);
}

function foregroundPreallocationId(operationId: OperationId): string {
	return createHash("sha256")
		.update(JSON.stringify(["omp-transient-task-foreground-session-entry-id-v1", 1, operationId]), "utf8")
		.digest("hex")
		.slice(0, 8);
}
function foregroundResultAppendRequestDigest(
	request: ForegroundPrimaryRequestV1["core"]["foregroundAppendBatch"]["requests"][number],
): Sha256Hex {
	return beforeReturnHexDigest([
		"omp-transient-task-foreground-settlement-v1",
		"append-request-core",
		1,
		request.identity,
		request.preReturnIdentity,
		request.handoffSha256,
		request.handoffBatchSha256,
		request.foregroundAppendBatchKeySha256,
		request.renderedResultSha256,
		request.injectionAppendRequestSha256,
		request.entry,
		request.toolResultMessageUtf8,
		request.toolResultMessageUtf8Sha256,
		request.toolResultMessageUtf8ByteLength,
		request.deliveryAuthority,
	]);
}

function foregroundResultAppendBatchDigest(
	batch: ForegroundPrimaryRequestV1["core"]["foregroundAppendBatch"],
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"append-batch-core",
		1,
		batch.handoffBatch,
		batch.renderedResult,
		batch.foregroundAppendBatchKeySha256,
		batch.injectionAppendRequest,
		batch.entry,
		batch.requests,
	]);
}

function noHandoffContinuationDigest(
	continuation: NoHandoffPrimaryRequestV1["core"]["noHandoffAppendAttempt"]["core"]["request"]["core"]["continuation"],
): Sha256Ref {
	const core = continuation.core;
	return detachedTupleSha256Ref([
		"omp-transient-task-no-handoff-persistence-v1",
		"continuation-core",
		1,
		core.route,
		core.resultKind,
		core.pendingCaptureIndexKey,
		core.pendingCaptureRecordSha256,
		core.sourceObservationReceipt,
		core.taskToolResultMessage,
		core.taskToolResultSessionWire,
		core.taskToolResultMessageUtf8,
		core.taskToolResultMessageUtf8Sha256,
		core.taskToolResultMessageUtf8ByteLength,
		core.ttsrInjectionContentPlan,
		core.frozenBeforeEmissionAt,
	]);
}

function foregroundSessionAppendRequestDigest(
	request: Omit<ForegroundSessionAppendRequestV1, "sessionAppendRequestSha256">,
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"session-append-core",
		1,
		request.foregroundAppendBatchKeySha256,
		request.appendBatchSha256,
		request.injectionAppendRequestSha256,
		request.parentSessionId,
		request.parentSessionGenerationSha256,
		request.parentBranchGenerationSha256,
		request.parentBranchAnchorEntryId,
		request.appendParentEntryId,
		request.toolCallId,
		request.toolResultEntryId,
		request.orderedAppendOperationIds,
		request.orderedSettlementIdentitySha256s,
		request.entry,
	]);
}

function foregroundSessionAppendReceiptDigest(
	receipt: Omit<ForegroundSessionAppendReceiptV1, "primaryReceiptSha256">,
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"session-append-receipt-core",
		1,
		receipt.foregroundAppendBatchKeySha256,
		receipt.appendBatchSha256,
		receipt.orderedAppendOperationIds,
		receipt.orderedSettlementIdentitySha256s,
		receipt.sessionAppendRequestSha256,
		receipt.injectionAppendReceiptSha256,
		receipt.entry,
		receipt.toolResultMessageUtf8,
		receipt.toolResultMessageUtf8Sha256,
		receipt.toolResultMessageUtf8ByteLength,
		receipt.committedAt,
	]);
}

function serializerHeadRequestDigest(request: SerializerHeadRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"head-request-core",
		1,
		request.serializerKey,
		request.ticketSha256,
		request.requestedAt,
	]);
}

function serializerQueueInspectRequestDigest(request: SerializerQueueInspectRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"queue-inspect-core",
		1,
		request.core.serializerKey,
		request.core.expectedQueueStateSha256,
		request.core.requestedAt,
	]);
}

function serializerQueueInspectionDigest(
	request: SerializerQueueInspectRequestV1,
	status: "absent" | "matching",
	queue: SerializerQueueStateV1 | null,
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"queue-inspection",
		1,
		request,
		status,
		queue,
	]);
}

function serializerQueueAdoptRequestDigest(request: SerializerQueueAdoptRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"queue-adopt-core",
		1,
		request.core.inspection,
		request.core.expectedInspectionSha256,
		request.core.requestedAt,
	]);
}

function noHandoffInspectRequestDigest(request: NoHandoffInspectRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-no-handoff-persistence-v1",
		"append-inspect-core",
		1,
		request.core.attempt,
		request.core.expectedTransitionReceiptSha256,
		request.core.requestedAt,
	]);
}

function noHandoffInspectionDigest(
	request: NoHandoffInspectRequestV1,
	status: "not_applied" | "outcome_unknown" | "committed",
	value: NoHandoffAttemptV1 | NoHandoffTransitionV1 | NoHandoffReceiptV1,
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-no-handoff-persistence-v1",
		"append-inspection",
		1,
		request,
		status,
		value,
	]);
}

function ordinaryPersistenceDigest(
	persistence: OrdinaryAppendRequestV1["core"]["plan"]["core"]["ordinaryPersistence"],
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"ordinary-core",
		1,
		persistence.toolCallId,
		persistence.toolName,
		persistence.sourceToolResultMessage,
		persistence.sourceToolResultMessageSha256,
		persistence.ordinaryPersistenceRequestSha256,
	]);
}

function ordinaryEntryPreallocationReceiptDigest(
	core: OrdinaryAppendRequestV1["core"]["plan"]["core"]["entryPreallocationReceipt"]["core"],
): Sha256Ref {
	return detachedTupleSha256Ref([
		core.serializerKeySha256,
		core.ticketSha256,
		core.entryId,
		"available",
		core.checkedAt,
	]);
}

function noHandoffAdoptRequestDigest(request: NoHandoffAdoptRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-no-handoff-persistence-v1",
		"append-adopt-core",
		1,
		request.core.inspection,
		request.core.expectedInspectionSha256,
		request.core.requestedAt,
	]);
}

function ordinaryAppendPlanDigest(plan: OrdinaryAppendRequestV1["core"]["plan"]): Sha256Ref {
	const core = plan.core;
	return detachedTupleSha256Ref([
		core.schemaVersion,
		core.ordinaryPersistence,
		core.ticketSha256,
		core.headPermit.core,
		core.initialAppendParentEntryId,
		core.entryPreallocationReceipt.core,
		core.entryTimestamp,
		core.exactToolResultMessage,
		core.entry,
		core.frozenAt,
	]);
}

function ordinaryAppendRequestDigest(request: OrdinaryAppendRequestV1): Sha256Ref {
	return detachedTupleSha256Ref([request.core.plan.core, request.core.requestedAt]);
}

function ordinaryAppendReceiptDigest(core: OrdinaryAppendReceiptV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		core.appendRequest.core,
		core.primaryAttemptSha256,
		core.primaryTransitionReceiptSha256,
		core.plan.core,
		core.entry,
		core.nextPriorLeafEntryId,
		core.committedAt,
	]);
}

function primaryAbsenceProofDigest(core: PrimaryAbsenceProofV1["core"]): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"primary-authoritative-absence-core",
		1,
		core.serializerKeySha256,
		core.ticketSha256,
		core.requestSha256,
		core.attemptSha256,
		core.transitionReceiptSha256,
		core.headPermitSha256,
		core.unchangedSerializerQueueState,
		core.ordinaryAppendPlan,
		core.expectedRouteEntriesInDispatchOrder,
		core.observedMatchingEntries,
		core.inspectedAt,
	]);
}

function ordinaryMatchingInspectionDigest(
	appendRequest: OrdinaryAppendRequestV1,
	plan: OrdinaryAppendRequestV1["core"]["plan"],
	entry: OrdinaryAppendRequestV1["core"]["plan"]["core"]["entry"],
	receipt: OrdinaryAppendReceiptV1,
): Sha256Ref {
	return detachedTupleSha256Ref(["matching_entry", appendRequest.core, plan.core, entry, receipt.core]);
}

function ordinaryAbsenceInspectionDigest(
	appendRequest: OrdinaryAppendRequestV1,
	plan: OrdinaryAppendRequestV1["core"]["plan"],
	entry: OrdinaryAppendRequestV1["core"]["plan"]["core"]["entry"],
	proof: PrimaryAbsenceProofV1,
): Sha256Ref {
	return detachedTupleSha256Ref(["authoritative_absence", appendRequest.core, plan.core, entry, proof.core]);
}

function primaryInspectionDigest(
	status: "absent" | "not_applied" | "authoritative_absence" | "outcome_unknown" | "committed",
	attempt: PrimaryCommitAttemptV1 | null,
	transition: PrimaryCommitTransitionV1 | null,
	receiptOrProof: PrimaryCommitReceiptV1 | PrimaryAbsenceProofV1 | null,
	ordinaryInspection: OrdinaryMatchingInspectionV1 | OrdinaryAbsenceInspectionV1 | null,
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-agent-session-tool-result-serializer-v1",
		"inspection",
		1,
		status,
		attempt,
		transition,
		receiptOrProof,
		ordinaryInspection,
	]);
}

function hubInjectionRegistrationReceiptDigest(
	receipt: HubPrimaryRequestV1["core"]["injectionRegistrationReceipt"],
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-hub-wait-message-winner-v1",
		"ttsr-injection-registration-receipt",
		1,
		receipt.afterToolCallPlanSha256,
		receipt.contentPlan,
		receipt.ordinaryPersistenceTicketSha256,
		receipt.registeredAt,
	]);
}

function hubInjectionResultPersistenceReceiptDigest(
	receipt: Omit<HubInjectionResultPersistenceReceiptV1, "receiptSha256">,
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-hub-wait-message-winner-v1",
		"injection-result-persistence-receipt",
		1,
		receipt.primaryCommitRequestSha256,
		receipt.primaryCommitAttemptSha256,
		receipt.primaryCommitTransitionReceiptSha256,
		receipt.ordinaryPersistenceTicketSha256,
		receipt.headPermitSha256,
		receipt.injectionRegistrationReceiptSha256,
		receipt.injectionAppendReceipt,
		receipt.ordinaryAppendPlanSha256,
		receipt.ordinaryAppendReceipt.core,
		receipt.nextPriorLeafEntryId,
		receipt.committedAt,
	]);
}

function foregroundSessionInspectDigest(
	request: ForegroundSessionAppendInspectRequestV1,
	status: "absent" | "matching",
	receipt: ForegroundSessionAppendReceiptV1 | null,
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-foreground-settlement-v1",
		"session-append-inspection",
		1,
		request,
		status,
		receipt,
	]);
}

function detachedResultTargetKeyTuple(identity: TransientTaskDetachedSettlementIdentityV1): readonly unknown[] {
	return [
		identity.taskId,
		identity.runId,
		identity.createId,
		identity.resultPublicationId,
		identity.resultPublicationTargetId,
		identity.resultPublicationTargetCleanupId,
	];
}

function detachedIdentityTuple(identity: TransientTaskDetachedSettlementIdentityV1): readonly unknown[] {
	return [
		"omp-transient-task-detached-settlement-v1",
		"identity",
		1,
		detachedResultTargetKeyTuple(identity),
		identity.deliveryOperationId,
		identity.ownerId,
		identity.jobId,
		identity.deliveryEpoch,
		identity.deliveryRequestSha256,
		identity.terminalStatus,
		identity.sinkProjectionKind,
		identity.cancellationKind,
		identity.jobErrorTextUtf8Sha256,
		identity.jobErrorTextUtf8ByteLength,
		identity.sinkResultUtf8Sha256,
		identity.sinkResultUtf8ByteLength,
	];
}

function detachedPrimarySelectorKey(
	plan: Pick<
		ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1,
		| "primarySessionId"
		| "primarySessionGenerationSha256"
		| "primaryBranchGenerationSha256"
		| "primaryBranchAnchorEntryId"
		| "appendParentEntryId"
		| "primarySessionEntryId"
		| "orderedOutboxMemberSha256s"
	>,
): string {
	return JSON.stringify([
		"omp-transient-task-parent-delivery-selector-v1",
		"detached-primary-session-persistence",
		1,
		plan.primarySessionId,
		plan.primarySessionGenerationSha256,
		plan.primaryBranchGenerationSha256,
		plan.primaryBranchAnchorEntryId,
		plan.appendParentEntryId,
		plan.primarySessionEntryId,
		plan.orderedOutboxMemberSha256s,
	]);
}

function detachedDerivationTuple(
	derivation: ConfidentialTransientTaskParentDeliveryEffectIdentityDerivationDescriptorV1["derivation"],
): readonly unknown[] {
	return [
		"omp-transient-task-effect-identity-v1",
		"derive",
		1,
		derivation.namespaceId,
		derivation.domain,
		["key", derivation.selector.keyUtf8],
	];
}

function detachedDescriptorTuple(
	descriptor: ConfidentialTransientTaskParentDeliveryEffectIdentityDerivationDescriptorV1,
): readonly unknown[] {
	return [
		"omp-transient-task-effect-identity-v1",
		"parent-delivery-descriptor",
		1,
		detachedDerivationTuple(descriptor.derivation),
		descriptor.derivation.selectorBinding,
	];
}

function detachedMemberCoreTuple(member: ConfidentialTransientTaskDetachedSessionOutboxMemberV1): readonly unknown[] {
	const core = member.core;
	return [
		"omp-transient-task-detached-settlement-v1",
		"session-outbox-member-core",
		1,
		detachedIdentityTuple(core.identity),
		core.sinkOperationId,
		core.outboxOperationId,
		core.deliveryRequestSha256,
		core.sinkResultUtf8,
		core.sinkResultUtf8Sha256,
		core.sinkResultUtf8ByteLength,
		core.currentAuthoritySha256,
		core.reservationReceiptSha256,
		core.jobMetadata,
	];
}

function detachedMemberTuple(member: ConfidentialTransientTaskDetachedSessionOutboxMemberV1): readonly unknown[] {
	return [
		"omp-transient-task-detached-settlement-v1",
		"session-outbox-member",
		1,
		detachedMemberCoreTuple(member),
		member.memberSha256,
	];
}

function detachedBatchKeyTuple(
	request: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanPrepareRequestV1,
): readonly unknown[] {
	return [
		"omp-transient-task-detached-settlement-v1",
		"primary-append-batch-key-core",
		1,
		request.parentDeliveryNamespaceId,
		request.primarySessionId,
		request.primarySessionGenerationSha256,
		request.primaryBranchGenerationSha256,
		request.primaryBranchAnchorEntryId,
		request.appendParentEntryId,
		request.orderedOutboxMembers.map(member => member.memberSha256),
		request.primarySessionMessageJsonUtf8,
		request.primarySessionMessageJsonUtf8Sha256,
		request.primarySessionMessageJsonUtf8ByteLength,
		request.primarySessionEntryTimestamp,
		request.preparedAt,
	];
}

function detachedPrepareRequestTuple(
	request: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanPrepareRequestV1,
): readonly unknown[] {
	return [
		"omp-transient-task-detached-settlement-v1",
		"primary-append-prepare-request",
		1,
		request.parentDeliveryNamespaceId,
		request.primarySessionId,
		request.primarySessionGenerationSha256,
		request.primaryBranchGenerationSha256,
		request.primaryBranchAnchorEntryId,
		request.appendParentEntryId,
		request.orderedOutboxMembers.map(detachedMemberTuple),
		request.primarySessionMessage,
		request.primarySessionMessageJsonUtf8,
		request.primarySessionMessageJsonUtf8Sha256,
		request.primarySessionMessageJsonUtf8ByteLength,
		request.primarySessionEntryTimestamp,
		request.preparedAt,
		request.primaryAppendBatchKeySha256,
	];
}

function detachedPlanTuple(
	plan: Omit<ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1, "primaryAppendPlanSha256">,
): readonly unknown[] {
	return [
		"omp-transient-task-detached-settlement-v1",
		"primary-append-plan",
		1,
		plan.preparationRequestSha256,
		plan.primaryAppendBatchKeySha256,
		plan.primaryAppendOperationId,
		detachedDescriptorTuple(plan.operationIdentityDerivationDescriptor),
		plan.primarySessionId,
		plan.primarySessionGenerationSha256,
		plan.primaryBranchGenerationSha256,
		plan.primaryBranchAnchorEntryId,
		plan.appendParentEntryId,
		plan.primarySessionEntryId,
		plan.orderedOutboxMemberSha256s,
		plan.primarySessionMessage,
		plan.primarySessionMessageJsonUtf8,
		plan.primarySessionMessageJsonUtf8Sha256,
		plan.primarySessionMessageJsonUtf8ByteLength,
		plan.primarySessionEntry,
		plan.primarySessionEntryJsonlUtf8,
		plan.primarySessionEntryJsonlUtf8Sha256,
		plan.primarySessionEntryJsonlUtf8ByteLength,
		plan.preparedAt,
	];
}

function detachedOutboxReceiptTuple(
	receipt: Omit<ConfidentialTransientTaskDetachedSessionOutboxReceiptV1, "receiptSha256">,
): readonly unknown[] {
	return [
		"omp-transient-task-detached-settlement-v1",
		"session-outbox-receipt",
		1,
		detachedMemberTuple(receipt.member),
		receipt.primaryAppendBatchKeySha256,
		receipt.primaryAppendPlanSha256,
		receipt.primaryAppendMemberIndex,
		receipt.primaryAppendMemberCount,
		receipt.persistedAt,
	];
}

function detachedPersistenceReceiptTuple(
	receipt: Omit<ConfidentialTransientTaskDetachedPrimarySessionPersistenceReceiptV1, "receiptSha256">,
): readonly unknown[] {
	return [
		"omp-transient-task-detached-settlement-v1",
		"primary-session-persistence",
		1,
		receipt.primaryAppendOperationId,
		receipt.primaryAppendBatchKeySha256,
		receipt.primaryAppendPlanSha256,
		receipt.orderedOutboxReceiptSha256s,
		receipt.primarySessionId,
		receipt.primarySessionGenerationSha256,
		receipt.primaryBranchGenerationSha256,
		receipt.primaryBranchAnchorEntryId,
		receipt.appendParentEntryId,
		receipt.primarySessionEntryId,
		receipt.primarySessionEntryJsonlUtf8Sha256,
		receipt.primarySessionEntryJsonlUtf8ByteLength,
		receipt.primaryAppendRequestSha256,
	];
}

function detachedAbsenceProofTuple(
	proof: ConfidentialTransientTaskDetachedPrimarySessionAppendAbsenceProofV1,
): readonly unknown[] {
	return [
		"omp-transient-task-detached-settlement-v1",
		"primary-append-absence-proof",
		1,
		proof.primaryAppendOperationId,
		proof.primaryAppendPlanSha256,
		proof.primarySessionId,
		proof.primarySessionGenerationSha256,
		proof.primaryBranchGenerationSha256,
		proof.primaryBranchAnchorEntryId,
		proof.appendParentEntryId,
		proof.primarySessionEntryId,
		proof.expectedPrimarySessionEntryJsonlUtf8Sha256,
		proof.observedCurrentLeafEntryId,
	];
}

function detachedInspectRequestTuple(
	plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1,
	expectedPrimaryAppendRequestSha256: Sha256Ref,
): readonly unknown[] {
	return [
		"omp-transient-task-detached-settlement-v1",
		"primary-append-inspect-request",
		1,
		detachedPlanTuple(plan),
		expectedPrimaryAppendRequestSha256,
	];
}

function detachedInspectionSha256(
	plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1,
	expectedPrimaryAppendRequestSha256: Sha256Ref,
	state: readonly unknown[],
): Sha256Ref {
	return detachedTupleSha256Ref([
		"omp-transient-task-detached-settlement-v1",
		"primary-append-inspection",
		1,
		detachedInspectRequestTuple(plan, expectedPrimaryAppendRequestSha256),
		state,
	]);
}

function validDetachedJobMetadata(input: unknown): boolean {
	if (input === null || typeof input !== "object") return false;
	const hasLabel = Object.hasOwn(input, "label");
	const hasDuration = Object.hasOwn(input, "durationMs");
	const keys = ["jobId", "type", ...(hasLabel ? ["label"] : []), ...(hasDuration ? ["durationMs"] : [])];
	return Boolean(
		detachedStrictRecord(input, keys) &&
			detachedIdentity(input.jobId) &&
			input.type === "task" &&
			(!hasLabel || detachedString(input.label)) &&
			(!hasDuration || detachedInteger(input.durationMs)),
	);
}

function validDetachedSettlementIdentity(
	input: unknown,
	parentDeliveryNamespaceId: OperationId,
): input is Exclude<TransientTaskDetachedSettlementIdentityV1, { readonly terminalStatus: "cancelled" }> {
	if (
		!detachedStrictRecord(input, [
			"schemaVersion",
			"taskId",
			"runId",
			"createId",
			"resultPublicationId",
			"resultPublicationTargetId",
			"resultPublicationTargetCleanupId",
			"deliveryOperationId",
			"ownerId",
			"jobId",
			"deliveryEpoch",
			"deliveryRequestSha256",
			"sinkResultUtf8Sha256",
			"sinkResultUtf8ByteLength",
			"identitySha256",
			"terminalStatus",
			"sinkProjectionKind",
			"cancellationKind",
			"jobErrorTextUtf8Sha256",
			"jobErrorTextUtf8ByteLength",
		]) ||
		input.schemaVersion !== 1 ||
		![
			input.taskId,
			input.runId,
			input.createId,
			input.resultPublicationId,
			input.resultPublicationTargetId,
			input.resultPublicationTargetCleanupId,
			input.deliveryOperationId,
			input.ownerId,
			input.jobId,
		].every(detachedIdentity) ||
		!detachedInteger(input.deliveryEpoch) ||
		!detachedSha256Hex(input.deliveryRequestSha256) ||
		!detachedSha256Ref(input.sinkResultUtf8Sha256) ||
		!detachedInteger(input.sinkResultUtf8ByteLength) ||
		!detachedSha256Ref(input.identitySha256) ||
		(input.terminalStatus !== "completed" && input.terminalStatus !== "failed") ||
		input.sinkProjectionKind !== "detached_async_result_entry" ||
		input.cancellationKind !== null ||
		input.jobErrorTextUtf8Sha256 !== null ||
		input.jobErrorTextUtf8ByteLength !== null
	)
		return false;
	const identity = input as unknown as Exclude<
		TransientTaskDetachedSettlementIdentityV1,
		{ readonly terminalStatus: "cancelled" }
	>;
	if (identity.identitySha256 !== detachedTupleSha256Ref(detachedIdentityTuple(identity))) return false;
	const selectorBinding = {
		resultPublicationTargetId: identity.resultPublicationTargetId,
		ownerId: identity.ownerId,
		jobId: identity.jobId,
		deliveryEpoch: identity.deliveryEpoch,
	};
	const derivation = {
		namespace: "parent_delivery" as const,
		namespaceId: parentDeliveryNamespaceId,
		domain: "detached_enqueue" as const,
		selector: {
			kind: "key" as const,
			keyUtf8: JSON.stringify([
				"omp-transient-task-parent-delivery-selector-v1",
				"detached-enqueue",
				1,
				identity.resultPublicationTargetId,
				identity.ownerId,
				identity.jobId,
				identity.deliveryEpoch,
			]),
		},
		selectorBinding,
	};
	return deriveTransientTaskEffectOperationIdV1(derivation) === identity.deliveryOperationId;
}

function validDetachedMember(
	input: unknown,
	parentDeliveryNamespaceId: OperationId,
): input is ConfidentialTransientTaskDetachedSessionOutboxMemberV1 {
	if (
		!detachedStrictRecord(input, ["core", "memberSha256"]) ||
		!detachedSha256Ref(input.memberSha256) ||
		!detachedStrictRecord(input.core, [
			"schemaVersion",
			"identity",
			"sinkOperationId",
			"outboxOperationId",
			"deliveryRequestSha256",
			"sinkResultUtf8",
			"sinkResultUtf8Sha256",
			"sinkResultUtf8ByteLength",
			"currentAuthoritySha256",
			"reservationReceiptSha256",
			"jobMetadata",
		]) ||
		input.core.schemaVersion !== 1 ||
		!validDetachedSettlementIdentity(input.core.identity, parentDeliveryNamespaceId) ||
		!detachedIdentity(input.core.sinkOperationId) ||
		!detachedIdentity(input.core.outboxOperationId) ||
		!detachedSha256Hex(input.core.deliveryRequestSha256) ||
		!detachedString(input.core.sinkResultUtf8, true) ||
		!detachedSha256Ref(input.core.sinkResultUtf8Sha256) ||
		!detachedInteger(input.core.sinkResultUtf8ByteLength) ||
		!detachedSha256Ref(input.core.currentAuthoritySha256) ||
		!detachedSha256Ref(input.core.reservationReceiptSha256) ||
		!validDetachedJobMetadata(input.core.jobMetadata)
	)
		return false;
	const member = input as unknown as ConfidentialTransientTaskDetachedSessionOutboxMemberV1;
	const core = member.core;
	if (
		core.identity.deliveryRequestSha256 !== core.deliveryRequestSha256 ||
		core.identity.sinkResultUtf8Sha256 !== core.sinkResultUtf8Sha256 ||
		core.identity.sinkResultUtf8ByteLength !== core.sinkResultUtf8ByteLength ||
		core.identity.jobId !== core.jobMetadata.jobId ||
		Buffer.byteLength(core.sinkResultUtf8, "utf8") !== core.sinkResultUtf8ByteLength ||
		detachedUtf8Sha256Ref(core.sinkResultUtf8) !== core.sinkResultUtf8Sha256 ||
		member.memberSha256 !== detachedTupleSha256Ref(detachedMemberCoreTuple(member))
	)
		return false;
	const sinkDerivation = {
		namespace: "parent_delivery" as const,
		namespaceId: parentDeliveryNamespaceId,
		domain: "detached_sink_enqueue" as const,
		selector: {
			kind: "key" as const,
			keyUtf8: JSON.stringify([
				"omp-transient-task-parent-delivery-selector-v1",
				"detached-sink-enqueue",
				1,
				core.identity.identitySha256,
			]),
		},
		selectorBinding: { identitySha256: core.identity.identitySha256 },
	};
	if (deriveTransientTaskEffectOperationIdV1(sinkDerivation) !== core.sinkOperationId) return false;
	const outboxDerivation = {
		namespace: "parent_delivery" as const,
		namespaceId: parentDeliveryNamespaceId,
		domain: "detached_session_outbox" as const,
		selector: {
			kind: "key" as const,
			keyUtf8: JSON.stringify([
				"omp-transient-task-parent-delivery-selector-v1",
				"detached-session-outbox",
				1,
				core.identity.identitySha256,
				core.sinkOperationId,
			]),
		},
		selectorBinding: { identitySha256: core.identity.identitySha256, sinkOperationId: core.sinkOperationId },
	};
	return deriveTransientTaskEffectOperationIdV1(outboxDerivation) === core.outboxOperationId;
}

function validDetachedPrimaryMessage(
	input: unknown,
): input is ConfidentialTransientTaskDetachedPrimarySessionMessageV1 {
	if (
		!detachedStrictRecord(input, [
			"role",
			"customType",
			"content",
			"display",
			"attribution",
			"details",
			"timestamp",
		]) ||
		input.role !== "custom" ||
		input.customType !== "async-result" ||
		!detachedString(input.content, true) ||
		input.display !== true ||
		input.attribution !== "agent" ||
		!detachedStrictRecord(input.details, ["jobs"]) ||
		!detachedStrictArray(input.details.jobs) ||
		input.details.jobs.length === 0 ||
		!input.details.jobs.every(validDetachedJobMetadata) ||
		!detachedInteger(input.timestamp)
	)
		return false;
	return true;
}

function validDetachedPrepareRequest(
	input: unknown,
): input is ConfidentialTransientTaskDetachedPrimarySessionAppendPlanPrepareRequestV1 {
	if (
		!detachedStrictRecord(input, [
			"schemaVersion",
			"parentDeliveryNamespaceId",
			"primarySessionId",
			"primarySessionGenerationSha256",
			"primaryBranchGenerationSha256",
			"primaryBranchAnchorEntryId",
			"appendParentEntryId",
			"orderedOutboxMembers",
			"primarySessionMessage",
			"primarySessionMessageJsonUtf8",
			"primarySessionMessageJsonUtf8Sha256",
			"primarySessionMessageJsonUtf8ByteLength",
			"primarySessionEntryTimestamp",
			"preparedAt",
			"primaryAppendBatchKeySha256",
		]) ||
		input.schemaVersion !== 1 ||
		!detachedIdentity(input.parentDeliveryNamespaceId) ||
		!detachedIdentity(input.primarySessionId) ||
		!detachedSha256Ref(input.primarySessionGenerationSha256) ||
		!detachedSha256Ref(input.primaryBranchGenerationSha256) ||
		(input.primaryBranchAnchorEntryId !== null && !detachedIdentity(input.primaryBranchAnchorEntryId)) ||
		(input.appendParentEntryId !== null && !detachedIdentity(input.appendParentEntryId)) ||
		!detachedStrictArray(input.orderedOutboxMembers) ||
		input.orderedOutboxMembers.length === 0 ||
		!validDetachedPrimaryMessage(input.primarySessionMessage) ||
		!detachedString(input.primarySessionMessageJsonUtf8, true) ||
		!detachedSha256Ref(input.primarySessionMessageJsonUtf8Sha256) ||
		!detachedInteger(input.primarySessionMessageJsonUtf8ByteLength) ||
		!detachedIso8601(input.primarySessionEntryTimestamp) ||
		!detachedIso8601(input.preparedAt) ||
		!detachedSha256Ref(input.primaryAppendBatchKeySha256)
	)
		return false;
	const request = input as unknown as ConfidentialTransientTaskDetachedPrimarySessionAppendPlanPrepareRequestV1;
	if (!request.orderedOutboxMembers.every(member => validDetachedMember(member, request.parentDeliveryNamespaceId)))
		return false;
	const memberDigests = request.orderedOutboxMembers.map(member => member.memberSha256);
	if (new Set(memberDigests).size !== memberDigests.length) return false;
	const messageBytes = Buffer.from(request.primarySessionMessageJsonUtf8, "utf8");
	if (
		messageBytes.byteLength !== request.primarySessionMessageJsonUtf8ByteLength ||
		detachedUtf8Sha256Ref(request.primarySessionMessageJsonUtf8) !== request.primarySessionMessageJsonUtf8Sha256 ||
		JSON.stringify(request.primarySessionMessage) !== request.primarySessionMessageJsonUtf8 ||
		request.primaryAppendBatchKeySha256 !== detachedTupleSha256Ref(detachedBatchKeyTuple(request)) ||
		!detachedExactJson(
			request.primarySessionMessage.details.jobs,
			request.orderedOutboxMembers.map(member => member.core.jobMetadata),
		)
	)
		return false;
	const built = buildAsyncResultBatchMessage(
		request.orderedOutboxMembers.map(
			(member): AsyncResultEntry => ({
				jobId: member.core.jobMetadata.jobId,
				result: member.core.sinkResultUtf8,
				job: {
					type: "task",
					label: member.core.jobMetadata.label,
				} as AsyncResultEntry["job"],
				durationMs: member.core.jobMetadata.durationMs,
				epoch: 0,
			}),
		),
	);
	return Boolean(
		built &&
			built.role === request.primarySessionMessage.role &&
			built.customType === request.primarySessionMessage.customType &&
			built.content === request.primarySessionMessage.content &&
			built.display === request.primarySessionMessage.display &&
			built.attribution === request.primarySessionMessage.attribution &&
			detachedExactJson(built.details, request.primarySessionMessage.details),
	);
}

function detachedPrepareRequestFromBundle(
	plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1,
	orderedOutboxReceipts: readonly [
		ConfidentialTransientTaskDetachedSessionOutboxReceiptV1,
		...ConfidentialTransientTaskDetachedSessionOutboxReceiptV1[],
	],
): ConfidentialTransientTaskDetachedPrimarySessionAppendPlanPrepareRequestV1 {
	return {
		schemaVersion: 1,
		parentDeliveryNamespaceId: plan.operationIdentityDerivationDescriptor.derivation.namespaceId,
		primarySessionId: plan.primarySessionId,
		primarySessionGenerationSha256: plan.primarySessionGenerationSha256,
		primaryBranchGenerationSha256: plan.primaryBranchGenerationSha256,
		primaryBranchAnchorEntryId: plan.primaryBranchAnchorEntryId,
		appendParentEntryId: plan.appendParentEntryId,
		orderedOutboxMembers: orderedOutboxReceipts.map(receipt => receipt.member) as [
			ConfidentialTransientTaskDetachedSessionOutboxMemberV1,
			...ConfidentialTransientTaskDetachedSessionOutboxMemberV1[],
		],
		primarySessionMessage: plan.primarySessionMessage,
		primarySessionMessageJsonUtf8: plan.primarySessionMessageJsonUtf8,
		primarySessionMessageJsonUtf8Sha256: plan.primarySessionMessageJsonUtf8Sha256,
		primarySessionMessageJsonUtf8ByteLength: plan.primarySessionMessageJsonUtf8ByteLength,
		primarySessionEntryTimestamp: plan.primarySessionEntry.timestamp,
		preparedAt: plan.preparedAt,
		primaryAppendBatchKeySha256: plan.primaryAppendBatchKeySha256,
	};
}

function buildDetachedPlan(
	request: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanPrepareRequestV1,
	primarySessionEntryId: string,
	primarySessionEntryJsonlUtf8: string,
): ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1 {
	const orderedOutboxMemberSha256s = request.orderedOutboxMembers.map(member => member.memberSha256) as [
		Sha256Ref,
		...Sha256Ref[],
	];
	const primarySessionEntry = {
		type: "message" as const,
		id: primarySessionEntryId,
		parentId: request.appendParentEntryId,
		timestamp: request.primarySessionEntryTimestamp,
		message: request.primarySessionMessage,
	};
	const selectorBinding = {
		primarySessionId: request.primarySessionId,
		primarySessionGenerationSha256: request.primarySessionGenerationSha256,
		primaryBranchGenerationSha256: request.primaryBranchGenerationSha256,
		primaryBranchAnchorEntryId: request.primaryBranchAnchorEntryId,
		appendParentEntryId: request.appendParentEntryId,
		primarySessionEntryId,
		orderedOutboxMemberSha256s,
	};
	const derivation = {
		namespace: "parent_delivery" as const,
		namespaceId: request.parentDeliveryNamespaceId,
		domain: "detached_primary_session_persistence" as const,
		selector: { kind: "key" as const, keyUtf8: detachedPrimarySelectorKey(selectorBinding) },
		selectorBinding,
	};
	const descriptorCore = { schemaVersion: 1 as const, derivation };
	const operationIdentityDerivationDescriptor = {
		...descriptorCore,
		descriptorSha256: detachedTupleSha256Ref([
			"omp-transient-task-effect-identity-v1",
			"parent-delivery-descriptor",
			1,
			detachedDerivationTuple(derivation),
			selectorBinding,
		]),
	};
	const core = {
		schemaVersion: 1 as const,
		preparationRequestSha256: detachedTupleSha256Ref(detachedPrepareRequestTuple(request)),
		primaryAppendBatchKeySha256: request.primaryAppendBatchKeySha256,
		primaryAppendOperationId: deriveTransientTaskEffectOperationIdV1(derivation),
		operationIdentityDerivationDescriptor,
		primarySessionId: request.primarySessionId,
		primarySessionGenerationSha256: request.primarySessionGenerationSha256,
		primaryBranchGenerationSha256: request.primaryBranchGenerationSha256,
		primaryBranchAnchorEntryId: request.primaryBranchAnchorEntryId,
		appendParentEntryId: request.appendParentEntryId,
		primarySessionEntryId,
		orderedOutboxMemberSha256s,
		primarySessionMessage: request.primarySessionMessage,
		primarySessionMessageJsonUtf8: request.primarySessionMessageJsonUtf8,
		primarySessionMessageJsonUtf8Sha256: request.primarySessionMessageJsonUtf8Sha256,
		primarySessionMessageJsonUtf8ByteLength: request.primarySessionMessageJsonUtf8ByteLength,
		primarySessionEntry,
		primarySessionEntryJsonlUtf8,
		primarySessionEntryJsonlUtf8Sha256: detachedUtf8Sha256Ref(primarySessionEntryJsonlUtf8),
		primarySessionEntryJsonlUtf8ByteLength: Buffer.byteLength(primarySessionEntryJsonlUtf8, "utf8"),
		preparedAt: request.preparedAt,
	};
	return {
		...core,
		primaryAppendPlanSha256: detachedTupleSha256Ref(detachedPlanTuple(core)),
	};
}

function buildDetachedOutboxReceipts(
	request: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanPrepareRequestV1,
	plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1,
): readonly [
	ConfidentialTransientTaskDetachedSessionOutboxReceiptV1,
	...ConfidentialTransientTaskDetachedSessionOutboxReceiptV1[],
] {
	const count = request.orderedOutboxMembers.length;
	return request.orderedOutboxMembers.map((member, index) => {
		const core = {
			schemaVersion: 1 as const,
			member,
			primaryAppendBatchKeySha256: plan.primaryAppendBatchKeySha256,
			primaryAppendPlanSha256: plan.primaryAppendPlanSha256,
			primaryAppendMemberIndex: index,
			primaryAppendMemberCount: count,
			persistedAt: request.preparedAt,
		};
		return {
			...core,
			receiptSha256: detachedTupleSha256Ref(detachedOutboxReceiptTuple(core)),
		};
	}) as [
		ConfidentialTransientTaskDetachedSessionOutboxReceiptV1,
		...ConfidentialTransientTaskDetachedSessionOutboxReceiptV1[],
	];
}

function buildDetachedPersistenceReceipt(
	plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1,
	orderedOutboxReceipts: readonly [
		ConfidentialTransientTaskDetachedSessionOutboxReceiptV1,
		...ConfidentialTransientTaskDetachedSessionOutboxReceiptV1[],
	],
	primaryAppendRequestSha256: Sha256Ref,
): ConfidentialTransientTaskDetachedPrimarySessionPersistenceReceiptV1 {
	const core = {
		schemaVersion: 1 as const,
		primaryAppendOperationId: plan.primaryAppendOperationId,
		primaryAppendBatchKeySha256: plan.primaryAppendBatchKeySha256,
		primaryAppendPlanSha256: plan.primaryAppendPlanSha256,
		orderedOutboxReceiptSha256s: orderedOutboxReceipts.map(receipt => receipt.receiptSha256) as [
			Sha256Ref,
			...Sha256Ref[],
		],
		primarySessionId: plan.primarySessionId,
		primarySessionGenerationSha256: plan.primarySessionGenerationSha256,
		primaryBranchGenerationSha256: plan.primaryBranchGenerationSha256,
		primaryBranchAnchorEntryId: plan.primaryBranchAnchorEntryId,
		appendParentEntryId: plan.appendParentEntryId,
		primarySessionEntryId: plan.primarySessionEntryId,
		primarySessionEntryJsonlUtf8Sha256: plan.primarySessionEntryJsonlUtf8Sha256,
		primarySessionEntryJsonlUtf8ByteLength: plan.primarySessionEntryJsonlUtf8ByteLength,
		primaryAppendRequestSha256,
	};
	return {
		...core,
		receiptSha256: detachedTupleSha256Ref(detachedPersistenceReceiptTuple(core)),
	};
}

function buildDetachedAbsenceProof(
	plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1,
	observedCurrentLeafEntryId: string | null,
): ConfidentialTransientTaskDetachedPrimarySessionAppendAbsenceProofV1 {
	const core = {
		schemaVersion: 1 as const,
		primaryAppendOperationId: plan.primaryAppendOperationId,
		primaryAppendPlanSha256: plan.primaryAppendPlanSha256,
		primarySessionId: plan.primarySessionId,
		primarySessionGenerationSha256: plan.primarySessionGenerationSha256,
		primaryBranchGenerationSha256: plan.primaryBranchGenerationSha256,
		primaryBranchAnchorEntryId: plan.primaryBranchAnchorEntryId,
		appendParentEntryId: plan.appendParentEntryId,
		primarySessionEntryId: plan.primarySessionEntryId,
		expectedPrimarySessionEntryJsonlUtf8Sha256: plan.primarySessionEntryJsonlUtf8Sha256,
		observedCurrentLeafEntryId,
	};
	return {
		...core,
		proofSha256: detachedTupleSha256Ref(
			detachedAbsenceProofTuple(core as ConfidentialTransientTaskDetachedPrimarySessionAppendAbsenceProofV1),
		),
	};
}

function validDetachedPlanBundle(
	planInput: unknown,
	receiptsInput: unknown,
): planInput is ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1 {
	if (
		!detachedStrictRecord(planInput, [
			"schemaVersion",
			"preparationRequestSha256",
			"primaryAppendBatchKeySha256",
			"primaryAppendOperationId",
			"operationIdentityDerivationDescriptor",
			"primarySessionId",
			"primarySessionGenerationSha256",
			"primaryBranchGenerationSha256",
			"primaryBranchAnchorEntryId",
			"appendParentEntryId",
			"primarySessionEntryId",
			"orderedOutboxMemberSha256s",
			"primarySessionMessage",
			"primarySessionMessageJsonUtf8",
			"primarySessionMessageJsonUtf8Sha256",
			"primarySessionMessageJsonUtf8ByteLength",
			"primarySessionEntry",
			"primarySessionEntryJsonlUtf8",
			"primarySessionEntryJsonlUtf8Sha256",
			"primarySessionEntryJsonlUtf8ByteLength",
			"preparedAt",
			"primaryAppendPlanSha256",
		]) ||
		planInput.schemaVersion !== 1 ||
		!detachedSha256Ref(planInput.preparationRequestSha256) ||
		!detachedSha256Ref(planInput.primaryAppendBatchKeySha256) ||
		!detachedIdentity(planInput.primaryAppendOperationId) ||
		!detachedIdentity(planInput.primarySessionId) ||
		!detachedSha256Ref(planInput.primarySessionGenerationSha256) ||
		!detachedSha256Ref(planInput.primaryBranchGenerationSha256) ||
		(planInput.primaryBranchAnchorEntryId !== null && !detachedIdentity(planInput.primaryBranchAnchorEntryId)) ||
		(planInput.appendParentEntryId !== null && !detachedIdentity(planInput.appendParentEntryId)) ||
		!detachedIdentity(planInput.primarySessionEntryId) ||
		!detachedStrictArray(planInput.orderedOutboxMemberSha256s) ||
		planInput.orderedOutboxMemberSha256s.length === 0 ||
		!planInput.orderedOutboxMemberSha256s.every(detachedSha256Ref) ||
		new Set(planInput.orderedOutboxMemberSha256s).size !== planInput.orderedOutboxMemberSha256s.length ||
		!validDetachedPrimaryMessage(planInput.primarySessionMessage) ||
		!detachedString(planInput.primarySessionMessageJsonUtf8, true) ||
		!detachedSha256Ref(planInput.primarySessionMessageJsonUtf8Sha256) ||
		!detachedInteger(planInput.primarySessionMessageJsonUtf8ByteLength) ||
		!detachedStrictRecord(planInput.primarySessionEntry, ["type", "id", "parentId", "timestamp", "message"]) ||
		planInput.primarySessionEntry.type !== "message" ||
		planInput.primarySessionEntry.id !== planInput.primarySessionEntryId ||
		planInput.primarySessionEntry.parentId !== planInput.appendParentEntryId ||
		!detachedIso8601(planInput.primarySessionEntry.timestamp) ||
		!detachedExactJson(planInput.primarySessionEntry.message, planInput.primarySessionMessage) ||
		!detachedString(planInput.primarySessionEntryJsonlUtf8) ||
		!planInput.primarySessionEntryJsonlUtf8.endsWith("\n") ||
		!detachedSha256Ref(planInput.primarySessionEntryJsonlUtf8Sha256) ||
		!detachedInteger(planInput.primarySessionEntryJsonlUtf8ByteLength, 1) ||
		!detachedIso8601(planInput.preparedAt) ||
		!detachedSha256Ref(planInput.primaryAppendPlanSha256) ||
		!detachedStrictRecord(planInput.operationIdentityDerivationDescriptor, [
			"schemaVersion",
			"derivation",
			"descriptorSha256",
		]) ||
		planInput.operationIdentityDerivationDescriptor.schemaVersion !== 1 ||
		!detachedSha256Ref(planInput.operationIdentityDerivationDescriptor.descriptorSha256) ||
		!detachedStrictRecord(planInput.operationIdentityDerivationDescriptor.derivation, [
			"namespace",
			"namespaceId",
			"domain",
			"selector",
			"selectorBinding",
		]) ||
		planInput.operationIdentityDerivationDescriptor.derivation.namespace !== "parent_delivery" ||
		!detachedIdentity(planInput.operationIdentityDerivationDescriptor.derivation.namespaceId) ||
		planInput.operationIdentityDerivationDescriptor.derivation.domain !== "detached_primary_session_persistence" ||
		!detachedStrictRecord(planInput.operationIdentityDerivationDescriptor.derivation.selector, ["kind", "keyUtf8"]) ||
		planInput.operationIdentityDerivationDescriptor.derivation.selector.kind !== "key" ||
		!detachedString(planInput.operationIdentityDerivationDescriptor.derivation.selector.keyUtf8) ||
		!detachedStrictRecord(planInput.operationIdentityDerivationDescriptor.derivation.selectorBinding, [
			"primarySessionId",
			"primarySessionGenerationSha256",
			"primaryBranchGenerationSha256",
			"primaryBranchAnchorEntryId",
			"appendParentEntryId",
			"primarySessionEntryId",
			"orderedOutboxMemberSha256s",
		]) ||
		!detachedStrictArray(receiptsInput) ||
		receiptsInput.length === 0
	)
		return false;
	const plan = planInput as unknown as ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1;
	const receipts = receiptsInput as unknown as [
		ConfidentialTransientTaskDetachedSessionOutboxReceiptV1,
		...ConfidentialTransientTaskDetachedSessionOutboxReceiptV1[],
	];
	const request = detachedPrepareRequestFromBundle(plan, receipts);
	if (!validDetachedPrepareRequest(request)) return false;
	const expectedPlan = buildDetachedPlan(request, plan.primarySessionEntryId, plan.primarySessionEntryJsonlUtf8);
	if (!detachedExactJson(expectedPlan, plan)) return false;
	const expectedReceipts = buildDetachedOutboxReceipts(request, expectedPlan);
	return detachedExactJson(expectedReceipts, receipts);
}

function validDetachedAppendRequest(
	input: unknown,
): input is ConfidentialTransientTaskDetachedPrimarySessionAppendRequestV1 {
	if (
		!detachedStrictRecord(input, ["plan", "orderedOutboxReceipts", "primaryAppendRequestSha256"]) ||
		!detachedSha256Ref(input.primaryAppendRequestSha256) ||
		!validDetachedPlanBundle(input.plan, input.orderedOutboxReceipts)
	)
		return false;
	const request = input as unknown as ConfidentialTransientTaskDetachedPrimarySessionAppendRequestV1;
	return (
		request.primaryAppendRequestSha256 ===
		detachedControllerDigest("primary-session-append-request", {
			plan: request.plan,
			orderedOutboxReceipts: request.orderedOutboxReceipts,
		})
	);
}

function validDetachedPersistenceReceipt(
	input: unknown,
	state: DetachedPrimaryAppendRuntimeStateV1,
	primaryAppendRequestSha256: Sha256Ref,
): input is ConfidentialTransientTaskDetachedPrimarySessionPersistenceReceiptV1 {
	if (
		!detachedStrictRecord(input, [
			"schemaVersion",
			"primaryAppendOperationId",
			"primaryAppendBatchKeySha256",
			"primaryAppendPlanSha256",
			"orderedOutboxReceiptSha256s",
			"primarySessionId",
			"primarySessionGenerationSha256",
			"primaryBranchGenerationSha256",
			"primaryBranchAnchorEntryId",
			"appendParentEntryId",
			"primarySessionEntryId",
			"primarySessionEntryJsonlUtf8Sha256",
			"primarySessionEntryJsonlUtf8ByteLength",
			"primaryAppendRequestSha256",
			"receiptSha256",
		]) ||
		input.schemaVersion !== 1 ||
		!detachedSha256Ref(input.receiptSha256)
	)
		return false;
	return detachedExactJson(
		input,
		buildDetachedPersistenceReceipt(state.plan, state.orderedOutboxReceipts, primaryAppendRequestSha256),
	);
}

function validDetachedAbsenceProof(
	input: unknown,
	plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1,
): input is ConfidentialTransientTaskDetachedPrimarySessionAppendAbsenceProofV1 {
	if (
		!detachedStrictRecord(input, [
			"schemaVersion",
			"primaryAppendOperationId",
			"primaryAppendPlanSha256",
			"primarySessionId",
			"primarySessionGenerationSha256",
			"primaryBranchGenerationSha256",
			"primaryBranchAnchorEntryId",
			"appendParentEntryId",
			"primarySessionEntryId",
			"expectedPrimarySessionEntryJsonlUtf8Sha256",
			"observedCurrentLeafEntryId",
			"proofSha256",
		]) ||
		input.schemaVersion !== 1 ||
		(input.observedCurrentLeafEntryId !== null && !detachedIdentity(input.observedCurrentLeafEntryId)) ||
		!detachedSha256Ref(input.proofSha256)
	)
		return false;
	return detachedExactJson(input, buildDetachedAbsenceProof(plan, input.observedCurrentLeafEntryId as string | null));
}

function validDetachedInspectRequest(
	input: unknown,
): input is ConfidentialTransientTaskDetachedPrimarySessionAppendInspectRequestV1 {
	if (
		!detachedStrictRecord(input, ["plan", "expectedPrimaryAppendRequestSha256", "inspectRequestSha256"]) ||
		!detachedSha256Ref(input.expectedPrimaryAppendRequestSha256) ||
		!detachedSha256Ref(input.inspectRequestSha256)
	)
		return false;
	const request = input as unknown as ConfidentialTransientTaskDetachedPrimarySessionAppendInspectRequestV1;
	return (
		request.inspectRequestSha256 ===
		detachedControllerDigest("primary-session-append-inspect-request", {
			plan: request.plan,
			expectedPrimaryAppendRequestSha256: request.expectedPrimaryAppendRequestSha256,
		})
	);
}

function validDetachedAdoptRequest(
	input: unknown,
): input is ConfidentialTransientTaskDetachedPrimarySessionAppendAdoptRequestV1 {
	if (
		!detachedStrictRecord(input, [
			"plan",
			"expectedPrimaryAppendRequestSha256",
			"expectedInspectionSha256",
			"currentPrimarySessionId",
			"currentPrimarySessionGenerationSha256",
			"currentPrimaryBranchGenerationSha256",
			"currentPrimaryBranchAnchorEntryId",
			"currentLeafEntryId",
			"adoptRequestSha256",
		]) ||
		!detachedSha256Ref(input.expectedPrimaryAppendRequestSha256) ||
		!detachedSha256Ref(input.expectedInspectionSha256) ||
		!detachedIdentity(input.currentPrimarySessionId) ||
		!detachedSha256Ref(input.currentPrimarySessionGenerationSha256) ||
		!detachedSha256Ref(input.currentPrimaryBranchGenerationSha256) ||
		(input.currentPrimaryBranchAnchorEntryId !== null &&
			!detachedIdentity(input.currentPrimaryBranchAnchorEntryId)) ||
		(input.currentLeafEntryId !== null && !detachedIdentity(input.currentLeafEntryId)) ||
		!detachedSha256Ref(input.adoptRequestSha256)
	)
		return false;
	const request = input as unknown as ConfidentialTransientTaskDetachedPrimarySessionAppendAdoptRequestV1;
	return (
		request.adoptRequestSha256 ===
		detachedControllerDigest("primary-session-append-adopt-request", {
			plan: request.plan,
			expectedPrimaryAppendRequestSha256: request.expectedPrimaryAppendRequestSha256,
			expectedInspectionSha256: request.expectedInspectionSha256,
			currentPrimarySessionId: request.currentPrimarySessionId,
			currentPrimarySessionGenerationSha256: request.currentPrimarySessionGenerationSha256,
			currentPrimaryBranchGenerationSha256: request.currentPrimaryBranchGenerationSha256,
			currentPrimaryBranchAnchorEntryId: request.currentPrimaryBranchAnchorEntryId,
			currentLeafEntryId: request.currentLeafEntryId,
		})
	);
}

function validDetachedPendingEnumerateRequest(
	input: unknown,
): input is ConfidentialTransientTaskDetachedPrimarySessionPendingPlanEnumerateRequestV1 {
	return Boolean(
		detachedStrictRecord(input, [
			"primarySessionId",
			"primarySessionGenerationSha256",
			"primaryBranchGenerationSha256",
			"primaryBranchAnchorEntryId",
			"currentLeafEntryId",
		]) &&
			detachedIdentity(input.primarySessionId) &&
			detachedSha256Ref(input.primarySessionGenerationSha256) &&
			detachedSha256Ref(input.primaryBranchGenerationSha256) &&
			(input.primaryBranchAnchorEntryId === null || detachedIdentity(input.primaryBranchAnchorEntryId)) &&
			(input.currentLeafEntryId === null || detachedIdentity(input.currentLeafEntryId)),
	);
}

function mintSessionId(): string {
	return Bun.randomUUIDv7();
}

function nowIso(): string {
	return new Date().toISOString();
}

function fileSafeTimestamp(iso: string): string {
	return iso.replace(/[:.]/g, "-");
}

function artifactsDirectoryFor(sessionFile: string | undefined): string | null {
	return sessionFile ? sessionFile.slice(0, -JSONL_SUFFIX_LENGTH) : null;
}

function journalDescriptorForSession(
	descriptor: SessionJournalStreamDescriptorV1,
	sessionId: string,
): SessionJournalStreamDescriptorV1 {
	const streamId = `session:${sessionId}` as const;
	if (descriptor.kind === "advisor") {
		return Object.freeze({
			schemaVersion: 1,
			streamId,
			sessionId,
			kind: "advisor",
			parentStreamId: descriptor.parentStreamId,
			advisorId: descriptor.advisorId,
		});
	}
	return Object.freeze({
		schemaVersion: 1,
		streamId,
		sessionId,
		kind: descriptor.kind,
		ownerAgentId: descriptor.ownerAgentId,
		...(descriptor.parentStreamId ? { parentStreamId: descriptor.parentStreamId } : {}),
	});
}

/**
 * Resolve a breadcrumb's recorded session file to its interactive root. Subagent
 * (and other artifact) sessions live inside a parent session's artifacts dir —
 * `<parent>.jsonl` strips its suffix to `<parent>/`, and a child writes
 * `<parent>/<agentId>.jsonl`. A breadcrumb that points at such a child — a
 * pre-fix poisoned crumb left by a subagent that opened in the parent's TTY, or
 * any nested artifact — must resolve back up to the top-level session so
 * `--continue` resumes the real conversation instead of a subagent transcript.
 */
function resolveBreadcrumbToInteractiveRoot(sessionFile: string): string {
	let current = path.resolve(sessionFile);
	// Walk up while the containing dir is itself a session's artifacts dir
	// (`<dir>.jsonl` exists). Capped to defend against pathological layouts.
	for (let depth = 0; depth < 8; depth++) {
		const parentSessionFile = `${path.dirname(current)}.jsonl`;
		if (!fs.existsSync(parentSessionFile)) return current;
		current = parentSessionFile;
	}
	return current;
}

function emptyUsageStatistics(): UsageStatistics {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 0,
		cost: 0,
	};
}

function taskUsageFrom(details: unknown): Usage | undefined {
	if (details === null || typeof details !== "object") return undefined;
	const maybeUsage = (details as Record<string, unknown>).usage;
	return maybeUsage !== null && typeof maybeUsage === "object" ? (maybeUsage as Usage) : undefined;
}

function entryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "assistant") return message.usage;
	if (message.role === "toolResult" && message.toolName === "task") return taskUsageFrom(message.details);
	return undefined;
}

function addUsage(target: UsageStatistics, usage: Usage | undefined): void {
	if (!usage) return;
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.orchestrationInput += usage.orchestration?.input ?? 0;
	target.orchestrationOutput += usage.orchestration?.output ?? 0;
	target.orchestrationCacheRead += usage.orchestration?.cacheRead ?? 0;
	target.premiumRequests += usage.premiumRequests ?? 0;
	target.cost += usage.cost.total;
}

function isAssistantEntry(entry: SessionEntry): boolean {
	return entry.type === "message" && entry.message.role === "assistant";
}

function isDraftOnlyMetadataEntry(entry: SessionEntry): boolean {
	// Startup-recorded selector state that does not survive as user intent
	// once the draft is cleared. `mode_change` covers the `plan.defaultOnStartup`
	// path (interactive-mode.ts enters plan mode before draft restoration) and
	// `/plan` toggles that leave the session otherwise empty; entries carrying
	// real conversation state — messages, compactions, branch summaries,
	// custom/custom_message, session_init, labels, title/tool selection — never
	// reach this branch and always keep the file resumable.
	switch (entry.type) {
		case "model_change":
		case "thinking_level_change":
		case "service_tier_change":
		case "mode_change":
		case "credential_pin":
			return true;
		default:
			return false;
	}
}

function orderedByTimestamp(a: SessionTreeNode, b: SessionTreeNode): number {
	return new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime();
}

/**
 * Maintains the derived views over a session's entry list: id lookup, the
 * parent→children adjacency, the resolved label map, the active leaf, and the
 * running usage totals. Kept in lockstep with the manager's `#entries` so reads
 * stay O(1)/O(children) instead of rescanning the whole journal.
 */
class SessionEntryIndex {
	#entriesById = new Map<string, SessionEntry>();
	#children = new Map<string | null, SessionEntry[]>();
	#labels = new Map<string, string>();
	#leaf: string | null = null;
	#usage = emptyUsageStatistics();

	clear(): void {
		this.#entriesById.clear();
		this.#children.clear();
		this.#labels.clear();
		this.#leaf = null;
		this.#usage = emptyUsageStatistics();
	}

	rebuild(entries: readonly SessionEntry[]): void {
		this.clear();
		for (const entry of entries) this.insert(entry);
	}

	insert(entry: SessionEntry): void {
		this.#entriesById.set(entry.id, entry);
		if (!isSessionManagerSidecarEntry(entry)) this.#leaf = entry.id;

		const bucket = this.#children.get(entry.parentId);
		if (bucket) bucket.push(entry);
		else this.#children.set(entry.parentId, [entry]);

		if (entry.type === "label") {
			if (entry.label) this.#labels.set(entry.targetId, entry.label);
			else this.#labels.delete(entry.targetId);
		}

		addUsage(this.#usage, entryUsage(entry));
	}

	has(id: string): boolean {
		return this.#entriesById.has(id);
	}

	get(id: string): SessionEntry | undefined {
		return this.#entriesById.get(id);
	}

	/**
	 * The live id→entry map. Read-only for callers (lookups + `generateId`
	 * collision checks); never mutate it directly — go through `insert`/`rebuild`.
	 */
	entriesById(): Map<string, SessionEntry> {
		return this.#entriesById;
	}

	leafId(): string | null {
		return this.#leaf;
	}

	leafEntry(): SessionEntry | undefined {
		return this.#leaf ? this.#entriesById.get(this.#leaf) : undefined;
	}

	setLeaf(id: string | null): void {
		this.#leaf = id;
	}

	childrenOf(parentId: string): SessionEntry[] {
		return [...(this.#children.get(parentId) ?? [])];
	}

	labelFor(id: string): string | undefined {
		return this.#labels.get(id);
	}

	labelsInEffect(): IterableIterator<[string, string]> {
		return this.#labels.entries();
	}

	usageSnapshot(): UsageStatistics {
		return { ...this.#usage };
	}

	pathTo(id: string | null | undefined = this.#leaf): SessionEntry[] {
		const branch: SessionEntry[] = [];
		const seen = new Set<string>();
		let cursor = id ? this.#entriesById.get(id) : undefined;

		while (cursor && !seen.has(cursor.id)) {
			seen.add(cursor.id);
			branch.push(cursor);
			cursor = cursor.parentId ? this.#entriesById.get(cursor.parentId) : undefined;
		}
		branch.reverse();
		return branch;
	}

	tree(entries: readonly SessionEntry[]): SessionTreeNode[] {
		const nodes = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		for (const entry of entries) {
			nodes.set(entry.id, { entry, children: [], label: this.#labels.get(entry.id) });
		}

		for (const entry of entries) {
			const node = nodes.get(entry.id)!;
			const parentId = entry.parentId;
			if (parentId === null || parentId === entry.id) {
				roots.push(node);
				continue;
			}

			const parent = nodes.get(parentId);
			if (parent) parent.children.push(node);
			else roots.push(node);
		}

		const stack = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort(orderedByTimestamp);
			stack.push(...node.children);
		}

		return roots;
	}
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getSessionName"
	| "getArtifactsDir"
	| "getArtifactManager"
	| "allocateArtifactPath"
	| "saveArtifact"
	| "getArtifactPath"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getUsageStatistics"
	| "putBlob"
	| "putBlobSync"
>;
export interface SessionManagerStateSnapshot {
	cwd: string;
	sessionDir: string;
	sessionId: string;
	sessionName: string | undefined;
	titleSource: SessionTitleSource | undefined;
	titleUpdatedAt: string;
	sessionFile: string | undefined;
	hasTitleSlot: boolean;
	onDisk: boolean;
	needsRewrite: boolean;
	draftOnlySessionCleanupArmed: boolean;
	header: SessionHeader;
	entries: SessionEntry[];
}

interface DiskQueueOptions {
	ignorePriorError?: boolean;
	ignoreEpoch?: boolean;
	epoch?: number;
}

interface AtomicEntryBatch {
	collecting: boolean;
	entryIds: Set<string>;
	deferredNotifications: SessionEntry[];
	preBatchLeafId: string | null;
	externalLeafChanged: boolean;
	externalLeafId: string | null;
}

/**
 * The storage may have published a write that rejected, and an authoritative
 * repair could not be proven durable. Callers must fail closed until recovery.
 */
export class SessionPersistenceIndeterminateError extends AggregateError {
	readonly operationError: Error;
	readonly recoveryErrors: readonly Error[];

	constructor(operationError: Error, recoveryErrors: readonly Error[]) {
		super(
			[operationError, ...recoveryErrors],
			`Session persistence is indeterminate after "${operationError.message}" and authoritative repair failed.`,
		);
		this.name = "SessionPersistenceIndeterminateError";
		this.operationError = operationError;
		this.recoveryErrors = [...recoveryErrors];
	}
}

interface SessionTransientPersistenceHostV1 {
	readonly persist: boolean;
	readonly storage: SessionStorage;
	readonly blobs: BlobStore;
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly header: SessionHeader;
	readonly entries: SessionEntry[];
	readonly index: SessionEntryIndex;
	readonly writer: SessionStorageWriter | undefined;
	readonly atomicEntryBatch: AtomicEntryBatch | undefined;
	readonly atomicRewriteFenceEpoch: number | null;
	fileIsCurrent: boolean;
	rewriteRequired: boolean;
	readonly sessionFileRelocating: { source: string; dest: string } | null;
	readonly diskFailure: Error | undefined;
	withAtomicPersistenceLock<T>(operation: () => Promise<T>): Promise<T>;
	appendEntriesAtomicallyLocked<T>(append: () => T): Promise<T>;
	appendToSessionFile(entry: SessionEntry): void;
	appendWriter(): SessionStorageWriter;
	noteDiskFailure(errorLike: unknown): Error;
	notifyEntryAppended(entry: SessionEntry): void;
	projectCurrentSession(): CanonicalSessionPersistenceProjection;
	recordEntry(entry: SessionEntry): void;
	authoritativelyRewriteCurrentStateLocked(operationError: Error): Promise<void>;
	submitJournalAppend(entry: CanonicalSessionEntryProjectionV1, primary: PrimarySessionDurabilityReceipt): void;
	resolveTransientTaskJournalGenerationAuthority(
		branchAnchorEntryId: string | null,
	): ConfidentialAgentSessionJournalGenerationAuthorityResultV1;
}

/** Owns transient-task custom-entry projections and their persistence protocols. */
export class SessionTransientPersistenceCoordinatorV1
	implements
		TransientTaskDetachedPrimarySessionAppendBridgeV1,
		TransientTaskForegroundPendingTtsrOverlayStoreV1,
		TransientTaskLifecycleGateStoreV1,
		AgentSessionToolResultPersistenceSerializerV1,
		TransientTaskForegroundSessionAppendBridgeV1,
		TransientTaskForegroundBeforeReturnRecoveryBridgeV1,
		Pick<
			TransientTaskForegroundTtsrOverlaySnapshotAdapterV1,
			"commitForegroundOverlayAfterPrimaryPersistence"
		>
{
	readonly #host: SessionTransientPersistenceHostV1;

	constructor(host: SessionTransientPersistenceHostV1) {
		this.#host = host;
	}

	get #persist(): boolean {
		return this.#host.persist;
	}

	get #storage(): SessionStorage {
		return this.#host.storage;
	}

	get #blobs(): BlobStore {
		return this.#host.blobs;
	}

	get #sessionId(): string {
		return this.#host.sessionId;
	}

	get #sessionFile(): string | undefined {
		return this.#host.sessionFile;
	}

	get #header(): SessionHeader {
		return this.#host.header;
	}

	get #entries(): SessionEntry[] {
		return this.#host.entries;
	}

	get #index(): SessionEntryIndex {
		return this.#host.index;
	}

	get #writer(): SessionStorageWriter | undefined {
		return this.#host.writer;
	}

	get #atomicEntryBatch(): AtomicEntryBatch | undefined {
		return this.#host.atomicEntryBatch;
	}

	get #atomicRewriteFenceEpoch(): number | null {
		return this.#host.atomicRewriteFenceEpoch;
	}

	get #fileIsCurrent(): boolean {
		return this.#host.fileIsCurrent;
	}

	set #fileIsCurrent(value: boolean) {
		this.#host.fileIsCurrent = value;
	}

	get #rewriteRequired(): boolean {
		return this.#host.rewriteRequired;
	}

	set #rewriteRequired(value: boolean) {
		this.#host.rewriteRequired = value;
	}

	get #sessionFileRelocating(): { source: string; dest: string } | null {
		return this.#host.sessionFileRelocating;
	}

	get #diskFailure(): Error | undefined {
		return this.#host.diskFailure;
	}

	#withAtomicPersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
		return this.#host.withAtomicPersistenceLock(operation);
	}

	#appendEntriesAtomicallyLocked<T>(append: () => T): Promise<T> {
		return this.#host.appendEntriesAtomicallyLocked(append);
	}

	#appendToSessionFile(entry: SessionEntry): void {
		this.#host.appendToSessionFile(entry);
	}

	#appendWriter(): SessionStorageWriter {
		return this.#host.appendWriter();
	}

	#noteDiskFailure(errorLike: unknown): Error {
		return this.#host.noteDiskFailure(errorLike);
	}

	#notifyEntryAppended(entry: SessionEntry): void {
		this.#host.notifyEntryAppended(entry);
	}

	#projectCurrentSession(): CanonicalSessionPersistenceProjection {
		return this.#host.projectCurrentSession();
	}

	#recordEntry(entry: SessionEntry): void {
		this.#host.recordEntry(entry);
	}

	#authoritativelyRewriteCurrentStateLocked(operationError: Error): Promise<void> {
		return this.#host.authoritativelyRewriteCurrentStateLocked(operationError);
	}

	#submitJournalAppend(entry: CanonicalSessionEntryProjectionV1, primary: PrimarySessionDurabilityReceipt): void {
		this.#host.submitJournalAppend(entry, primary);
	}

	resolveTransientTaskJournalGenerationAuthority(
		branchAnchorEntryId: string | null,
	): ConfidentialAgentSessionJournalGenerationAuthorityResultV1 {
		return this.#host.resolveTransientTaskJournalGenerationAuthority(branchAnchorEntryId);
	}
	#detachedSessionGenerationSha256(): Sha256Ref {
		return detachedTupleSha256Ref(["omp-agent-session-journal-generation-v1", "session-core", 1, this.#sessionId]);
	}

	#detachedBranchGenerationSha256(branchAnchorEntryId: string | null): Sha256Ref {
		return detachedTupleSha256Ref([
			"omp-agent-session-journal-generation-v1",
			"branch-core",
			1,
			this.#detachedSessionGenerationSha256(),
			branchAnchorEntryId,
		]);
	}

	#transientRuntimeStateProjection(): {
		readonly valid: boolean;
		readonly state: SessionManagerTransientRuntimeStateV1 | null;
	} {
		let previousStateSha256: Sha256Ref | null = null;
		let state: SessionManagerTransientRuntimeStateV1 | null = null;
		for (const entry of this.#entries) {
			if (!isSessionManagerTransientStateEntry(entry)) continue;
			if (!validTransientRuntimeStateSnapshot(entry.data, previousStateSha256)) return { valid: false, state: null };
			state = structuredClone(entry.data);
			previousStateSha256 = state.stateSha256;
		}
		return { valid: true, state };
	}

	#draftTransientRuntimeState(
		current: SessionManagerTransientRuntimeStateV1 | null,
		updatedAt: ISO8601,
	): SessionManagerTransientRuntimeStateV1 {
		if (current === null) return emptyTransientRuntimeState(null, updatedAt);
		const clone = structuredClone(current);
		const core: SessionManagerTransientRuntimeStateCoreV1 = {
			schemaVersion: 1,
			previousStateSha256: current.stateSha256,
			overlays: clone.overlays,
			lifecycleStates: clone.lifecycleStates,
			lifecycleMarkers: clone.lifecycleMarkers,
			lifecycleAdoptions: clone.lifecycleAdoptions,
			lifecycleMarkerAdoptions: clone.lifecycleMarkerAdoptions,
			serializerQueues: clone.serializerQueues,
			serializerAllocations: clone.serializerAllocations,
			primaryCommits: clone.primaryCommits,
			noHandoffCommits: clone.noHandoffCommits,
			injectionAppends: clone.injectionAppends,
			beforeReturnRows: clone.beforeReturnRows,
			foregroundPreallocations: clone.foregroundPreallocations,
			foregroundAppends: clone.foregroundAppends,
			queueInspections: clone.queueInspections,
			queueAdoptions: clone.queueAdoptions,
			primaryAdoptions: clone.primaryAdoptions,
			hubSendAwaitTargetSessionAppends: clone.hubSendAwaitTargetSessionAppends,
			hubSendAwaitTargetDeliveryLedger: clone.hubSendAwaitTargetDeliveryLedger,
			updatedAt,
		};
		return { ...core, stateSha256: transientRuntimeStateDigest(core) };
	}

	#sealTransientRuntimeState(state: SessionManagerTransientRuntimeStateV1): void {
		const core: SessionManagerTransientRuntimeStateCoreV1 = {
			schemaVersion: state.schemaVersion,
			previousStateSha256: state.previousStateSha256,
			overlays: state.overlays,
			lifecycleStates: state.lifecycleStates,
			lifecycleMarkers: state.lifecycleMarkers,
			lifecycleAdoptions: state.lifecycleAdoptions,
			lifecycleMarkerAdoptions: state.lifecycleMarkerAdoptions,
			serializerQueues: state.serializerQueues,
			serializerAllocations: state.serializerAllocations,
			primaryCommits: state.primaryCommits,
			noHandoffCommits: state.noHandoffCommits,
			injectionAppends: state.injectionAppends,
			beforeReturnRows: state.beforeReturnRows,
			foregroundPreallocations: state.foregroundPreallocations,
			foregroundAppends: state.foregroundAppends,
			queueInspections: state.queueInspections,
			queueAdoptions: state.queueAdoptions,
			primaryAdoptions: state.primaryAdoptions,
			hubSendAwaitTargetSessionAppends: state.hubSendAwaitTargetSessionAppends,
			hubSendAwaitTargetDeliveryLedger: state.hubSendAwaitTargetDeliveryLedger,
			updatedAt: state.updatedAt,
		};
		state.stateSha256 = transientRuntimeStateDigest(core);
	}

	#recordTransientRuntimeState(state: SessionManagerTransientRuntimeStateV1): void {
		const entry: CustomEntry = {
			type: "custom",
			customType: TRANSIENT_RUNTIME_STATE_CUSTOM_TYPE,
			data: structuredClone(state),
			id: generateId(this.#index),
			parentId: this.#index.leafId(),
			timestamp: state.updatedAt,
		};
		this.#entries.push(entry);
		this.#index.insert(entry);
		const batch = this.#atomicEntryBatch;
		if (batch?.collecting) batch.entryIds.add(entry.id);
		this.#appendToSessionFile(entry);
	}

	async #commitTransientRuntimeState(state: SessionManagerTransientRuntimeStateV1): Promise<void> {
		this.#sealTransientRuntimeState(state);
		await this.#appendEntriesAtomicallyLocked(() => this.#recordTransientRuntimeState(state));
	}

	#transientAuthorityStatus(
		parentSessionId: string,
		parentSessionGenerationSha256: Sha256Ref,
		branchAnchorEntryId: string | null,
		branchGenerationSha256: Sha256Ref,
	): "matching" | "session_generation_replaced" | "branch_generation_replaced" | "branch_anchor_missing" {
		const authority = this.resolveTransientTaskJournalGenerationAuthority(branchAnchorEntryId);
		if (authority.status === "branch_anchor_missing") return "branch_anchor_missing";
		if (authority.status !== "matching") return "session_generation_replaced";
		if (
			parentSessionId !== authority.authority.sessionGeneration.core.sessionId ||
			parentSessionGenerationSha256 !== authority.authority.sessionGeneration.sessionGenerationSha256
		)
			return "session_generation_replaced";
		if (branchGenerationSha256 !== authority.authority.branchGeneration.branchGenerationSha256)
			return "branch_generation_replaced";
		return "matching";
	}

	#assistantAnchorContainsToolCall(anchorEntryId: string, toolCallId: string): boolean {
		const entry = this.#index.get(anchorEntryId);
		return Boolean(
			entry?.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some(block => block.type === "toolCall" && block.id === toolCallId),
		);
	}

	#exactForegroundMessageEntry(entry: ForegroundSessionAppendRequestV1["entry"]): SessionMessageEntry | null {
		const { providerMetadata, ...messageWithoutProviderMetadata } = entry.message;
		const mutableMessage: ToolResultMessage = {
			...messageWithoutProviderMetadata,
			content: entry.message.content.map(block => ({ ...block })),
			...(providerMetadata
				? {
						providerMetadata: {
							type: "computer" as const,
							screenshot:
								"image_url" in providerMetadata.screenshot
									? { type: "computer_screenshot" as const, image_url: providerMetadata.screenshot.image_url }
									: { type: "computer_screenshot" as const, file_id: providerMetadata.screenshot.file_id },
							acknowledgedSafetyChecks: providerMetadata.acknowledgedSafetyChecks.map(check => ({ ...check })),
						},
					}
				: {}),
		};
		const candidate: SessionMessageEntry = {
			type: "message",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			message: mutableMessage,
		};
		try {
			const projection = projectSessionEntryForPersistence(candidate, this.#entries.length, this.#blobs);
			if (
				projection.canonicalLine !== entry.sessionEntryJsonlUtf8 ||
				detachedUtf8Sha256Ref(projection.canonicalLine) !== entry.sessionEntryJsonlUtf8Sha256 ||
				Buffer.byteLength(projection.canonicalLine, "utf8") !== entry.sessionEntryJsonlUtf8ByteLength
			)
				return null;
			return candidate;
		} catch {
			return null;
		}
	}

	#exactInjectionEntry(entry: ExactInjectionAppendRequestV1["core"]["entry"]): TtsrInjectionEntry | null {
		const candidate: TtsrInjectionEntry = {
			type: "ttsr_injection",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			injectedRules: [entry.injectedRules[0], ...entry.injectedRules.slice(1)],
		};
		try {
			const projection = projectSessionEntryForPersistence(candidate, this.#entries.length, this.#blobs);
			if (
				projection.canonicalLine !== entry.sessionEntryJsonlUtf8 ||
				detachedUtf8Sha256Ref(projection.canonicalLine) !== entry.sessionEntryJsonlUtf8Sha256 ||
				Buffer.byteLength(projection.canonicalLine, "utf8") !== entry.sessionEntryJsonlUtf8ByteLength
			)
				return null;
			return candidate;
		} catch {
			return null;
		}
	}

	#exactOrdinaryMessageEntry(
		entry: OrdinaryAppendRequestV1["core"]["plan"]["core"]["entry"],
	): SessionMessageEntry | null {
		const candidate: SessionMessageEntry = {
			type: "message",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			message: { ...entry.message, content: entry.message.content.map(block => structuredClone(block)) },
		};
		try {
			const projection = projectSessionEntryForPersistence(candidate, this.#entries.length, this.#blobs);
			if (
				projection.canonicalLine !== entry.sessionEntryJsonlUtf8 ||
				detachedUtf8Sha256Ref(projection.canonicalLine) !== entry.sessionEntryJsonlUtf8Sha256 ||
				Buffer.byteLength(projection.canonicalLine, "utf8") !== entry.sessionEntryJsonlUtf8ByteLength
			)
				return null;
			return candidate;
		} catch {
			return null;
		}
	}

	#prepareOrdinaryAppendAtParent(
		appendRequest: OrdinaryAppendRequestV1,
		expectedParentEntryId: string,
		primaryAttemptSha256: Sha256Ref,
		primaryTransitionReceiptSha256: Sha256Ref,
		committedAt: ISO8601,
	):
		| {
				readonly status: "ready";
				readonly candidate: SessionMessageEntry;
				readonly physicalExists: boolean;
				readonly receipt: OrdinaryAppendReceiptV1;
		  }
		| { readonly status: "prior_leaf_conflict" | "entry_conflict" | "invalid" } {
		const plan = appendRequest.core.plan;
		const preallocation = plan.core.entryPreallocationReceipt;
		if (
			appendRequest.requestSha256 !== ordinaryAppendRequestDigest(appendRequest) ||
			plan.planSha256 !== ordinaryAppendPlanDigest(plan) ||
			plan.core.ordinaryPersistence.ordinaryPersistenceRequestSha256 !==
				ordinaryPersistenceDigest(plan.core.ordinaryPersistence) ||
			preallocation.receiptSha256 !== ordinaryEntryPreallocationReceiptDigest(preallocation.core) ||
			plan.core.ticketSha256 !== plan.core.headPermit.core.ticketSha256 ||
			preallocation.core.ticketSha256 !== plan.core.ticketSha256 ||
			preallocation.core.serializerKeySha256 !== plan.core.headPermit.core.serializerKeySha256 ||
			preallocation.core.entryId !== plan.core.entry.id ||
			plan.core.entryTimestamp !== plan.core.entry.timestamp ||
			!detachedExactJson(plan.core.exactToolResultMessage, plan.core.entry.message) ||
			plan.core.entry.parentId !== expectedParentEntryId
		)
			return { status: "invalid" };
		const candidate = this.#exactOrdinaryMessageEntry(plan.core.entry);
		if (!candidate) return { status: "invalid" };
		const physical = this.#index.get(candidate.id);
		if (physical && !detachedExactJson(physical, candidate)) return { status: "entry_conflict" };
		if (!physical && this.#index.leafId() !== expectedParentEntryId) return { status: "prior_leaf_conflict" };
		if (physical && this.#index.leafId() !== candidate.id) return { status: "prior_leaf_conflict" };
		const receiptCore: OrdinaryAppendReceiptV1["core"] = {
			appendRequest,
			primaryAttemptSha256,
			primaryTransitionReceiptSha256,
			plan,
			entry: plan.core.entry,
			nextPriorLeafEntryId: plan.core.entry.id,
			committedAt,
		};
		return {
			status: "ready",
			candidate,
			physicalExists: physical !== undefined,
			receipt: { core: receiptCore, receiptSha256: ordinaryAppendReceiptDigest(receiptCore) },
		};
	}
	#primaryExpectedPhysicalEntry(entry: {
		readonly id: string;
		readonly parentId: string;
		readonly timestamp: ISO8601;
		readonly sessionEntryJsonlUtf8: string;
		readonly sessionEntryJsonlUtf8Sha256: Sha256Ref;
		readonly sessionEntryJsonlUtf8ByteLength: number;
	}): PrimaryExpectedPhysicalEntryV1 {
		return {
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			sessionEntryJsonlUtf8: entry.sessionEntryJsonlUtf8,
			sessionEntryJsonlUtf8Sha256: entry.sessionEntryJsonlUtf8Sha256,
			sessionEntryJsonlUtf8ByteLength: entry.sessionEntryJsonlUtf8ByteLength,
		};
	}

	#primaryRoutePhysicalPlan(request: PrimaryCommitAttemptV1["core"]["request"]): PrimaryRoutePhysicalPlanV1 | null {
		let resultCandidate: SessionMessageEntry | null = null;
		let ordinaryAppendRequest: OrdinaryAppendRequestV1 | null = null;
		if (request.core.route === "task_foreground_delivery") {
			const batch = request.core.foregroundAppendBatch;
			const first = batch.requests[0];
			if (
				!first ||
				batch.appendBatchSha256 !== foregroundResultAppendBatchDigest(batch) ||
				batch.injectionAppendRequest.requestSha256 !== request.core.injectionAppendRequest.requestSha256 ||
				!detachedExactJson(batch.injectionAppendRequest, request.core.injectionAppendRequest) ||
				!validBeforeReturnHandoff(batch.handoffBatch) ||
				batch.handoffBatch.handoffBatchSha256 !== first.handoffBatchSha256 ||
				batch.foregroundAppendBatchKeySha256 !== first.foregroundAppendBatchKeySha256 ||
				batch.renderedResult.renderedResultSha256 !== first.renderedResultSha256 ||
				batch.injectionAppendRequest.requestSha256 !== first.injectionAppendRequestSha256 ||
				!detachedExactJson(batch.entry, first.entry) ||
				batch.requests.length !== batch.handoffBatch.handoffs.length
			)
				return null;
			for (let index = 0; index < batch.requests.length; index++) {
				const member = batch.requests[index];
				const handoff = batch.handoffBatch.handoffs[index];
				if (
					!member ||
					!handoff ||
					member.appendRequestSha256 !== foregroundResultAppendRequestDigest(member) ||
					member.handoffSha256 !== handoff.handoffSha256 ||
					member.handoffBatchSha256 !== batch.handoffBatch.handoffBatchSha256 ||
					member.foregroundAppendBatchKeySha256 !== batch.foregroundAppendBatchKeySha256 ||
					member.renderedResultSha256 !== batch.renderedResult.renderedResultSha256 ||
					member.injectionAppendRequestSha256 !== batch.injectionAppendRequest.requestSha256 ||
					member.preReturnIdentity.preReturnIdentitySha256 !== member.identity.core.preReturnIdentitySha256 ||
					member.identity.identitySha256 !==
						detachedTupleSha256Ref([
							"omp-transient-task-foreground-settlement-v1",
							"result-settlement-identity-core",
							1,
							member.identity.core.preReturnIdentitySha256,
							member.identity.core.sinkProjection,
							member.identity.core.deliveryRequestSha256,
							member.identity.core.deliveryAuthority,
							member.identity.core.deliveryAuthoritySha256,
						]) ||
					!detachedExactJson(member.deliveryAuthority, member.identity.core.deliveryAuthority) ||
					member.identity.core.sinkProjection.projectionSha256 !==
						detachedTupleSha256Ref([
							"omp-transient-task-foreground-settlement-v1",
							"final-sink-projection-core",
							1,
							member.identity.core.sinkProjection.core.preReturnIdentitySha256,
							member.identity.core.sinkProjection.core.renderedResultSha256,
							member.identity.core.sinkProjection.core.sinkResultUtf8,
							member.identity.core.sinkProjection.core.sinkResultUtf8Sha256,
							member.identity.core.sinkProjection.core.sinkResultUtf8ByteLength,
						]) ||
					member.toolResultMessageUtf8 !== JSON.stringify(member.entry.message) ||
					member.toolResultMessageUtf8Sha256 !== detachedUtf8Sha256Ref(member.toolResultMessageUtf8) ||
					member.toolResultMessageUtf8ByteLength !== Buffer.byteLength(member.toolResultMessageUtf8, "utf8") ||
					!detachedExactJson(member.entry, batch.entry)
				)
					return null;
			}
			resultCandidate = this.#exactForegroundMessageEntry(batch.entry);
		} else if (request.core.route === "task_no_handoff_result") {
			const nestedAttempt = request.core.noHandoffAppendAttempt;
			const nestedRequest = nestedAttempt.core.request;
			if (
				nestedAttempt.attemptSha256 !== noHandoffAttemptDigest(nestedAttempt) ||
				nestedRequest.requestSha256 !== noHandoffRequestDigest(nestedRequest) ||
				nestedRequest.core.continuation.continuationSha256 !==
					noHandoffContinuationDigest(nestedRequest.core.continuation)
			)
				return null;
			resultCandidate = this.#exactForegroundMessageEntry(nestedRequest.core.taskResultEntry);
		} else {
			ordinaryAppendRequest = request.core.ordinaryAppendRequest;
			const plan = ordinaryAppendRequest.core.plan;
			if (
				ordinaryAppendRequest.requestSha256 !== ordinaryAppendRequestDigest(ordinaryAppendRequest) ||
				plan.planSha256 !== ordinaryAppendPlanDigest(plan) ||
				plan.core.ordinaryPersistence.ordinaryPersistenceRequestSha256 !==
					ordinaryPersistenceDigest(plan.core.ordinaryPersistence) ||
				plan.core.entryPreallocationReceipt.receiptSha256 !==
					ordinaryEntryPreallocationReceiptDigest(plan.core.entryPreallocationReceipt.core) ||
				plan.core.entryPreallocationReceipt.core.entryId !== plan.core.entry.id ||
				plan.core.entryTimestamp !== plan.core.entry.timestamp ||
				!detachedExactJson(plan.core.exactToolResultMessage, plan.core.entry.message)
			)
				return null;
			resultCandidate = this.#exactOrdinaryMessageEntry(plan.core.entry);
		}
		if (!resultCandidate) return null;
		const resultEntry =
			request.core.route === "task_foreground_delivery"
				? request.core.foregroundAppendBatch.entry
				: request.core.route === "task_no_handoff_result"
					? request.core.noHandoffAppendAttempt.core.request.core.taskResultEntry
					: request.core.ordinaryAppendRequest.core.plan.core.entry;
		const resultExpected = this.#primaryExpectedPhysicalEntry(resultEntry);
		const injectionRequest =
			request.core.route === "task_foreground_delivery" || request.core.route === "hub_wait_message_return"
				? request.core.injectionAppendRequest
				: request.core.route === "task_no_handoff_result"
					? request.core.noHandoffAppendAttempt.core.request.core.injectionAppendRequest
					: null;
		if (
			injectionRequest &&
			(injectionRequest.requestSha256 !== injectionAppendRequestDigest(injectionRequest) ||
				injectionRequest.core.headPermit.permitSha256 !==
					serializerHeadPermitDigest(injectionRequest.core.headPermit.core) ||
				injectionRequest.core.currentPriorLeafEntryId !==
					injectionRequest.core.headPermit.core.currentPriorLeafEntryId ||
				injectionRequest.core.nextTaskResultAppendParentEntryId !==
					(injectionRequest.core.disposition === "exact_entry"
						? injectionRequest.core.entry.id
						: injectionRequest.core.currentPriorLeafEntryId))
		)
			return null;
		if (!injectionRequest || injectionRequest.core.disposition === "no_entry") {
			return { candidates: [resultCandidate], expected: [resultExpected], ordinaryAppendRequest };
		}
		const injectionCandidate = this.#exactInjectionEntry(injectionRequest.core.entry);
		if (!injectionCandidate) return null;
		return {
			candidates: [injectionCandidate, resultCandidate],
			expected: [this.#primaryExpectedPhysicalEntry(injectionRequest.core.entry), resultExpected],
			ordinaryAppendRequest,
		};
	}

	async #resolveInjectionAppendLocked(
		request: InjectionAppendRequestV1,
	): Promise<
		| { readonly status: "committed" | "already_committed"; readonly receipt: InjectionAppendReceiptV1 }
		| { readonly status: "outcome_unknown" | "prior_leaf_conflict" | "entry_conflict" | "invalid" }
	> {
		if (
			request.requestSha256 !== injectionAppendRequestDigest(request) ||
			request.core.headPermit.permitSha256 !== serializerHeadPermitDigest(request.core.headPermit.core) ||
			request.core.currentPriorLeafEntryId !== request.core.headPermit.core.currentPriorLeafEntryId ||
			request.core.nextTaskResultAppendParentEntryId !==
				(request.core.disposition === "exact_entry" ? request.core.entry.id : request.core.currentPriorLeafEntryId)
		)
			return { status: "invalid" };
		let projection = this.#transientRuntimeStateProjection();
		if (!projection.valid) return { status: "invalid" };
		let row = projection.state?.injectionAppends.find(candidate => candidate.requestSha256 === request.requestSha256);
		if (row && !detachedExactJson(row.attempt.core.request, request)) return { status: "entry_conflict" };
		if (row?.status === "committed")
			return row.receipt ? { status: "already_committed", receipt: row.receipt } : { status: "invalid" };
		const attemptCore = { state: "not_applied" as const, request, preparedAt: request.core.requestedAt };
		const attempt = {
			core: attemptCore,
			attemptSha256: injectionAppendAttemptDigest({ core: attemptCore, attemptSha256: request.requestSha256 }),
		};
		if (request.core.disposition === "no_entry") {
			if (this.#index.leafId() !== request.core.currentPriorLeafEntryId) return { status: "prior_leaf_conflict" };
			const receiptCore = {
				disposition: "no_entry" as const,
				requestSha256: request.requestSha256,
				attemptSha256: attempt.attemptSha256,
				transitionReceipt: null,
				entry: null,
				currentPriorLeafEntryId: request.core.currentPriorLeafEntryId,
				nextTaskResultAppendParentEntryId: request.core.nextTaskResultAppendParentEntryId,
				committedAt: request.core.requestedAt,
			};
			const receipt = { core: receiptCore, receiptSha256: injectionAppendReceiptDigest(receiptCore) };
			const state = this.#draftTransientRuntimeState(projection.state, request.core.requestedAt);
			state.injectionAppends.push({
				requestSha256: request.requestSha256,
				attempt,
				status: "committed",
				transitionReceipt: null,
				receipt,
				restoredInspectionSha256: null,
			});
			await this.#commitTransientRuntimeState(state);
			return { status: "committed", receipt };
		}
		const candidate = this.#exactInjectionEntry(request.core.entry);
		if (!candidate || request.core.deterministicEntryId !== candidate.id) return { status: "invalid" };
		if (!row) {
			const transitionCore = {
				attemptSha256: attempt.attemptSha256,
				requestSha256: request.requestSha256,
				priorState: "not_applied" as const,
				nextState: "outcome_unknown" as const,
				transitionedImmediatelyBeforeDispatchAt: request.core.requestedAt,
			};
			const transitionReceipt = {
				core: transitionCore,
				transitionReceiptSha256: injectionAppendTransitionDigest(transitionCore),
			};
			const state = this.#draftTransientRuntimeState(projection.state, request.core.requestedAt);
			state.injectionAppends.push({
				requestSha256: request.requestSha256,
				attempt,
				status: "outcome_unknown",
				transitionReceipt,
				receipt: null,
				restoredInspectionSha256: null,
			});
			await this.#commitTransientRuntimeState(state);
			projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "outcome_unknown" };
			row = projection.state?.injectionAppends.find(
				candidateRow => candidateRow.requestSha256 === request.requestSha256,
			);
		}
		if (!row?.transitionReceipt) return { status: "invalid" };
		const physical = this.#index.get(candidate.id);
		if (physical && !detachedExactJson(physical, candidate)) return { status: "entry_conflict" };
		if (!physical && this.#index.leafId() !== request.core.currentPriorLeafEntryId)
			return { status: "prior_leaf_conflict" };
		if (physical && this.#index.leafId() !== candidate.id) return { status: "prior_leaf_conflict" };
		const receiptCore = {
			disposition: "exact_entry" as const,
			requestSha256: request.requestSha256,
			attemptSha256: row.attempt.attemptSha256,
			transitionReceipt: row.transitionReceipt,
			entry: request.core.entry,
			currentPriorLeafEntryId: request.core.currentPriorLeafEntryId,
			nextTaskResultAppendParentEntryId: request.core.nextTaskResultAppendParentEntryId,
			committedAt: request.core.requestedAt,
		};
		const receipt = { core: receiptCore, receiptSha256: injectionAppendReceiptDigest(receiptCore) };
		const state = this.#draftTransientRuntimeState(projection.state, request.core.requestedAt);
		const stateRow = state.injectionAppends.find(
			candidateRow => candidateRow.requestSha256 === request.requestSha256,
		)!;
		stateRow.status = "committed";
		stateRow.receipt = receipt;
		this.#sealTransientRuntimeState(state);
		await this.#appendEntriesAtomicallyLocked(() => {
			if (!physical) this.#recordEntry(candidate);
			this.#recordTransientRuntimeState(state);
		});
		return { status: "committed", receipt };
	}

	#detachedPlanAuthorityStatus(
		plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1,
		requireAppendParentLeaf: boolean,
	): "matching" | "session_generation_conflict" | "branch_generation_conflict" | "parent_conflict" {
		if (
			!this.#persist ||
			!this.#sessionFile ||
			plan.primarySessionId !== this.#sessionId ||
			plan.primarySessionGenerationSha256 !== this.#detachedSessionGenerationSha256()
		)
			return "session_generation_conflict";
		if (
			plan.primaryBranchGenerationSha256 !== this.#detachedBranchGenerationSha256(plan.primaryBranchAnchorEntryId) ||
			(plan.primaryBranchAnchorEntryId !== null &&
				(!this.#index.has(plan.primaryBranchAnchorEntryId) ||
					isDetachedPrimaryAppendStateEntry(this.#index.get(plan.primaryBranchAnchorEntryId)!)))
		)
			return "branch_generation_conflict";
		if (
			plan.appendParentEntryId !== plan.primaryBranchAnchorEntryId ||
			(plan.appendParentEntryId !== null && !this.#index.has(plan.appendParentEntryId)) ||
			(requireAppendParentLeaf && this.#index.leafId() !== plan.appendParentEntryId)
		)
			return "parent_conflict";
		return "matching";
	}

	#detachedPlanHasCanonicalEntry(plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1): boolean {
		try {
			const projected = projectSessionEntryForPersistence(plan.primarySessionEntry as SessionEntry, 0, this.#blobs);
			return (
				projected.canonicalLine === plan.primarySessionEntryJsonlUtf8 &&
				detachedUtf8Sha256Ref(projected.canonicalLine) === plan.primarySessionEntryJsonlUtf8Sha256 &&
				Buffer.byteLength(projected.canonicalLine, "utf8") === plan.primarySessionEntryJsonlUtf8ByteLength
			);
		} catch {
			return false;
		}
	}

	#detachedStateProjection(): DetachedPrimaryAppendStateProjectionV1 {
		const plans = new Map<Sha256Ref, DetachedPrimaryAppendRuntimeStateV1>();
		const batchKeys = new Map<Sha256Ref, DetachedPrimaryAppendRuntimeStateV1>();
		const memberSha256s = new Map<Sha256Ref, DetachedPrimaryAppendRuntimeStateV1>();
		const invalid = (): DetachedPrimaryAppendStateProjectionV1 => ({
			valid: false,
			plans,
			batchKeys,
			memberSha256s,
		});
		for (const entry of this.#entries) {
			if (!isDetachedPrimaryAppendStateEntry(entry)) continue;
			const data = entry.data;
			if (data === null || typeof data !== "object" || !("state" in data)) return invalid();
			if (data.state === "not_applied") {
				if (
					!detachedStrictRecord(data, ["schemaVersion", "state", "plan", "orderedOutboxReceipts"]) ||
					data.schemaVersion !== 1 ||
					!validDetachedPlanBundle(data.plan, data.orderedOutboxReceipts)
				)
					return invalid();
				const plan = data.plan as ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1;
				const orderedOutboxReceipts = data.orderedOutboxReceipts as [
					ConfidentialTransientTaskDetachedSessionOutboxReceiptV1,
					...ConfidentialTransientTaskDetachedSessionOutboxReceiptV1[],
				];
				if (
					!this.#detachedPlanHasCanonicalEntry(plan) ||
					plans.has(plan.primaryAppendPlanSha256) ||
					batchKeys.has(plan.primaryAppendBatchKeySha256)
				)
					return invalid();
				const state: DetachedPrimaryAppendRuntimeStateV1 = {
					plan,
					orderedOutboxReceipts,
					status: "not_applied",
					primaryAppendRequestSha256: null,
					receipt: null,
					restoredInspectionSha256: null,
				};
				plans.set(plan.primaryAppendPlanSha256, state);
				batchKeys.set(plan.primaryAppendBatchKeySha256, state);
				for (const memberSha256 of plan.orderedOutboxMemberSha256s) {
					if (memberSha256s.has(memberSha256)) return invalid();
					memberSha256s.set(memberSha256, state);
				}
				continue;
			}
			if (data.state === "outcome_unknown") {
				if (
					!detachedStrictRecord(data, [
						"schemaVersion",
						"state",
						"primaryAppendPlanSha256",
						"primaryAppendRequestSha256",
					]) ||
					data.schemaVersion !== 1 ||
					!detachedSha256Ref(data.primaryAppendPlanSha256) ||
					!detachedSha256Ref(data.primaryAppendRequestSha256)
				)
					return invalid();
				const state = plans.get(data.primaryAppendPlanSha256);
				if (state?.status !== "not_applied") return invalid();
				const expected = detachedControllerDigest("primary-session-append-request", {
					plan: state.plan,
					orderedOutboxReceipts: state.orderedOutboxReceipts,
				});
				if (data.primaryAppendRequestSha256 !== expected) return invalid();
				state.status = "outcome_unknown";
				state.primaryAppendRequestSha256 = data.primaryAppendRequestSha256;
				continue;
			}
			if (data.state === "committed") {
				if (
					!detachedStrictRecord(data, ["schemaVersion", "state", "receipt"]) ||
					data.schemaVersion !== 1 ||
					!data.receipt ||
					typeof data.receipt !== "object" ||
					!("primaryAppendPlanSha256" in data.receipt) ||
					!detachedSha256Ref(data.receipt.primaryAppendPlanSha256)
				)
					return invalid();
				const state = plans.get(data.receipt.primaryAppendPlanSha256);
				if (
					state?.status !== "outcome_unknown" ||
					state.primaryAppendRequestSha256 === null ||
					!validDetachedPersistenceReceipt(data.receipt, state, state.primaryAppendRequestSha256)
				)
					return invalid();
				state.status = "committed";
				state.receipt = data.receipt;
				continue;
			}
			if (data.state === "restored_not_applied") {
				if (
					!detachedStrictRecord(data, [
						"schemaVersion",
						"state",
						"primaryAppendPlanSha256",
						"primaryAppendRequestSha256",
						"inspectionSha256",
						"authoritativeAbsenceProof",
					]) ||
					data.schemaVersion !== 1 ||
					!detachedSha256Ref(data.primaryAppendPlanSha256) ||
					!detachedSha256Ref(data.primaryAppendRequestSha256) ||
					!detachedSha256Ref(data.inspectionSha256)
				)
					return invalid();
				const state = plans.get(data.primaryAppendPlanSha256);
				if (
					state?.status !== "outcome_unknown" ||
					state.primaryAppendRequestSha256 !== data.primaryAppendRequestSha256 ||
					state.restoredInspectionSha256 !== null ||
					!validDetachedAbsenceProof(data.authoritativeAbsenceProof, state.plan)
				)
					return invalid();
				const proof = data.authoritativeAbsenceProof;
				const expectedInspection = detachedInspectionSha256(state.plan, data.primaryAppendRequestSha256, [
					"append_outcome_unknown",
					"authoritative_absence",
					detachedPlanTuple(state.plan),
					null,
					detachedAbsenceProofTuple(proof),
				]);
				if (data.inspectionSha256 !== expectedInspection) return invalid();
				state.status = "not_applied";
				state.restoredInspectionSha256 = data.inspectionSha256;
				continue;
			}
			return invalid();
		}
		return { valid: true, plans, batchKeys, memberSha256s };
	}

	#detachedReservedEntryIdView(): { has(id: string): boolean } {
		const state = this.#detachedStateProjection();
		return {
			has: id =>
				this.#index.has(id) ||
				(state.valid &&
					Array.from(state.plans.values()).some(candidate => candidate.plan.primarySessionEntryId === id)),
		};
	}

	#recordDetachedPrimaryState(
		data: DetachedPrimaryAppendStateEntryDataV1,
		plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1,
	): void {
		const entry: CustomEntry = {
			type: "custom",
			customType: DETACHED_PRIMARY_APPEND_STATE_CUSTOM_TYPE,
			data,
			id: generateId(this.#detachedReservedEntryIdView()),
			parentId: plan.appendParentEntryId,
			timestamp: nowIso(),
		};
		this.#entries.push(entry);
		this.#index.insert(entry);
		const batch = this.#atomicEntryBatch;
		if (batch?.collecting) batch.entryIds.add(entry.id);
		this.#appendToSessionFile(entry);
	}

	#insertDetachedPrimaryEntryFromDurable(plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1): boolean {
		const existing = this.#index.get(plan.primarySessionEntryId);
		if (existing) return detachedExactJson(existing, plan.primarySessionEntry);
		const entry = structuredClone(plan.primarySessionEntry) as SessionMessageEntry;
		this.#entries.push(entry);
		this.#index.insert(entry);
		return true;
	}

	async #inspectDetachedPrimaryPhysicalEntry(
		plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1,
	): Promise<"matching" | "absent" | "conflict" | "unknown"> {
		if (!this.#sessionFile) return "unknown";
		try {
			await this.#writer?.flush();
		} catch {
			// A failed exact append may leave the writer latched while its bytes are
			// already durable. Physical inspection must still read the authoritative file.
		}
		try {
			await this.#storage.drain();
			const body = await this.#storage.readText(this.#sessionFile);
			const existing = this.#index.get(plan.primarySessionEntryId);
			if (existing) {
				if (!detachedExactJson(existing, plan.primarySessionEntry)) return "conflict";
				const ordinal = this.#entries.findIndex(entry => entry.id === plan.primarySessionEntryId);
				if (ordinal < 0) return "conflict";
				const projected = projectSessionEntryForPersistence(existing, ordinal, this.#blobs);
				if (projected.canonicalLine !== plan.primarySessionEntryJsonlUtf8) return "conflict";
				return body === this.#projectCurrentSession().canonicalBody ? "matching" : "unknown";
			}
			const currentBody = this.#projectCurrentSession().canonicalBody;
			if (body === currentBody) return "absent";
			return body === `${currentBody}${plan.primarySessionEntryJsonlUtf8}` ? "matching" : "unknown";
		} catch {
			return "unknown";
		}
	}

	async #appendDetachedPrimaryEntry(plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1): Promise<void> {
		if (
			!this.#persist ||
			!this.#sessionFile ||
			!this.#fileIsCurrent ||
			this.#rewriteRequired ||
			this.#sessionFileRelocating ||
			this.#atomicRewriteFenceEpoch !== null ||
			this.#diskFailure
		)
			throw new Error("detached_primary_session_append_not_writable");
		const entry = structuredClone(plan.primarySessionEntry) as SessionMessageEntry;
		const projected = projectSessionEntryForPersistence(entry, this.#entries.length, this.#blobs);
		if (projected.canonicalLine !== plan.primarySessionEntryJsonlUtf8)
			throw new Error("detached_primary_session_append_entry_bytes_mismatch");
		try {
			const writer = this.#appendWriter();
			const committed = writer.append(projected.canonicalLine);
			const durable = (async () => {
				await committed;
				await writer.flush();
				await this.#storage.drain();
			})();
			this.#submitJournalAppend(projected, createPrimarySessionDurabilityReceipt(durable));
			this.#entries.push(entry);
			this.#index.insert(entry);
			this.#fileIsCurrent = true;
			this.#rewriteRequired = false;
			this.#notifyEntryAppended(entry);
			await durable;
		} catch (error) {
			throw this.#noteDiskFailure(error);
		}
	}
	#hubSendAwaitTargetLedgerSha256(ledger: HubSendAwaitTargetDeliveryLedgerRuntimeV1): Sha256Ref {
		return detachedTupleSha256Ref([
			"omp-hub-send-await-outbound-v1",
			"target-delivery-ledger",
			1,
			ledger.incarnationSha256,
			ledger.revision,
			ledger.entries.map(entry => entry.entrySha256),
			ledger.failedObservations.map(request => request.requestSha256),
		]);
	}

	#newHubSendAwaitTargetLedger(): HubSendAwaitTargetDeliveryLedgerRuntimeV1 {
		return {
			incarnationSha256: detachedTupleSha256Ref([
				"omp-hub-send-await-outbound-v1",
				"target-delivery-ledger-incarnation",
				1,
				this.#sessionId,
				this.#detachedSessionGenerationSha256(),
			]),
			revision: 0,
			entries: [],
			failedObservations: [],
		};
	}

	async observeHubSendAwaitTargetDeliveryLedger(input: {
		readonly targetAgentId: string;
		readonly sendOperationId: OperationId;
		readonly messageSha256: Sha256Ref;
		readonly observedAt: ISO8601;
	}): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerPermitV1> {
		if (
			!detachedIdentity(input.targetAgentId) ||
			!detachedIdentity(input.sendOperationId) ||
			!detachedSha256Ref(input.messageSha256) ||
			!detachedIso8601(input.observedAt)
		) {
			throw new Error("Invalid Hub send-await target-ledger observation");
		}
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) throw new Error("Hub send-await target ledger is invalid");
			let ledger = projection.state?.hubSendAwaitTargetDeliveryLedger ?? null;
			if (!ledger) {
				const state = this.#draftTransientRuntimeState(projection.state, input.observedAt);
				ledger = this.#newHubSendAwaitTargetLedger();
				state.hubSendAwaitTargetDeliveryLedger = ledger;
				await this.#commitTransientRuntimeState(state);
			}
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-permit", {
				schemaVersion: 1 as const,
				targetAgentId: input.targetAgentId,
				targetDeliveryLedgerIncarnationSha256: ledger.incarnationSha256,
				targetDeliveryLedgerRevision: ledger.revision,
				targetDeliveryLedgerSha256: this.#hubSendAwaitTargetLedgerSha256(ledger),
				sendOperationId: input.sendOperationId,
				messageSha256: input.messageSha256,
				observedAt: input.observedAt,
			});
		});
	}

	async observeHubSendAwaitAcceptedSourceMaterialization(input: {
		readonly entry: Extract<
			ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1,
			{ state: "accepted_pending_delivery" }
		>;
		readonly observedAt: ISO8601;
		readonly waiterSelectorAuthority: { readonly authoritySha256: Sha256Ref; readonly revision: number };
	}): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliverySourceMaterializationPermitV1> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-ledger-entry",
				input.entry,
			) ||
			!detachedIso8601(input.observedAt) ||
			!detachedSha256Ref(input.waiterSelectorAuthority.authoritySha256) ||
			!detachedInteger(input.waiterSelectorAuthority.revision)
		) {
			throw new Error("Invalid Hub send-await source-materialization observation");
		}
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) throw new Error("Hub send-await source persistence is invalid");
			let ledger = projection.state?.hubSendAwaitTargetDeliveryLedger ?? null;
			if (!ledger) {
				const state = this.#draftTransientRuntimeState(projection.state, input.observedAt);
				ledger = this.#newHubSendAwaitTargetLedger();
				state.hubSendAwaitTargetDeliveryLedger = ledger;
				await this.#commitTransientRuntimeState(state);
			}
			const head = this.#index.leafId();
			const authority = this.resolveTransientTaskJournalGenerationAuthority(head);
			const targetSessionAuthority =
				authority.status === "matching"
					? {
							targetSessionId: this.#sessionId,
							targetSessionGenerationSha256: authority.authority.sessionGeneration.sessionGenerationSha256,
							targetBranchGenerationSha256: authority.authority.branchGeneration.branchGenerationSha256,
							targetSessionHeadEntryId: head,
						}
					: null;
			const failedObservationAuthority = {
				authoritySha256: detachedTupleSha256Ref([
					"omp-hub-send-await-outbound-v1",
					"target-failed-observation-authority",
					1,
					ledger.incarnationSha256,
					ledger.revision,
					ledger.failedObservations.map(request => request.requestSha256),
				]),
				revision: ledger.failedObservations.length,
			};
			return buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-source-materialization-permit",
				{
					schemaVersion: 1 as const,
					acceptedEntrySha256: input.entry.entrySha256,
					targetAgentId: input.entry.message.to,
					waiterSelectorAuthority: input.waiterSelectorAuthority,
					targetSessionAuthority,
					failedObservationAuthority,
					observedAt: input.observedAt,
				},
			);
		});
	}

	async acceptExactHubSendAwaitTargetMessage(
		request: ConfidentialTransientTaskHubSendAwaitTargetDeliveryExactMessageRequestV1,
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliveryEffectResultV1> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-exact-message-request",
				request,
			)
		) {
			return { status: "invalid" };
		}
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			const ledger = projection.state?.hubSendAwaitTargetDeliveryLedger;
			if (!projection.valid || !ledger) return { status: "invalid" } as const;
			if (
				request.message.to !== request.permit.targetAgentId ||
				request.message.messageSha256 !== request.permit.messageSha256
			)
				return { status: "conflict" } as const;
			const matches = ledger.entries.filter(
				entry =>
					entry.request.permit.sendOperationId === request.permit.sendOperationId ||
					entry.message.messageSha256 === request.message.messageSha256,
			);
			if (matches.length > 1) return { status: "conflict" } as const;
			const existing = matches[0];
			if (existing) {
				if (!detachedExactJson(existing.request, request)) return { status: "conflict" } as const;
				if (existing.state === "settled") return { status: "already_settled", entry: existing } as const;
				if (existing.state === "accepted_pending_delivery")
					return { status: "already_accepted", entry: existing } as const;
				return { status: "outcome_unknown" } as const;
			}
			if (
				request.permit.targetDeliveryLedgerIncarnationSha256 !== ledger.incarnationSha256 ||
				request.permit.targetDeliveryLedgerRevision !== ledger.revision ||
				request.permit.targetDeliveryLedgerSha256 !== this.#hubSendAwaitTargetLedgerSha256(ledger)
			)
				return { status: "conflict" } as const;
			const plan = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-consumption-plan", {
				schemaVersion: 1 as const,
				request,
				permitSha256: request.permit.permitSha256,
				sendOperationId: request.permit.sendOperationId,
				messageSha256: request.message.messageSha256,
				preparedAt: request.requestedAt,
			});
			const consumptionState = buildHubTargetNotAppliedConsumptionStateV1(plan);
			const entry = buildHubTargetAcceptedLedgerEntryV1({
				state: "accepted_pending_delivery",
				request,
				message: request.message,
				permit: request.permit,
				consumptionState,
			});
			const state = this.#draftTransientRuntimeState(projection.state, request.requestedAt);
			const draftLedger = state.hubSendAwaitTargetDeliveryLedger!;
			draftLedger.entries.push(entry);
			draftLedger.revision += 1;
			await this.#commitTransientRuntimeState(state);
			return { status: "accepted", entry } as const;
		});
	}

	async transitionHubSendAwaitTargetConsumption(
		request: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionRequestV1,
	): Promise<
		| {
				readonly status: "transitioned" | "already_transitioned";
				readonly receipt: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionTransitionReceiptV1;
		  }
		| { readonly status: "conflict" | "invalid" }
	> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-transition-request",
				request,
			)
		) {
			return { status: "invalid" };
		}
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			const ledger = projection.state?.hubSendAwaitTargetDeliveryLedger;
			if (!projection.valid || !ledger) return { status: "invalid" } as const;
			const index = ledger.entries.findIndex(
				entry => entry.request.requestSha256 === request.plan.request.requestSha256,
			);
			if (index < 0) return { status: "conflict" } as const;
			const entry = ledger.entries[index];
			if (
				entry.state !== "accepted_pending_delivery" ||
				!detachedExactJson(entry.consumptionState.plan, request.plan)
			) {
				return { status: "conflict" } as const;
			}
			if (entry.consumptionState.state === "outcome_unknown") {
				if (!detachedExactJson(entry.consumptionState.transitionRequest, request))
					return { status: "conflict" } as const;
				return { status: "already_transitioned", receipt: entry.consumptionState.transitionReceipt } as const;
			}
			if (entry.consumptionState.stateSha256 !== request.expectedNotAppliedStateSha256)
				return { status: "conflict" } as const;
			const receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-transition-receipt",
				{
					planSha256: request.plan.planSha256,
					transitionRequestSha256: request.requestSha256,
					priorStateSha256: entry.consumptionState.stateSha256,
					outcomeUnknownStateSha256: detachedTupleSha256Ref([
						"omp-hub-send-await-outbound-v1",
						"target-delivery-consumption-outcome-unknown",
						1,
						request.plan.planSha256,
						request.requestSha256,
					]),
					transitionedAt: request.transitionedAt,
				},
			);
			const outcomeUnknown = buildHubTargetOutcomeUnknownConsumptionStateV1(request.plan, request, receipt);
			const nextEntry = buildHubTargetAcceptedLedgerEntryV1({
				state: "accepted_pending_delivery",
				request: entry.request,
				message: entry.message,
				permit: entry.permit,
				consumptionState: outcomeUnknown,
			});
			const state = this.#draftTransientRuntimeState(projection.state, request.transitionedAt);
			state.hubSendAwaitTargetDeliveryLedger!.entries[index] = nextEntry;
			state.hubSendAwaitTargetDeliveryLedger!.revision += 1;
			await this.#commitTransientRuntimeState(state);
			return { status: "transitioned", receipt } as const;
		});
	}

	async settleHubSendAwaitTargetConsumption(
		receipt: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionReceiptV1,
	): Promise<Extract<ConfidentialTransientTaskHubSendAwaitTargetDeliveryLedgerEntryV1, { state: "settled" }>> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-receipt",
				receipt,
			)
		) {
			throw new Error("Invalid Hub send-await target consumption receipt");
		}
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			const ledger = projection.state?.hubSendAwaitTargetDeliveryLedger;
			if (!projection.valid || !ledger) throw new Error("Hub send-await target ledger is invalid");
			const index = ledger.entries.findIndex(
				entry => entry.request.requestSha256 === receipt.plan.request.requestSha256,
			);
			if (index < 0) throw new Error("Hub send-await target entry is absent");
			const entry = ledger.entries[index];
			if (entry.state === "settled") {
				if (!detachedExactJson(entry.consumptionReceipt, receipt))
					throw new Error("Hub target settlement conflict");
				return entry;
			}
			if (
				entry.state !== "accepted_pending_delivery" ||
				entry.consumptionState.state !== "outcome_unknown" ||
				!detachedExactJson(entry.consumptionState.transitionRequest, receipt.transitionRequest) ||
				!detachedExactJson(entry.consumptionState.transitionReceipt, receipt.transitionReceipt)
			) {
				throw new Error("Hub target settlement authority is stale");
			}
			const consumptionState = buildHubTargetSettledConsumptionStateV1(receipt);
			const settled = buildHubTargetSettledLedgerEntryV1({
				state: "settled",
				request: entry.request,
				message: entry.message,
				permit: entry.permit,
				consumptionState,
				consumptionReceipt: receipt,
				sourceReceipt: receipt.sourceReceipt,
				settledAt: receipt.settledAt,
			});
			const state = this.#draftTransientRuntimeState(projection.state, receipt.settledAt);
			state.hubSendAwaitTargetDeliveryLedger!.entries[index] = settled;
			state.hubSendAwaitTargetDeliveryLedger!.revision += 1;
			await this.#commitTransientRuntimeState(state);
			return settled;
		});
	}

	async adoptHubSendAwaitTargetConsumption(
		request: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptRequestV1,
		result: ConfidentialTransientTaskHubSendAwaitTargetDeliveryConsumptionAdoptResultV1,
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliveryEffectResultV1> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-adopt-request",
				request,
			) ||
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-consumption-adopt-result",
				result,
			)
		) {
			return { status: "invalid" };
		}
		if (result.status === "settled") {
			const settled = await this.settleHubSendAwaitTargetConsumption(result.receipt);
			return { status: "settled", entry: settled };
		}
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			const ledger = projection.state?.hubSendAwaitTargetDeliveryLedger;
			if (!projection.valid || !ledger) return { status: "invalid" } as const;
			const index = ledger.entries.findIndex(
				entry => entry.request.requestSha256 === request.inspectRequest.plan.request.requestSha256,
			);
			if (index < 0) return { status: "conflict" } as const;
			const entry = ledger.entries[index];
			if (
				entry.state !== "accepted_pending_delivery" ||
				entry.consumptionState.state !== "outcome_unknown" ||
				!detachedExactJson(entry.consumptionState.transitionRequest, request.inspectRequest.transitionRequest) ||
				!detachedExactJson(entry.consumptionState.transitionReceipt, request.inspectRequest.transitionReceipt)
			) {
				return { status: "conflict" } as const;
			}
			const state = this.#draftTransientRuntimeState(projection.state, request.adoptedAt);
			if (result.status === "restored_not_applied") {
				const restored = buildHubTargetAcceptedLedgerEntryV1({
					state: "accepted_pending_delivery" as const,
					request: entry.request,
					message: entry.message,
					permit: entry.permit,
					consumptionState: result.state,
				});
				state.hubSendAwaitTargetDeliveryLedger!.entries[index] = restored;
				state.hubSendAwaitTargetDeliveryLedger!.revision += 1;
				await this.#commitTransientRuntimeState(state);
				return { status: "accepted", entry: restored } as const;
			}
			const blockedState = buildHubTargetBlockedConsumptionStateV1(result.block);
			const blocked = buildHubTargetBlockedLedgerEntryV1({
				state: "blocked_indeterminate",
				request: entry.request,
				message: entry.message,
				permit: entry.permit,
				consumptionState: blockedState,
				block: result.block,
				blockedAt: request.adoptedAt,
			});
			state.hubSendAwaitTargetDeliveryLedger!.entries[index] = blocked;
			state.hubSendAwaitTargetDeliveryLedger!.revision += 1;
			await this.#commitTransientRuntimeState(state);
			return { status: "outcome_unknown" } as const;
		});
	}

	async recordHubSendAwaitTargetFailedObservation(
		request: ConfidentialTransientTaskHubSendAwaitTargetFailedObservationRequestV1,
	): Promise<void> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-failed-observation-request", request)
		) {
			throw new Error("Invalid Hub send-await failed observation");
		}
		await this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			const ledger = projection.state?.hubSendAwaitTargetDeliveryLedger;
			if (!projection.valid || !ledger) throw new Error("Hub send-await target ledger is invalid");
			const existing = ledger.failedObservations.find(row => row.requestSha256 === request.requestSha256);
			if (existing) {
				if (!detachedExactJson(existing, request)) throw new Error("Hub failed-observation conflict");
				return;
			}
			const state = this.#draftTransientRuntimeState(projection.state, request.observedAt);
			state.hubSendAwaitTargetDeliveryLedger!.failedObservations.push(structuredClone(request));
			state.hubSendAwaitTargetDeliveryLedger!.revision += 1;
			await this.#commitTransientRuntimeState(state);
		});
	}

	inspectHubSendAwaitTargetFailedObservation(
		request: ConfidentialTransientTaskHubSendAwaitTargetFailedObservationRequestV1,
	): {
		readonly request: ConfidentialTransientTaskHubSendAwaitTargetFailedObservationRequestV1 | null;
		readonly authority: { readonly authoritySha256: Sha256Ref; readonly revision: number };
	} {
		const projection = this.#transientRuntimeStateProjection();
		const ledger = projection.state?.hubSendAwaitTargetDeliveryLedger;
		if (!projection.valid || !ledger) throw new Error("Hub send-await target ledger is invalid");
		return {
			request: ledger.failedObservations.find(row => row.requestSha256 === request.requestSha256) ?? null,
			authority: {
				authoritySha256: detachedTupleSha256Ref([
					"omp-hub-send-await-outbound-v1",
					"target-failed-observation-authority",
					1,
					ledger.incarnationSha256,
					ledger.revision,
					ledger.failedObservations.map(row => row.requestSha256),
				]),
				revision: ledger.failedObservations.length,
			},
		};
	}

	async inspectExactHubSendAwaitTargetMessage(
		request: ConfidentialTransientTaskHubSendAwaitTargetDeliveryInspectRequestV1,
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetDeliveryInspectionV1> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspect-request", request)
		) {
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
				status: "invalid" as const,
			});
		}
		const projection = this.#transientRuntimeStateProjection();
		const ledger = projection.state?.hubSendAwaitTargetDeliveryLedger;
		if (!projection.valid || !ledger) {
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
				status: "invalid" as const,
			});
		}
		const matches = ledger.entries.filter(
			entry =>
				entry.request.permit.sendOperationId === request.sendOperationId ||
				entry.message.messageSha256 === request.messageSha256,
		);
		if (matches.length > 1)
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
				status: "conflict" as const,
			});
		const entry = matches[0];
		if (entry) {
			if (
				entry.request.requestSha256 !== request.expectedExactMessageRequestSha256 ||
				entry.consumptionState.state === "blocked_indeterminate" ||
				(entry.consumptionState.state !== "settled" &&
					entry.consumptionState.plan.planSha256 !== request.expectedConsumptionPlanSha256)
			) {
				return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
					status: "conflict" as const,
				});
			}
			if (entry.state === "settled")
				return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
					status: "matching_settled_entry" as const,
					entry,
				});
			if (entry.state === "accepted_pending_delivery")
				return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
					status: "matching_pending_entry" as const,
					entry,
				});
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
				status: "outcome_unknown" as const,
				entry,
			});
		}
		if (
			request.permit.targetDeliveryLedgerIncarnationSha256 === ledger.incarnationSha256 &&
			request.permit.targetDeliveryLedgerRevision === ledger.revision &&
			request.permit.targetDeliveryLedgerSha256 === this.#hubSendAwaitTargetLedgerSha256(ledger)
		) {
			const proof = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-delivery-authoritative-absence",
				{
					permit: request.permit,
					inspectRequest: request,
					unchangedTargetDeliveryLedgerIncarnationSha256: ledger.incarnationSha256,
					unchangedTargetDeliveryLedgerRevision: ledger.revision,
					unchangedTargetDeliveryLedgerSha256: this.#hubSendAwaitTargetLedgerSha256(ledger),
					exactOperationAbsent: true as const,
					exactMessageAbsent: true as const,
					provenAt: request.inspectedAt,
				},
			);
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
				status: "authoritative_absence" as const,
				proof,
			});
		}
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-delivery-inspection", {
			status: "conflict" as const,
		});
	}

	#parseHubSendAwaitTargetSessionEntry(
		request: ConfidentialTransientTaskHubSendAwaitTargetSessionAppendRequestV1,
	): CustomMessageEntry | null {
		try {
			const parsed = JSON.parse(
				request.sessionEntryJsonlUtf8.endsWith("\n")
					? request.sessionEntryJsonlUtf8.slice(0, -1)
					: request.sessionEntryJsonlUtf8,
			) as unknown;
			if (
				!detachedStrictRecord(parsed, [
					"type",
					"id",
					"parentId",
					"timestamp",
					"customType",
					"content",
					"display",
					"details",
					"attribution",
				]) ||
				parsed.type !== "custom_message" ||
				parsed.id !== request.sessionEntryId ||
				parsed.parentId !== request.appendParentEntryId ||
				!detachedIso8601(parsed.timestamp) ||
				parsed.customType !== request.sessionEntry.customType ||
				parsed.content !== request.sessionEntry.content ||
				parsed.display !== true ||
				parsed.attribution !== "agent" ||
				!detachedExactJson(parsed.details, request.sessionEntry.details) ||
				`${JSON.stringify(parsed)}\n` !== request.sessionEntryJsonlUtf8
			)
				return null;
			return parsed as unknown as CustomMessageEntry;
		} catch {
			return null;
		}
	}

	async appendExactHubSendAwaitTargetSessionEntry(
		request: ConfidentialTransientTaskHubSendAwaitTargetSessionAppendRequestV1,
	): Promise<TransientTaskHubSendAwaitTargetSessionAppendResultV1> {
		if (!validateTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-session-append-request", request))
			return { status: "invalid" };
		const candidate = this.#parseHubSendAwaitTargetSessionEntry(request);
		if (!candidate || request.targetSessionId !== this.#sessionId) return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" } as const;
			const authority = this.resolveTransientTaskJournalGenerationAuthority(request.expectedHeadEntryId);
			if (
				authority.status !== "matching" ||
				authority.authority.sessionGeneration.sessionGenerationSha256 !== request.targetSessionGenerationSha256 ||
				authority.authority.branchGeneration.branchGenerationSha256 !== request.targetBranchGenerationSha256 ||
				this.#index.leafId() !== request.expectedHeadEntryId ||
				request.appendParentEntryId !== request.expectedHeadEntryId
			) {
				return { status: "conflict" } as const;
			}
			const matches =
				projection.state?.hubSendAwaitTargetSessionAppends.filter(
					row =>
						row.request.appendOperationId === request.appendOperationId ||
						row.request.sessionEntryId === request.sessionEntryId,
				) ?? [];
			if (matches.length > 1) return { status: "conflict" } as const;
			const existing = matches[0];
			if (existing) {
				if (!detachedExactJson(existing.request, request)) return { status: "conflict" } as const;
				if (existing.status === "appended" && existing.receipt)
					return { status: "already_appended", receipt: existing.receipt } as const;
			}
			const physical = this.#index.get(request.sessionEntryId);
			if (physical && !detachedExactJson(physical, candidate)) return { status: "conflict" } as const;
			const receipt = buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-session-append-receipt", {
				schemaVersion: 1 as const,
				request,
				committedSessionEntryId: request.sessionEntryId,
				priorHeadEntryId: request.expectedHeadEntryId,
				committedHeadEntryId: request.sessionEntryId,
				committedAt: request.requestedAt,
			});
			const state = this.#draftTransientRuntimeState(projection.state, request.requestedAt);
			if (existing) {
				const row = state.hubSendAwaitTargetSessionAppends.find(
					item => item.request.appendOperationId === request.appendOperationId,
				)!;
				row.status = "appended";
				row.receipt = receipt;
			} else {
				state.hubSendAwaitTargetSessionAppends.push({
					request: structuredClone(request),
					status: "appended",
					receipt,
					restoredInspectionSha256: null,
				});
			}
			this.#sealTransientRuntimeState(state);
			try {
				await this.#appendEntriesAtomicallyLocked(() => {
					if (!physical) this.#recordEntry(candidate);
					this.#recordTransientRuntimeState(state);
				});
			} catch {
				return { status: "outcome_unknown" } as const;
			}
			return { status: "appended", receipt } as const;
		});
	}

	async inspectExactHubSendAwaitTargetSessionEntry(
		request: ConfidentialTransientTaskHubSendAwaitTargetSessionAppendInspectRequestV1,
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetSessionAppendInspectionV1> {
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-session-append-inspect-request",
				request,
			)
		)
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-session-append-inspection", {
				status: "invalid" as const,
			});
		const projection = this.#transientRuntimeStateProjection();
		if (!projection.valid)
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-session-append-inspection", {
				status: "invalid" as const,
			});
		const row = projection.state?.hubSendAwaitTargetSessionAppends.find(
			candidate =>
				candidate.request.appendOperationId === request.appendOperationId ||
				candidate.request.sessionEntryId === request.sessionEntryId,
		);
		if (!row || row.request.requestSha256 !== request.expectedAppendRequestSha256) {
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-session-append-inspection", {
				status: "conflict" as const,
			});
		}
		const physical = this.#index.get(request.sessionEntryId);
		const expected = this.#parseHubSendAwaitTargetSessionEntry(row.request);
		if (row.receipt && physical && expected && detachedExactJson(physical, expected)) {
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-session-append-inspection", {
				status: "matching" as const,
				receipt: row.receipt,
			});
		}
		const authority = this.resolveTransientTaskJournalGenerationAuthority(row.request.expectedHeadEntryId);
		if (
			!physical &&
			authority.status === "matching" &&
			authority.authority.sessionGeneration.sessionGenerationSha256 === row.request.targetSessionGenerationSha256 &&
			authority.authority.branchGeneration.branchGenerationSha256 === row.request.targetBranchGenerationSha256 &&
			this.#index.leafId() === row.request.expectedHeadEntryId
		) {
			const proof = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-session-append-authoritative-absence",
				{
					inspectRequest: request,
					appendRequest: row.request,
					unchangedTargetSessionGenerationSha256: row.request.targetSessionGenerationSha256,
					unchangedTargetBranchGenerationSha256: row.request.targetBranchGenerationSha256,
					unchangedHeadEntryId: row.request.expectedHeadEntryId,
					exactAppendOperationAbsent: true as const,
					exactSessionEntryAbsent: true as const,
					provenAt: request.inspectedAt,
				},
			);
			return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-session-append-inspection", {
				status: "authoritative_absence" as const,
				proof,
			});
		}
		return buildTransientTaskHubWaitMessageCanonicalRecordV1("send-await-target-session-append-inspection", {
			status: "outcome_unknown" as const,
			inspectRequestSha256: request.requestSha256,
			appendRequestSha256: row.request.requestSha256,
			inspectedAt: request.inspectedAt,
		});
	}

	async adoptExactHubSendAwaitTargetSessionEntry(
		request: ConfidentialTransientTaskHubSendAwaitTargetSessionAppendAdoptRequestV1,
	): Promise<ConfidentialTransientTaskHubSendAwaitTargetSessionAppendAdoptResultV1> {
		const inspection = request.inspection;
		if (
			!validateTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-session-append-adopt-request",
				request,
			) ||
			request.expectedInspectionSha256 !== inspection.inspectionSha256
		) {
			const invalidInspection = buildTransientTaskHubWaitMessageCanonicalRecordV1(
				"send-await-target-session-append-inspection",
				{ status: "invalid" as const },
			);
			if (invalidInspection.status !== "invalid") throw new Error("Invalid Hub target append inspection mismatch");
			return {
				status: "blocked_indeterminate",
				request: request.appendRequest,
				inspectRequest: request.inspectRequest,
				inspection: invalidInspection,
			};
		}
		if (inspection.status === "matching") return { status: "appended", receipt: inspection.receipt };
		if (inspection.status !== "authoritative_absence") {
			return {
				status: "blocked_indeterminate",
				request: request.appendRequest,
				inspectRequest: request.inspectRequest,
				inspection,
			};
		}
		await this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			const row = projection.state?.hubSendAwaitTargetSessionAppends.find(
				candidate => candidate.request.appendOperationId === request.appendRequest.appendOperationId,
			);
			if (!projection.valid || !row || !detachedExactJson(row.request, request.appendRequest))
				throw new Error("Hub target append inspection is stale");
			if (row.restoredInspectionSha256 === request.expectedInspectionSha256) return;
			const state = this.#draftTransientRuntimeState(projection.state, request.adoptedAt);
			const draft = state.hubSendAwaitTargetSessionAppends.find(
				candidate => candidate.request.appendOperationId === request.appendRequest.appendOperationId,
			)!;
			draft.status = "not_applied";
			draft.receipt = null;
			draft.restoredInspectionSha256 = request.expectedInspectionSha256;
			await this.#commitTransientRuntimeState(state);
		});
		return { status: "restored_not_applied", request: request.appendRequest };
	}

	#beforeReturnOverlay(
		record: ConfidentialTransientTaskForegroundBeforeReturnRecordV1,
		state: SessionManagerTransientRuntimeStateV1 | null,
	):
		| { status: "matching"; snapshot: PendingOverlaySnapshotV1 }
		| { status: "pending_overlay_missing" | "pending_overlay_conflict" } {
		const binding = record.pendingOverlayBinding;
		const rows = state?.overlays.filter(row => row.anchoredBinding?.bindingSha256 === binding.bindingSha256) ?? [];
		if (rows.length === 0) return { status: "pending_overlay_missing" };
		if (rows.length !== 1) return { status: "pending_overlay_conflict" };
		const row = rows[0];
		if (
			!row.snapshot ||
			!row.preDispatchBinding ||
			!row.anchoredBinding ||
			!detachedExactJson(row.anchoredBinding, binding) ||
			!detachedExactJson(row.anchoredBinding.preDispatchBinding, row.preDispatchBinding) ||
			row.snapshot.pendingOverlaySnapshotSha256 !== row.preDispatchBinding.pendingOverlaySnapshotSha256 ||
			row.snapshot.finalVersion !== row.preDispatchBinding.finalVersion ||
			row.snapshot.finalVersionSha256 !== row.preDispatchBinding.finalVersionSha256 ||
			row.snapshot.captureOutcomeHistorySha256 !== row.preDispatchBinding.captureOutcomeHistorySha256 ||
			row.snapshot.finalCaptureOutcomeSha256 !== row.preDispatchBinding.finalCaptureOutcomeSha256 ||
			row.preDispatchBinding.bindingSha256 !== overlayPreDispatchBindingDigest(row.preDispatchBinding) ||
			binding.bindingSha256 !== overlayBindingDigest(binding)
		)
			return { status: "pending_overlay_conflict" };
		return { status: "matching", snapshot: row.snapshot };
	}

	#beforeReturnAuthority(
		record: ConfidentialTransientTaskForegroundBeforeReturnRecordV1,
	):
		| "matching"
		| "session_generation_replaced"
		| "branch_generation_replaced"
		| "branch_anchor_missing"
		| "tool_call_missing" {
		const key = record.batchKeyInput;
		const authority = this.#transientAuthorityStatus(
			key.parentSessionId,
			key.parentSessionGenerationSha256,
			key.parentBranchAnchorEntryId,
			key.parentBranchGenerationSha256,
		);
		if (authority !== "matching") return authority;
		return this.#assistantAnchorContainsToolCall(key.parentBranchAnchorEntryId, key.toolCallId)
			? "matching"
			: "tool_call_missing";
	}

	async prepareBeforeReturnRecord(
		record: ConfidentialTransientTaskForegroundBeforeReturnRecordV1,
	): ReturnType<TransientTaskForegroundBeforeReturnRecoveryBridgeV1["prepareBeforeReturnRecord"]> {
		if (!validBeforeReturnRecord(record)) return { status: "invalid" };
		const authority = this.#beforeReturnAuthority(record);
		if (authority !== "matching") return { status: authority };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const overlay = this.#beforeReturnOverlay(record, projection.state);
			if (overlay.status !== "matching") return { status: overlay.status };
			const key = beforeReturnRecoveryKey(record, overlay.snapshot);
			const matches =
				projection.state?.beforeReturnRows.filter(
					row =>
						row.recoveryKey.parentSessionId === key.parentSessionId &&
						row.recoveryKey.parentSessionGenerationSha256 === key.parentSessionGenerationSha256 &&
						row.recoveryKey.parentBranchGenerationSha256 === key.parentBranchGenerationSha256 &&
						row.recoveryKey.parentBranchAnchorEntryId === key.parentBranchAnchorEntryId &&
						row.recoveryKey.toolCallId === key.toolCallId,
				) ?? [];
			if (matches.length > 1) return { status: "conflict" };
			if (matches.length === 1)
				return detachedExactJson(matches[0].record, record) && detachedExactJson(matches[0].recoveryKey, key)
					? { status: "already_prepared" }
					: { status: "conflict" };
			const state = this.#draftTransientRuntimeState(projection.state, record.frozenBeforeReturnAt);
			state.beforeReturnRows.push({
				recoveryKey: structuredClone(key),
				record: structuredClone(record),
				suspension: null,
				handoffBatch: null,
				enumerationInspectionSha256s: [],
				inspectionEnumerationJoins: [],
				adoptionRequestSha256: null,
				adoptionReceipt: null,
			});
			await this.#commitTransientRuntimeState(state);
			return { status: "prepared" };
		});
	}

	async persistBeforeReturnSuspension(
		suspension: ConfidentialTransientTaskForegroundBeforeReturnSuspensionV1,
	): ReturnType<TransientTaskForegroundBeforeReturnRecoveryBridgeV1["persistBeforeReturnSuspension"]> {
		if (!validBeforeReturnSuspension(suspension)) return { status: "invalid" };
		const record = suspension.record;
		const authority = this.#beforeReturnAuthority(record);
		if (authority !== "matching") return { status: authority };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const overlay = this.#beforeReturnOverlay(record, projection.state);
			if (overlay.status !== "matching") return { status: overlay.status };
			const key = beforeReturnRecoveryKey(record, overlay.snapshot);
			const matches =
				projection.state?.beforeReturnRows.filter(
					row => row.recoveryKey.recoveryKeySha256 === key.recoveryKeySha256,
				) ?? [];
			if (matches.length > 1) return { status: "conflict" };
			if (matches.length === 1) {
				const row = matches[0];
				if (!detachedExactJson(row.record, record) || row.handoffBatch) return { status: "conflict" };
				if (row.suspension)
					return detachedExactJson(row.suspension, suspension)
						? { status: "already_prepared" }
						: { status: "conflict" };
				const state = this.#draftTransientRuntimeState(projection.state, suspension.suspendedAt);
				state.beforeReturnRows.find(
					candidate => candidate.recoveryKey.recoveryKeySha256 === key.recoveryKeySha256,
				)!.suspension = structuredClone(suspension);
				await this.#commitTransientRuntimeState(state);
				return { status: "prepared" };
			}
			const state = this.#draftTransientRuntimeState(projection.state, suspension.suspendedAt);
			state.beforeReturnRows.push({
				recoveryKey: structuredClone(key),
				record: structuredClone(record),
				suspension: structuredClone(suspension),
				handoffBatch: null,
				enumerationInspectionSha256s: [],
				inspectionEnumerationJoins: [],
				adoptionRequestSha256: null,
				adoptionReceipt: null,
			});
			await this.#commitTransientRuntimeState(state);
			return { status: "prepared" };
		});
	}

	async enumeratePendingBeforeReturn(
		request: BeforeReturnEnumerateRequestV1,
	): ReturnType<TransientTaskForegroundBeforeReturnRecoveryBridgeV1["enumeratePendingBeforeReturn"]> {
		if (
			!detachedStrictRecord(request, [
				"schemaVersion",
				"parentSessionId",
				"parentSessionGenerationSha256",
				"parentBranchGenerationSha256",
				"parentBranchAnchorEntryId",
				"toolCallId",
				"requestedAt",
				"requestSha256",
			]) ||
			request.schemaVersion !== 1 ||
			!detachedIdentity(request.parentSessionId) ||
			!detachedSha256Ref(request.parentSessionGenerationSha256) ||
			!detachedSha256Ref(request.parentBranchGenerationSha256) ||
			!detachedIdentity(request.parentBranchAnchorEntryId) ||
			!detachedIdentity(request.toolCallId) ||
			!detachedIso8601(request.requestedAt) ||
			!detachedSha256Hex(request.requestSha256) ||
			request.requestSha256 !== beforeReturnEnumerationRequestDigest(request)
		)
			return { status: "invalid" };
		const authority = this.#transientAuthorityStatus(
			request.parentSessionId,
			request.parentSessionGenerationSha256,
			request.parentBranchAnchorEntryId,
			request.parentBranchGenerationSha256,
		);
		if (authority !== "matching") return { status: authority };
		if (!this.#assistantAnchorContainsToolCall(request.parentBranchAnchorEntryId, request.toolCallId))
			return { status: "tool_call_missing" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const matches =
				projection.state?.beforeReturnRows.filter(
					row =>
						row.recoveryKey.parentSessionId === request.parentSessionId &&
						row.recoveryKey.parentSessionGenerationSha256 === request.parentSessionGenerationSha256 &&
						row.recoveryKey.parentBranchGenerationSha256 === request.parentBranchGenerationSha256 &&
						row.recoveryKey.parentBranchAnchorEntryId === request.parentBranchAnchorEntryId &&
						row.recoveryKey.toolCallId === request.toolCallId,
				) ?? [];
			if (matches.length > 1)
				return {
					status: "duplicate_pending_conflict",
					physicalMatchCount: matches.length,
					inspectedAt: request.requestedAt,
					conflictSha256: detachedTupleSha256Ref([
						"omp-transient-task-foreground-settlement-v1",
						"before-return-duplicate-conflict",
						1,
						request,
						matches.length,
					]),
				};
			const row = matches[0];
			const pending = !row
				? ([] as const)
				: row.handoffBatch
					? ([
							{
								recoveryKey: row.recoveryKey,
								durableState: "handoff_prepared" as const,
								suspensionSha256: row.suspension?.suspensionSha256 ?? null,
								handoffBatchSha256: row.handoffBatch.handoffBatchSha256,
							},
						] as const)
					: row.suspension
						? ([
								{
									recoveryKey: row.recoveryKey,
									durableState: "suspended" as const,
									suspensionSha256: row.suspension.suspensionSha256,
									handoffBatchSha256: null,
								},
							] as const)
						: ([
								{
									recoveryKey: row.recoveryKey,
									durableState: "recorded" as const,
									suspensionSha256: null,
									handoffBatchSha256: null,
								},
							] as const);
			const inspectionSha256 = detachedTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"before-return-enumeration-inspection",
				1,
				request,
				matches[0] ? beforeReturnPendingDigest(matches[0]) : null,
			]);
			if (matches[0] && !matches[0].enumerationInspectionSha256s.includes(inspectionSha256)) {
				const state = this.#draftTransientRuntimeState(projection.state, request.requestedAt);
				state.beforeReturnRows
					.find(row => row.recoveryKey.recoveryKeySha256 === matches[0].recoveryKey.recoveryKeySha256)!
					.enumerationInspectionSha256s.push(inspectionSha256);
				await this.#commitTransientRuntimeState(state);
			}
			return { status: "matching", pending, inspectedAt: request.requestedAt, inspectionSha256 };
		});
	}

	async inspectPendingBeforeReturn(
		request: BeforeReturnInspectRequestV1,
	): ReturnType<TransientTaskForegroundBeforeReturnRecoveryBridgeV1["inspectPendingBeforeReturn"]> {
		if (
			!detachedStrictRecord(request, [
				"recoveryKey",
				"expectedEnumerationInspectionSha256",
				"requestedAt",
				"requestSha256",
			]) ||
			!detachedCanonicalData(request.recoveryKey) ||
			!detachedSha256Ref(request.expectedEnumerationInspectionSha256) ||
			!detachedIso8601(request.requestedAt) ||
			!detachedSha256Hex(request.requestSha256) ||
			request.requestSha256 !== beforeReturnInspectRequestDigest(request)
		)
			return { status: "invalid" };
		const key = request.recoveryKey;
		const authority = this.#transientAuthorityStatus(
			key.parentSessionId,
			key.parentSessionGenerationSha256,
			key.parentBranchAnchorEntryId,
			key.parentBranchGenerationSha256,
		);
		if (authority !== "matching") return { status: authority };
		if (!this.#assistantAnchorContainsToolCall(key.parentBranchAnchorEntryId, key.toolCallId))
			return { status: "tool_call_missing" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const matches =
				projection.state?.beforeReturnRows.filter(
					row => row.recoveryKey.recoveryKeySha256 === key.recoveryKeySha256,
				) ?? [];
			if (matches.length === 0) return { status: "absent" };
			if (matches.length > 1) return { status: "duplicate_pending_conflict" };
			const row = matches[0];
			if (!detachedExactJson(row.recoveryKey, key)) return { status: "conflict" };
			if (!row.enumerationInspectionSha256s.includes(request.expectedEnumerationInspectionSha256))
				return { status: "enumeration_stale" };
			if (
				!validBeforeReturnRecord(row.record) ||
				(row.suspension !== null && !validBeforeReturnSuspension(row.suspension)) ||
				(row.handoffBatch !== null && !validBeforeReturnHandoff(row.handoffBatch))
			)
				return { status: "snapshot_conflict" };
			const overlay = this.#beforeReturnOverlay(row.record, projection.state);
			if (overlay.status !== "matching") return { status: "snapshot_conflict" };
			const inspectionSha256 = detachedTupleSha256Ref([
				"omp-transient-task-foreground-settlement-v1",
				"before-return-inspection",
				1,
				request,
				beforeReturnPendingDigest(row),
				row.record,
				overlay.snapshot,
				row.record.pendingOverlayBinding,
				row.suspension,
				row.handoffBatch,
			]);
			if (
				!row.inspectionEnumerationJoins.some(
					join =>
						join.inspectionSha256 === inspectionSha256 &&
						join.enumerationInspectionSha256 === request.expectedEnumerationInspectionSha256,
				)
			) {
				const state = this.#draftTransientRuntimeState(projection.state, request.requestedAt);
				state.beforeReturnRows
					.find(candidate => candidate.recoveryKey.recoveryKeySha256 === row.recoveryKey.recoveryKeySha256)!
					.inspectionEnumerationJoins.push({
						inspectionSha256,
						enumerationInspectionSha256: request.expectedEnumerationInspectionSha256,
					});
				await this.#commitTransientRuntimeState(state);
			}
			const common = {
				status: "matching" as const,
				record: row.record,
				orderedPreReturnIdentities: row.record.orderedPreReturnIdentities,
				pendingOverlaySnapshot: overlay.snapshot,
				pendingOverlayBinding: row.record.pendingOverlayBinding,
				inspectionSha256,
			};
			if (row.handoffBatch)
				return {
					...common,
					durableState: "handoff_prepared" as const,
					suspension: row.suspension,
					handoffBatch: row.handoffBatch,
					inspectedAt: request.requestedAt,
				};
			if (row.suspension)
				return {
					...common,
					durableState: "suspended" as const,
					suspension: row.suspension,
					handoffBatch: null,
					inspectedAt: request.requestedAt,
				};
			return { ...common, durableState: "recorded" as const, suspension: null, handoffBatch: null };
		});
	}

	async adoptPendingBeforeReturn(
		request: BeforeReturnAdoptRequestV1,
	): ReturnType<TransientTaskForegroundBeforeReturnRecoveryBridgeV1["adoptPendingBeforeReturn"]> {
		if (
			!detachedStrictRecord(request, ["inspection", "expectedInspectionSha256", "requestedAt", "requestSha256"]) ||
			!detachedCanonicalData(request.inspection) ||
			!detachedSha256Ref(request.expectedInspectionSha256) ||
			request.expectedInspectionSha256 !== request.inspection.inspectionSha256 ||
			!detachedIso8601(request.requestedAt) ||
			!detachedSha256Hex(request.requestSha256) ||
			request.requestSha256 !== beforeReturnAdoptRequestDigest(request)
		)
			return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const record = request.inspection.record;
			const authority = this.#beforeReturnAuthority(record);
			if (authority !== "matching") return { status: authority };
			const matches =
				projection.state?.beforeReturnRows.filter(
					row => row.recoveryKey.beforeReturnRecordSha256 === record.recordSha256,
				) ?? [];
			if (matches.length !== 1)
				return { status: matches.length > 1 ? "duplicate_pending_conflict" : "inspection_stale" };
			const row = matches[0];
			const overlay = this.#beforeReturnOverlay(row.record, projection.state);
			const join = row.inspectionEnumerationJoins.find(
				candidate => candidate.inspectionSha256 === request.expectedInspectionSha256,
			);
			if (
				overlay.status !== "matching" ||
				!join ||
				!detachedExactJson(request.inspection.record, row.record) ||
				!detachedExactJson(request.inspection.pendingOverlaySnapshot, overlay.snapshot) ||
				!detachedExactJson(request.inspection.pendingOverlayBinding, row.record.pendingOverlayBinding) ||
				!detachedExactJson(request.inspection.suspension, row.suspension) ||
				!detachedExactJson(request.inspection.handoffBatch, row.handoffBatch)
			)
				return { status: "inspection_stale" };
			if (row.adoptionRequestSha256 !== null && row.adoptionRequestSha256 !== request.requestSha256)
				return { status: "conflict" };
			let receipt = row.adoptionReceipt;
			const already = receipt !== null;
			if (!receipt) {
				const core = {
					schemaVersion: 1 as const,
					recoveryKeySha256: row.recoveryKey.recoveryKeySha256,
					beforeReturnRecordSha256: row.record.recordSha256,
					suspensionSha256: row.suspension?.suspensionSha256 ?? null,
					handoffBatchSha256: row.handoffBatch?.handoffBatchSha256 ?? null,
					pendingOverlayBindingSha256: row.recoveryKey.pendingOverlayBindingSha256,
					pendingOverlaySnapshotSha256: row.recoveryKey.pendingOverlaySnapshotSha256,
					pendingOverlayFinalVersion: row.recoveryKey.pendingOverlayFinalVersion,
					pendingOverlayFinalVersionSha256: row.recoveryKey.pendingOverlayFinalVersionSha256,
					pendingOverlayCaptureOutcomeHistorySha256: row.recoveryKey.pendingOverlayCaptureOutcomeHistorySha256,
					pendingOverlayFinalCaptureOutcomeSha256: row.recoveryKey.pendingOverlayFinalCaptureOutcomeSha256,
					returnedSourceResultSnapshotSha256: row.recoveryKey.returnedSourceResultSnapshotSha256,
					returnedSourceResultSnapshotByteLength: row.recoveryKey.returnedSourceResultSnapshotByteLength,
					returnedAgentToolResultUtf8Sha256: row.recoveryKey.returnedAgentToolResultUtf8Sha256,
					orderedPreReturnIdentitySha256s: row.recoveryKey.orderedPreReturnIdentitySha256s,
					enumerationInspectionSha256: join.enumerationInspectionSha256,
					exactInspectionSha256: request.expectedInspectionSha256,
					adoptedAt: request.requestedAt,
				};
				receipt = {
					...core,
					receiptSha256: detachedTupleSha256Ref([
						"omp-transient-task-foreground-settlement-v1",
						"before-return-adoption-core",
						1,
						core.recoveryKeySha256,
						core.beforeReturnRecordSha256,
						core.suspensionSha256,
						core.handoffBatchSha256,
						core.pendingOverlayBindingSha256,
						core.pendingOverlaySnapshotSha256,
						core.pendingOverlayFinalVersion,
						core.pendingOverlayFinalVersionSha256,
						core.pendingOverlayCaptureOutcomeHistorySha256,
						core.pendingOverlayFinalCaptureOutcomeSha256,
						core.returnedSourceResultSnapshotSha256,
						core.returnedSourceResultSnapshotByteLength,
						core.returnedAgentToolResultUtf8Sha256,
						core.orderedPreReturnIdentitySha256s,
						core.enumerationInspectionSha256,
						core.exactInspectionSha256,
						core.adoptedAt,
					]),
				};
				const state = this.#draftTransientRuntimeState(projection.state, request.requestedAt);
				const draft = state.beforeReturnRows.find(
					candidate => candidate.recoveryKey.recoveryKeySha256 === row.recoveryKey.recoveryKeySha256,
				)!;
				draft.adoptionRequestSha256 = request.requestSha256;
				draft.adoptionReceipt = receipt;
				await this.#commitTransientRuntimeState(state);
			}
			const common = {
				record: row.record,
				orderedPreReturnIdentities: row.record.orderedPreReturnIdentities,
				pendingOverlaySnapshot: overlay.snapshot,
				pendingOverlayBinding: row.record.pendingOverlayBinding,
				suspension: row.suspension,
				receipt,
			};
			return row.handoffBatch
				? {
						status: already ? ("already_handoff_adopted" as const) : ("handoff_adopted" as const),
						...common,
						handoffBatch: row.handoffBatch,
					}
				: {
						status: already ? ("already_record_adopted" as const) : ("record_adopted" as const),
						...common,
						handoffBatch: null,
					};
		});
	}

	async prepareFirstVersionAndIndexStartedCapture(
		request: PendingOverlayFirstRequestV1,
	): ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["prepareFirstVersionAndIndexStartedCapture"]> {
		if (
			!detachedCanonicalData(request) ||
			!validOverlayVersion(request.version) ||
			request.version.version !== 0 ||
			request.version.priorVersionSha256 !== null ||
			request.requestSha256 !== request.startedRecord.recordSha256 ||
			request.startedRecord.recordSha256 !==
				canonicalTransientTaskSourceObservationDigestV1("pending_capture_record", request.startedRecord.core) ||
			request.startedRecord.core.state !== "started" ||
			request.startedRecord.core.durableVersions.length !== 1 ||
			!detachedExactJson(request.startedRecord.core.durableVersions[0], request.version) ||
			!detachedExactJson(request.startedRecord.core.captureKey, request.version.key) ||
			request.startedRecord.core.finalizedSnapshot !== null ||
			request.startedRecord.core.preDispatchBinding !== null ||
			request.startedRecord.core.anchoredBinding !== null ||
			request.startedRecord.core.executeEntryObservationReceipt !== null
		)
			return { status: "invalid" };
		let indexKey: PendingOverlayFirstRequestV1["startedRecord"]["core"]["indexKey"];
		try {
			indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(request.startedRecord.core.indexKey);
		} catch {
			return { status: "invalid" };
		}
		const key = request.version.key;
		if (
			indexKey.core.parentSessionId !== key.parentSessionId ||
			indexKey.core.parentSessionGenerationSha256 !== key.parentSessionGenerationSha256 ||
			indexKey.core.toolCallId !== key.toolCallId ||
			indexKey.core.toolName !== "task"
		)
			return { status: "invalid" };
		const preAuthority = this.#transientAuthorityStatus(
			key.parentSessionId,
			key.parentSessionGenerationSha256,
			key.preAssistantAnchorEntryId,
			key.preAssistantBranchGenerationSha256,
		);
		if (preAuthority === "session_generation_replaced") return { status: "session_generation_replaced" };
		if (preAuthority === "branch_generation_replaced") return { status: "pre_assistant_branch_replaced" };
		if (preAuthority === "branch_anchor_missing") return { status: "pre_assistant_anchor_replaced" };
		const indexAuthority = this.#transientAuthorityStatus(
			indexKey.core.parentSessionId,
			indexKey.core.parentSessionGenerationSha256,
			indexKey.core.assistantAnchorEntryId,
			indexKey.core.parentBranchGenerationSha256,
		);
		if (indexAuthority === "session_generation_replaced") return { status: "session_generation_replaced" };
		if (indexAuthority === "branch_generation_replaced") return { status: "pre_assistant_branch_replaced" };
		if (indexAuthority === "branch_anchor_missing") return { status: "pre_assistant_anchor_replaced" };
		if (!this.#assistantAnchorContainsToolCall(indexKey.core.assistantAnchorEntryId, indexKey.core.toolCallId))
			return { status: "pre_assistant_anchor_replaced" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const existing = projection.state?.overlays.find(row => row.keySha256 === key.keySha256);
			if (existing) {
				if (
					existing.versions.length === 1 &&
					detachedExactJson(existing.versions[0], request.version) &&
					detachedExactJson(existing.pendingRecord, request.startedRecord) &&
					existing.startedReceipt !== null
				)
					return {
						status: "already_recorded",
						version: existing.versions[0],
						startedRecord: request.startedRecord,
						receipt: existing.startedReceipt,
					};
				return { status: "version_conflict" };
			}
			const headCore = {
				schemaVersion: 1 as const,
				indexKeySha256: indexKey.indexKeySha256,
				nextObservationSequence: 0,
				acceptedObservationCount: 0,
				lastAcceptedObservationSha256: null,
			};
			const receiptCore = {
				schemaVersion: 1 as const,
				indexKeySha256: indexKey.indexKeySha256,
				captureKeySha256: key.keySha256,
				firstVersionSha256: request.version.versionSha256,
				startedRecordSha256: request.startedRecord.recordSha256,
				initialSourceObservationHeadSha256: canonicalTransientTaskSourceObservationDigestV1(
					"source_observation_head",
					headCore,
				),
				recordedAt: request.version.capturedAt,
			};
			const receipt = {
				core: receiptCore,
				receiptSha256: canonicalTransientTaskSourceObservationDigestV1(
					"pending_capture_started_receipt",
					receiptCore,
				),
			};
			const state = this.#draftTransientRuntimeState(projection.state, request.version.capturedAt);
			state.overlays.push({
				keySha256: key.keySha256,
				versions: [structuredClone(request.version)],
				pendingRecord: structuredClone(request.startedRecord),
				startedReceipt: receipt,
				snapshot: null,
				preDispatchBinding: null,
				anchoredBinding: null,
				terminalRequest: null,
				terminalReceipt: null,
				overlayCommitReceipt: null,
				adoptedInspectionSha256s: [],
				adoptedTerminalInspectionSha256s: [],
			});
			await this.#commitTransientRuntimeState(state);
			return { status: "recorded", version: request.version, startedRecord: request.startedRecord, receipt };
		});
	}

	async prepareSubsequentVersion(
		version: PendingOverlayVersionV1,
	): ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["prepareSubsequentVersion"]> {
		if (!validOverlayVersion(version) || version.version === 0 || version.priorVersionSha256 === null)
			return { status: "invalid" };
		const authority = this.#transientAuthorityStatus(
			version.key.parentSessionId,
			version.key.parentSessionGenerationSha256,
			version.key.preAssistantAnchorEntryId,
			version.key.preAssistantBranchGenerationSha256,
		);
		if (authority === "session_generation_replaced") return { status: "session_generation_replaced" };
		if (authority === "branch_generation_replaced") return { status: "pre_assistant_branch_replaced" };
		if (authority === "branch_anchor_missing") return { status: "pre_assistant_anchor_replaced" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const row = projection.state?.overlays.find(candidate => candidate.keySha256 === version.key.keySha256);
			if (row?.pendingRecord?.core.state !== "started" || row.snapshot || row.terminalReceipt)
				return { status: "version_conflict" };
			const existing = row.versions[version.version];
			if (existing)
				return detachedExactJson(existing, version)
					? { status: "already_recorded", version: existing }
					: { status: "version_conflict" };
			if (
				row.versions.length !== version.version ||
				row.versions[row.versions.length - 1]?.versionSha256 !== version.priorVersionSha256
			)
				return { status: "version_conflict" };
			const state = this.#draftTransientRuntimeState(projection.state, version.capturedAt);
			const draftRow = state.overlays.find(candidate => candidate.keySha256 === version.key.keySha256)!;
			draftRow.versions.push(structuredClone(version));
			const firstVersion = draftRow.versions[0];
			if (!firstVersion) return { status: "version_conflict" };
			if (draftRow.pendingRecord?.core.state !== "started") return { status: "version_conflict" };
			const pendingCore: Extract<
				ConfidentialTransientTaskPendingCaptureRecordV1,
				{ readonly core: { readonly state: "started" } }
			>["core"] = {
				...draftRow.pendingRecord.core,
				durableVersions: [firstVersion, ...draftRow.versions.slice(1)],
			};
			draftRow.pendingRecord = {
				core: pendingCore,
				recordSha256: canonicalTransientTaskSourceObservationDigestV1("pending_capture_record", pendingCore),
			};
			await this.#commitTransientRuntimeState(state);
			return { status: "recorded", version };
		});
	}

	async finalizePendingOverlay(
		request: PendingOverlayFinalizeRequestV1,
	): ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["finalizePendingOverlay"]> {
		if (
			!validOverlayKey(request.key) ||
			!detachedInteger(request.expectedFinalVersion) ||
			!detachedSha256Ref(request.expectedFinalVersionSha256) ||
			!detachedSha256Ref(request.expectedCaptureOutcomeHistorySha256) ||
			!detachedIso8601(request.finalizedAt) ||
			request.requestSha256 !== overlayFinalizeRequestDigest(request)
		)
			return { status: "invalid" };
		const authority = this.#transientAuthorityStatus(
			request.key.parentSessionId,
			request.key.parentSessionGenerationSha256,
			request.key.preAssistantAnchorEntryId,
			request.key.preAssistantBranchGenerationSha256,
		);
		if (authority === "session_generation_replaced") return { status: "session_generation_replaced" };
		if (authority === "branch_generation_replaced") return { status: "pre_assistant_branch_replaced" };
		if (authority === "branch_anchor_missing") return { status: "pre_assistant_anchor_replaced" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const row = projection.state?.overlays.find(candidate => candidate.keySha256 === request.key.keySha256);
			if (row?.pendingRecord?.core.state !== "started") return { status: "expected_capture_missing" };
			if (row.snapshot && row.preDispatchBinding) {
				return row.snapshot.finalVersion === request.expectedFinalVersion &&
					row.snapshot.finalVersionSha256 === request.expectedFinalVersionSha256 &&
					row.snapshot.captureOutcomeHistorySha256 === request.expectedCaptureOutcomeHistorySha256
					? { status: "already_finalized", snapshot: row.snapshot, binding: row.preDispatchBinding }
					: { status: "finalization_conflict" };
			}
			if (row.versions.length !== request.expectedFinalVersion + 1) return { status: "version_missing" };
			const finalVersion = row.versions[request.expectedFinalVersion];
			if (!finalVersion || finalVersion.versionSha256 !== request.expectedFinalVersionSha256)
				return { status: "version_conflict" };
			const first = row.versions[0];
			if (!first) return { status: "expected_capture_missing" };
			const orderedCaptureOutcomes = [
				first.outcome,
				...row.versions.slice(1).map(version => version.outcome),
			] as const;
			const captureOutcomeHistorySha256 = detachedUtf8Sha256Ref(JSON.stringify(orderedCaptureOutcomes));
			if (captureOutcomeHistorySha256 !== request.expectedCaptureOutcomeHistorySha256)
				return { status: "finalization_conflict" };
			const snapshotCore = {
				schemaVersion: 1 as const,
				key: request.key,
				finalVersion: request.expectedFinalVersion,
				finalVersionSha256: request.expectedFinalVersionSha256,
				orderedCaptureOutcomes,
				captureOutcomeHistorySha256,
				finalCaptureOutcomeSha256: finalVersion.outcome.outcomeSha256,
				overlaySnapshot: finalVersion.outcome.overlaySnapshot,
				finalizedAt: request.finalizedAt,
			};
			const snapshot = {
				...snapshotCore,
				pendingOverlaySnapshotSha256: overlaySnapshotDigest(snapshotCore),
			};
			const bindingCore = {
				keySha256: request.key.keySha256,
				finalVersion: snapshot.finalVersion,
				finalVersionSha256: snapshot.finalVersionSha256,
				captureOutcomeHistorySha256: snapshot.captureOutcomeHistorySha256,
				finalCaptureOutcomeSha256: snapshot.finalCaptureOutcomeSha256,
				pendingOverlaySnapshotSha256: snapshot.pendingOverlaySnapshotSha256,
			};
			const binding = { ...bindingCore, bindingSha256: overlayPreDispatchBindingDigest(bindingCore) };
			const state = this.#draftTransientRuntimeState(projection.state, request.finalizedAt);
			const draftRow = state.overlays.find(candidate => candidate.keySha256 === request.key.keySha256)!;
			draftRow.snapshot = snapshot;
			draftRow.preDispatchBinding = binding;
			if (draftRow.pendingRecord?.core.state !== "started") return { status: "expected_capture_missing" };
			const pendingCore: Extract<
				ConfidentialTransientTaskPendingCaptureRecordV1,
				{ readonly core: { readonly state: "finalized_unanchored" } }
			>["core"] = {
				...draftRow.pendingRecord.core,
				state: "finalized_unanchored",
				durableVersions: [first, ...draftRow.versions.slice(1)],
				finalizedSnapshot: snapshot,
				preDispatchBinding: binding,
				anchoredBinding: null,
			};
			draftRow.pendingRecord = {
				core: pendingCore,
				recordSha256: canonicalTransientTaskSourceObservationDigestV1("pending_capture_record", pendingCore),
			};
			await this.#commitTransientRuntimeState(state);
			return { status: "finalized", snapshot, binding };
		});
	}

	async inspectPendingOverlay(
		request: PendingOverlayInspectRequestV1,
	): ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["inspectPendingOverlay"]> {
		if (
			!validOverlayKey(request.key) ||
			!detachedIso8601(request.requestedAt) ||
			request.requestSha256 !== overlayInspectRequestDigest(request)
		)
			return { status: "invalid" };
		const authority = this.#transientAuthorityStatus(
			request.key.parentSessionId,
			request.key.parentSessionGenerationSha256,
			request.key.preAssistantAnchorEntryId,
			request.key.preAssistantBranchGenerationSha256,
		);
		if (authority === "session_generation_replaced") return { status: "session_generation_replaced" };
		if (authority === "branch_generation_replaced") return { status: "pre_assistant_branch_replaced" };
		if (authority === "branch_anchor_missing") return { status: "pre_assistant_anchor_replaced" };
		const projection = this.#transientRuntimeStateProjection();
		if (!projection.valid) return { status: "invalid" };
		const row = projection.state?.overlays.find(candidate => candidate.keySha256 === request.key.keySha256);
		if (!row) return { status: "absent" };
		if (!row.snapshot || !row.preDispatchBinding) return { status: "version_conflict" };
		if (!detachedExactJson(row.preDispatchBinding, request.expectedBinding)) return { status: "binding_conflict" };
		return {
			status: "matching",
			snapshot: row.snapshot,
			binding: row.preDispatchBinding,
			inspectedAt: request.requestedAt,
			inspectionSha256: overlayInspectionDigest(request, row.snapshot, row.preDispatchBinding),
		};
	}

	async adoptPendingOverlay(
		request: PendingOverlayAdoptRequestV1,
	): ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["adoptPendingOverlay"]> {
		if (
			!detachedIso8601(request.requestedAt) ||
			request.expectedInspectionSha256 !== request.inspection.inspectionSha256 ||
			request.requestSha256 !== overlayAdoptRequestDigest(request)
		)
			return { status: "invalid" };
		const inspected = await this.inspectPendingOverlay({
			key: request.inspection.snapshot.key,
			expectedBinding: request.inspection.binding,
			requestedAt: request.inspection.inspectedAt,
			requestSha256: overlayInspectRequestDigest({
				key: request.inspection.snapshot.key,
				expectedBinding: request.inspection.binding,
				requestedAt: request.inspection.inspectedAt,
				requestSha256: request.inspection.snapshot.pendingOverlaySnapshotSha256,
			}),
		});
		if (inspected.status !== "matching" || inspected.inspectionSha256 !== request.expectedInspectionSha256)
			return { status: "inspection_stale" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const row = projection.state?.overlays.find(
				candidate => candidate.keySha256 === request.inspection.snapshot.key.keySha256,
			);
			if (!row?.snapshot || !row.preDispatchBinding) return { status: "inspection_stale" };
			const already = row.adoptedInspectionSha256s.includes(request.expectedInspectionSha256);
			if (!already) {
				const state = this.#draftTransientRuntimeState(projection.state, request.requestedAt);
				state.overlays
					.find(candidate => candidate.keySha256 === request.inspection.snapshot.key.keySha256)!
					.adoptedInspectionSha256s.push(request.expectedInspectionSha256);
				await this.#commitTransientRuntimeState(state);
			}
			return {
				status: already ? "already_adopted" : "adopted",
				snapshot: row.snapshot,
				binding: row.preDispatchBinding,
				adoptedAt: request.requestedAt,
				receiptSha256: detachedTupleSha256Ref([
					"omp-transient-task-foreground-settlement-v1",
					"pending-ttsr-adoption",
					1,
					request.inspection,
					request.expectedInspectionSha256,
					request.requestedAt,
				]),
			};
		});
	}

	async bindPendingOverlayToAssistantAnchor(
		request: PendingOverlayAnchorBindRequestV1,
	): ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["bindPendingOverlayToAssistantAnchor"]> {
		if (
			!detachedIso8601(request.requestedAt) ||
			!detachedIdentity(request.parentBranchAnchorEntryId) ||
			!detachedIdentity(request.toolCallId) ||
			request.requestSha256 !== overlayAnchorBindRequestDigest(request) ||
			!detachedExactJson(request.snapshot.key, request.snapshot.key) ||
			request.snapshot.pendingOverlaySnapshotSha256 !== request.preDispatchBinding.pendingOverlaySnapshotSha256
		)
			return { status: "invalid" };
		const authority = this.#transientAuthorityStatus(
			request.snapshot.key.parentSessionId,
			request.snapshot.key.parentSessionGenerationSha256,
			request.parentBranchAnchorEntryId,
			request.parentBranchGenerationSha256,
		);
		if (authority === "session_generation_replaced") return { status: "session_generation_replaced" };
		if (authority === "branch_generation_replaced") return { status: "branch_generation_replaced" };
		if (authority === "branch_anchor_missing") return { status: "assistant_anchor_missing" };
		if (!this.#assistantAnchorContainsToolCall(request.parentBranchAnchorEntryId, request.toolCallId))
			return { status: "assistant_anchor_tool_call_missing" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const row = projection.state?.overlays.find(
				candidate => candidate.keySha256 === request.snapshot.key.keySha256,
			);
			if (
				!row?.snapshot ||
				!row.preDispatchBinding ||
				!row.pendingRecord ||
				row.pendingRecord.core.state !== "finalized_unanchored" ||
				!detachedExactJson(row.snapshot, request.snapshot) ||
				!detachedExactJson(row.preDispatchBinding, request.preDispatchBinding)
			)
				return { status: "binding_conflict" };
			const bindingCore = {
				preDispatchBinding: request.preDispatchBinding,
				parentBranchGenerationSha256: request.parentBranchGenerationSha256,
				parentBranchAnchorEntryId: request.parentBranchAnchorEntryId,
			};
			const binding = { ...bindingCore, bindingSha256: overlayBindingDigest(bindingCore) };
			if (row.anchoredBinding) {
				return detachedExactJson(row.anchoredBinding, binding)
					? {
							status: "already_bound",
							snapshot: row.snapshot,
							binding: row.anchoredBinding,
							boundAt: request.requestedAt,
							receiptSha256: request.requestSha256,
						}
					: { status: "binding_conflict" };
			}
			const state = this.#draftTransientRuntimeState(projection.state, request.requestedAt);
			const draftRow = state.overlays.find(candidate => candidate.keySha256 === request.snapshot.key.keySha256)!;
			draftRow.anchoredBinding = binding;
			if (draftRow.pendingRecord?.core.state !== "finalized_unanchored") return { status: "binding_conflict" };
			const pendingCore: Extract<
				ConfidentialTransientTaskPendingCaptureRecordV1,
				{ readonly core: { readonly state: "anchored" } }
			>["core"] = {
				...draftRow.pendingRecord.core,
				state: "anchored",
				finalizedSnapshot: row.snapshot,
				preDispatchBinding: row.preDispatchBinding,
				anchoredBinding: binding,
			};
			draftRow.pendingRecord = {
				core: pendingCore,
				recordSha256: canonicalTransientTaskSourceObservationDigestV1("pending_capture_record", pendingCore),
			};
			await this.#commitTransientRuntimeState(state);
			return {
				status: "bound",
				snapshot: row.snapshot,
				binding,
				boundAt: request.requestedAt,
				receiptSha256: request.requestSha256,
			};
		});
	}

	async recordCaptureTerminal(
		request: PendingOverlayTerminalRequestV1,
	): ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["recordCaptureTerminal"]> {
		if (
			!validOverlayKey(request.core.key) ||
			!detachedIso8601(request.core.requestedAt) ||
			request.core.observation.observationSha256 !== captureTerminalObservationDigest(request) ||
			request.core.disposition.dispositionSha256 !== captureTerminalDispositionDigest(request) ||
			request.requestSha256 !== captureTerminalRequestDigest(request)
		)
			return { status: "invalid" };
		const authority = this.#transientAuthorityStatus(
			request.core.key.parentSessionId,
			request.core.key.parentSessionGenerationSha256,
			request.core.key.preAssistantAnchorEntryId,
			request.core.key.preAssistantBranchGenerationSha256,
		);
		if (authority === "session_generation_replaced") return { status: "session_generation_replaced" };
		if (authority !== "matching") return { status: "pre_assistant_branch_replaced" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const row = projection.state?.overlays.find(candidate => candidate.keySha256 === request.core.key.keySha256);
			if (!row) return { status: "observation_conflict" };
			if (row.terminalReceipt && row.terminalRequest) {
				return detachedExactJson(row.terminalRequest, request)
					? { status: "already_recorded", receipt: row.terminalReceipt }
					: { status: "disposition_conflict" };
			}
			if (
				!detachedExactJson(request.core.observation.core.orderedPreparedVersions, row.versions) ||
				!detachedExactJson(request.core.observation.core.finalizedSnapshot, row.snapshot) ||
				!detachedExactJson(request.core.observation.core.preDispatchBinding, row.preDispatchBinding)
			)
				return { status: "observation_conflict" };
			const primaryReceiptSha256 = request.core.primaryPersistenceReceipt.primaryReceiptSha256;
			const primaryExists = projection.state?.primaryCommits.some(
				commit =>
					commit.commitReceipt?.core.primaryPersistenceReceipt.primaryReceiptSha256 === primaryReceiptSha256,
			);
			if (!primaryExists) return { status: "primary_receipt_missing" };
			const sourceReceipt = request.core.disposition.core.sourceObservationReceipt;
			if (
				sourceReceipt.receiptSha256 !==
				request.core.sourceObservationAdoption.acceptedRow.core.observationReceipt.receiptSha256
			)
				return { status: "observation_conflict" };
			const receiptCore = {
				schemaVersion: 1 as const,
				keySha256: request.core.key.keySha256,
				requestSha256: request.requestSha256,
				observationSha256: request.core.observation.observationSha256,
				dispositionSha256: request.core.disposition.dispositionSha256,
				sourceObservationReceiptSha256: sourceReceipt.receiptSha256,
				sourceObservationAdoptionReceiptSha256:
					request.core.sourceObservationAdoption.acceptedRow.acceptedRowSha256,
				primaryPersistenceReceiptSha256: primaryReceiptSha256,
				finalVersionSha256: row.snapshot?.finalVersionSha256 ?? null,
				pendingOverlaySnapshotSha256: row.snapshot?.pendingOverlaySnapshotSha256 ?? null,
				releasedProvisionalClaimSha256s: [...request.core.orderedProvisionalClaimSha256sToRelease],
				terminalizedAt: request.core.requestedAt,
			};
			const receipt = { core: receiptCore, receiptSha256: captureTerminalReceiptDigest(receiptCore) };
			const state = this.#draftTransientRuntimeState(projection.state, request.core.requestedAt);
			const draftRow = state.overlays.find(candidate => candidate.keySha256 === request.core.key.keySha256)!;
			draftRow.terminalRequest = structuredClone(request);
			draftRow.terminalReceipt = receipt;
			await this.#commitTransientRuntimeState(state);
			return { status: "recorded", receipt };
		});
	}

	async inspectCaptureTerminal(
		request: PendingOverlayTerminalInspectRequestV1,
	): ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["inspectCaptureTerminal"]> {
		if (
			!validOverlayKey(request.core.key) ||
			!detachedIso8601(request.core.requestedAt) ||
			request.requestSha256 !== captureTerminalInspectRequestDigest(request)
		)
			return { status: "invalid" };
		const projection = this.#transientRuntimeStateProjection();
		if (!projection.valid) return { status: "invalid" };
		const row = projection.state?.overlays.find(candidate => candidate.keySha256 === request.core.key.keySha256);
		if (!row?.terminalRequest || !row.terminalReceipt) {
			return {
				status: "absent",
				inspectionSha256: detachedTupleSha256Ref([
					"omp-transient-task-capture-terminal-v1",
					"inspection",
					1,
					request,
					"absent",
				]),
			};
		}
		if (row.terminalRequest.requestSha256 !== request.core.expectedTerminalRequestSha256)
			return { status: "conflict" };
		return {
			status: "matching",
			terminalRequest: row.terminalRequest,
			receipt: row.terminalReceipt,
			inspectedAt: request.core.requestedAt,
			inspectionSha256: detachedTupleSha256Ref([
				"omp-transient-task-capture-terminal-v1",
				"inspection",
				1,
				request,
				"matching",
				row.terminalRequest,
				row.terminalReceipt,
			]),
		};
	}

	async adoptCaptureTerminal(
		request: PendingOverlayTerminalAdoptRequestV1,
	): ReturnType<TransientTaskForegroundPendingTtsrOverlayStoreV1["adoptCaptureTerminal"]> {
		if (
			!detachedIso8601(request.core.requestedAt) ||
			request.core.expectedInspectionSha256 !== request.core.inspection.inspectionSha256 ||
			request.requestSha256 !== captureTerminalAdoptRequestDigest(request)
		)
			return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const row = projection.state?.overlays.find(
				candidate => candidate.keySha256 === request.core.inspection.terminalRequest.core.key.keySha256,
			);
			if (
				!row?.terminalRequest ||
				!row.terminalReceipt ||
				!detachedExactJson(row.terminalRequest, request.core.inspection.terminalRequest) ||
				!detachedExactJson(row.terminalReceipt, request.core.inspection.receipt)
			)
				return { status: "inspection_stale" };
			const already = row.adoptedTerminalInspectionSha256s.includes(request.core.expectedInspectionSha256);
			if (!already) {
				const state = this.#draftTransientRuntimeState(projection.state, request.core.requestedAt);
				state.overlays
					.find(candidate => candidate.keySha256 === row.keySha256)!
					.adoptedTerminalInspectionSha256s.push(request.core.expectedInspectionSha256);
				await this.#commitTransientRuntimeState(state);
			}
			return { status: already ? "already_adopted" : "adopted", receipt: row.terminalReceipt };
		});
	}

	/** Persists an exact foreground TTSR overlay receipt only after the general primary append is durable. */
	async commitForegroundOverlayAfterPrimaryPersistence(
		snapshot: ConfidentialTransientTaskForegroundTtsrOverlaySnapshotV1,
		renderedGate: ConfidentialTransientTaskForegroundRenderedGateV1,
		injectionAppendReceipt: ConfidentialTransientTaskForegroundTtsrInjectionAppendReceiptV1,
		primaryReceipt: ConfidentialAgentSessionToolResultPrimaryPersistenceReceiptV1,
	): Promise<TransientTaskForegroundTtsrOverlayCommitResultV1> {
		if (
			!detachedCanonicalData(snapshot) ||
			!detachedCanonicalData(renderedGate) ||
			!detachedCanonicalData(injectionAppendReceipt) ||
			!detachedCanonicalData(primaryReceipt) ||
			!validateTransientTaskHubWaitMessageCanonicalRecordV1("foreground-ttsr-overlay-snapshot", snapshot) ||
			!isForegroundPrimaryPersistenceReceiptV1(primaryReceipt) ||
			primaryReceipt.core.schemaVersion !== 1 ||
			primaryReceipt.primaryReceiptSha256 !== primaryPersistenceReceiptDigest(primaryReceipt) ||
			injectionAppendReceipt.receiptSha256 !== injectionAppendReceiptDigest(injectionAppendReceipt.core)
		)
			return { status: "invalid" };
		if (!validForegroundRenderedGateForOverlay(renderedGate, snapshot)) return { status: "gate_conflict" };
		if (
			(injectionAppendReceipt.core.disposition === "no_entry" &&
				(injectionAppendReceipt.core.transitionReceipt !== null || injectionAppendReceipt.core.entry !== null)) ||
			(injectionAppendReceipt.core.disposition === "exact_entry" &&
				(injectionAppendReceipt.core.transitionReceipt.transitionReceiptSha256 !==
					injectionAppendTransitionDigest(injectionAppendReceipt.core.transitionReceipt.core) ||
					injectionAppendReceipt.core.transitionReceipt.core.requestSha256 !==
						injectionAppendReceipt.core.requestSha256 ||
					injectionAppendReceipt.core.transitionReceipt.core.attemptSha256 !==
						injectionAppendReceipt.core.attemptSha256))
		)
			return { status: "invalid" };

		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" } as const;
			const runtime = projection.state;
			const primaryRows =
				runtime?.primaryCommits.filter(
					row =>
						row.commitReceipt?.core.primaryPersistenceReceipt.primaryReceiptSha256 ===
						primaryReceipt.primaryReceiptSha256,
				) ?? [];
			if (primaryRows.length === 0) return { status: "primary_receipt_missing" } as const;
			if (primaryRows.length !== 1) return { status: "invalid" } as const;
			const primaryRow = primaryRows[0];
			const commitReceipt = primaryRow.commitReceipt;
			if (
				primaryRow.status !== "committed" ||
				!commitReceipt ||
				commitReceipt.core.route !== "task_foreground_delivery" ||
				commitReceipt.commitReceiptSha256 !== primaryCommitReceiptDigest(commitReceipt.core) ||
				!detachedExactJson(commitReceipt.core.primaryPersistenceReceipt, primaryReceipt) ||
				primaryRow.attempt.attemptSha256 !== primaryAttemptDigest(primaryRow.attempt) ||
				!primaryRow.transitionReceipt ||
				primaryRow.transitionReceipt.transitionReceiptSha256 !==
					primaryTransitionDigest(primaryRow.transitionReceipt.core) ||
				commitReceipt.core.requestSha256 !== primaryRow.attempt.core.request.requestSha256 ||
				commitReceipt.core.attemptSha256 !== primaryRow.attempt.attemptSha256 ||
				commitReceipt.core.transitionReceiptSha256 !== primaryRow.transitionReceipt.transitionReceiptSha256
			)
				return { status: "invalid" } as const;

			const request = primaryRow.attempt.core.request;
			if (
				request.core.route !== "task_foreground_delivery" ||
				request.requestSha256 !== primaryRequestDigest(request) ||
				primaryReceipt.core.requestSha256 !== request.requestSha256 ||
				primaryReceipt.core.transitionReceiptSha256 !== primaryRow.transitionReceipt.transitionReceiptSha256
			)
				return { status: "invalid" } as const;
			const physicalPlan = this.#primaryRoutePhysicalPlan(request);
			if (!physicalPlan) return { status: "invalid" } as const;
			for (const candidate of physicalPlan.candidates) {
				const physical = this.#index.get(candidate.id);
				if (!physical || !detachedExactJson(physical, candidate)) return { status: "entry_conflict" } as const;
			}

			const batch = request.core.foregroundAppendBatch;
			const injectionRequest = request.core.injectionAppendRequest;
			if (
				batch.foregroundAppendBatchKeySha256 !== renderedGate.foregroundAppendBatchKeySha256 ||
				!detachedExactJson(batch.renderedResult, renderedGate.renderedResult) ||
				!detachedExactJson(batch.injectionAppendRequest, injectionRequest) ||
				!detachedExactJson(injectionRequest.core.contentPlan, renderedGate.ttsrInjectionContentPlan)
			)
				return { status: "gate_conflict" } as const;
			if (
				injectionRequest.requestSha256 !== injectionAppendRequestDigest(injectionRequest) ||
				injectionAppendReceipt.core.requestSha256 !== injectionRequest.requestSha256 ||
				!detachedExactJson(primaryReceipt.core.injectionAppendReceipt, injectionAppendReceipt) ||
				injectionRequest.core.disposition !== injectionAppendReceipt.core.disposition ||
				!detachedExactJson(injectionRequest.core.entry, injectionAppendReceipt.core.entry)
			)
				return { status: "entry_conflict" } as const;

			const injectionRows =
				runtime?.injectionAppends.filter(row => row.requestSha256 === injectionRequest.requestSha256) ?? [];
			if (injectionRows.length !== 1) return { status: "entry_conflict" } as const;
			const injectionRow = injectionRows[0];
			if (
				injectionRow.status !== "committed" ||
				!injectionRow.receipt ||
				injectionRow.attempt.attemptSha256 !== injectionAppendReceipt.core.attemptSha256 ||
				injectionRow.attempt.attemptSha256 !== injectionAppendAttemptDigest(injectionRow.attempt) ||
				!detachedExactJson(injectionRow.attempt.core.request, injectionRequest) ||
				!detachedExactJson(injectionRow.receipt, injectionAppendReceipt) ||
				!detachedExactJson(injectionRow.transitionReceipt, injectionAppendReceipt.core.transitionReceipt)
			)
				return { status: "entry_conflict" } as const;

			const foregroundReceipt = primaryReceipt.core.foregroundPrimaryReceipt;
			if (
				foregroundReceipt.primaryReceiptSha256 !== foregroundSessionAppendReceiptDigest(foregroundReceipt) ||
				foregroundReceipt.foregroundAppendBatchKeySha256 !== batch.foregroundAppendBatchKeySha256 ||
				foregroundReceipt.appendBatchSha256 !== batch.appendBatchSha256 ||
				foregroundReceipt.injectionAppendReceiptSha256 !== injectionAppendReceipt.receiptSha256 ||
				!detachedExactJson(foregroundReceipt.entry, batch.entry) ||
				foregroundReceipt.toolResultMessageUtf8 !== JSON.stringify(batch.entry.message) ||
				foregroundReceipt.toolResultMessageUtf8Sha256 !==
					detachedUtf8Sha256Ref(foregroundReceipt.toolResultMessageUtf8) ||
				foregroundReceipt.toolResultMessageUtf8ByteLength !==
					Buffer.byteLength(foregroundReceipt.toolResultMessageUtf8, "utf8") ||
				primaryReceipt.core.nextPriorLeafEntryId !== foregroundReceipt.entry.id ||
				primaryReceipt.core.committedAt !== foregroundReceipt.committedAt
			)
				return { status: "entry_conflict" } as const;
			const appendRows =
				runtime?.foregroundAppends.filter(
					row => row.request.foregroundAppendBatchKeySha256 === batch.foregroundAppendBatchKeySha256,
				) ?? [];
			if (appendRows.length !== 1) return { status: "entry_conflict" } as const;
			const appendRow = appendRows[0];
			if (
				appendRow.request.sessionAppendRequestSha256 !== foregroundSessionAppendRequestDigest(appendRow.request) ||
				!detachedExactJson(appendRow.receipt, foregroundReceipt) ||
				!detachedExactJson(appendRow.request.entry, batch.entry) ||
				appendRow.request.injectionAppendRequestSha256 !== injectionRequest.requestSha256 ||
				appendRow.request.toolCallId !== snapshot.toolCallId
			)
				return { status: "entry_conflict" } as const;

			const beforeReturnRows =
				runtime?.beforeReturnRows.filter(
					row => row.recoveryKey.foregroundAppendBatchKeySha256 === batch.foregroundAppendBatchKeySha256,
				) ?? [];
			if (beforeReturnRows.length !== 1) return { status: "snapshot_conflict" } as const;
			const beforeReturnRow = beforeReturnRows[0];
			if (
				!beforeReturnRow.handoffBatch ||
				!detachedExactJson(beforeReturnRow.handoffBatch, batch.handoffBatch) ||
				!beforeReturnHandoffMatchesRecord(
					beforeReturnRow.handoffBatch,
					beforeReturnRow.record,
					beforeReturnRow.recoveryKey,
				) ||
				beforeReturnRow.record.batchKeyInput.toolCallId !== snapshot.toolCallId ||
				beforeReturnRow.record.pendingOverlayBinding.bindingSha256 !==
					batch.handoffBatch.pendingOverlayBinding.bindingSha256
			)
				return { status: "snapshot_conflict" } as const;
			const beforeReturnOverlay = this.#beforeReturnOverlay(beforeReturnRow.record, runtime);
			if (beforeReturnOverlay.status !== "matching") return { status: "snapshot_conflict" } as const;
			const overlayRows =
				runtime?.overlays.filter(
					row =>
						row.anchoredBinding?.bindingSha256 === beforeReturnRow.record.pendingOverlayBinding.bindingSha256,
				) ?? [];
			if (overlayRows.length !== 1) return { status: "snapshot_conflict" } as const;
			const overlayRow = overlayRows[0];
			const pendingSnapshot = beforeReturnOverlay.snapshot;
			const finalOutcome = pendingSnapshot.orderedCaptureOutcomes.at(-1);
			const {
				pendingOverlaySnapshotSha256: _pendingOverlaySnapshotSha256,
				...pendingSnapshotCore
			} = pendingSnapshot;
			if (
				!validOverlayKey(pendingSnapshot.key) ||
				pendingSnapshot.key.toolCallId !== snapshot.toolCallId ||
				pendingSnapshot.pendingOverlaySnapshotSha256 !== overlaySnapshotDigest(pendingSnapshotCore) ||
				pendingSnapshot.captureOutcomeHistorySha256 !==
					detachedUtf8Sha256Ref(JSON.stringify(pendingSnapshot.orderedCaptureOutcomes)) ||
				pendingSnapshot.finalVersion !== pendingSnapshot.orderedCaptureOutcomes.length - 1 ||
				!finalOutcome ||
				finalOutcome.outcomeSha256 !== pendingSnapshot.finalCaptureOutcomeSha256 ||
				!detachedExactJson(finalOutcome.overlaySnapshot, snapshot) ||
				!detachedExactJson(pendingSnapshot.overlaySnapshot, snapshot) ||
				!detachedExactJson(overlayRow.snapshot, pendingSnapshot)
			)
				return { status: "snapshot_conflict" } as const;

			const common = {
				schemaVersion: 1 as const,
				preOverlayGateSha256: renderedGate.preOverlayGateSha256,
				renderedGateSha256: renderedGate.renderedGateSha256,
				overlaySnapshotSha256: snapshot.snapshotSha256,
				pendingOverlaySnapshotSha256: pendingSnapshot.pendingOverlaySnapshotSha256,
				pendingOverlayFinalVersion: pendingSnapshot.finalVersion,
				pendingOverlayFinalVersionSha256: pendingSnapshot.finalVersionSha256,
				pendingOverlayCaptureOutcomeHistorySha256: pendingSnapshot.captureOutcomeHistorySha256,
				pendingOverlayFinalCaptureOutcomeSha256: pendingSnapshot.finalCaptureOutcomeSha256,
				injectionContentPlanSha256: renderedGate.ttsrInjectionContentPlan.contentPlanSha256,
				injectionAppendRequestSha256: injectionRequest.requestSha256,
				injectionAppendReceiptSha256: injectionAppendReceipt.receiptSha256,
				primaryPersistenceReceiptSha256: primaryReceipt.primaryReceiptSha256,
				committedAt: primaryReceipt.core.committedAt,
			};
			let receiptCore: ForegroundOverlayCommitReceiptCoreV1;
			if (renderedGate.ttsrInjectionContentPlan.disposition === "no_entry") {
				if (
					injectionRequest.core.disposition !== "no_entry" ||
					injectionAppendReceipt.core.disposition !== "no_entry"
				)
					return { status: "entry_conflict" } as const;
				receiptCore = {
					...common,
					disposition: "no_entry",
					injectedRuleNames: [],
					ttsrInjectionEntry: null,
				};
			} else {
				if (
					injectionRequest.core.disposition !== "exact_entry" ||
					injectionAppendReceipt.core.disposition !== "exact_entry" ||
					!detachedExactJson(
						renderedGate.ttsrInjectionContentPlan.injectedRuleNames,
						injectionAppendReceipt.core.entry.injectedRules,
					) ||
					!detachedExactJson(injectionRequest.core.entry, injectionAppendReceipt.core.entry)
				)
					return { status: "entry_conflict" } as const;
				receiptCore = {
					...common,
					disposition: "exact_entry",
					injectedRuleNames: renderedGate.ttsrInjectionContentPlan.injectedRuleNames,
					ttsrInjectionEntry: injectionAppendReceipt.core.entry,
				};
			}
			const receipt: ConfidentialTransientTaskForegroundTtsrOverlayCommitReceiptV1 = {
				...receiptCore,
				receiptSha256: foregroundOverlayCommitReceiptDigest(receiptCore),
			};
			const existing = overlayRow.overlayCommitReceipt ?? null;
			if (existing) {
				if (existing.receiptSha256 !== foregroundOverlayCommitReceiptDigest(existing)) {
					return { status: "invalid" } as const;
				}
				if (detachedExactJson(existing, receipt)) return { status: "already_committed", receipt: existing } as const;
				if (
					existing.overlaySnapshotSha256 !== receipt.overlaySnapshotSha256 ||
					existing.pendingOverlaySnapshotSha256 !== receipt.pendingOverlaySnapshotSha256 ||
					existing.pendingOverlayFinalVersion !== receipt.pendingOverlayFinalVersion ||
					existing.pendingOverlayFinalVersionSha256 !== receipt.pendingOverlayFinalVersionSha256 ||
					existing.pendingOverlayCaptureOutcomeHistorySha256 !==
						receipt.pendingOverlayCaptureOutcomeHistorySha256 ||
					existing.pendingOverlayFinalCaptureOutcomeSha256 !== receipt.pendingOverlayFinalCaptureOutcomeSha256
				)
					return { status: "snapshot_conflict" } as const;
				if (
					existing.preOverlayGateSha256 !== receipt.preOverlayGateSha256 ||
					existing.renderedGateSha256 !== receipt.renderedGateSha256 ||
					existing.injectionContentPlanSha256 !== receipt.injectionContentPlanSha256
				)
					return { status: "gate_conflict" } as const;
				return { status: "entry_conflict" } as const;
			}

			const state = this.#draftTransientRuntimeState(runtime, receipt.committedAt);
			const draftOverlay = state.overlays.find(row => row.keySha256 === overlayRow.keySha256);
			if (!draftOverlay || draftOverlay.overlayCommitReceipt) return { status: "snapshot_conflict" } as const;
			draftOverlay.overlayCommitReceipt = structuredClone(receipt);
			await this.#commitTransientRuntimeState(state);
			return { status: "committed", receipt } as const;
		});
	}

	async prepareLifecycleGate(
		request: LifecyclePrepareRequestV1,
	): ReturnType<TransientTaskLifecycleGateStoreV1["prepareLifecycleGate"]> {
		if (!validLifecyclePrepareRequest(request)) return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const expected = lifecyclePreparedStateForRequest(request);
			const existing = projection.state?.lifecycleStates.find(
				state => state.core.key.keySha256 === request.core.key.keySha256,
			);
			if (existing) {
				if (!lifecyclePreparedState(existing)) return { status: "state_conflict" };
				return existing.stateSha256 === expected.stateSha256 && detachedExactJson(existing, expected)
					? { status: "already_prepared", state: existing }
					: { status: "state_conflict" };
			}
			const pending = projection.state?.overlays.find(
				row => row.pendingRecord?.recordSha256 === request.core.pendingCaptureRecordSha256,
			);
			if (!pending?.pendingRecord) return { status: "pending_conflict" };
			if (
				request.core.acceptedObservation.observationSha256 !== request.core.key.core.observationSha256 ||
				request.core.observationReceipt.receiptSha256 !== request.core.key.core.observationReceiptSha256
			)
				return { status: "observation_conflict" };
			const runtime = this.#draftTransientRuntimeState(projection.state, request.core.gateResultRecordedAt);
			runtime.lifecycleStates.push(expected);
			await this.#commitTransientRuntimeState(runtime);
			return { status: "prepared", state: expected };
		});
	}

	async enumerateLifecycleGates(
		request: LifecycleEnumerateRequestV1,
	): ReturnType<TransientTaskLifecycleGateStoreV1["enumerateLifecycleGates"]> {
		if (!detachedIso8601(request.requestedAt) || request.requestSha256 !== lifecycleEnumerateRequestDigest(request))
			return { status: "invalid" };
		let indexKey: LifecycleEnumerateRequestV1["indexKey"];
		try {
			indexKey = decodeTransientTaskPendingCaptureIndexKeyV1(request.indexKey);
		} catch {
			return { status: "invalid" };
		}
		if (
			indexKey.core.parentSessionId !== request.parentSessionId ||
			indexKey.core.parentSessionGenerationSha256 !== request.parentSessionGenerationSha256 ||
			indexKey.core.parentBranchGenerationSha256 !== request.parentBranchGenerationSha256 ||
			indexKey.core.assistantAnchorEntryId !== request.parentBranchAnchorEntryId
		)
			return { status: "invalid" };
		if (
			this.#transientAuthorityStatus(
				request.parentSessionId,
				request.parentSessionGenerationSha256,
				request.parentBranchAnchorEntryId,
				request.parentBranchGenerationSha256,
			) !== "matching"
		)
			return { status: "session_generation_replaced" };
		const projection = this.#transientRuntimeStateProjection();
		if (!projection.valid) return { status: "invalid" };
		const matching =
			projection.state?.lifecycleStates.filter(
				state =>
					state.core.key.core.indexKeySha256 === indexKey.indexKeySha256 && state.core.state !== "terminalized",
			) ?? [];
		const ordinals = new Set<number>();
		for (const state of matching) {
			if (ordinals.has(state.core.key.core.lifecycleOrdinal)) return { status: "duplicate_conflict" };
			ordinals.add(state.core.key.core.lifecycleOrdinal);
		}
		const unresolved = matching
			.map(state => ({
				keySha256: state.core.key.keySha256,
				stateSha256: state.stateSha256,
				lifecycleOrdinal: state.core.key.core.lifecycleOrdinal,
			}))
			.sort((left, right) => left.lifecycleOrdinal - right.lifecycleOrdinal);
		const core = {
			schemaVersion: 1 as const,
			status: "matching" as const,
			enumerateRequest: request,
			unresolved,
			inspectedAt: request.requestedAt,
		};
		return {
			status: "matching",
			inspection: { core, inspectionSha256: lifecycleEnumerationInspectionDigest(request, unresolved) },
		};
	}

	async inspectLifecycleGate(
		request: LifecycleInspectRequestV1,
	): ReturnType<TransientTaskLifecycleGateStoreV1["inspectLifecycleGate"]> {
		if (
			request.schemaVersion !== 1 ||
			!detachedInteger(request.memberIndex) ||
			!detachedIso8601(request.requestedAt) ||
			request.requestSha256 !== lifecycleInspectRequestDigest(request) ||
			request.enumerationInspection.inspectionSha256 !==
				lifecycleEnumerationInspectionDigest(
					request.enumerationInspection.core.enumerateRequest,
					request.enumerationInspection.core.unresolved,
				)
		)
			return { status: "invalid" };
		const member = request.enumerationInspection.core.unresolved[request.memberIndex];
		const projection = this.#transientRuntimeStateProjection();
		if (!projection.valid) return { status: "invalid" };
		if (!member) {
			const core = {
				schemaVersion: 1 as const,
				inspectRequest: request,
				status: "absent" as const,
				keySha256: null,
				stateSha256: null,
			};
			return {
				status: "absent",
				inspection: { core, inspectionSha256: lifecycleInspectionDigest(request, null) },
			};
		}
		const state = projection.state?.lifecycleStates.find(
			candidate => candidate.core.key.keySha256 === member.keySha256,
		);
		if (!state) return { status: "enumeration_stale" };
		if (state.stateSha256 !== member.stateSha256) return { status: "state_conflict" };
		const core = {
			schemaVersion: 1 as const,
			inspectRequest: request,
			status: "matching" as const,
			keySha256: member.keySha256,
			stateSha256: member.stateSha256,
		};
		return { status: "matching", inspection: { core, inspectionSha256: lifecycleInspectionDigest(request, state) } };
	}

	async adoptLifecycleGate(
		request: LifecycleAdoptRequestV1,
	): ReturnType<TransientTaskLifecycleGateStoreV1["adoptLifecycleGate"]> {
		if (
			!detachedIso8601(request.adoptedAt) ||
			request.expectedInspectionSha256 !== request.inspection.inspectionSha256 ||
			request.requestSha256 !== lifecycleAdoptRequestDigest(request)
		)
			return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const state = projection.state?.lifecycleStates.find(
				candidate => candidate.core.key.keySha256 === request.inspection.core.keySha256,
			);
			if (!state || state.stateSha256 !== request.inspection.core.stateSha256) return { status: "inspection_stale" };
			const already = projection.state?.lifecycleAdoptions.includes(request.requestSha256) ?? false;
			if (!already) {
				const runtime = this.#draftTransientRuntimeState(projection.state, request.adoptedAt);
				runtime.lifecycleAdoptions.push(request.requestSha256);
				await this.#commitTransientRuntimeState(runtime);
			}
			return { status: already ? "already_adopted" : "adopted", state };
		});
	}

	async resumeLifecycleGate(
		request: LifecycleResumeRequestV1,
	): ReturnType<TransientTaskLifecycleGateStoreV1["resumeLifecycleGate"]> {
		if (!detachedIso8601(request.core.resumedAt) || request.requestSha256 !== lifecycleResumeRequestDigest(request))
			return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const existing = projection.state?.lifecycleStates.find(
				state => state.stateSha256 === request.core.expectedSuspendedStateSha256,
			);
			if (!existing || !lifecycleSuspendedState(existing)) {
				const observationSha256 = request.core.resumeRequest.core.suspension.core.lifecycleObservationSha256;
				const lifecycleStates = projection.state?.lifecycleStates ?? [];
				const awaitingReplay = lifecycleStates
					.filter(lifecycleAwaitingState)
					.find(state => state.core.key.core.observationSha256 === observationSha256);
				if (awaitingReplay)
					return { status: "already_awaiting_primary", state: awaitingReplay, pendingCaptureRemoved: false };
				const terminalReplay = lifecycleStates
					.filter(lifecycleTerminalizedState)
					.find(state => state.core.key.core.observationSha256 === observationSha256);
				if (terminalReplay)
					return { status: "already_terminalized", state: terminalReplay, pendingCaptureRemoved: true };
				return { status: "state_conflict" };
			}
			if (!detachedExactJson(existing.core.resumeRequest, request.core.resumeRequest))
				return { status: "resume_request_conflict" };
			if (request.core.gateResult.status === "suspended")
				return { status: "suspended", state: existing, pendingCaptureRemoved: false };
			if (request.core.gateResult.terminalization === "terminalized") {
				if (!request.core.terminalCaptureReceipt || !request.core.terminalMarker)
					return { status: "primary_receipt_missing" };
				return this.#terminalizeLifecycleState(
					projection.state,
					existing,
					request.core.terminalCaptureReceipt,
					request.core.terminalMarker,
					request.core.resumedAt,
				);
			}
			const nextCore: LifecycleAwaitingStateV1["core"] = {
				key: existing.core.key,
				state: "awaiting_primary",
				acceptedObservation: existing.core.acceptedObservation,
				observationReceipt: existing.core.observationReceipt,
				pendingCaptureRecordSha256: existing.core.pendingCaptureRecordSha256,
				route: existing.core.route,
				gateResult: request.core.gateResult,
				suspension: null,
				resumeRequest: null,
				terminalCaptureReceipt: null,
				terminalMarker: null,
				gateResultRecordedAt: request.core.resumedAt,
			};
			const next: LifecycleAwaitingStateV1 = { core: nextCore, stateSha256: lifecycleStateDigest(nextCore) };
			const runtime = this.#draftTransientRuntimeState(projection.state, request.core.resumedAt);
			const index = runtime.lifecycleStates.findIndex(state => state.stateSha256 === existing.stateSha256);
			runtime.lifecycleStates[index] = next;
			await this.#commitTransientRuntimeState(runtime);
			return { status: "awaiting_primary", state: next, pendingCaptureRemoved: false };
		});
	}

	async #terminalizeLifecycleState(
		current: SessionManagerTransientRuntimeStateV1 | null,
		existing: LifecyclePreparedStateV1,
		terminalCaptureReceipt: PendingOverlayTerminalReceiptV1,
		terminalMarker: LifecycleMarkerV1,
		terminalizedAt: ISO8601,
	): Promise<Awaited<ReturnType<TransientTaskLifecycleGateStoreV1["terminalizeLifecycleGate"]>>> {
		if (!current) return { status: "state_conflict" };
		const overlay = current.overlays.find(
			row => row.pendingRecord?.recordSha256 === existing.core.pendingCaptureRecordSha256,
		);
		if (!overlay?.pendingRecord || !overlay.terminalReceipt) return { status: "pending_conflict" };
		if (
			!detachedExactJson(overlay.terminalReceipt, terminalCaptureReceipt) ||
			terminalMarker.markerSha256 !== lifecycleMarkerDigest(terminalMarker) ||
			terminalMarker.core.indexKey.indexKeySha256 !== existing.core.key.core.indexKeySha256 ||
			terminalMarker.core.terminalCaptureReceipt.receiptSha256 !== terminalCaptureReceipt.receiptSha256 ||
			terminalMarker.core.terminalAuthority.primaryReceiptSha256 !==
				terminalCaptureReceipt.core.primaryPersistenceReceiptSha256
		)
			return { status: "primary_receipt_missing" };
		const nextCore: LifecycleTerminalizedStateV1["core"] = {
			key: existing.core.key,
			state: "terminalized",
			acceptedObservation: existing.core.acceptedObservation,
			observationReceipt: existing.core.observationReceipt,
			pendingCaptureRecordSha256: existing.core.pendingCaptureRecordSha256,
			route: existing.core.route,
			gateResult: {
				status: "observation_durable",
				resultExposure: "continue_original_emission",
				terminalization: "terminalized",
				observationReceiptSha256: existing.core.observationReceipt.receiptSha256,
				terminalReceiptSha256: terminalCaptureReceipt.receiptSha256,
				suspension: null,
				resumeRequest: null,
			},
			suspension: null,
			resumeRequest: null,
			terminalCaptureReceipt,
			terminalMarker,
			gateResultRecordedAt: terminalizedAt,
		};
		const next: LifecycleTerminalizedStateV1 = { core: nextCore, stateSha256: lifecycleStateDigest(nextCore) };
		const runtime = this.#draftTransientRuntimeState(current, terminalizedAt);
		const stateIndex = runtime.lifecycleStates.findIndex(state => state.stateSha256 === existing.stateSha256);
		runtime.lifecycleStates[stateIndex] = next;
		runtime.lifecycleMarkers.push(structuredClone(terminalMarker));
		const row = runtime.overlays.find(candidate => candidate.keySha256 === overlay.keySha256)!;
		row.pendingRecord = null;
		await this.#commitTransientRuntimeState(runtime);
		return { status: "terminalized", state: next, pendingCaptureRemoved: true };
	}

	async terminalizeLifecycleGate(
		request: LifecycleTerminalizeRequestV1,
	): ReturnType<TransientTaskLifecycleGateStoreV1["terminalizeLifecycleGate"]> {
		if (
			!detachedIso8601(request.terminalizedAt) ||
			request.requestSha256 !== lifecycleTerminalizeRequestDigest(request)
		)
			return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const existing = projection.state?.lifecycleStates.find(
				state => state.stateSha256 === request.expectedAwaitingStateSha256,
			);
			if (!existing || !lifecycleAwaitingState(existing)) {
				const replay = (projection.state?.lifecycleStates ?? [])
					.filter(lifecycleTerminalizedState)
					.find(
						state =>
							state.core.terminalCaptureReceipt.receiptSha256 === request.terminalCaptureReceipt.receiptSha256 &&
							state.core.terminalMarker.markerSha256 === request.terminalMarker.markerSha256,
					);
				if (replay) return { status: "already_terminalized", state: replay, pendingCaptureRemoved: true };
				return { status: "state_conflict" };
			}
			return this.#terminalizeLifecycleState(
				projection.state,
				existing,
				request.terminalCaptureReceipt,
				request.terminalMarker,
				request.terminalizedAt,
			);
		});
	}

	async inspectLifecycleTerminalMarker(
		request: LifecycleMarkerInspectRequestV1,
	): ReturnType<TransientTaskLifecycleGateStoreV1["inspectLifecycleTerminalMarker"]> {
		if (
			request.schemaVersion !== 1 ||
			!detachedIso8601(request.requestedAt) ||
			request.requestSha256 !== lifecycleMarkerInspectRequestDigest(request)
		)
			return { status: "invalid" };
		if (request.parentSessionGenerationSha256 !== this.#detachedSessionGenerationSha256())
			return { status: "session_generation_replaced" };
		const projection = this.#transientRuntimeStateProjection();
		if (!projection.valid) return { status: "invalid" };
		const marker = projection.state?.lifecycleMarkers.find(
			candidate => candidate.core.indexKey.indexKeySha256 === request.indexKeySha256,
		);
		if (!marker)
			return {
				status: "absent",
				inspectionSha256: detachedTupleSha256Ref([
					"omp-transient-task-lifecycle-gate-v1",
					"terminal-marker-inspection",
					1,
					request,
					"absent",
				]),
			};
		if (marker.markerSha256 !== request.expectedMarkerSha256) return { status: "marker_conflict" };
		return {
			status: "matching",
			markerSha256: marker.markerSha256,
			terminalCaptureReceiptSha256: marker.core.terminalCaptureReceipt.receiptSha256,
			inspectionSha256: detachedTupleSha256Ref([
				"omp-transient-task-lifecycle-gate-v1",
				"terminal-marker-inspection",
				1,
				request,
				"matching",
				marker.markerSha256,
				marker.core.terminalCaptureReceipt.receiptSha256,
			]),
		};
	}

	async adoptLifecycleTerminalMarker(
		request: LifecycleMarkerAdoptRequestV1,
	): ReturnType<TransientTaskLifecycleGateStoreV1["adoptLifecycleTerminalMarker"]> {
		if (
			!detachedIso8601(request.adoptedAt) ||
			request.expectedInspectionSha256 !== request.inspection.inspectionSha256 ||
			request.requestSha256 !== lifecycleMarkerAdoptRequestDigest(request)
		)
			return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const marker = projection.state?.lifecycleMarkers.find(
				candidate => candidate.markerSha256 === request.inspection.markerSha256,
			);
			if (!marker) return { status: "inspection_stale" };
			if (marker.core.indexKey.core.parentSessionGenerationSha256 !== this.#detachedSessionGenerationSha256())
				return { status: "session_generation_replaced" };
			const already = projection.state?.lifecycleMarkerAdoptions.includes(request.requestSha256) ?? false;
			if (!already) {
				const runtime = this.#draftTransientRuntimeState(projection.state, request.adoptedAt);
				runtime.lifecycleMarkerAdoptions.push(request.requestSha256);
				await this.#commitTransientRuntimeState(runtime);
			}
			return { status: already ? "already_adopted" : "adopted", marker };
		});
	}

	async allocateOrReuseTicketBeforeEmission(
		request: SerializerAllocationRequestV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["allocateOrReuseTicketBeforeEmission"]> {
		const requestCore = request.core;
		if (
			!detachedCanonicalData(request) ||
			!detachedIso8601(requestCore.requestedAt) ||
			request.requestSha256 !== serializerAllocationRequestDigest(request)
		)
			return { status: "invalid" };
		if (requestCore.mode === "reuse_selected_hub") {
			const completion = requestCore.completionReceipt;
			const receipt = completion.ticketAllocationReceipt;
			const ticket = completion.ordinaryPersistenceTicket;
			if (
				requestCore.serializerKey.serializerKeySha256 !== serializerKeyDigest(requestCore.serializerKey) ||
				!detachedExactJson(ticket.core.serializerKey, requestCore.serializerKey) ||
				ticket.core.toolCallId !== requestCore.toolCallId ||
				requestCore.toolCallId !== completion.returnTarget.toolCallId ||
				!detachedExactJson(ticket.core.exactToolResultMessage, requestCore.exactToolResultMessage) ||
				!detachedExactJson(
					completion.postHookFinalization.exactToolResultMessage,
					requestCore.exactToolResultMessage,
				) ||
				receipt.core.ticket.ticketSha256 !== ticket.ticketSha256 ||
				receipt.receiptSha256 !== serializerAllocationReceiptDigest(receipt.core) ||
				completion.registeredSerializerQueueStateSha256 !==
					receipt.core.registeredSerializerQueueState.queueStateSha256
			)
				return { status: "completion_receipt_mismatch" };
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const queue = projection.state?.serializerQueues.find(
				candidate =>
					candidate.core.serializerKey.serializerKeySha256 === requestCore.serializerKey.serializerKeySha256,
			);
			const allocation = projection.state?.serializerAllocations.find(
				candidate => candidate.receiptSha256 === receipt.receiptSha256,
			);
			if (!queue || !allocation || !detachedExactJson(queue, completion.registeredSerializerQueueState))
				return { status: "sequence_conflict" };
			return { status: "reused", receipt: allocation };
		}
		const input = requestCore.ticketInput;
		const key = input.serializerKey;
		if (key.serializerKeySha256 !== serializerKeyDigest(key)) return { status: "serializer_key_mismatch" };
		if (
			this.#transientAuthorityStatus(
				key.parentSessionId,
				key.parentSessionGenerationSha256,
				key.assistantAnchorEntryId,
				key.parentBranchGenerationSha256,
			) !== "matching"
		)
			return { status: "serializer_key_mismatch" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const priorAllocation = projection.state?.serializerAllocations.find(
				candidate => candidate.core.allocationRequestSha256 === request.requestSha256,
			);
			if (priorAllocation) return { status: "already_allocated", receipt: priorAllocation };
			const queues =
				projection.state?.serializerQueues.filter(
					candidate => candidate.core.serializerKey.serializerKeySha256 === key.serializerKeySha256,
				) ?? [];
			if (queues.length > 1) return { status: "sequence_conflict" };
			const previous =
				queues[0] ??
				(() => {
					const core = {
						serializerKey: key,
						orderedTickets: [],
						committedTicketCount: 0,
						previousPrimaryReceiptSha256: null,
						updatedAt: requestCore.requestedAt,
					};
					return { core, queueStateSha256: serializerQueueDigest(core) };
				})();
			if (previous.core.orderedTickets.some(ticket => ticket.core.toolCallId === input.toolCallId))
				return { status: "ticket_conflict" };
			const ticket = serializerTicketFromInput(input, previous.core.orderedTickets.length, requestCore.requestedAt);
			const registeredCore = {
				serializerKey: key,
				orderedTickets: [...previous.core.orderedTickets, ticket],
				committedTicketCount: previous.core.committedTicketCount,
				previousPrimaryReceiptSha256: previous.core.previousPrimaryReceiptSha256,
				updatedAt: requestCore.requestedAt,
			};
			const registered = { core: registeredCore, queueStateSha256: serializerQueueDigest(registeredCore) };
			const receiptCore = {
				allocationRequestSha256: request.requestSha256,
				ticket,
				previousSerializerQueueState: previous,
				registeredSerializerQueueState: registered,
				previousAllocatedTicketCount: previous.core.orderedTickets.length,
				allocatedTicketCount: registered.core.orderedTickets.length,
				allocatedAt: requestCore.requestedAt,
			};
			const receipt = { core: receiptCore, receiptSha256: serializerAllocationReceiptDigest(receiptCore) };
			const state = this.#draftTransientRuntimeState(projection.state, requestCore.requestedAt);
			const queueIndex = state.serializerQueues.findIndex(
				candidate => candidate.core.serializerKey.serializerKeySha256 === key.serializerKeySha256,
			);
			if (queueIndex === -1) state.serializerQueues.push(registered);
			else state.serializerQueues[queueIndex] = registered;
			state.serializerAllocations.push(receipt);
			await this.#commitTransientRuntimeState(state);
			return { status: "allocated", receipt };
		});
	}

	async waitForHeadAndResolveCurrentPriorLeaf(
		request: SerializerHeadRequestV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["waitForHeadAndResolveCurrentPriorLeaf"]> {
		if (
			request.serializerKey.serializerKeySha256 !== serializerKeyDigest(request.serializerKey) ||
			!detachedIso8601(request.requestedAt) ||
			request.requestSha256 !== serializerHeadRequestDigest(request)
		)
			return { status: "invalid" };
		if (
			this.#transientAuthorityStatus(
				request.serializerKey.parentSessionId,
				request.serializerKey.parentSessionGenerationSha256,
				request.serializerKey.assistantAnchorEntryId,
				request.serializerKey.parentBranchGenerationSha256,
			) !== "matching"
		)
			return { status: "prior_leaf_conflict" };
		const projection = this.#transientRuntimeStateProjection();
		if (!projection.valid) return { status: "invalid" };
		const queues =
			projection.state?.serializerQueues.filter(
				candidate => candidate.core.serializerKey.serializerKeySha256 === request.serializerKey.serializerKeySha256,
			) ?? [];
		if (queues.length !== 1) return { status: "ticket_conflict" };
		const queue = queues[0];
		const index = queue.core.orderedTickets.findIndex(ticket => ticket.ticketSha256 === request.ticketSha256);
		if (index < 0) return { status: "ticket_conflict" };
		if (index > queue.core.committedTicketCount) return { status: "waiting_for_earlier_completion" };
		if (index < queue.core.committedTicketCount) return { status: "ticket_conflict" };
		const currentPriorLeafEntryId = this.#index.leafId();
		if (currentPriorLeafEntryId === null) return { status: "prior_leaf_conflict" };
		const ticket = queue.core.orderedTickets[index];
		const permitCore = {
			serializerKeySha256: request.serializerKey.serializerKeySha256,
			ticketSha256: ticket.ticketSha256,
			completionOrdinal: ticket.core.completionOrdinal,
			currentPriorLeafEntryId,
			previousPrimaryReceiptSha256: queue.core.previousPrimaryReceiptSha256,
			resolvedAt: request.requestedAt,
		};
		return {
			status: "head",
			permit: { core: permitCore, permitSha256: serializerHeadPermitDigest(permitCore) },
		};
	}

	async preparePrimaryCommitAtHead(
		attempt: PrimaryCommitAttemptV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["preparePrimaryCommitAtHead"]> {
		if (
			attempt.core.state !== "not_applied" ||
			attempt.core.request.requestSha256 !== primaryRequestDigest(attempt.core.request) ||
			attempt.attemptSha256 !== primaryAttemptDigest(attempt) ||
			attempt.core.request.core.headPermit.permitSha256 !==
				serializerHeadPermitDigest(attempt.core.request.core.headPermit.core) ||
			attempt.core.request.core.ticket.ticketSha256 !== attempt.core.request.core.headPermit.core.ticketSha256
		)
			return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const queue = projection.state?.serializerQueues.find(
				candidate =>
					candidate.core.serializerKey.serializerKeySha256 ===
					attempt.core.request.core.ticket.core.serializerKey.serializerKeySha256,
			);
			if (
				!queue ||
				queue.core.orderedTickets[queue.core.committedTicketCount]?.ticketSha256 !==
					attempt.core.request.core.ticket.ticketSha256
			)
				return { status: "not_head" };
			const existing = projection.state?.primaryCommits.find(
				row => row.attempt.attemptSha256 === attempt.attemptSha256,
			);
			if (existing)
				return detachedExactJson(existing.attempt, attempt)
					? { status: "already_prepared" }
					: { status: "conflict" };
			if (this.#index.leafId() !== attempt.core.request.core.headPermit.core.currentPriorLeafEntryId)
				return { status: "not_head" };
			const state = this.#draftTransientRuntimeState(projection.state, attempt.core.preparedAt);
			state.primaryCommits.push({
				attempt: structuredClone(attempt),
				status: "not_applied",
				transitionReceipt: null,
				commitReceipt: null,
				restoredInspectionSha256: null,
			});
			await this.#commitTransientRuntimeState(state);
			return { status: "prepared" };
		});
	}

	async transitionPrimaryCommitToOutcomeUnknownAtHead(
		attempt: PrimaryCommitAttemptV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["transitionPrimaryCommitToOutcomeUnknownAtHead"]> {
		if (attempt.attemptSha256 !== primaryAttemptDigest(attempt)) return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const row = projection.state?.primaryCommits.find(
				candidate => candidate.attempt.attemptSha256 === attempt.attemptSha256,
			);
			if (!row || !detachedExactJson(row.attempt, attempt)) return { status: "conflict" };
			if (row.transitionReceipt) return { status: "already_transitioned", receipt: row.transitionReceipt };
			const queue = projection.state?.serializerQueues.find(
				candidate =>
					candidate.core.serializerKey.serializerKeySha256 ===
					attempt.core.request.core.ticket.core.serializerKey.serializerKeySha256,
			);
			if (
				!queue ||
				queue.core.orderedTickets[queue.core.committedTicketCount]?.ticketSha256 !==
					attempt.core.request.core.ticket.ticketSha256 ||
				this.#index.leafId() !== attempt.core.request.core.headPermit.core.currentPriorLeafEntryId
			)
				return { status: "not_head" };
			const core = {
				attemptSha256: attempt.attemptSha256,
				requestSha256: attempt.core.request.requestSha256,
				priorState: "not_applied" as const,
				nextState: "outcome_unknown" as const,
				foregroundBatchTransitionReceiptSha256: null,
				transitionedImmediatelyBeforeDispatchAt: attempt.core.preparedAt,
			};
			const receipt = { core, transitionReceiptSha256: primaryTransitionDigest(core) };
			const state = this.#draftTransientRuntimeState(projection.state, attempt.core.preparedAt);
			const draftRow = state.primaryCommits.find(
				candidate => candidate.attempt.attemptSha256 === attempt.attemptSha256,
			)!;
			draftRow.status = "outcome_unknown";
			draftRow.transitionReceipt = receipt;
			await this.#commitTransientRuntimeState(state);
			return { status: "transitioned", receipt };
		});
	}
	async appendOrAdoptPrimaryAtHead(
		effect: PrimaryCommitEffectV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["appendOrAdoptPrimaryAtHead"]> {
		const attempt = effect.core.attempt;
		const request = attempt.core.request;
		const transitionReceipt = effect.core.transitionReceipt;
		const ticket = request.core.ticket;
		const headPermit = request.core.headPermit;
		const key = ticket.core.serializerKey;
		if (
			effect.effectRequestSha256 !== primaryEffectDigest(effect) ||
			attempt.core.state !== "not_applied" ||
			attempt.attemptSha256 !== primaryAttemptDigest(attempt) ||
			request.requestSha256 !== primaryRequestDigest(request) ||
			transitionReceipt.transitionReceiptSha256 !== primaryTransitionDigest(transitionReceipt.core) ||
			transitionReceipt.core.attemptSha256 !== attempt.attemptSha256 ||
			transitionReceipt.core.requestSha256 !== request.requestSha256 ||
			transitionReceipt.core.priorState !== "not_applied" ||
			transitionReceipt.core.nextState !== "outcome_unknown" ||
			ticket.ticketSha256 !== serializerTicketDigest(ticket.core) ||
			key.serializerKeySha256 !== serializerKeyDigest(key) ||
			headPermit.permitSha256 !== serializerHeadPermitDigest(headPermit.core) ||
			headPermit.core.serializerKeySha256 !== key.serializerKeySha256 ||
			headPermit.core.ticketSha256 !== ticket.ticketSha256 ||
			headPermit.core.completionOrdinal !== ticket.core.completionOrdinal
		)
			return { status: "invalid" };
		if (
			this.#transientAuthorityStatus(
				key.parentSessionId,
				key.parentSessionGenerationSha256,
				key.assistantAnchorEntryId,
				key.parentBranchGenerationSha256,
			) !== "matching"
		)
			return { status: "not_head" };
		if (!this.#primaryRoutePhysicalPlan(request)) return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			let projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const queues =
				projection.state?.serializerQueues.filter(
					candidate => candidate.core.serializerKey.serializerKeySha256 === key.serializerKeySha256,
				) ?? [];
			if (queues.length !== 1) return { status: "not_head" };
			const previousQueue = queues[0];
			if (
				previousQueue.queueStateSha256 !== serializerQueueDigest(previousQueue.core) ||
				previousQueue.core.orderedTickets[previousQueue.core.committedTicketCount]?.ticketSha256 !==
					ticket.ticketSha256 ||
				previousQueue.core.committedTicketCount !== headPermit.core.completionOrdinal ||
				previousQueue.core.previousPrimaryReceiptSha256 !== headPermit.core.previousPrimaryReceiptSha256 ||
				!detachedExactJson(previousQueue.core.orderedTickets[previousQueue.core.committedTicketCount], ticket)
			)
				return { status: "not_head" };
			const primaryRows =
				projection.state?.primaryCommits.filter(row => row.attempt.attemptSha256 === attempt.attemptSha256) ?? [];
			if (primaryRows.length !== 1) return { status: "invalid" };
			let primaryRow: PrimaryCommitRuntimeRowV1 | undefined = primaryRows[0];
			if (!primaryRow || !detachedExactJson(primaryRow.attempt, attempt)) return { status: "invalid" };
			if (primaryRow.status === "committed")
				return primaryRow.commitReceipt
					? { status: "already_committed", receipt: primaryRow.commitReceipt }
					: { status: "invalid" };
			if (
				primaryRow.status !== "outcome_unknown" ||
				!primaryRow.transitionReceipt ||
				!detachedExactJson(primaryRow.transitionReceipt, transitionReceipt)
			)
				return { status: "outcome_unknown" };

			let resultCandidate: SessionMessageEntry;
			let resultPhysicalExists: boolean;
			let foregroundAppend: {
				readonly request: ForegroundSessionAppendRequestV1;
				readonly receipt: ForegroundSessionAppendReceiptV1;
			} | null = null;
			let noHandoffReceipt: NoHandoffReceiptV1 | null = null;
			let primaryPersistenceReceipt: PrimaryPersistenceReceiptV1;
			let nextPriorLeafEntryId: string;
			let committedAt: ISO8601;

			if (request.core.route === "task_foreground_delivery") {
				if (ticket.core.route !== "task_foreground_delivery") return { status: "invalid" };
				const batch = request.core.foregroundAppendBatch;
				const first = batch.requests[0];
				if (
					!first ||
					!detachedExactJson(ticket.core.handoffBatch, batch.handoffBatch) ||
					ticket.core.serializerKey.serializerKeySha256 !== batch.handoffBatch.toolResultSerializerKeySha256 ||
					ticket.core.toolCallId !== batch.handoffBatch.toolCallId ||
					!detachedExactJson(ticket.core.exactToolResultMessage, batch.entry.message) ||
					batch.injectionAppendRequest.core.headPermit.permitSha256 !== headPermit.permitSha256 ||
					!detachedExactJson(batch.injectionAppendRequest.core.headPermit, headPermit)
				)
					return { status: "invalid" };
				const injection = await this.#resolveInjectionAppendLocked(request.core.injectionAppendRequest);
				if (injection.status !== "committed" && injection.status !== "already_committed")
					return injection.status === "prior_leaf_conflict"
						? { status: "prior_leaf_conflict" }
						: injection.status === "entry_conflict"
							? { status: "entry_conflict" }
							: injection.status === "invalid"
								? { status: "invalid" }
								: { status: "outcome_unknown" };
				const orderedAppendOperationIds: ForegroundSessionAppendRequestV1["orderedAppendOperationIds"] = [
					first.preReturnIdentity.core.appendOperationId,
					...batch.requests.slice(1).map(member => member.preReturnIdentity.core.appendOperationId),
				];
				const orderedSettlementIdentitySha256s: ForegroundSessionAppendRequestV1["orderedSettlementIdentitySha256s"] =
					[
						first.identity.identitySha256,
						...batch.requests.slice(1).map(member => member.identity.identitySha256),
					];
				const identity = first.preReturnIdentity.core;
				const appendCore: Omit<ForegroundSessionAppendRequestV1, "sessionAppendRequestSha256"> = {
					schemaVersion: 1,
					foregroundAppendBatchKeySha256: batch.foregroundAppendBatchKeySha256,
					appendBatchSha256: batch.appendBatchSha256,
					injectionAppendRequestSha256: request.core.injectionAppendRequest.requestSha256,
					parentSessionId: identity.parentSessionId,
					parentSessionGenerationSha256: identity.parentSessionGenerationSha256,
					parentBranchGenerationSha256: identity.parentBranchGenerationSha256,
					parentBranchAnchorEntryId: identity.parentBranchAnchorEntryId,
					appendParentEntryId: injection.receipt.core.nextTaskResultAppendParentEntryId,
					toolCallId: identity.toolCallId,
					toolResultEntryId: batch.entry.id,
					orderedAppendOperationIds,
					orderedSettlementIdentitySha256s,
					entry: batch.entry,
				};
				const appendRequest: ForegroundSessionAppendRequestV1 = {
					...appendCore,
					sessionAppendRequestSha256: foregroundSessionAppendRequestDigest(appendCore),
				};
				projection = this.#transientRuntimeStateProjection();
				if (!projection.valid) return { status: "outcome_unknown" };
				primaryRow = projection.state?.primaryCommits.find(
					row => row.attempt.attemptSha256 === attempt.attemptSha256,
				);
				if (!primaryRow?.transitionReceipt || !detachedExactJson(primaryRow.transitionReceipt, transitionReceipt))
					return { status: "outcome_unknown" };
				const preallocation = projection.state?.foregroundPreallocations.find(
					row =>
						row.request.foregroundAppendBatchKeySha256 === batch.foregroundAppendBatchKeySha256 &&
						row.toolResultEntryId === batch.entry.id,
				);
				if (!preallocation) return { status: "invalid" };
				const existing = projection.state?.foregroundAppends.find(
					row => row.request.foregroundAppendBatchKeySha256 === batch.foregroundAppendBatchKeySha256,
				);
				resultCandidate = this.#exactForegroundMessageEntry(batch.entry)!;
				if (existing) {
					if (!detachedExactJson(existing.request, appendRequest)) return { status: "entry_conflict" };
					const physical = this.#index.get(resultCandidate.id);
					if (!physical || !detachedExactJson(physical, resultCandidate)) return { status: "entry_conflict" };
					foregroundAppend = existing;
					resultPhysicalExists = true;
				} else {
					if (batch.entry.parentId !== injection.receipt.core.nextTaskResultAppendParentEntryId)
						return { status: "prior_leaf_conflict" };
					const physical = this.#index.get(resultCandidate.id);
					if (physical && !detachedExactJson(physical, resultCandidate)) return { status: "entry_conflict" };
					if (!physical && this.#index.leafId() !== batch.entry.parentId) return { status: "prior_leaf_conflict" };
					if (physical && this.#index.leafId() !== resultCandidate.id) return { status: "prior_leaf_conflict" };
					const toolResultMessageUtf8 = JSON.stringify(batch.entry.message);
					const receiptCore: Omit<ForegroundSessionAppendReceiptV1, "primaryReceiptSha256"> = {
						schemaVersion: 1,
						foregroundAppendBatchKeySha256: batch.foregroundAppendBatchKeySha256,
						appendBatchSha256: batch.appendBatchSha256,
						orderedAppendOperationIds,
						orderedSettlementIdentitySha256s,
						sessionAppendRequestSha256: appendRequest.sessionAppendRequestSha256,
						injectionAppendReceiptSha256: injection.receipt.receiptSha256,
						entry: batch.entry,
						toolResultMessageUtf8,
						toolResultMessageUtf8Sha256: detachedUtf8Sha256Ref(toolResultMessageUtf8),
						toolResultMessageUtf8ByteLength: Buffer.byteLength(toolResultMessageUtf8, "utf8"),
						committedAt: batch.entry.timestamp,
					};
					foregroundAppend = {
						request: appendRequest,
						receipt: { ...receiptCore, primaryReceiptSha256: foregroundSessionAppendReceiptDigest(receiptCore) },
					};
					resultPhysicalExists = physical !== undefined;
				}
				const persistenceCore: ForegroundPrimaryPersistenceReceiptV1["core"] = {
					schemaVersion: 1,
					route: "task_foreground_delivery",
					requestSha256: request.requestSha256,
					transitionReceiptSha256: transitionReceipt.transitionReceiptSha256,
					foregroundPrimaryReceipt: foregroundAppend.receipt,
					injectionAppendReceipt: injection.receipt,
					nextPriorLeafEntryId: foregroundAppend.receipt.entry.id,
					committedAt: foregroundAppend.receipt.committedAt,
				};
				primaryPersistenceReceipt = {
					core: persistenceCore,
					primaryReceiptSha256: primaryPersistenceReceiptDigest({ core: persistenceCore }),
				};
				nextPriorLeafEntryId = persistenceCore.nextPriorLeafEntryId;
				committedAt = persistenceCore.committedAt;
			} else if (request.core.route === "task_no_handoff_result") {
				if (ticket.core.route !== "task_no_handoff_result") return { status: "invalid" };
				const nestedAttempt = request.core.noHandoffAppendAttempt;
				const nestedRequest = nestedAttempt.core.request;
				if (
					!detachedExactJson(ticket.core.continuation, nestedRequest.core.continuation) ||
					!detachedExactJson(nestedRequest.core.headPermit, headPermit) ||
					nestedRequest.core.injectionAppendRequest.core.headPermit.permitSha256 !== headPermit.permitSha256 ||
					!detachedExactJson(ticket.core.exactToolResultMessage, nestedRequest.core.taskResultEntry.message)
				)
					return { status: "invalid" };
				let nestedRow = projection.state?.noHandoffCommits.find(
					row => row.attempt.attemptSha256 === nestedAttempt.attemptSha256,
				);
				if (!nestedRow || !detachedExactJson(nestedRow.attempt, nestedAttempt)) return { status: "invalid" };
				const injection = await this.#resolveInjectionAppendLocked(nestedRequest.core.injectionAppendRequest);
				if (injection.status !== "committed" && injection.status !== "already_committed")
					return injection.status === "prior_leaf_conflict"
						? { status: "prior_leaf_conflict" }
						: injection.status === "entry_conflict"
							? { status: "entry_conflict" }
							: injection.status === "invalid"
								? { status: "invalid" }
								: { status: "outcome_unknown" };
				projection = this.#transientRuntimeStateProjection();
				if (!projection.valid) return { status: "outcome_unknown" };
				nestedRow = projection.state?.noHandoffCommits.find(
					row => row.attempt.attemptSha256 === nestedAttempt.attemptSha256,
				);
				if (!nestedRow) return { status: "outcome_unknown" };
				resultCandidate = this.#exactForegroundMessageEntry(nestedRequest.core.taskResultEntry)!;
				if (nestedRow.status === "committed") {
					if (!nestedRow.receipt) return { status: "invalid" };
					const physical = this.#index.get(resultCandidate.id);
					if (!physical || !detachedExactJson(physical, resultCandidate)) return { status: "entry_conflict" };
					noHandoffReceipt = nestedRow.receipt;
					resultPhysicalExists = true;
				} else {
					if (nestedRow.status !== "outcome_unknown" || !nestedRow.transitionReceipt)
						return { status: "outcome_unknown" };
					if (
						nestedRequest.core.taskResultEntry.parentId !==
						injection.receipt.core.nextTaskResultAppendParentEntryId
					)
						return { status: "prior_leaf_conflict" };
					const physical = this.#index.get(resultCandidate.id);
					if (physical && !detachedExactJson(physical, resultCandidate)) return { status: "entry_conflict" };
					if (!physical && this.#index.leafId() !== resultCandidate.parentId)
						return { status: "prior_leaf_conflict" };
					if (physical && this.#index.leafId() !== resultCandidate.id) return { status: "prior_leaf_conflict" };
					const receiptCore: NoHandoffReceiptV1["core"] = {
						requestSha256: nestedRequest.requestSha256,
						attemptSha256: nestedAttempt.attemptSha256,
						transitionReceiptSha256: nestedRow.transitionReceipt.transitionReceiptSha256,
						injectionAppendReceipt: injection.receipt,
						taskResultEntry: nestedRequest.core.taskResultEntry,
						nextPriorLeafEntryId: nestedRequest.core.taskResultEntry.id,
						committedAt: nestedRequest.core.requestedAt,
					};
					noHandoffReceipt = { core: receiptCore, receiptSha256: noHandoffReceiptDigest(receiptCore) };
					resultPhysicalExists = physical !== undefined;
				}
				const continuation = nestedRequest.core.continuation;
				const persistenceCore: NoHandoffPrimaryPersistenceReceiptV1["core"] = {
					schemaVersion: 1,
					route: "task_no_handoff_result",
					requestSha256: request.requestSha256,
					transitionReceiptSha256: transitionReceipt.transitionReceiptSha256,
					continuationSha256: continuation.continuationSha256,
					pendingCaptureIndexKeySha256: continuation.core.pendingCaptureIndexKey.indexKeySha256,
					noHandoffAppendReceipt: noHandoffReceipt,
					nextPriorLeafEntryId: noHandoffReceipt.core.nextPriorLeafEntryId,
					committedAt: noHandoffReceipt.core.committedAt,
				};
				primaryPersistenceReceipt = {
					core: persistenceCore,
					primaryReceiptSha256: primaryPersistenceReceiptDigest({ core: persistenceCore }),
				};
				nextPriorLeafEntryId = persistenceCore.nextPriorLeafEntryId;
				committedAt = persistenceCore.committedAt;
			} else if (request.core.route === "non_task_ordinary") {
				if (ticket.core.route !== "non_task_ordinary") return { status: "invalid" };
				const appendRequest = request.core.ordinaryAppendRequest;
				const plan = appendRequest.core.plan;
				if (
					plan.core.ticketSha256 !== ticket.ticketSha256 ||
					!detachedExactJson(plan.core.headPermit, headPermit) ||
					plan.core.initialAppendParentEntryId !== headPermit.core.currentPriorLeafEntryId ||
					!detachedExactJson(ticket.core.ordinaryPersistence, plan.core.ordinaryPersistence) ||
					!detachedExactJson(ticket.core.exactToolResultMessage, plan.core.exactToolResultMessage)
				)
					return { status: "invalid" };
				const prepared = this.#prepareOrdinaryAppendAtParent(
					appendRequest,
					headPermit.core.currentPriorLeafEntryId,
					attempt.attemptSha256,
					transitionReceipt.transitionReceiptSha256,
					appendRequest.core.requestedAt,
				);
				if (prepared.status !== "ready") return { status: prepared.status };
				resultCandidate = prepared.candidate;
				resultPhysicalExists = prepared.physicalExists;
				const persistenceCore: OrdinaryPrimaryPersistenceReceiptV1["core"] = {
					schemaVersion: 1,
					route: "non_task_ordinary",
					requestSha256: request.requestSha256,
					transitionReceiptSha256: transitionReceipt.transitionReceiptSha256,
					ordinaryAppendReceipt: prepared.receipt,
					nextPriorLeafEntryId: prepared.receipt.core.nextPriorLeafEntryId,
					committedAt: prepared.receipt.core.committedAt,
				};
				primaryPersistenceReceipt = {
					core: persistenceCore,
					primaryReceiptSha256: primaryPersistenceReceiptDigest({ core: persistenceCore }),
				};
				nextPriorLeafEntryId = persistenceCore.nextPriorLeafEntryId;
				committedAt = persistenceCore.committedAt;
			} else {
				if (ticket.core.route !== "non_task_ordinary") return { status: "invalid" };
				const registration = request.core.injectionRegistrationReceipt;
				const appendRequest = request.core.ordinaryAppendRequest;
				const plan = appendRequest.core.plan;
				if (
					registration.receiptSha256 !== hubInjectionRegistrationReceiptDigest(registration) ||
					registration.ordinaryPersistenceTicketSha256 !== ticket.ticketSha256 ||
					!detachedExactJson(registration.contentPlan, request.core.injectionAppendRequest.core.contentPlan) ||
					plan.core.ticketSha256 !== ticket.ticketSha256 ||
					!detachedExactJson(plan.core.headPermit, headPermit) ||
					plan.core.initialAppendParentEntryId !== headPermit.core.currentPriorLeafEntryId ||
					!detachedExactJson(ticket.core.ordinaryPersistence, plan.core.ordinaryPersistence) ||
					request.core.injectionAppendRequest.core.headPermit.permitSha256 !== headPermit.permitSha256
				)
					return { status: "invalid" };
				const injection = await this.#resolveInjectionAppendLocked(request.core.injectionAppendRequest);
				if (injection.status !== "committed" && injection.status !== "already_committed")
					return injection.status === "prior_leaf_conflict"
						? { status: "prior_leaf_conflict" }
						: injection.status === "entry_conflict"
							? { status: "entry_conflict" }
							: injection.status === "invalid"
								? { status: "invalid" }
								: { status: "outcome_unknown" };
				projection = this.#transientRuntimeStateProjection();
				if (!projection.valid) return { status: "outcome_unknown" };
				const prepared = this.#prepareOrdinaryAppendAtParent(
					appendRequest,
					injection.receipt.core.nextTaskResultAppendParentEntryId,
					attempt.attemptSha256,
					transitionReceipt.transitionReceiptSha256,
					appendRequest.core.requestedAt,
				);
				if (prepared.status !== "ready") return { status: prepared.status };
				resultCandidate = prepared.candidate;
				resultPhysicalExists = prepared.physicalExists;
				const hubReceiptCore: Omit<HubInjectionResultPersistenceReceiptV1, "receiptSha256"> = {
					schemaVersion: 1,
					primaryCommitRequestSha256: request.requestSha256,
					primaryCommitAttemptSha256: attempt.attemptSha256,
					primaryCommitTransitionReceiptSha256: transitionReceipt.transitionReceiptSha256,
					ordinaryPersistenceTicketSha256: ticket.ticketSha256,
					headPermitSha256: headPermit.permitSha256,
					injectionRegistrationReceiptSha256: registration.receiptSha256,
					injectionAppendReceipt: injection.receipt,
					ordinaryAppendPlanSha256: plan.planSha256,
					ordinaryAppendReceipt: prepared.receipt,
					nextPriorLeafEntryId: prepared.receipt.core.nextPriorLeafEntryId,
					committedAt: prepared.receipt.core.committedAt,
				};
				const hubReceipt: HubInjectionResultPersistenceReceiptV1 = {
					...hubReceiptCore,
					receiptSha256: hubInjectionResultPersistenceReceiptDigest(hubReceiptCore),
				};
				const persistenceCore: HubPrimaryPersistenceReceiptV1["core"] = {
					schemaVersion: 1,
					route: "hub_wait_message_return",
					requestSha256: request.requestSha256,
					transitionReceiptSha256: transitionReceipt.transitionReceiptSha256,
					hubWaitMessageInjectionResultReceipt: hubReceipt,
					nextPriorLeafEntryId: hubReceipt.nextPriorLeafEntryId,
					committedAt: hubReceipt.committedAt,
				};
				primaryPersistenceReceipt = {
					core: persistenceCore,
					primaryReceiptSha256: primaryPersistenceReceiptDigest({ core: persistenceCore }),
				};
				nextPriorLeafEntryId = persistenceCore.nextPriorLeafEntryId;
				committedAt = persistenceCore.committedAt;
			}

			projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "outcome_unknown" };
			const currentQueue = projection.state?.serializerQueues.find(
				candidate => candidate.core.serializerKey.serializerKeySha256 === key.serializerKeySha256,
			);
			primaryRow = projection.state?.primaryCommits.find(row => row.attempt.attemptSha256 === attempt.attemptSha256);
			if (
				!currentQueue ||
				!primaryRow?.transitionReceipt ||
				!detachedExactJson(primaryRow.transitionReceipt, transitionReceipt) ||
				currentQueue.queueStateSha256 !== previousQueue.queueStateSha256 ||
				!detachedExactJson(currentQueue, previousQueue)
			)
				return { status: "outcome_unknown" };
			const advancedQueueCore: SerializerQueueStateV1["core"] = {
				serializerKey: previousQueue.core.serializerKey,
				orderedTickets: previousQueue.core.orderedTickets,
				committedTicketCount: previousQueue.core.committedTicketCount + 1,
				previousPrimaryReceiptSha256: primaryPersistenceReceipt.primaryReceiptSha256,
				updatedAt: committedAt,
			};
			const advancedQueue: SerializerQueueStateV1 = {
				core: advancedQueueCore,
				queueStateSha256: serializerQueueDigest(advancedQueueCore),
			};
			const common = {
				schemaVersion: 1 as const,
				requestSha256: request.requestSha256,
				attemptSha256: attempt.attemptSha256,
				transitionReceiptSha256: transitionReceipt.transitionReceiptSha256,
				previousSerializerQueueState: previousQueue,
				advancedSerializerQueueState: advancedQueue,
				previousSerializerQueueStateSha256: previousQueue.queueStateSha256,
				advancedSerializerQueueStateSha256: advancedQueue.queueStateSha256,
				previousCommittedTicketCount: previousQueue.core.committedTicketCount,
				committedTicketCount: advancedQueue.core.committedTicketCount,
				previousPrimaryPersistenceReceiptSha256: previousQueue.core.previousPrimaryReceiptSha256,
				newPrimaryPersistenceReceiptSha256: primaryPersistenceReceipt.primaryReceiptSha256,
				nextPriorLeafEntryId,
				nextHeadTicketSha256:
					advancedQueue.core.orderedTickets[advancedQueue.core.committedTicketCount]?.ticketSha256 ?? null,
				committedAt,
			};
			let commitReceipt: PrimaryCommitReceiptV1;
			if (isForegroundPrimaryPersistenceReceiptV1(primaryPersistenceReceipt)) {
				const core: ForegroundPrimaryCommitReceiptV1["core"] = {
					...common,
					route: "task_foreground_delivery",
					primaryPersistenceReceipt,
				};
				commitReceipt = { core, commitReceiptSha256: primaryCommitReceiptDigest(core) };
			} else if (isNoHandoffPrimaryPersistenceReceiptV1(primaryPersistenceReceipt)) {
				const core: NoHandoffPrimaryCommitReceiptV1["core"] = {
					...common,
					route: "task_no_handoff_result",
					primaryPersistenceReceipt,
				};
				commitReceipt = { core, commitReceiptSha256: primaryCommitReceiptDigest(core) };
			} else if (isOrdinaryPrimaryPersistenceReceiptV1(primaryPersistenceReceipt)) {
				const core: OrdinaryPrimaryCommitReceiptV1["core"] = {
					...common,
					route: "non_task_ordinary",
					primaryPersistenceReceipt,
				};
				commitReceipt = { core, commitReceiptSha256: primaryCommitReceiptDigest(core) };
			} else if (isHubPrimaryPersistenceReceiptV1(primaryPersistenceReceipt)) {
				const core: HubPrimaryCommitReceiptV1["core"] = {
					...common,
					route: "hub_wait_message_return",
					primaryPersistenceReceipt,
				};
				commitReceipt = { core, commitReceiptSha256: primaryCommitReceiptDigest(core) };
			} else {
				return { status: "invalid" };
			}
			const state = this.#draftTransientRuntimeState(projection.state, committedAt);
			const queueIndex = state.serializerQueues.findIndex(
				candidate => candidate.core.serializerKey.serializerKeySha256 === key.serializerKeySha256,
			);
			if (queueIndex < 0) return { status: "outcome_unknown" };
			state.serializerQueues[queueIndex] = advancedQueue;
			const draftPrimary = state.primaryCommits.find(row => row.attempt.attemptSha256 === attempt.attemptSha256);
			if (!draftPrimary) return { status: "outcome_unknown" };
			draftPrimary.status = "committed";
			draftPrimary.commitReceipt = commitReceipt;
			if (foregroundAppend) {
				const existing = state.foregroundAppends.find(
					row =>
						row.request.foregroundAppendBatchKeySha256 ===
						foregroundAppend.request.foregroundAppendBatchKeySha256,
				);
				if (!existing) state.foregroundAppends.push(structuredClone(foregroundAppend));
			}
			if (noHandoffReceipt) {
				const nested = state.noHandoffCommits.find(
					row => row.attempt.attemptSha256 === noHandoffReceipt!.core.attemptSha256,
				);
				if (!nested) return { status: "outcome_unknown" };
				nested.status = "committed";
				nested.receipt = noHandoffReceipt;
			}
			this.#sealTransientRuntimeState(state);
			try {
				await this.#appendEntriesAtomicallyLocked(() => {
					if (!resultPhysicalExists) this.#recordEntry(resultCandidate);
					this.#recordTransientRuntimeState(state);
				});
			} catch {
				return { status: "outcome_unknown" };
			}
			return { status: "committed", receipt: commitReceipt };
		});
	}
	async inspectPrimaryCommit(
		request: PrimaryInspectRequestV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["inspectPrimaryCommit"]> {
		const key = request.core.serializerKey;
		if (
			!detachedIso8601(request.core.requestedAt) ||
			key.serializerKeySha256 !== serializerKeyDigest(key) ||
			request.requestSha256 !== primaryInspectRequestDigest(request)
		)
			return { status: "invalid" };
		if (
			this.#transientAuthorityStatus(
				key.parentSessionId,
				key.parentSessionGenerationSha256,
				key.assistantAnchorEntryId,
				key.parentBranchGenerationSha256,
			) !== "matching"
		)
			return { status: "ticket_conflict" };
		const projection = this.#transientRuntimeStateProjection();
		if (!projection.valid) return { status: "invalid" };
		const rows =
			projection.state?.primaryCommits.filter(
				row =>
					row.attempt.core.request.core.ticket.core.serializerKey.serializerKeySha256 ===
						key.serializerKeySha256 &&
					row.attempt.core.request.core.ticket.ticketSha256 === request.core.ticketSha256,
			) ?? [];
		if (rows.length > 1) return { status: "ticket_conflict" };
		const row = rows[0];
		if (!row)
			return {
				status: "absent",
				inspectionSha256: primaryInspectionDigest("absent", null, null, null, null),
			};
		if (
			row.attempt.attemptSha256 !== request.core.expectedAttemptSha256 ||
			row.attempt.core.request.requestSha256 !== request.core.expectedRequestSha256 ||
			!detachedExactJson(row.attempt.core.request.core.ticket.core.serializerKey, key)
		)
			return { status: "ticket_conflict" };
		const routePlan = this.#primaryRoutePhysicalPlan(row.attempt.core.request);
		if (!routePlan) return { status: "invalid" };
		if (row.status === "not_applied")
			return {
				status: "not_applied",
				attempt: row.attempt,
				inspectionSha256: primaryInspectionDigest("not_applied", row.attempt, null, null, null),
			};
		if (!row.transitionReceipt) return { status: "invalid" };
		if (
			row.transitionReceipt.transitionReceiptSha256 !== primaryTransitionDigest(row.transitionReceipt.core) ||
			row.transitionReceipt.core.attemptSha256 !== row.attempt.attemptSha256 ||
			row.transitionReceipt.core.requestSha256 !== row.attempt.core.request.requestSha256
		)
			return { status: "invalid" };
		let matchingCount = 0;
		for (const candidate of routePlan.candidates) {
			const physical = this.#index.get(candidate.id);
			if (!physical) continue;
			if (!detachedExactJson(physical, candidate)) return { status: "entry_conflict" };
			matchingCount++;
		}
		if (row.status === "committed") {
			if (!row.commitReceipt) return { status: "invalid" };
			if (matchingCount !== routePlan.candidates.length) return { status: "prior_leaf_conflict" };
			const receipt = row.commitReceipt;
			if (
				receipt.commitReceiptSha256 !== primaryCommitReceiptDigest(receipt.core) ||
				receipt.core.primaryPersistenceReceipt.primaryReceiptSha256 !==
					primaryPersistenceReceiptDigest(receipt.core.primaryPersistenceReceipt) ||
				receipt.core.requestSha256 !== row.attempt.core.request.requestSha256 ||
				receipt.core.attemptSha256 !== row.attempt.attemptSha256 ||
				receipt.core.transitionReceiptSha256 !== row.transitionReceipt.transitionReceiptSha256
			)
				return { status: "invalid" };
			let ordinaryAppendInspection: OrdinaryMatchingInspectionV1 | null = null;
			if (routePlan.ordinaryAppendRequest) {
				const persistence = receipt.core.primaryPersistenceReceipt;
				const ordinaryReceipt =
					persistence.core.route === "non_task_ordinary"
						? persistence.core.ordinaryAppendReceipt
						: persistence.core.route === "hub_wait_message_return"
							? persistence.core.hubWaitMessageInjectionResultReceipt.ordinaryAppendReceipt
							: null;
				if (
					!ordinaryReceipt ||
					!detachedExactJson(ordinaryReceipt.core.appendRequest, routePlan.ordinaryAppendRequest) ||
					ordinaryReceipt.receiptSha256 !== ordinaryAppendReceiptDigest(ordinaryReceipt.core)
				)
					return { status: "invalid" };
				const appendRequest = routePlan.ordinaryAppendRequest;
				const plan = appendRequest.core.plan;
				ordinaryAppendInspection = {
					status: "matching_entry",
					appendRequest,
					plan,
					entry: plan.core.entry,
					receipt: ordinaryReceipt,
					inspectionSha256: ordinaryMatchingInspectionDigest(
						appendRequest,
						plan,
						plan.core.entry,
						ordinaryReceipt,
					),
				};
			}
			return {
				status: "committed",
				receipt,
				ordinaryAppendInspection,
				inspectionSha256: primaryInspectionDigest("committed", null, null, receipt, ordinaryAppendInspection),
			};
		}
		if (matchingCount > 0)
			return {
				status: "outcome_unknown",
				attempt: row.attempt,
				transitionReceipt: row.transitionReceipt,
				inspectionSha256: primaryInspectionDigest(
					"outcome_unknown",
					row.attempt,
					row.transitionReceipt,
					null,
					null,
				),
			};
		const queueRows =
			projection.state?.serializerQueues.filter(
				queue => queue.core.serializerKey.serializerKeySha256 === key.serializerKeySha256,
			) ?? [];
		if (queueRows.length !== 1) return { status: "ticket_conflict" };
		const queue = queueRows[0];
		const headPermit = row.attempt.core.request.core.headPermit;
		if (
			queue.queueStateSha256 !== serializerQueueDigest(queue.core) ||
			queue.core.orderedTickets[queue.core.committedTicketCount]?.ticketSha256 !== request.core.ticketSha256 ||
			queue.core.committedTicketCount !== headPermit.core.completionOrdinal ||
			queue.core.previousPrimaryReceiptSha256 !== headPermit.core.previousPrimaryReceiptSha256 ||
			this.#index.leafId() !== headPermit.core.currentPriorLeafEntryId
		)
			return {
				status: "outcome_unknown",
				attempt: row.attempt,
				transitionReceipt: row.transitionReceipt,
				inspectionSha256: primaryInspectionDigest(
					"outcome_unknown",
					row.attempt,
					row.transitionReceipt,
					null,
					null,
				),
			};
		const proofCore: PrimaryAbsenceProofV1["core"] = {
			serializerKeySha256: key.serializerKeySha256,
			ticketSha256: request.core.ticketSha256,
			requestSha256: row.attempt.core.request.requestSha256,
			attemptSha256: row.attempt.attemptSha256,
			transitionReceiptSha256: row.transitionReceipt.transitionReceiptSha256,
			headPermitSha256: headPermit.permitSha256,
			unchangedSerializerQueueState: queue,
			ordinaryAppendPlan: routePlan.ordinaryAppendRequest?.core.plan ?? null,
			expectedRouteEntriesInDispatchOrder: routePlan.expected,
			observedMatchingEntries: [],
			inspectedAt: request.core.requestedAt,
		};
		const proof: PrimaryAbsenceProofV1 = { core: proofCore, proofSha256: primaryAbsenceProofDigest(proofCore) };
		let ordinaryAppendInspection: OrdinaryAbsenceInspectionV1 | null = null;
		if (routePlan.ordinaryAppendRequest) {
			const appendRequest = routePlan.ordinaryAppendRequest;
			const plan = appendRequest.core.plan;
			ordinaryAppendInspection = {
				status: "authoritative_absence",
				appendRequest,
				plan,
				entry: plan.core.entry,
				proof,
				inspectionSha256: ordinaryAbsenceInspectionDigest(appendRequest, plan, plan.core.entry, proof),
			};
		}
		return {
			status: "authoritative_absence",
			attempt: row.attempt,
			transitionReceipt: row.transitionReceipt,
			proof,
			ordinaryAppendInspection,
			inspectionSha256: primaryInspectionDigest(
				"authoritative_absence",
				row.attempt,
				row.transitionReceipt,
				proof,
				ordinaryAppendInspection,
			),
		};
	}

	async adoptPrimaryCommit(
		request: PrimaryAdoptRequestV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["adoptPrimaryCommit"]> {
		if (
			!detachedIso8601(request.core.requestedAt) ||
			request.core.expectedInspectionSha256 !== request.core.inspection.inspectionSha256 ||
			request.requestSha256 !== primaryAdoptRequestDigest(request)
		)
			return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const inspection = request.core.inspection;
			if (inspection.status === "committed") {
				if (
					inspection.inspectionSha256 !==
					primaryInspectionDigest("committed", null, null, inspection.receipt, inspection.ordinaryAppendInspection)
				)
					return { status: "invalid" };
				const row = projection.state?.primaryCommits.find(
					candidate => candidate.attempt.attemptSha256 === inspection.receipt.core.attemptSha256,
				);
				if (!row?.commitReceipt || !detachedExactJson(row.commitReceipt, inspection.receipt))
					return { status: "inspection_stale" };
				const routePlan = this.#primaryRoutePhysicalPlan(row.attempt.core.request);
				if (!routePlan) return { status: "invalid" };
				for (const candidate of routePlan.candidates) {
					const physical = this.#index.get(candidate.id);
					if (!physical) return { status: "inspection_stale" };
					if (!detachedExactJson(physical, candidate)) return { status: "entry_conflict" };
				}
				if ((routePlan.ordinaryAppendRequest === null) !== (inspection.ordinaryAppendInspection === null))
					return { status: "invalid" };
				if (routePlan.ordinaryAppendRequest && inspection.ordinaryAppendInspection) {
					const ordinary = inspection.ordinaryAppendInspection;
					const persistence = inspection.receipt.core.primaryPersistenceReceipt;
					const embeddedReceipt =
						persistence.core.route === "non_task_ordinary"
							? persistence.core.ordinaryAppendReceipt
							: persistence.core.route === "hub_wait_message_return"
								? persistence.core.hubWaitMessageInjectionResultReceipt.ordinaryAppendReceipt
								: null;
					if (
						!embeddedReceipt ||
						!detachedExactJson(ordinary.appendRequest, routePlan.ordinaryAppendRequest) ||
						!detachedExactJson(ordinary.receipt, embeddedReceipt) ||
						ordinary.inspectionSha256 !==
							ordinaryMatchingInspectionDigest(
								ordinary.appendRequest,
								ordinary.plan,
								ordinary.entry,
								ordinary.receipt,
							)
					)
						return { status: "invalid" };
				}
				const already = projection.state?.primaryAdoptions.includes(request.core.expectedInspectionSha256) ?? false;
				if (!already) {
					const state = this.#draftTransientRuntimeState(projection.state, request.core.requestedAt);
					state.primaryAdoptions.push(request.core.expectedInspectionSha256);
					await this.#commitTransientRuntimeState(state);
				}
				let ordinaryAppendAdoption: OrdinaryCommittedAdoptionV1 | null = null;
				if (inspection.ordinaryAppendInspection) {
					const ordinary = inspection.ordinaryAppendInspection;
					ordinaryAppendAdoption = {
						status: already ? "already_adopted" : "adopted",
						receipt: ordinary.receipt,
						plan: ordinary.plan,
						entry: ordinary.entry,
					};
				}
				return {
					status: already ? "already_adopted" : "adopted",
					receipt: inspection.receipt,
					ordinaryAppendAdoption,
				};
			}
			const attempt = inspection.attempt;
			const row = projection.state?.primaryCommits.find(
				candidate => candidate.attempt.attemptSha256 === attempt.attemptSha256,
			);
			if (!row || !detachedExactJson(row.attempt, attempt)) return { status: "inspection_stale" };
			if (inspection.status === "not_applied") {
				if (
					row.status !== "not_applied" ||
					inspection.inspectionSha256 !== primaryInspectionDigest("not_applied", attempt, null, null, null)
				)
					return { status: "inspection_stale" };
				const already = row.restoredInspectionSha256 === request.core.expectedInspectionSha256;
				if (!already) {
					const state = this.#draftTransientRuntimeState(projection.state, request.core.requestedAt);
					const draft = state.primaryCommits.find(
						candidate => candidate.attempt.attemptSha256 === attempt.attemptSha256,
					);
					if (!draft) return { status: "inspection_stale" };
					draft.restoredInspectionSha256 = request.core.expectedInspectionSha256;
					await this.#commitTransientRuntimeState(state);
				}
				return {
					status: already ? "already_restored_not_applied" : "restored_not_applied",
					attempt,
					authoritativeAbsenceProofSha256: null,
					ordinaryAppendAdoption: null,
				};
			}
			const transition = inspection.transitionReceipt;
			const proof = inspection.proof;
			if (
				row.status !== "outcome_unknown" ||
				!row.transitionReceipt ||
				!detachedExactJson(row.transitionReceipt, transition) ||
				proof.proofSha256 !== primaryAbsenceProofDigest(proof.core) ||
				inspection.inspectionSha256 !==
					primaryInspectionDigest(
						"authoritative_absence",
						attempt,
						transition,
						proof,
						inspection.ordinaryAppendInspection,
					)
			)
				return { status: "inspection_stale" };
			const routePlan = this.#primaryRoutePhysicalPlan(attempt.core.request);
			if (!routePlan || !detachedExactJson(routePlan.expected, proof.core.expectedRouteEntriesInDispatchOrder))
				return { status: "invalid" };
			if ((routePlan.ordinaryAppendRequest === null) !== (inspection.ordinaryAppendInspection === null))
				return { status: "invalid" };
			if (routePlan.ordinaryAppendRequest && inspection.ordinaryAppendInspection) {
				const ordinary = inspection.ordinaryAppendInspection;
				if (
					!detachedExactJson(ordinary.appendRequest, routePlan.ordinaryAppendRequest) ||
					!detachedExactJson(ordinary.proof, proof) ||
					ordinary.inspectionSha256 !==
						ordinaryAbsenceInspectionDigest(ordinary.appendRequest, ordinary.plan, ordinary.entry, proof)
				)
					return { status: "invalid" };
			}
			for (const candidate of routePlan.candidates) {
				const physical = this.#index.get(candidate.id);
				if (physical && !detachedExactJson(physical, candidate)) return { status: "entry_conflict" };
				if (physical) return { status: "outcome_unknown" };
			}
			const queueRows =
				projection.state?.serializerQueues.filter(
					queue =>
						queue.core.serializerKey.serializerKeySha256 ===
						attempt.core.request.core.ticket.core.serializerKey.serializerKeySha256,
				) ?? [];
			if (queueRows.length !== 1) return { status: "ticket_conflict" };
			const queue = queueRows[0];
			if (
				!detachedExactJson(queue, proof.core.unchangedSerializerQueueState) ||
				this.#index.leafId() !== attempt.core.request.core.headPermit.core.currentPriorLeafEntryId ||
				proof.core.serializerKeySha256 !==
					attempt.core.request.core.ticket.core.serializerKey.serializerKeySha256 ||
				proof.core.ticketSha256 !== attempt.core.request.core.ticket.ticketSha256 ||
				proof.core.requestSha256 !== attempt.core.request.requestSha256 ||
				proof.core.attemptSha256 !== attempt.attemptSha256 ||
				proof.core.transitionReceiptSha256 !== transition.transitionReceiptSha256 ||
				proof.core.headPermitSha256 !== attempt.core.request.core.headPermit.permitSha256 ||
				!detachedExactJson(proof.core.ordinaryAppendPlan, routePlan.ordinaryAppendRequest?.core.plan ?? null)
			)
				return { status: "inspection_stale" };
			const already = row.restoredInspectionSha256 === request.core.expectedInspectionSha256;
			if (!already) {
				const state = this.#draftTransientRuntimeState(projection.state, request.core.requestedAt);
				const draft = state.primaryCommits.find(
					candidate => candidate.attempt.attemptSha256 === attempt.attemptSha256,
				);
				if (!draft) return { status: "inspection_stale" };
				draft.status = "not_applied";
				draft.transitionReceipt = null;
				draft.commitReceipt = null;
				draft.restoredInspectionSha256 = request.core.expectedInspectionSha256;
				await this.#commitTransientRuntimeState(state);
			}
			let ordinaryAppendAdoption: OrdinaryRestoredAdoptionV1 | null = null;
			if (inspection.ordinaryAppendInspection) {
				const ordinary = inspection.ordinaryAppendInspection;
				ordinaryAppendAdoption = {
					status: already ? "already_restored_not_applied" : "restored_not_applied",
					appendRequest: ordinary.appendRequest,
					plan: ordinary.plan,
					entry: ordinary.entry,
					proof,
				};
			}
			return {
				status: already ? "already_restored_not_applied" : "restored_not_applied",
				attempt,
				authoritativeAbsenceProofSha256: proof.proofSha256,
				ordinaryAppendAdoption,
			};
		});
	}

	async inspectQueueForRestart(
		request: SerializerQueueInspectRequestV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["inspectQueueForRestart"]> {
		const key = request.core.serializerKey;
		if (
			!detachedIso8601(request.core.requestedAt) ||
			key.serializerKeySha256 !== serializerKeyDigest(key) ||
			request.requestSha256 !== serializerQueueInspectRequestDigest(request)
		)
			return { status: "invalid" };
		if (
			this.#transientAuthorityStatus(
				key.parentSessionId,
				key.parentSessionGenerationSha256,
				key.assistantAnchorEntryId,
				key.parentBranchGenerationSha256,
			) !== "matching"
		)
			return { status: "state_conflict" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const queues =
				projection.state?.serializerQueues.filter(
					queue => queue.core.serializerKey.serializerKeySha256 === key.serializerKeySha256,
				) ?? [];
			if (queues.length > 1) return { status: "duplicate_queue_conflict" };
			const queue = queues[0];
			if (!queue) {
				if (request.core.expectedQueueStateSha256 !== null) return { status: "state_conflict" };
				return {
					status: "absent",
					inspectionSha256: serializerQueueInspectionDigest(request, "absent", null),
				};
			}
			if (
				queue.queueStateSha256 !== serializerQueueDigest(queue.core) ||
				request.core.expectedQueueStateSha256 !== queue.queueStateSha256 ||
				!detachedExactJson(queue.core.serializerKey, key)
			)
				return { status: "state_conflict" };
			const inspection: SerializerQueueMatchingInspectionV1 = {
				status: "matching",
				queueState: queue,
				inspectionSha256: serializerQueueInspectionDigest(request, "matching", queue),
			};
			const existing = projection.state?.queueInspections.find(
				row => row.request.requestSha256 === request.requestSha256,
			);
			if (existing)
				return detachedExactJson(existing, { request, inspection }) ? inspection : { status: "state_conflict" };
			const state = this.#draftTransientRuntimeState(projection.state, request.core.requestedAt);
			state.queueInspections.push({ request: structuredClone(request), inspection: structuredClone(inspection) });
			await this.#commitTransientRuntimeState(state);
			return inspection;
		});
	}

	async adoptQueueForRestart(
		request: SerializerQueueAdoptRequestV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["adoptQueueForRestart"]> {
		if (
			!detachedIso8601(request.core.requestedAt) ||
			request.core.expectedInspectionSha256 !== request.core.inspection.inspectionSha256 ||
			request.requestSha256 !== serializerQueueAdoptRequestDigest(request)
		)
			return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const expected = request.core.inspection.queueState;
			const inspectionRow = projection.state?.queueInspections.find(
				row => row.inspection.inspectionSha256 === request.core.expectedInspectionSha256,
			);
			if (!inspectionRow || !detachedExactJson(inspectionRow.inspection, request.core.inspection))
				return { status: "inspection_stale" };
			if (
				inspectionRow.inspection.inspectionSha256 !==
				serializerQueueInspectionDigest(inspectionRow.request, "matching", inspectionRow.inspection.queueState)
			)
				return { status: "invalid" };
			const queues =
				projection.state?.serializerQueues.filter(
					queue =>
						queue.core.serializerKey.serializerKeySha256 === expected.core.serializerKey.serializerKeySha256,
				) ?? [];
			if (queues.length > 1) return { status: "duplicate_queue_conflict" };
			const queue = queues[0];
			if (!queue || !detachedExactJson(queue, expected)) return { status: "inspection_stale" };
			if (queue.queueStateSha256 !== serializerQueueDigest(queue.core)) return { status: "state_conflict" };
			const already = projection.state?.queueAdoptions.includes(request.core.expectedInspectionSha256) ?? false;
			if (!already) {
				const state = this.#draftTransientRuntimeState(projection.state, request.core.requestedAt);
				state.queueAdoptions.push(request.core.expectedInspectionSha256);
				await this.#commitTransientRuntimeState(state);
			}
			return { status: already ? "already_adopted" : "adopted", queueState: queue };
		});
	}

	async prepareNoHandoffAppend(
		attempt: NoHandoffAttemptV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["prepareNoHandoffAppend"]> {
		if (
			attempt.core.state !== "not_applied" ||
			attempt.core.request.requestSha256 !== noHandoffRequestDigest(attempt.core.request) ||
			attempt.attemptSha256 !== noHandoffAttemptDigest(attempt)
		)
			return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const existing = projection.state?.noHandoffCommits.find(
				row => row.attempt.attemptSha256 === attempt.attemptSha256,
			);
			if (existing)
				return detachedExactJson(existing.attempt, attempt)
					? { status: "already_prepared" }
					: { status: "conflict" };
			const state = this.#draftTransientRuntimeState(projection.state, attempt.core.preparedAt);
			state.noHandoffCommits.push({
				attempt: structuredClone(attempt),
				status: "not_applied",
				transitionReceipt: null,
				receipt: null,
				restoredInspectionSha256: null,
			});
			await this.#commitTransientRuntimeState(state);
			return { status: "prepared" };
		});
	}

	async transitionNoHandoffAppendToOutcomeUnknown(
		attempt: NoHandoffAttemptV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["transitionNoHandoffAppendToOutcomeUnknown"]> {
		if (attempt.attemptSha256 !== noHandoffAttemptDigest(attempt)) return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const row = projection.state?.noHandoffCommits.find(
				candidate => candidate.attempt.attemptSha256 === attempt.attemptSha256,
			);
			if (!row || !detachedExactJson(row.attempt, attempt)) return { status: "conflict" };
			if (row.transitionReceipt) return { status: "already_transitioned", receipt: row.transitionReceipt };
			const core = {
				attemptSha256: attempt.attemptSha256,
				requestSha256: attempt.core.request.requestSha256,
				priorState: "not_applied" as const,
				nextState: "outcome_unknown" as const,
				transitionedImmediatelyBeforeDispatchAt: attempt.core.preparedAt,
			};
			const receipt = { core, transitionReceiptSha256: noHandoffTransitionDigest(core) };
			const state = this.#draftTransientRuntimeState(projection.state, attempt.core.preparedAt);
			const draftRow = state.noHandoffCommits.find(
				candidate => candidate.attempt.attemptSha256 === attempt.attemptSha256,
			)!;
			draftRow.status = "outcome_unknown";
			draftRow.transitionReceipt = receipt;
			await this.#commitTransientRuntimeState(state);
			return { status: "transitioned", receipt };
		});
	}

	async appendOrAdoptNoHandoffResult(
		attempt: NoHandoffAttemptV1,
		transitionReceipt: NoHandoffTransitionV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["appendOrAdoptNoHandoffResult"]> {
		if (
			attempt.attemptSha256 !== noHandoffAttemptDigest(attempt) ||
			transitionReceipt.transitionReceiptSha256 !== noHandoffTransitionDigest(transitionReceipt.core) ||
			transitionReceipt.core.attemptSha256 !== attempt.attemptSha256 ||
			transitionReceipt.core.requestSha256 !== attempt.core.request.requestSha256
		)
			return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			let projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			let row = projection.state?.noHandoffCommits.find(
				candidate => candidate.attempt.attemptSha256 === attempt.attemptSha256,
			);
			if (!row || !detachedExactJson(row.transitionReceipt, transitionReceipt)) return { status: "invalid" };
			if (row.status === "committed")
				return row.receipt ? { status: "already_committed", receipt: row.receipt } : { status: "invalid" };
			if (row.status !== "outcome_unknown") return { status: "outcome_unknown" };
			const injection = await this.#resolveInjectionAppendLocked(attempt.core.request.core.injectionAppendRequest);
			if (injection.status !== "committed" && injection.status !== "already_committed")
				return injection.status === "entry_conflict"
					? { status: "entry_conflict" }
					: injection.status === "prior_leaf_conflict"
						? { status: "parent_conflict" }
						: injection.status === "invalid"
							? { status: "invalid" }
							: { status: "outcome_unknown" };
			const request = attempt.core.request.core;
			if (
				request.taskResultEntry.parentId !== injection.receipt.core.nextTaskResultAppendParentEntryId ||
				this.#index.leafId() !== request.taskResultEntry.parentId
			)
				return { status: "parent_conflict" };
			const candidate = this.#exactForegroundMessageEntry(request.taskResultEntry);
			if (!candidate) return { status: "invalid" };
			const physical = this.#index.get(candidate.id);
			if (physical && !detachedExactJson(physical, candidate)) return { status: "entry_conflict" };
			projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "outcome_unknown" };
			row = projection.state?.noHandoffCommits.find(
				candidateRow => candidateRow.attempt.attemptSha256 === attempt.attemptSha256,
			);
			if (!row?.transitionReceipt) return { status: "outcome_unknown" };
			const receiptCore = {
				requestSha256: attempt.core.request.requestSha256,
				attemptSha256: attempt.attemptSha256,
				transitionReceiptSha256: transitionReceipt.transitionReceiptSha256,
				injectionAppendReceipt: injection.receipt,
				taskResultEntry: request.taskResultEntry,
				nextPriorLeafEntryId: request.taskResultEntry.id,
				committedAt: request.requestedAt,
			};
			const receipt = { core: receiptCore, receiptSha256: noHandoffReceiptDigest(receiptCore) };
			const state = this.#draftTransientRuntimeState(projection.state, request.requestedAt);
			const draftRow = state.noHandoffCommits.find(
				candidateRow => candidateRow.attempt.attemptSha256 === attempt.attemptSha256,
			)!;
			draftRow.status = "committed";
			draftRow.receipt = receipt;
			this.#sealTransientRuntimeState(state);
			try {
				await this.#appendEntriesAtomicallyLocked(() => {
					if (!physical) this.#recordEntry(candidate);
					this.#recordTransientRuntimeState(state);
				});
			} catch {
				return { status: "outcome_unknown" };
			}
			return { status: "committed", receipt };
		});
	}

	async inspectNoHandoffAppend(
		request: NoHandoffInspectRequestV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["inspectNoHandoffAppend"]> {
		if (
			!detachedIso8601(request.core.requestedAt) ||
			request.requestSha256 !== noHandoffInspectRequestDigest(request)
		)
			return { status: "invalid" };
		const projection = this.#transientRuntimeStateProjection();
		if (!projection.valid) return { status: "invalid" };
		const row = projection.state?.noHandoffCommits.find(
			candidate => candidate.attempt.attemptSha256 === request.core.attempt.attemptSha256,
		);
		if (!row) return { status: "absent" };
		if (!detachedExactJson(row.attempt, request.core.attempt)) return { status: "conflict" };
		if (row.status === "not_applied")
			return {
				status: "not_applied",
				attempt: row.attempt,
				inspectionSha256: noHandoffInspectionDigest(request, "not_applied", row.attempt),
			};
		if (
			!row.transitionReceipt ||
			request.core.expectedTransitionReceiptSha256 !== row.transitionReceipt.transitionReceiptSha256
		)
			return { status: "conflict" };
		if (row.status === "outcome_unknown")
			return {
				status: "outcome_unknown",
				transitionReceipt: row.transitionReceipt,
				inspectionSha256: noHandoffInspectionDigest(request, "outcome_unknown", row.transitionReceipt),
			};
		if (!row.receipt) return { status: "invalid" };
		return {
			status: "committed",
			receipt: row.receipt,
			inspectionSha256: noHandoffInspectionDigest(request, "committed", row.receipt),
		};
	}

	async adoptNoHandoffAppend(
		request: NoHandoffAdoptRequestV1,
	): ReturnType<AgentSessionToolResultPersistenceSerializerV1["adoptNoHandoffAppend"]> {
		if (
			!detachedIso8601(request.core.requestedAt) ||
			request.core.expectedInspectionSha256 !== request.core.inspection.inspectionSha256 ||
			request.requestSha256 !== noHandoffAdoptRequestDigest(request)
		)
			return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const attemptSha256 =
				request.core.inspection.status === "not_applied"
					? request.core.inspection.attempt.attemptSha256
					: request.core.inspection.receipt.core.attemptSha256;
			const row = projection.state?.noHandoffCommits.find(
				candidate => candidate.attempt.attemptSha256 === attemptSha256,
			);
			if (!row) return { status: "inspection_stale" };
			if (request.core.inspection.status === "committed") {
				if (!row.receipt || !detachedExactJson(row.receipt, request.core.inspection.receipt))
					return { status: "inspection_stale" };
				return { status: "already_adopted", receipt: row.receipt };
			}
			if (row.status === "outcome_unknown") return { status: "outcome_unknown" };
			if (!detachedExactJson(row.attempt, request.core.inspection.attempt)) return { status: "inspection_stale" };
			const already = row.restoredInspectionSha256 === request.core.expectedInspectionSha256;
			if (!already) {
				const state = this.#draftTransientRuntimeState(projection.state, request.core.requestedAt);
				state.noHandoffCommits.find(
					candidate => candidate.attempt.attemptSha256 === attemptSha256,
				)!.restoredInspectionSha256 = request.core.expectedInspectionSha256;
				await this.#commitTransientRuntimeState(state);
			}
			return {
				status: already ? "already_restored_not_applied" : "restored_not_applied",
				attempt: row.attempt,
			};
		});
	}

	async preallocateExactToolResultEntry(
		request: ForegroundPreallocationRequestV1,
	): ReturnType<TransientTaskForegroundSessionAppendBridgeV1["preallocateExactToolResultEntry"]> {
		if (
			request.schemaVersion !== 1 ||
			request.expectedToolResultEntryId !== foregroundPreallocationId(request.entryPreallocationOperationId) ||
			request.foregroundAppendBatchKeySha256 !==
				deriveTransientTaskForegroundAppendBatchKeyV1({
					parentSessionId: request.parentSessionId,
					parentSessionGenerationSha256: request.parentSessionGenerationSha256,
					parentBranchGenerationSha256: request.parentBranchGenerationSha256,
					parentBranchAnchorEntryId: request.parentBranchAnchorEntryId,
					toolCallId: request.toolCallId,
					orderedPreReturnIdentitySha256s: request.orderedPreReturnIdentitySha256s,
				})
		)
			return { status: "invalid" };
		const authority = this.#transientAuthorityStatus(
			request.parentSessionId,
			request.parentSessionGenerationSha256,
			request.parentBranchAnchorEntryId,
			request.parentBranchGenerationSha256,
		);
		if (authority === "session_generation_replaced") return { status: "session_generation_replaced" };
		if (authority === "branch_generation_replaced") return { status: "branch_generation_replaced" };
		if (authority === "branch_anchor_missing") return { status: "branch_anchor_missing" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const existing = projection.state?.foregroundPreallocations.find(
				row => row.request.entryPreallocationOperationId === request.entryPreallocationOperationId,
			);
			if (existing)
				return detachedExactJson(existing.request, request)
					? {
							status: "already_preallocated",
							foregroundAppendBatchKeySha256: request.foregroundAppendBatchKeySha256,
							toolResultEntryId: existing.toolResultEntryId,
						}
					: { status: "entry_id_conflict" };
			if (this.#index.has(request.expectedToolResultEntryId)) return { status: "entry_id_conflict" };
			const state = this.#draftTransientRuntimeState(projection.state, this.#header.timestamp);
			state.foregroundPreallocations.push({
				request: structuredClone(request),
				toolResultEntryId: request.expectedToolResultEntryId,
			});
			await this.#commitTransientRuntimeState(state);
			return {
				status: "preallocated",
				foregroundAppendBatchKeySha256: request.foregroundAppendBatchKeySha256,
				toolResultEntryId: request.expectedToolResultEntryId,
			};
		});
	}

	async appendExactToolResult(
		request: ForegroundSessionAppendRequestV1,
	): ReturnType<TransientTaskForegroundSessionAppendBridgeV1["appendExactToolResult"]> {
		if (
			request.schemaVersion !== 1 ||
			request.sessionAppendRequestSha256 !== foregroundSessionAppendRequestDigest(request) ||
			request.toolResultEntryId !== request.entry.id ||
			request.appendParentEntryId !== request.entry.parentId
		)
			return { status: "invalid" };
		const authority = this.#transientAuthorityStatus(
			request.parentSessionId,
			request.parentSessionGenerationSha256,
			request.parentBranchAnchorEntryId,
			request.parentBranchGenerationSha256,
		);
		if (authority === "session_generation_replaced") return { status: "session_generation_replaced" };
		if (authority === "branch_generation_replaced") return { status: "branch_generation_replaced" };
		if (authority === "branch_anchor_missing") return { status: "branch_anchor_missing" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#transientRuntimeStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const existing = projection.state?.foregroundAppends.find(
				row => row.request.foregroundAppendBatchKeySha256 === request.foregroundAppendBatchKeySha256,
			);
			if (existing)
				return detachedExactJson(existing.request, request)
					? { status: "already_appended", receipt: existing.receipt }
					: { status: "message_conflict" };
			const preallocation = projection.state?.foregroundPreallocations.find(
				row =>
					row.request.foregroundAppendBatchKeySha256 === request.foregroundAppendBatchKeySha256 &&
					row.toolResultEntryId === request.toolResultEntryId,
			);
			if (!preallocation) return { status: "entry_id_conflict" };
			const injection = projection.state?.injectionAppends.find(
				row => row.requestSha256 === request.injectionAppendRequestSha256,
			);
			if (injection?.status !== "committed" || !injection.receipt) return { status: "append_outcome_unknown" };
			if (injection.receipt.core.nextTaskResultAppendParentEntryId !== request.appendParentEntryId)
				return { status: "append_parent_stale" };
			if (this.#index.leafId() !== request.appendParentEntryId) return { status: "append_parent_stale" };
			const candidate = this.#exactForegroundMessageEntry(request.entry);
			if (!candidate) return { status: "invalid" };
			const physical = this.#index.get(candidate.id);
			if (physical && !detachedExactJson(physical, candidate)) return { status: "entry_id_conflict" };
			const toolResultMessageUtf8 = JSON.stringify(request.entry.message);
			const receiptCore = {
				schemaVersion: 1 as const,
				foregroundAppendBatchKeySha256: request.foregroundAppendBatchKeySha256,
				appendBatchSha256: request.appendBatchSha256,
				orderedAppendOperationIds: request.orderedAppendOperationIds,
				orderedSettlementIdentitySha256s: request.orderedSettlementIdentitySha256s,
				sessionAppendRequestSha256: request.sessionAppendRequestSha256,
				injectionAppendReceiptSha256: injection.receipt.receiptSha256,
				entry: request.entry,
				toolResultMessageUtf8,
				toolResultMessageUtf8Sha256: detachedUtf8Sha256Ref(toolResultMessageUtf8),
				toolResultMessageUtf8ByteLength: Buffer.byteLength(toolResultMessageUtf8, "utf8"),
				committedAt: request.entry.timestamp,
			};
			const receipt = { ...receiptCore, primaryReceiptSha256: foregroundSessionAppendReceiptDigest(receiptCore) };
			const state = this.#draftTransientRuntimeState(projection.state, request.entry.timestamp);
			state.foregroundAppends.push({ request: structuredClone(request), receipt });
			this.#sealTransientRuntimeState(state);
			try {
				await this.#appendEntriesAtomicallyLocked(() => {
					if (!physical) this.#recordEntry(candidate);
					this.#recordTransientRuntimeState(state);
				});
			} catch {
				return { status: "append_outcome_unknown" };
			}
			return { status: "appended", receipt };
		});
	}

	async inspectExactToolResult(
		request: ForegroundSessionAppendInspectRequestV1,
	): ReturnType<TransientTaskForegroundSessionAppendBridgeV1["inspectExactToolResult"]> {
		const authority = this.#transientAuthorityStatus(
			request.parentSessionId,
			request.parentSessionGenerationSha256,
			request.parentBranchAnchorEntryId,
			request.parentBranchGenerationSha256,
		);
		if (authority === "session_generation_replaced") return { status: "session_generation_replaced" };
		if (authority === "branch_generation_replaced") return { status: "branch_generation_replaced" };
		if (authority === "branch_anchor_missing") return { status: "branch_anchor_missing" };
		const projection = this.#transientRuntimeStateProjection();
		if (!projection.valid) return { status: "invalid" };
		const inspectedAt = projection.state?.updatedAt ?? this.#header.timestamp;
		const row = projection.state?.foregroundAppends.find(
			candidate => candidate.request.foregroundAppendBatchKeySha256 === request.foregroundAppendBatchKeySha256,
		);
		if (!row)
			return {
				status: "absent",
				inspectedAt,
				inspectionSha256: foregroundSessionInspectDigest(request, "absent", null),
			};
		const receipt = row.receipt;
		if (
			row.request.appendBatchSha256 !== request.appendBatchSha256 ||
			row.request.injectionAppendRequestSha256 !== request.injectionAppendRequestSha256 ||
			row.request.appendParentEntryId !== request.appendParentEntryId
		)
			return { status: "append_parent_stale" };
		if (row.request.toolResultEntryId !== request.toolResultEntryId) return { status: "entry_id_conflict" };
		if (
			!detachedExactJson(row.request.orderedAppendOperationIds, request.orderedAppendOperationIds) ||
			!detachedExactJson(row.request.orderedSettlementIdentitySha256s, request.orderedSettlementIdentitySha256s) ||
			receipt.entry.sessionEntryJsonlUtf8Sha256 !== request.sessionEntryJsonlUtf8Sha256 ||
			receipt.entry.sessionEntryJsonlUtf8ByteLength !== request.sessionEntryJsonlUtf8ByteLength ||
			receipt.toolResultMessageUtf8Sha256 !== request.toolResultMessageUtf8Sha256 ||
			receipt.toolResultMessageUtf8ByteLength !== request.toolResultMessageUtf8ByteLength
		)
			return { status: "message_conflict" };
		const candidate = this.#exactForegroundMessageEntry(receipt.entry);
		if (!candidate) return { status: "invalid" };
		const physical = this.#index.get(receipt.entry.id);
		if (!physical) return { status: "append_parent_stale" };
		if (!detachedExactJson(physical, candidate)) return { status: "entry_id_conflict" };
		return {
			status: "matching",
			primaryReceiptSha256: receipt.primaryReceiptSha256,
			sessionEntryJsonlUtf8Sha256: receipt.entry.sessionEntryJsonlUtf8Sha256,
			sessionEntryJsonlUtf8ByteLength: receipt.entry.sessionEntryJsonlUtf8ByteLength,
			toolResultMessageUtf8Sha256: receipt.toolResultMessageUtf8Sha256,
			toolResultMessageUtf8ByteLength: receipt.toolResultMessageUtf8ByteLength,
			inspectedAt,
			inspectionSha256: foregroundSessionInspectDigest(request, "matching", receipt),
		};
	}
	async prepareDetachedPrimarySessionAppendPlan(
		request: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanPrepareRequestV1,
	): Promise<
		| {
				readonly status: "prepared" | "already_prepared";
				readonly plan: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1;
				readonly orderedOutboxReceipts: readonly [
					ConfidentialTransientTaskDetachedSessionOutboxReceiptV1,
					...ConfidentialTransientTaskDetachedSessionOutboxReceiptV1[],
				];
		  }
		| {
				readonly status:
					| "session_generation_conflict"
					| "branch_generation_conflict"
					| "parent_conflict"
					| "open_plan_conflict"
					| "member_conflict"
					| "invalid";
		  }
	> {
		if (!validDetachedPrepareRequest(request)) return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#detachedStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const existing = projection.batchKeys.get(request.primaryAppendBatchKeySha256);
			if (existing) {
				return detachedExactJson(
					detachedPrepareRequestFromBundle(existing.plan, existing.orderedOutboxReceipts),
					request,
				)
					? {
							status: "already_prepared" as const,
							plan: existing.plan,
							orderedOutboxReceipts: existing.orderedOutboxReceipts,
						}
					: { status: "open_plan_conflict" as const };
			}
			if (
				!this.#persist ||
				!this.#sessionFile ||
				request.primarySessionId !== this.#sessionId ||
				request.primarySessionGenerationSha256 !== this.#detachedSessionGenerationSha256()
			)
				return { status: "session_generation_conflict" };
			if (
				request.primaryBranchGenerationSha256 !==
					this.#detachedBranchGenerationSha256(request.primaryBranchAnchorEntryId) ||
				(request.primaryBranchAnchorEntryId !== null &&
					(!this.#index.has(request.primaryBranchAnchorEntryId) ||
						isDetachedPrimaryAppendStateEntry(this.#index.get(request.primaryBranchAnchorEntryId)!)))
			)
				return { status: "branch_generation_conflict" };
			if (
				request.appendParentEntryId !== request.primaryBranchAnchorEntryId ||
				(request.appendParentEntryId !== null && !this.#index.has(request.appendParentEntryId)) ||
				this.#index.leafId() !== request.appendParentEntryId
			)
				return { status: "parent_conflict" };
			for (const member of request.orderedOutboxMembers) {
				if (projection.memberSha256s.has(member.memberSha256)) return { status: "member_conflict" };
			}
			for (const state of projection.plans.values()) {
				if (
					state.status !== "committed" &&
					state.plan.primarySessionId === request.primarySessionId &&
					state.plan.primarySessionGenerationSha256 === request.primarySessionGenerationSha256 &&
					state.plan.primaryBranchGenerationSha256 === request.primaryBranchGenerationSha256 &&
					state.plan.primaryBranchAnchorEntryId === request.primaryBranchAnchorEntryId
				)
					return { status: "open_plan_conflict" };
			}

			const primarySessionEntryId = generateId(this.#detachedReservedEntryIdView());
			const primarySessionEntry: SessionMessageEntry = {
				type: "message",
				id: primarySessionEntryId,
				parentId: request.appendParentEntryId,
				timestamp: request.primarySessionEntryTimestamp,
				message: request.primarySessionMessage,
			};
			let primarySessionEntryJsonlUtf8: string;
			try {
				primarySessionEntryJsonlUtf8 = projectSessionEntryForPersistence(
					primarySessionEntry,
					this.#entries.length,
					this.#blobs,
				).canonicalLine;
			} catch {
				return { status: "invalid" };
			}
			const plan = buildDetachedPlan(request, primarySessionEntryId, primarySessionEntryJsonlUtf8);
			const orderedOutboxReceipts = buildDetachedOutboxReceipts(request, plan);
			if (!this.#detachedPlanHasCanonicalEntry(plan)) return { status: "invalid" };
			await this.#appendEntriesAtomicallyLocked(() => {
				this.#recordDetachedPrimaryState(
					{ schemaVersion: 1, state: "not_applied", plan, orderedOutboxReceipts },
					plan,
				);
			});
			return { status: "prepared", plan, orderedOutboxReceipts };
		});
	}

	async appendFixedDetachedPrimarySessionPlan(
		request: ConfidentialTransientTaskDetachedPrimarySessionAppendRequestV1,
	): Promise<ConfidentialTransientTaskDetachedPrimarySessionAppendResultV1> {
		if (!validDetachedAppendRequest(request)) return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#detachedStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const state = projection.plans.get(request.plan.primaryAppendPlanSha256);
			if (!state) return { status: "plan_missing" };
			if (!detachedExactJson(state.plan, request.plan)) return { status: "entry_conflict" };
			if (!detachedExactJson(state.orderedOutboxReceipts, request.orderedOutboxReceipts))
				return { status: "member_conflict" };
			if (state.status === "committed") {
				if (!state.receipt || state.receipt.primaryAppendRequestSha256 !== request.primaryAppendRequestSha256)
					return { status: "invalid" };
				return { status: "already_appended", receipt: state.receipt };
			}
			const authority = this.#detachedPlanAuthorityStatus(state.plan, state.status === "not_applied");
			if (authority !== "matching") return { status: authority };
			if (state.status === "outcome_unknown") {
				return { status: "append_outcome_unknown", primaryAppendPlanSha256: state.plan.primaryAppendPlanSha256 };
			}
			if (
				state.primaryAppendRequestSha256 !== null &&
				state.primaryAppendRequestSha256 !== request.primaryAppendRequestSha256
			)
				return { status: "invalid" };
			if (this.#index.has(state.plan.primarySessionEntryId)) return { status: "entry_conflict" };
			const beforeArm = await this.#inspectDetachedPrimaryPhysicalEntry(state.plan);
			if (beforeArm === "matching" || beforeArm === "conflict") return { status: "entry_conflict" };
			if (beforeArm !== "absent") return { status: "invalid" };
			await this.#appendEntriesAtomicallyLocked(() => {
				this.#recordDetachedPrimaryState(
					{
						schemaVersion: 1,
						state: "outcome_unknown",
						primaryAppendPlanSha256: state.plan.primaryAppendPlanSha256,
						primaryAppendRequestSha256: request.primaryAppendRequestSha256,
					},
					state.plan,
				);
			});
			if (
				this.#detachedPlanAuthorityStatus(state.plan, true) !== "matching" ||
				this.#index.has(state.plan.primarySessionEntryId)
			)
				return { status: "append_outcome_unknown", primaryAppendPlanSha256: state.plan.primaryAppendPlanSha256 };
			try {
				await this.#appendDetachedPrimaryEntry(state.plan);
			} catch {
				return { status: "append_outcome_unknown", primaryAppendPlanSha256: state.plan.primaryAppendPlanSha256 };
			}
			const receipt = buildDetachedPersistenceReceipt(
				state.plan,
				state.orderedOutboxReceipts,
				request.primaryAppendRequestSha256,
			);
			try {
				await this.#appendEntriesAtomicallyLocked(() => {
					this.#recordDetachedPrimaryState({ schemaVersion: 1, state: "committed", receipt }, state.plan);
				});
			} catch {
				return { status: "append_outcome_unknown", primaryAppendPlanSha256: state.plan.primaryAppendPlanSha256 };
			}
			return { status: "appended", receipt };
		});
	}

	async inspectFixedDetachedPrimarySessionAppend(
		request: ConfidentialTransientTaskDetachedPrimarySessionAppendInspectRequestV1,
	): Promise<ConfidentialTransientTaskDetachedPrimarySessionAppendInspectResultV1> {
		if (!validDetachedInspectRequest(request)) return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#detachedStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const state = projection.plans.get(request.plan.primaryAppendPlanSha256);
			if (!state) return { status: "plan_missing" };
			if (!detachedExactJson(state.plan, request.plan)) return { status: "entry_conflict" };
			const expectedRequestSha256 = detachedControllerDigest("primary-session-append-request", {
				plan: state.plan,
				orderedOutboxReceipts: state.orderedOutboxReceipts,
			});
			if (
				request.expectedPrimaryAppendRequestSha256 !== expectedRequestSha256 ||
				(state.primaryAppendRequestSha256 !== null && state.primaryAppendRequestSha256 !== expectedRequestSha256)
			)
				return { status: "invalid" };
			const authority = this.#detachedPlanAuthorityStatus(state.plan, state.status === "not_applied");
			if (authority !== "matching") return { status: authority };
			const physical = await this.#inspectDetachedPrimaryPhysicalEntry(state.plan);
			if (physical === "conflict") return { status: "entry_conflict" };
			if (state.status === "committed") {
				if (!state.receipt || physical !== "matching") return { status: "invalid" };
				return {
					status: "committed",
					receipt: state.receipt,
					inspectionSha256: detachedInspectionSha256(state.plan, expectedRequestSha256, [
						"committed",
						detachedPersistenceReceiptTuple(state.receipt),
					]),
				};
			}
			if (state.status === "not_applied") {
				if (physical !== "absent")
					return physical === "matching" ? { status: "entry_conflict" } : { status: "invalid" };
				return {
					status: "not_applied",
					plan: state.plan,
					inspectionSha256: detachedInspectionSha256(state.plan, expectedRequestSha256, [
						"not_applied",
						detachedPlanTuple(state.plan),
					]),
				};
			}
			if (physical === "matching") {
				if (
					this.#index.leafId() !== state.plan.appendParentEntryId &&
					this.#index.leafId() !== state.plan.primarySessionEntryId
				)
					return { status: "parent_conflict" };
				return {
					status: "append_outcome_unknown",
					plan: state.plan,
					observation: "matching_entry",
					matchingEntryJsonlUtf8Sha256: state.plan.primarySessionEntryJsonlUtf8Sha256,
					authoritativeAbsenceProof: null,
					inspectionSha256: detachedInspectionSha256(state.plan, expectedRequestSha256, [
						"append_outcome_unknown",
						"matching_entry",
						detachedPlanTuple(state.plan),
						state.plan.primarySessionEntryJsonlUtf8Sha256,
						null,
					]),
				};
			}
			if (physical !== "absent" || this.#index.leafId() !== state.plan.appendParentEntryId)
				return physical === "absent" ? { status: "parent_conflict" } : { status: "invalid" };
			const authoritativeAbsenceProof = buildDetachedAbsenceProof(state.plan, this.#index.leafId());
			return {
				status: "append_outcome_unknown",
				plan: state.plan,
				observation: "authoritative_absence",
				matchingEntryJsonlUtf8Sha256: null,
				authoritativeAbsenceProof,
				inspectionSha256: detachedInspectionSha256(state.plan, expectedRequestSha256, [
					"append_outcome_unknown",
					"authoritative_absence",
					detachedPlanTuple(state.plan),
					null,
					detachedAbsenceProofTuple(authoritativeAbsenceProof),
				]),
			};
		});
	}

	async adoptFixedDetachedPrimarySessionAppend(
		request: ConfidentialTransientTaskDetachedPrimarySessionAppendAdoptRequestV1,
	): Promise<ConfidentialTransientTaskDetachedPrimarySessionAppendAdoptResultV1> {
		if (!validDetachedAdoptRequest(request)) return { status: "invalid" };
		return this.#withAtomicPersistenceLock(async () => {
			const projection = this.#detachedStateProjection();
			if (!projection.valid) return { status: "invalid" };
			const state = projection.plans.get(request.plan.primaryAppendPlanSha256);
			if (!state || !detachedExactJson(state.plan, request.plan)) return { status: "invalid" };
			const expectedRequestSha256 = detachedControllerDigest("primary-session-append-request", {
				plan: state.plan,
				orderedOutboxReceipts: state.orderedOutboxReceipts,
			});
			if (
				request.expectedPrimaryAppendRequestSha256 !== expectedRequestSha256 ||
				(state.primaryAppendRequestSha256 !== null && state.primaryAppendRequestSha256 !== expectedRequestSha256)
			)
				return { status: "invalid" };
			if (
				request.currentPrimarySessionId !== this.#sessionId ||
				request.currentPrimarySessionGenerationSha256 !== this.#detachedSessionGenerationSha256()
			)
				return { status: "session_generation_conflict" };
			if (
				request.currentPrimaryBranchAnchorEntryId !== state.plan.primaryBranchAnchorEntryId ||
				request.currentPrimaryBranchGenerationSha256 !==
					this.#detachedBranchGenerationSha256(request.currentPrimaryBranchAnchorEntryId) ||
				request.currentPrimaryBranchGenerationSha256 !== state.plan.primaryBranchGenerationSha256
			)
				return { status: "branch_generation_conflict" };
			if (request.currentLeafEntryId !== this.#index.leafId()) return { status: "parent_conflict" };
			const authority = this.#detachedPlanAuthorityStatus(state.plan, false);
			if (authority !== "matching") return { status: authority };
			const physical = await this.#inspectDetachedPrimaryPhysicalEntry(state.plan);
			if (physical === "conflict") return { status: "entry_conflict" };
			const matchingInspectionSha256 = detachedInspectionSha256(state.plan, expectedRequestSha256, [
				"append_outcome_unknown",
				"matching_entry",
				detachedPlanTuple(state.plan),
				state.plan.primarySessionEntryJsonlUtf8Sha256,
				null,
			]);
			if (state.status === "committed") {
				if (!state.receipt || physical !== "matching") return { status: "invalid" };
				const committedInspectionSha256 = detachedInspectionSha256(state.plan, expectedRequestSha256, [
					"committed",
					detachedPersistenceReceiptTuple(state.receipt),
				]);
				if (
					request.expectedInspectionSha256 !== matchingInspectionSha256 &&
					request.expectedInspectionSha256 !== committedInspectionSha256
				)
					return { status: "inspection_stale" };
				return { status: "already_adopted", receipt: state.receipt };
			}
			if (state.status === "not_applied") {
				if (
					state.restoredInspectionSha256 === request.expectedInspectionSha256 &&
					physical === "absent" &&
					this.#index.leafId() === state.plan.appendParentEntryId
				)
					return { status: "already_not_applied", plan: state.plan };
				return { status: "inspection_stale" };
			}
			if (physical === "matching") {
				if (request.expectedInspectionSha256 !== matchingInspectionSha256) return { status: "inspection_stale" };
				if (
					this.#index.leafId() !== state.plan.appendParentEntryId &&
					this.#index.leafId() !== state.plan.primarySessionEntryId
				)
					return { status: "parent_conflict" };
				if (!this.#insertDetachedPrimaryEntryFromDurable(state.plan)) return { status: "entry_conflict" };
				if (this.#diskFailure) {
					try {
						await this.#authoritativelyRewriteCurrentStateLocked(this.#diskFailure);
					} catch {
						return { status: "append_outcome_unknown" };
					}
				}
				const receipt = buildDetachedPersistenceReceipt(
					state.plan,
					state.orderedOutboxReceipts,
					expectedRequestSha256,
				);
				try {
					await this.#appendEntriesAtomicallyLocked(() => {
						this.#recordDetachedPrimaryState({ schemaVersion: 1, state: "committed", receipt }, state.plan);
					});
				} catch {
					return { status: "append_outcome_unknown" };
				}
				return { status: "adopted", receipt };
			}
			if (physical !== "absent") return { status: "append_outcome_unknown" };
			if (this.#index.leafId() !== state.plan.appendParentEntryId) return { status: "parent_conflict" };
			const authoritativeAbsenceProof = buildDetachedAbsenceProof(state.plan, this.#index.leafId());
			const absenceInspectionSha256 = detachedInspectionSha256(state.plan, expectedRequestSha256, [
				"append_outcome_unknown",
				"authoritative_absence",
				detachedPlanTuple(state.plan),
				null,
				detachedAbsenceProofTuple(authoritativeAbsenceProof),
			]);
			if (request.expectedInspectionSha256 !== absenceInspectionSha256) return { status: "inspection_stale" };
			if (state.restoredInspectionSha256 !== null) return { status: "append_outcome_unknown" };
			try {
				await this.#appendEntriesAtomicallyLocked(() => {
					this.#recordDetachedPrimaryState(
						{
							schemaVersion: 1,
							state: "restored_not_applied",
							primaryAppendPlanSha256: state.plan.primaryAppendPlanSha256,
							primaryAppendRequestSha256: expectedRequestSha256,
							inspectionSha256: absenceInspectionSha256,
							authoritativeAbsenceProof,
						},
						state.plan,
					);
				});
			} catch {
				return { status: "append_outcome_unknown" };
			}
			return { status: "restored_not_applied", plan: state.plan };
		});
	}

	async enumeratePendingDetachedPrimarySessionAppendPlans(
		request: ConfidentialTransientTaskDetachedPrimarySessionPendingPlanEnumerateRequestV1,
	): Promise<readonly ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1[]> {
		if (!validDetachedPendingEnumerateRequest(request)) return [];
		return this.#withAtomicPersistenceLock(async () => {
			if (
				!this.#persist ||
				!this.#sessionFile ||
				request.primarySessionId !== this.#sessionId ||
				request.primarySessionGenerationSha256 !== this.#detachedSessionGenerationSha256() ||
				request.primaryBranchGenerationSha256 !==
					this.#detachedBranchGenerationSha256(request.primaryBranchAnchorEntryId) ||
				request.currentLeafEntryId !== this.#index.leafId()
			)
				return [];
			const projection = this.#detachedStateProjection();
			if (!projection.valid) return [];
			const pending: ConfidentialTransientTaskDetachedPrimarySessionAppendPlanV1[] = [];
			for (const state of projection.plans.values()) {
				if (
					state.status !== "committed" &&
					state.plan.primarySessionId === request.primarySessionId &&
					state.plan.primarySessionGenerationSha256 === request.primarySessionGenerationSha256 &&
					state.plan.primaryBranchGenerationSha256 === request.primaryBranchGenerationSha256 &&
					state.plan.primaryBranchAnchorEntryId === request.primaryBranchAnchorEntryId &&
					(state.status === "outcome_unknown"
						? request.currentLeafEntryId === state.plan.appendParentEntryId ||
							request.currentLeafEntryId === state.plan.primarySessionEntryId
						: request.currentLeafEntryId === state.plan.appendParentEntryId)
				)
					pending.push(state.plan);
			}
			return pending;
		});
	}
}

/**
 * Stores and navigates an append-only conversation journal.
 *
 * A session is a JSONL file: one header line followed by entries. Entries form a
 * tree by `(id, parentId)`, and the mutable leaf pointer selects which path is
 * active for future appends and for LLM context construction.
 *
 * Durability is software-crash safe but not power-loss safe: completed entries
 * (user/assistant/toolResult messages, tool_execution_start markers, custom
 * entries) are handed to the OS synchronously in-body on append and never
 * `fsync`'d. In-flight streaming text is intentionally not durable until
 * `message_end` persists the finished message.
 *
 * While an in-place atomic rewrite is publishing, a concurrent completed append
 * supersedes that publish with a synchronous full-body rewrite so the entry is
 * software-crash durable before the append returns; the abandoned atomic's
 * `commitGuard` then refuses to clobber the fresher body.
 *
 * During {@link moveTo}, appends write a full body to the live relocation path
 * (source until rename, destination once the rename has landed) so a crash mid-
 * move still preserves completed entries without recreating a vacated source.
 * A trailing atomic rewrite still rewrites the header cwd after the path is
 * repointed.
 */
export class SessionManager implements SessionManagerJournalGenerationAuthorityResolverV1 {
	#cwd: string;
	/** Additional workspace directories beyond cwd (multi-root). Normalized absolute, deduped, excludes cwd. */
	#additionalDirectories: string[] = [];
	#sessionDir: string;
	readonly #persist: boolean;
	readonly #storage: SessionStorage;
	readonly #blobs: BlobStore;
	#journalService: SessionJournalService | undefined;
	#journalDescriptor: SessionJournalStreamDescriptorV1 | undefined;
	#journalHandle: SessionJournalStreamHandle | undefined;
	#journalProjection: CanonicalSessionProjectionV1 | undefined;

	#sessionId = "";
	#sessionName: string | undefined;
	#titleSource: SessionTitleSource | undefined;
	#sessionFile: string | undefined;
	#header!: SessionHeader;
	#titleUpdatedAt = "";
	#hasTitleSlot = true;
	#entries: SessionEntry[] = [];
	#index = new SessionEntryIndex();

	/** File reflects all current entries; appends can go incrementally. */
	#fileIsCurrent = false;
	/** In-memory entries diverged from disk (load-migration/sanitize) → next persist must full-rewrite. */
	#rewriteRequired = false;
	/** Lazy gate crossed (ensureOnDisk / loaded file): every entry must persist from now on. */
	#forceFileCreation = false;
	/**
	 * Armed only when this manager observed a draft sidecar lifecycle that
	 * materialized an otherwise metadata-only session file. Explicit
	 * ensureOnDisk() callers (ACP session/new, handoff) must survive close().
	 */
	#draftOnlySessionCleanupArmed = false;

	/**
	 * Collab replication tap: invoked for every appended entry with the
	 * in-memory (pre-blob-externalization) entry, so inline images survive.
	 */
	onEntryAppended?: (entry: SessionEntry) => void;

	#turnBudgetTotal: number | null = null;
	#turnBudgetHard = false;
	#turnOutputBaseline = 0;
	#turnEvalOutput = 0;

	/** The single open append writer; the manager only ever writes one file at a time. */
	#writer: SessionStorageWriter | undefined;
	/** Serializes async disk work (flush/close/atomic rewrite). Appends are synchronous and bypass it. */
	#diskTail: Promise<void> = Promise.resolve();
	#diskFailure: Error | undefined;
	#diskFailureLogged = false;
	/** FIFO reservation for atomic batches and authoritative recovery. */
	#atomicPersistenceTail: Promise<void> = Promise.resolve();
	/** Observer notifications withheld until their entries are proven durable. */
	#pendingDurabilityNotifications: SessionEntry[] = [];
	/** Bumped on every sync rewrite / chain reset so stale queued tasks become no-ops. */
	#diskEpoch = 0;
	/**
	 * Epoch of the in-flight atomic rewrite, or `null` when no rewrite is running.
	 * The fence in {@link #appendToSessionFile} only applies while this matches
	 * `#diskEpoch`: once a synchronous rewrite (`flushSync` → `#rewriteSynchronously`)
	 * bumps the epoch, the pending atomic publish is guaranteed to abandon via
	 * its `commitGuard`, and appends can safely take the hot path against the
	 * freshly-published file.
	 */
	#atomicRewriteFenceEpoch: number | null = null;
	/** Set by synchronous appends that land while an atomic replacement is active. */
	#atomicRewriteDirty = false;
	/**
	 * Active {@link moveTo} relocation. Concurrent completed appends write a
	 * full body to the live path: source while it still exists, destination
	 * once rename has landed (source gone). Never recreates a vacated source.
	 * `null` outside an active relocation.
	 */
	#sessionFileRelocating: { source: string; dest: string } | null = null;
	/** Atomic entry batch currently staged for a full-file commit. */
	#atomicEntryBatch: AtomicEntryBatch | undefined;

	#artifactManager: ArtifactManager | null = null;
	#artifactManagerSessionFile: string | null = null;
	#adoptedArtifactManager: ArtifactManager | null = null;
	#inMemoryArtifacts: Map<string, string> | null = null;
	#inMemoryArtifactCounter = 0;

	#suppressBreadcrumb = false;
	/**
	 * The last breadcrumb this manager wrote marked a lazy `/new` boundary whose
	 * JSONL is not yet on disk. Cleared (and the crumb re-stamped non-fresh) once
	 * the session materializes, so a materialized-then-deleted session still falls
	 * back to the most-recent session instead of being treated as a fresh crumb.
	 */
	#breadcrumbFresh = false;
	#sessionNameChangedCallbacks = new Set<() => void>();
	readonly transientPersistence: SessionTransientPersistenceCoordinatorV1;

	private constructor(cwd: string, sessionDir: string, persist: boolean, storage: SessionStorage) {
		this.#cwd = cwd;
		this.#sessionDir = sessionDir;
		this.#persist = persist;
		this.#storage = storage;
		this.#blobs = new BlobStore(getBlobsDir());
		const manager = this;
		this.transientPersistence = new SessionTransientPersistenceCoordinatorV1({
			get persist() {
				return manager.#persist;
			},
			get storage() {
				return manager.#storage;
			},
			get blobs() {
				return manager.#blobs;
			},
			get sessionId() {
				return manager.#sessionId;
			},
			get sessionFile() {
				return manager.#sessionFile;
			},
			get header() {
				return manager.#header;
			},
			get entries() {
				return manager.#entries;
			},
			get index() {
				return manager.#index;
			},
			get writer() {
				return manager.#writer;
			},
			get atomicEntryBatch() {
				return manager.#atomicEntryBatch;
			},
			get atomicRewriteFenceEpoch() {
				return manager.#atomicRewriteFenceEpoch;
			},
			get fileIsCurrent() {
				return manager.#fileIsCurrent;
			},
			set fileIsCurrent(value) {
				manager.#fileIsCurrent = value;
			},
			get rewriteRequired() {
				return manager.#rewriteRequired;
			},
			set rewriteRequired(value) {
				manager.#rewriteRequired = value;
			},
			get sessionFileRelocating() {
				return manager.#sessionFileRelocating;
			},
			get diskFailure() {
				return manager.#diskFailure;
			},
			withAtomicPersistenceLock: operation => manager.#withAtomicPersistenceLock(operation),
			appendEntriesAtomicallyLocked: append => manager.#appendEntriesAtomicallyLocked(append),
			appendToSessionFile: entry => manager.#appendToSessionFile(entry),
			appendWriter: () => manager.#appendWriter(),
			noteDiskFailure: errorLike => manager.#noteDiskFailure(errorLike),
			notifyEntryAppended: entry => manager.#notifyEntryAppended(entry),
			projectCurrentSession: () => manager.#projectCurrentSession(),
			recordEntry: entry => manager.#recordEntry(entry),
			authoritativelyRewriteCurrentStateLocked: operationError =>
				manager.#authoritativelyRewriteCurrentStateLocked(operationError),
			submitJournalAppend: (entry, primary) => manager.#submitJournalAppend(entry, primary),
			resolveTransientTaskJournalGenerationAuthority: branchAnchorEntryId =>
				manager.resolveTransientTaskJournalGenerationAuthority(branchAnchorEntryId),
		});

		if (persist && sessionDir) this.#storage.ensureDirSync(sessionDir);
	}

	#rememberBreadcrumb(cwd: string, sessionFile: string, fresh = false): void {
		this.#breadcrumbFresh = fresh;
		if (!this.#suppressBreadcrumb) writeTerminalBreadcrumb(cwd, sessionFile, fresh);
	}

	/**
	 * Re-stamp a fresh `/new` breadcrumb as non-fresh once the session has
	 * materialized on disk. A no-op unless the current breadcrumb is still fresh.
	 */
	#materializeBreadcrumb(): void {
		if (!this.#breadcrumbFresh || !this.#sessionFile) return;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, false);
	}

	#clearDiskError(): void {
		this.#diskFailure = undefined;
		this.#diskFailureLogged = false;
	}

	#noteDiskFailure(errorLike: unknown): Error {
		const error = toError(errorLike);
		if (!this.#diskFailure) this.#diskFailure = error;

		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence error.", {
				sessionFile: this.#sessionFile,
				error: error.message,
				stack: error.stack,
			});
		}

		return this.#diskFailure;
	}

	#scheduleDiskWork(work: () => Promise<void>, options: DiskQueueOptions = {}): Promise<void> {
		const epoch = options.epoch ?? this.#diskEpoch;
		const scheduled = this.#diskTail
			.catch(() => undefined)
			.then(async () => {
				if (!options.ignoreEpoch && epoch !== this.#diskEpoch) return;
				if (this.#diskFailure && !options.ignorePriorError) throw this.#diskFailure;
				await work();
			});

		const reported = scheduled.catch(err => {
			throw this.#noteDiskFailure(err);
		});
		this.#diskTail = reported.catch(() => undefined);
		return reported;
	}

	async #withAtomicPersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
		const predecessor = this.#atomicPersistenceTail;
		const turn = Promise.withResolvers<void>();
		this.#atomicPersistenceTail = predecessor.catch(() => undefined).then(() => turn.promise);
		await predecessor.catch(() => undefined);
		try {
			return await operation();
		} finally {
			turn.resolve();
		}
	}

	async #drainAndCloseWriter(): Promise<void> {
		try {
			await this.#scheduleDiskWork(
				async () => {
					await this.#closeWriterHandle();
				},
				{ ignorePriorError: true, ignoreEpoch: true },
			);
		} finally {
			this.#writer = undefined;
			this.#diskTail = Promise.resolve();
		}
	}

	#closeWriterEventually(): void {
		const writer = this.#writer;
		this.#writer = undefined;
		if (writer) void writer.close().catch(() => undefined);
	}

	async #closeWriterHandle(): Promise<void> {
		const writer = this.#writer;
		if (!writer) return;
		this.#writer = undefined;
		await writer.close();
	}

	#latchIndeterminate(operationError: Error, recoveryErrors: readonly Error[]): SessionPersistenceIndeterminateError {
		const error = new SessionPersistenceIndeterminateError(operationError, recoveryErrors);
		this.#diskFailure = error;
		if (!this.#diskFailureLogged) {
			this.#diskFailureLogged = true;
			logger.error("Session persistence became indeterminate.", {
				sessionFile: this.#sessionFile,
				error: error.message,
			});
		}
		return error;
	}

	#notifyDurableEntries(entries: readonly SessionEntry[] = []): void {
		const notifications = [...this.#pendingDurabilityNotifications, ...entries];
		this.#pendingDurabilityNotifications = [];
		const seen = new Set<string>();
		for (const entry of notifications) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			this.#notifyEntryAppended(entry);
		}
	}

	async #authoritativelyRewriteCurrentStateLocked(operationError: Error): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		const previousDiskTail = this.#diskTail;
		const writer = this.#writer;
		this.#diskEpoch++;
		const epoch = this.#diskEpoch;
		this.#writer = undefined;
		this.#diskTail = Promise.resolve();
		this.#forceFileCreation = true;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = true;
		this.#atomicRewriteFenceEpoch = epoch;
		if (!this.#diskFailure) this.#diskFailure = operationError;
		try {
			await previousDiskTail.catch(() => undefined);
			let closeError: Error | undefined;
			if (writer) {
				try {
					await writer.close();
				} catch (error) {
					closeError = toError(error);
				}
			}
			let drainError: Error | undefined;
			try {
				await this.#storage.drain();
			} catch (error) {
				drainError = toError(error);
			}
			if (writer?.isOpen()) {
				throw this.#latchIndeterminate(operationError, [
					closeError ?? new Error("Failed to close session writer before authoritative repair."),
					...(drainError ? [drainError] : []),
				]);
			}

			do {
				this.#atomicRewriteDirty = false;
				const sessionFile = this.#sessionFile;
				if (!sessionFile) {
					throw this.#latchIndeterminate(operationError, [
						new Error("Session file disappeared during authoritative repair."),
					]);
				}
				const projection = this.#projectCurrentSession();
				const durability = Promise.withResolvers<void>();
				this.#submitJournalReplace(
					"persistence-recovery",
					projection,
					createPrimarySessionDurabilityReceipt(durability.promise),
				);
				try {
					try {
						await this.#storage.writeTextAtomic(sessionFile, projection.canonicalBody, {
							commitGuard: () => this.#diskEpoch === epoch,
						});
					} catch (error) {
						const recoveryErrors = [toError(error)];
						try {
							await this.#storage.drain();
						} catch (drainFailure) {
							recoveryErrors.push(toError(drainFailure));
						}
						let actual: string;
						try {
							actual = await this.#storage.readText(sessionFile);
						} catch (readFailure) {
							recoveryErrors.push(toError(readFailure));
							throw this.#latchIndeterminate(operationError, recoveryErrors);
						}
						if (actual !== projection.canonicalBody) {
							recoveryErrors.push(new Error("Authoritative session repair did not match durable storage."));
							throw this.#latchIndeterminate(operationError, recoveryErrors);
						}
					}
					if (this.#diskEpoch !== epoch) {
						throw this.#latchIndeterminate(operationError, [
							new Error("Authoritative session repair was superseded before verification."),
						]);
					}
					durability.resolve();
				} catch (error) {
					durability.reject(error);
					throw error;
				}
			} while (this.#atomicRewriteDirty);

			this.#fileIsCurrent = true;
			this.#rewriteRequired = false;
			this.#hasTitleSlot = true;
			this.#clearDiskError();
		} catch (error) {
			if (error instanceof SessionPersistenceIndeterminateError) throw error;
			throw this.#latchIndeterminate(operationError, [toError(error)]);
		} finally {
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	#appendWriter(): SessionStorageWriter {
		if (!this.#sessionFile) throw new Error("Cannot open a session writer before a session file exists");

		if (this.#writer?.isOpen()) return this.#writer;

		this.#writer = this.#storage.openWriter(this.#sessionFile, {
			flags: "a",
			onError: err => this.#noteDiskFailure(err),
		});
		return this.#writer;
	}

	#titleSlotLine(): string {
		return serializeTitleSlot({
			title: this.#sessionName,
			source: this.#titleSource,
			updatedAt: this.#titleUpdatedAt || this.#header.timestamp,
		});
	}

	#projectCurrentSession(): CanonicalSessionPersistenceProjection {
		return projectSessionForPersistence(this.#titleSlotLine(), this.#header, this.#entries, this.#blobs);
	}

	#submitJournalReplace(
		reason: SessionJournalReplaceReason,
		projection: CanonicalSessionPersistenceProjection,
		primary: PrimarySessionDurabilityReceipt,
	): void {
		const handle = this.#journalHandle;
		if (!handle) return;
		this.#journalProjection = projection.journal;
		try {
			handle.replace(reason, projection.journal, primary);
		} catch {
			// Journal submission is post-primary and cannot fail session persistence.
		}
	}

	#submitJournalAppend(entry: CanonicalSessionEntryProjectionV1, primary: PrimarySessionDurabilityReceipt): void {
		const handle = this.#journalHandle;
		if (!handle) return;
		const current = this.#journalProjection;
		if (
			handle.needsReconcile ||
			!current ||
			current.sessionId !== this.#sessionId ||
			entry.ordinal !== current.entries.length
		) {
			this.#submitJournalReplace("queue-reconcile", this.#projectCurrentSession(), primary);
			return;
		}
		this.#journalProjection = Object.freeze({
			...current,
			entries: Object.freeze([...current.entries, entry]),
		});
		try {
			handle.append(entry, primary);
		} catch {
			this.#journalProjection = undefined;
			this.#submitJournalReplace("queue-reconcile", this.#projectCurrentSession(), primary);
		}
	}

	#submitJournalDelete(primary: PrimarySessionDurabilityReceipt): void {
		try {
			this.#journalHandle?.delete(primary);
		} catch {
			// Journal submission is post-primary and cannot fail session persistence.
		}
	}

	#historyContainsAssistantMessage(): boolean {
		return this.#entries.some(isAssistantEntry);
	}

	#shouldHaveSessionFile(): boolean {
		return this.#forceFileCreation || this.#fileIsCurrent || this.#historyContainsAssistantMessage();
	}

	/**
	 * Live path for concurrent completed appends during {@link moveTo}.
	 * Prefers destination once rename has landed (source gone); otherwise
	 * source. Never invents a path that does not already exist.
	 */
	#liveRelocationWritePath(): string | null {
		const relocating = this.#sessionFileRelocating;
		if (!relocating) return null;
		if (this.#storage.existsSync(relocating.dest)) return relocating.dest;
		if (this.#storage.existsSync(relocating.source)) return relocating.source;
		// Rename in flight with neither path visible (rare cross-device edge):
		// fall back to destination so we do not recreate a vacated source.
		return relocating.dest;
	}

	/**
	 * Synchronously rewrite the whole file (header + entries) and keep no open
	 * writer; the next append re-opens one. `writeTextSync` returns with the
	 * bytes in the kernel page cache, so the file is software-crash durable.
	 *
	 * During {@link moveTo}, writes to the live relocation path (source pre-
	 * rename, destination post-rename) rather than always `#sessionFile`, so
	 * concurrent completed entries are durable without recreating a vacated source.
	 */
	#rewriteSynchronously(reason: SessionJournalReplaceReason = "rewrite"): void {
		if (!this.#persist || !this.#shouldHaveSessionFile()) return;
		const targetPath = this.#liveRelocationWritePath() ?? this.#sessionFile;
		if (!targetPath) return;
		const projection = this.#projectCurrentSession();

		try {
			this.#diskEpoch++;
			this.#diskTail = Promise.resolve();
			this.#closeWriterEventually();
			this.#storage.writeTextSync(targetPath, projection.canonicalBody);
			this.#submitJournalReplace(reason, projection, createPrimarySessionDurabilityReceipt(this.#storage.drain()));
			// Only mark the manager current when writing the active session path.
			// Mid-move writes update the live relocation path; `#sessionFile` is
			// still the pre-repoint source until moveTo repoints it.
			if (!this.#sessionFileRelocating || targetPath === this.#sessionFile) {
				this.#fileIsCurrent = true;
				this.#materializeBreadcrumb();
				this.#rewriteRequired = false;
				this.#hasTitleSlot = true;
			} else {
				// Destination body is current on disk; in-memory still needs a
				// header-cwd rewrite after repoint, but entries are durable.
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				this.#hasTitleSlot = true;
			}
		} catch (err) {
			const error = this.#noteDiskFailure(err);
			const failed = Promise.withResolvers<void>();
			this.#submitJournalReplace(reason, projection, createPrimarySessionDurabilityReceipt(failed.promise));
			failed.reject(error);
		}
	}

	/**
	 * Rewrite the whole file atomically (temp-write + rename, EPERM-safe) on the
	 * disk chain. The body is serialized after the writer is closed. The fence
	 * is enabled BEFORE `#closeWriterHandle()` and stays active until the last
	 * atomic publish returns, so a sync append landing in the close-yield window
	 * cannot open a fresh writer that the pending replacement would then detach
	 * from the current JSONL path. A `commitGuard` also prevents a superseding
	 * synchronous rewrite from being overwritten by the stale body serialized
	 * before it ran.
	 */
	async #rewriteAtomically(reason: SessionJournalReplaceReason = "rewrite"): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;

		const startEpoch = this.#diskEpoch;
		await this.#scheduleDiskWork(
			async () => {
				if (await this.#runFencedAtomicRewrite(startEpoch, reason)) {
					this.#fileIsCurrent = true;
					this.#materializeBreadcrumb();
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch: startEpoch },
		);
	}

	/**
	 * Shared fenced atomic-rewrite loop used by `#rewriteAtomically` and the
	 * `#persistTitleChangeEntry` fallback. Holds `#atomicRewriteActive` across
	 * the writer close and the full-file replace, and loops on
	 * `#atomicRewriteDirty` so any fenced append that lands during the rewrite
	 * is captured before the task resolves. Returns `false` when the disk epoch
	 * moved (a superseding synchronous rewrite has taken over) so callers skip
	 * their post-publish state updates.
	 */
	async #runFencedAtomicRewrite(epoch: number, reason: SessionJournalReplaceReason): Promise<boolean> {
		this.#atomicRewriteFenceEpoch = epoch;
		try {
			do {
				this.#atomicRewriteDirty = false;
				await this.#closeWriterHandle();
				const sessionFile = this.#sessionFile;
				if (!sessionFile || this.#diskEpoch !== epoch) return false;
				const projection = this.#projectCurrentSession();
				const durability = Promise.withResolvers<void>();
				this.#submitJournalReplace(reason, projection, createPrimarySessionDurabilityReceipt(durability.promise));
				try {
					await this.#storage.writeTextAtomic(sessionFile, projection.canonicalBody, {
						commitGuard: () => this.#diskEpoch === epoch,
					});
					if (this.#diskEpoch !== epoch) {
						const superseded = new Error("Session rewrite was superseded before primary commit.");
						durability.reject(superseded);
						return false;
					}
					durability.resolve();
				} catch (error) {
					durability.reject(error);
					throw error;
				}
			} while (this.#atomicRewriteDirty);
			return true;
		} finally {
			// Only relinquish the fence if we still own it. A superseding
			// synchronous rewrite (`flushSync` → `#rewriteSynchronously`) may
			// have reset `#diskTail`, scheduled a fresh atomic task at the new
			// epoch, and that task may have taken ownership of the fence while
			// this stale rewrite was still awaiting storage. Clearing it here
			// unconditionally would strand appends during the newer publish.
			if (this.#atomicRewriteFenceEpoch === epoch) this.#atomicRewriteFenceEpoch = null;
		}
	}

	#appendToSessionFile(entry: SessionEntry): void {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#atomicEntryBatch) {
			this.#fileIsCurrent = false;
			this.#rewriteRequired = true;
			this.#atomicRewriteDirty = true;
			return;
		}
		if (this.#diskFailure) throw this.#diskFailure;

		// Lazy gate: a brand-new session is not written until it has an assistant
		// message (or someone forced creation), so sessions that never produce
		// output never create a file.
		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}

		// Atomic replacement / move window: do not open a fresh append writer that
		// a Windows EPERM replace could detach from the current JSONL path.
		// - moveTo: write a full body to the live relocation path (source pre-
		//   rename, destination post-rename) so completed entries are durable
		//   without recreating a vacated source.
		// - in-place atomic fence: supersede the pending publish with a
		//   synchronous full-body rewrite; bumping `#diskEpoch` abandons the
		//   in-flight atomic via its `commitGuard`.
		if (this.#sessionFileRelocating) {
			this.#rewriteSynchronously("move");
			return;
		}
		if (this.#atomicRewriteFenceEpoch !== null && this.#atomicRewriteFenceEpoch === this.#diskEpoch) {
			this.#atomicRewriteDirty = true;
			this.#rewriteSynchronously("rewrite");
			return;
		}
		// Cold/divergent: not on disk yet, or in-memory entries diverged from the
		// file → rewrite the whole file synchronously and keep going.
		if (!this.#fileIsCurrent || this.#rewriteRequired) {
			this.#rewriteSynchronously(this.#fileIsCurrent ? "rewrite" : "create");
			return;
		}

		// Hot path: write the entry directly on the writer, outside the async disk
		// chain. Prefer appendSync so write failures latch `#diskFailure` before
		// this call returns (not via a discarded rejected Promise after a later
		// microtask). Callers stay non-throwing here — the core turn loop invokes
		// appendMessage/appendCustomEntry without try/catch; flushSync/close and
		// subsequent appends still throw the latched error. File writers apply
		// each line to the OS page cache before return.
		// A mid-close writer leaves `#writer` undefined, so `#appendWriter` simply
		// opens a fresh append handle and the entry still lands.
		const projectedEntry = projectSessionEntryForPersistence(entry, this.#entries.length - 1, this.#blobs);
		try {
			const writer = this.#appendWriter();
			if (writer.appendSync) {
				writer.appendSync(projectedEntry.canonicalLine);
				this.#submitJournalAppend(projectedEntry, createPrimarySessionDurabilityReceipt(writer.flush()));
			} else {
				const committed = writer.append(projectedEntry.canonicalLine);
				this.#submitJournalAppend(projectedEntry, createPrimarySessionDurabilityReceipt(committed));
				void committed.catch(err => this.#noteDiskFailure(err));
			}
		} catch (err) {
			const error = this.#noteDiskFailure(err);
			const failed = Promise.withResolvers<void>();
			this.#submitJournalAppend(projectedEntry, createPrimarySessionDurabilityReceipt(failed.promise));
			failed.reject(error);
		}
	}

	async #persistTitleChangeEntry(entry: TitleChangeEntry, update: SessionTitleUpdate): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#diskFailure) throw this.#diskFailure;
		if (!this.#shouldHaveSessionFile()) {
			this.#fileIsCurrent = false;
			return;
		}
		if (this.#sessionFileRelocating) {
			this.#rewriteSynchronously("title-change");
			return;
		}
		if (
			!this.#fileIsCurrent ||
			this.#rewriteRequired ||
			!this.#hasTitleSlot ||
			!this.#storage.existsSync(this.#sessionFile)
		) {
			await this.#rewriteAtomically("title-change");
			return;
		}
		const epoch = this.#diskEpoch;
		const projectedEntry = projectSessionEntryForPersistence(entry, this.#entries.length - 1, this.#blobs);
		await this.#scheduleDiskWork(
			async () => {
				const sessionFile = this.#sessionFile;
				if (!sessionFile) return;
				try {
					const committed = this.#appendWriter()
						.append(projectedEntry.canonicalLine)
						.then(() => this.#storage.updateSessionTitle(sessionFile, update));
					this.#submitJournalReplace(
						"title-change",
						this.#projectCurrentSession(),
						createPrimarySessionDurabilityReceipt(committed),
					);
					await committed;
					if (epoch === this.#diskEpoch) this.#fileIsCurrent = true;
				} catch {
					if (!(await this.#runFencedAtomicRewrite(epoch, "title-change"))) return;
					this.#clearDiskError();
					this.#fileIsCurrent = true;
					this.#rewriteRequired = false;
					this.#hasTitleSlot = true;
				}
			},
			{ epoch },
		);
	}

	#notifyEntryAppended(entry: SessionEntry): void {
		const callback = this.onEntryAppended;
		if (callback) {
			try {
				callback(entry);
			} catch (err) {
				logger.warn("collab entry hook failed", { error: String(err) });
			}
		}
	}

	#openJournalStreamForCurrentSession(): boolean {
		const service = this.#journalService;
		const descriptor = this.#journalDescriptor;
		if (!service || !descriptor) return false;
		const currentDescriptor = journalDescriptorForSession(descriptor, this.#sessionId);
		try {
			this.#journalHandle = service.openStream(currentDescriptor);
			this.#journalDescriptor = currentDescriptor;
			this.#journalProjection = undefined;
			return true;
		} catch {
			this.#journalHandle = undefined;
			this.#journalProjection = undefined;
			return false;
		}
	}

	async #releaseJournalHandle(reconcile = true, primaryCommitted?: PromiseLike<void>): Promise<void> {
		const handle = this.#journalHandle;
		const projection = this.#journalProjection;
		this.#journalHandle = undefined;
		this.#journalProjection = undefined;
		if (!handle) return;
		let primarySucceeded = true;
		try {
			await (primaryCommitted ?? this.#storage.drain());
		} catch {
			primarySucceeded = false;
		}
		if (reconcile && primarySucceeded && handle.needsReconcile && projection) {
			try {
				handle.replace("queue-reconcile", projection, createPrimarySessionDurabilityReceipt(Promise.resolve()));
			} catch {
				// A closing or failed optional journal still releases its stream handle.
			}
		}
		try {
			await handle.close();
		} catch {
			// Journal failure is post-primary and never makes session persistence fail.
		}
	}

	#submitOpenJournalReconcile(reason: SessionJournalReplaceReason = "open-reconcile"): void {
		if (!this.#journalHandle || !this.#fileIsCurrent || this.#rewriteRequired || !this.#sessionFile) return;
		const projection = this.#projectCurrentSession();
		this.#submitJournalReplace(reason, projection, createPrimarySessionDurabilityReceipt(this.#storage.drain()));
	}

	#resetToNewSession(
		options?: NewSessionOptions,
		forcedSessionFile?: string,
		identity?: { sessionId: string; timestamp: ISO8601 },
	): string | undefined {
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();
		this.#sessionId = identity?.sessionId ?? mintSessionId();
		this.#sessionName = undefined;
		this.#titleSource = undefined;
		this.#titleUpdatedAt = "";
		this.#hasTitleSlot = true;

		const timestamp = identity?.timestamp ?? nowIso();
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			timestamp,
			cwd: this.#cwd,
			parentSession: options?.parentSession,
			providerPromptCacheKey: options?.providerPromptCacheKey,
		};
		const workspace = normalizeSessionWorkspace({
			cwd: this.#cwd,
			directories: options?.additionalDirectories ?? [],
		});
		this.#additionalDirectories = additionalWorkspaceDirectories(workspace);
		if (this.#additionalDirectories.length > 0) {
			this.#header.additionalDirectories = [...this.#additionalDirectories];
		}
		this.#titleUpdatedAt = timestamp;

		this.#entries = [];
		this.#index.clear();
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#forceFileCreation = false;
		this.#draftOnlySessionCleanupArmed = false;
		this.#turnBudgetTotal = null;
		this.#turnBudgetHard = false;
		this.#turnOutputBaseline = 0;
		this.#turnEvalOutput = 0;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;
		this.#inMemoryArtifacts = null;
		this.#inMemoryArtifactCounter = 0;

		if (this.#persist) {
			this.#sessionFile =
				forcedSessionFile ??
				path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
			this.#rememberBreadcrumb(this.#cwd, this.#sessionFile, true);
		} else {
			this.#sessionFile = undefined;
		}
		this.#journalProjection = undefined;
		if (this.#persist && this.#journalService && this.#journalDescriptor) this.#openJournalStreamForCurrentSession();

		return this.#sessionFile;
	}

	#applyEntries(header: SessionHeader, entries: SessionEntry[]): void {
		this.#header = header;
		this.#entries = entries;
		this.#sessionId = header.id;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = header.timestamp;
		this.#index.rebuild(entries);
	}

	#freshEntryFields(id = generateId(this.#index)): { id: string; parentId: string | null; timestamp: string } {
		return {
			id,
			parentId: this.#index.leafId(),
			timestamp: nowIso(),
		};
	}

	#setLeaf(id: string | null): void {
		this.#index.setLeaf(id);
		const batch = this.#atomicEntryBatch;
		if (batch && !batch.collecting) {
			batch.externalLeafChanged = true;
			batch.externalLeafId = id;
		}
	}

	#recordEntry(entry: SessionEntry): void {
		this.#entries.push(entry);
		this.#index.insert(entry);
		const batch = this.#atomicEntryBatch;
		if (batch?.collecting) batch.entryIds.add(entry.id);
		if (batch && !batch.collecting) {
			batch.externalLeafChanged = true;
			batch.externalLeafId = entry.id;
		}
		this.#appendToSessionFile(entry);
		if (batch) batch.deferredNotifications.push(entry);
		else this.#notifyEntryAppended(entry);
	}

	#rollbackAtomicEntryBatch(batch: AtomicEntryBatch): void {
		const retainedAncestor = (id: string | null): string | null => {
			const seen = new Set<string>();
			while (id && batch.entryIds.has(id) && !seen.has(id)) {
				seen.add(id);
				id = this.#index.get(id)?.parentId ?? null;
			}
			return id;
		};
		const retained = this.#entries.filter(entry => !batch.entryIds.has(entry.id));
		for (const entry of retained) entry.parentId = retainedAncestor(entry.parentId);
		const restoredLeaf = retainedAncestor(batch.externalLeafChanged ? batch.externalLeafId : batch.preBatchLeafId);
		this.#entries = retained;
		this.#index.rebuild(retained);
		this.#index.setLeaf(restoredLeaf && this.#index.has(restoredLeaf) ? restoredLeaf : null);
	}

	#draftPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, "draft.txt") : null;
	}

	#draftOnlySessionMarkerPath(): string | null {
		const artifactsDir = this.getArtifactsDir();
		return artifactsDir ? path.join(artifactsDir, DRAFT_ONLY_SESSION_MARKER) : null;
	}

	#hasDraftOnlySessionMarker(): boolean {
		const markerPath = this.#draftOnlySessionMarkerPath();
		return markerPath !== null && this.#storage.existsSync(markerPath);
	}

	async #writeDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		await this.#storage.writeText(markerPath, "");
	}

	async #clearDraftOnlySessionMarker(): Promise<void> {
		const markerPath = this.#draftOnlySessionMarkerPath();
		if (!markerPath) return;
		try {
			await this.#storage.unlink(markerPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}

	#artifactManagerForSession(): ArtifactManager | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager;

		const sessionFile = this.#sessionFile;
		if (!sessionFile) {
			this.#artifactManager = null;
			this.#artifactManagerSessionFile = null;
			return null;
		}

		if (this.#artifactManager && this.#artifactManagerSessionFile === sessionFile) return this.#artifactManager;

		this.#artifactManager = new ArtifactManager(sessionFile.slice(0, -JSONL_SUFFIX_LENGTH));
		this.#artifactManagerSessionFile = sessionFile;
		return this.#artifactManager;
	}

	#notifySessionNameListeners(): void {
		for (const callback of [...this.#sessionNameChangedCallbacks]) {
			try {
				callback();
			} catch (err) {
				logger.warn("SessionManager: session name change hook failed", { error: String(err) });
			}
		}
	}

	static #cleanTitle(raw: string): string {
		return raw
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/ +/g, " ")
			.trim();
	}

	/** Puts a binary blob into the blob store and returns the blob reference. */
	async putBlob(data: Buffer, options?: BlobPutOptions): Promise<BlobPutResult> {
		return this.#blobs.put(data, options);
	}

	/** Synchronous variant of {@link putBlob} for rebuild-only render paths. */
	putBlobSync(data: Buffer, options?: BlobPutOptions): BlobPutResult {
		return this.#blobs.putSync(data, options);
	}

	/** Bind this manager to one explicitly owned process journal stream. */
	async attachSessionJournal(
		service: SessionJournalService,
		descriptor: SessionJournalStreamDescriptorV1,
	): Promise<void> {
		if (!this.#persist) throw new Error("session_journal_requires_primary_persistence");
		if (descriptor.sessionId !== this.#sessionId || descriptor.streamId !== `session:${this.#sessionId}`)
			throw new Error("session_journal_session_mismatch");
		await this.#releaseJournalHandle(!this.#diskFailure);
		this.#journalService = service;
		this.#journalDescriptor = descriptor;
		if (!this.#openJournalStreamForCurrentSession()) {
			this.#journalService = undefined;
			this.#journalDescriptor = undefined;
			throw new Error("session_journal_open_failed");
		}
		const openReason = descriptor.kind === "advisor" ? "advisor-open" : "open-reconcile";
		const advisorNeedsCreate = descriptor.kind === "advisor" && !this.#fileIsCurrent;
		if (advisorNeedsCreate) this.#forceFileCreation = true;
		if (this.#sessionFile && (this.#rewriteRequired || advisorNeedsCreate)) await this.#rewriteAtomically(openReason);
		else this.#submitOpenJournalReconcile(openReason);
	}

	/** Flush and detach the current journal stream before mutating session generation. */
	async prepareSessionGenerationChange(): Promise<void> {
		await this.flush();
		await this.#releaseJournalHandle();
	}

	/** Reopen the retained journal authority after a failed generation mutation. */
	resumeSessionGenerationAfterFailedChange(): void {
		if (this.#journalHandle || !this.#journalService || !this.#journalDescriptor) return;
		if (!this.#openJournalStreamForCurrentSession()) throw new Error("session_journal_reopen_failed");
		this.#submitOpenJournalReconcile();
	}

	captureState(): SessionManagerStateSnapshot {
		return {
			cwd: this.#cwd,
			sessionDir: this.#sessionDir,
			sessionId: this.#sessionId,
			sessionName: this.#sessionName,
			titleSource: this.#titleSource,
			titleUpdatedAt: this.#titleUpdatedAt,
			hasTitleSlot: this.#hasTitleSlot,
			sessionFile: this.#sessionFile,
			onDisk: this.#fileIsCurrent,
			needsRewrite: this.#rewriteRequired,
			draftOnlySessionCleanupArmed: this.#draftOnlySessionCleanupArmed,
			// Snapshot header + entries by reference: switch/reload replaces the
			// active header/array wholesale, so rollback needs no deep clone.
			header: this.#header,
			entries: [...this.#entries],
		};
	}

	/**
	 * Create an independent manager for the current logical session and branch.
	 * The clone shares the storage backend but owns its entry index and writer, so
	 * callers can finish session-owned work after this manager switches elsewhere.
	 * Set `persist` false when the original session is intentionally being dropped.
	 */
	cloneCurrentSession(options?: { persist?: boolean }): SessionManager {
		const persist = options?.persist ?? this.#persist;
		const clone = new SessionManager(this.#cwd, this.#sessionDir, persist, this.#storage);
		clone.#suppressBreadcrumb = true;
		clone.restoreState(this.captureState());
		if (persist && this.#journalService && this.#journalDescriptor) {
			clone.#journalService = this.#journalService;
			clone.#journalDescriptor = this.#journalDescriptor;
			if (clone.#openJournalStreamForCurrentSession()) clone.#journalProjection = this.#journalProjection;
		}
		if (!persist) {
			clone.#sessionFile = undefined;
			clone.#fileIsCurrent = false;
			clone.#rewriteRequired = false;
			clone.#forceFileCreation = false;
		}
		return clone;
	}

	restoreState(snapshot: SessionManagerStateSnapshot): void {
		const rebindJournal = this.#journalService !== undefined && this.#journalDescriptor !== undefined;
		const writer = this.#writer;
		this.#writer = undefined;
		if (this.#journalHandle) {
			const primaryCommitted = writer ? writer.close().then(() => this.#storage.drain()) : this.#storage.drain();
			void this.#releaseJournalHandle(!this.#diskFailure, primaryCommitted);
		} else if (writer) {
			void writer.close().catch(() => undefined);
		}
		this.#diskTail = Promise.resolve();
		this.#clearDiskError();

		this.#cwd = snapshot.cwd;
		this.#sessionDir = snapshot.sessionDir;
		this.#sessionFile = snapshot.sessionFile;
		this.#fileIsCurrent = snapshot.onDisk;
		this.#rewriteRequired = snapshot.needsRewrite;
		this.#forceFileCreation = snapshot.onDisk;
		this.#draftOnlySessionCleanupArmed = snapshot.draftOnlySessionCleanupArmed;
		this.#applyEntries(snapshot.header, [...snapshot.entries]);
		this.#additionalDirectories = snapshot.header.additionalDirectories ?? [];
		this.#sessionName = snapshot.sessionName;
		this.#titleSource = snapshot.titleSource;
		this.#titleUpdatedAt = snapshot.titleUpdatedAt;
		this.#hasTitleSlot = snapshot.hasTitleSlot;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#adoptedArtifactManager = null;

		if (this.#sessionFile) this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);
		if (rebindJournal && this.#openJournalStreamForCurrentSession()) this.#submitOpenJournalReconcile();
	}

	/** Switch to a different session file (resume / branch). */
	async setSessionFile(sessionFile: string): Promise<void> {
		await this.#drainAndCloseWriter();
		await this.#releaseJournalHandle(!this.#diskFailure);
		this.#clearDiskError();
		this.#draftOnlySessionCleanupArmed = false;

		const resolvedSessionFile = path.resolve(sessionFile);
		this.#sessionFile = resolvedSessionFile;
		this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);

		const titleSlot = await readTitleSlotFromFile(resolvedSessionFile, this.#storage);
		const fileEntries = await loadEntriesFromFile(resolvedSessionFile, this.#storage);
		if (fileEntries.length === 0) {
			// Explicit but empty/missing path (e.g. --session flag): start fresh but
			// keep the requested path and materialize the header immediately.
			this.#resetToNewSession(undefined, resolvedSessionFile);
			this.#forceFileCreation = true;
			await this.#rewriteAtomically("create");
			this.#fileIsCurrent = true;
			return;
		}

		const migrated = migrateToCurrentVersion(fileEntries);
		await resolveBlobRefsInEntries(fileEntries, this.#blobs);
		// loadEntriesFromFile guarantees entries[0] is a valid session header.
		const header = fileEntries[0] as SessionHeader;

		// Adopt the loaded session's working directory. Sessions live in a dir
		// keyed by their cwd, so resuming a session from another project must
		// re-point cwd/sessionDir at that project — unless that project directory
		// no longer exists on disk, in which case adopting it (and the process
		// chdir interactive mode then performs) would fail with ENOENT. Keep the
		// current cwd so the resumed session stays where the user already is.
		const headerCwd = header.cwd ? path.resolve(header.cwd) : undefined;
		if (headerCwd && headerCwd !== path.resolve(this.#cwd) && (await directoryExists(headerCwd))) {
			this.#cwd = headerCwd;
			this.#sessionDir = path.dirname(resolvedSessionFile);
			this.#rememberBreadcrumb(this.#cwd, resolvedSessionFile);
		}

		this.#applyEntries(header, fileEntries.slice(1) as SessionEntry[]);
		this.#additionalDirectories = header.additionalDirectories ?? [];
		this.#titleUpdatedAt = titleSlot?.updatedAt ?? header.timestamp;
		this.#hasTitleSlot = titleSlot !== undefined;
		this.#fileIsCurrent = true;
		this.#rewriteRequired = migrated || titleSlot === undefined;
		this.#forceFileCreation = true;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;

		if (this.sanitizeLoadedOpenAIResponsesReplayMetadata()) this.#rewriteRequired = true;
		if (this.#journalService && this.#journalDescriptor && this.#openJournalStreamForCurrentSession()) {
			if (this.#rewriteRequired) await this.#rewriteAtomically("open-reconcile");
			else this.#submitOpenJournalReconcile();
		}
	}

	/** Start a new session. Drains and closes any existing writer first. */
	async newSession(options?: NewSessionOptions): Promise<string | undefined> {
		await this.#drainAndCloseWriter();
		await this.#releaseJournalHandle(!this.#diskFailure);
		return this.#resetToNewSession(options);
	}
	/** Delete a session file and its artifact directory. ENOENT is treated as success. */
	async dropSession(sessionPath: string): Promise<void> {
		await this.#drainAndCloseWriter();
		const droppingCurrent =
			this.#sessionFile !== undefined && path.resolve(sessionPath) === path.resolve(this.#sessionFile);
		const committed = this.#storage.deleteSessionWithArtifacts(sessionPath).catch(err => {
			if (!isEnoent(err)) throw err;
		});
		if (droppingCurrent) this.#submitJournalDelete(createPrimarySessionDurabilityReceipt(committed));
		await committed;
		if (droppingCurrent) {
			this.#journalProjection = undefined;
			this.#fileIsCurrent = false;
			this.#forceFileCreation = false;
			this.#hasTitleSlot = false;
			await this.#releaseJournalHandle(false);
		}
	}
	/**
	 * Fork the current session into a new file with the same entries.
	 * @returns the old and new session file paths, or undefined when not persisting.
	 */
	async fork(): Promise<{ oldSessionFile: string; newSessionFile: string } | undefined> {
		if (!this.#persist || !this.#sessionFile) return undefined;

		const oldSessionFile = this.#sessionFile;
		const parentSessionId = this.#sessionId;
		await this.#drainAndCloseWriter();
		await this.#releaseJournalHandle(!this.#diskFailure);
		this.#clearDiskError();
		const timestamp = nowIso();
		this.#sessionId = mintSessionId();
		this.#sessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${this.#sessionId}.jsonl`);
		this.#header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.#sessionId,
			title: this.#header.title ?? this.#sessionName,
			titleSource: this.#header.titleSource ?? this.#titleSource,
			timestamp,
			cwd: this.#cwd,
			additionalDirectories: this.#additionalDirectories.length > 0 ? [...this.#additionalDirectories] : undefined,
			parentSession: parentSessionId,
			providerPromptCacheKey: this.#header.providerPromptCacheKey ?? parentSessionId,
		};
		this.#sessionName = this.#header.title;
		this.#titleSource = this.#header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
		this.#fileIsCurrent = false;
		this.#rewriteRequired = false;
		this.#forceFileCreation = true;
		this.#draftOnlySessionCleanupArmed = false;
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#rememberBreadcrumb(this.#cwd, this.#sessionFile);

		if (this.#journalService && this.#journalDescriptor) this.#openJournalStreamForCurrentSession();
		await this.#rewriteAtomically("fork");
		return { oldSessionFile, newSessionFile: this.#sessionFile };
	}

	/**
	 * Move the session to a new working directory: relocate the session file and
	 * artifacts on disk, update internal references, and rewrite the header cwd.
	 */
	async moveTo(newCwd: string, targetSessionDir?: string): Promise<void> {
		const resolvedCwd = path.resolve(newCwd);
		const resolvedTargetDir = targetSessionDir ? path.resolve(targetSessionDir) : undefined;
		if (
			resolvedCwd === path.resolve(this.#cwd) &&
			(!resolvedTargetDir || resolvedTargetDir === path.resolve(this.#sessionDir))
		) {
			return;
		}

		const managedRoot = resolveManagedSessionRoot(this.#sessionDir, this.#cwd);
		const nextSessionDir =
			resolvedTargetDir ??
			(managedRoot
				? computeDefaultSessionDir(resolvedCwd, this.#storage, managedRoot)
				: computeDefaultSessionDir(resolvedCwd, this.#storage));

		let sessionFileExisted = false;
		// Track source+dest for concurrent completed appends during relocation
		// (see `#sessionFileRelocating`). Existence of either path decides the
		// live write target — not a `#diskEpoch` bump, which would cancel any
		// disk task already queued at the current epoch (e.g. a header-only
		// `ensureOnDisk()` materializing rewrite) before the drain below runs it.
		if (this.#persist && this.#sessionFile) {
			const source = this.#sessionFile;
			const dest = path.join(nextSessionDir, path.basename(source));
			this.#sessionFileRelocating = { source, dest };
		}

		try {
			if (this.#persist && this.#sessionFile) {
				this.#storage.ensureDirSync(nextSessionDir);
				await this.#drainAndCloseWriter();
				this.#clearDiskError();

				const oldSessionFile = this.#sessionFile;
				const newSessionFile = path.join(nextSessionDir, path.basename(oldSessionFile));
				const oldArtifactsDir = artifactsDirectoryFor(oldSessionFile)!;
				const newArtifactsDir = artifactsDirectoryFor(newSessionFile)!;
				const sessionPathChanged = path.resolve(oldSessionFile) !== path.resolve(newSessionFile);
				const artifactPathChanged = path.resolve(oldArtifactsDir) !== path.resolve(newArtifactsDir);
				sessionFileExisted = this.#storage.existsSync(oldSessionFile);

				let sessionMoved = false;
				let artifactsMoved = false;

				try {
					if (sessionFileExisted && sessionPathChanged) {
						await this.#storage.rename(oldSessionFile, newSessionFile);
						sessionMoved = true;
					}

					if (artifactPathChanged) {
						try {
							const artifactStat = await fs.promises.stat(oldArtifactsDir);
							if (artifactStat.isDirectory()) {
								await fs.promises.rename(oldArtifactsDir, newArtifactsDir);
								artifactsMoved = true;
							}
						} catch (err) {
							if (!isEnoent(err)) throw err;
						}
					}
				} catch (err) {
					if (artifactsMoved) {
						try {
							await fs.promises.rename(newArtifactsDir, oldArtifactsDir);
						} catch (rollbackErr) {
							throw new Error(
								`Failed to move artifacts and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
							);
						}
					}

					if (sessionMoved) {
						try {
							await this.#storage.rename(newSessionFile, oldSessionFile);
						} catch (rollbackErr) {
							throw new Error(
								`Failed to move session file and rollback: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
							);
						}
					}

					throw err;
				}

				if (sessionFileExisted && sessionPathChanged) {
					this.#header.previousSessionFiles = [
						...new Set([...(this.#header.previousSessionFiles ?? []), path.resolve(oldSessionFile)]),
					];
				}

				this.#sessionFile = newSessionFile;
				this.#artifactManager = null;
				this.#artifactManagerSessionFile = null;
				// Path is repointed; hot-path appends may use `#sessionFile` again.
				this.#sessionFileRelocating = null;
			}

			this.#cwd = resolvedCwd;
			this.#sessionDir = nextSessionDir;
			this.#header.cwd = resolvedCwd;
			// Re-filter additional roots: the new cwd may have been an additional root,
			// or it may now contain/subsume one. Re-normalize to keep the invariant
			// that cwd is never also listed as an additional directory.
			if (this.#additionalDirectories.length > 0) {
				this.#additionalDirectories = this.#additionalDirectories.filter(d => d !== resolvedCwd);
				this.#header.additionalDirectories =
					this.#additionalDirectories.length > 0 ? this.#additionalDirectories : undefined;
			}

			// Rewrite at the new location when the file already existed (update cwd) or
			// there is in-memory output worth materializing; otherwise stay lazy.
			const hasAssistant = this.#historyContainsAssistantMessage();
			if (this.#persist && this.#sessionFile && (sessionFileExisted || hasAssistant)) {
				this.#forceFileCreation = true;
				await this.#rewriteAtomically("move");
			}

			if (this.#sessionFile) this.#rememberBreadcrumb(resolvedCwd, this.#sessionFile);
		} finally {
			this.#sessionFileRelocating = null;
		}
	}

	/**
	 * Force the session onto disk even with no assistant message yet (ACP
	 * session/new must create a discoverable file immediately).
	 */
	async ensureOnDisk(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		this.#forceFileCreation = true;
		if (this.#fileIsCurrent && !this.#rewriteRequired) return;
		await this.#rewriteAtomically(this.#fileIsCurrent ? "rewrite" : "create");
	}

	/** Persist this session's transcript as a newly identified OMP session. */
	async persistCopy(
		options?: { sessionDir?: string; suppressBreadcrumb?: boolean },
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionManager> {
		const sessionDir = options?.sessionDir ?? SessionManager.getDefaultSessionDir(this.#cwd, undefined, storage);
		const manager = new SessionManager(this.#cwd, sessionDir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		manager.#journalService = this.#journalService;
		manager.#journalDescriptor = this.#journalDescriptor;
		manager.#resetToNewSession();
		manager.#sessionName = this.#sessionName;
		manager.#titleSource = this.#titleSource;
		manager.#titleUpdatedAt = this.#titleUpdatedAt;
		manager.#header.title = this.#sessionName;
		manager.#header.titleSource = this.#titleSource;
		manager.#additionalDirectories = [...this.#additionalDirectories];
		manager.#header.additionalDirectories =
			manager.#additionalDirectories.length > 0 ? [...manager.#additionalDirectories] : undefined;
		manager.#entries = structuredClone(this.#entries);
		manager.#index.rebuild(manager.#entries);
		manager.#forceFileCreation = true;
		await manager.#rewriteAtomically("copy");
		return manager;
	}

	/**
	 * Stage a synchronous group of entry appends and publish the resulting full
	 * journal with one atomic replace. A failed publish removes only the staged
	 * entries, preserves/reparents entries appended concurrently, restores the
	 * prior durable file view, and clears the failed writer latch for retry.
	 *
	 * The callback MUST be synchronous.
	 */
	appendEntriesAtomically<T>(append: () => T): Promise<T> {
		return this.#withAtomicPersistenceLock(() => this.#appendEntriesAtomicallyLocked(append));
	}

	async #appendEntriesAtomicallyLocked<T>(append: () => T): Promise<T> {
		if (!this.#persist || !this.#sessionFile) return append();
		if (this.#atomicEntryBatch) throw new Error("Atomic persistence lock ownership was violated.");
		try {
			await this.ensureOnDisk();
			await this.flush();
		} catch (error) {
			const operationError = toError(error);
			await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			this.#notifyDurableEntries();
			throw error;
		}

		const batch: AtomicEntryBatch = {
			collecting: true,
			entryIds: new Set(),
			deferredNotifications: [],
			preBatchLeafId: this.#index.leafId(),
			externalLeafChanged: false,
			externalLeafId: null,
		};
		this.#atomicEntryBatch = batch;
		let result!: T;
		try {
			try {
				result = append();
			} finally {
				batch.collecting = false;
			}
			await this.#rewriteAtomically("atomic-batch");
			if (!this.#fileIsCurrent || this.#rewriteRequired) {
				throw new Error("Atomic session batch was superseded before commit.");
			}
			this.#atomicEntryBatch = undefined;
			this.#notifyDurableEntries(batch.deferredNotifications);
			return result;
		} catch (error) {
			batch.collecting = false;
			const operationError = toError(error);
			this.#rollbackAtomicEntryBatch(batch);
			try {
				await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			} catch (repairError) {
				const retainedNotifications = batch.deferredNotifications.filter(entry => !batch.entryIds.has(entry.id));
				this.#pendingDurabilityNotifications.push(...retainedNotifications);
				this.#atomicEntryBatch = undefined;
				this.#fileIsCurrent = false;
				this.#rewriteRequired = true;
				if (repairError instanceof SessionPersistenceIndeterminateError) throw repairError;
				throw this.#latchIndeterminate(operationError, [toError(repairError)]);
			}
			const retainedNotifications = batch.deferredNotifications.filter(entry => !batch.entryIds.has(entry.id));
			this.#atomicEntryBatch = undefined;
			this.#notifyDurableEntries(retainedNotifications);
			throw error;
		}
	}

	/**
	 * Replace an uncertain append tail with the authoritative in-memory journal.
	 * Callers must only use this for monotonic recovery where every retained
	 * entry remains intended (for example, an explicit terminal tombstone).
	 */
	recoverPersistenceFromCurrentState(): Promise<void> {
		return this.#withAtomicPersistenceLock(async () => {
			if (!this.#persist || !this.#sessionFile) return;
			if (this.#atomicEntryBatch) throw new Error("Atomic persistence lock ownership was violated.");
			const operationError =
				this.#diskFailure ?? new Error("Authoritative session persistence recovery was requested.");
			await this.#authoritativelyRewriteCurrentStateLocked(operationError);
			this.#notifyDurableEntries();
		});
	}

	/** Flush pending writes. Call before switching sessions or on shutdown. */
	async flush(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		let primaryError: Error | undefined;
		try {
			await this.#scheduleDiskWork(async () => {
				if (this.#writer?.isOpen()) await this.#writer.flush();
			});
			// Drain any fire-and-forget backing writes (e.g. `writeTextSync` queued
			// on IndexedSessionStorage during `flushSync`) so callers relying on
			// flush() see the write durably visible to readers.
			await this.#storage.drain();
			if (this.#diskFailure) throw this.#diskFailure;
		} catch (error) {
			primaryError = toError(error);
		}

		const handle = this.#journalHandle;
		try {
			if (!primaryError && handle?.needsReconcile && this.#journalProjection) {
				handle.replace(
					"queue-reconcile",
					this.#journalProjection,
					createPrimarySessionDurabilityReceipt(this.#storage.drain()),
				);
			}
			await handle?.flush();
		} catch {
			// A successful primary flush remains successful when the optional journal fails.
		}
		if (primaryError) throw primaryError;
	}

	/**
	 * Synchronously makes the current append-only session durable. Avoid rewriting
	 * an already-current file: large restored sessions can contain GiB of compacted
	 * history, and Ctrl+C must not rebuild the whole JSONL string just to flush.
	 */
	flushSync(): void {
		if (!this.#persist || !this.#sessionFile) return;
		if (this.#atomicEntryBatch) throw new Error("Cannot synchronously flush during an atomic session batch.");
		if (this.#diskFailure) throw this.#diskFailure;
		if (this.#fileIsCurrent && !this.#rewriteRequired) {
			this.#writer?.flushSync?.();
			const writerError = this.#writer?.getError();
			if (writerError) throw writerError;
			return;
		}
		this.#rewriteSynchronously("rewrite");
		if (this.#diskFailure) throw this.#diskFailure;
	}

	/**
	 * Drop only session files that this manager saw materialized for a draft and
	 * that still contain no durable conversation or extension state. Explicit
	 * ensureOnDisk() records (ACP session/new, handoff) stay resumable.
	 */
	async #dropIfEmptyAndNoDraft(): Promise<void> {
		if (!this.#draftOnlySessionCleanupArmed) return;
		const sessionFile = this.#sessionFile;
		if (!sessionFile || !this.#storage.existsSync(sessionFile)) {
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		const draftPath = this.#draftPath();
		if (draftPath && this.#storage.existsSync(draftPath)) return;
		if (!this.#entries.every(isDraftOnlyMetadataEntry)) {
			await this.#clearDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = false;
			return;
		}
		try {
			const committed = this.#storage.deleteSessionWithArtifacts(sessionFile).catch(error => {
				if (!isEnoent(error)) throw error;
			});
			this.#submitJournalDelete(createPrimarySessionDurabilityReceipt(committed));
			await committed;
			this.#journalProjection = undefined;
			this.#fileIsCurrent = false;
			this.#forceFileCreation = false;
			this.#hasTitleSlot = false;
			this.#draftOnlySessionCleanupArmed = false;
		} catch (err) {
			if (!isEnoent(err)) {
				logger.warn("Failed to drop empty session on close", { sessionFile, error: String(err) });
			}
		}
	}

	/** Flush, then close the append writer. */
	async close(): Promise<void> {
		if (!this.#persist) return;
		let primaryError: Error | undefined;
		try {
			await this.#scheduleDiskWork(async () => {
				const hadWriter = this.#writer !== undefined;
				await this.#closeWriterHandle();
				if (hadWriter || (this.#sessionFile && this.#storage.existsSync(this.#sessionFile)))
					this.#fileIsCurrent = true;
			});
			await this.#dropIfEmptyAndNoDraft();
		} catch (error) {
			primaryError = toError(error);
		}
		try {
			// Wait for any queued backing writes (IndexedSessionStorage per-path
			// tail) to become durable before journal reconciliation and release.
			await this.#storage.drain();
		} catch (error) {
			primaryError ??= toError(error);
		}
		if (!primaryError && this.#diskFailure) primaryError = this.#diskFailure;
		await this.#releaseJournalHandle(primaryError === undefined);
		if (primaryError) throw primaryError;
	}

	getCwd(): string {
		return this.#cwd;
	}

	/** Additional workspace directories beyond cwd (multi-root), absolute and normalized. */
	getAdditionalDirectories(): string[] {
		return [...this.#additionalDirectories];
	}

	/**
	 * Persist a workspace-directory change to the session header. Respects the
	 * lazy-persistence gate: a session with no durable output yet keeps the
	 * change in memory (the header lands with the first real write), so seeding
	 * roots at launch never materializes an empty resumable session file.
	 */
	async #persistWorkspaceDirectoriesChange(): Promise<void> {
		if (!this.#persist || !this.#sessionFile || !this.#shouldHaveSessionFile()) return;
		this.#rewriteRequired = true;
		await this.#rewriteAtomically("header-change");
	}

	/**
	 * Add a workspace directory. Normalizes (relative to cwd), dedupes, rejects
	 * the cwd itself, persists to the session header, and triggers an atomic
	 * rewrite so the change survives a crash. Returns the resolved absolute
	 * path or `null` when the directory was already present (no-op).
	 */
	async addWorkspaceDirectory(directory: string): Promise<string | null> {
		const resolved = normalizeWorkspaceDirectory(directory, this.#cwd);
		if (resolved === path.resolve(this.#cwd)) {
			throw new Error("The current working directory is already the primary workspace root.");
		}
		if (this.#additionalDirectories.includes(resolved)) return null;
		this.#additionalDirectories = [...this.#additionalDirectories, resolved];
		this.#header.additionalDirectories = this.#additionalDirectories;
		await this.#persistWorkspaceDirectoriesChange();
		return resolved;
	}

	/**
	 * Remove a workspace directory by absolute or cwd-relative path. Persists
	 * the trimmed header. Returns the resolved path that was removed, or
	 * `null` when the directory was not an additional root (no-op).
	 */
	async removeWorkspaceDirectory(directory: string): Promise<string | null> {
		const resolved = normalizeWorkspaceDirectory(directory, this.#cwd);
		const idx = this.#additionalDirectories.findIndex(p => path.resolve(p) === resolved);
		if (idx === -1) return null;
		this.#additionalDirectories = this.#additionalDirectories.filter((_, i) => i !== idx);
		if (this.#additionalDirectories.length === 0) {
			this.#header.additionalDirectories = undefined;
		} else {
			this.#header.additionalDirectories = this.#additionalDirectories;
		}
		await this.#persistWorkspaceDirectoriesChange();
		return resolved;
	}

	/** Seed additional directories from settings or a passed list. Also called on resumed sessions with --add-dir; persists the updated header when the session file is already durable. No-op when the normalized list is unchanged (avoids rewriting large session files on every startup). */
	async setAdditionalDirectories(directories: string[]): Promise<void> {
		const workspace = normalizeSessionWorkspace({ cwd: this.#cwd, directories });
		const next = additionalWorkspaceDirectories(workspace);
		if (
			next.length === this.#additionalDirectories.length &&
			next.every((d, i) => d === this.#additionalDirectories[i])
		) {
			return;
		}
		this.#additionalDirectories = next;
		if (this.#additionalDirectories.length > 0) {
			this.#header.additionalDirectories = this.#additionalDirectories;
		} else {
			this.#header.additionalDirectories = undefined;
		}
		await this.#persistWorkspaceDirectoriesChange();
	}

	getUsageStatistics(): UsageStatistics {
		return this.#index.usageSnapshot();
	}

	/**
	 * Open a new per-turn budget window: snapshot the cumulative output baseline,
	 * reset the eval-subagent counter, and set the (optional) ceiling.
	 */
	beginTurnBudget(total: number | null, hard: boolean): void {
		this.#turnBudgetTotal = total;
		this.#turnBudgetHard = hard;
		this.#turnOutputBaseline = this.#index.usageSnapshot().output;
		this.#turnEvalOutput = 0;
	}

	recordEvalSubagentOutput(output: number): void {
		if (Number.isFinite(output) && output > 0) this.#turnEvalOutput += output;
	}

	getTurnBudget(): { total: number | null; spent: number; hard: boolean } {
		const mainOutput = Math.max(0, this.#index.usageSnapshot().output - this.#turnOutputBaseline);
		return { total: this.#turnBudgetTotal, spent: mainOutput + this.#turnEvalOutput, hard: this.#turnBudgetHard };
	}

	getSessionDir(): string {
		return this.#sessionDir;
	}

	getSessionId(): string {
		return this.#sessionId;
	}

	/** Persisted conversation-boundary ordinal used as the async delivery epoch. */
	resolveTransientTaskDeliveryEpoch(): number {
		let deliveryEpoch = 0;
		for (const entry of this.getBranch()) {
			if (entry.type === "reset_boundary") deliveryEpoch += 1;
		}
		return deliveryEpoch;
	}

	resolveTransientTaskJournalGenerationAuthority(
		branchAnchorEntryId: string | null,
	): ConfidentialAgentSessionJournalGenerationAuthorityResultV1 {
		const sessionId = this.#header?.id;
		if (
			!detachedIdentity(sessionId) ||
			sessionId !== this.#sessionId ||
			(branchAnchorEntryId !== null && !detachedIdentity(branchAnchorEntryId))
		) {
			return { status: "invalid" };
		}
		if (branchAnchorEntryId !== null && !this.#index.get(branchAnchorEntryId)) {
			return { status: "branch_anchor_missing" };
		}
		const sessionGenerationCore = { schemaVersion: 1 as const, sessionId };
		const sessionGeneration = {
			core: sessionGenerationCore,
			sessionGenerationSha256: detachedTupleSha256Ref([
				"omp-agent-session-journal-generation-v1",
				"session-core",
				1,
				sessionId,
			]),
		};
		const branchGenerationCore = {
			schemaVersion: 1 as const,
			sessionGenerationSha256: sessionGeneration.sessionGenerationSha256,
			branchAnchorEntryId,
		};
		const branchGeneration = {
			core: branchGenerationCore,
			branchGenerationSha256: detachedTupleSha256Ref([
				"omp-agent-session-journal-generation-v1",
				"branch-core",
				1,
				sessionGeneration.sessionGenerationSha256,
				branchAnchorEntryId,
			]),
		};
		return { status: "matching", authority: { sessionGeneration, branchGeneration } };
	}

	getSessionFile(): string | undefined {
		return this.#sessionFile;
	}

	getArtifactsDir(): string | null {
		if (this.#adoptedArtifactManager) return this.#adoptedArtifactManager.dir;
		return artifactsDirectoryFor(this.#sessionFile);
	}

	adoptArtifactManager(manager: ArtifactManager): void {
		this.#adoptedArtifactManager = manager;
	}

	getArtifactManager(): ArtifactManager | null {
		return this.#artifactManagerForSession();
	}

	async allocateArtifactPath(toolType: string): Promise<{ id?: string; path?: string }> {
		return (await this.#artifactManagerForSession()?.allocatePath(toolType)) ?? {};
	}

	async saveArtifact(content: string, toolType: string): Promise<string | undefined> {
		const manager = this.#artifactManagerForSession();
		if (manager) return manager.save(content, toolType);

		// Non-persistent session: keep an in-memory copy so spill truncation works.
		this.#inMemoryArtifacts ??= new Map();
		const id = String(this.#inMemoryArtifactCounter++);
		this.#inMemoryArtifacts.set(id, content);
		return id;
	}

	async getArtifactPath(id: string): Promise<string | null> {
		return (await this.#artifactManagerForSession()?.getPath(id)) ?? null;
	}

	async saveDraft(text: string): Promise<void> {
		const draftPath = this.#draftPath();
		if (!draftPath || !this.#persist) return;

		if (text.length === 0) {
			try {
				await this.#storage.unlink(draftPath);
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			return;
		}

		const sessionFile = this.#sessionFile;
		const draftWillMaterializeMetadataOnlyFile =
			sessionFile !== undefined &&
			!this.#storage.existsSync(sessionFile) &&
			this.#entries.every(isDraftOnlyMetadataEntry);
		// Force the header onto disk so resume can find the file this draft attaches to.
		await this.ensureOnDisk();
		if (draftWillMaterializeMetadataOnlyFile) {
			await this.#writeDraftOnlySessionMarker();
			this.#draftOnlySessionCleanupArmed = true;
		}
		await this.#storage.writeText(draftPath, text);
	}

	async consumeDraft(): Promise<string | null> {
		const draftPath = this.#draftPath();
		if (!draftPath) return null;

		let draft: string;
		try {
			draft = await this.#storage.readText(draftPath);
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}

		try {
			await this.#storage.unlink(draftPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		if (this.#entries.every(isDraftOnlyMetadataEntry) && this.#hasDraftOnlySessionMarker())
			this.#draftOnlySessionCleanupArmed = true;

		return draft;
	}

	/** The source that set the session name: "user" (manual/RPC) or "auto" (generated title). */
	get titleSource(): SessionTitleSource | undefined {
		return this.#titleSource;
	}

	getSessionName(): string | undefined {
		return this.#sessionName;
	}

	onSessionNameChanged(cb: () => void): () => void {
		this.#sessionNameChangedCallbacks.add(cb);
		return () => {
			this.#sessionNameChangedCallbacks.delete(cb);
		};
	}

	/**
	 * Set the session display name.
	 * @param source "user" for explicit renames; "auto" for generated titles.
	 *   Auto titles are ignored once the user has set a name.
	 */
	async setSessionName(name: string, source: SessionTitleSource = "auto", trigger?: string): Promise<boolean> {
		if (this.#titleSource === "user" && source === "auto") return false;

		const title = SessionManager.#cleanTitle(name);
		if (!title) return false;

		const previousTitle = this.#sessionName;
		const timestamp = nowIso();
		this.#sessionName = title;
		this.#titleSource = source;
		this.#titleUpdatedAt = timestamp;
		this.#header.title = title;
		this.#header.titleSource = source;

		const entry: TitleChangeEntry = {
			type: TITLE_CHANGE_ENTRY_TYPE,
			...this.#freshEntryFields(),
			timestamp,
			title,
			source,
		};
		if (previousTitle) entry.previousTitle = previousTitle;
		if (trigger) entry.trigger = trigger;
		this.#entries.push(entry);
		this.#index.insert(entry);
		this.#notifyEntryAppended(entry);
		await this.#persistTitleChangeEntry(entry, { title, source, updatedAt: timestamp });

		this.#notifySessionNameListeners();
		return true;
	}

	/**
	 * Append a foreign (host-authored) entry verbatim, preserving its
	 * `id`/`parentId`. Used by collab guests to mirror the host session.
	 */
	ingestReplicatedEntry(entry: SessionEntry): void {
		this.#recordEntry(entry);
	}

	/**
	 * Snapshot the session for collab replication: the live header plus a deep
	 * copy of every entry (the host mutates entries in place on rewrite paths, so
	 * guests must not share references).
	 */
	snapshotForReplication(): { header: SessionHeader; entries: SessionEntry[] } {
		return { header: structuredClone(this.#header), entries: structuredClone(this.#entries) as SessionEntry[] };
	}

	/**
	 * Append a message as a child of the current leaf, then advance the leaf.
	 * CompactionSummaryMessage / BranchSummaryMessage are rejected here — they are
	 * top-level entries via appendCompaction()/branchWithSummary().
	 */
	appendMessage(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
	): string {
		const entry: SessionMessageEntry = { type: "message", ...this.#freshEntryFields(), message };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append to a non-active branch without changing the current leaf.
	 * Used by work that retains ownership of a branch across tree navigation.
	 */
	appendMessageToBranch(
		message:
			| Message
			| CustomMessage
			| HookMessage
			| BashExecutionMessage
			| PythonExecutionMessage
			| FileMentionMessage,
		parentId: string | null,
	): string {
		if (parentId !== null && !this.#index.has(parentId)) throw new Error(`Entry ${parentId} not found`);
		const activeLeafId = this.#index.leafId();
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.#index),
			parentId,
			timestamp: nowIso(),
			message,
		};
		this.#recordEntry(entry);
		this.#index.setLeaf(activeLeafId);
		return entry.id;
	}

	/** Append a thinking level change as child of current leaf, then advance leaf. Returns entry id. */
	appendThinkingLevelChange(thinkingLevel?: string, configured?: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			...this.#freshEntryFields(),
			thinkingLevel: thinkingLevel ?? null,
			configured: configured ?? null,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	appendServiceTierChange(serviceTier: ServiceTierByFamily | null): string {
		const entry: ServiceTierChangeEntry = { type: "service_tier_change", ...this.#freshEntryFields(), serviceTier };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendModeChange(mode: string, data?: Record<string, unknown>): string {
		const entry: ModeChangeEntry = { type: "mode_change", ...this.#freshEntryFields(), mode, data };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append a model change as a child of the current leaf, then advance the leaf.
	 * @param model Model in "provider/modelId" format
	 * @param role Optional role (default: "default")
	 */
	appendModelChange(model: string, role?: string): string {
		const entry: ModelChangeEntry = { type: "model_change", ...this.#freshEntryFields(), model, role };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendSessionInit(init: {
		systemPrompt: string;
		task: string;
		tools: string[];
		outputSchema?: unknown;
		outputSchemaMode?: StructuredSubagentSchemaMode;
		restrictToolNames?: boolean;
		spawns?: string;
		readSummarize?: boolean;
	}): string {
		const entry: SessionInitEntry = { type: "session_init", ...this.#freshEntryFields(), ...init };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendPlannedSessionInit(
		entryId: string,
		init: {
			systemPrompt: string;
			task: string;
			tools: string[];
			outputSchema?: unknown;
			outputSchemaMode?: StructuredSubagentSchemaMode;
			restrictToolNames?: boolean;
			spawns?: string;
			readSummarize?: boolean;
		},
	): string {
		if (!entryId) throw new Error("Planned session init entry ID must not be empty");
		if (this.#index.has(entryId)) throw new Error(`Entry ${entryId} already exists`);
		const entry: SessionInitEntry = { ...init, type: "session_init", ...this.#freshEntryFields(entryId) };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCompaction<T = unknown>(
		summary: string,
		shortSummary: string | undefined,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromExtension?: boolean,
		preserveData?: Record<string, unknown>,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			...this.#freshEntryFields(),
			summary,
			shortSummary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromExtension,
			preserveData,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Append the durable conversation boundary recorded by `/clear`. The
	 * collapsed live transcript and the model-context rebuild start after the
	 * latest one, while the full history stays on disk (the plain
	 * `transcript:true` export walks it unchanged).
	 */
	appendResetBoundary(): string {
		const entry: ResetBoundaryEntry = { type: "reset_boundary", ...this.#freshEntryFields() };
		this.#recordEntry(entry);
		return entry.id;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = { type: "custom", customType, data, ...this.#freshEntryFields() };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Rewrite the session file after in-place entry updates (e.g. pruning old tool
	 * outputs). Use sparingly.
	 */
	async rewriteEntries(): Promise<void> {
		if (!this.#persist || !this.#sessionFile) return;
		await this.#rewriteAtomically("rewrite");
	}

	/**
	 * Append a custom message entry (for extensions) that participates in LLM context.
	 * @param customType Hook identifier for filtering on reload
	 * @param content Message content (string or TextContent/ImageContent array)
	 * @param display Whether to show in TUI (true = styled display, false = hidden)
	 * @param details Optional extension-specific metadata (not sent to LLM)
	 * @param attribution Who initiated this message for billing/attribution semantics
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string | undefined,
		content: string | (TextContent | ImageContent)[] | undefined,
		display: boolean | undefined,
		details?: T,
		attribution: MessageAttribution | undefined = "agent",
	): string {
		const normalized = normalizeCustomMessagePayload<T>({ customType, content, display, details, attribution });
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType: normalized.customType,
			content: normalized.content,
			display: normalized.display,
			// Drop AgentSession-internal transient fields before disk persistence.
			details: stripInternalDetailsFields(normalized.details),
			attribution: normalized.attribution,
			...this.#freshEntryFields(),
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/** Append a TTSR injection entry recording which rules were injected. */
	appendTtsrInjection(ruleNames: string[]): string {
		const entry: TtsrInjectionEntry = {
			type: "ttsr_injection",
			...this.#freshEntryFields(),
			injectedRules: [...ruleNames],
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/** All unique TTSR rule names injected on the current branch (root → leaf). */
	getInjectedTtsrRules(): string[] {
		const names = new Set<string>();
		for (const entry of this.getBranch()) {
			if (entry.type !== "ttsr_injection") continue;
			for (const name of entry.injectedRules) names.add(name);
		}
		return [...names];
	}

	/** Append a credential pin recording which OAuth account served `provider`. */
	appendCredentialPin(provider: string, hash: string): string {
		const entry: CredentialPinEntry = {
			type: "credential_pin",
			...this.#freshEntryFields(),
			provider,
			hash,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Latest credential pin per provider on the current branch (root → leaf),
	 * with the effective last-use time of the pinned account.
	 *
	 * Pins are appended only when the serving account *changes*, so a long
	 * session on one account carries a single old pin entry. Any assistant turn
	 * for the same provider after that pin was necessarily served by the pinned
	 * account, so its timestamp advances `lastUsedAt` — a resume seconds after
	 * the last turn seeds a warm sticky instead of a stale one.
	 */
	getCredentialPins(): Map<string, { hash: string; lastUsedAt: number }> {
		const pins = new Map<string, { hash: string; lastUsedAt: number }>();
		for (const entry of this.getBranch()) {
			if (entry.type === "credential_pin") {
				pins.set(entry.provider, { hash: entry.hash, lastUsedAt: new Date(entry.timestamp).getTime() });
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				const pin = pins.get(entry.message.provider);
				if (pin) pin.lastUsedAt = Math.max(pin.lastUsedAt, entry.message.timestamp);
			}
		}
		return pins;
	}

	getLeafId(): string | null {
		return this.#index.leafId();
	}

	getLeafEntry(): SessionEntry | undefined {
		return this.#index.leafEntry();
	}

	/**
	 * The most recent model role on the current branch, or undefined when no
	 * model change has been recorded.
	 */
	getLastModelChangeRole(): string | undefined {
		const branch = this.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type === "model_change") return entry.role ?? "default";
		}
		return undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		return this.#index.get(id);
	}

	/** All direct children of an entry. */
	getChildren(parentId: string): SessionEntry[] {
		return this.#index.childrenOf(parentId);
	}

	getLabel(id: string): string | undefined {
		return this.#index.labelFor(id);
	}

	/**
	 * Set or clear a label on an entry. Pass undefined/empty to clear.
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		if (!this.#index.has(targetId)) throw new Error(`Entry ${targetId} not found`);

		const entry: LabelEntry = { type: "label", ...this.#freshEntryFields(), targetId, label };
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Walk from an entry to root, returning entries in path order. Includes all
	 * entry types; use buildSessionContext() for the resolved LLM messages.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		return this.#index.pathTo(fromId ?? this.#index.leafId());
	}

	/**
	 * Build the session context (LLM messages), or — with `{ transcript: true }` —
	 * the full-history display transcript, from the current leaf path.
	 */
	buildSessionContext(options?: BuildSessionContextOptions): SessionContext {
		return buildSessionContext(this.#entries, this.#index.leafId(), this.#index.entriesById(), options);
	}

	/** Strip stale OpenAI Responses assistant replay metadata from loaded entries. */
	sanitizeLoadedOpenAIResponsesReplayMetadata(): boolean {
		let changed = false;
		for (const entry of this.#entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;

			const sanitized = sanitizeRehydratedOpenAIResponsesAssistantMessage(entry.message);
			if (sanitized === entry.message) continue;

			entry.message = sanitized;
			changed = true;
		}

		return changed;
	}

	getHeader(): SessionHeader | null {
		return this.#header;
	}

	/** All session entries (excludes header). Returns a shallow copy. */
	getEntries(): SessionEntry[] {
		return [...this.#entries];
	}

	/**
	 * The session as a tree. A well-formed session has exactly one root; orphaned
	 * entries (broken parent chain) are returned as roots too.
	 */
	getTree(): SessionTreeNode[] {
		return this.#index.tree(this.#entries);
	}

	/**
	 * Move the leaf to an earlier entry so the next append forms a new branch.
	 * Existing entries are never modified or deleted.
	 */
	branch(branchFromId: string): void {
		if (!this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.#setLeaf(branchFromId);
	}

	/** Reset the leaf to null so the next append creates a new root entry. */
	resetLeaf(): void {
		this.#setLeaf(null);
	}

	/** Like branch(), but also records a branch_summary of the abandoned path. */
	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromExtension?: boolean): string {
		if (branchFromId !== null && !this.#index.has(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);

		this.#setLeaf(branchFromId);
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.#index),
			parentId: branchFromId,
			timestamp: nowIso(),
			fromId: branchFromId ?? "root",
			summary,
			details,
			fromExtension,
		};
		this.#recordEntry(entry);
		return entry.id;
	}

	/**
	 * Create a new session file containing only the path from root to `leafId`.
	 * Returns the new file path, or undefined when not persisting.
	 */
	createBranchedSession(leafId: string): string | undefined {
		const sourceSessionFile = this.#sessionFile;
		const branchPath = this.getBranch(leafId);
		if (branchPath.length === 0) throw new Error(`Entry ${leafId} not found`);
		void this.#releaseJournalHandle(!this.#diskFailure);

		// Drop label entries from the path; recreate them fresh from the resolved map.
		const entriesToKeep = branchPath.filter(entry => entry.type !== "label");
		const keptIds = new Set(entriesToKeep.map(entry => entry.id));
		const labelsToCarry: Array<{ targetId: string; label: string }> = [];
		for (const [targetId, label] of this.#index.labelsInEffect()) {
			if (keptIds.has(targetId)) labelsToCarry.push({ targetId, label });
		}

		const timestamp = nowIso();
		const newSessionId = mintSessionId();
		const newSessionFile = path.join(this.#sessionDir, `${fileSafeTimestamp(timestamp)}_${newSessionId}.jsonl`);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.#cwd,
			title: this.#sessionName,
			titleSource: this.#titleSource,
			parentSession: this.#persist ? sourceSessionFile : undefined,
			additionalDirectories: this.#additionalDirectories.length > 0 ? [...this.#additionalDirectories] : undefined,
		};

		const labels: LabelEntry[] = [];
		let parentId = entriesToKeep[entriesToKeep.length - 1]?.id ?? null;
		for (const carried of labelsToCarry) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...keptIds, ...labels.map(entry => entry.id)])),
				parentId,
				timestamp: nowIso(),
				targetId: carried.targetId,
				label: carried.label,
			};
			labels.push(labelEntry);
			parentId = labelEntry.id;
		}

		this.#header = header;
		this.#entries = [...entriesToKeep, ...labels];
		this.#sessionId = newSessionId;
		this.#sessionName = header.title;
		this.#titleSource = header.titleSource;
		this.#titleUpdatedAt = timestamp;
		this.#hasTitleSlot = true;
		this.#index.rebuild(this.#entries);
		this.#artifactManager = null;
		this.#artifactManagerSessionFile = null;
		this.#forceFileCreation = this.#persist;

		if (!this.#persist) {
			this.#sessionFile = undefined;
			this.#fileIsCurrent = false;
			this.#rewriteRequired = false;
			return undefined;
		}

		this.#sessionFile = newSessionFile;
		if (this.#journalService && this.#journalDescriptor) this.#openJournalStreamForCurrentSession();
		this.#rewriteSynchronously("branch");
		this.#rememberBreadcrumb(this.#cwd, newSessionFile);
		return newSessionFile;
	}

	/** Resolve the canonical default session directory for a cwd. */
	static getDefaultSessionDir(
		cwd: string,
		agentDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): string {
		return computeDefaultSessionDir(cwd, storage, getSessionsDir(agentDir));
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in the session header)
	 * @param sessionDir Optional session directory; defaults to the cwd-derived dir.
	 */
	static create(cwd: string, sessionDir?: string, storage: SessionStorage = new FileSessionStorage()): SessionManager {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#resetToNewSession();
		return manager;
	}

	static createPlanned({
		sessionId,
		sessionFile,
		createdAt,
		cwd,
		parentSession,
		providerPromptCacheKey,
		suppressBreadcrumb = true,
		storage = new FileSessionStorage(),
	}: {
		sessionId: string;
		sessionFile: string;
		createdAt: ISO8601;
		cwd: string;
		parentSession?: string;
		providerPromptCacheKey?: string;
		suppressBreadcrumb?: boolean;
		storage?: SessionStorage;
	}): SessionManager {
		if (!detachedIdentity(sessionId)) throw new Error("Planned session ID must be a non-empty valid identity");
		if (!sessionFile) throw new Error("Planned session file must not be empty");
		if (!detachedIso8601(createdAt)) throw new Error("Planned session creation time must be ISO-8601");
		const manager = new SessionManager(cwd, path.dirname(sessionFile), true, storage);
		manager.#suppressBreadcrumb = true;
		manager.#resetToNewSession({ parentSession, providerPromptCacheKey }, sessionFile, {
			sessionId,
			timestamp: createdAt,
		});
		manager.#forceFileCreation = true;
		manager.#rewriteSynchronously("create");
		manager.#suppressBreadcrumb = suppressBreadcrumb;
		if (!suppressBreadcrumb) manager.#rememberBreadcrumb(cwd, sessionFile);
		return manager;
	}

	/**
	 * Create a fresh empty session file in the default session directory for
	 * `cwd`, writing only the session header. The returned path can be passed to
	 * `setSessionFile` / `AgentSession.switchSession` when a caller explicitly
	 * needs a brand-new persisted session at a cwd-derived path.
	 */
	static createEmptySessionFile(cwd: string, storage: SessionStorage = new FileSessionStorage()): string {
		const sessionDir = SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const id = mintSessionId();
		const timestamp = nowIso();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id,
			timestamp,
			cwd: path.resolve(cwd),
		};
		const file = path.join(sessionDir, `${fileSafeTimestamp(timestamp)}_${id}.jsonl`);
		storage.writeTextSync(file, `${serializeTitleSlot({ updatedAt: timestamp })}${JSON.stringify(header)}\n`);
		return file;
	}

	/**
	 * Fork a session into the current project directory: copy history from another
	 * session file while creating a fresh session file in this sessionDir.
	 *
	 * `options.sessionFile` pins the new session's file path (default: an
	 * auto-named `<timestamp>_<id>.jsonl` in `sessionDir`). Callers that register
	 * the fork as a named agent (e.g. `/tan`) pass `<agentId>.jsonl` so the
	 * persisted-subagent scan keys the agent by the same id the live ref uses.
	 */
	static async forkFrom(
		sourcePath: string,
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: { suppressBreadcrumb?: boolean; sessionFile?: string },
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;

		const sourceEntries = structuredClone(await loadEntriesFromFile(sourcePath, storage)) as FileEntry[];
		migrateToCurrentVersion(sourceEntries);
		await resolveBlobRefsInEntries(sourceEntries, manager.#blobs);

		const sourceHeader = sourceEntries.find(entry => entry.type === "session") as SessionHeader | undefined;
		const history = sourceEntries.filter(entry => entry.type !== "session") as SessionEntry[];
		manager.#resetToNewSession(
			{
				parentSession: sourceHeader?.id,
				providerPromptCacheKey: sourceHeader?.providerPromptCacheKey ?? sourceHeader?.id,
			},
			options?.sessionFile,
		);
		manager.#header.title = sourceHeader?.title;
		manager.#header.titleSource = sourceHeader?.titleSource;
		manager.#additionalDirectories = (sourceHeader?.additionalDirectories ?? []).filter(d => d !== path.resolve(cwd));
		manager.#header.additionalDirectories =
			manager.#additionalDirectories.length > 0 ? manager.#additionalDirectories : undefined;
		manager.#sessionName = manager.#header.title;
		manager.#titleSource = manager.#header.titleSource;
		manager.#titleUpdatedAt = nowIso();
		manager.#hasTitleSlot = true;
		manager.#entries = history;
		manager.#index.rebuild(history);
		manager.sanitizeLoadedOpenAIResponsesReplayMetadata();
		manager.#forceFileCreation = true;
		await manager.#rewriteAtomically("fork");
		return manager;
	}

	/**
	 * Open a specific session file.
	 * @param sessionDir Optional dir for /new or /branch; defaults to the file's parent.
	 * @param options.initialCwd Cwd to use when the file is empty or missing.
	 */
	static async open(
		filePath: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
		options?: { initialCwd?: string; suppressBreadcrumb?: boolean },
	): Promise<SessionManager> {
		const loaded = await loadEntriesFromFile(filePath, storage);
		const header = loaded.find(entry => entry.type === "session") as SessionHeader | undefined;
		// Resume into the session's recorded cwd only when that directory still
		// exists. A deleted project dir would make the constructor's #cwd — and the
		// `setProjectDir` chdir interactive mode runs next — point at (and fail on)
		// a missing path, so fall back to the launch cwd and anchor /new and /branch
		// there too, keeping the resumed session where the user already is.
		const recordedCwd = header?.cwd;
		const recordedCwdUsable = !!recordedCwd && (await directoryExists(recordedCwd));
		const cwd = recordedCwdUsable ? recordedCwd : (options?.initialCwd ?? getProjectDir());
		const dir =
			sessionDir ??
			(recordedCwd && !recordedCwdUsable
				? SessionManager.getDefaultSessionDir(cwd, undefined, storage)
				: path.dirname(path.resolve(filePath)));
		const manager = new SessionManager(cwd, dir, true, storage);
		manager.#suppressBreadcrumb = options?.suppressBreadcrumb === true;
		await manager.setSessionFile(filePath);
		return manager;
	}

	/**
	 * Lock-free peek for cold subagent revival: returns the recorded working
	 * directory (session header) and the latest `session_init` contract (system
	 * prompt / tools / output schema) WITHOUT taking the single-writer lock that
	 * {@link open} acquires — the caller re-opens for the actual revive. Returns
	 * null when the file can't be read; `init` is null for files written before
	 * `session_init` was recorded (no faithful contract to rebuild from).
	 */
	static async peekSessionInit(
		filePath: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<{
		cwd: string;
		init: {
			systemPrompt: string;
			task: string;
			tools: string[];
			outputSchema?: unknown;
			outputSchemaMode?: StructuredSubagentSchemaMode;
			restrictToolNames?: boolean;
			spawns?: string;
			readSummarize?: boolean;
		} | null;
	} | null> {
		let loaded: FileEntry[];
		try {
			loaded = await loadEntriesFromFile(filePath, storage);
		} catch {
			return null;
		}
		// A missing/empty file has no usable session — nothing to revive from.
		if (loaded.length === 0) return null;
		const header = loaded.find(entry => entry.type === "session") as SessionHeader | undefined;
		let init: {
			systemPrompt: string;
			task: string;
			tools: string[];
			outputSchema?: unknown;
			outputSchemaMode?: StructuredSubagentSchemaMode;
			restrictToolNames?: boolean;
			spawns?: string;
			readSummarize?: boolean;
		} | null = null;
		for (let index = loaded.length - 1; index >= 0; index--) {
			const entry = loaded[index];
			if (entry.type === "session_init") {
				init = {
					systemPrompt: entry.systemPrompt,
					task: entry.task,
					tools: entry.tools,
					outputSchema: entry.outputSchema,
					outputSchemaMode: entry.outputSchemaMode,
					restrictToolNames: entry.restrictToolNames,
					readSummarize: entry.readSummarize,
					spawns: entry.spawns,
				};
				break;
			}
		}
		return { cwd: header?.cwd ?? getProjectDir(), init };
	}

	/** Continue the most recent session, or create a new one if none exists. */
	static async continueRecent(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionManager> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		const resolvedCwd = path.resolve(cwd);
		const breadcrumb = await readTerminalBreadcrumbEntry();
		let chosenSession: string | null | undefined;

		if (breadcrumb) {
			// A fresh `/new` boundary whose JSONL was never materialized (lazy
			// new-session persistence, then a process exit before any assistant
			// output). Honor the boundary: start fresh rather than falling back to
			// findMostRecentSession(), which would resurrect the pre-`/new`
			// transcript. A materialized (or genuinely stale/deleted) crumb reports
			// exists=false only when fresh, so this never masks a real stale crumb.
			if (breadcrumb.fresh && !breadcrumb.exists) {
				const manager = new SessionManager(cwd, dir, true, storage);
				manager.#resetToNewSession();
				return manager;
			}

			// Recover stale crumbs: a subagent open (pre-fix) may have pointed this
			// terminal's breadcrumb at an artifact child; resume the parent instead.
			breadcrumb.sessionFile = resolveBreadcrumbToInteractiveRoot(breadcrumb.sessionFile);
			const breadcrumbCwd = path.resolve(breadcrumb.cwd);
			if (breadcrumbCwd === resolvedCwd) {
				chosenSession = breadcrumb.sessionFile;
			} else {
				// The terminal's last session started in a different cwd. If that cwd is
				// gone (worktree move/rename) and this location has no sessions of its
				// own, re-root the moved session here instead of starting fresh. When an
				// explicit sessionDir is reused across the move, the stale breadcrumb file
				// may be the newest entry there; prefer a genuine current-cwd session.
				let newestInTargetDir = await findMostRecentSession(dir, storage);
				const breadcrumbFile = path.resolve(breadcrumb.sessionFile);
				const breadcrumbCwdMissing = !fs.existsSync(breadcrumbCwd);
				const newestIsBreadcrumb = newestInTargetDir ? path.resolve(newestInTargetDir) === breadcrumbFile : false;
				let currentProjectAlreadyHasSession = false;

				if (breadcrumbCwdMissing && newestIsBreadcrumb) {
					const localSession = (await SessionManager.list(cwd, dir, storage)).find(
						session =>
							path.resolve(session.path) !== breadcrumbFile &&
							session.cwd &&
							path.resolve(session.cwd) === resolvedCwd,
					);
					if (localSession) {
						newestInTargetDir = localSession.path;
						currentProjectAlreadyHasSession = true;
					}
				}

				const looksLikeMovedProject =
					breadcrumbCwdMissing &&
					(newestInTargetDir === null || (newestIsBreadcrumb && !currentProjectAlreadyHasSession));
				if (looksLikeMovedProject) {
					logger.info("Re-rooting moved session", { from: breadcrumbCwd, to: resolvedCwd });
					// Anchor at the gone breadcrumb cwd so the moveTo below relocates the
					// session: open() now falls back to the launch cwd for a missing
					// recorded cwd, which would no-op moveTo when it equals `cwd`.
					const manager = await SessionManager.open(breadcrumb.sessionFile, undefined, storage, {
						initialCwd: breadcrumbCwd,
					});
					await manager.moveTo(cwd, sessionDir);
					return manager;
				}

				chosenSession = newestInTargetDir;
			}
		}

		if (chosenSession === undefined) chosenSession = await findMostRecentSession(dir, storage);

		const manager = new SessionManager(cwd, dir, true, storage);
		if (chosenSession) await manager.setSessionFile(chosenSession);
		else manager.#resetToNewSession();
		return manager;
	}

	/** Create an in-memory session (no file persistence). */
	static inMemory(
		cwd: string = getProjectDir(),
		storage: SessionStorage = new MemorySessionStorage(),
	): SessionManager {
		const manager = new SessionManager(cwd, "", false, storage);
		manager.#resetToNewSession();
		return manager;
	}

	/**
	 * List sessions for a project directory.
	 * @param sessionDir Optional dir; defaults to the cwd-derived dir.
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		storage: SessionStorage = new FileSessionStorage(),
	): Promise<SessionInfo[]> {
		const dir = sessionDir ?? SessionManager.getDefaultSessionDir(cwd, undefined, storage);
		return listSessions(dir, storage);
	}

	/** List all sessions across all project directories. */
	static listAll(storage: SessionStorage = new FileSessionStorage()): Promise<SessionInfo[]> {
		return listAllSessions(storage);
	}
}

/** Coordinator-owned detached append view; lifetime follows the session manager. */
export function createTransientTaskDetachedPrimarySessionAppendBridgeV1(
	sessionManager: SessionManager,
): TransientTaskDetachedPrimarySessionAppendBridgeV1 {
	return sessionManager.transientPersistence;
}

/** Coordinator-owned lifecycle gate view. */
export function createTransientTaskLifecycleGateStoreV1(
	sessionManager: SessionManager,
): TransientTaskLifecycleGateStoreV1 {
	return sessionManager.transientPersistence;
}

/** Coordinator-owned general tool-result serializer view. */
export function createAgentSessionToolResultPersistenceSerializerV1(
	sessionManager: SessionManager,
): AgentSessionToolResultPersistenceSerializerV1 {
	return sessionManager.transientPersistence;
}

/** Coordinator-owned foreground append view. */
export function createTransientTaskForegroundSessionAppendBridgeV1(
	sessionManager: SessionManager,
): TransientTaskForegroundSessionAppendBridgeV1 {
	return sessionManager.transientPersistence;
}

/** Coordinator-owned confidential pending-overlay store view. */
export function createTransientTaskForegroundPendingTtsrOverlayStoreV1(
	sessionManager: SessionManager,
): TransientTaskForegroundPendingTtsrOverlayStoreV1 {
	return sessionManager.transientPersistence;
}

/** Coordinator-owned before-return recovery view. */
export function createTransientTaskForegroundBeforeReturnRecoveryBridgeV1(
	sessionManager: SessionManager,
): TransientTaskForegroundBeforeReturnRecoveryBridgeV1 {
	return sessionManager.transientPersistence;
}

/**
 * If the current session was created by `/move` and contains no real
 * user/assistant messages, delete it so empty move sessions don't accumulate.
 */
export async function cleanupEmptyMoveSession(
	sessionManager: SessionManager,
	movedFromEmptySessionFile: string | undefined,
): Promise<void> {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !movedFromEmptySessionFile) return;
	if (path.resolve(sessionFile) !== path.resolve(movedFromEmptySessionFile)) return;
	const entries = sessionManager.getEntries();
	const hasRealMessages = entries.some(
		e => e.type === "message" && (e.message.role === "user" || e.message.role === "assistant"),
	);
	if (hasRealMessages) return;
	try {
		await sessionManager.dropSession(sessionFile);
	} catch (err) {
		logger.warn("Failed to clean up empty move session", { sessionFile, error: String(err) });
	}
}
