import type { CreateAgentSessionOptions } from "../sdk";

const ompInternalSessions = new WeakSet<object>();

/** Mark one OMP-owned session options object as carrying governed internal prompt authority. */
export function markOmpInternalSession<T extends CreateAgentSessionOptions>(options: T): T {
	ompInternalSessions.add(options);
	return options;
}

/** Test object identity against the package-private internal prompt capability. */
export function isOmpInternalSession(options: CreateAgentSessionOptions): boolean {
	return ompInternalSessions.has(options);
}
