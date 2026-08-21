import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { type AsyncJob, AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import { buildAsyncResultBatchMessage } from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";

function makeSession(settings: Settings, asyncJobManager: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
		asyncJobManager,
	};
}

function baseResult(overrides: Record<string, unknown> = {}) {
	return {
		output: "",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs: [] as unknown[],
		...overrides,
	};
}

/**
 * Mock the JS backend with a cell that streams one chunk immediately and then
 * blocks until the returned `release()` gate opens — so backgrounding is decided
 * by the tool's own threshold/steer race, never by a guessed sleep.
 */
function mockGatedCell(finalOutput: string, displayOutputs: unknown[] = []): { release: () => void } {
	const gate = Promise.withResolvers<void>();
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
		_code: string,
		options: { onChunk?: (chunk: string) => void },
	) => {
		options.onChunk?.("start\n");
		await gate.promise;
		return baseResult({ output: finalOutput, displayOutputs });
	}) as never);
	return { release: gate.resolve };
}

function steeringContext(steeringSignal: AbortSignal): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		modelRegistry: {
			find: () => undefined,
			getAll: () => [],
			getApiKey: async () => undefined,
		} as unknown as AgentToolContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		toolNames: [],
		toolCall: {
			batchId: "batch-1",
			index: 0,
			total: 1,
			toolCalls: [{ id: "call-steer", name: "eval" }],
			steeringSignal,
		},
	} as AgentToolContext;
}

/**
 * Defends the eval auto-background contract (mirror of bash's): a cell that
 * finishes before the threshold resolves inline with no job leftovers, a cell
 * that outlives the threshold converts into a running async job whose result is
 * delivered later, and a steering interrupt backgrounds the cell immediately so
 * the queued message can inject while the kernel keeps working.
 */
