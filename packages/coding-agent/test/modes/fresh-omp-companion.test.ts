import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { isRecord, VERSION } from "@oh-my-pi/pi-utils";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionHandler,
	TerminalInputHandler,
} from "../../src/extensibility/extensions/types";
import {
	createFreshOmpCompanionController,
	type FreshOmpCompanionController,
} from "../../src/modes/fresh-omp-companion";
import {
	type CompanionCommandTarget,
	encodeFrame,
	normalizeString,
	parseCommand,
	type SemanticSnapshot,
} from "../../src/modes/fresh-omp-companion-wire";
import type { SessionEntry } from "../../src/session/session-entries";

const OSC_PREFIX = "\x1b]777;notify;fresh://omp-companion;v1;";
const OSC_TERMINATOR = "\x1b\\";
const COMMAND_PREFIX = "\u{10ffff}fresh-omp-command:v1:";
const COMMAND_END = "\u{10fffe}";
const SYNC_DOMAIN = "fresh-omp/sync/v1\0";
const OUT_DOMAIN = "fresh-omp/out/v1\0";
const IN_DOMAIN = "fresh-omp/in/v1\0";
const SESSION_A = "018f1d74-7f7b-7d31-8d93-9a21c7b95bb1";
const SESSION_B = "018f1d74-7f7b-7d31-8d93-9a21c7b95bb2";
const SECRET = Uint8Array.from({ length: 32 }, (_, index) => index);
const COMMAND_TARGET: CompanionCommandTarget = {
	incarnation: "550e8400-e29b-41d4-a716-446655440000",
	sessionGeneration: 1,
	sessionId: SESSION_A,
	workEpoch: 1,
};
let nextCommandSequence = 0;

type RegisteredHandler = ExtensionHandler<ExtensionEvent>;

type ManagedTimerCallback = Parameters<ExtensionContext["setTimeout"]>[0];
type ManagedTimer = Parameters<ExtensionContext["clearTimer"]>[0];

type ParsedFrame = {
	frame: string;
	sync: string;
	bodyText: string;
	tagText: string;
	envelope: {
		version: number;
		type: string;
		snapshot: Record<string, unknown>;
	};
};

function hmac(secret: Uint8Array, domain: string, ascii = ""): Buffer {
	return crypto.createHmac("sha256", secret).update(domain, "utf8").update(ascii, "ascii").digest();
}

function parseFrame(frame: string, secret: Uint8Array): ParsedFrame {
	expect(frame.startsWith(OSC_PREFIX)).toBe(true);
	expect(frame.endsWith(OSC_TERMINATOR)).toBe(true);
	const content = frame.slice(OSC_PREFIX.length, -OSC_TERMINATOR.length);
	const syncSeparator = content.indexOf(";");
	expect(syncSeparator).toBe(22);
	const sync = content.slice(0, syncSeparator);
	const authenticated = content.slice(syncSeparator + 1);
	const tagSeparator = authenticated.lastIndexOf(".");
	expect(tagSeparator).toBeGreaterThan(0);
	const bodyText = authenticated.slice(0, tagSeparator);
	const tagText = authenticated.slice(tagSeparator + 1);
	expect(bodyText).toMatch(/^[A-Za-z0-9_-]+$/);
	expect(Buffer.from(bodyText, "base64url").toString("base64url")).toBe(bodyText);
	expect(tagText).toHaveLength(43);
	expect(Buffer.from(tagText, "base64url").toString("base64url")).toBe(tagText);
	expect(crypto.timingSafeEqual(Buffer.from(tagText, "base64url"), hmac(secret, OUT_DOMAIN, bodyText))).toBe(true);
	const json = Buffer.from(bodyText, "base64url").toString("utf8");
	return {
		frame,
		sync,
		bodyText,
		tagText,
		envelope: JSON.parse(json) as ParsedFrame["envelope"],
	};
}

function latestSnapshotIdentity(): (CompanionCommandTarget & { sequence: number }) | undefined {
	// The test harness installs a Bun mock before commands inspect captured writes.
	const mockedWrite = process.stdout.write as typeof process.stdout.write & { mock?: { calls: unknown[][] } };
	const calls = mockedWrite.mock?.calls ?? [];
	for (let index = calls.length - 1; index >= 0; index--) {
		const frame = calls[index]?.[0];
		if (typeof frame !== "string" || !frame.startsWith(OSC_PREFIX) || !frame.endsWith(OSC_TERMINATOR)) continue;
		const content = frame.slice(OSC_PREFIX.length, -OSC_TERMINATOR.length);
		const authenticated = content.slice(content.indexOf(";") + 1);
		const bodyText = authenticated.slice(0, authenticated.lastIndexOf("."));
		try {
			const envelope: unknown = JSON.parse(Buffer.from(bodyText, "base64url").toString("utf8"));
			if (!isRecord(envelope) || !isRecord(envelope.snapshot)) continue;
			const snapshot = envelope.snapshot;
			if (
				typeof snapshot.incarnation === "string" &&
				typeof snapshot.sequence === "number" &&
				typeof snapshot.sessionGeneration === "number" &&
				typeof snapshot.sessionId === "string" &&
				typeof snapshot.workEpoch === "number"
			) {
				return {
					incarnation: snapshot.incarnation,
					sequence: snapshot.sequence,
					sessionGeneration: snapshot.sessionGeneration,
					sessionId: snapshot.sessionId,
					workEpoch: snapshot.workEpoch,
				};
			}
		} catch {
			// Ignore non-companion writes and malformed test fixtures.
		}
	}
	return undefined;
}

function commandFrame(
	secret: Uint8Array,
	type: "cancel" | "request_snapshot" | "snapshot_ack",
	options: {
		json?: string;
		bodyText?: string;
		tagText?: string;
		target?: CompanionCommandTarget;
		sequence?: number;
		accepted?: boolean;
		commandSequence?: number;
	} = {},
): string {
	const latest = latestSnapshotIdentity();
	const source = options.target ?? latest ?? COMMAND_TARGET;
	const target: CompanionCommandTarget = {
		incarnation: source.incarnation,
		sessionGeneration: source.sessionGeneration,
		sessionId: source.sessionId,
		workEpoch: source.workEpoch,
	};
	const commandSequence = options.commandSequence ?? ++nextCommandSequence;
	const json =
		options.json ??
		(type === "snapshot_ack"
			? JSON.stringify({
					version: 1,
					type,
					incarnation: target.incarnation,
					sequence: options.sequence ?? latest?.sequence ?? 1,
					sessionGeneration: target.sessionGeneration,
					sessionId: target.sessionId,
					workEpoch: target.workEpoch,
					accepted: options.accepted ?? true,
					commandSequence,
				})
			: JSON.stringify({ version: 1, type, ...target, commandSequence }));
	const bodyText = options.bodyText ?? Buffer.from(json, "utf8").toString("base64url");
	const tagText = options.tagText ?? hmac(secret, IN_DOMAIN, bodyText).toString("base64url");
	return `${COMMAND_PREFIX}${bodyText}.${tagText}${COMMAND_END}`;
}

function authenticatedCommandCapture(json: string, secret: Uint8Array = SECRET): string {
	const bodyText = Buffer.from(json, "utf8").toString("base64url");
	return `${bodyText}.${hmac(secret, IN_DOMAIN, bodyText).toString("base64url")}`;
}

function event(type: ExtensionEvent["type"], fields: Record<string, unknown> = {}): ExtensionEvent {
	return { type, ...fields } as ExtensionEvent;
}

