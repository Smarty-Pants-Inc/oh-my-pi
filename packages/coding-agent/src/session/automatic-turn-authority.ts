export type AutomaticTurnSource =
	| "direct_user_input"
	| "active_goal_continuation"
	| "active_async_result_wake"
	| "bounded_transport_or_protocol_retry";

export type AutomaticTurnOutcomeStatus = "accepted" | "started" | "deferred" | "rejected" | "failed";

export interface AutomaticTurnOutcome {
	sequence: number;
	source: AutomaticTurnSource;
	status: AutomaticTurnOutcomeStatus;
	reason: string;
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

	record(source: AutomaticTurnSource, status: AutomaticTurnOutcomeStatus, reason: string): void {
		this.#outcomes.push({ sequence: ++this.#sequence, source, status, reason });
		if (this.#outcomes.length > 100) this.#outcomes.shift();
	}

	authorize(source: AutomaticTurnSource, stillOpen: boolean = true): boolean {
		if (!allowedSources.has(source)) {
			this.record(source, "rejected", "source is not registered");
			return false;
		}
		if (source === "active_async_result_wake" && !stillOpen) {
			this.record(source, "rejected", "originating asynchronous turn is closed");
			return false;
		}
		this.record(source, "accepted", "authority and origin checks passed");
		return true;
	}

	outcomes(): readonly AutomaticTurnOutcome[] {
		return this.#outcomes.map(outcome => ({ ...outcome }));
	}
}
