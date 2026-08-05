import * as path from "node:path";
import type {
	Agent,
	AgentMessage,
	AgentTool,
	AgentToolDirectiveSessionTransition,
	ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type { Effort, Model, ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { logger } from "@oh-my-pi/pi-utils";
import type { GoalModeState } from "../goals/state";
import type { PlanModeState } from "../plan-mode/state";
import type { CheckpointState, CompletedRewindState } from "../tools/checkpoint";
import type { TodoPhase } from "../tools/todo";
import type { InspectImageMode } from "../utils/inspect-image-mode";
import type { VibeModeState } from "../vibe/state";
import type { BashRunner, BashSessionTransition } from "./bash-runner";
import type { CustomMessage } from "./messages";
import type { ModelControls } from "./model-controls";
import type { SessionAdvisors } from "./session-advisors";
import type { PersistedSessionFileSnapshot, SessionManager, SessionManagerStateSnapshot } from "./session-manager";
import type { SessionMemory } from "./session-memory";
import type { SessionTools, SessionToolsStateTransition } from "./session-tools";
import type { TodoTracker } from "./todo-tracker";
import type { ToolChoiceQueue, ToolChoiceQueueSessionTransition } from "./tool-choice-queue";
import type { YieldQueueTransaction } from "./yield-queue";

export interface RetainedSessionTransitionCheckpoint {
	restore(options?: {
		cleanupReplacement?: boolean;
		reconcileMode?: boolean;
		rewriteRetainedEntries?: boolean;
	}): Promise<void>;
}

export interface SessionLifecycleCommitOptions {
	preserveToolState?: boolean;
	preserveAdvisorState?: boolean;
	preserveAdvisorCost?: boolean;
	finalizeProviderSessions?: () => void;
}

/** Runtime participants selected before publication and activated only afterwards. */
export interface SessionLifecycleOwnership {
	/** Wait until delivery quarantine is established before checkpoint capture. */
	ready(): Promise<void>;
	/** Drain completed retained Bash results, then quarantine later mutation before durable capture. */
	quarantineBash(): Promise<void>;
	/** Acquire fallible mutation participants after retained Bash flushing completes. */
	acquire(): Promise<void>;
	markTarget(): void;
	prepareCommit(): Promise<void>;
	selectCommit(options?: SessionLifecycleCommitOptions): Promise<void>;
	activateCommit(): Promise<void>;
	prepareRollback(): Promise<void>;
	selectRollback(): Promise<void>;
	activateRollback(): Promise<void>;
}

/** Reversible ownership whose selected side is exposed only after activation. */
export interface SessionLifecycleOutcomeOwnership {
	select(committed: boolean): void | Promise<void>;
	activate(): void | Promise<void>;
}

/** Async jobs additionally discard provisional target work during rollback preparation. */
export interface SessionLifecycleAsyncOwnership extends SessionLifecycleOutcomeOwnership {
	prepareRollback(): void | Promise<void>;
}

/** Session-change registrations select target cleanup before commit-only notification. */
export interface SessionLifecycleSessionChangeOwnership {
	selectRollback(): void | Promise<void>;
	activateCommit(): void | Promise<void>;
}

export interface SessionLifecycleOwnerHost {
	agent: Pick<Agent, "beginToolDirectiveSessionTransition">;
	bash: Pick<
		BashRunner,
		| "beginSessionTransitionAfterFlushingPending"
		| "markSessionTransition"
		| "prepareCommit"
		| "prepareRollback"
		| "finishSessionTransition"
		| "rollbackSessionTransition"
		| "awaitSessionTransition"
	>;
	advisors: Pick<
		SessionAdvisors,
		"beginSessionTransitionDelivery" | "refreshProviderIdentity" | "resetSessionState" | "clearCost"
	>;
	toolChoiceQueue: Pick<ToolChoiceQueue, "beginSessionTransition">;
	sessionTools: Pick<SessionTools, "beginSessionTransition">;
	beginAsyncOwnership(): Promise<SessionLifecycleAsyncOwnership | undefined>;
	beginLaunchCompletionOwnership(): SessionLifecycleOutcomeOwnership;
	beginSessionChangeOwnership(): SessionLifecycleSessionChangeOwnership;
}

export interface SessionLifecycleOwnerOptions {
	persistDetachedBash?: boolean;
}

export const SESSION_LIFECYCLE_PARTICIPANTS = [
	"bash",
	"asyncJobs",
	"launchCompletions",
	"advisorDelivery",
	"toolDirectives",
	"toolChoice",
	"sessionTools",
	"sessionChanges",
	"providerSessions",
	"advisorRuntime",
] as const;

export type SessionLifecycleParticipantName = (typeof SESSION_LIFECYCLE_PARTICIPANTS)[number];

type SessionLifecycleParticipantPhase =
	| "initializeMutation"
	| "initializationCleanup"
	| "markTarget"
	| "prepareCommit"
	| "selectCommit"
	| "prepareRollback"
	| "selectRollback"
	| "activateCommit"
	| "activateRollback";

type SessionLifecycleParticipantInitialization = "delivery-sync" | "delivery-async" | "mutation" | "none";

type LifecycleOperation = {
	name: string;
	run: () => void | Promise<void>;
};

type LifecycleSyncOperation = {
	run: () => void;
};

interface SessionLifecycleParticipantDefinition {
	name: SessionLifecycleParticipantName;
	initialization: SessionLifecycleParticipantInitialization;
	initialize(): void | Promise<void>;
	initializationCleanup(): readonly LifecycleOperation[];
	markTarget(): readonly LifecycleSyncOperation[];
	prepareCommit(): readonly LifecycleOperation[];
	selectCommit(options?: SessionLifecycleCommitOptions): readonly LifecycleOperation[];
	prepareRollback(): readonly LifecycleOperation[];
	selectRollback(): readonly LifecycleOperation[];
	activateCommit(options?: SessionLifecycleCommitOptions): readonly LifecycleOperation[];
	activateRollback(): readonly LifecycleOperation[];
}

type SessionLifecycleParticipantTable = {
	[K in SessionLifecycleParticipantName]: SessionLifecycleParticipantDefinition & { name: K };
};

const NO_OPERATIONS: readonly LifecycleOperation[] = [];
const NO_SYNC_OPERATIONS: readonly LifecycleSyncOperation[] = [];

const PARTICIPANT_PHASE_ORDER = {
	initializeMutation: {
		sessionChanges: 10,
		bash: 20,
		advisorDelivery: 30,
		toolDirectives: 40,
		toolChoice: 50,
		sessionTools: 60,
		asyncJobs: 70,
		launchCompletions: 80,
		providerSessions: 90,
		advisorRuntime: 100,
	},
	initializationCleanup: {
		sessionTools: 10,
		toolChoice: 20,
		toolDirectives: 30,
		advisorDelivery: 40,
		bash: 50,
		sessionChanges: 60,
		asyncJobs: 70,
		launchCompletions: 80,
		providerSessions: 90,
		advisorRuntime: 100,
	},
	markTarget: {
		bash: 10,
		asyncJobs: 20,
		launchCompletions: 30,
		advisorDelivery: 40,
		toolDirectives: 50,
		toolChoice: 60,
		sessionTools: 70,
		sessionChanges: 80,
		providerSessions: 90,
		advisorRuntime: 100,
	},
	prepareCommit: {
		bash: 10,
		asyncJobs: 20,
		launchCompletions: 30,
		advisorDelivery: 40,
		toolDirectives: 50,
		toolChoice: 60,
		sessionTools: 70,
		sessionChanges: 80,
		providerSessions: 90,
		advisorRuntime: 100,
	},
	selectCommit: {
		toolDirectives: 10,
		toolChoice: 20,
		sessionTools: 30,
		advisorDelivery: 40,
		bash: 50,
		asyncJobs: 60,
		launchCompletions: 70,
		sessionChanges: 80,
		providerSessions: 90,
		advisorRuntime: 100,
	},
	prepareRollback: {
		bash: 10,
		asyncJobs: 20,
		launchCompletions: 30,
		advisorDelivery: 40,
		toolDirectives: 50,
		toolChoice: 60,
		sessionTools: 70,
		sessionChanges: 80,
		providerSessions: 90,
		advisorRuntime: 100,
	},
	selectRollback: {
		advisorDelivery: 10,
		toolDirectives: 20,
		toolChoice: 30,
		sessionTools: 40,
		sessionChanges: 50,
		asyncJobs: 60,
		launchCompletions: 70,
		bash: 80,
		providerSessions: 90,
		advisorRuntime: 100,
	},
	activateCommit: {
		advisorDelivery: 10,
		asyncJobs: 20,
		launchCompletions: 30,
		providerSessions: 40,
		advisorRuntime: 50,
		sessionChanges: 60,
		bash: 70,
		toolDirectives: 80,
		toolChoice: 90,
		sessionTools: 100,
	},
	activateRollback: {
		advisorDelivery: 10,
		asyncJobs: 20,
		launchCompletions: 30,
		advisorRuntime: 40,
		bash: 50,
		toolDirectives: 60,
		toolChoice: 70,
		sessionTools: 80,
		sessionChanges: 90,
		providerSessions: 100,
	},
} satisfies Record<SessionLifecycleParticipantPhase, Record<SessionLifecycleParticipantName, number>>;

export type SessionLifecycleOwnerState =
	| { phase: "delivery-quarantining" }
	| { phase: "delivery-ready" }
	| { phase: "ownership-acquiring" }
	| { phase: "ownership-active"; targetMarked: boolean; commitPrepared: boolean }
	| { phase: "commit-selected"; options: SessionLifecycleCommitOptions | undefined }
	| { phase: "rollback-prepared"; ownershipAcquired: boolean }
	| { phase: "rollback-selected"; ownershipAcquired: boolean }
	| { phase: "closed"; outcome: "commit" | "rollback" }
	| { phase: "failed"; error: unknown };

function operation(name: string, run: () => void | Promise<void>): LifecycleOperation {
	return { name, run };
}

function throwFailures(failures: unknown[], aggregateMessage: string): void {
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, aggregateMessage);
}

function createParticipantTable(
	host: SessionLifecycleOwnerHost,
	options: SessionLifecycleOwnerOptions,
): SessionLifecycleParticipantTable {
	let bashTransition: BashSessionTransition | undefined;
	let asyncOwnership: SessionLifecycleAsyncOwnership | undefined;
	let launchCompletionOwnership: SessionLifecycleOutcomeOwnership | undefined;
	let advisorDeliveryTransition: YieldQueueTransaction | undefined;
	let toolDirectiveTransition: AgentToolDirectiveSessionTransition | undefined;
	let toolChoiceTransition: ToolChoiceQueueSessionTransition | undefined;
	let sessionToolsTransition: SessionToolsStateTransition | undefined;
	let sessionChangeOwnership: SessionLifecycleSessionChangeOwnership | undefined;

	return {
		bash: {
			name: "bash",
			initialization: "mutation",
			initialize: async () => {
				bashTransition ??= await host.bash.beginSessionTransitionAfterFlushingPending({
					persistDetached: options.persistDetachedBash,
				});
			},
			initializationCleanup: () =>
				bashTransition
					? [
							operation("Bash ownership", async () => {
								host.bash.finishSessionTransition(bashTransition!, false);
								await host.bash.awaitSessionTransition(bashTransition!);
							}),
						]
					: NO_OPERATIONS,
			markTarget: () =>
				bashTransition ? [{ run: () => host.bash.markSessionTransition(bashTransition!) }] : NO_SYNC_OPERATIONS,
			prepareCommit: () =>
				bashTransition
					? [operation("Bash ownership", () => host.bash.prepareCommit(bashTransition!))]
					: NO_OPERATIONS,
			selectCommit: () =>
				bashTransition
					? [
							operation("Bash ownership", async () => {
								host.bash.finishSessionTransition(bashTransition!, true);
								await host.bash.awaitSessionTransition(bashTransition!);
							}),
						]
					: NO_OPERATIONS,
			prepareRollback: () =>
				bashTransition
					? [operation("Bash ownership", () => host.bash.prepareRollback(bashTransition!))]
					: NO_OPERATIONS,
			selectRollback: () =>
				bashTransition
					? [operation("Bash ownership", () => host.bash.rollbackSessionTransition(bashTransition!))]
					: NO_OPERATIONS,
			activateCommit: () => NO_OPERATIONS,
			activateRollback: () => NO_OPERATIONS,
		},
		asyncJobs: {
			name: "asyncJobs",
			initialization: "delivery-async",
			initialize: async () => {
				asyncOwnership = await host.beginAsyncOwnership();
			},
			initializationCleanup: () =>
				asyncOwnership
					? [
							operation("async ownership selection", () => asyncOwnership!.select(false)),
							operation("async delivery", () => asyncOwnership!.activate()),
						]
					: NO_OPERATIONS,
			markTarget: () => NO_SYNC_OPERATIONS,
			prepareCommit: () => NO_OPERATIONS,
			selectCommit: () =>
				asyncOwnership ? [operation("async ownership", () => asyncOwnership!.select(true))] : NO_OPERATIONS,
			prepareRollback: () =>
				asyncOwnership ? [operation("async ownership", () => asyncOwnership!.prepareRollback())] : NO_OPERATIONS,
			selectRollback: () =>
				asyncOwnership ? [operation("async ownership", () => asyncOwnership!.select(false))] : NO_OPERATIONS,
			activateCommit: () =>
				asyncOwnership ? [operation("async delivery", () => asyncOwnership!.activate())] : NO_OPERATIONS,
			activateRollback: () =>
				asyncOwnership ? [operation("async delivery", () => asyncOwnership!.activate())] : NO_OPERATIONS,
		},
		launchCompletions: {
			name: "launchCompletions",
			initialization: "delivery-sync",
			initialize: () => {
				launchCompletionOwnership = host.beginLaunchCompletionOwnership();
			},
			initializationCleanup: () =>
				launchCompletionOwnership
					? [
							operation("launch completion ownership selection", () => launchCompletionOwnership!.select(false)),
							operation("launch completion delivery", () => launchCompletionOwnership!.activate()),
						]
					: NO_OPERATIONS,
			markTarget: () => NO_SYNC_OPERATIONS,
			prepareCommit: () => NO_OPERATIONS,
			selectCommit: () =>
				launchCompletionOwnership
					? [operation("launch completion ownership", () => launchCompletionOwnership!.select(true))]
					: NO_OPERATIONS,
			prepareRollback: () => NO_OPERATIONS,
			selectRollback: () =>
				launchCompletionOwnership
					? [operation("launch completion ownership", () => launchCompletionOwnership!.select(false))]
					: NO_OPERATIONS,
			activateCommit: () =>
				launchCompletionOwnership
					? [operation("launch completion delivery", () => launchCompletionOwnership!.activate())]
					: NO_OPERATIONS,
			activateRollback: () =>
				launchCompletionOwnership
					? [operation("launch completion delivery", () => launchCompletionOwnership!.activate())]
					: NO_OPERATIONS,
		},
		advisorDelivery: {
			name: "advisorDelivery",
			initialization: "mutation",
			initialize: () => {
				advisorDeliveryTransition = host.advisors.beginSessionTransitionDelivery();
			},
			initializationCleanup: () =>
				advisorDeliveryTransition
					? [
							operation("advisor delivery ownership selection", () => advisorDeliveryTransition!.rollback()),
							operation("advisor delivery ownership", () => advisorDeliveryTransition!.activate()),
						]
					: NO_OPERATIONS,
			markTarget: () => NO_SYNC_OPERATIONS,
			prepareCommit: () => NO_OPERATIONS,
			selectCommit: commitOptions =>
				advisorDeliveryTransition
					? [
							operation("advisor delivery ownership", () => {
								if (commitOptions?.preserveAdvisorState) advisorDeliveryTransition!.rollback();
								else advisorDeliveryTransition!.commit();
							}),
						]
					: NO_OPERATIONS,
			prepareRollback: () => NO_OPERATIONS,
			selectRollback: () =>
				advisorDeliveryTransition
					? [operation("advisor delivery ownership", () => advisorDeliveryTransition!.rollback())]
					: NO_OPERATIONS,
			activateCommit: () =>
				advisorDeliveryTransition
					? [operation("advisor delivery ownership", () => advisorDeliveryTransition!.activate())]
					: NO_OPERATIONS,
			activateRollback: () =>
				advisorDeliveryTransition
					? [operation("advisor delivery ownership", () => advisorDeliveryTransition!.activate())]
					: NO_OPERATIONS,
		},
		toolDirectives: {
			name: "toolDirectives",
			initialization: "mutation",
			initialize: () => {
				toolDirectiveTransition = host.agent.beginToolDirectiveSessionTransition();
			},
			initializationCleanup: () =>
				toolDirectiveTransition
					? [operation("tool directive ownership", () => toolDirectiveTransition!.rollback())]
					: NO_OPERATIONS,
			markTarget: () => NO_SYNC_OPERATIONS,
			prepareCommit: () => NO_OPERATIONS,
			selectCommit: commitOptions =>
				toolDirectiveTransition
					? [
							operation("tool directive ownership", () => {
								if (commitOptions?.preserveToolState) toolDirectiveTransition!.rollback();
								else toolDirectiveTransition!.commit();
							}),
						]
					: NO_OPERATIONS,
			prepareRollback: () => NO_OPERATIONS,
			selectRollback: () =>
				toolDirectiveTransition
					? [operation("tool directive ownership", () => toolDirectiveTransition!.rollback())]
					: NO_OPERATIONS,
			activateCommit: () => NO_OPERATIONS,
			activateRollback: () => NO_OPERATIONS,
		},
		toolChoice: {
			name: "toolChoice",
			initialization: "mutation",
			initialize: () => {
				toolChoiceTransition = host.toolChoiceQueue.beginSessionTransition();
			},
			initializationCleanup: () =>
				toolChoiceTransition
					? [operation("tool choice ownership", () => toolChoiceTransition!.rollback())]
					: NO_OPERATIONS,
			markTarget: () => NO_SYNC_OPERATIONS,
			prepareCommit: () => NO_OPERATIONS,
			selectCommit: commitOptions =>
				toolChoiceTransition
					? [
							operation("tool choice ownership", () => {
								if (commitOptions?.preserveToolState) toolChoiceTransition!.rollback();
								else toolChoiceTransition!.commit();
							}),
						]
					: NO_OPERATIONS,
			prepareRollback: () => NO_OPERATIONS,
			selectRollback: () =>
				toolChoiceTransition
					? [operation("tool choice ownership", () => toolChoiceTransition!.rollback())]
					: NO_OPERATIONS,
			activateCommit: () => NO_OPERATIONS,
			activateRollback: () => NO_OPERATIONS,
		},
		sessionTools: {
			name: "sessionTools",
			initialization: "mutation",
			initialize: () => {
				sessionToolsTransition = host.sessionTools.beginSessionTransition();
			},
			initializationCleanup: () =>
				sessionToolsTransition
					? [operation("session tool ownership", () => sessionToolsTransition!.rollback())]
					: NO_OPERATIONS,
			markTarget: () => NO_SYNC_OPERATIONS,
			prepareCommit: () => NO_OPERATIONS,
			selectCommit: commitOptions =>
				sessionToolsTransition
					? [
							operation("session tool ownership", () => {
								if (commitOptions?.preserveToolState) sessionToolsTransition!.rollback();
								else sessionToolsTransition!.commit();
							}),
						]
					: NO_OPERATIONS,
			prepareRollback: () => NO_OPERATIONS,
			selectRollback: () =>
				sessionToolsTransition
					? [operation("session tool ownership", () => sessionToolsTransition!.rollback())]
					: NO_OPERATIONS,
			activateCommit: () => NO_OPERATIONS,
			activateRollback: () => NO_OPERATIONS,
		},
		sessionChanges: {
			name: "sessionChanges",
			initialization: "mutation",
			initialize: () => {
				sessionChangeOwnership = host.beginSessionChangeOwnership();
			},
			initializationCleanup: () => NO_OPERATIONS,
			markTarget: () => NO_SYNC_OPERATIONS,
			prepareCommit: () => NO_OPERATIONS,
			selectCommit: () => NO_OPERATIONS,
			prepareRollback: () => NO_OPERATIONS,
			selectRollback: () =>
				sessionChangeOwnership
					? [operation("session change registrations", () => sessionChangeOwnership!.selectRollback())]
					: NO_OPERATIONS,
			activateCommit: () =>
				sessionChangeOwnership
					? [operation("session change callbacks", () => sessionChangeOwnership!.activateCommit())]
					: NO_OPERATIONS,
			activateRollback: () => NO_OPERATIONS,
		},
		providerSessions: {
			name: "providerSessions",
			initialization: "none",
			initialize: () => {},
			initializationCleanup: () => NO_OPERATIONS,
			markTarget: () => NO_SYNC_OPERATIONS,
			prepareCommit: () => NO_OPERATIONS,
			selectCommit: () => NO_OPERATIONS,
			prepareRollback: () => NO_OPERATIONS,
			selectRollback: () => NO_OPERATIONS,
			activateCommit: commitOptions =>
				commitOptions?.finalizeProviderSessions
					? [operation("provider finalization", commitOptions.finalizeProviderSessions)]
					: NO_OPERATIONS,
			activateRollback: () => NO_OPERATIONS,
		},
		advisorRuntime: {
			name: "advisorRuntime",
			initialization: "none",
			initialize: () => {},
			initializationCleanup: () => NO_OPERATIONS,
			markTarget: () => NO_SYNC_OPERATIONS,
			prepareCommit: () => NO_OPERATIONS,
			selectCommit: () => NO_OPERATIONS,
			prepareRollback: () => NO_OPERATIONS,
			selectRollback: () => NO_OPERATIONS,
			activateCommit: commitOptions => {
				if (!advisorDeliveryTransition) return NO_OPERATIONS;
				const operations: LifecycleOperation[] = [
					operation("advisor provider identity", () => host.advisors.refreshProviderIdentity()),
				];
				if (commitOptions?.preserveAdvisorState) {
					if (!commitOptions.preserveAdvisorCost) {
						operations.push(operation("advisor cost", () => host.advisors.clearCost()));
					}
				} else {
					operations.push(
						operation("advisor session state", () =>
							host.advisors.resetSessionState({
								preserveCost: commitOptions?.preserveAdvisorCost,
								preserveDeliveries: true,
							}),
						),
					);
				}
				return operations;
			},
			activateRollback: () =>
				advisorDeliveryTransition
					? [operation("advisor provider identity", () => host.advisors.refreshProviderIdentity())]
					: NO_OPERATIONS,
		},
	};
}

/** Owns participant acquisition, reversible selection, and post-publication activation. */
export class SessionLifecycleOwner implements SessionLifecycleOwnership {
	#state: SessionLifecycleOwnerState = { phase: "delivery-quarantining" };
	readonly #participants: readonly SessionLifecycleParticipantDefinition[];
	readonly #bashParticipant: SessionLifecycleParticipantDefinition;
	readonly #deliveryAcquisition: Promise<{ ok: true } | { ok: false; error: unknown }>;
	#readyPromise: Promise<void> | undefined;

	constructor(host: SessionLifecycleOwnerHost, options: SessionLifecycleOwnerOptions = {}) {
		const table = createParticipantTable(host, options);
		this.#participants = SESSION_LIFECYCLE_PARTICIPANTS.map(name => table[name]);
		this.#bashParticipant = table.bash;
		const launchCompletions = table.launchCompletions;
		if (launchCompletions.initialization !== "delivery-sync") {
			throw new Error("Launch completion lifecycle participant must initialize synchronously");
		}
		launchCompletions.initialize();
		const asyncJobs = table.asyncJobs;
		if (asyncJobs.initialization !== "delivery-async") {
			throw new Error("Async job lifecycle participant must initialize asynchronously");
		}
		this.#deliveryAcquisition = Promise.resolve(asyncJobs.initialize()).then(
			() => ({ ok: true as const }),
			error => ({ ok: false as const, error }),
		);
	}

	get state(): SessionLifecycleOwnerState {
		return this.#state;
	}

	ready(): Promise<void> {
		if (this.#state.phase === "failed") return Promise.reject(this.#state.error);
		if (this.#state.phase !== "delivery-quarantining") return Promise.resolve();
		this.#readyPromise ??= this.#establishDeliveryQuarantine();
		return this.#readyPromise;
	}

	async quarantineBash(): Promise<void> {
		if (this.#state.phase === "failed") throw this.#state.error;
		if (this.#state.phase === "closed") throw new Error("Lifecycle ownership is closed");
		if (this.#state.phase === "delivery-quarantining") {
			throw new Error("Lifecycle delivery quarantine is not ready");
		}
		await this.#bashParticipant.initialize();
	}

	async acquire(): Promise<void> {
		if (this.#ownershipAcquired()) return;
		if (this.#state.phase === "failed") throw this.#state.error;
		if (this.#state.phase === "closed") throw new Error("Lifecycle ownership is closed");
		if (this.#state.phase === "delivery-quarantining") await this.ready();
		this.#state = { phase: "ownership-acquiring" };
		try {
			for (const participant of this.#orderedParticipants("initializeMutation")) {
				if (participant.initialization === "mutation") await participant.initialize();
			}
			this.#state = { phase: "ownership-active", targetMarked: false, commitPrepared: false };
		} catch (error) {
			await this.#closeFailedInitialization(error);
		}
	}

	markTarget(): void {
		const state = this.#requireOwnership();
		if (state.phase === "commit-selected" || state.phase === "rollback-selected") return;
		if (state.phase !== "ownership-active") throw new Error("Lifecycle mutation ownership is unavailable");
		if (state.targetMarked) return;
		this.#state = { ...state, targetMarked: true };
		for (const participant of this.#orderedParticipants("markTarget")) {
			for (const targetOperation of participant.markTarget()) targetOperation.run();
		}
	}

	async prepareCommit(): Promise<void> {
		const state = this.#requireOwnership();
		if (state.phase === "commit-selected" || state.phase === "rollback-selected") return;
		if (state.phase !== "ownership-active") throw new Error("Lifecycle mutation ownership is unavailable");
		if (state.commitPrepared) return;
		await this.#runPhase("prepareCommit", participant => participant.prepareCommit());
		this.#state = { ...state, commitPrepared: true };
	}

	async selectCommit(options?: SessionLifecycleCommitOptions): Promise<void> {
		const state = this.#requireOwnership();
		if (state.phase === "commit-selected") return;
		if (state.phase === "rollback-selected") throw new Error("Lifecycle rollback ownership is already selected");
		if (state.phase !== "ownership-active") throw new Error("Lifecycle mutation ownership is unavailable");
		const failures: unknown[] = [];
		if (!state.commitPrepared) {
			failures.push(new Error("Lifecycle ownership selected commit without successful preparation"));
		}
		await this.#attemptPhase("selectCommit", participant => participant.selectCommit(options), failures);
		throwFailures(failures, "Lifecycle commit owner selection was incomplete");
		this.#state = { phase: "commit-selected", options };
	}

	async activateCommit(): Promise<void> {
		if (this.#state.phase === "closed") return;
		const state = this.#requireOwnership();
		if (state.phase !== "commit-selected") throw new Error("Lifecycle commit activated before target selection");
		this.#state = { phase: "closed", outcome: "commit" };
		await this.#activatePhase(
			"activateCommit",
			participant => participant.activateCommit(state.options),
			"Lifecycle commit participant activation failed after host publication",
		);
	}

	async prepareRollback(): Promise<void> {
		if (
			this.#state.phase === "failed" ||
			this.#state.phase === "closed" ||
			this.#state.phase === "rollback-prepared" ||
			this.#state.phase === "rollback-selected"
		) {
			return;
		}
		try {
			await this.ready();
		} catch {
			return;
		}
		const ownershipAcquired = this.#ownershipAcquired();
		this.#state = { phase: "rollback-prepared", ownershipAcquired };
		const failures: unknown[] = [];
		await this.#attemptPhase("prepareRollback", participant => participant.prepareRollback(), failures);
		throwFailures(failures, "Lifecycle rollback preparation was incomplete");
	}

	async selectRollback(): Promise<void> {
		if (
			this.#state.phase === "failed" ||
			this.#state.phase === "closed" ||
			this.#state.phase === "rollback-selected"
		) {
			return;
		}
		try {
			await this.ready();
		} catch {
			return;
		}
		const ownershipAcquired = this.#ownershipAcquired();
		this.#state = { phase: "rollback-selected", ownershipAcquired };
		const failures: unknown[] = [];
		await this.#attemptPhase("selectRollback", participant => participant.selectRollback(), failures);
		throwFailures(failures, "Lifecycle runtime ownership rollback was incomplete");
	}

	async activateRollback(): Promise<void> {
		if (this.#state.phase === "failed" || this.#state.phase === "closed") return;
		if (this.#state.phase !== "rollback-selected") {
			throw new Error("Lifecycle rollback activated before retained selection");
		}
		this.#state = { phase: "closed", outcome: "rollback" };
		await this.#activatePhase(
			"activateRollback",
			participant => participant.activateRollback(),
			"Lifecycle rollback participant activation failed after host publication",
		);
	}

	async #establishDeliveryQuarantine(): Promise<void> {
		const acquisition = await this.#deliveryAcquisition;
		if (acquisition.ok) {
			this.#state = { phase: "delivery-ready" };
			return;
		}
		const failures: unknown[] = [acquisition.error];
		await this.#attemptPhase("initializationCleanup", participant => participant.initializationCleanup(), failures);
		const failure =
			failures.length === 1
				? failures[0]
				: new AggregateError(failures, "Lifecycle delivery quarantine initialization was incomplete");
		this.#state = { phase: "failed", error: failure };
		throw failure;
	}

	async #closeFailedInitialization(error: unknown): Promise<never> {
		const failures: unknown[] = [error];
		await this.#attemptPhase("initializationCleanup", participant => participant.initializationCleanup(), failures);
		const failure =
			failures.length === 1
				? failures[0]
				: new AggregateError(failures, "Lifecycle ownership initialization failed and cleanup was incomplete");
		this.#state = { phase: "failed", error: failure };
		throw failure;
	}

	#orderedParticipants(phase: SessionLifecycleParticipantPhase): SessionLifecycleParticipantDefinition[] {
		return [...this.#participants].sort(
			(left, right) => PARTICIPANT_PHASE_ORDER[phase][left.name] - PARTICIPANT_PHASE_ORDER[phase][right.name],
		);
	}

	async #runPhase(
		phase: SessionLifecycleParticipantPhase,
		operations: (participant: SessionLifecycleParticipantDefinition) => readonly LifecycleOperation[],
	): Promise<void> {
		for (const participant of this.#orderedParticipants(phase)) {
			for (const participantOperation of operations(participant)) await participantOperation.run();
		}
	}

	async #attemptPhase(
		phase: SessionLifecycleParticipantPhase,
		operations: (participant: SessionLifecycleParticipantDefinition) => readonly LifecycleOperation[],
		failures: unknown[],
	): Promise<void> {
		for (const participant of this.#orderedParticipants(phase)) {
			for (const participantOperation of operations(participant)) {
				try {
					await participantOperation.run();
				} catch (error) {
					failures.push(error);
				}
			}
		}
	}

	async #activatePhase(
		phase: "activateCommit" | "activateRollback",
		operations: (participant: SessionLifecycleParticipantDefinition) => readonly LifecycleOperation[],
		message: string,
	): Promise<void> {
		for (const participant of this.#orderedParticipants(phase)) {
			for (const participantOperation of operations(participant)) {
				try {
					await participantOperation.run();
				} catch (error) {
					logger.error(message, {
						participant: participantOperation.name,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
	}

	#ownershipAcquired(): boolean {
		switch (this.#state.phase) {
			case "ownership-active":
			case "commit-selected":
				return true;
			case "rollback-prepared":
			case "rollback-selected":
				return this.#state.ownershipAcquired;
			default:
				return false;
		}
	}

	#requireOwnership():
		| Extract<SessionLifecycleOwnerState, { phase: "ownership-active" }>
		| Extract<SessionLifecycleOwnerState, { phase: "commit-selected" }>
		| Extract<SessionLifecycleOwnerState, { phase: "rollback-selected" }> {
		if (!this.#ownershipAcquired() || this.#state.phase === "closed" || this.#state.phase === "failed") {
			throw new Error("Lifecycle mutation ownership is unavailable");
		}
		if (
			this.#state.phase !== "ownership-active" &&
			this.#state.phase !== "commit-selected" &&
			this.#state.phase !== "rollback-selected"
		) {
			throw new Error("Lifecycle mutation ownership is unavailable");
		}
		return this.#state;
	}
}

export interface RetainedSessionRuntimeFields {
	pendingNextTurnMessages: CustomMessage[];
	scheduledHiddenNextTurnGeneration: number | undefined;
	freshProviderSessionId: string | undefined;
	inheritedProviderPromptCacheKey: string | undefined;
	observedSessionId: string | undefined;
	checkpointState: CheckpointState | undefined;
	pendingRewindReport: string | undefined;
	lastCompletedRewind: CompletedRewindState | undefined;
	rewoundToolResultIds: Set<string>;
	planModeState: PlanModeState | undefined;
	vibeModeState: VibeModeState | undefined;
	goalModeState: GoalModeState | undefined;
	inspectImageModeOverride: InspectImageMode | undefined;
	goalTurnCounter: number;
	planReferenceSent: boolean;
	planReferencePath: string;
	planModeReminderCount: number;
	planModeReminderAwaitingProgress: boolean;
}

export interface RetainedSessionRuntimeCheckpoint extends RetainedSessionRuntimeFields {
	sessionManagerState: SessionManagerStateSnapshot;
	persistedSessionFile: PersistedSessionFileSnapshot | undefined;
	agentMessages: AgentMessage[];
	steeringMessages: AgentMessage[];
	followUpMessages: AgentMessage[];
	model: Model | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	autoThinking: boolean;
	autoResolvedThinkingLevel: Effort | undefined;
	serviceTierByFamily: ServiceTierByFamily;
	tools: AgentTool[];
	activeToolNames: string[];
	mountedToolNames: string[];
	baseSystemPrompt: string[];
	systemPrompt: string[];
	memoryPromotionSnapshot: string[] | undefined;
	agentPromptCacheKey: string | undefined;
	todoPhases: TodoPhase[];
	advisorCosts: ReadonlyMap<string, number>;
}

export interface RetainedSessionCheckpointHost {
	sessionManager: Pick<
		SessionManager,
		| "capturePersistedSessionFile"
		| "captureState"
		| "getSessionFile"
		| "dropSession"
		| "restoreState"
		| "restorePersistedSessionFile"
		| "rewriteEntries"
	>;
	agent: Pick<
		Agent,
		| "state"
		| "peekSteeringQueue"
		| "peekFollowUpQueue"
		| "promptCacheKey"
		| "setModel"
		| "setTools"
		| "setSystemPrompt"
		| "replaceMessages"
		| "replaceQueues"
	>;
	models: Pick<
		ModelControls,
		| "thinkingLevel"
		| "isAutoThinking"
		| "autoResolvedThinkingLevel"
		| "serviceTierByFamily"
		| "restoreThinkingSnapshot"
		| "restoreServiceTiers"
	>;
	tools: Pick<
		SessionTools,
		| "getActiveToolNames"
		| "getMountedXdevToolNames"
		| "baseSystemPrompt"
		| "setActiveToolPresentation"
		| "setBaseSystemPrompt"
	>;
	memory: Pick<SessionMemory, "promotionSnapshot" | "rekeyForCurrentSessionId" | "restorePromotionSnapshot">;
	todo: Pick<TodoTracker, "phases" | "setPhases">;
	advisors: Pick<SessionAdvisors, "captureCostSnapshot" | "restoreCost">;
	model(): Model | undefined;
	captureRuntimeFields(): RetainedSessionRuntimeFields;
	restoreRuntimeFields(checkpoint: RetainedSessionRuntimeFields): void;
	syncAgentSessionId(sessionId: string): void;
	reconcile(): void | Promise<void>;
	emitModelChanged(): void | Promise<void>;
}

/** Capture retained durable bytes first, then the exact manager and runtime state describing them. */
export async function captureRetainedSessionCheckpoint(
	host: RetainedSessionCheckpointHost,
	options: { capturePersistedSessionFile?: boolean } = {},
): Promise<RetainedSessionTransitionCheckpoint> {
	const persistedSessionFile = options.capturePersistedSessionFile
		? await host.sessionManager.capturePersistedSessionFile()
		: undefined;
	const sessionManagerState = host.sessionManager.captureState();
	const agentMessages = [...host.agent.state.messages];
	const steeringMessages = [...host.agent.peekSteeringQueue()];
	const followUpMessages = [...host.agent.peekFollowUpQueue()];
	const runtimeFields = host.captureRuntimeFields();
	const checkpoint: RetainedSessionRuntimeCheckpoint = {
		sessionManagerState,
		persistedSessionFile,
		agentMessages,
		steeringMessages,
		followUpMessages,
		...runtimeFields,
		model: host.model(),
		thinkingLevel: host.models.thinkingLevel,
		autoThinking: host.models.isAutoThinking,
		autoResolvedThinkingLevel: host.models.autoResolvedThinkingLevel,
		serviceTierByFamily: host.models.serviceTierByFamily,
		tools: [...host.agent.state.tools],
		activeToolNames: host.tools.getActiveToolNames(),
		mountedToolNames: host.tools.getMountedXdevToolNames(),
		baseSystemPrompt: host.tools.baseSystemPrompt,
		systemPrompt: host.agent.state.systemPrompt,
		memoryPromotionSnapshot: host.memory.promotionSnapshot,
		agentPromptCacheKey: host.agent.promptCacheKey,
		todoPhases: host.todo.phases,
		advisorCosts: host.advisors.captureCostSnapshot(),
	};
	return {
		restore: restoreOptions => restoreRetainedSessionCheckpoint(host, checkpoint, restoreOptions),
	};
}

async function restoreRetainedSessionCheckpoint(
	host: RetainedSessionCheckpointHost,
	checkpoint: RetainedSessionRuntimeCheckpoint,
	options: {
		cleanupReplacement?: boolean;
		reconcileMode?: boolean;
		rewriteRetainedEntries?: boolean;
	} = {},
): Promise<void> {
	const restorationErrors: unknown[] = [];
	const attemptRestore = async (restore: () => void | Promise<void>): Promise<void> => {
		try {
			await restore();
		} catch (error) {
			restorationErrors.push(error);
		}
	};
	const replacementSessionFile = host.sessionManager.getSessionFile();
	const retainedSessionFile = checkpoint.sessionManagerState.sessionFile;
	if (
		options.cleanupReplacement &&
		replacementSessionFile &&
		(!retainedSessionFile || path.resolve(replacementSessionFile) !== path.resolve(retainedSessionFile))
	) {
		await attemptRestore(() => host.sessionManager.dropSession(replacementSessionFile));
	}

	const restoreSessionManager = async (): Promise<void> => {
		await attemptRestore(() => host.sessionManager.restoreState(checkpoint.sessionManagerState));
		if (options.rewriteRetainedEntries && checkpoint.persistedSessionFile) {
			let restoredPersistedFile: boolean | undefined;
			await attemptRestore(async () => {
				restoredPersistedFile = await host.sessionManager.restorePersistedSessionFile(
					checkpoint.persistedSessionFile,
				);
			});
			if (restoredPersistedFile === false) {
				restorationErrors.push(new Error("Retained session journal preimage could not be restored"));
				await attemptRestore(() => host.sessionManager.rewriteEntries());
			}
			// Durable restoration updates writer/title bookkeeping as a side effect;
			// reapply the deep snapshot so every in-memory field remains exact too.
			await attemptRestore(() => host.sessionManager.restoreState(checkpoint.sessionManagerState));
		}
	};
	const modelBeforeRollback = host.model();
	const restoreRuntime = async (): Promise<void> => {
		await attemptRestore(() => host.restoreRuntimeFields(checkpoint));
		await attemptRestore(() => host.syncAgentSessionId(checkpoint.sessionManagerState.sessionId));
		await attemptRestore(() => {
			host.agent.promptCacheKey = checkpoint.agentPromptCacheKey;
		});
		await attemptRestore(() => host.memory.rekeyForCurrentSessionId());
		await attemptRestore(() => {
			if (checkpoint.model) host.agent.setModel(checkpoint.model);
		});
		await attemptRestore(() =>
			host.models.restoreThinkingSnapshot(
				checkpoint.thinkingLevel,
				checkpoint.autoThinking,
				checkpoint.autoResolvedThinkingLevel,
			),
		);
		await attemptRestore(() => host.models.restoreServiceTiers(checkpoint.serviceTierByFamily));
		await attemptRestore(() =>
			host.tools.setActiveToolPresentation(
				[...checkpoint.activeToolNames, ...checkpoint.mountedToolNames],
				checkpoint.mountedToolNames,
			),
		);
		await attemptRestore(() => host.agent.setTools(checkpoint.tools));
		await attemptRestore(() => host.tools.setBaseSystemPrompt(checkpoint.baseSystemPrompt));
		await attemptRestore(() => host.memory.restorePromotionSnapshot(checkpoint.memoryPromotionSnapshot));
		await attemptRestore(() => host.agent.setSystemPrompt(checkpoint.systemPrompt));
		await attemptRestore(() => host.agent.replaceMessages(checkpoint.agentMessages));
		await attemptRestore(() => host.agent.replaceQueues(checkpoint.steeringMessages, checkpoint.followUpMessages));
		await attemptRestore(() => host.todo.setPhases(checkpoint.todoPhases));
		await attemptRestore(() => host.advisors.restoreCost(checkpoint.advisorCosts));
	};

	await restoreSessionManager();
	await restoreRuntime();
	if (options.reconcileMode) {
		await attemptRestore(() => host.reconcile());
		// Reconciliation can mutate titles, entries, durable JSONL, and runtime.
		// Reapply the complete checkpoint regardless of whether it succeeded.
		await restoreSessionManager();
		await restoreRuntime();
		// Runtime restoration can invoke presentation hooks; make the manager and
		// exact durable bytes the final authoritative restoration before publication.
		await restoreSessionManager();
	}
	if (checkpoint.model && !modelsAreEqual(modelBeforeRollback, checkpoint.model)) {
		await attemptRestore(() => host.emitModelChanged());
	}
	if (restorationErrors.length > 0) {
		throw new AggregateError(restorationErrors, "Retained session restoration was incomplete");
	}
}
