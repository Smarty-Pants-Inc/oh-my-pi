import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	buildFrozenCommitMessageInvocationsV1,
	createFrozenCommitMessageInvocationBuilderV1,
	executeFrozenCommitMessageInvocationV1,
	generateCommitMessage,
} from "@oh-my-pi/pi-coding-agent/utils/commit-message-generator";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(modelRoles: Record<string, string>) {
	return {
		get(path: string) {
			if (path === "providers.tinyModel") return "online";
			return undefined;
		},
		getModelRole(role: string) {
			return modelRoles[role];
		},
		getStorage() {
			return undefined;
		},
	} as never;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("role thinking helper propagation", () => {
	it("passes smol-role thinking to commit message generation", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:high`,
			smol: "@default:minimal",
		});
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: vi.fn(() => async () => "test-key"),
		};
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix scope handling" }],
		} as never);

		const message = await generateCommitMessage(`diff --git a/x b/x\n+change\n`, registry as never, settings);
		expect(message).toBe("fix scope handling");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			reasoning: Effort.Minimal,
			maxTokens: 1024,
		});
	});

	it("keeps the commit budget reasoning-safe when the catalog disables reasoning", async () => {
		const model = { ...getModelOrThrow("claude-sonnet-4-5"), reasoning: false };
		const settings = createSettings({
			smol: `${model.provider}/${model.id}`,
		});
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: vi.fn(() => async () => "test-key"),
		};
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix qwen title budget" }],
		} as never);

		const message = await generateCommitMessage(`diff --git a/x b/x\n+change\n`, registry as never, settings);
		expect(message).toBe("fix qwen title budget");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			maxTokens: 1024,
		});
	});

	it("freezes deterministic credential-free candidate invocations in selected order", () => {
		const base = getModelOrThrow("claude-sonnet-4-5");
		const selected = {
			...base,
			id: "commit-frozen-selected",
			name: "Commit frozen selected",
			headers: {
				Authorization: "never-persist-this",
				"x-goog-api-key": "never-persist-this-either",
				"x-omp-trace": "preserved",
			},
		};
		const fallback = { ...base, id: "commit-frozen-fallback", name: "Commit frozen fallback" };
		const getApiKey = vi.fn(async () => "never-persist-this");
		const registry = {
			getAvailable: () => [fallback, selected],
			getApiKey,
			resolver: vi.fn(() => async () => "never-persist-this"),
		};
		const settings = createSettings({ smol: `${selected.provider}/${selected.id}:minimal` });

		const invocations = buildFrozenCommitMessageInvocationsV1(
			"diff --git a/x b/x\n+change\n",
			registry as never,
			settings,
			"session-7",
			77,
		);
		const repeated = buildFrozenCommitMessageInvocationsV1(
			"diff --git a/x b/x\n+change\n",
			registry as never,
			settings,
			"session-7",
			77,
		);
		const frozen = invocations[0];
		if (!frozen) throw new Error("Expected frozen invocation");

		expect(invocations.map(invocation => invocation.candidate.model.id)).toEqual([selected.id, fallback.id]);
		expect(invocations).toEqual(repeated);
		expect(getApiKey).not.toHaveBeenCalled();
		expect(frozen).toMatchObject({
			schemaVersion: 1,
			candidate: { resolverKind: "model_registry", sessionId: "session-7" },
			frozenAt: 77,
			maxTokens: 1024,
			reasoning: Effort.Minimal,
		});
		expect(frozen.userPromptUtf8).toBe("<diff>\ndiff --git a/x b/x\n+change\n\n</diff>");
		expect(frozen.candidate.model.headers).toEqual({ "x-omp-trace": "preserved" });
		expect(frozen.candidate.model.maxTokens).toBe(base.maxTokens);
		expect(JSON.stringify(frozen)).not.toContain("never-persist-this");
		expect(JSON.stringify(frozen)).not.toContain("never-persist-this-either");
		expect(frozen.canonicalJsonUtf8ByteLength).toBe(Buffer.byteLength(frozen.canonicalJsonUtf8, "utf8"));
		expect(frozen.canonicalJsonUtf8Sha256).toBe(
			`sha256:${createHash("sha256").update(frozen.canonicalJsonUtf8, "utf8").digest("hex")}`,
		);
		expect(JSON.parse(frozen.canonicalJsonUtf8)).toMatchObject({ candidate: { sessionId: "session-7" } });
	});

	it("keeps factory candidate bytes and order stable after settings and catalog mutation", () => {
		const base = getModelOrThrow("claude-sonnet-4-5");
		const selected = { ...base, id: "commit-factory-selected", name: "Commit factory selected" };
		const replacement = { ...base, id: "commit-factory-replacement", name: "Commit factory replacement" };
		const available = [selected];
		const roles: Record<string, string> = { smol: `${selected.provider}/${selected.id}:minimal` };
		const getApiKey = vi.fn(async () => "must-not-be-read");
		const getAvailable = vi.fn(() => available);
		const registry = {
			getAvailable,
			getApiKey,
			resolver: vi.fn(() => async () => "must-not-be-read"),
		};
		const builder = createFrozenCommitMessageInvocationBuilderV1(
			registry as never,
			createSettings(roles),
			"session-factory",
		);
		const beforeMutation = builder("diff --git a/x b/x\n+change\n", 101);

		roles.smol = `${replacement.provider}/${replacement.id}:high`;
		available.splice(0, available.length, replacement);
		selected.baseUrl = "https://mutated.invalid";
		const afterMutation = builder("diff --git a/x b/x\n+change\n", 101);

		expect(afterMutation).toEqual(beforeMutation);
		expect(afterMutation.map(invocation => invocation.candidate.model.id)).toEqual(["commit-factory-selected"]);
		expect(afterMutation[0]?.candidate.model.baseUrl).toBe(base.baseUrl);
		expect(afterMutation[0]?.reasoning).toBe(Effort.Minimal);
		expect(getApiKey).not.toHaveBeenCalled();
		expect(getAvailable).toHaveBeenCalledTimes(1);
	});

	it("executes only the frozen model, prompt, timestamp, and reasoning before applying legacy cleanup", async () => {
		const model = { ...getModelOrThrow("claude-sonnet-4-5"), id: "commit-frozen-execution" };
		const settings = createSettings({ smol: `${model.provider}/${model.id}:minimal` });
		const sourceRegistry = {
			getAvailable: () => [model],
			getApiKey: async () => "source-key",
			resolver: vi.fn(() => async () => "source-key"),
		};
		const invocation = buildFrozenCommitMessageInvocationsV1(
			"diff --git a/x b/x\n+change\n",
			sourceRegistry as never,
			settings,
			"session-8",
			88,
		)[0];
		if (!invocation) throw new Error("Expected frozen invocation");
		const getApiKey = vi.fn(async () => "resolved-only-at-execution");
		const resolver = vi.fn(() => async () => "resolved-only-at-execution");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [
				{ type: "text", text: '  "fix frozen ' },
				{ type: "text", text: 'cleanup."  ' },
			],
		} as never);

		const result = await executeFrozenCommitMessageInvocationV1(invocation, { getApiKey, resolver });

		expect(result).toMatchObject({ status: "generated", selectedText: { utf8: "fix frozen cleanup" } });
		expect(result.responseText?.utf8).toBe('  "fix frozen cleanup."  ');
		expect(getApiKey).toHaveBeenCalledWith(expect.objectContaining({ id: model.id }), "session-8");
		expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ id: model.id }), "session-8");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0]).toEqual([
			expect.objectContaining({ id: model.id }),
			{
				systemPrompt: [invocation.systemPromptUtf8],
				messages: [{ role: "user", content: invocation.userPromptUtf8, timestamp: 88 }],
			},
			expect.objectContaining({ maxTokens: 1024, reasoning: Effort.Minimal }),
		]);
	});

	it("does not dispatch without credentials and classifies a provider rejection", async () => {
		const model = { ...getModelOrThrow("claude-sonnet-4-5"), id: "commit-frozen-outcomes" };
		const settings = createSettings({ smol: `${model.provider}/${model.id}` });
		const sourceRegistry = {
			getAvailable: () => [model],
			getApiKey: async () => "source-key",
			resolver: vi.fn(() => async () => "source-key"),
		};
		const invocation = buildFrozenCommitMessageInvocationsV1(
			"diff --git a/x b/x\n+change\n",
			sourceRegistry as never,
			settings,
			"session-9",
			99,
		)[0];
		if (!invocation) throw new Error("Expected frozen invocation");
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		const noCredentials = await executeFrozenCommitMessageInvocationV1(invocation, {
			getApiKey: vi.fn(async () => undefined),
			resolver: vi.fn(() => async () => "must-not-resolve"),
		});

		expect(noCredentials.status).toBe("no_credentials");
		expect(completeSimpleMock).not.toHaveBeenCalled();
		completeSimpleMock.mockResolvedValue({
			stopReason: "error",
			content: [{ type: "text", text: "provider says no" }],
		} as never);
		const rejected = await executeFrozenCommitMessageInvocationV1(invocation, {
			getApiKey: async () => "available-at-dispatch",
			resolver: () => async () => "available-at-dispatch",
		});

		expect(rejected).toMatchObject({ status: "provider_rejected", responseText: { utf8: "provider says no" } });
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
	});

	it("disables reasoning for title generation even when smol role has thinking", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:high`,
			smol: "@default:low",
		});
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: vi.fn(() => async () => "test-key"),
		};
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "<title>Investigate resolver</title>" }],
		} as never);

		const title = await generateSessionTitle("Investigate resolver", registry as never, settings);
		expect(title).toBe("Investigate resolver");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({ disableReasoning: true });
	});
});
