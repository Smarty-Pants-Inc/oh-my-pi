#!/usr/bin/env bun
/**
 * Test fixture: a stand-in for the coding-agent RPC mode.
 *
 * Emits the `ready` frame immediately, echoes each inbound command with a
 * success response, and stays alive until stdin closes or SIGTERM arrives.
 * Used by rpc-client lifecycle tests that need to exercise start/stop/start
 * without booting the full agent runtime (which requires provider credentials).
 */
if (Bun.env.MOCK_RPC_PID_FILE) {
	await Bun.write(Bun.env.MOCK_RPC_PID_FILE, String(process.pid));
}
if (Bun.env.MOCK_RPC_IGNORE_SIGTERM === "1") {
	process.on("SIGTERM", () => {});
}

const supportsProtocolV2 = Bun.env.MOCK_RPC_V2 === "1";
const legacyState = {
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	sessionId: "mock-session",
	autoCompactionEnabled: false,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [],
};

if (Bun.env.MOCK_RPC_EXIT_BEFORE_READY) {
	const message = Bun.env.MOCK_RPC_EXIT_STDERR ?? "";
	if (message) {
		// Await the pipe write: exiting immediately can drop unflushed stderr
		// bytes, leaving the client's startup error without the failure text.
		const { promise, resolve } = Promise.withResolvers<void>();
		process.stderr.write(message, () => resolve());
		await promise;
	}
	process.exit(Number(Bun.env.MOCK_RPC_EXIT_BEFORE_READY));
}

let protocolV2Enabled = false;
let closureRejectionSupported = false;
let firstOverlappingPromptId: string | undefined;
let heldBarrierPromptId: string | undefined;
let heldIdleBarrierId: string | undefined;
let heldDelayedAcceptancePromptId: string | undefined;
let heldBarrierReleased = false;
let heldSessionReplacement: { id: string | undefined; command: string; data: unknown } | undefined;
let scheduledDuringReplacement = 0;
let overlappingLocalPromptCount = 0;
let olderPromptResultSent = false;
process.stdout.write(
	`${JSON.stringify(
		supportsProtocolV2
			? {
					type: "ready",
					protocolVersion: 1,
					supportedProtocolVersions: [1, 2],
					maxFrameBytes: 1024 * 1024,
					maxReassembledFrameBytes: 64 * 1024 * 1024,
				}
			: { type: "ready" },
	)}\n`,
);

function writeFrame(frame: Record<string, unknown>): void {
	const logical = Buffer.from(JSON.stringify(frame), "utf8");
	if (!protocolV2Enabled || logical.byteLength <= 1024 * 1024) {
		process.stdout.write(`${logical.toString("utf8")}\n`);
		return;
	}
	const chunkBytes = 256 * 1024;
	const count = Math.ceil(logical.byteLength / chunkBytes);
	for (let index = 0; index < count; index++) {
		process.stdout.write(
			`${JSON.stringify({
				type: "rpc_chunk",
				chunkId: "mock-rpc-v2",
				index,
				count,
				byteLength: logical.byteLength,
				data: logical.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64"),
			})}\n`,
		);
	}
}

