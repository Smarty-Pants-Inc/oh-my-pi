/**
 * AgentRegistry - Process-global registry of agents (the main session plus
 * every subagent), keyed by stable id.
 *
 * Tracks each agent's status and (when live) its AgentSession so peers can be
 * addressed by id (`hub`, `task resume`, `history://`). Sessions are
 * registered explicitly at creation; finished agents stay registered as
 * `idle` (live) or `parked` (session disposed, ref + sessionFile retained for
 * revival) and are only removed on explicit release/teardown.
 */

import type { AgentSession } from "../session/agent-session";
import { oneLineLabel } from "../task/types";
import type {
	PersistentAgentPhase,
	PersistentAgentRecordCommitGuardV1,
	PersistentAgentStore,
} from "./persistent-agent-contracts.js";

export const MAIN_AGENT_ID = "Main";

/**
 * - `running`: a turn is in flight.
 * - `idle`: live AgentSession in memory, awaiting work. Finished agents are
 *   `idle`, not removed.
 * - `parked`: session disposed; AgentRef + sessionFile retained, revivable.
 * - `aborted`: hard-killed, terminal.
 */
export type AgentStatus = "running" | "idle" | "parked" | "aborted";
/**
 * - `main`/`sub`: the user-facing agent tree (driving agent + task subagents).
 * - `advisor`: a passive review transcript persisted like a subagent for usage
 *   attribution and Agent Hub observability, but never a peer — hidden from
 *   agent-facing rosters (`hub`, `history://`) and not messageable/revivable.
 */
export type AgentKind = "main" | "sub" | "advisor";
/** Durable identity bound to this exact in-process projection. */
export interface PersistentAgentRegistryBinding {
	readonly recordRevision: number;
	readonly ownerEpoch: number;
	readonly recordPhase: PersistentAgentPhase;
}

const PERSISTENT_AGENT_PHASES: Readonly<Record<PersistentAgentPhase, true>> = {
	creating: true,
	open: true,
	parking: true,
	parked: true,
	reviving: true,
	forking: true,
	releasing: true,
	released: true,
	recovery_required: true,
};

export interface AgentRef {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	status: AgentStatus;
	/** Null exactly when parked/aborted. */
	session: AgentSession | null;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	/** Short gist of what the agent is currently doing (latest intent or tool), for the work-aware roster. Display-only. */
	activity?: string;
	/** Present only for refs projected from the durable persistent-agent store. */
	persistent?: PersistentAgentRegistryBinding;
}

export type AgentRefExpectation = AgentRef | AgentSession;

export type RegistryEvent =
	| { type: "registered"; ref: AgentRef }
	| { type: "status_changed"; ref: AgentRef }
	| { type: "removed"; ref: AgentRef };

type RegistryListener = (event: RegistryEvent) => void;

export interface RegisterInput {
	id: string;
	displayName: string;
	kind: AgentKind;
	parentId?: string;
	session: AgentSession | null;
	sessionFile?: string | null;
	status?: AgentStatus;
	persistent?: PersistentAgentRegistryBinding;
}

export class AgentRegistry {
	static #global: AgentRegistry | undefined;

	static global(): AgentRegistry {
		if (!AgentRegistry.#global) {
			AgentRegistry.#global = new AgentRegistry();
		}
		return AgentRegistry.#global;
	}

	/** Reset the global registry. Test-only. */
	static resetGlobalForTests(): void {
		AgentRegistry.#global = new AgentRegistry();
	}

	readonly #refs = new Map<string, AgentRef>();
	readonly #listeners = new Set<RegistryListener>();
	#processOwnedPersistentAgentStore: PersistentAgentStore | undefined;
	#processOwnedPersistentAgentStoreBindings = 0;