function advance(ms: number): void {
	vi.advanceTimersByTime(ms);
	vi.advanceTimersByTime(0);
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function modeEntry(mode: string, data?: Record<string, unknown>): SessionEntry {
	return {
		type: "mode_change",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date(0).toISOString(),
		mode,
		data,
	} as never as SessionEntry;
}

function todoEntry(phases: unknown[]): SessionEntry {
	return {
		type: "custom",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp: new Date(0).toISOString(),
		customType: "user_todo_edit",
		data: { phases },
	} as never as SessionEntry;
}
class CompanionHarness {
	readonly controller: FreshOmpCompanionController;
	readonly handlers = new Map<ExtensionEvent["type"], RegisteredHandler>();
	readonly registerTool = vi.fn();
	readonly warn = vi.fn();
	readonly abort = vi.fn();
	readonly ensureOnDisk = vi.fn(async (): Promise<void> => {
		if (this.throwOnEnsure) throw new Error("ensure secret payload");
		await this.ensureOnDiskBarrier;
	});
	readonly getBranch = vi.fn((): SessionEntry[] => this.branch);
	readonly context: ExtensionContext;
	input?: TerminalInputHandler;
	inputInstalls = 0;
	inputUnsubscribes = 0;
	sessionId = SESSION_A;
	sessionName: string | undefined = "Primary";
	cwd = "/tmp/project";
	modelProvider = "anthropic";
	modelId = "claude-sonnet";
	thinkingLevel = "high";
	idle = true;
	compacting = false;
	branch: SessionEntry[] = [];
	usage: { tokens: number; contextWindow: number; percent: number } | undefined = {
		tokens: 250,
		contextWindow: 1_000,
		percent: 25,
	};
	jobs: {
		running: Array<{ id: string; type: string; status: string; label: string; startTime: number }>;
		recent: Array<{ id: string; type: string; status: string; label: string; startTime: number }>;
		delivery: { queued: number; delivering: boolean; pendingJobIds: string[] };
	} | null = {
		running: [],
		recent: [],
		delivery: { queued: 0, delivering: false, pendingJobIds: [] },
	};
	jobCounts: { running: number; recentFailures: number; pendingDelivery: number } | null = {
		running: 0,
		recentFailures: 0,
		pendingDelivery: 0,
	};
	readonly getAsyncJobSnapshot = vi.fn(() => this.jobs as never);
	readonly getAsyncJobCounts = vi.fn(() => this.jobCounts as never);
	throwOnSample = false;
	throwOnTimer = false;
	throwOnClearTimer = false;
	throwOnUnsubscribe = false;
	ensureOnDiskBarrier: Promise<void> = Promise.resolve();
	throwOnEnsure = false;

	constructor(readonly secret: Uint8Array = SECRET) {
		this.controller = createFreshOmpCompanionController(secret);
		this.context = {
			ui: {
				onTerminalInput: (handler: TerminalInputHandler): (() => void) => {
					this.inputInstalls++;
					this.input = handler;
					return () => {
						this.inputUnsubscribes++;
						if (this.throwOnUnsubscribe) throw new Error("unsubscribe secret payload");
						if (this.input === handler) this.input = undefined;
					};
				},
			},
			getContextUsage: () => {
				if (this.throwOnSample) throw new Error("sample secret payload");
				return this.usage;
			},
			isCompacting: () => this.compacting,
			getAsyncJobSnapshot: this.getAsyncJobSnapshot,
			getAsyncJobCounts: this.getAsyncJobCounts,
			cwd: this.cwd,
			sessionManager: {
				getSessionId: () => this.sessionId,
				getSessionName: () => this.sessionName,
				getCwd: () => this.cwd,
				getBranch: this.getBranch,
				ensureOnDisk: this.ensureOnDisk,
			},
			model: { provider: this.modelProvider, id: this.modelId },
			isIdle: () => this.idle,
			abort: this.abort,
			setTimeout: (callback: ManagedTimerCallback, ms?: number, ...args: unknown[]) => {
				if (this.throwOnTimer) throw new Error("timer secret payload");
				return globalThis.setTimeout(() => callback(...args), ms);
			},
			setInterval: (callback: ManagedTimerCallback, ms?: number, ...args: unknown[]) => {
				if (this.throwOnTimer) throw new Error("timer secret payload");
				return globalThis.setInterval(() => callback(...args), ms);
			},
			clearTimer: (timer: ManagedTimer): void => {
				if (this.throwOnClearTimer) throw new Error("clear timer secret payload");
				clearTimeout(timer);
				clearInterval(timer);
			},
		} as never as ExtensionContext;
		const api = {
			on: (type: ExtensionEvent["type"], handler: RegisteredHandler): void => {
				this.handlers.set(type, handler);
			},
			registerTool: this.registerTool,
			getThinkingLevel: () => this.thinkingLevel,
			logger: { warn: this.warn },
		} as never as ExtensionAPI;
		void this.controller.factory(api);
		this.controller.setHostTerminalInput((handler: TerminalInputHandler): (() => void) => {
			this.inputInstalls++;
			this.input = handler;
			return () => {
				this.inputUnsubscribes++;
				if (this.throwOnUnsubscribe) throw new Error("unsubscribe secret payload");
				if (this.input === handler) this.input = undefined;
			};
		});
		activeHarnesses.push(this);
	}

	invoke(type: ExtensionEvent["type"], fields: Record<string, unknown> = {}): void {
		const handler = this.handlers.get(type);
		expect(handler).toBeDefined();
		void handler?.(event(type, fields), this.context);
	}

	async invokeAsync(type: ExtensionEvent["type"], fields: Record<string, unknown> = {}): Promise<void> {
		const handler = this.handlers.get(type);
		expect(handler).toBeDefined();
		await handler?.(event(type, fields), this.context);
	}

	beforeSessionMutation(type: "session_switch" | "session_branch" | "session_tree"): void {
		void this.controller.beforeSessionMutation({ type }, this.context);
	}

	async afterDispatch(
		type: "session_ready" | "session_rollback" | "session_branch" | "session_tree",
		autoAcknowledge = true,
	): Promise<void> {
		const completion = Promise.resolve(this.controller.afterDispatch(event(type), this.context));
		if (autoAcknowledge) this.feed(commandFrame(this.secret, "snapshot_ack"));
		await completion;
	}

	async start(): Promise<void> {
		await this.invokeAsync("session_start");
	}

	feed(data: string): string {
		const handler = this.input;
		expect(handler).toBeDefined();
		return handler?.(data)?.data ?? data;
	}

	shutdown(): void {
		const handler = this.handlers.get("session_shutdown");
		if (!handler) return;
		try {
			void handler(event("session_shutdown"), this.context);
		} catch {
			// The production contract makes cleanup nonfatal; test teardown mirrors that boundary.
		}
	}
}

let activeHarnesses: CompanionHarness[] = [];

afterEach(() => {
	for (const harness of activeHarnesses) harness.shutdown();
	activeHarnesses = [];
	nextCommandSequence = 0;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Fresh OMP companion wire snapshots", () => {
	it("emits the exact authenticated one-write OSC frame and registers zero tools", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();

		await harness.start();
		expect(write).toHaveBeenCalledTimes(1);
		advance(1_000);
		expect(write).toHaveBeenCalledTimes(1);
		expect(write.mock.calls[0]).toHaveLength(1);
		const parsed = parseFrame(write.mock.calls[0]?.[0] as string, SECRET);
		const expectedSync = hmac(SECRET, SYNC_DOMAIN).subarray(0, 16).toString("base64url");
		expect(parsed.sync).toBe(expectedSync);
		expect(parsed.sync).toHaveLength(22);
		expect(parsed.bodyText.length).toBeLessThanOrEqual(10_923);
		expect(Buffer.from(parsed.bodyText, "base64url").byteLength).toBeLessThanOrEqual(8_192);
		expect(Buffer.byteLength(parsed.frame, "utf8")).toBeLessThanOrEqual(12 * 1_024);
		expect(parsed.envelope).toMatchObject({
			version: 1,
			type: "snapshot",
			snapshot: {
				version: 1,
				ompVersion: VERSION,
				processId: process.pid,
				sessionId: SESSION_A,
				sessionGeneration: 1,
				workEpoch: 1,
				state: "idle",
				runningTools: 0,
				pendingApprovals: 0,
			},
		});
		expect(parsed.envelope.snapshot.incarnation).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(parsed.envelope.snapshot.sequence).toBeGreaterThan(0);
		expect(parsed.envelope.snapshot.timestampMs).toBeGreaterThanOrEqual(0);
		expect(parsed.frame).not.toContain(Buffer.from(SECRET).toString("base64url"));
		expect(harness.registerTool).not.toHaveBeenCalled();
	});

	it("publishes canonical footer status text and clears it with the loader", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();

		await harness.start();
		advance(1_000);
		harness.invoke("agent_start");
		harness.controller.setStatusText("Finding top-level files");
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot).toMatchObject({
			state: "working",
			statusText: "Finding top-level files",
		});

		harness.controller.setStatusText("Working…");
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.statusText).toBe("Working…");

		harness.controller.setStatusText(undefined);
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.statusText).toBeUndefined();
	});

	it("uses one process-wide incarnation and monotonically increasing sequence across controllers", async () => {
		vi.useFakeTimers();
		expect(() => createFreshOmpCompanionController(new Uint8Array(31))).toThrow(
			"Fresh OMP companion secret must be exactly 32 bytes",
		);
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const first = new CompanionHarness();
		const second = new CompanionHarness();
		await first.start();
		await second.start();
		advance(1_000);

		expect(write).toHaveBeenCalledTimes(2);
		const firstSnapshot = parseFrame(write.mock.calls[0]?.[0] as string, SECRET).envelope.snapshot;
		const secondSnapshot = parseFrame(write.mock.calls[1]?.[0] as string, SECRET).envelope.snapshot;
		expect(secondSnapshot.incarnation).toBe(firstSnapshot.incarnation);
		expect(secondSnapshot.sequence).toBe((firstSnapshot.sequence as number) + 1);
	});

	it("normalizes strict schema fields, domains, goal/todo state, and count-only async summaries", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		harness.sessionName = `  Main\t\u202e${"😀".repeat(200)}  `;
		harness.cwd = ` /tmp\n${"😀".repeat(600)} `;
		harness.modelProvider = ` provider\u0085${"😀".repeat(100)}`;
		harness.modelId = `model\u2067${"😀".repeat(100)}`;
		harness.context.model = { provider: harness.modelProvider, id: harness.modelId } as never;
		harness.usage = { tokens: -20.8, contextWindow: Number.MAX_SAFE_INTEGER + 100, percent: 123.456 };
		harness.jobCounts = { running: 1, recentFailures: 3, pendingDelivery: 4 };
		harness.branch = [
			modeEntry("goal", {
				goal: { objective: "  Ship\n\u202e safely  ", status: "active" },
			}),
			todoEntry([
				{
					name: "Phase",
					tasks: [
						{ content: "  Waiting\tfirst  ", status: "pending" },
						{ content: "  Active\u2066 now  ", status: "in_progress" },
						{ content: "Blocked", status: "blocked" },
						{ content: "Done", status: "completed" },
						{ content: "Dropped", status: "abandoned" },
					],
				},
			]),
		];

		await harness.start();
		harness.invoke("tool_execution_start", {
			toolCallId: "call-secret",
			toolName: ` tool\t${"😀".repeat(100)}`,
			args: { prompt: "must-not-cross" },
			intent: ` inspect\n${"😀".repeat(200)}`,
		});
		harness.invoke("tool_approval_requested", {
			sessionId: SESSION_A,
			toolCallId: "approval-secret",
			toolName: "bash",
			reason: "must-not-cross",
			approvalMode: "ask",
		});
		advance(1_000);

		const parsed = parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET);
		const snapshot = parsed.envelope.snapshot as Record<string, unknown> & {
			model: { provider: string; id: string };
			currentTool: { name: string; intent: string };
			goal: { objective: string; status: string };
			todos: Record<string, unknown>;
			context: Record<string, number>;
			asyncJobs: Record<string, number>;
		};
		expect(Object.keys(snapshot).sort()).toEqual(
			[
				"asyncJobs",
				"context",
				"currentTool",
				"cwd",
				"goal",
				"incarnation",
				"model",
				"ompVersion",
				"pendingApprovals",
				"processId",
				"runningTools",
				"sequence",
				"sessionGeneration",
				"workEpoch",
				"sessionId",
				"sessionName",
				"state",
				"thinkingLevel",
				"timestampMs",
				"todos",
				"version",
			].sort(),
		);
		expect(snapshot.state).toBe("awaiting_approval");
		expect(snapshot.sessionName).toBe(`Main ${"😀".repeat(155)}`);
		expect(Array.from(snapshot.sessionName as string)).toHaveLength(160);
		expect(Buffer.byteLength(snapshot.cwd as string, "utf8")).toBeLessThanOrEqual(2_048);
		expect(Array.from(snapshot.cwd as string)).toHaveLength(512);
		expect(snapshot.model.provider.startsWith("provider ")).toBe(true);
		expect(Buffer.byteLength(snapshot.model.provider, "utf8")).toBeLessThanOrEqual(256);
		expect(Buffer.byteLength(snapshot.model.id, "utf8")).toBeLessThanOrEqual(256);
		expect(Array.from(snapshot.currentTool.name)).toHaveLength(80);
		expect(Array.from(snapshot.currentTool.intent)).toHaveLength(160);
		expect(snapshot.goal).toEqual({ objective: "Ship safely", status: "active" });
		expect(snapshot.todos).toEqual({
			pending: 1,
			inProgress: 1,
			blocked: 1,
			completed: 1,
			abandoned: 1,
			current: "Active now",
		});
		expect(snapshot.context).toEqual({ tokens: 0, contextWindow: Number.MAX_SAFE_INTEGER, percentBps: 10_000 });
		expect(snapshot.asyncJobs).toEqual({ running: 1, recentFailures: 3, pendingDelivery: 4 });
		expect(harness.getAsyncJobSnapshot).not.toHaveBeenCalled();
		expect(harness.getAsyncJobCounts).toHaveBeenCalled();
		const serialized = JSON.stringify(parsed.envelope);
		expect(serialized).not.toContain("must-not-cross");
		expect(serialized).not.toContain("running-secret");
		expect(serialized).not.toContain("delivery-secret");
		expect(serialized).not.toContain(":null");

		harness.invoke("tool_execution_end", {
			toolCallId: "call-secret",
			toolName: "todo",
			result: { details: { phases: [] } },
			isError: false,
		});
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.todos).toBeUndefined();
	});
});

