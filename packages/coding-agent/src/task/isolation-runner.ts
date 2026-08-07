/**
 * Durable transient-task isolation orchestration.
 *
 * Physical identity, creator preparation, binding, capture, and cleanup are
 * supplied by authority-bearing adapters. Presentation IDs never select a
 * directory or Git ref, and this module performs no ambient Git discovery.
 */
import type {
	ExecutionEnvironmentBinding,
	ExecutionEnvironmentLease,
	ExecutionEnvironmentProvider,
} from "../session/execution-environment";
import type {
	ConfidentialTransientTaskEnsureIsolationRequestV1,
	OrdinaryTransientTaskBoundIsolationContinuationV1,
	OrdinaryTransientTaskExecutionEnvironmentReleaseBarrierV1,
	OrdinaryTransientTaskLifecycleRunV1,
	TransientTaskOutcomePayloadByteBudgetV1,
	TransientTaskPostTerminalCleanupEvidenceV1,
	TransientTaskResultlessRepresentabilityPreflightV1,
	TransientTaskResultlessTerminalProjectionV1,
} from "../session/workspace-runtime-contracts";
import type { ToolSession } from "../tools";
import { generateCommitMessage } from "../utils/commit-message-generator";
import {
	classifyTransientTaskSingleResultProjectionV1,
	type ExecutorOptions,
	projectSingleResultToOutcomeDocumentV1,
	projectTransientTaskResultlessSourceV1,
	runSubprocess,
} from "./executor";
import type { SingleResult } from "./types";
import { type ConfidentialTransientTaskIsolationMaterializerV1, ensureIsolation } from "./worktree";

/** Build a commit-message callback for durable capture preparation. */
export type BuildCommitMessage = () => undefined | ((diff: string) => Promise<string | null>);

/** Preserve the existing model-backed message policy without granting Git authority. */
export function makeIsolationCommitMessage(session: ToolSession): BuildCommitMessage {
	return () => {
		const style = session.settings.get("task.isolation.commits");
		if (style !== "ai" || !session.modelRegistry) return undefined;
		const registry = session.modelRegistry;
		const settings = session.settings;
		const sessionId = session.getSessionId?.() ?? undefined;
		return async (diff: string) => generateCommitMessage(diff, registry, settings, sessionId);
	};
}

interface TransientTaskIsolationSettlementBaseV1 {
	readonly mergeSummary: string;
	readonly changesApplied: boolean | null;
	readonly terminalEvidence: TransientTaskPostTerminalCleanupEvidenceV1;
}

export type TransientTaskIsolationSettlementV1 = TransientTaskIsolationSettlementBaseV1 &
	(
		| {
				readonly result: SingleResult;
				readonly terminalProjection?: never;
				readonly error?: never;
		  }
		| {
				readonly result: null;
				readonly terminalProjection: TransientTaskResultlessTerminalProjectionV1;
				readonly error: unknown;
		  }
	);

/** Exact ordinary-lifecycle facets consumed by the task-layer isolation runner. */
export interface TransientTaskIsolationLifecycleAdapterV1 {
	readonly taskId: OrdinaryTransientTaskLifecycleRunV1["taskId"];
	readonly runId: OrdinaryTransientTaskLifecycleRunV1["runId"];
	readonly materializer: ConfidentialTransientTaskIsolationMaterializerV1;
	readonly ensureRequest: ConfidentialTransientTaskEnsureIsolationRequestV1;
	readonly fail: OrdinaryTransientTaskLifecycleRunV1["fail"];
	readonly finalized: OrdinaryTransientTaskLifecycleRunV1["finalized"];
	readonly isolationReady: OrdinaryTransientTaskLifecycleRunV1["isolationReady"];
	readonly releaseExecutionEnvironment: OrdinaryTransientTaskLifecycleRunV1["releaseExecutionEnvironment"];
	readonly finalizeAfterPending: OrdinaryTransientTaskLifecycleRunV1["finalizeAfterPending"];
}

export interface IsolatedRunOptions {
	baseOptions: ExecutorOptions;
	lifecycle: TransientTaskIsolationLifecycleAdapterV1;
	resultlessRepresentabilityPreflight: TransientTaskResultlessRepresentabilityPreflightV1;
	outcomePayloadBudget: TransientTaskOutcomePayloadByteBudgetV1;
	/** Provider compatibility seam; acquisition receives the same durable task/run identity. */
	executionEnvironmentProvider?: ExecutionEnvironmentProvider;
}

function lifecycleFailure(result: SingleResult, message: string): SingleResult {
	return {
		...result,
		exitCode: result.exitCode === 0 ? 1 : result.exitCode,
		error: result.error ? `${result.error}; ${message}` : message,
		patchPath: undefined,
		branchName: undefined,
		branchBaseSha: undefined,
		nestedPatches: undefined,
	};
}

function leaseFailureMessage(stage: "sync-back" | "release", lease: ExecutionEnvironmentLease, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `Execution environment ${stage} failed for lease ${JSON.stringify(lease.id)}: ${message}`;
}


