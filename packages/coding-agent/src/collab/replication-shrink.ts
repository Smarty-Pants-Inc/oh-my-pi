/**
 * Hard-cap helper for host→guest collab frames.
 *
 * The host wraps every {@link CollabFrame} in an AES-GCM envelope and ships it
 * through the relay's WebSocket. WebSocket servers enforce a per-frame
 * `maxPayloadLength` (Bun's default is 16 MB; many proxies cap lower). A
 * single oversized payload — typically a `read`/`bash`/`search` tool result
 * captured as one multi-megabyte string, or a tool result whose `content`
 * array holds thousands of small blocks — would otherwise ship as its own
 * oversized frame and trip that limit, killing the host's WebSocket with
 * `1006 Received too big message`. `CollabSocket` treats 1006 as transient
 * and reconnects, the next guest hello triggers the same oversized send, and
 * the loop never breaks (issue #3739).
 *
 * This helper bounds the UTF-8 JSON serialization of any serializable payload
 * below {@link MAX_REPLICATED_PAYLOAD_BYTES}. Already-small payloads pass through
 * untouched; oversized ones are returned as a deep-cloned shadow where long
 * strings are head-truncated AND long arrays are head-clipped, with
 * `[…N chars elided for collab session]` / `[…N items elided for collab
 * session]` markers. Both axes are needed: string truncation alone leaves
 * the cap unenforced for a payload built of many short strings, where no
 * field exceeds the per-string floor.
 */
import { isSafeResponseAnchorId } from "../session/response-anchor";

/**
 * Per-payload ceiling for host→guest frames. Local NDJSON bridge records are
 * capped at 1 MiB; reserve 1 KiB for the `{t:"frame",...}` wrapper and newline.
 * The same margin remains ample for encrypted relay envelopes.
 */
export const MAX_REPLICATED_PAYLOAD_BYTES = 1024 * 1024 - 1024;

/**
 * Progressive shrink passes. Each pass tightens both the per-string cap and
 * the per-array head limit; the loop stops at the first pass whose output
 * fits {@link MAX_REPLICATED_PAYLOAD_BYTES}. The schedule is concrete (not
 * recomputed) so the failure modes the helper guards against are visible:
 *
 * - One giant string → the first pass already truncates it under 64 KB.
 * - Array of many small blocks (e.g. a tool result with thousands of
 *   `{type:"text", text:"..."}` content items) → later passes head-clip the
 *   array to a small sample with a `[…N items elided]` summary element.
 *
 * The final pass clamps every string to 64 B and every array to one element,
 * so even pathological mixes converge.
 */
interface ShrinkPass {
	stringCap: number;
	arrayLimit: number;
}

const SHRINK_PASSES: readonly ShrinkPass[] = [
	{ stringCap: 64 * 1024, arrayLimit: 256 },
	{ stringCap: 16 * 1024, arrayLimit: 128 },
	{ stringCap: 4 * 1024, arrayLimit: 64 },
	{ stringCap: 1 * 1024, arrayLimit: 32 },
	{ stringCap: 256, arrayLimit: 16 },
	{ stringCap: 256, arrayLimit: 4 },
	{ stringCap: 64, arrayLimit: 1 },
];

const STRING_ELISION_RESERVE = 80;

/**
 * Recursively walk `value`, head-truncating any string longer than
 * `stringCap` and head-clipping any array longer than `arrayLimit`. Returns
 * a freshly built deep clone — every object/array is rebuilt so the
 * recursive output can be safely serialized in isolation. Cheap to call on
 * small values: short strings, numbers, and booleans pass through without
 * allocation.
 */
function shrinkWalk(value: unknown, stringCap: number, arrayLimit: number): unknown {
	if (typeof value === "string") {
		if (value.length <= stringCap) return value;
		const headLen = Math.max(0, stringCap - STRING_ELISION_RESERVE);
		return `${value.slice(0, headLen)}\n…[${value.length - headLen} chars elided for collab session]`;
	}
	if (Array.isArray(value)) {
		const keep = Math.min(value.length, arrayLimit);
		const elided = value.length - keep;
		const out: unknown[] = new Array(elided > 0 ? keep + 1 : keep);
		for (let i = 0; i < keep; i++) out[i] = shrinkWalk(value[i], stringCap, arrayLimit);
		if (elided > 0) out[keep] = `…[${elided} items elided for collab session]`;
		return out;
	}
	if (value && typeof value === "object") {
		const src = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const k in src) out[k] = shrinkWalk(src[k], stringCap, arrayLimit);
		return out;
	}
	return value;
}

/** Restore bounded response identities on the two root wire shapes this helper shrinks: events and entries. */
function restoreResponseAnchorIds(source: unknown, target: unknown): void {
	if (!source || typeof source !== "object" || Array.isArray(source)) return;
	if (!target || typeof target !== "object" || Array.isArray(target)) return;
	const sourceRecord = source as Record<string, unknown>;
	const targetRecord = target as Record<string, unknown>;
	if (isSafeResponseAnchorId(sourceRecord.responseAnchorId)) {
		targetRecord.responseAnchorId = sourceRecord.responseAnchorId;
	}
	const sourceMessage = sourceRecord.message;
	const targetMessage = targetRecord.message;
	if (!sourceMessage || typeof sourceMessage !== "object" || Array.isArray(sourceMessage)) return;
	if (!targetMessage || typeof targetMessage !== "object" || Array.isArray(targetMessage)) return;
	const nestedResponseAnchorId = (sourceMessage as Record<string, unknown>).responseAnchorId;
	if (isSafeResponseAnchorId(nestedResponseAnchorId)) {
		(targetMessage as Record<string, unknown>).responseAnchorId = nestedResponseAnchorId;
	}
}

/**
 * Return `value` unchanged when its UTF-8 JSON serialization already fits
 * {@link MAX_REPLICATED_PAYLOAD_BYTES}; otherwise return a deep-cloned
 * shadow shrunk along both string and array axes until the payload fits.
 * The function is generic over `T` because the wire shape is preserved:
 * only string leaves and array tails change. Valid `responseAnchorId` fields on
 * the root event/entry and its immediate message are restored after every pass.
 */
export function shrinkForReplication<T>(value: T): T {
	if (Buffer.byteLength(JSON.stringify(value)) <= MAX_REPLICATED_PAYLOAD_BYTES) return value;
	let shrunk: unknown = value;
	for (const pass of SHRINK_PASSES) {
		shrunk = shrinkWalk(value, pass.stringCap, pass.arrayLimit);
		restoreResponseAnchorIds(value, shrunk);
		if (Buffer.byteLength(JSON.stringify(shrunk)) <= MAX_REPLICATED_PAYLOAD_BYTES) return shrunk as T;
	}
	return shrunk as T;
}