describe("Fresh OMP companion wire string bounds", () => {
	it("removes a trailing ASCII space exposed by code-point and UTF-8 byte truncation", () => {
		const codePointBounded = normalizeString("😀 text", 2, Number.MAX_SAFE_INTEGER);
		const byteBounded = normalizeString("😀 text", Number.MAX_SAFE_INTEGER, 5);

		for (const value of [codePointBounded, byteBounded]) {
			expect(value).toBe("😀");
			expect(value?.startsWith(" ")).toBe(false);
			expect(value?.endsWith(" ")).toBe(false);
		}
	});

	it("never splits an extended grapheme at code-point or UTF-8 byte bounds", () => {
		for (const cluster of ["e\u0301", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇺🇳"]) {
			const codePoints = Array.from(cluster).length;
			const bytes = Buffer.byteLength(cluster, "utf8");
			expect(normalizeString(`${cluster}x`, codePoints, Number.MAX_SAFE_INTEGER)).toBe(cluster);
			expect(normalizeString(`${cluster}x`, Number.MAX_SAFE_INTEGER, bytes)).toBe(cluster);
			expect(normalizeString(cluster, codePoints - 1, Number.MAX_SAFE_INTEGER)).toBe("");
			expect(normalizeString(cluster, Number.MAX_SAFE_INTEGER, bytes - 1)).toBe("");
		}
	});

	it("removes a trailing ASCII space exposed by each reduced cwd cap", () => {
		const snapshot = (cwd: string, ompVersion = "omp"): SemanticSnapshot => ({
			version: 1,
			incarnation: "00000000-0000-4000-8000-000000000000",
			sessionGeneration: 1,
			workEpoch: 1,
			ompVersion,
			processId: 1,
			sessionId: SESSION_A,
			cwd,
			state: "idle",
			runningTools: 0,
			pendingApprovals: 0,
		});
		const reducedAt1024 = encodeFrame(
			SECRET,
			"a".repeat(22),
			snapshot(`${"x".repeat(1_023)} ${"overflow".repeat(2_000)}`),
			1,
		);
		const reducedAt256 = encodeFrame(
			SECRET,
			"a".repeat(22),
			snapshot(`${"y".repeat(255)} ${"overflow".repeat(2_000)}`, "v".repeat(7_000)),
			2,
		);

		for (const [encoded, expected] of [
			[reducedAt1024, "x".repeat(1_023)],
			[reducedAt256, "y".repeat(255)],
		] as const) {
			expect(encoded).toBeDefined();
			const cwd = parseFrame(encoded?.frame as string, SECRET).envelope.snapshot.cwd;
			expect(cwd).toBe(expected);
			expect((cwd as string).startsWith(" ")).toBe(false);
			expect((cwd as string).endsWith(" ")).toBe(false);
		}
	});
});

describe("Fresh OMP canonical command parser", () => {
	const commandJson = (
		type: "cancel" | "request_snapshot",
		commandSequence: number,
		target = COMMAND_TARGET,
	): string => JSON.stringify({ version: 1, type, ...target, commandSequence });

	it("accepts only canonical commands for the exact live work and next sequence", () => {
		const cancel = authenticatedCommandCapture(commandJson("cancel", 1));
		expect(parseCommand(SECRET, cancel, COMMAND_TARGET, 0)).toEqual({ type: "cancel", commandSequence: 1 });
		expect(parseCommand(SECRET, cancel, COMMAND_TARGET, 1)).toBeUndefined();

		const request = authenticatedCommandCapture(commandJson("request_snapshot", 2));
		expect(parseCommand(SECRET, request, COMMAND_TARGET, 1)).toEqual({
			type: "request_snapshot",
			commandSequence: 2,
		});
		expect(
			parseCommand(SECRET, request, { ...COMMAND_TARGET, workEpoch: COMMAND_TARGET.workEpoch + 1 }, 1),
		).toBeUndefined();

		const acknowledgementJson = JSON.stringify({
			version: 1,
			type: "snapshot_ack",
			incarnation: COMMAND_TARGET.incarnation,
			sequence: 9,
			sessionGeneration: COMMAND_TARGET.sessionGeneration,
			sessionId: COMMAND_TARGET.sessionId,
			workEpoch: COMMAND_TARGET.workEpoch,
			accepted: true,
			commandSequence: 3,
		});
		expect(parseCommand(SECRET, authenticatedCommandCapture(acknowledgementJson), COMMAND_TARGET, 2)).toEqual({
			type: "snapshot_ack",
			incarnation: COMMAND_TARGET.incarnation,
			sequence: 9,
			sessionGeneration: COMMAND_TARGET.sessionGeneration,
			sessionId: COMMAND_TARGET.sessionId,
			workEpoch: COMMAND_TARGET.workEpoch,
			accepted: true,
			commandSequence: 3,
		});

		for (const json of [
			`${commandJson("cancel", 3)} `,
			`{"type":"cancel","version":1,"incarnation":"${COMMAND_TARGET.incarnation}","sessionGeneration":1,"sessionId":"${SESSION_A}","workEpoch":1,"commandSequence":3}`,
			commandJson("cancel", 3).replace('"version":1', '"version":1,"version":1'),
			JSON.stringify({ version: 1, type: "cancel", ...COMMAND_TARGET, commandSequence: 3, extra: true }),
		]) {
			expect(parseCommand(SECRET, authenticatedCommandCapture(json), COMMAND_TARGET, 2)).toBeUndefined();
		}
	});
});

describe("Fresh OMP companion lifecycle and generation isolation", () => {
	it("requires an exact positive snapshot acknowledgement before lifecycle activation", async () => {
		vi.useFakeTimers();
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);

		harness.beforeSessionMutation("session_switch");
		harness.sessionId = SESSION_B;
		await harness.invokeAsync("session_ready");
		const completion = harness.afterDispatch("session_ready", false);
		const published = latestSnapshotIdentity();
		if (!published) throw new Error("expected lifecycle snapshot identity");
		const activated = vi.fn();
		void completion.then(activated);

		expect(
			harness.feed(
				commandFrame(SECRET, "snapshot_ack", {
					target: published,
					sequence: published.sequence + 1,
				}),
			),
		).toBe("");
		await Promise.resolve();
		expect(activated).not.toHaveBeenCalled();

		expect(
			harness.feed(commandFrame(SECRET, "snapshot_ack", { target: published, sequence: published.sequence })),
		).toBe("");
		await completion;
		expect(activated).toHaveBeenCalledTimes(1);
		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);

		harness.beforeSessionMutation("session_switch");
		harness.sessionId = SESSION_A;
		harness.invoke("session_rollback");
		const rejected = harness.afterDispatch("session_rollback", false);
		const rejectedMessage = rejectionMessage(rejected);
		expect(harness.feed(commandFrame(SECRET, "snapshot_ack", { accepted: false }))).toBe("");
		expect(await rejectedMessage).toContain("Fresh rejected the durable snapshot acknowledgement");
		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);
	});

	it("times out a missing acknowledgement and cannot reuse a late stale frame", async () => {
		vi.useFakeTimers();
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);

		harness.beforeSessionMutation("session_switch");
		harness.sessionId = SESSION_B;
		await harness.invokeAsync("session_ready");
		const timedOut = harness.afterDispatch("session_ready", false);
		const stale = latestSnapshotIdentity();
		if (!stale) throw new Error("expected timed-out lifecycle snapshot identity");
		const timeoutMessage = rejectionMessage(timedOut);
		advance(5_000);
		expect(await timeoutMessage).toContain("timed out");

		harness.beforeSessionMutation("session_switch");
		harness.sessionId = SESSION_A;
		harness.invoke("session_rollback");
		const replacement = harness.afterDispatch("session_rollback", false);
		const current = latestSnapshotIdentity();
		if (!current) throw new Error("expected replacement lifecycle snapshot identity");
		const activated = vi.fn();
		void replacement.then(activated);
		expect(harness.feed(commandFrame(SECRET, "snapshot_ack", { target: stale, sequence: stale.sequence }))).toBe("");
		await Promise.resolve();
		expect(activated).not.toHaveBeenCalled();
		expect(harness.feed(commandFrame(SECRET, "snapshot_ack", { target: current, sequence: current.sequence }))).toBe(
			"",
		);
		await replacement;
		expect(activated).toHaveBeenCalledTimes(1);
	});

	it("rejects pending acknowledgements on generation replacement and shutdown", async () => {
		vi.useFakeTimers();
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);

		harness.beforeSessionMutation("session_switch");
		harness.sessionId = SESSION_B;
		await harness.invokeAsync("session_ready");
		const replaced = harness.afterDispatch("session_ready", false);
		const replacedMessage = rejectionMessage(replaced);
		harness.beforeSessionMutation("session_switch");
		expect(await replacedMessage).toContain("superseded by a new session generation");

		harness.sessionId = SESSION_A;
		harness.invoke("session_rollback");
		const stopped = harness.afterDispatch("session_rollback", false);
		const stoppedMessage = rejectionMessage(stopped);
		harness.shutdown();
		expect(await stoppedMessage).toContain("cancelled during shutdown");
	});
	it("materializes each advertised session before enabling or publishing its companion", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		const startGate = Promise.withResolvers<void>();
		harness.ensureOnDiskBarrier = startGate.promise;
		const cancel = commandFrame(SECRET, "cancel");

		const starting = harness.start();
		await Promise.resolve();
		expect(harness.ensureOnDisk).toHaveBeenCalledTimes(1);
		expect(harness.inputInstalls).toBe(1);
		expect(harness.feed(cancel.slice(0, 1))).toBe("");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
		advance(1_000);
		expect(write).not.toHaveBeenCalled();

		startGate.resolve();
		await starting;
		expect(harness.inputInstalls).toBe(1);
		expect(write).toHaveBeenCalledTimes(1);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.sessionId).toBe(SESSION_A);
		expect(harness.feed(cancel.slice(1))).toBe("");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
		const activeCancel = commandFrame(SECRET, "cancel");
		expect(harness.feed(activeCancel)).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);

		harness.beforeSessionMutation("session_switch");
		harness.sessionId = SESSION_B;
		const beforeTargetSample = write.mock.calls.length;
		advance(1_000);
		expect(write).toHaveBeenCalledTimes(beforeTargetSample);

		harness.throwOnEnsure = true;
		await harness.invokeAsync("session_ready");
		expect(harness.ensureOnDisk).toHaveBeenCalledTimes(1);
		expect(harness.warn).not.toHaveBeenCalled();
		await harness.afterDispatch("session_ready");
		expect(write).toHaveBeenCalledTimes(beforeTargetSample + 1);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.sessionId).toBe(SESSION_B);
	});

	it("does not let a delayed old session_start unquiesce a newer generation", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		const oldStartGate = Promise.withResolvers<void>();
		harness.ensureOnDiskBarrier = oldStartGate.promise;

		const oldStart = harness.invokeAsync("session_start");
		await Promise.resolve();
		harness.beforeSessionMutation("session_switch");
		oldStartGate.resolve();
		await oldStart;
		advance(1_000);
		expect(write).not.toHaveBeenCalled();

		harness.invoke("session_rollback");
		await harness.afterDispatch("session_rollback");
		advance(50);
		expect(write).toHaveBeenCalledTimes(1);
		expect(parseFrame(write.mock.calls[0]?.[0] as string, SECRET).envelope.snapshot.sessionGeneration).toBe(2);
	});

	it("does not let a rejected old session_start disable a newer generation", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		const oldStartGate = Promise.withResolvers<void>();
		harness.ensureOnDiskBarrier = oldStartGate.promise;

		const oldStart = harness.invokeAsync("session_start");
		await Promise.resolve();
		harness.beforeSessionMutation("session_switch");
		oldStartGate.reject(new Error("stale start materialization failed"));
		await oldStart;
		expect(harness.warn).not.toHaveBeenCalled();

		harness.invoke("session_rollback");
		await harness.afterDispatch("session_rollback");
		advance(50);
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("binds synchronous readiness to the generation that reaches host completion", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		const beforeTransition = write.mock.calls.length;

		harness.beforeSessionMutation("session_switch");
		harness.sessionId = SESSION_B;
		await harness.invokeAsync("session_ready");
		harness.beforeSessionMutation("session_switch");
		await harness.afterDispatch("session_ready");
		advance(1_000);
		expect(write).toHaveBeenCalledTimes(beforeTransition);

		harness.sessionId = SESSION_A;
		harness.invoke("session_rollback");
		await harness.afterDispatch("session_rollback");
		advance(50);
		expect(write).toHaveBeenCalledTimes(beforeTransition + 1);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot).toMatchObject({
			sessionGeneration: 3,
			sessionId: SESSION_A,
		});
	});

	it("publishes only from post-fan-out continuations and rejects stale-generation scheduled work", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		const initial = parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot;
		expect(initial.sessionGeneration).toBe(1);

		harness.beforeSessionMutation("session_switch");
		harness.sessionId = SESSION_B;
		harness.sessionName = "Target before public handlers";
		const beforeTargetSample = write.mock.calls.length;
		advance(1_000);
		expect(write).toHaveBeenCalledTimes(beforeTargetSample);
		const beforeReady = write.mock.calls.length;
		await harness.invokeAsync("session_ready");
		expect(write).toHaveBeenCalledTimes(beforeReady);
		harness.sessionName = "Target after public handlers";
		await harness.afterDispatch("session_ready");
		const ready = parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot;
		expect(ready).toMatchObject({
			sessionId: SESSION_B,
			sessionName: "Target after public handlers",
			sessionGeneration: 2,
		});
		expect(harness.inputInstalls).toBe(1);
		expect(harness.inputUnsubscribes).toBe(0);

		const beforeStale = write.mock.calls.length;
		harness.invoke("agent_start");
		harness.throwOnClearTimer = true;
		harness.beforeSessionMutation("session_switch");
		advance(50);
		expect(write).toHaveBeenCalledTimes(beforeStale);
		harness.throwOnClearTimer = false;

		harness.sessionId = SESSION_A;
		harness.sessionName = "Retained before rollback fan-out";
		harness.invoke("session_rollback");
		harness.sessionName = "Retained after rollback fan-out";
		await harness.afterDispatch("session_rollback");
		advance(50);
		const rollback = parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot;
		expect(rollback).toMatchObject({
			sessionId: SESSION_A,
			sessionName: "Retained after rollback fan-out",
			sessionGeneration: 3,
		});

		harness.branch = [modeEntry("goal", { goal: { objective: "Old goal", status: "active" } })];
		const beforeBranch = write.mock.calls.length;
		harness.beforeSessionMutation("session_branch");
		harness.invoke("session_branch", { previousSessionFile: "/retained" });
		advance(1_000);
		expect(write).toHaveBeenCalledTimes(beforeBranch);
		harness.branch = [modeEntry("none"), todoEntry([])];
		await harness.afterDispatch("session_branch");
		advance(50);
		const branch = parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot;
		expect(branch.sessionGeneration).toBe(4);
		expect(branch.goal).toBeUndefined();

		const beforeTree = write.mock.calls.length;
		harness.beforeSessionMutation("session_tree");
		harness.sessionName = "Tree before public handlers";
		harness.invoke("session_tree", { newLeafId: "target", oldLeafId: "retained" });
		advance(1_000);
		expect(write).toHaveBeenCalledTimes(beforeTree);
		harness.sessionName = "Tree after public handlers";
		await harness.afterDispatch("session_tree");
		advance(50);
		const tree = parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot;
		expect(tree).toMatchObject({
			sessionGeneration: 5,
			sessionName: "Tree after public handlers",
		});
	});

	it("repairs stale compaction event state from the authoritative one-second sample", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("idle");

		harness.compacting = false;
		harness.invoke("auto_compaction_start", {
			reason: "threshold",
			action: "context-full",
		});
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("compacting");

		advance(950);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("idle");
	});

	it("keeps idle one-second sampling O(1) by reusing cached branch summaries", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		harness.branch = [modeEntry("goal", { goal: { objective: "Cached goal", status: "active" } })];
		await harness.start();
		expect(harness.getBranch).toHaveBeenCalledTimes(1);

		harness.getBranch.mockClear();
		advance(5_000);
		expect(harness.getBranch).not.toHaveBeenCalled();

		harness.controller.setThinkingLevel("auto");
		advance(50);
		expect(harness.getBranch).not.toHaveBeenCalled();
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.thinkingLevel).toBe("auto");
	});

	it("keeps one host-owned filter consume-only through fences until shutdown", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		const cancel = commandFrame(SECRET, "cancel");
		const request = commandFrame(SECRET, "request_snapshot");
		const malformed = `${COMMAND_PREFIX}not.a.valid.command${COMMAND_END}`;
		const initialWrites = write.mock.calls.length;
		const firstInput = harness.input;

		expect(harness.feed(`${COMMAND_PREFIX}frozen`)).toBe("");
		harness.beforeSessionMutation("session_switch");
		expect(harness.input).toBe(firstInput);
		expect(harness.inputInstalls).toBe(1);
		expect(harness.inputUnsubscribes).toBe(0);
		expect(harness.feed("ordinary-during-switch")).toBe("");
		expect(harness.feed(`${COMMAND_END}ordinary-after-resync`)).toBe("ordinary-after-resync");
		expect(harness.feed(`before${cancel}${malformed}${request}after`)).toBe("beforeafter");
		expect(harness.feed(`${COMMAND_PREFIX}${"A".repeat(2_093)}${COMMAND_END}tail`)).toBe("tail");
		expect(harness.feed(`${COMMAND_PREFIX}timed-out`)).toBe("");
		advance(1_000);
		expect(harness.feed("ordinary-after-timeout")).toBe("");
		expect(harness.feed(`${COMMAND_END}ordinary-after-timeout-resync`)).toBe("ordinary-after-timeout-resync");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledTimes(initialWrites);

		await harness.invokeAsync("session_ready");
		expect(harness.feed(`left${cancel}${request}right`)).toBe("leftright");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledTimes(initialWrites);
		await harness.afterDispatch("session_ready");
		await harness.afterDispatch("session_ready");
		advance(50);
		expect(harness.input).toBe(firstInput);
		expect(harness.inputInstalls).toBe(1);
		expect(harness.inputUnsubscribes).toBe(0);
		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);

		harness.beforeSessionMutation("session_switch");
		expect(harness.feed(cancel)).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);
		harness.invoke("session_rollback");
		await harness.afterDispatch("session_rollback");
		await harness.afterDispatch("session_rollback");
		advance(50);
		expect(harness.input).toBe(firstInput);
		expect(harness.inputInstalls).toBe(1);
		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(2);

		harness.beforeSessionMutation("session_branch");
		expect(harness.input).toBe(firstInput);
		expect(harness.feed("ordinary-during-host-fence")).toBe("ordinary-during-host-fence");
		expect(harness.feed(cancel)).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(2);
		harness.invoke("session_branch", { previousSessionFile: "/retained" });
		await harness.afterDispatch("session_branch");
		await harness.afterDispatch("session_branch");
		advance(50);
		expect(harness.input).toBe(firstInput);
		expect(harness.inputInstalls).toBe(1);
		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(3);

		harness.beforeSessionMutation("session_tree");
		expect(harness.input).toBe(firstInput);
		harness.invoke("session_tree", { newLeafId: "target", oldLeafId: "retained" });
		await harness.afterDispatch("session_tree");
		advance(50);
		expect(harness.input).toBe(firstInput);
		expect(harness.inputInstalls).toBe(1);
		expect(harness.inputUnsubscribes).toBe(0);
		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(4);

		harness.shutdown();
		expect(harness.input).toBeUndefined();
		expect(harness.inputUnsubscribes).toBe(1);
	});

	it("cancels companion work and issues one best-effort stopped frame on shutdown", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		harness.invoke("tool_execution_start", {
			toolCallId: "active-tool",
			toolName: "bash",
			intent: "running",
		});
		harness.invoke("tool_approval_requested", {
			sessionId: SESSION_A,
			toolCallId: "pending-approval",
			toolName: "bash",
			approvalMode: "ask",
		});
		advance(50);
		const beforeShutdown = write.mock.calls.length;

		harness.shutdown();
		expect(write).toHaveBeenCalledTimes(beforeShutdown + 1);
		const stopped = parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot;
		expect(stopped).toMatchObject({ state: "stopped", runningTools: 0, pendingApprovals: 0 });
		expect(stopped.currentTool).toBeUndefined();
		expect(harness.input).toBeUndefined();
		advance(10_000);
		expect(write).toHaveBeenCalledTimes(beforeShutdown + 1);
	});

	it("publishes shutdown from the last committed target, never a provisional switch", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);

		harness.beforeSessionMutation("session_switch");
		harness.sessionId = SESSION_B;
		harness.sessionName = "Uncommitted target";
		harness.shutdown();

		const stopped = parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot;
		expect(stopped).toMatchObject({
			state: "stopped",
			sessionGeneration: 1,
			sessionId: SESSION_A,
			sessionName: "Primary",
		});
	});
});