async function settleLifecycleFailure(
	opts: IsolatedRunOptions,
	error: unknown,
	bound: OrdinaryTransientTaskBoundIsolationContinuationV1 | undefined,
	releaseBarrier: OrdinaryTransientTaskExecutionEnvironmentReleaseBarrierV1,
): Promise<TransientTaskIsolationSettlementV1> {
	const terminal = bound
		? await opts.lifecycle.fail({
				phase: "bound",
				projection: projectTransientTaskResultlessSourceV1(opts.resultlessRepresentabilityPreflight, "failed", {
					kind: "caught_value",
					caughtAt: "runtime",
					value: error,
				}),
				cleanupDescriptor: bound.cleanupDescriptor,
				releaseBarrier,
			})
		: await opts.lifecycle.fail({
				phase: "before_bind",
				source: { kind: "caught_value", caughtAt: "runtime", value: error },
			});
	return {
		result: null,
		terminalProjection: terminal.terminalSource,
		error,
		mergeSummary: terminal.mergeSummary,
		changesApplied: terminal.changesApplied,
		terminalEvidence: terminal.terminalEvidence,
	};
}

/**
 * Run one child only after stored claim-current isolation is durably ready and
 * bound. Every terminal path is handed to the injected ordinary lifecycle;
 * there is no direct directory/ref cleanup or post-terminal publication path.
 */
export async function runIsolatedSubprocess(opts: IsolatedRunOptions): Promise<TransientTaskIsolationSettlementV1> {
	let lease: ExecutionEnvironmentLease | undefined;
	let bound: OrdinaryTransientTaskBoundIsolationContinuationV1 | undefined;
	let releaseAttempted = false;
	let finalizationStarted = false;
	let releaseBarrier: OrdinaryTransientTaskExecutionEnvironmentReleaseBarrierV1 = { status: "not_applicable" };

	const releaseLease = async (): Promise<OrdinaryTransientTaskExecutionEnvironmentReleaseBarrierV1> => {
		if (!lease || releaseAttempted) return releaseBarrier;
		releaseAttempted = true;
		releaseBarrier = await opts.lifecycle.releaseExecutionEnvironment(lease.releaseAuthority);
		return releaseBarrier;
	};

	try {
		const ensured = await ensureIsolation(opts.lifecycle.ensureRequest, opts.lifecycle.materializer);
		if (ensured.status !== "created" && ensured.status !== "same_manifest_adopted") {
			const code = "code" in ensured ? ensured.code : "record_invariant_violation";
			throw new Error(`Task isolation unavailable: ${ensured.status}/${code}`);
		}
		bound = await opts.lifecycle.isolationReady(ensured.cleanupDescriptor);
		const isolationDir = bound.cleanupDescriptor.mergedDir;

		if (opts.executionEnvironmentProvider) {
			const acquiredLease = await opts.executionEnvironmentProvider.acquire({
				taskId: opts.lifecycle.taskId,
				runId: opts.lifecycle.runId,
				sourceRoot: isolationDir,
				...(opts.baseOptions.signal ? { signal: opts.baseOptions.signal } : {}),
			});
			if (!acquiredLease) throw new Error("Execution environment provider returned no lease");
			lease = acquiredLease;
		}

		let result = await runSubprocess({
			...opts.baseOptions,
			worktree: isolationDir,
			preloadedExtensionPaths: undefined,
			preloadedCustomToolPaths: undefined,
			...(lease
				? {
						executionEnvironment: {
							id: lease.id,
							sourceRoot: lease.sourceRoot,
							remoteRoot: lease.remoteRoot,
							bridge: lease.bridge,
						} satisfies ExecutionEnvironmentBinding,
					}
				: {}),
		});

		const executionLease = lease;
		const shouldSyncExecutionEnvironment =
			executionLease !== undefined &&
			result.exitCode === 0 &&
			!result.error &&
			!result.aborted &&
			!opts.baseOptions.signal?.aborted;
		const projection = projectSingleResultToOutcomeDocumentV1(result, opts.outcomePayloadBudget);
		const pending = await opts.lifecycle.finalized({
			projection,
			classification: classifyTransientTaskSingleResultProjectionV1(projection),
		});
		finalizationStarted = true;
		const terminal = await opts.lifecycle.finalizeAfterPending({
			cleanupDescriptor: bound.cleanupDescriptor,
			pending,
			executionEnvironment: executionLease
				? shouldSyncExecutionEnvironment
					? {
							kind: "sync_then_release",
							syncBack: () => executionLease.syncBack(opts.baseOptions.signal),
							releaseAuthority: executionLease.releaseAuthority,
						}
					: { kind: "release_only", releaseAuthority: executionLease.releaseAuthority }
				: { kind: "not_applicable" },
		});
		releaseBarrier = terminal.releaseBarrier;
		return {
			result,
			mergeSummary: terminal.mergeSummary,
			changesApplied: terminal.changesApplied,
			terminalEvidence: terminal.terminalEvidence,
		};
	} catch (error) {
		let terminalError = error;
		if (lease && !releaseAttempted && !finalizationStarted) {
			try {
				await releaseLease();
			} catch (releaseError) {
				terminalError = new Error(`${String(error)}; ${leaseFailureMessage("release", lease, releaseError)}`, {
					cause: error,
				});
			}
		}
		return settleLifecycleFailure(opts, terminalError, bound, releaseBarrier);
	}
}
