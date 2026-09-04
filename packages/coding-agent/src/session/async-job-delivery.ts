/**
 * Owner-routed async job delivery: formatting and batch-message assembly for
 * `async-result` follow-ups.
 *
 * Each {@link AgentSession} registers a delivery sink for its own agent id
 * (`AsyncJobManager.registerDeliverySink`) and enqueues formatted entries on
 * its yield queue; the queue's idle flush injects them as a follow-up turn.
 * This replaces the old single hardwired `onJobComplete` closure that routed
 * every completion — regardless of owner — into the first top-level session.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AsyncJob, AsyncJobType } from "../async";
import asyncResultTemplate from "../prompts/tools/async-result.md" with { type: "text" };
import type { StructuredSubagentOutput } from "../task/types";
import type { CustomMessage } from "./messages";
import { truncateMiddle } from "./streaming-output";

/**
 * `customType` of the injected async-result follow-up message. The task
 * executor's run monitor matches on it to invalidate a previously recorded
 * yield: a result injected after the yield supersedes that yield's payload.
 */
export const ASYNC_RESULT_MESSAGE_TYPE = "async-result";

/** Result payloads longer than this spill to an artifact with an inline preview. */
export const ASYNC_INLINE_RESULT_MAX_CHARS = 12_000;
export const ASYNC_PREVIEW_MAX_CHARS = 4_000;

export interface AsyncResultEntry {
	jobId: string;
	result: string;
	job: AsyncJob | undefined;
	durationMs: number | undefined;
	/**
	 * Owning session's async-delivery generation at enqueue time. A session
	 * transition (`/new`, switch, handoff) bumps the generation, so an entry
	 * whose generation no longer matches belongs to a replaced transcript and
	 * is dropped at flush — even after its job id has been reused, which clears
	 * the manager's per-id suppression marker.
	 */
	epoch: number;
	originTurnId?: string;
}

type AsyncResultJobDetails = {
	jobId: string;
	type?: AsyncJobType;
	label?: string;
	durationMs?: number;
	originTurnId?: string;
	/** Full structured payload (source/mode/status/data/error), when the job used an output schema. */
	schema?: StructuredSubagentOutput;
};

export type AsyncResultDetails = {
	jobs: AsyncResultJobDetails[];
};
export function buildAsyncResultImageAttachments(
	jobs: readonly { jobId: string; resultContent?: AsyncJob["resultContent"] }[],
): { images: ImageContent[]; orderText?: string } {
	const images: ImageContent[] = [];
	const orderLines: string[] = [];
	for (const job of jobs) {
		const jobImages = job.resultContent?.filter((block): block is ImageContent => block.type === "image") ?? [];
		for (const [index, image] of jobImages.entries()) {
			images.push(image);
			orderLines.push(
				`- Image #${images.length}: job \`${job.jobId}\` (result image ${index + 1} of ${jobImages.length})`,
			);
		}
	}
	return {
		images,
		...(orderLines.length > 0
			? { orderText: `Attached image order (preserved below):\n${orderLines.join("\n")}` }
			: {}),
	};
}

/**
 * Compact, size-capped JSON block for the delivery text, used only for
 * schema-invalid/error results (valid results point to `agent://<jobId>`
 * instead, since the sidecar's `<output>` block already carries the full
 * JSON — no need to duplicate it here).
 */
export function renderStructuredJson(structured: StructuredSubagentOutput): string | undefined {
	if (!Object.hasOwn(structured, "data")) return undefined;
	let serialized: string;
	try {
		serialized = JSON.stringify(structured.data, null, 2) ?? "null";
	} catch {
		return undefined;
	}
	return truncateMiddle(serialized, { maxBytes: ASYNC_PREVIEW_MAX_CHARS }).content;
}

export function buildAsyncResultBatchMessage(entries: AsyncResultEntry[]): CustomMessage<AsyncResultDetails> | null {
	if (entries.length === 0) return null;
	const jobs = entries.map(entry => {
		const structured = entry.job?.structured;
		const hasStructuredData = structured ? Object.hasOwn(structured, "data") : false;
		const structuredJson = structured && structured.status !== "valid" ? renderStructuredJson(structured) : undefined;
		return {
			jobId: entry.jobId,
			agentUrlId: entry.job?.agentId ?? entry.jobId,
			result: entry.result,
			type: entry.job?.type,
			label: entry.job?.label,
			durationMs: entry.durationMs,
			originTurnId: entry.originTurnId,
			structured,
			structuredJson,
			hasStructuredData,
			schemaStatus: structured?.status,
			schemaError: structured?.error,
			schemaValid: structured?.status === "valid",
		};
	});
	const details: AsyncResultDetails = {
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			type: job.type,
			label: job.label,
			durationMs: job.durationMs,
			originTurnId: job.originTurnId,
			...(job.structured ? { schema: job.structured } : {}),
		})),
	};
	const rendered = prompt.render(asyncResultTemplate, {
		multiple: jobs.length > 1,
		jobs,
	});
	const attachments = buildAsyncResultImageAttachments(
		entries.map(entry => ({ jobId: entry.jobId, resultContent: entry.job?.resultContent })),
	);
	const renderedWithImageOrder = attachments.orderText ? `${rendered}\n\n${attachments.orderText}` : rendered;
	return {
		role: "custom",
		customType: ASYNC_RESULT_MESSAGE_TYPE,
		content:
			attachments.images.length > 0
				? [{ type: "text", text: renderedWithImageOrder }, ...attachments.images]
				: renderedWithImageOrder,
		display: true,
		attribution: "agent",
		details,
		timestamp: Date.now(),
	};
}