describe("Fresh OMP companion command parser", () => {
	it("handles arbitrary splits, multiple surrounding frames, canonical auth, caps, timeout, and lifecycle reset", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		const writesBeforeRequest = write.mock.calls.length;
		const request = commandFrame(SECRET, "request_snapshot");
		const requestTarget = latestSnapshotIdentity();
		if (!requestTarget) throw new Error("expected an emitted companion snapshot");
		expect(parseCommand(SECRET, request.slice(COMMAND_PREFIX.length, -COMMAND_END.length), requestTarget, 0)).toEqual(
			{ type: "request_snapshot", commandSequence: 1 },
		);
		let ordinary = harness.feed(`before${request.slice(0, 1)}`);
		for (let index = 1; index < request.length - 1; index++) ordinary += harness.feed(request[index] ?? "");
		ordinary += harness.feed(`${request.at(-1)}after`);
		expect(ordinary).toBe("beforeafter");
		expect(write).toHaveBeenCalledTimes(writesBeforeRequest);
		advance(50);
		expect(write).toHaveBeenCalledTimes(writesBeforeRequest + 1);

		const cancel = commandFrame(SECRET, "cancel");
		const combined = harness.feed(`x${cancel}${cancel}${request}y`);
		expect(combined).toBe("xy");
		expect(harness.abort).not.toHaveBeenCalled();
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);

		const badTag = `${COMMAND_PREFIX}${Buffer.from(JSON.stringify({ version: 1, type: "cancel" })).toString("base64url")}.${"A".repeat(43)}${COMMAND_END}`;
		expect(harness.feed(`left${badTag}right`)).toBe("leftright");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);

		const duplicateJson = '{"version":1,"version":1,"type":"cancel"}';
		expect(harness.feed(commandFrame(SECRET, "cancel", { json: duplicateJson }))).toBe("");
		const unknownJson = JSON.stringify({ version: 1, type: "cancel", extra: true });
		expect(harness.feed(commandFrame(SECRET, "cancel", { json: unknownJson }))).toBe("");
		const wrongVersionJson = JSON.stringify({ version: 2, type: "cancel" });
		expect(harness.feed(commandFrame(SECRET, "cancel", { json: wrongVersionJson }))).toBe("");
		const invalidUtf8Body = Buffer.from([0xff]).toString("base64url");
		expect(harness.feed(commandFrame(SECRET, "cancel", { bodyText: invalidUtf8Body }))).toBe("");
		const extraSeparatorBody = `${Buffer.from(JSON.stringify({ version: 1, type: "cancel" })).toString("base64url")}.A`;
		expect(harness.feed(commandFrame(SECRET, "cancel", { bodyText: extraSeparatorBody }))).toBe("");
		const paddedBody = `${Buffer.from(JSON.stringify({ version: 1, type: "cancel" })).toString("base64url")}=`;
		expect(harness.feed(commandFrame(SECRET, "cancel", { bodyText: paddedBody }))).toBe("");
		expect(harness.feed(`${COMMAND_PREFIX}é${COMMAND_END}`)).toBe("");
		const oversizedJson = JSON.stringify({ version: 1, type: "cancel", extra: "x".repeat(1_024) });
		expect(harness.feed(commandFrame(SECRET, "cancel", { json: oversizedJson }))).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);

		expect(harness.feed(`${COMMAND_PREFIX}${"A".repeat(2_093)}${COMMAND_END}`)).toBe("");
		expect(harness.feed("tail")).toBe("tail");

		expect(harness.feed(`${COMMAND_PREFIX}abc`)).toBe("");
		advance(1_000);
		expect(harness.feed(`late${COMMAND_PREFIX}not.a.valid.command${COMMAND_END}after`)).toBe("after");

		expect(harness.feed(`${COMMAND_PREFIX}partial`)).toBe("");
		const oldInput = harness.input;
		harness.beforeSessionMutation("session_switch");
		expect(harness.input).toBe(oldInput);
		expect(harness.inputUnsubscribes).toBe(0);
		expect(harness.feed("ordinary-after-reset")).toBe("");
		expect(harness.feed(`${COMMAND_END}ordinary-after-reset-resync`)).toBe("ordinary-after-reset-resync");
		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);
	});

	it("cancels only the authenticated work epoch and replaces stale queued timers", async () => {
		vi.useFakeTimers();
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();

		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		harness.idle = false;
		harness.invoke("agent_start");
		advance(50);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(latestSnapshotIdentity()?.workEpoch).toBe(2);

		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);
	});

	it("coalesces cancel until async abort settlement and contains rejection", async () => {
		vi.useFakeTimers();
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		const firstAbort = Promise.withResolvers<void>();
		harness.abort.mockImplementation(() => firstAbort.promise as never);

		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);

		firstAbort.resolve();
		await firstAbort.promise;
		await Promise.resolve();
		const rejectedAbort = Promise.withResolvers<void>();
		harness.abort.mockImplementation(() => rejectedAbort.promise as never);
		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(2);

		rejectedAbort.reject(new Error("private abort failure"));
		await Promise.resolve();
		await Promise.resolve();
		expect(harness.warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(harness.warn.mock.calls[0])).toContain("event_fault");
		expect(JSON.stringify(harness.warn.mock.calls[0])).not.toContain("private abort failure");
	});
});

