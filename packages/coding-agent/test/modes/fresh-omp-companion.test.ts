import { afterEach, describe, expect, it, vi } from "bun:test";
import * as crypto from "node:crypto";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
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
	CANCEL_COMMAND_BODY_B64,
	encodeFrame,
	normalizeString,
	parseCommand,
	REQUEST_SNAPSHOT_COMMAND_BODY_B64,
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

function commandFrame(
	secret: Uint8Array,
	type: "cancel" | "request_snapshot",
	options: { json?: string; bodyText?: string; tagText?: string } = {},
): string {
	const json = options.json ?? JSON.stringify({ version: 1, type });
	const bodyText = options.bodyText ?? Buffer.from(json, "utf8").toString("base64url");
	const tagText = options.tagText ?? hmac(secret, IN_DOMAIN, bodyText).toString("base64url");
	return `${COMMAND_PREFIX}${bodyText}.${tagText}${COMMAND_END}`;
}

function authenticatedCommandCapture(bodyText: string, secret: Uint8Array = SECRET): string {
	return `${bodyText}.${hmac(secret, IN_DOMAIN, bodyText).toString("base64url")}`;
}

function event(type: ExtensionEvent["type"], fields: Record<string, unknown> = {}): ExtensionEvent {
	return { type, ...fields } as ExtensionEvent;
}

