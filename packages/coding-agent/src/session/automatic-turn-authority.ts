export type AutomaticTurnSource =
	| "direct_user_input"
	| "loop_mode_autonomous_wake"
	| "active_goal_continuation"
	| "active_async_result_wake"
	| "bounded_transport_or_protocol_retry";

export type AutomaticTurnOutcomeStatus = "accepted" | "started" | "deferred" | "rejected" | "failed";

export interface AutomaticTurnOutcome {
	sequence: number;
	source: AutomaticTurnSource;
	status: AutomaticTurnOutcomeStatus;
	reason: string;
	originTurnId?: string;
}

const allowedSources = new Set<AutomaticTurnSource>([
	"direct_user_input",
	"active_goal_continuation",
	"active_async_result_wake",
	"bounded_transport_or_protocol_retry",
]);

/** Central, inspectable authority ledger for every host-created model turn. */
export class AutomaticTurnAuthority {
	#sequence = 0;
	readonly #outcomes: AutomaticTurnOutcome[] = [];
	readonly #openTurns = new Set<string>();
	#turnSequence = 0;

	record(
		source: AutomaticTurnSource,
		status: AutomaticTurnOutcomeStatus,
		reason: string,
		originTurnId?: string,
	): void {
		this.#outcomes.push({
			sequence: ++this.#sequence,
			source,
			status,
			reason,
			...(originTurnId ? { originTurnId } : {}),
		});
		if (this.#outcomes.length > 100) this.#outcomes.shift();
	}

	openTurn(): string {
		const id = `turn-${++this.#turnSequence}`;
		this.#openTurns.add(id);
		return id;
	}

	closeTurn(turnId: string | undefined): void {
		if (turnId) this.#openTurns.delete(turnId);
	}

	isTurnOpen(turnId: string | undefined): boolean {
		return turnId !== undefined && this.#openTurns.has(turnId);
	}

	authorize(source: AutomaticTurnSource, originTurnId?: string): boolean {
		if (!allowedSources.has(source)) {
			this.record(source, "rejected", "source is not registered");
			return false;
		}
		if (source === "active_async_result_wake" && !this.isTurnOpen(originTurnId)) {
			this.record(source, "rejected", "originating asynchronous turn is closed", originTurnId);
			return false;
		}
		this.record(source, "accepted", "authority and origin checks passed", originTurnId);
		return true;
	}

	outcomes(): readonly AutomaticTurnOutcome[] {
		return this.#outcomes.map(outcome => ({ ...outcome }));
	}
}