describe("Fresh OMP companion backpressure and liveness", () => {
	it("never replays a false-return write, retains only newest subsequent state, and heartbeats at five seconds", async () => {
		vi.useFakeTimers();
		let call = 0;
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => ++call !== 1);
		const baselineDrainListeners = process.stdout.listenerCount("drain");
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		expect(write).toHaveBeenCalledTimes(1);
		expect(process.stdout.listenerCount("drain")).toBe(baselineDrainListeners + 1);

		harness.invoke("agent_start");
		harness.invoke("tool_execution_start", {
			toolCallId: "tool-a",
			toolName: "read",
			args: {},
			intent: "older blocked state",
		});
		harness.invoke("tool_approval_requested", {
			sessionId: SESSION_A,
			toolCallId: "approval-a",
			toolName: "read",
			approvalMode: "ask",
		});
		expect(write).toHaveBeenCalledTimes(1);

		process.stdout.emit("drain");
		expect(write).toHaveBeenCalledTimes(2);
		expect(process.stdout.listenerCount("drain")).toBe(baselineDrainListeners);
		const newest = parseFrame(write.mock.calls[1]?.[0] as string, SECRET).envelope.snapshot as Record<
			string,
			unknown
		>;
		expect(newest.state).toBe("awaiting_approval");
		expect((newest.currentTool as Record<string, unknown>).intent).toBe("older blocked state");
		process.stdout.emit("drain");
		expect(write).toHaveBeenCalledTimes(2);

		advance(4_998);
		expect(write).toHaveBeenCalledTimes(2);
		advance(2);
		expect(write).toHaveBeenCalledTimes(3);
		const heartbeat = parseFrame(write.mock.calls[2]?.[0] as string, SECRET).envelope.snapshot as Record<
			string,
			number
		>;
		expect(heartbeat.sequence).toBe((newest.sequence as number) + 1);
		expect(heartbeat.timestampMs - (newest.timestampMs as number)).toBe(5_000);
	});

	it("keeps forced heartbeat intent through every blocked replacement and rearms after drain", async () => {
		vi.useFakeTimers();
		let writes = 0;
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => ++writes !== 1);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		expect(write).toHaveBeenCalledTimes(1);

		// The blocked output spans the five-second heartbeat and the following normal sample.
		advance(6_000);
		expect(write).toHaveBeenCalledTimes(1);
		const drainedAt = Date.now();
		process.stdout.emit("drain");
		expect(write).toHaveBeenCalledTimes(2);
		const drained = parseFrame(write.mock.calls[1]?.[0] as string, SECRET).envelope.snapshot;
		expect(drained.state).toBe("idle");

		advance(4_999);
		expect(write).toHaveBeenCalledTimes(2);
		advance(1);
		expect(write).toHaveBeenCalledTimes(3);
		const heartbeat = parseFrame(write.mock.calls[2]?.[0] as string, SECRET).envelope.snapshot;
		expect(heartbeat.sequence).toBe((drained.sequence as number) + 1);
		const heartbeatTimestamp = heartbeat.timestampMs as number;
		expect(heartbeatTimestamp).toBeGreaterThanOrEqual(drainedAt + 5_000);
		expect(heartbeatTimestamp).toBeLessThanOrEqual(drainedAt + 5_001);
	});
});

