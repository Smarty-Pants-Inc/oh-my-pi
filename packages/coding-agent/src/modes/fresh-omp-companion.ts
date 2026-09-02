import * as crypto from "node:crypto";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionFactory,
	HostInternalSessionMutationEvent,
	TerminalInputHandler,
} from "../extensibility/extensions/types";
import { getLatestTodoPhasesFromEntries } from "../tools/todo";
import {
	boundedInteger,
	boundedLength,
	COMMAND_CAPTURE_CHARACTER_PATTERN,
	COMMAND_END,
	COMMAND_PREFIX,
	COMMAND_TIMEOUT_MS,
	type CompanionCommandTarget,
	type CompanionStateName,
	configuredThinkingLevel,
	EMIT_COALESCE_MS,
	encodeFrame,
	type GoalSummary,
	goalFromBranch,
	HEARTBEAT_MS,
	hasSettledFailure,
	hmac,
	isCanonicalUuid,
	MAX_COMMAND_CAPTURE_CHARS,
	MAX_FRAME_BYTES,
	MAX_PROCESS_ID,
	MAX_SAFE_INTEGER,
	normalizeString,
	type ParsedCompanionCommand,
	parseCommand,
	SAMPLE_INTERVAL_MS,
	SECRET_BYTES,
	type SemanticSnapshot,
	SYNC_BYTES,
	SYNC_DOMAIN,
	summarizeGoal,
	summarizeTodos,
	type TodoSummary,
	type ToolSummary,
	todosFromToolResult,
} from "./fresh-omp-companion-wire";

let processIncarnation: string | undefined;
let processSequence = 0;
const SNAPSHOT_ACK_TIMEOUT_MS = 5_000;
const SNAPSHOT_ACK_FAILURE = Symbol.for("oh-my-pi.fresh-omp.snapshot-ack-failure");

class FreshOmpSnapshotAcknowledgementError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FreshOmpSnapshotAcknowledgementError";
		Object.defineProperty(this, SNAPSHOT_ACK_FAILURE, { value: true });
	}
}

export interface FreshOmpCompanionController {
	factory: ExtensionFactory;
	beforeSessionMutation(event: HostInternalSessionMutationEvent, ctx: ExtensionContext): void | Promise<void>;
	afterDispatch(event: ExtensionEvent, ctx: ExtensionContext): void | Promise<void>;
	setHostTerminalInput(register: (handler: TerminalInputHandler) => () => void): void;
	setThinkingLevel(thinkingLevel: SemanticSnapshot["thinkingLevel"]): void;
	setStatusText(statusText?: string): void;
}

type ManagedTimerRef = {
	ctx: ExtensionContext;
	timer: Timer;
};

type PendingLifecycle = {
	kind: "session_ready" | "session_rollback" | "session_branch" | "session_tree";
	generation: number;
};

type PendingSnapshotAcknowledgement = CompanionCommandTarget & {
	sequence: number;
	promise: Promise<void>;
	resolve: (value: void | PromiseLike<void>) => void;
	reject: (reason?: unknown) => void;
	timer?: ManagedTimerRef;
};

type DisableReason =
	| "event_fault"
	| "parser_fault"
	| "sampling_fault"
	| "snapshot_oversize_after_reduction"
	| "sequence_overflow"
	| "stdout_write_failed"
	| "encoding_fault";

interface CompanionRuntime {
	disabled: boolean;
	quiesced: boolean;
	shutdown: boolean;
	generation: number;
	authoritativeSampled: boolean;
	workEpoch: number;
	lastCommandSequence: number;
	agentActive: boolean;
	continuationActive: boolean;
	retryActive: boolean;
	compacting: boolean;
	lastSettledFailed: boolean;
	thinkingLevel?: SemanticSnapshot["thinkingLevel"];
	thinkingLevelInitialized: boolean;
	context?: SemanticSnapshot["context"];
	contextInitialized: boolean;
	statusText?: string;
	toolOrder: number;
	runningTools: Map<string, ToolSummary>;
	pendingApprovals: Set<string>;
	goal?: GoalSummary;
	todos?: TodoSummary;
	pendingLifecycle?: PendingLifecycle;
	pendingSnapshotAcknowledgement?: PendingSnapshotAcknowledgement;
	inputUnsubscribe?: () => void;
	sampleTimer?: ManagedTimerRef;
	emitTimer?: ManagedTimerRef;
	heartbeatTimer?: ManagedTimerRef;
	commandTimer?: ManagedTimerRef;
	commandDeadline: number;
	abortTimer?: ManagedTimerRef;
	abortPromise?: Promise<void>;
	requestTimer?: ManagedTimerRef;
	pendingSnapshot?: SemanticSnapshot;
	pendingForce: boolean;
	blockedSnapshot?: SemanticSnapshot;
	blockedForce: boolean;
	stdoutBlocked: boolean;
	drainListener?: () => void;
	lastEmittedSemantic?: string;
	lastCommittedSnapshot?: SemanticSnapshot;
	lastEmissionAt: number;
	prefixMatch: string;
	commandMode: "scan" | "capture" | "discard";
	commandCapture: string;
	commandEndMatch: string;
	commandConsumeOnly: boolean;
}

type CommandControlMatch = {
	pending: string;
	invalidated: boolean;
	complete?: "end" | "prefix";
};

