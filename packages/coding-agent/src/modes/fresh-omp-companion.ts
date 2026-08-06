import * as crypto from "node:crypto";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionFactory,
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
	isCanonicalUuidV4,
	MAX_COMMAND_CAPTURE_CHARS,
	MAX_FRAME_BYTES,
	MAX_PROCESS_ID,
	MAX_SAFE_INTEGER,
	normalizeString,
	parseCommand,
	SAMPLE_INTERVAL_MS,
	SECRET_BYTES,
	type SemanticSnapshot,
	SYNC_B64_LENGTH,
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

export interface FreshOmpCompanionController {
	factory: ExtensionFactory;
	beforeSessionMutation(
		event: { type: "session_branch" | "session_tree" },
		ctx: ExtensionContext,
	): void | Promise<void>;
	afterDispatch(event: ExtensionEvent, ctx: ExtensionContext): void | Promise<void>;
	setHostTerminalInput(register: (handler: TerminalInputHandler) => () => void): void;
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
	agentActive: boolean;
	continuationActive: boolean;
	retryActive: boolean;
	compacting: boolean;
	lastSettledFailed: boolean;
	statusText?: string;
	toolOrder: number;
	runningTools: Map<string, ToolSummary>;
	pendingApprovals: Set<string>;
	goal?: GoalSummary;
	todos?: TodoSummary;
	pendingLifecycle?: PendingLifecycle;
	inputUnsubscribe?: () => void;
	sampleTimer?: ManagedTimerRef;
	emitTimer?: ManagedTimerRef;
	heartbeatTimer?: ManagedTimerRef;
	commandTimer?: ManagedTimerRef;
	commandDeadline: number;
	abortTimer?: ManagedTimerRef;
	requestTimer?: ManagedTimerRef;
	pendingSnapshot?: SemanticSnapshot;
	pendingForce: boolean;
	blockedSnapshot?: SemanticSnapshot;
	blockedForce: boolean;
	stdoutBlocked: boolean;
	drainListener?: () => void;
	lastEmittedSemantic?: string;
	lastEmissionAt: number;
	prefixMatch: string;
	commandMode: "scan" | "capture" | "discard";
	commandCapture: string;
	commandEndMatch: string;
	commandConsumeOnly: boolean;
}
export function createFreshOmpCompanionController(secret: Uint8Array): FreshOmpCompanionController {
	if (secret.byteLength !== SECRET_BYTES) {
		throw new TypeError("Fresh OMP companion secret must be exactly 32 bytes");
	}
	const capability = Uint8Array.from(secret);
	const sync = hmac(capability, SYNC_DOMAIN).subarray(0, SYNC_BYTES).toString("base64url");
	const incarnation = processIncarnation ?? crypto.randomUUID();
	if (sync.length !== SYNC_B64_LENGTH || !isCanonicalUuidV4(incarnation)) {
		throw new Error("Fresh OMP companion initialization failed");
	}
	processIncarnation = incarnation;

	const state: CompanionRuntime = {
		disabled: false,
		quiesced: false,
		shutdown: false,
		generation: 0,
		authoritativeSampled: false,
		agentActive: false,
		continuationActive: false,
		retryActive: false,
		compacting: false,
		lastSettledFailed: false,
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

	const cancelCommandCapture = (): void => {
		clearTimer(state.commandTimer);
		state.commandDeadline = 0;
		state.commandTimer = undefined;
		state.prefixMatch = "";
		state.commandMode = "scan";
		state.commandCapture = "";
		state.commandEndMatch = "";
		state.commandConsumeOnly = false;
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
		cancelCommandCapture();
	};

	const clearAllScheduling = (): void => {
		cancelScheduling();
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
		cancelOutputScheduling();
		diagnostic(reason, length, ctx);
	};

	const clearTransientFacts = (): void => {
		state.authoritativeSampled = false;
		state.agentActive = false;
		state.continuationActive = false;
		state.retryActive = false;
		state.compacting = false;
		state.lastSettledFailed = false;
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
		state.generation++;
		return true;
	};

	const rebuildSessionSummaries = (ctx: ExtensionContext): void => {
		const branch = ctx.sessionManager.getBranch();
		state.goal = goalFromBranch(branch);
		state.todos = summarizeTodos(getLatestTodoPhasesFromEntries(branch));
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
		const branch = ctx.sessionManager.getBranch();
		const thinkingLevel = api ? configuredThinkingLevel(api, branch) : undefined;
		let currentTool: ToolSummary | undefined;
		for (const tool of state.runningTools.values()) {
			if (!currentTool || tool.order > currentTool.order) currentTool = tool;
		}
		const currentToolName = normalizeString(currentTool?.name, 80, 320);
		const currentToolIntent = normalizeString(currentTool?.intent, 160, 640);
		const statusText = normalizeString(state.statusText, 240, 960);
		const goalObjective = normalizeString(state.goal?.objective, 240, 960);
		const todoCurrent = normalizeString(state.todos?.current, 240, 960);
		const usage = ctx.getContextUsage();
		const tokens = boundedInteger(usage?.tokens, MAX_SAFE_INTEGER);
		const contextWindow = boundedInteger(usage?.contextWindow, MAX_SAFE_INTEGER);
		const percentBps = boundedInteger(
			typeof usage?.percent === "number" ? Math.round(usage.percent * 100) : undefined,
			10_000,
		);
		const jobs = ctx.getAsyncJobSnapshot();
		let recentFailures = 0;
		if (jobs) {
			const recentCount = Math.min(5, jobs.recent.length);
			for (let index = 0; index < recentCount; index++) {
				if (jobs.recent[index]?.status === "failed") recentFailures++;
			}
		}

		return {
			version: 1,
			incarnation,
			sessionGeneration: state.generation,
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
			...(tokens === undefined || contextWindow === undefined || percentBps === undefined
				? {}
				: { context: { tokens, contextWindow, percentBps } }),
			pendingApprovals: boundedLength(state.pendingApprovals.size),
			...(jobs === null
				? {}
				: {
						asyncJobs: {
							running: boundedLength(jobs.running.length),
							recentFailures: boundedLength(recentFailures),
							pendingDelivery: boundedLength(jobs.delivery.queued),
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
			let ref: ManagedTimerRef | undefined;
			const timer = ctx.setTimeout(() => {
				if (state.heartbeatTimer !== ref) return;
				state.heartbeatTimer = undefined;
				if (state.disabled || state.quiesced || state.shutdown || generation !== state.generation) return;
				sample(ctx, generation, true);
			}, HEARTBEAT_MS);
			ref = { ctx, timer };
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
	): void => {
		if (state.disabled || (state.quiesced && !state.shutdown) || generation !== state.generation) return;
		if (state.stdoutBlocked && allowDrain) {
			state.blockedSnapshot = snapshot;
			state.blockedForce ||= force;
			return;
		}
		try {
			const encoded = encodeFrame(capability, sync, snapshot, processSequence + 1);
			if (!encoded) {
				const reason =
					processSequence >= MAX_SAFE_INTEGER ? "sequence_overflow" : "snapshot_oversize_after_reduction";
				disable(reason, 0, ctx);
				return;
			}
			if (!force && encoded.semantic === state.lastEmittedSemantic) return;
			let writable: boolean;
			try {
				writable = process.stdout.write(encoded.frame);
			} catch {
				disable("stdout_write_failed", Math.min(MAX_FRAME_BYTES, encoded.frame.length), ctx);
				return;
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
		} catch {
			disable("encoding_fault", 0, ctx);
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
			let ref: ManagedTimerRef | undefined;
			const timer = ctx.setTimeout(() => {
				if (state.emitTimer !== ref) return;
				flushPending(ctx, generation);
			}, delay);
			ref = { ctx, timer };
			state.emitTimer = ref;
		} catch {
			disable("sampling_fault", 0, ctx);
		}
	};

	const sample = (ctx: ExtensionContext, generation: number, force = false): void => {
		if (state.disabled || state.quiesced || state.shutdown || generation !== state.generation) return;
		try {
			state.compacting = ctx.isCompacting();
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
			let ref: ManagedTimerRef | undefined;
			const timer = ctx.setInterval(() => {
				if (state.sampleTimer !== ref) return;
				sample(ctx, generation);
			}, SAMPLE_INTERVAL_MS);
			ref = { ctx, timer };
			state.sampleTimer = ref;
		} catch {
			disable("sampling_fault", 0, ctx);
		}
	};

	const scheduleAbort = (ctx: ExtensionContext, generation: number): void => {
		if (state.abortTimer || state.disabled || state.quiesced || generation !== state.generation) return;
		try {
			let ref: ManagedTimerRef | undefined;
			const timer = ctx.setTimeout(() => {
				if (state.abortTimer !== ref) return;
				state.abortTimer = undefined;
				if (state.disabled || state.quiesced || state.shutdown || generation !== state.generation) return;
				try {
					ctx.abort();
				} catch {
					disable("event_fault", 0, ctx);
				}
			}, 0);
			ref = { ctx, timer };
			state.abortTimer = ref;
		} catch {
			disable("event_fault", 0, ctx);
		}
	};

	const scheduleRequestedSnapshot = (ctx: ExtensionContext, generation: number): void => {
		if (state.requestTimer || state.disabled || state.quiesced || generation !== state.generation) return;
		try {
			let ref: ManagedTimerRef | undefined;
			const timer = ctx.setTimeout(() => {
				if (state.requestTimer !== ref) return;
				state.requestTimer = undefined;
				if (state.disabled || state.quiesced || state.shutdown || generation !== state.generation) return;
				sample(ctx, generation, true);
			}, 0);
			ref = { ctx, timer };
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
			let ref: ManagedTimerRef | undefined;
			const timer = ctx.setTimeout(() => {
				if (state.commandTimer !== ref) return;
				state.commandTimer = undefined;
				if (generation !== state.generation) return;
				cancelCommandCapture();
			}, COMMAND_TIMEOUT_MS);
			ref = { ctx, timer };
			state.commandTimer = ref;
		} catch {
			disable("parser_fault", 0, ctx);
		}
	};

	const completeCommand = (ctx: ExtensionContext, generation: number): void => {
		clearTimer(state.commandTimer);
		state.commandTimer = undefined;
		state.commandDeadline = 0;
		const capture = state.commandCapture;
		const discard = state.commandMode === "discard";
		const consumeOnly = state.commandConsumeOnly;
		state.commandMode = "scan";
		state.commandConsumeOnly = false;
		state.commandCapture = "";
		state.commandEndMatch = "";
		if (discard || consumeOnly || state.disabled || state.quiesced) return;
		const command = parseCommand(capability, capture);
		if (command === "cancel") scheduleAbort(ctx, generation);
		else if (command === "request_snapshot") scheduleRequestedSnapshot(ctx, generation);
	};

	const appendCapturedCharacter = (character: string): void => {
		if (state.commandMode === "discard") return;
		if (!COMMAND_CAPTURE_CHARACTER_PATTERN.test(character)) {
			state.commandMode = "discard";
			state.commandCapture = "";
			return;
		}
		if (state.commandCapture.length >= MAX_COMMAND_CAPTURE_CHARS) {
			state.commandMode = "discard";
			state.commandCapture = "";
			return;
		}
		state.commandCapture += character;
	};

	const feedTerminalInput = (ctx: ExtensionContext, generation: number, data: string): { data: string } => {
		if (state.commandMode !== "scan" && Date.now() >= state.commandDeadline) cancelCommandCapture();
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
					if (state.prefixMatch === COMMAND_PREFIX) {
						state.prefixMatch = "";
						state.commandMode = "capture";
						state.commandConsumeOnly ||= state.quiesced || state.disabled;
						state.commandCapture = "";
						state.commandEndMatch = "";
						armCommandTimeout(ctx, generation);
					}
					continue;
				}

				state.commandEndMatch += character;
				while (state.commandEndMatch && !COMMAND_END.startsWith(state.commandEndMatch)) {
					appendCapturedCharacter(state.commandEndMatch[0] ?? "");
					state.commandEndMatch = state.commandEndMatch.slice(1);
				}
				if (state.commandEndMatch === COMMAND_END) completeCommand(ctx, generation);
			}
			return { data: output };
		} catch {
			const currentIsPrivate =
				processingPrivateCandidate || state.commandMode !== "scan" || state.prefixMatch !== "";
			const currentWasEmitted = output.length > outputLengthBeforeCharacter;
			const untouchedTail = data.slice(currentIsPrivate || currentWasEmitted ? index + 1 : index);
			cancelCommandCapture();
			disable("parser_fault", Buffer.byteLength(data, "utf8"), ctx);
			if (!untouchedTail) return { data: output };
			return { data: output + feedTerminalInput(ctx, generation, untouchedTail).data };
		}
	};

	const installInput = (ctx: ExtensionContext): void => {
		inputContext = ctx;
		cancelCommandCapture();
		if (state.inputUnsubscribe) return;
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

	const publishLifecycleSnapshot = (ctx: ExtensionContext, generation: number): void => {
		try {
			state.compacting = ctx.isCompacting();
			state.authoritativeSampled = true;
			const snapshot = buildSemanticSnapshot(ctx);
			if (snapshot) writeSnapshot(ctx, generation, snapshot, true, true);
		} catch {
			disable("event_fault", 0, ctx);
		}
	};

	const completeLifecycle = (kind: PendingLifecycle["kind"], ctx: ExtensionContext): void => {
		const pending = state.pendingLifecycle;
		if (!pending || pending.kind !== kind || pending.generation !== state.generation || state.disabled) return;
		state.pendingLifecycle = undefined;
		cancelScheduling();
		clearTransientFacts();
		rebuildSessionSummaries(ctx);
		state.quiesced = false;
		installInput(ctx);
		startSampling(ctx, state.generation);
		publishLifecycleSnapshot(ctx, state.generation);
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
		pi.on("session_switch", (_event, ctx) => {
			fenceLifecycle(ctx);
		});
		pi.on("session_ready", (_event, ctx) => {
			const generation = state.generation;
			return guardedAsync(
				ctx,
				() => generation === state.generation,
				async () => {
					// Resume/reload readiness is not an owner-created replacement, so keep
					// this generic materialization guard in addition to owner-side creation.
					await ctx.sessionManager.ensureOnDisk();
					if (state.disabled || generation !== state.generation) return;
					state.pendingLifecycle = { kind: "session_ready", generation };
				},
			);
		});
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
				const snapshot = buildSemanticSnapshot(ctx);
				if (snapshot) writeSnapshot(ctx, state.generation, snapshot, true, false);
				state.disabled = true;
			});
		});
		pi.on("agent_start", (_event, ctx) =>
			guarded(ctx, () => {
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
		pi.on("tool_execution_start", (event, ctx) =>
			guarded(ctx, () => {
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
				state.retryActive = true;
				state.lastSettledFailed = false;
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("auto_retry_end", (event, ctx) =>
			guarded(ctx, () => {
				state.retryActive = false;
				state.lastSettledFailed = !event.success && event.finalError !== "Retry cancelled";
				scheduleChangedSnapshot(ctx);
			}),
		);
		pi.on("session.compacting", (_event, ctx) =>
			guarded(ctx, () => {
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
				state.todos = summarizeTodos(getLatestTodoPhasesFromEntries(ctx.sessionManager.getBranch()));
				scheduleChangedSnapshot(ctx);
			}),
		);
	};

	return {
		factory,
		beforeSessionMutation(_event, ctx): void {
			fenceLifecycle(ctx);
		},
		afterDispatch(event, ctx): void {
			guarded(ctx, () => {
				switch (event.type) {
					case "session_ready":
						completeLifecycle("session_ready", ctx);
						break;
					case "session_rollback":
						completeLifecycle("session_rollback", ctx);
						break;
					case "session_branch":
						completeLifecycle("session_branch", ctx);
						break;
					case "session_tree":
						completeLifecycle("session_tree", ctx);
						break;
				}
			});
		},
		setHostTerminalInput(register): void {
			registerHostTerminalInput = register;
			if (inputContext && !state.shutdown) installInput(inputContext);
		},
		setStatusText(statusText): void {
			if (state.disabled || state.shutdown) return;
			state.statusText = normalizeString(statusText, 240, 960);
			if (inputContext) scheduleChangedSnapshot(inputContext);
		},
	};
}