describe("EvalTool auto-background", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("keeps fast cells inline and suppresses their job delivery", async () => {
		const deliveries: string[] = [];
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: async (_jobId, text) => {
				deliveries.push(text);
			},
		});
		vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async () =>
			baseResult({ output: "quick\n" })) as never);

		const tool = new EvalTool(
			makeSession(
				Settings.isolated({
					"eval.autoBackground.enabled": true,
					"eval.autoBackground.thresholdMs": 2_000,
				}),
				asyncJobManager,
			),
		);
		const result = await tool.execute("call-inline", { language: "js", code: "print('quick')" });

		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("quick");
		expect(result.details?.async).toBeUndefined();
		expect(result.details?.cells?.[0]?.status).toBe("complete");
		await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
		expect(deliveries).toEqual([]);
		await asyncJobManager.dispose();
	});

	it("backgrounds a cell that outlives the threshold and delivers its result", async () => {
		const deliveries: Array<{ jobId: string; text: string }> = [];
		const updates: string[] = [];
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				deliveries.push({ jobId, text });
			},
		});
		const cell = mockGatedCell("start\ndone\n");

		const tool = new EvalTool(
			makeSession(
				Settings.isolated({
					"eval.autoBackground.enabled": true,
					"eval.autoBackground.thresholdMs": 10,
				}),
				asyncJobManager,
			),
		);
		// The gated cell cannot finish on its own, so execute() returning proves
		// the threshold path backgrounded it.
		const result = await tool.execute(
			"call-background",
			{ language: "js", code: "print('start'); await work(); print('done')" },
			undefined,
			update => {
				updates.push(update.content?.find(block => block.type === "text")?.text ?? "");
			},
		);

		expect(result.details?.async?.state).toBe("running");
		expect(result.details?.async?.type).toBe("eval");
		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("Backgrounded as job");
		// The snapshot keeps the running cell (with its streamed tail) for the transcript.
		expect(result.details?.cells?.[0]?.status).toBe("running");

		const jobId = result.details?.async?.jobId;
		if (!jobId) {
			throw new Error("expected an auto-backgrounded job id");
		}
		const runningJob = asyncJobManager.getJob(jobId);
		expect(runningJob?.status).toBe("running");
		const updatesAtBackground = updates.slice();
		cell.release();
		await runningJob?.promise;
		await asyncJobManager.drainDeliveries({ timeoutMs: 1 });
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]?.jobId).toBe(jobId);
		expect(deliveries[0]?.text).toContain("done");
		expect(runningJob?.resultContent).toEqual([{ type: "text", text: "start\ndone" }]);
		const automaticMessage = buildAsyncResultBatchMessage([
			{ jobId, result: deliveries[0]?.text ?? "", job: runningJob, durationMs: 0, epoch: 0 },
		]);
		expect(automaticMessage?.content).toEqual(expect.stringContaining("done"));
		// Tool-call updates stop once the cell is backgrounded.
		expect(updates).toEqual(updatesAtBackground);
		await asyncJobManager.dispose();
	});

	it("batches two image-bearing backgrounded cells with recoverable job boundaries", async () => {
		const sourceImages: ImageContent[] = [
			{ type: "image", data: Buffer.from([0, 1, 2, 3]).toString("base64"), mimeType: "image/png" },
			{ type: "image", data: Buffer.from([4, 5, 6, 7]).toString("base64"), mimeType: "image/png" },
		];
		const deliveries: Array<{ jobId: string; text: string; job: AsyncJob }> = [];
		const asyncJobManager = new AsyncJobManager({
			onJobComplete: (jobId, text, job) => {
				deliveries.push({ jobId, text, job });
			},
		});
		const tool = new EvalTool(
			makeSession(
				Settings.isolated({
					"eval.autoBackground.enabled": true,
					"eval.autoBackground.thresholdMs": 0,
				}),
				asyncJobManager,
			),
		);

		const runImageCell = async (
			callId: string,
			image: ImageContent,
		): Promise<{ job: AsyncJob; image: ImageContent }> => {
			vi.restoreAllMocks();
			const cell = mockGatedCell("", [image]);
			const result = await tool.execute(callId, { language: "js", code: `display(${callId})` });
			const jobId = result.details?.async?.jobId;
			if (!jobId) throw new Error("expected an image-bearing background job id");
			const job = asyncJobManager.getJob(jobId);
			if (!job) throw new Error(`missing background job ${jobId}`);
			cell.release();
			await job.promise;
			await asyncJobManager.drainDeliveries({ timeoutMs: 100 });
			const retainedImage = job.resultContent?.find((block): block is ImageContent => block.type === "image");
			if (!retainedImage) throw new Error(`missing retained image for ${jobId}`);
			return { job, image: retainedImage };
		};

		const first = await runImageCell("firstImage", sourceImages[0]!);
		const second = await runImageCell("secondImage", sourceImages[1]!);
		expect(deliveries.map(delivery => delivery.jobId)).toEqual([first.job.id, second.job.id]);

		const automaticMessage = buildAsyncResultBatchMessage(
			deliveries.map(delivery => ({
				jobId: delivery.jobId,
				result: delivery.text,
				job: delivery.job,
				durationMs: 0,
				epoch: 0,
			})),
		);
		if (!automaticMessage || !Array.isArray(automaticMessage.content)) {
			throw new Error("expected structured automatic delivery content");
		}
		const summary = automaticMessage.content[0];
		if (summary?.type !== "text") throw new Error("expected automatic delivery summary text");
		expect(summary.text).toContain(`Image #1: job \`${first.job.id}\``);
		expect(summary.text).toContain(`Image #2: job \`${second.job.id}\``);
		expect(summary.text.indexOf(`Image #1: job \`${first.job.id}\``)).toBeLessThan(
			summary.text.indexOf(`Image #2: job \`${second.job.id}\``),
		);
		expect(automaticMessage.content[1]).toBe(first.image);
		expect(automaticMessage.content[2]).toBe(second.image);

		const converted = convertToLlm([automaticMessage]);
		const developer = converted.find(message => message.role === "developer");
		if (developer?.role !== "developer" || !Array.isArray(developer.content)) {
			throw new Error("expected converted automatic summary");
		}
		const developerText = developer.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
		expect(developerText).toContain(`Image #1: job \`${first.job.id}\``);
		expect(developerText).toContain(`Image #2: job \`${second.job.id}\``);
		const user = converted.find(message => message.role === "user");
		if (user?.role !== "user" || !Array.isArray(user.content)) {
			throw new Error("expected converted automatic images");
		}
		const convertedImages = user.content.filter((block): block is ImageContent => block.type === "image");
		expect(convertedImages[0]).toBe(first.image);
		expect(convertedImages[1]).toBe(second.image);
		await asyncJobManager.dispose();
	});

	it("backgrounds a running cell when the steering signal fires mid-wait", async () => {
		const asyncJobManager = new AsyncJobManager({});
		const cell = mockGatedCell("steered\n");

		const tool = new EvalTool(
			makeSession(
				Settings.isolated({
					"eval.autoBackground.enabled": true,
					// High threshold: only the steering signal can background this.
					"eval.autoBackground.thresholdMs": 60_000,
				}),
				asyncJobManager,
			),
		);
		const steering = new AbortController();
		steering.abort();
		const result = await tool.execute(
			"call-steer",
			{ language: "js", code: "await work()" },
			undefined,
			undefined,
			steeringContext(steering.signal),
		);

		// The steer backgrounds the cell instead of killing it: the call returns a
		// running job and the cell finishes on its own.
		expect(result.details?.async?.state).toBe("running");
		const text = result.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		expect(text).toContain("Backgrounded early to handle an incoming message");
		const jobId = result.details?.async?.jobId;
		if (!jobId) {
			throw new Error("expected a steer-backgrounded job id");
		}
		const job = asyncJobManager.getJob(jobId);
		expect(job?.status).toBe("running");
		cell.release();
		await job?.promise;
		expect(asyncJobManager.getJob(jobId)?.status).toBe("completed");
		await asyncJobManager.dispose();
	});
});
