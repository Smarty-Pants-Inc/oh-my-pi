import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { deterministicUuid } from "@oh-my-pi/pi-ai/utils/deterministic-id";

// Leaves ample room below Herdr's 256-byte full aid limit for the fixed OMP
// process-session prefix and delimiters.
export const MAX_RESPONSE_ANCHOR_ID_BYTES = 128;
const RESPONSE_ANCHOR_ID_RE = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_RESPONSE_ANCHOR_ID_BYTES}}$`);
const SYNTHESIZED_RESPONSE_ANCHOR_ID_PREFIX = "legacy-";

export function isSafeResponseAnchorId(value: unknown): value is string {
	return typeof value === "string" && RESPONSE_ANCHOR_ID_RE.test(value);
}

/** A safe random identifier for a newly appended response or local fallback. */
export function createResponseAnchorId(): string {
	return crypto.randomUUID();
}
/** A stable safe response anchor for a durable session entry. */
export function responseAnchorIdForEntry(entryId: string): string {
	return `${SYNTHESIZED_RESPONSE_ANCHOR_ID_PREFIX}${deterministicUuid(entryId)}`;
}

/** Use the durable entry id on replay; newly appended messages receive a UUID. */
export function stampAssistantResponseAnchorId(message: AssistantMessage, entryId?: string): void {
	if (isSafeResponseAnchorId(message.responseAnchorId)) return;
	message.responseAnchorId = entryId === undefined ? createResponseAnchorId() : responseAnchorIdForEntry(entryId);
}

/** Never pass persisted data through to OSC unless it passed the shared bound. */
export function responseAnchorIdOrFallback(value: unknown, fallback: string): string {
	if (isSafeResponseAnchorId(value)) return value;
	return isSafeResponseAnchorId(fallback) ? fallback : createResponseAnchorId();
}