// Bun's `console` is an AsyncIterable over stdin lines.
for await (const raw of console) {
	if (!raw) continue;
	try {
		const frame = JSON.parse(raw) as Record<string, unknown>;
		if (frame && typeof frame === "object" && typeof frame.type === "string") {
			if (Bun.env.MOCK_RPC_EXIT_ON_COMMAND) {
				process.stderr.write(Bun.env.MOCK_RPC_EXIT_STDERR ?? "");
				process.exit(Number(Bun.env.MOCK_RPC_EXIT_ON_COMMAND));
			}
			if (Bun.env.MOCK_RPC_INVALID_OUTPUT === "1") {
				process.stdout.write("{invalid-json\n");
				continue;
			}
			if (Bun.env.MOCK_RPC_IGNORE_COMMANDS === "1") continue;
			const id = typeof frame.id === "string" ? frame.id : undefined;
			if (
				heldSessionReplacement &&
				(frame.type === "prompt" || frame.type === "steer" || frame.type === "follow_up")
			) {
				scheduledDuringReplacement += 1;
			}
			if (frame.type === "negotiate_protocol" && frame.protocolVersion === 2) {
				const closureRejectionRequested = frame.closureRejection === true;
				const idleBarrierRequested = frame.idleBarrier === true;
				const acknowledgeClosure = closureRejectionRequested && Bun.env.MOCK_RPC_IDLE_WITHOUT_CLOSURE_ACK !== "1";
				closureRejectionSupported = acknowledgeClosure;
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: {
						protocolVersion: 2,
						...(acknowledgeClosure ? { closureRejection: true } : {}),
						...(Bun.env.MOCK_RPC_LEGACY_V2 !== "1" && acknowledgeClosure && idleBarrierRequested
							? { idleBarrier: true }
							: Bun.env.MOCK_RPC_IDLE_WITHOUT_CLOSURE_ACK === "1"
								? { idleBarrier: true }
								: {}),
					},
				});
				protocolV2Enabled = true;
				continue;
			}
			if (frame.type === "get_messages_page") {
				if (Bun.env.MOCK_RPC_PAGE_BUSY === "1") {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: "Cannot page messages while the session is changing",
						code: "session_busy",
					});
					continue;
				}
				if (Bun.env.MOCK_RPC_PAGE_STALE === "1" && frame.cursor !== undefined) {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: "RPC message cursor is stale",
						code: "stale_cursor",
					});
					continue;
				}
				const first = frame.cursor === undefined;
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: first
						? {
								messages: [{ role: "user", content: "first", timestamp: 1 }],
								nextCursor: "second-page",
								totalMessages: 2,
							}
						: {
								messages: [{ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 }],
								totalMessages: 2,
							},
				});
				continue;
			}
			if (
				frame.type === "get_messages" &&
				(Bun.env.MOCK_RPC_PAGE_BUSY === "1" || Bun.env.MOCK_RPC_PAGE_STALE === "1")
			) {
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: {
						messages: [
							{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
						],
					},
				});
				continue;
			}
			if (frame.type === "get_state" && Bun.env.MOCK_RPC_OVERLAPPING_LOCAL_PROMPT_RESULT === "1") {
				while (!olderPromptResultSent) await Bun.sleep(1);
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: { olderPromptResultSent },
				});
				continue;
			}
			if (frame.type === "get_messages" && Bun.env.MOCK_RPC_OVERLAPPING_LOCAL_PROMPT_RESULT === "1") {
				writeFrame({ type: "agent_end", messages: [], isTerminal: true });
				writeFrame({ id, type: "response", command: frame.type, success: true, data: { messages: [] } });
				continue;
			}
			if (frame.type === "get_state" && heldSessionReplacement) {
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: { scheduledDuringReplacement },
				});
				const replacement = heldSessionReplacement;
				heldSessionReplacement = undefined;
				writeFrame({
					id: replacement.id,
					type: "response",
					command: replacement.command,
					success: true,
					data: replacement.data,
				});
				continue;
			}
			if (
				frame.type === "get_state" &&
				(Bun.env.MOCK_RPC_LEGACY_STATE === "1" || Bun.env.MOCK_RPC_INVALID_TPS === "1")
			) {
				const data = {
					...legacyState,
					...(Bun.env.MOCK_RPC_INVALID_TPS === "1" ? { tokensPerSecond: "invalid" } : {}),
				};
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data,
				});
				continue;
			}

			if (frame.type === "wait_for_idle") {
				if (Bun.env.MOCK_RPC_DELAYED_ACCEPTANCE_LATE_FAILURE === "1" && heldDelayedAcceptancePromptId) {
					const promptId = heldDelayedAcceptancePromptId;
					heldDelayedAcceptancePromptId = undefined;
					writeFrame({ id: promptId, type: "response", command: "prompt", success: true, data: {} });
					writeFrame({
						id: promptId,
						type: "response",
						command: "prompt",
						success: false,
						error: "late failure",
					});
					writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
					continue;
				}
				if (Bun.env.MOCK_RPC_SESSION_REPLACEMENT_RACE === "1" && !heldBarrierReleased) {
					heldIdleBarrierId = id;
					continue;
				}
				if (Bun.env.MOCK_RPC_HELD_BARRIER_FAILURES && !heldBarrierReleased) {
					heldIdleBarrierId = id;
					continue;
				}
				const delayMs = Number(Bun.env.MOCK_RPC_IDLE_DELAY_MS ?? 0);
				if (delayMs > 0) await Bun.sleep(delayMs);
				if (Bun.env.MOCK_RPC_REJECT_IDLE_BARRIER === "1") {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: "idle barrier was not negotiated",
					});
				} else {
					writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
				}
				continue;
			}

			if (
				frame.type === "new_session" ||
				frame.type === "switch_session" ||
				frame.type === "branch" ||
				frame.type === "handoff"
			) {
				const data =
					frame.type === "branch"
						? { text: "branched prompt", cancelled: Bun.env.MOCK_RPC_CANCEL_SESSION_CHANGE === "1" }
						: frame.type === "handoff"
							? Bun.env.MOCK_RPC_CANCEL_HANDOFF === "1"
								? null
								: { savedPath: "/tmp/handoff.md" }
							: { cancelled: Bun.env.MOCK_RPC_CANCEL_SESSION_CHANGE === "1" };
				if (Bun.env.MOCK_RPC_HOLD_SESSION_REPLACEMENT === "1") continue;
				if (Bun.env.MOCK_RPC_SESSION_REPLACEMENT_RACE === "1") {
					writeFrame({ type: "agent_end", messages: [], isTerminal: true });
					if (heldIdleBarrierId) {
						writeFrame({
							id: heldIdleBarrierId,
							type: "response",
							command: "wait_for_idle",
							success: true,
							data: {},
						});
						heldBarrierReleased = true;
					}
					heldSessionReplacement = { id, command: frame.type, data };
					continue;
				}
				if (Bun.env.MOCK_RPC_TARGET_CLOSURE_BEFORE_REPLACEMENT_RESPONSE === "1") {
					writeFrame({
						type: "agent_end",
						messages: [],
						closureRejected: {
							reason: "stale_todos",
							todos: [{ content: "Finish target session task", status: "pending" }],
						},
					});
				}
				writeFrame({ id, type: "response", command: frame.type, success: true, data });
				continue;
			}

			if (frame.type === "prompt" && Bun.env.MOCK_RPC_HELD_BARRIER_FAILURES) {
				if (!heldBarrierPromptId) {
					heldBarrierPromptId = id;
					writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
					continue;
				}

				writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
				if (Bun.env.MOCK_RPC_HELD_BARRIER_FAILURES === "earlier_and_later") {
					writeFrame({
						id: heldBarrierPromptId,
						type: "response",
						command: frame.type,
						success: false,
						error: "earlier failure",
					});
				}
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: false,
					error: "later failure",
				});
				if (heldIdleBarrierId) {
					writeFrame({
						id: heldIdleBarrierId,
						type: "response",
						command: "wait_for_idle",
						success: true,
						data: {},
					});
					heldBarrierReleased = true;
				}
				continue;
			}

			if (frame.type === "prompt" && Bun.env.MOCK_RPC_DELAYED_ACCEPTANCE_LATE_FAILURE === "1") {
				heldDelayedAcceptancePromptId = id;
				if (!protocolV2Enabled) {
					void Bun.sleep(25).then(() => {
						if (heldDelayedAcceptancePromptId !== id) return;
						heldDelayedAcceptancePromptId = undefined;
						writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
						writeFrame({ id, type: "response", command: frame.type, success: false, error: "late failure" });
					});
				}
				continue;
			}

			if (frame.type === "prompt" && Bun.env.MOCK_RPC_OVERLAPPING_LATE_PROMPT_FAILURE === "1") {
				if (!firstOverlappingPromptId) {
					firstOverlappingPromptId = id;
					writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
					continue;
				}
				writeFrame({
					id: firstOverlappingPromptId,
					type: "response",
					command: frame.type,
					success: false,
					error: "late failure",
				});
				await Bun.sleep(50);
				writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
				continue;
			}

			if (frame.type === "prompt" && Bun.env.MOCK_RPC_OVERLAPPING_LOCAL_PROMPT_RESULT === "1") {
				overlappingLocalPromptCount += 1;
				writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
				if (overlappingLocalPromptCount === 1) {
					void Bun.sleep(25).then(() => {
						olderPromptResultSent = true;
						writeFrame({ type: "prompt_result", id, agentInvoked: false });
					});
				}
				continue;
			}
			if (frame.type === "prompt" && Bun.env.MOCK_RPC_LOCAL_ONLY_PROMPT) {
				if (Bun.env.MOCK_RPC_LOCAL_ONLY_PROMPT === "result") {
					writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
					await Bun.sleep(25);
					writeFrame({ type: "prompt_result", id, agentInvoked: false });
				} else {
					writeFrame({ id, type: "response", command: frame.type, success: true, data: { agentInvoked: false } });
				}
				continue;
			}

			if (
				(frame.type === "prompt" || frame.type === "abort_and_prompt") &&
				Bun.env.MOCK_RPC_LATE_FAILURE_COMMAND === frame.type
			) {
				writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
				await Bun.sleep(25);
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: false,
					error: "late failure",
				});
				continue;
			}
			if (frame.type === "prompt" && Bun.env.MOCK_RPC_CLOSURE_REJECTED === "1") {
				if (closureRejectionSupported) {
					writeFrame({
						type: "agent_end",
						messages: [],
						closureRejected: {
							reason: "stale_todos",
							todos: [{ content: "Finish RPC task", status: "pending" }],
						},
					});
				} else {
					writeFrame({ type: "rpc_frame_error", error: "Completion rejected; upgrade the RPC client" });
				}
			}
			if (frame.type === "prompt" && Bun.env.MOCK_RPC_NON_TERMINAL_AGENT_END === "1") {
				writeFrame({ type: "agent_end", messages: [], isTerminal: false });
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: {},
				});
				await Bun.sleep(50);
				writeFrame({ type: "agent_end", messages: [], isTerminal: true });
				continue;
			}

			if ((frame.type === "steer" || frame.type === "follow_up") && Bun.env.MOCK_RPC_REJECT_QUEUED === "1") {
				writeFrame({ id, type: "response", command: frame.type, success: false, error: "rejected command" });
				continue;
			}

			if ((frame.type === "steer" || frame.type === "follow_up") && Bun.env.MOCK_RPC_QUEUED_TERMINAL === "1") {
				writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
				await Bun.sleep(50);
				writeFrame({ type: "agent_end", messages: [], isTerminal: true });
				continue;
			}

			if (frame.type === "prompt" && Bun.env.MOCK_RPC_PROMPT_AGENT_END === "1") {
				writeFrame({ type: "agent_end", messages: [] });
			}

			writeFrame({
				id,
				type: "response",
				command: frame.type,
				success: true,
				data: supportsProtocolV2 && frame.type === "get_state" ? { payload: "😀".repeat(270_000) } : {},
			});
		}
	} catch {
		// ignore parse errors — the test harness sends well-formed frames.
	}
}
process.exit(0);
