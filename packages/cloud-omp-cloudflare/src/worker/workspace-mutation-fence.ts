import { WorkspaceObjectError } from "./errors";

export interface WorkspaceMutationLease {
	readonly generation: number;
	release(): void;
}

/** Rejects mutations after cleanup starts and lets cleanup await already-entered operations. */
export class WorkspaceMutationFence {
	#accepting = true;
	#inFlight = 0;
	#drained: PromiseWithResolvers<void> | undefined;

	enter(generation: number): WorkspaceMutationLease {
		if (!this.#accepting) throw new WorkspaceObjectError(410, "workspace_gone", "Workspace cleanup has started");
		this.#inFlight++;
		let released = false;
		return {
			generation,
			release: () => {
				if (released) return;
				released = true;
				this.#inFlight--;
				if (this.#inFlight === 0) this.#drained?.resolve();
			},
		};
	}

	seal(): void {
		this.#accepting = false;
	}

	async waitForDrain(): Promise<void> {
		if (this.#inFlight === 0) return;
		this.#drained ??= Promise.withResolvers<void>();
		await this.#drained.promise;
	}
}
