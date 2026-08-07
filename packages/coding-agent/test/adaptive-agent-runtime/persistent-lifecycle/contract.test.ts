import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(import.meta.dir, "../../..");

const lifecycleProgram = `
import assert from "node:assert/strict";
import {
	createPersistentAgent,
	deletePersistentAgentWorkspace,
	getPersistentAgentStatus,
	listPersistentAgents,
	materializePersistentRuntimePolicyV1,
	openPersistentAgent,
	purgePersistentAgentWorkspace,
	setPersistentAgentRuntimePolicy,
} from "@oh-my-pi/pi-coding-agent/sdk";

const agentId = "Main";
const initialPolicy = materializePersistentRuntimePolicyV1();
const handle = await createPersistentAgent({
	id: agentId,
	displayName: "Main",
	workspace: { kind: "empty" },
	modelProfileId: "lifecycle-test",
	runtimePolicy: initialPolicy,
});
const created = await handle.status();
assert.equal(created.recordPhase, "open");
assert.equal(created.modelProfileId, "lifecycle-test");
assert.equal(created.workspace.health, "present");
assert.equal(created.runtime.state, "none");
assert.equal(created.session.health, "present");
assert.ok(created.session.identity);
assert.ok(created.workspace.workspaceId);
const sessionId = created.session.identity.sessionId;
const workspaceId = created.workspace.workspaceId;

const listed = await listPersistentAgents();
assert.equal(listed.length, 1);
assert.equal(listed[0]?.kind, "present");
assert.equal(listed[0]?.agentId, agentId);

const parked = await handle.park();
assert.equal(parked.recordPhase, "parked");
assert.equal(parked.workspace.workspaceId, workspaceId);
assert.equal(parked.session.identity?.sessionId, sessionId);

const policy = materializePersistentRuntimePolicyV1({ idleRuntimeTtlMs: 1 });
const updated = await setPersistentAgentRuntimePolicy(agentId, policy);
assert.equal(updated.changed, true);
assert.equal(updated.recordRevision, updated.previousRecordRevision + 1);
assert.equal(updated.status.recordPhase, "parked");
assert.equal(updated.currentPolicy.idleRuntimeTtlMs, 1);

const revived = await openPersistentAgent(agentId);
const opened = await revived.status();
assert.equal(opened.recordPhase, "open");
assert.equal(opened.workspace.workspaceId, workspaceId);
assert.equal(opened.session.identity?.sessionId, sessionId);
assert.equal(opened.runtimePolicy.idleRuntimeTtlMs, 1);

const released = await revived.release();
assert.equal(released.recordPhase, "released");
assert.equal(released.workspace.workspaceId, workspaceId);
assert.equal(released.workspace.deletion?.state, "retained");

const deleted = await deletePersistentAgentWorkspace(agentId, { deletedBytesGraceMs: 0 });
assert.equal(deleted.workspaceId, workspaceId);
assert.equal(deleted.state, "purge_due");

const tombstoned = await getPersistentAgentStatus(agentId);
assert.equal(tombstoned.kind, "present");
assert.equal(tombstoned.recordPhase, "released");
assert.equal(tombstoned.workspace.health, "tombstoned");
assert.equal(tombstoned.workspace.deletion?.state, "purge_due");

const purged = await purgePersistentAgentWorkspace(agentId);
assert.equal(purged.workspaceId, workspaceId);
assert.equal(purged.state, "purged");

const finalStatus = await getPersistentAgentStatus(agentId);
assert.equal(finalStatus.kind, "present");
assert.equal(finalStatus.recordPhase, "released");
assert.equal(finalStatus.workspace.health, "purged");
assert.equal(finalStatus.workspace.deletion?.state, "purged");
const resultPath = process.env.LIFECYCLE_RESULT_PATH;
assert.ok(resultPath);
await Bun.write(resultPath, JSON.stringify({ workspaceId, sessionId }));
`;

test("runs the public persistent-agent lifecycle in an isolated process", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-persistent-lifecycle-"));
	const agentDir = join(root, "agent");
	const settingsRoot = join(root, "settings");
	const lifecyclePath = join(root, "lifecycle.ts");
	const resultPath = join(root, "result.json");
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(settingsRoot, { recursive: true });
		await writeFile(
			join(agentDir, "config.yml"),
			"agents:\n  persistent:\n    enabled: true\n    workspaceRetention:\n      onAgentRelease: retain\n      deletedBytesGraceMs: 0\nmodelConnections:\n  lifecycle-test:\n    id: lifecycle-test\n    model:\n      provider: lifecycle-test\n      id: lifecycle-test\n",
		);
		await writeFile(
			join(agentDir, "models.yml"),
			"providers:\n  lifecycle-test:\n    baseUrl: https://example.invalid/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: lifecycle-test\n        name: Lifecycle Test\n        reasoning: false\n        input: [text]\n        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }\n        contextWindow: 8192\n        maxTokens: 4096\n",
		);
		await writeFile(
			lifecyclePath,
			lifecycleProgram.replace("@oh-my-pi/pi-coding-agent/sdk", pathToFileURL(join(packageRoot, "src/sdk.ts")).href),
		);
		const child = Bun.spawn([process.execPath, lifecyclePath], {
			cwd: packageRoot,
			stdout: "ignore",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: root,
				XDG_CONFIG_HOME: settingsRoot,
				PI_CODING_AGENT_DIR: agentDir,
				LIFECYCLE_RESULT_PATH: resultPath,
				NO_COLOR: "1",
			},
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		if (exitCode !== 0) throw new Error(stderr || `persistent lifecycle child exited ${exitCode}`);
		expect(await Bun.file(resultPath).json()).toMatchObject({
			workspaceId: expect.any(String),
			sessionId: expect.any(String),
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
