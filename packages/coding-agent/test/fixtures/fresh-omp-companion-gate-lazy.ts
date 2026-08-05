import { mock } from "bun:test";
import * as crypto from "node:crypto";

mock.module("node:crypto", () => ({
	...crypto,
	randomUUID(): never {
		throw new Error("entropy unavailable");
	},
}));

// Deliberately dynamic: the probe must mock entropy before evaluating the main import graph.
const { resolveFreshOmpCompanionSecret } = await import("../../src/main");
const secret = resolveFreshOmpCompanionSecret({
	isInteractive: true,
	noSession: false,
	env: {},
});
if (secret !== undefined) throw new Error("Companion must remain gated off");

const { createFreshOmpCompanionController } = await import("../../src/modes/fresh-omp-companion");
try {
	createFreshOmpCompanionController(new Uint8Array(32));
	throw new Error("Eligible companion construction must require incarnation entropy");
} catch (error) {
	if (!(error instanceof Error) || error.message !== "entropy unavailable") throw error;
}