function advanceCommandControlMatch(current: string, character: string): CommandControlMatch {
	const candidate = current + character;
	if (candidate === COMMAND_END) return { pending: "", invalidated: false, complete: "end" };
	if (candidate === COMMAND_PREFIX) return { pending: "", invalidated: false, complete: "prefix" };
	if (COMMAND_END.startsWith(candidate) || COMMAND_PREFIX.startsWith(candidate)) {
		return { pending: candidate, invalidated: false };
	}
	for (let start = 1; start < candidate.length; start++) {
		const suffix = candidate.slice(start);
		if (COMMAND_END.startsWith(suffix) || COMMAND_PREFIX.startsWith(suffix)) {
			return { pending: suffix, invalidated: true };
		}
	}
	return { pending: "", invalidated: true };
}
export function createFreshOmpCompanionController(secret: Uint8Array): FreshOmpCompanionController {
	if (secret.byteLength !== SECRET_BYTES) {
		throw new TypeError("Fresh OMP companion secret must be exactly 32 bytes");
	}
	const capability = Uint8Array.from(secret);
	const sync = hmac(capability, SYNC_DOMAIN).subarray(0, SYNC_BYTES).toString("base64url");
	const incarnation = processIncarnation ?? crypto.randomUUID();
	processIncarnation = incarnation;

	const state: CompanionRuntime = {
		disabled: false,
		quiesced: false,
		shutdown: false,
		generation: 0,
		workEpoch: 0,
		lastCommandSequence: 0,
		authoritativeSampled: false,
		agentActive: false,
		continuationActive: false,
		retryActive: false,
		compacting: false,
		lastSettledFailed: false,
		thinkingLevelInitialized: false,
		contextInitialized: false,
		toolOrder: 0,
		runningTools: new Map(),
		pendingApprovals: new Set(),
		pendingForce: false,
		blockedForce: false,
		stdoutBlocked: false,
		lastEmissionAt: 0,
		prefixMatch: "",
		commandDeadline: 0,
		commandMode: "scan",
		commandCapture: "",
		commandEndMatch: "",
		commandConsumeOnly: false,
	};
	let api: ExtensionAPI | undefined;
	let registerHostTerminalInput: ((handler: TerminalInputHandler) => () => void) | undefined;
	let inputContext: ExtensionContext | undefined;

	const clearTimer = (ref: ManagedTimerRef | undefined): void => {
		if (!ref) return;
		try {
			ref.ctx.clearTimer(ref.timer);
		} catch {
			// Cleanup is deliberately best-effort.
		}
	};

	const rejectPendingSnapshotAcknowledgement = (message: string): void => {
		const pending = state.pendingSnapshotAcknowledgement;
		if (!pending) return;
		state.pendingSnapshotAcknowledgement = undefined;
		clearTimer(pending.timer);
		pending.timer = undefined;
		pending.reject(new FreshOmpSnapshotAcknowledgementError(message));
	};

	const clearDrain = (): void => {
		const listener = state.drainListener;
		state.drainListener = undefined;
		if (!listener) return;
		try {
			process.stdout.off("drain", listener);
		} catch {
			// Cleanup is deliberately best-effort.
		}
	};

	const unsubscribeInput = (): void => {
		const unsubscribe = state.inputUnsubscribe;
		inputContext = undefined;
		state.inputUnsubscribe = undefined;
		if (!unsubscribe) return;
		try {
			unsubscribe();
		} catch {
			// Cleanup is deliberately best-effort.
		}
	};

	const resetCommandScanner = (): void => {
		clearTimer(state.commandTimer);
		state.commandDeadline = 0;
		state.commandTimer = undefined;
		state.prefixMatch = "";
		state.commandMode = "scan";
		state.commandCapture = "";
		state.commandEndMatch = "";
		state.commandConsumeOnly = false;
	};

	const discardCommandCapture = (): void => {
		const wasScanning = state.commandMode === "scan";
		const pendingControl = wasScanning ? state.prefixMatch : state.commandEndMatch;
		clearTimer(state.commandTimer);
		state.commandDeadline = 0;
		state.commandTimer = undefined;
		state.prefixMatch = "";
		state.commandCapture = "";
		if (wasScanning && pendingControl === "") {
			state.commandMode = "scan";
			state.commandEndMatch = "";
			state.commandConsumeOnly = false;
			return;
		}
		state.commandMode = "discard";
		state.commandEndMatch = pendingControl;
		state.commandConsumeOnly ||= state.quiesced || state.disabled;
	};

	const cancelOutputScheduling = (): void => {
		clearTimer(state.sampleTimer);
		clearTimer(state.emitTimer);
		clearTimer(state.heartbeatTimer);
		clearTimer(state.abortTimer);
		clearTimer(state.requestTimer);
		state.sampleTimer = undefined;
		state.emitTimer = undefined;
		state.heartbeatTimer = undefined;
		state.abortTimer = undefined;
		state.requestTimer = undefined;
		state.pendingSnapshot = undefined;
		state.pendingForce = false;
		state.blockedSnapshot = undefined;
		state.blockedForce = false;
		state.stdoutBlocked = false;
		clearDrain();
	};

	const cancelScheduling = (): void => {
		cancelOutputScheduling();
		discardCommandCapture();
	};

	const clearAllScheduling = (): void => {
		cancelOutputScheduling();
		rejectPendingSnapshotAcknowledgement("Fresh snapshot acknowledgement was cancelled during shutdown");
		resetCommandScanner();
		unsubscribeInput();
	};

	const diagnostic = (reason: DisableReason, length: number, ctx?: ExtensionContext): void => {
		try {
			const sessionId = ctx?.sessionManager.getSessionId();
			api?.logger.warn("Fresh OMP companion disabled", {
				reason,
				length: Math.min(MAX_FRAME_BYTES, Math.max(0, Math.trunc(length))),
				session: typeof sessionId === "string" ? sessionId.slice(0, 8) : "unknown",
				incarnation: incarnation.slice(0, 8),
			});
		} catch {
			// Diagnostics cannot become a second failure path.
		}
	};

	const disable = (reason: DisableReason, length: number, ctx?: ExtensionContext): void => {
		if (state.disabled) return;
		state.disabled = true;
		rejectPendingSnapshotAcknowledgement("Fresh snapshot acknowledgement was cancelled after companion failure");
		cancelOutputScheduling();
		diagnostic(reason, length, ctx);
	};

	const clearTransientFacts = (): void => {
		state.authoritativeSampled = false;
		state.agentActive = false;
		state.continuationActive = false;
		state.retryActive = false;
		state.compacting = false;
		state.context = undefined;
		state.contextInitialized = false;
		state.statusText = undefined;
		state.toolOrder = 0;
		state.runningTools.clear();
		state.pendingApprovals.clear();
		state.goal = undefined;
		state.todos = undefined;
	};

	const bumpGeneration = (ctx: ExtensionContext): boolean => {
		if (state.generation >= MAX_SAFE_INTEGER) {
			disable("sequence_overflow", 0, ctx);
			return false;
		}
		rejectPendingSnapshotAcknowledgement("Fresh snapshot acknowledgement was superseded by a new session generation");
		state.generation++;
		state.workEpoch = 1;
		return true;
	};

	const beginWorkEpoch = (ctx: ExtensionContext): boolean => {
		if (
			state.agentActive ||
			state.continuationActive ||
			state.retryActive ||
			state.compacting ||
			state.runningTools.size > 0 ||
			state.pendingApprovals.size > 0
		)
			return true;
		if (state.workEpoch >= MAX_SAFE_INTEGER) {
			disable("sequence_overflow", 0, ctx);
			return false;
		}
		state.workEpoch++;
		return true;
	};

	const rebuildSessionSummaries = (ctx: ExtensionContext): void => {
		const branch = ctx.sessionManager.getBranch();
		state.goal = goalFromBranch(branch);
		state.todos = summarizeTodos(getLatestTodoPhasesFromEntries(branch));
		if (!state.thinkingLevelInitialized) {
			state.thinkingLevel = api ? configuredThinkingLevel(api, branch) : undefined;
			state.thinkingLevelInitialized = true;
		}
	};

	const refreshContextUsage = (ctx: ExtensionContext): void => {
		const usage = ctx.getContextUsage();
		const tokens = boundedInteger(usage?.tokens, MAX_SAFE_INTEGER);
		const contextWindow = boundedInteger(usage?.contextWindow, MAX_SAFE_INTEGER);
		const percentBps = boundedInteger(
			typeof usage?.percent === "number" ? Math.round(usage.percent * 100) : undefined,
			10_000,
		);
		state.context =
			tokens === undefined || contextWindow === undefined || percentBps === undefined
				? undefined
				: { tokens, contextWindow, percentBps };
		state.contextInitialized = true;
	};

	const derivedState = (ctx: ExtensionContext): CompanionStateName => {
		if (state.shutdown) return "stopped";
		if (state.pendingApprovals.size > 0) return "awaiting_approval";
		if (state.compacting) return "compacting";
		if (state.retryActive) return "retrying";
		if (state.agentActive || state.continuationActive || state.runningTools.size > 0 || !ctx.isIdle())
			return "working";
		if (state.lastSettledFailed) return "error";
		return "idle";
	};

	const buildSemanticSnapshot = (ctx: ExtensionContext): SemanticSnapshot | undefined => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!isCanonicalUuid(sessionId)) return undefined;
		const ompVersion = normalizeString(VERSION, 64, 128);
		const cwd = normalizeString(ctx.sessionManager.getCwd(), 512, 2_048);
		if (!ompVersion || !cwd || state.generation < 1 || state.generation > MAX_SAFE_INTEGER) return undefined;
		if (!Number.isInteger(process.pid) || process.pid < 1 || process.pid > MAX_PROCESS_ID) return undefined;

		const sessionName = normalizeString(ctx.sessionManager.getSessionName(), 160, 640);
		const modelProvider = normalizeString(ctx.model?.provider, 128, 256);
		const modelId = normalizeString(ctx.model?.id, 128, 256);
		const thinkingLevel = state.thinkingLevel;
		let currentTool: ToolSummary | undefined;
		for (const tool of state.runningTools.values()) {
			if (!currentTool || tool.order > currentTool.order) currentTool = tool;
		}
		const currentToolName = normalizeString(currentTool?.name, 80, 320);
		const currentToolIntent = normalizeString(currentTool?.intent, 160, 640);
		const statusText = normalizeString(state.statusText, 240, 960);
		const goalObjective = normalizeString(state.goal?.objective, 240, 960);
		const todoCurrent = normalizeString(state.todos?.current, 240, 960);
		const context = state.context;
		const jobs = ctx.getAsyncJobCounts();

		return {
			version: 1,
			incarnation,
			sessionGeneration: state.generation,
			workEpoch: state.workEpoch,
			ompVersion,
			processId: process.pid,
			sessionId,
			...(sessionName === undefined ? {} : { sessionName }),
			cwd,
			state: derivedState(ctx),
			...(statusText === undefined ? {} : { statusText }),
			...(modelProvider === undefined || modelId === undefined
				? {}
				: { model: { provider: modelProvider, id: modelId } }),
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			runningTools: boundedLength(state.runningTools.size),
			...(currentToolName === undefined
				? {}
				: {
						currentTool: {
							name: currentToolName,
							...(currentToolIntent === undefined ? {} : { intent: currentToolIntent }),
						},
					}),
			...(goalObjective === undefined || state.goal === undefined
				? {}
				: { goal: { objective: goalObjective, status: state.goal.status } }),
			...(state.todos === undefined
				? {}
				: {
						todos: {
							pending: state.todos.pending,
							inProgress: state.todos.inProgress,
							blocked: state.todos.blocked,
							completed: state.todos.completed,
							abandoned: state.todos.abandoned,
							...(todoCurrent === undefined ? {} : { current: todoCurrent }),
						},
					}),
			...(context === undefined ? {} : { context }),
			pendingApprovals: boundedLength(state.pendingApprovals.size),
			...(jobs === null
				? {}
				: {
						asyncJobs: {
							running: boundedLength(jobs.running),
							recentFailures: boundedLength(jobs.recentFailures),
							pendingDelivery: boundedLength(jobs.pendingDelivery),
						},
					}),
		};
	};

	const attachDrain = (ctx: ExtensionContext, generation: number): void => {
		if (state.drainListener) return;
		const listener = (): void => {
			if (state.drainListener !== listener) return;
			state.drainListener = undefined;
			state.stdoutBlocked = false;
			if (state.disabled || state.quiesced || state.shutdown || generation !== state.generation) {
				state.blockedSnapshot = undefined;
				state.blockedForce = false;
				return;
			}
			const snapshot = state.blockedSnapshot;
			const force = state.blockedForce;
			state.blockedSnapshot = undefined;
			state.blockedForce = false;
			if (snapshot) writeSnapshot(ctx, generation, snapshot, force, true);
		};
		state.drainListener = listener;
		try {
			process.stdout.once("drain", listener);
		} catch {
			state.drainListener = undefined;
			disable("stdout_write_failed", 0, ctx);
		}
	};
	const scheduleHeartbeat = (ctx: ExtensionContext, generation: number): void => {
		clearTimer(state.heartbeatTimer);
		state.heartbeatTimer = undefined;
		if (state.disabled || state.quiesced || state.shutdown || generation !== state.generation) return;
		try {
			const ref: ManagedTimerRef = {
				ctx,
				timer: ctx.setTimeout(() => {
					if (state.heartbeatTimer !== ref) return;
					state.heartbeatTimer = undefined;
					if (state.disabled || state.quiesced || state.shutdown || generation !== state.generation) return;
					sample(ctx, generation, true);
				}, HEARTBEAT_MS),
			};
			state.heartbeatTimer = ref;
		} catch {
			disable("sampling_fault", 0, ctx);
		}
	};

	const writeSnapshot = (
		ctx: ExtensionContext,
		generation: number,
		snapshot: SemanticSnapshot,
		force: boolean,
		allowDrain: boolean,
		allowQuiesced = false,
	): number | undefined => {
		if (state.disabled || (state.quiesced && !state.shutdown && !allowQuiesced) || generation !== state.generation)
			return undefined;
		if (state.stdoutBlocked && allowDrain) {
			state.blockedSnapshot = snapshot;
			state.blockedForce ||= force;
			return undefined;
		}
		try {
			const encoded = encodeFrame(capability, sync, snapshot, processSequence + 1);
			if (!encoded) {
				const reason =
					processSequence >= MAX_SAFE_INTEGER ? "sequence_overflow" : "snapshot_oversize_after_reduction";
				disable(reason, 0, ctx);
				return undefined;
			}
			if (!force && encoded.semantic === state.lastEmittedSemantic) return undefined;
			let writable: boolean;
			try {
				writable = process.stdout.write(encoded.frame);
			} catch {
				disable("stdout_write_failed", Math.min(MAX_FRAME_BYTES, encoded.frame.length), ctx);
				return undefined;
			}
			processSequence = encoded.sequence;
			state.lastEmittedSemantic = encoded.semantic;
			state.lastEmissionAt = Date.now();
			scheduleHeartbeat(ctx, generation);
			if (!writable && allowDrain) {
				state.stdoutBlocked = true;
				const laterSnapshot = state.pendingSnapshot;
				const laterForce = state.pendingForce;
				state.pendingSnapshot = undefined;
				state.pendingForce = false;
				clearTimer(state.emitTimer);
				state.emitTimer = undefined;
				if (laterSnapshot) {
					state.blockedSnapshot = laterSnapshot;
					state.blockedForce ||= laterForce;
				}
				attachDrain(ctx, generation);
			}
			return encoded.sequence;
		} catch {
			disable("encoding_fault", 0, ctx);
			return undefined;
		}
	};

	const flushPending = (ctx: ExtensionContext, generation: number): void => {
		if (state.disabled || state.quiesced || generation !== state.generation) return;
		state.emitTimer = undefined;
		const snapshot = state.pendingSnapshot;
		const force = state.pendingForce;
		state.pendingSnapshot = undefined;
		state.pendingForce = false;
		if (snapshot) writeSnapshot(ctx, generation, snapshot, force, true);
	};

	const queueSnapshot = (ctx: ExtensionContext, generation: number, force: boolean): void => {
		if (state.disabled || state.quiesced || generation !== state.generation) return;
		let snapshot: SemanticSnapshot | undefined;
		try {
			snapshot = buildSemanticSnapshot(ctx);
		} catch {
			disable("sampling_fault", 0, ctx);
			return;
		}
		if (!snapshot) return;
		state.lastCommittedSnapshot = snapshot;
		if (state.stdoutBlocked) {
			state.blockedSnapshot = snapshot;
			state.blockedForce ||= force;
			return;
		}
		state.pendingSnapshot = snapshot;
		state.pendingForce ||= force;
		if (state.emitTimer) return;
		const elapsed = Math.max(0, Date.now() - state.lastEmissionAt);
		const delay = state.lastEmissionAt === 0 ? 0 : Math.max(0, EMIT_COALESCE_MS - elapsed);
		try {
			const ref: ManagedTimerRef = {
				ctx,
				timer: ctx.setTimeout(() => {
					if (state.emitTimer !== ref) return;
					flushPending(ctx, generation);
				}, delay),
			};
			state.emitTimer = ref;
		} catch {
			disable("sampling_fault", 0, ctx);
		}
	};

	const sample = (ctx: ExtensionContext, generation: number, force = false): void => {
		if (state.disabled || state.quiesced || state.shutdown || generation !== state.generation) return;
		try {
			if (!state.contextInitialized) refreshContextUsage(ctx);
			state.compacting = ctx.isCompacting();
			if (ctx.isIdle()) state.agentActive = false;
			state.authoritativeSampled = true;
			queueSnapshot(ctx, generation, force);
		} catch {
			disable("sampling_fault", 0, ctx);
		}
	};

	const scheduleChangedSnapshot = (ctx: ExtensionContext): void => {
		if (state.quiesced || !state.authoritativeSampled) return;
		queueSnapshot(ctx, state.generation, false);
	};

	const startSampling = (ctx: ExtensionContext, generation: number): void => {
		clearTimer(state.sampleTimer);
		state.sampleTimer = undefined;
		if (state.disabled || state.quiesced || state.shutdown || generation !== state.generation) return;
		try {
			const ref: ManagedTimerRef = {
				ctx,
				timer: ctx.setInterval(() => {
					if (state.sampleTimer !== ref) return;
					sample(ctx, generation);
				}, SAMPLE_INTERVAL_MS),
			};
			state.sampleTimer = ref;
		} catch {
			disable("sampling_fault", 0, ctx);
		}
	};

	const scheduleAbort = (ctx: ExtensionContext, generation: number, workEpoch: number): void => {
		if (state.abortPromise || state.disabled || state.quiesced || generation !== state.generation) return;
		clearTimer(state.abortTimer);
		state.abortTimer = undefined;
		try {
			const ref: ManagedTimerRef = {
				ctx,
				timer: ctx.setTimeout(() => {
					if (state.abortTimer !== ref) return;
					state.abortTimer = undefined;
					if (
						state.disabled ||
						state.quiesced ||
						state.shutdown ||
						generation !== state.generation ||
						workEpoch !== state.workEpoch
					)
						return;
					let abortResult: void | Promise<void>;
					try {
						abortResult = ctx.abort();
					} catch {
						disable("event_fault", 0, ctx);
						return;
					}
					const abortPromise = Promise.resolve(abortResult);
					state.abortPromise = abortPromise;
					void abortPromise
						.catch(() => {
							if (
								!state.disabled &&
								!state.shutdown &&
								generation === state.generation &&
								workEpoch === state.workEpoch
							) {
								disable("event_fault", 0, ctx);
							}
						})
						.finally(() => {
							if (state.abortPromise === abortPromise) state.abortPromise = undefined;
						});
				}, 0),
			};
			state.abortTimer = ref;
		} catch {
			disable("event_fault", 0, ctx);
		}
	};

	const scheduleRequestedSnapshot = (ctx: ExtensionContext, generation: number): void => {
		if (state.requestTimer || state.disabled || state.quiesced || generation !== state.generation) return;
		try {
			const ref: ManagedTimerRef = {
				ctx,
				timer: ctx.setTimeout(() => {
					if (state.requestTimer !== ref) return;
					state.requestTimer = undefined;
					if (state.disabled || state.quiesced || state.shutdown || generation !== state.generation) return;
					sample(ctx, generation, true);
				}, 0),
			};
			state.requestTimer = ref;
		} catch {
			disable("event_fault", 0, ctx);
		}
	};

	const armCommandTimeout = (ctx: ExtensionContext, generation: number): void => {
		clearTimer(state.commandTimer);
		state.commandTimer = undefined;
		state.commandDeadline = Date.now() + COMMAND_TIMEOUT_MS;
		try {
			const ref: ManagedTimerRef = {
				ctx,
				timer: ctx.setTimeout(() => {
					if (state.commandTimer !== ref) return;
					state.commandTimer = undefined;
					if (generation !== state.generation) return;
					discardCommandCapture();
				}, COMMAND_TIMEOUT_MS),
			};
			state.commandTimer = ref;
		} catch {
			disable("parser_fault", 0, ctx);
		}
	};

	const beginCommandCapture = (ctx: ExtensionContext, generation: number): void => {
		state.prefixMatch = "";
		state.commandMode = "capture";
		state.commandCapture = "";
		state.commandEndMatch = "";
		state.commandConsumeOnly ||= state.quiesced || state.disabled;
		armCommandTimeout(ctx, generation);
	};

	const settleSnapshotAcknowledgement = (command: Extract<ParsedCompanionCommand, { type: "snapshot_ack" }>): void => {
		const pending = state.pendingSnapshotAcknowledgement;
		if (
			!pending ||
			command.incarnation !== pending.incarnation ||
			command.sequence !== pending.sequence ||
			command.sessionGeneration !== pending.sessionGeneration ||
			command.sessionId !== pending.sessionId ||
			command.workEpoch !== pending.workEpoch
		)
			return;
		if (!command.accepted) {
			rejectPendingSnapshotAcknowledgement("Fresh rejected the durable snapshot acknowledgement");
			return;
		}
		state.pendingSnapshotAcknowledgement = undefined;
		clearTimer(pending.timer);
		pending.timer = undefined;
		pending.resolve(undefined);
	};

	const completeCommand = (ctx: ExtensionContext, generation: number): void => {
		clearTimer(state.commandTimer);
		state.commandTimer = undefined;
		state.commandDeadline = 0;
		const capture = state.commandCapture;
		const discard = state.commandMode === "discard";
		const consumeOnly = state.commandConsumeOnly;
		state.prefixMatch = "";
		state.commandMode = "scan";
		state.commandConsumeOnly = false;
		state.commandCapture = "";
		state.commandEndMatch = "";
		if (discard || state.disabled) return;
		const command = parseCommand(
			capability,
			capture,
			{
				incarnation,
				sessionGeneration: state.generation,
				sessionId: ctx.sessionManager.getSessionId(),
				workEpoch: state.workEpoch,
			},
			state.lastCommandSequence,
		);
		if (!command) return;
		state.lastCommandSequence = command.commandSequence;
		if (command.type === "snapshot_ack") {
			settleSnapshotAcknowledgement(command);
			return;
		}
		if (consumeOnly || state.quiesced) return;
		if (command.type === "cancel") scheduleAbort(ctx, generation, state.workEpoch);
		else scheduleRequestedSnapshot(ctx, generation);
	};

	const feedTerminalInput = (ctx: ExtensionContext, generation: number, data: string): { data: string } => {
		if (state.commandMode === "capture" && Date.now() >= state.commandDeadline) discardCommandCapture();
		if (state.commandMode === "scan" && state.prefixMatch === "" && !data.includes(COMMAND_PREFIX[0] ?? "")) {
			return { data };
		}
		let output = "";
		let index = 0;
		let processingPrivateCandidate = false;
		let outputLengthBeforeCharacter = 0;
		try {
			for (; index < data.length; index++) {
				processingPrivateCandidate = state.commandMode !== "scan" || state.prefixMatch !== "";
				outputLengthBeforeCharacter = output.length;
				const character = data[index] ?? "";
				if (state.commandMode === "scan") {
					if (state.prefixMatch === "" && character === (COMMAND_PREFIX[0] ?? "")) {
						state.commandConsumeOnly = state.quiesced || state.disabled;
					}
					state.prefixMatch += character;
					while (state.prefixMatch && !COMMAND_PREFIX.startsWith(state.prefixMatch)) {
						output += state.prefixMatch[0];
						state.prefixMatch = state.prefixMatch.slice(1);
					}
					if (!state.prefixMatch) state.commandConsumeOnly = false;
					if (state.prefixMatch === COMMAND_PREFIX) beginCommandCapture(ctx, generation);
					continue;
				}

				if (
					state.commandMode === "capture" &&
					state.commandEndMatch === "" &&
					COMMAND_CAPTURE_CHARACTER_PATTERN.test(character)
				) {
					if (state.commandCapture.length >= MAX_COMMAND_CAPTURE_CHARS) discardCommandCapture();
					else state.commandCapture += character;
					continue;
				}

				const control = advanceCommandControlMatch(state.commandEndMatch, character);
				state.commandEndMatch = control.pending;
				if (control.complete === "end") {
					completeCommand(ctx, generation);
					continue;
				}
				if (control.complete === "prefix") {
					beginCommandCapture(ctx, generation);
					continue;
				}
				if (state.commandMode === "capture" && control.invalidated) discardCommandCapture();
			}
			return { data: output };
		} catch {
			const currentIsPrivate =
				processingPrivateCandidate || state.commandMode !== "scan" || state.prefixMatch !== "";
			const currentWasEmitted = output.length > outputLengthBeforeCharacter;
			const untouchedTail = data.slice(currentIsPrivate || currentWasEmitted ? index + 1 : index);
			discardCommandCapture();
			disable("parser_fault", Buffer.byteLength(data, "utf8"), ctx);
			if (!untouchedTail) return { data: output };
			return { data: output + feedTerminalInput(ctx, generation, untouchedTail).data };
		}
	};

	const installInput = (ctx: ExtensionContext): void => {
		inputContext = ctx;
		if (state.inputUnsubscribe) return;
		resetCommandScanner();
		const register = registerHostTerminalInput;
		if (!register) return;
		try {
			state.inputUnsubscribe = register(data => {
				const currentContext = inputContext;
				if (state.shutdown || !currentContext) return undefined;
				return feedTerminalInput(currentContext, state.generation, data);
			});
		} catch {
			inputContext = undefined;
			disable("parser_fault", 0, ctx);
		}
	};

	const beginSession = (ctx: ExtensionContext): boolean => {
		cancelScheduling();
		clearTransientFacts();
		state.lastCommittedSnapshot = undefined;
		if (!bumpGeneration(ctx)) return false;
		state.quiesced = true;
		installInput(ctx);
		return !state.disabled;
	};

	const activateMaterializedSession = (ctx: ExtensionContext, generation: number): void => {
		if (state.disabled || generation !== state.generation) return;
		rebuildSessionSummaries(ctx);
		state.quiesced = false;
		startSampling(ctx, generation);
		sample(ctx, generation, true);
		clearTimer(state.emitTimer);
		state.emitTimer = undefined;
		flushPending(ctx, generation);
	};

	const beginSwitch = (ctx: ExtensionContext): void => {
		state.quiesced = true;
		cancelScheduling();
		clearTransientFacts();
		state.pendingLifecycle = undefined;
		void bumpGeneration(ctx);
	};

	const fenceLifecycle = (ctx: ExtensionContext): void => {
		try {
			beginSwitch(ctx);
		} catch {
			state.quiesced = true;
			cancelScheduling();
			state.pendingLifecycle = undefined;
			disable("event_fault", 0, ctx);
		}
	};

	const waitForSnapshotAcknowledgement = (
		ctx: ExtensionContext,
		target: CompanionCommandTarget & { sequence: number },
	): Promise<void> => {
		rejectPendingSnapshotAcknowledgement("Fresh snapshot acknowledgement was superseded by a newer publication");
		const deferred = Promise.withResolvers<void>();
		const pending: PendingSnapshotAcknowledgement = { ...target, ...deferred };
		state.pendingSnapshotAcknowledgement = pending;
		try {
			const timer = ctx.setTimeout(() => {
				if (state.pendingSnapshotAcknowledgement !== pending) return;
				rejectPendingSnapshotAcknowledgement("Fresh snapshot acknowledgement timed out");
			}, SNAPSHOT_ACK_TIMEOUT_MS);
			pending.timer = { ctx, timer };
		} catch {
			rejectPendingSnapshotAcknowledgement("Fresh snapshot acknowledgement timeout could not be armed");
		}
		return pending.promise;
	};

	const publishLifecycleSnapshot = (
		ctx: ExtensionContext,
		generation: number,
	): { snapshot: SemanticSnapshot; sequence: number } => {
		state.compacting = ctx.isCompacting();
		const snapshot = buildSemanticSnapshot(ctx);
		if (!snapshot) throw new FreshOmpSnapshotAcknowledgementError("Fresh lifecycle snapshot could not be built");
		const sequence = writeSnapshot(ctx, generation, snapshot, true, true, true);
		if (sequence === undefined) {
			throw new FreshOmpSnapshotAcknowledgementError("Fresh lifecycle snapshot could not be published");
		}
		return { snapshot, sequence };
	};

	const completeLifecycle = async (kind: PendingLifecycle["kind"], ctx: ExtensionContext): Promise<void> => {
		const pending = state.pendingLifecycle;
		if (!pending || pending.kind !== kind || pending.generation !== state.generation || state.disabled) return;
		state.pendingLifecycle = undefined;
		const generation = state.generation;
		try {
			cancelScheduling();
			clearTransientFacts();
			rebuildSessionSummaries(ctx);
			refreshContextUsage(ctx);
			installInput(ctx);
			const { snapshot, sequence } = publishLifecycleSnapshot(ctx, generation);
			await waitForSnapshotAcknowledgement(ctx, {
				incarnation: snapshot.incarnation,
				sequence,
				sessionGeneration: snapshot.sessionGeneration,
				sessionId: snapshot.sessionId,
				workEpoch: snapshot.workEpoch,
			});
			if (state.disabled || state.shutdown || generation !== state.generation) {
				throw new FreshOmpSnapshotAcknowledgementError(
					"Fresh snapshot acknowledgement was superseded before lifecycle activation",
				);
			}
			state.lastCommittedSnapshot = snapshot;
			state.authoritativeSampled = true;
			state.quiesced = false;
			startSampling(ctx, generation);
		} catch (error) {
			state.quiesced = true;
			if (error instanceof FreshOmpSnapshotAcknowledgementError) throw error;
			disable("event_fault", 0, ctx);
			throw new FreshOmpSnapshotAcknowledgementError("Fresh lifecycle snapshot publication failed");
		}
	};

	const guarded = (ctx: ExtensionContext, operation: () => void): void => {
		if (state.disabled) return;
		try {
			operation();
		} catch {
			disable("event_fault", 0, ctx);
		}
	};

	const guardedAsync = async (
		ctx: ExtensionContext,
		isCurrent: () => boolean,
		operation: () => Promise<void>,
	): Promise<void> => {
		if (state.disabled || !isCurrent()) return;
		try {
			await operation();
		} catch {
			// A lifecycle await belongs to the generation that started it. Its late
			// rejection must not disable a replacement that has already taken over.
			if (state.disabled || !isCurrent()) return;
			disable("event_fault", 0, ctx);
		}
	};

	const factory: ExtensionFactory = pi => {
		api = pi;
		pi.on("session_start", (_event, ctx) => {
			let generation = state.generation;
			return guardedAsync(
				ctx,
				() => generation === state.generation,
				async () => {
					if (!beginSession(ctx)) return;
					generation = state.generation;
					await ctx.sessionManager.ensureOnDisk();
					activateMaterializedSession(ctx, generation);
				},
			);
		});
		pi.on("session_ready", (_event, ctx) =>
			guarded(ctx, () => {
				state.pendingLifecycle = { kind: "session_ready", generation: state.generation };
			}),
		);
		pi.on("session_rollback", (_event, ctx) =>
			guarded(ctx, () => {
				state.pendingLifecycle = { kind: "session_rollback", generation: state.generation };
			}),
		);
		pi.on("session_branch", (_event, ctx) =>
			guarded(ctx, () => {
				state.pendingLifecycle = { kind: "session_branch", generation: state.generation };
			}),
		);
		pi.on("session_tree", (_event, ctx) =>
			guarded(ctx, () => {
				state.pendingLifecycle = { kind: "session_tree", generation: state.generation };
			}),
		);
		pi.on("session_shutdown", (_event, ctx) => {
			if (state.disabled) {
				state.shutdown = true;
				state.quiesced = true;
				clearAllScheduling();
				state.pendingLifecycle = undefined;
				return;
			}
			guarded(ctx, () => {
				state.shutdown = true;
				state.quiesced = true;
				clearAllScheduling();
				state.pendingLifecycle = undefined;
				state.statusText = undefined;
				const committed = state.lastCommittedSnapshot;
				if (committed) {
					const { statusText: _statusText, currentTool: _currentTool, ...snapshot } = committed;
					writeSnapshot(
						ctx,
						state.generation,
						{ ...snapshot, state: "stopped", runningTools: 0, pendingApprovals: 0 },
						true,
						false,
					);
				}
				state.disabled = true;
			});
		});
		pi.on("agent_start", (_event, ctx) =>
			guarded(ctx, () => {
				if (!beginWorkEpoch(ctx)) return;
				state.agentActive = true;
				state.continuationActive = false;
				state.lastSettledFailed = false;
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("agent_end", (event, ctx) =>
			guarded(ctx, () => {
				state.agentActive = false;
				state.continuationActive = event.willContinue === true;
				if (!event.willContinue) state.lastSettledFailed = hasSettledFailure(event.messages);
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("message_end", (_event, ctx) =>
			guarded(ctx, () => {
				refreshContextUsage(ctx);
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("tool_execution_start", (event, ctx) =>
			guarded(ctx, () => {
				if (!beginWorkEpoch(ctx)) return;
				state.toolOrder++;
				state.runningTools.set(event.toolCallId, {
					name: event.toolName,
					...(event.intent === undefined ? {} : { intent: event.intent }),
					order: state.toolOrder,
				});
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("tool_execution_end", (event, ctx) =>
			guarded(ctx, () => {
				state.runningTools.delete(event.toolCallId);
				if (event.toolName === "todo" && !event.isError) {
					const todos = todosFromToolResult(event.result);
					if (todos === null) delete state.todos;
					else if (todos !== undefined) state.todos = todos;
				}
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("tool_approval_requested", (event, ctx) =>
			guarded(ctx, () => {
				if (!beginWorkEpoch(ctx)) return;
				state.pendingApprovals.add(`${event.sessionId}\0${event.toolCallId}`);
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("tool_approval_resolved", (event, ctx) =>
			guarded(ctx, () => {
				state.pendingApprovals.delete(`${event.sessionId}\0${event.toolCallId}`);
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("auto_retry_start", (_event, ctx) =>
			guarded(ctx, () => {
				if (!beginWorkEpoch(ctx)) return;
				state.retryActive = true;
				state.lastSettledFailed = false;
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("auto_retry_end", (event, ctx) =>
			guarded(ctx, () => {
				state.retryActive = false;
				state.continuationActive = false;
				state.lastSettledFailed = !event.success && event.finalError !== "Retry cancelled";
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("session.compacting", (_event, ctx) =>
			guarded(ctx, () => {
				if (!beginWorkEpoch(ctx)) return;
				state.compacting = true;
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("session_compact", (_event, ctx) =>
			guarded(ctx, () => {
				state.compacting = false;
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("auto_compaction_start", (_event, ctx) =>
			guarded(ctx, () => {
				if (!beginWorkEpoch(ctx)) return;
				state.compacting = true;
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("auto_compaction_end", (_event, ctx) =>
			guarded(ctx, () => {
				state.compacting = false;
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("goal_updated", (event, ctx) =>
			guarded(ctx, () => {
				state.goal = summarizeGoal(event.goal);
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("todo_reminder", (_event, ctx) =>
			guarded(ctx, () => {
				const branch = ctx.sessionManager.getBranch();
				state.todos = summarizeTodos(getLatestTodoPhasesFromEntries(branch));
				scheduleChangedSnapshot(ctx);
			}),
		);
	};

	return {
		factory,
		beforeSessionMutation(_event, ctx): void {
			fenceLifecycle(ctx);
		},
		afterDispatch(event, ctx): void | Promise<void> {
			switch (event.type) {
				case "session_ready":
					return completeLifecycle("session_ready", ctx);
				case "session_rollback":
					return completeLifecycle("session_rollback", ctx);
				case "session_branch":
					return completeLifecycle("session_branch", ctx);
				case "session_tree":
					return completeLifecycle("session_tree", ctx);
			}
		},
		setHostTerminalInput(register): void {
			registerHostTerminalInput = register;
			if (inputContext && !state.shutdown) installInput(inputContext);
		},
		setThinkingLevel(thinkingLevel): void {
			if (state.disabled || state.shutdown) return;
			state.thinkingLevel = thinkingLevel;
			state.thinkingLevelInitialized = true;
			if (inputContext) scheduleChangedSnapshot(inputContext);
		},
		setStatusText(statusText): void {
			if (state.disabled || state.shutdown) return;
			state.statusText = normalizeString(statusText, 240, 960);
			if (inputContext) scheduleChangedSnapshot(inputContext);
		},
	};
}