function advance(ms: number): void {
	vi.advanceTimersByTime(ms);
	vi.advanceTimersByTime(0);
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
			getAsyncJobSnapshot: () => this.jobs as never,
			cwd: this.cwd,
			sessionManager: {
				getSessionId: () => this.sessionId,
				getSessionName: () => this.sessionName,
				getCwd: () => this.cwd,
				getBranch: () => this.branch,
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

	beforeSessionMutation(type: "session_branch" | "session_tree"): void {
		void this.controller.beforeSessionMutation({ type }, this.context);
	}

	afterDispatch(type: "session_ready" | "session_rollback" | "session_branch" | "session_tree"): void {
		void this.controller.afterDispatch(event(type), this.context);
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
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Fresh OMP companion wire snapshots", () => {
	it("emits the exact authenticated one-write OSC frame and registers zero tools", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();

		await harness.start();
		advance(999);
		expect(write).not.toHaveBeenCalled();
		advance(1);

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

	it("normalizes strict schema fields, domains, goal/todo state, and default-five async failures", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		harness.sessionName = `  Main\t\u202e${"😀".repeat(200)}  `;
		harness.cwd = ` /tmp\n${"😀".repeat(600)} `;
		harness.modelProvider = ` provider\u0085${"😀".repeat(100)}`;
		harness.modelId = `model\u2067${"😀".repeat(100)}`;
		harness.context.model = { provider: harness.modelProvider, id: harness.modelId } as never;
		harness.usage = { tokens: -20.8, contextWindow: Number.MAX_SAFE_INTEGER + 100, percent: 123.456 };
		harness.jobs = {
			running: [{ id: "running-secret", type: "task", status: "running", label: "do not emit", startTime: 0 }],
			recent: [
				{ id: "1", type: "task", status: "failed", label: "hidden", startTime: 0 },
				{ id: "2", type: "task", status: "cancelled", label: "hidden", startTime: 0 },
				{ id: "3", type: "task", status: "failed", label: "hidden", startTime: 0 },
				{ id: "4", type: "task", status: "completed", label: "hidden", startTime: 0 },
				{ id: "5", type: "task", status: "failed", label: "hidden", startTime: 0 },
				{ id: "6", type: "task", status: "failed", label: "outside-default-five", startTime: 0 },
			],
			delivery: { queued: 4, delivering: true, pendingJobIds: ["delivery-secret"] },
		};
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

	it("removes a trailing ASCII space exposed by each reduced cwd cap", () => {
		const snapshot = (cwd: string, ompVersion = "omp"): SemanticSnapshot => ({
			version: 1,
			incarnation: "00000000-0000-4000-8000-000000000000",
			sessionGeneration: 1,
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
	it("accepts only the two frozen authenticated body strings", () => {
		expect(parseCommand(SECRET, authenticatedCommandCapture(CANCEL_COMMAND_BODY_B64))).toBe("cancel");
		expect(parseCommand(SECRET, authenticatedCommandCapture(REQUEST_SNAPSHOT_COMMAND_BODY_B64))).toBe(
			"request_snapshot",
		);

		const nearCanonicalBodies = [
			Buffer.from('{"version":1,"type":"cancel" }', "utf8").toString("base64url"),
			Buffer.from('{"type":"cancel","version":1}', "utf8").toString("base64url"),
			Buffer.from('{"version":1,"version":1,"type":"cancel"}', "utf8").toString("base64url"),
		];
		for (const bodyText of nearCanonicalBodies) {
			expect(parseCommand(SECRET, authenticatedCommandCapture(bodyText))).toBeUndefined();
		}
	});
});

describe("Fresh OMP companion lifecycle and generation isolation", () => {
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
		advance(1_000);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.sessionId).toBe(SESSION_A);
		expect(harness.feed(cancel.slice(1))).toBe("");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(harness.feed(cancel)).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);

		harness.invoke("session_switch", { reason: "new", previousSessionFile: "/old" });
		harness.sessionId = SESSION_B;
		const beforeTargetSample = write.mock.calls.length;
		advance(1_000);
		expect(write).toHaveBeenCalledTimes(beforeTargetSample);
		const readyGate = Promise.withResolvers<void>();
		harness.ensureOnDiskBarrier = readyGate.promise;
		const becomingReady = harness.invokeAsync("session_ready");
		await Promise.resolve();
		expect(harness.ensureOnDisk).toHaveBeenCalledTimes(2);
		const beforeReady = write.mock.calls.length;
		harness.afterDispatch("session_ready");
		advance(50);
		expect(write).toHaveBeenCalledTimes(beforeReady);

		readyGate.resolve();
		await becomingReady;
		harness.afterDispatch("session_ready");
		expect(write).toHaveBeenCalledTimes(beforeReady + 1);
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
		harness.invoke("session_switch", { reason: "new", previousSessionFile: "/old" });
		oldStartGate.resolve();
		await oldStart;
		advance(1_000);
		expect(write).not.toHaveBeenCalled();

		harness.invoke("session_rollback");
		harness.afterDispatch("session_rollback");
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
		harness.invoke("session_switch", { reason: "new", previousSessionFile: "/old" });
		oldStartGate.reject(new Error("stale start materialization failed"));
		await oldStart;
		expect(harness.warn).not.toHaveBeenCalled();

		harness.invoke("session_rollback");
		harness.afterDispatch("session_rollback");
		advance(50);
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("does not let a delayed old session_ready activate a newer generation", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		const beforeTransition = write.mock.calls.length;

		harness.invoke("session_switch", { reason: "new", previousSessionFile: "/old" });
		const oldReadyGate = Promise.withResolvers<void>();
		harness.ensureOnDiskBarrier = oldReadyGate.promise;
		const oldReady = harness.invokeAsync("session_ready");
		await Promise.resolve();
		harness.invoke("session_switch", { reason: "resume", previousSessionFile: "/target" });
		oldReadyGate.resolve();
		await oldReady;
		harness.afterDispatch("session_ready");
		advance(1_000);
		expect(write).toHaveBeenCalledTimes(beforeTransition);

		harness.invoke("session_rollback");
		harness.afterDispatch("session_rollback");
		advance(50);
		expect(write).toHaveBeenCalledTimes(beforeTransition + 1);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.sessionGeneration).toBe(3);
	});

	it("does not let a rejected old session_ready disable a newer generation", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		const beforeTransition = write.mock.calls.length;

		harness.invoke("session_switch", { reason: "new", previousSessionFile: "/old" });
		const oldReadyGate = Promise.withResolvers<void>();
		harness.ensureOnDiskBarrier = oldReadyGate.promise;
		const oldReady = harness.invokeAsync("session_ready");
		await Promise.resolve();
		harness.invoke("session_switch", { reason: "resume", previousSessionFile: "/target" });
		oldReadyGate.reject(new Error("stale readiness materialization failed"));
		await oldReady;
		expect(harness.warn).not.toHaveBeenCalled();

		harness.invoke("session_rollback");
		harness.afterDispatch("session_rollback");
		advance(50);
		expect(write).toHaveBeenCalledTimes(beforeTransition + 1);
	});

	it("publishes only from post-fan-out continuations and rejects stale-generation scheduled work", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		advance(1_000);
		const initial = parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot;
		expect(initial.sessionGeneration).toBe(1);

		harness.invoke("session_switch", { reason: "resume", previousSessionFile: "/old" });
		harness.sessionId = SESSION_B;
		harness.sessionName = "Target before public handlers";
		const beforeTargetSample = write.mock.calls.length;
		advance(1_000);
		expect(write).toHaveBeenCalledTimes(beforeTargetSample);
		const beforeReady = write.mock.calls.length;
		await harness.invokeAsync("session_ready");
		expect(write).toHaveBeenCalledTimes(beforeReady);
		harness.sessionName = "Target after public handlers";
		harness.afterDispatch("session_ready");
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
		harness.invoke("session_switch", { reason: "resume", previousSessionFile: "/target" });
		advance(50);
		expect(write).toHaveBeenCalledTimes(beforeStale);
		harness.throwOnClearTimer = false;

		harness.sessionId = SESSION_A;
		harness.sessionName = "Retained before rollback fan-out";
		harness.invoke("session_rollback");
		harness.sessionName = "Retained after rollback fan-out";
		harness.afterDispatch("session_rollback");
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
		harness.afterDispatch("session_branch");
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
		harness.afterDispatch("session_tree");
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
		harness.invoke("session_switch", { reason: "new", previousSessionFile: "/old" });
		expect(harness.input).toBe(firstInput);
		expect(harness.inputInstalls).toBe(1);
		expect(harness.inputUnsubscribes).toBe(0);
		expect(harness.feed("ordinary-during-switch")).toBe("ordinary-during-switch");
		expect(harness.feed(`before${cancel}${malformed}${request}after`)).toBe("beforeafter");
		expect(harness.feed(`${COMMAND_PREFIX}${"A".repeat(2_093)}${COMMAND_END}tail`)).toBe("tail");
		expect(harness.feed(`${COMMAND_PREFIX}timed-out`)).toBe("");
		advance(1_000);
		expect(harness.feed("ordinary-after-timeout")).toBe("ordinary-after-timeout");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledTimes(initialWrites);

		const readyGate = Promise.withResolvers<void>();
		harness.ensureOnDiskBarrier = readyGate.promise;
		const becomingReady = harness.invokeAsync("session_ready");
		await Promise.resolve();
		expect(harness.feed(`left${cancel}${request}right`)).toBe("leftright");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledTimes(initialWrites);
		readyGate.resolve();
		await becomingReady;
		harness.afterDispatch("session_ready");
		harness.afterDispatch("session_ready");
		advance(50);
		expect(harness.input).toBe(firstInput);
		expect(harness.inputInstalls).toBe(1);
		expect(harness.inputUnsubscribes).toBe(0);
		expect(harness.feed(cancel)).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);

		harness.invoke("session_switch", { reason: "resume", previousSessionFile: "/target" });
		expect(harness.feed(cancel)).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);
		harness.invoke("session_rollback");
		harness.afterDispatch("session_rollback");
		harness.afterDispatch("session_rollback");
		advance(50);
		expect(harness.input).toBe(firstInput);
		expect(harness.inputInstalls).toBe(1);
		expect(harness.feed(cancel)).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(2);

		harness.beforeSessionMutation("session_branch");
		expect(harness.input).toBe(firstInput);
		expect(harness.feed("ordinary-during-host-fence")).toBe("ordinary-during-host-fence");
		expect(harness.feed(cancel)).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(2);
		harness.invoke("session_branch", { previousSessionFile: "/retained" });
		harness.afterDispatch("session_branch");
		harness.afterDispatch("session_branch");
		advance(50);
		expect(harness.input).toBe(firstInput);
		expect(harness.inputInstalls).toBe(1);
		expect(harness.feed(cancel)).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(3);

		harness.beforeSessionMutation("session_tree");
		expect(harness.input).toBe(firstInput);
		harness.invoke("session_tree", { newLeafId: "target", oldLeafId: "retained" });
		harness.afterDispatch("session_tree");
		advance(50);
		expect(harness.input).toBe(firstInput);
		expect(harness.inputInstalls).toBe(1);
		expect(harness.inputUnsubscribes).toBe(0);
		expect(harness.feed(cancel)).toBe("");
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
		const beforeShutdown = write.mock.calls.length;

		harness.shutdown();
		expect(write).toHaveBeenCalledTimes(beforeShutdown + 1);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("stopped");
		expect(harness.input).toBeUndefined();
		advance(10_000);
		expect(write).toHaveBeenCalledTimes(beforeShutdown + 1);
	});
});

