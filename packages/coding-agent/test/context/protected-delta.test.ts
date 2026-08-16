import { describe, expect, it } from "bun:test";
import { canonicalJson, type JsonValue, sha256 } from "../../src/context/canonical";
import { buildProtectedDeltaEvidence, diffManifestRoots } from "../../src/context/diff";

const identity = {
	repository: "Smarty-Pants-Inc/oh-my-pi",
	baseCommit: "a".repeat(40),
	baseTree: "b".repeat(40),
	headCommit: "c".repeat(40),
	headTree: "d".repeat(40),
};

describe("protected delta evidence", () => {
	it("reports a missing pre-registry manifest as an explicit null root", () => {
		expect(diffManifestRoots(undefined, { rootSha256: "a".repeat(64) })).toEqual({
			baseRootSha256: null,
			targetRootSha256: "a".repeat(64),
			changed: true,
		});
	});

	it("binds immutable repository identity and classification into one canonical hash", () => {
		const evidence = buildProtectedDeltaEvidence({
			...identity,
			protectedDelta: true,
			classifications: [{ path: "AGENTS.md", surface: "instruction", kind: "changed" }],
		});
		const { classificationSha256, ...payload } = evidence;

		expect(evidence.schema).toBe("smarty.protected_delta.v1");
		expect(classificationSha256).toBe(sha256(canonicalJson(payload as unknown as JsonValue)));
	});

	it("changes the hash for identity or protected-surface mutations", () => {
		const ordinary = buildProtectedDeltaEvidence({
			...identity,
			protectedDelta: false,
			classifications: [],
		});
		const changedIdentity = buildProtectedDeltaEvidence({
			...identity,
			headTree: "e".repeat(40),
			protectedDelta: false,
			classifications: [],
		});
		const protectedChange = buildProtectedDeltaEvidence({
			...identity,
			protectedDelta: true,
			classifications: [{ path: "src/goals/runtime.ts", surface: "goal", kind: "changed" }],
		});

		expect(
			new Set([
				ordinary.classificationSha256,
				changedIdentity.classificationSha256,
				protectedChange.classificationSha256,
			]).size,
		).toBe(3);
	});
});