describe("Fresh OMP companion fault containment", () => {
	it("contains sampling/parser/cleanup faults and emits only secret-safe diagnostics", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();

		harness.throwOnSample = true;
		await harness.start();
		expect(() => advance(1_000)).not.toThrow();
		expect(write).not.toHaveBeenCalled();
		expect(harness.warn).toHaveBeenCalledTimes(1);
		const diagnostic = JSON.stringify(harness.warn.mock.calls[0]);
		expect(diagnostic).toContain("sampling_fault");
		expect(diagnostic).toContain(SESSION_A.slice(0, 8));
		expect(diagnostic).not.toContain(Buffer.from(SECRET).toString("base64url"));
		expect(diagnostic).not.toContain("sample secret payload");

		const parserHarness = new CompanionHarness();
		await parserHarness.start();
		parserHarness.throwOnTimer = true;
		expect(() => parserHarness.feed(`${COMMAND_PREFIX}partial`)).not.toThrow();
		expect(parserHarness.warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(parserHarness.warn.mock.calls[0])).not.toContain("timer secret payload");

		const cleanupHarness = new CompanionHarness();
		await cleanupHarness.start();
		cleanupHarness.throwOnUnsubscribe = true;
		expect(() => cleanupHarness.shutdown()).not.toThrow();
		expect(cleanupHarness.inputUnsubscribes).toBe(1);
		expect(cleanupHarness.warn).not.toHaveBeenCalled();
	});

	it("retains consume-only filtering after a sampling fault and through a switch fence", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		expect(parseFrame(write.mock.calls[0]?.[0] as string, SECRET).envelope.type).toBe("snapshot");

		harness.throwOnSample = true;
		expect(() => advance(1_000)).not.toThrow();
		expect(harness.warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(harness.warn.mock.calls[0])).toContain("sampling_fault");
		expect(harness.inputUnsubscribes).toBe(0);
		expect(harness.feed("ordinary input")).toBe("ordinary input");
		advance(12_000);
		expect(harness.input).toBeDefined();

		const cancel = commandFrame(SECRET, "cancel");
		const request = commandFrame(SECRET, "request_snapshot");
		const malformed = `${COMMAND_PREFIX}not.a.valid.command${COMMAND_END}`;
		expect(harness.feed(`before${cancel}${malformed}${request}after`)).toBe("beforeafter");
		expect(harness.feed(`${COMMAND_PREFIX}${"A".repeat(2_093)}${COMMAND_END}tail`)).toBe("tail");
		expect(harness.feed(`${COMMAND_PREFIX}partial`)).toBe("");
		advance(1_000);
		expect(harness.feed("after-timeout")).toBe("");
		expect(harness.feed(`${COMMAND_END}ordinary-after-timeout`)).toBe("ordinary-after-timeout");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledTimes(1);

		harness.beforeSessionMutation("session_switch");
		expect(harness.input).toBeDefined();
		expect(harness.inputUnsubscribes).toBe(0);
		expect(harness.feed(`left${cancel}right`)).toBe("leftright");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
	});

	it("keeps ordinary input usable after stdout emission disables the companion", async () => {
		vi.useFakeTimers();
		let failWrites = false;
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => {
			if (failWrites) throw new Error("stdout secret payload");
			return true;
		});
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		expect(parseFrame(write.mock.calls[0]?.[0] as string, SECRET).envelope.type).toBe("snapshot");

		failWrites = true;
		harness.invoke("agent_start");
		expect(() => advance(50)).not.toThrow();
		expect(harness.warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(harness.warn.mock.calls[0])).toContain("stdout_write_failed");
		expect(JSON.stringify(harness.warn.mock.calls[0])).not.toContain("stdout secret payload");
		expect(harness.feed("ordinary-after-stdout-fault")).toBe("ordinary-after-stdout-fault");
		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledTimes(2);

		harness.shutdown();
		expect(harness.input).toBeUndefined();
		expect(harness.inputUnsubscribes).toBe(1);
	});

	it("contains scheduled encoding failures and disables actions exactly once", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		const cancel = commandFrame(SECRET, "cancel");
		const encoder = vi.spyOn(crypto, "createHmac").mockImplementationOnce(() => {
			throw new Error("scheduled encoding secret payload");
		});

		harness.invoke("agent_start");
		expect(() => advance(50)).not.toThrow();
		expect(harness.warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(harness.warn.mock.calls[0])).toContain("encoding_fault");
		expect(JSON.stringify(harness.warn.mock.calls[0])).not.toContain("scheduled encoding secret payload");
		expect(write).toHaveBeenCalledTimes(1);
		expect(harness.feed("ordinary-after-encoding-fault")).toBe("ordinary-after-encoding-fault");
		expect(harness.feed(cancel)).toBe("");
		advance(10_000);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(harness.warn).toHaveBeenCalledTimes(1);
		encoder.mockRestore();
	});

	it("contains drain-triggered encoding failures and disables actions exactly once", async () => {
		vi.useFakeTimers();
		let writes = 0;
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => ++writes !== 1);
		const baselineDrainListeners = process.stdout.listenerCount("drain");
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		expect(process.stdout.listenerCount("drain")).toBe(baselineDrainListeners + 1);
		const cancel = commandFrame(SECRET, "cancel");
		harness.invoke("agent_start");
		const encoder = vi.spyOn(crypto, "createHmac").mockImplementationOnce(() => {
			throw new Error("drain encoding secret payload");
		});

		expect(() => process.stdout.emit("drain")).not.toThrow();
		expect(process.stdout.listenerCount("drain")).toBe(baselineDrainListeners);
		expect(harness.warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(harness.warn.mock.calls[0])).toContain("encoding_fault");
		expect(JSON.stringify(harness.warn.mock.calls[0])).not.toContain("drain encoding secret payload");
		expect(write).toHaveBeenCalledTimes(1);
		expect(harness.feed("ordinary-after-drain-fault")).toBe("ordinary-after-drain-fault");
		expect(harness.feed(cancel)).toBe("");
		expect(() => process.stdout.emit("drain")).not.toThrow();
		advance(10_000);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(harness.warn).toHaveBeenCalledTimes(1);
		encoder.mockRestore();
	});

	it("drops only the private candidate when command verification throws", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		const cancel = commandFrame(SECRET, "cancel");
		const verification = vi.spyOn(crypto, "timingSafeEqual").mockImplementationOnce((): boolean => {
			throw new Error("verification secret payload");
		});

		let forwarded = "";
		expect(() => {
			forwarded = harness.feed(`before${cancel}after`);
		}).not.toThrow();
		expect(forwarded).toBe("beforeafter");
		expect(harness.warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(harness.warn.mock.calls[0])).toContain("parser_fault");
		expect(JSON.stringify(harness.warn.mock.calls[0])).not.toContain("verification secret payload");
		expect(harness.feed(`left${commandFrame(SECRET, "request_snapshot")}right`)).toBe("leftright");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledTimes(1);
		verification.mockRestore();

		harness.beforeSessionMutation("session_switch");
		expect(harness.input).toBeDefined();
		expect(harness.inputUnsubscribes).toBe(0);
		expect(harness.feed(`left${cancel}right`)).toBe("leftright");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
	});

	it("retains a consume-only parser after startup materialization fails", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		harness.throwOnEnsure = true;

		await harness.start();
		advance(10_000);

		const authenticated = commandFrame(SECRET, "cancel");
		const malformed = `${COMMAND_PREFIX}not.a.valid.command${COMMAND_END}`;
		const oversized = `${COMMAND_PREFIX}${"A".repeat(2_093)}${COMMAND_END}`;
		expect(harness.inputInstalls).toBe(1);
		expect(harness.inputUnsubscribes).toBe(0);
		expect(harness.feed("ordinary input\nwith\ttabs")).toBe("ordinary input\nwith\ttabs");
		expect(harness.feed(`before${authenticated}${malformed}after`)).toBe("beforeafter");
		expect(harness.feed(`${oversized}tail`)).toBe("tail");
		expect(harness.feed(`${COMMAND_PREFIX}timed-out`)).toBe("");
		advance(1_000);
		expect(harness.feed(`late${COMMAND_END}`)).toBe("");
		expect(harness.feed("ordinary-after-timeout")).toBe("ordinary-after-timeout");
		advance(0);

		expect(harness.abort).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(harness.warn).toHaveBeenCalledTimes(1);
		const diagnostic = JSON.stringify(harness.warn.mock.calls[0]);
		expect(diagnostic).toContain("event_fault");
		expect(diagnostic).not.toContain("ensure secret payload");
	});

	it("classifies settled failures without turning user interrupts into errors", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		const interrupted = {
			role: "assistant",
			content: [],
			stopReason: "aborted",
			errorMessage: "Interrupted by user",
		} as never as AgentMessage;
		harness.invoke("agent_end", { messages: [interrupted] });
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("idle");

		const failed = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "provider failed",
		} as never as AgentMessage;
		harness.invoke("agent_start");
		advance(50);
		harness.invoke("agent_end", { messages: [failed] });
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("error");

		harness.idle = false;
		harness.invoke("agent_end", { messages: [failed], willContinue: true });
		harness.invoke("auto_retry_start", { attempt: 1, maxAttempts: 2, delayMs: 10, errorMessage: "retry" });
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("retrying");
		harness.idle = true;
		harness.invoke("auto_retry_end", { success: false, attempt: 1, finalError: "Retry cancelled" });
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("idle");

		harness.idle = false;
		harness.invoke("agent_end", { messages: [failed], willContinue: true });
		harness.invoke("auto_retry_start", { attempt: 2, maxAttempts: 2, delayMs: 10, errorMessage: "retry" });
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("retrying");
		harness.idle = true;
		advance(1_000);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("retrying");
		harness.invoke("auto_retry_end", { success: true, attempt: 2 });
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("idle");

		harness.idle = false;
		harness.invoke("agent_end", { messages: [failed], willContinue: true });
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("working");
		harness.idle = true;
		advance(1_000);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("working");
		harness.invoke("agent_start");
		harness.invoke("agent_end", { messages: [interrupted], willContinue: false });
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("idle");
	});
});