describe("Fresh OMP companion command parser", () => {
	it("handles arbitrary splits, multiple surrounding frames, canonical auth, caps, timeout, and lifecycle reset", async () => {
		vi.useFakeTimers();
		const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const harness = new CompanionHarness();
		await harness.start();
		const request = commandFrame(SECRET, "request_snapshot");
		let ordinary = harness.feed(`before${request.slice(0, 1)}`);
		for (let index = 1; index < request.length - 1; index++) ordinary += harness.feed(request[index] ?? "");
		ordinary += harness.feed(`${request.at(-1)}after`);
		expect(ordinary).toBe("beforeafter");
		expect(write).not.toHaveBeenCalled();
		advance(0);
		expect(write).toHaveBeenCalledTimes(1);

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
		expect(harness.feed(`late${COMMAND_END}`)).toBe(`late${COMMAND_END}`);

		expect(harness.feed(`${COMMAND_PREFIX}partial`)).toBe("");
		const oldInput = harness.input;
		harness.invoke("session_switch", { reason: "new", previousSessionFile: "/old" });
		expect(harness.input).toBe(oldInput);
		expect(harness.inputUnsubscribes).toBe(0);
		expect(harness.feed("ordinary-after-reset")).toBe("ordinary-after-reset");
		expect(harness.feed(commandFrame(SECRET, "cancel"))).toBe("");
		advance(0);
		expect(harness.abort).toHaveBeenCalledTimes(1);
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
		expect(harness.feed("after-timeout")).toBe("after-timeout");
		advance(0);
		expect(harness.abort).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledTimes(1);

		harness.invoke("session_switch", { reason: "new", previousSessionFile: "/old" });
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
		expect(write).not.toHaveBeenCalled();
		verification.mockRestore();

		harness.invoke("session_switch", { reason: "new", previousSessionFile: "/old" });
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
		expect(harness.feed(`late${COMMAND_END}`)).toBe(`late${COMMAND_END}`);
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

		harness.invoke("auto_retry_start", { attempt: 1, maxAttempts: 2, delayMs: 10, errorMessage: "retry" });
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("retrying");
		harness.invoke("auto_retry_end", { success: false, attempt: 1, finalError: "Retry cancelled" });
		advance(50);
		expect(parseFrame(write.mock.calls.at(-1)?.[0] as string, SECRET).envelope.snapshot.state).toBe("idle");
	});
});