	/**
	 * Bind the sole process-owned durable store used by production registry
	 * discovery. Every live session must present the same object; a different
	 * object would split persistent identity authority and is rejected.
	 */
	bindProcessOwnedPersistentAgentStore(store: PersistentAgentStore): () => void {
		if (!store) throw new TypeError("Process-owned persistent agent store is required");
		const current = this.#processOwnedPersistentAgentStore;
		if (current && current !== store) {
			throw new TypeError("A different process-owned persistent agent store is already bound");
		}
		this.#processOwnedPersistentAgentStore = store;
		this.#processOwnedPersistentAgentStoreBindings++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#processOwnedPersistentAgentStoreBindings--;
			if (this.#processOwnedPersistentAgentStoreBindings === 0) {
				this.#processOwnedPersistentAgentStore = undefined;
			}
		};
	}

	/** Resolve the exact bound production store, failing closed when unavailable. */
	requireProcessOwnedPersistentAgentStore(): PersistentAgentStore {
		const store = this.#processOwnedPersistentAgentStore;
		if (!store) throw new TypeError("Process-owned persistent agent store authority is not bound");
		return store;
	}

	#matchesExpected(ref: AgentRef, expected?: AgentRefExpectation): boolean {
		return expected === undefined || ref === expected || ref.session === expected;
	}

	#isValidPersistentBinding(binding: PersistentAgentRegistryBinding): boolean {
		return (
			Number.isSafeInteger(binding.recordRevision) &&
			binding.recordRevision >= 1 &&
			Number.isSafeInteger(binding.ownerEpoch) &&
			binding.ownerEpoch >= 1 &&
			typeof binding.recordPhase === "string" &&
			Object.hasOwn(PERSISTENT_AGENT_PHASES, binding.recordPhase)
		);
	}

	#isPersistentIdentityCurrent(id: string, expected: AgentRef | null): boolean {
		const normalized = id.toLowerCase();
		if (expected && expected.id.toLowerCase() !== normalized) return false;
		for (const ref of this.#refs.values()) {
			if (ref.id.toLowerCase() === normalized && ref !== expected) return false;
		}
		return expected === null || this.#refs.get(expected.id) === expected;
	}

	register(input: RegisterInput): AgentRef {
		if (input.persistent && !this.#isValidPersistentBinding(input.persistent)) {
			throw new TypeError("Invalid persistent agent registry binding");
		}
		const now = Date.now();
		const ref: AgentRef = {
			id: input.id,
			displayName: input.displayName,
			kind: input.kind,
			parentId: input.parentId,
			status: input.status ?? "running",
			session: input.session,
			sessionFile: input.sessionFile ?? null,
			createdAt: now,
			lastActivity: now,
			persistent: input.persistent ? { ...input.persistent } : undefined,
		};
		this.#refs.set(ref.id, ref);
		this.#emit({ type: "registered", ref });
		return ref;
	}

	/**
	 * Register a new id only when it is absent, or reuse the exact detached
	 * `parked` ref a revival was authorized to revive. A missing, replaced, or
	 * terminal expected ref is a failed CAS: delayed revivers must never claim an
	 * id after its prior generation disappeared or was hard-killed.
	 */
	registerIfAvailable(input: RegisterInput, expected: AgentRef | null): AgentRef | undefined {
		const current = this.#refs.get(input.id);
		if (expected === null) return current ? undefined : this.register(input);
		return current === expected && current.status === "parked" && !current.session ? current : undefined;
	}

	/**
	 * Freeze the exact process-local projection that may authorize one durable
	 * record replacement. A null expectation proves the ID is still absent;
	 * otherwise both the exact ref object and its current durable coordinates
	 * must remain unchanged through the storage commit guard.
	 */
	createPersistentCommitGuard(
		id: string,
		expected: AgentRef | null,
		binding: PersistentAgentRegistryBinding | null,
	): PersistentAgentRecordCommitGuardV1 {
		if (expected === null) {
			if (binding !== null || !this.#isPersistentIdentityCurrent(id, null)) {
				throw new TypeError("Persistent agent registry absence changed");
			}
			return Object.freeze({ isCurrent: () => this.#isPersistentIdentityCurrent(id, null) });
		}
		if (binding === null) throw new TypeError("Persistent agent registry binding changed");
		const frozenBinding = Object.freeze({ ...binding });
		if (
			!this.#isValidPersistentBinding(frozenBinding) ||
			!this.#isPersistentIdentityCurrent(id, expected) ||
			!this.#samePersistentBinding(expected.persistent, frozenBinding)
		) {
			throw new TypeError("Persistent agent registry binding changed");
		}
		return Object.freeze({
			isCurrent: () =>
				this.#isPersistentIdentityCurrent(id, expected) &&
				this.#samePersistentBinding(expected.persistent, frozenBinding),
		});
	}

	#samePersistentBinding(
		current: PersistentAgentRegistryBinding | undefined,
		expected: PersistentAgentRegistryBinding,
	): boolean {
		return (
			current?.recordRevision === expected.recordRevision &&
			current.ownerEpoch === expected.ownerEpoch &&
			current.recordPhase === expected.recordPhase
		);
	}

	/**
	 * Bind a durable record revision and owner epoch to the exact live ref.
	 * Delayed lifecycle work cannot regress either authority coordinate.
	 */
	bindPersistentState(id: string, binding: PersistentAgentRegistryBinding, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected) || !this.#isValidPersistentBinding(binding)) return false;
		const current = ref.persistent;
		if (
			current &&
			(binding.recordRevision < current.recordRevision ||
				binding.ownerEpoch < current.ownerEpoch ||
				(binding.recordRevision === current.recordRevision && binding.recordPhase !== current.recordPhase))
		) {
			return false;
		}
		ref.persistent = { ...binding };
		ref.lastActivity = Date.now();
		return true;
	}

	setStatus(id: string, status: AgentStatus, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		// `aborted` is terminal: delayed progress/revival work from the killed
		// generation must never transition the tombstone back to a live status.
		if (ref.status === "aborted") return status === "aborted";
		if (ref.status === status) return true;
		ref.status = status;
		// Activity describes current work; it is meaningless once the agent
		// leaves `running`, so drop it to avoid showing stale work in rosters.
		if (status !== "running") ref.activity = undefined;
		ref.lastActivity = Date.now();
		this.#emit({ type: "status_changed", ref });
		return true;
	}

	/**
	 * Record a short activity gist for the work-aware roster. Display-only and
	 * read on demand (`irc list`, peer roster), so it emits no event — keeping
	 * the per-tool-call update rate off the registry listener path (same as
	 * `attachSession`, which also bumps `lastActivity` without emitting). Only a
	 * `running` agent has current work: a heartbeat for any other status is
	 * dropped, so a late progress flush can't resurrect activity on a ref that
	 * `setStatus` just cleared. Every running heartbeat refreshes `lastActivity`
	 * — even when the gist text is unchanged — so the roster's "active … ago" and
	 * recency sort track real work, not just the last status change.
	 * The gist is normalized to one bounded line (`oneLineLabel`) so model-derived
	 * intent text can neither break the roster nor smuggle terminal escapes —
	 * every caller is safe without sanitizing at its own call site.
	 */
	setActivity(id: string, activity: string): void {
		const ref = this.#refs.get(id);
		if (!ref) return;
		if (ref.status !== "running") return;
		const gist = oneLineLabel(activity);
		ref.lastActivity = Date.now();
		if (ref.activity === gist) return;
		ref.activity = gist;
	}

	attachSession(
		id: string,
		session: AgentSession,
		sessionFile?: string | null,
		expected?: AgentRefExpectation,
	): boolean {
		const ref = this.#refs.get(id);
		// Never attach a late-created session to a hard-killed tombstone. This
		// closes the race between a parked reviver claiming the ref and finishing
		// createAgentSession after an explicit kill.
		if (!ref || ref.status === "aborted" || !this.#matchesExpected(ref, expected)) return false;
		ref.session = session;
		if (sessionFile !== undefined) ref.sessionFile = sessionFile;
		ref.lastActivity = Date.now();
		return true;
	}

	detachSession(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		ref.session = null;
		return true;
	}

	unregister(id: string, expected?: AgentRefExpectation): boolean {
		const ref = this.#refs.get(id);
		if (!ref || !this.#matchesExpected(ref, expected)) return false;
		this.#refs.delete(id);
		this.#emit({ type: "removed", ref });
		return true;
	}

	get(id: string): AgentRef | undefined {
		return this.#refs.get(id);
	}

	list(): AgentRef[] {
		return [...this.#refs.values()];
	}

	/**
	 * Returns every alive agent (running | idle) except the caller. Advisor refs
	 * are observability-only transcripts, never peers, so they are excluded.
	 * Flat namespace: every other agent is visible.
	 */
	listVisibleTo(id: string): AgentRef[] {
		return this.list().filter(
			ref => ref.id !== id && ref.kind !== "advisor" && (ref.status === "running" || ref.status === "idle"),
		);
	}

	onChange(listener: RegistryListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event: RegistryEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(event);
			} catch {
				// listeners must not break the dispatch loop
			}
		}
	}
}
