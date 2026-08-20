import { describe, expect, it } from "bun:test";
import {
	createLocalSubagentRuntimeProfile,
	ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE,
	resolveSubagentRuntimeToolNames,
	SUBAGENT_RUNTIME_CAPABILITIES,
	type SubagentRuntimeProfile,
	subagentRuntimeAllows,
	subagentRuntimeRestrictsToolNames,
} from "@oh-my-pi/pi-coding-agent/task/runtime-profile";

describe("subagent runtime profiles", () => {
	it("defines the exact immutable execution-environment sandbox", () => {
		expect(ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE).toEqual({
			tools: { mode: "exact", names: ["read", "write", "bash"] },
			restrictToolNames: true,
			bash: "enabled",
			capabilities: {
				spawns: false,
				prewalk: false,
				lsp: false,
				irc: false,
				mcp: false,
				extensions: false,
				customTools: false,
				sharedEvalState: false,
				keepAlive: false,
				revival: false,
			},
		});
		expect(Object.isFrozen(ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE)).toBe(true);
		expect(Object.isFrozen(ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE.tools)).toBe(true);
		expect(Object.isFrozen(ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE.capabilities)).toBe(true);
		if (ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE.tools.mode !== "exact") {
			throw new Error("Expected an exact execution-environment tool policy");
		}
		expect(Object.isFrozen(ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE.tools.names)).toBe(true);
		expect(resolveSubagentRuntimeToolNames(ENVIRONMENT_SUBAGENT_RUNTIME_PROFILE, ["hostile"])).toEqual([
			"read",
			"write",
			"bash",
		]);
	});

	it("fails closed when a capability or tool-policy field is missing", () => {
		const malformed = {
			tools: { mode: "unknown" },
			bash: "enabled",
			capabilities: {},
		} as unknown as SubagentRuntimeProfile;

		for (const capability of SUBAGENT_RUNTIME_CAPABILITIES) {
			expect(subagentRuntimeAllows(malformed, capability)).toBe(false);
		}
		expect(subagentRuntimeRestrictsToolNames(malformed)).toBe(true);
		expect(resolveSubagentRuntimeToolNames(malformed, ["read", "write", "bash", "task"])).toEqual([]);
	});

	it("preserves the ordinary local executor defaults", () => {
		const local = createLocalSubagentRuntimeProfile();

		expect(local).toMatchObject({
			tools: { mode: "agent" },
			restrictToolNames: false,
			bash: "inherit",
		});
		for (const capability of SUBAGENT_RUNTIME_CAPABILITIES) {
			expect(subagentRuntimeAllows(local, capability)).toBe(true);
		}
		expect(resolveSubagentRuntimeToolNames(local, ["read", "write"])).toEqual(["read", "write"]);
		expect(resolveSubagentRuntimeToolNames(local, undefined)).toBeUndefined();
		expect(Object.isFrozen(local)).toBe(true);
		expect(Object.isFrozen(local.capabilities)).toBe(true);
	});
});
