import { describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ISO8601,
	ProviderId,
	RuntimeFenceId,
	RuntimeLeaseId,
	Sha256Hex,
	Sha256Ref,
	WorkspaceId,
} from "../../../src/registry/persistent-agent-contracts.js";
import { LocalWorkspaceProvider } from "../../../src/session/local-workspace-provider.js";
import {
	materializeWorkspaceDeletionPlanV1,
	materializeWorkspaceSnapshotV1,
} from "../../../src/session/managed-workspace.js";
import {
	type CanonicalWorkspaceCommitReceipt,
	canonicalRuntimeSha256,
	type LocalIsolationAvailabilityV1,
	type RuntimeAccessContext,
	type RuntimeAcquireResult,
	type RuntimeCandidate,
	type RuntimeCheckpointAcknowledgeRequest,
	type RuntimeFence,
	type RuntimeLeasePlan,
	type RuntimePushRequest,
	type RuntimeReplicaRef,
	type RuntimeRequirements,
	type WorkspaceSnapshot,
} from "../../../src/session/workspace-runtime-contracts.js";

const availability: LocalIsolationAvailabilityV1 =
	process.platform === "darwin"
		? {
				availability: "available",
				policy: {
					driverId: "darwin-sandbox-exec-v1",
					commandEnvironment: "omp-runtime-scrubbed-v1",
					network: "none",
					writableRootClass: "replica_only",
					readonlyRootSet: "darwin-system-v1",
					runtimeSupportSet: "darwin-device-paths-v1",
					temporaryDirectory: "/workspace",
					hostHomeAccess: "denied",
					controlDataAccess: "denied",
				},
			}
		: {
				availability: "available",
				policy: {
					driverId: "linux-bubblewrap-v1",
					commandEnvironment: "omp-runtime-scrubbed-v1",
					network: "none",
					writableRootClass: "replica_only",
					readonlyRootSet: "linux-system-v1",
					runtimeSupportSet: "linux-private-dev-proc-v1",
					temporaryDirectory: "/workspace",
					hostHomeAccess: "denied",
					controlDataAccess: "denied",
				},
			};

const requirements: RuntimeRequirements = {
	capabilities: ["workspace.read", "workspace.write", "process.exec"],
	placement: "local",
	configuredProviderId: null,
	workspaceFormat: "omp-text-v1",
	os: null,
	arch: null,
	minCpu: 0,
	minMemoryMiB: 0,
	network: "none",
	maxReadyLatencyMs: null,
};

const sha256 = (content: string): Sha256Hex => createHash("sha256").update(content, "utf8").digest("hex") as Sha256Hex;
const id = (value: string) => value as never;

function snapshot(workspaceId: WorkspaceId, files = [{ path: "seed.txt", contentUtf8: "seed\n" }]) {
	return materializeWorkspaceSnapshotV1({
		workspaceId,
		generation: 0,
		committedAt: "2026-08-06T00:00:00.000Z" as never,
		files,
	});
}

async function acquireHash(
	candidate: { providerId: ProviderId; profileId: string },
	plan: RuntimeLeasePlan,
	transitionId: string,
) {
	return canonicalRuntimeSha256([
		"omp-runtime-provider-v1",
		"acquire",
		transitionId,
		candidate.providerId,
		candidate.profileId,
		plan.replica.workspaceId,
		plan.replica.replicaId,
		plan.leaseId,
		plan.fenceId,
		plan.baseCheckpoint.generation,
		plan.baseCheckpoint.rootSha256,
		plan.baseCheckpoint.fileCount,
		plan.baseCheckpoint.byteCount,
		plan.deletionAuthorityDomain,
		plan.leaseTtlMs,
		0,
	]);
}

async function pushHash(
	lease: {
		replica: { providerId: ProviderId; profileId: string; workspaceId: WorkspaceId; replicaId: string };
		leaseId: RuntimeLeaseId;
		fenceId: RuntimeFenceId;
		baseGeneration: number;
	},
	transitionId: string,
	image: { rootSha256: Sha256Hex; fileCount: number; byteCount: number },
) {
	return canonicalRuntimeSha256([
		"omp-runtime-provider-v1",
		"push",
		transitionId,
		lease.replica.providerId,
		lease.replica.profileId,
		lease.replica.workspaceId,
		lease.replica.replicaId,
		lease.leaseId,
		lease.fenceId,
		lease.baseGeneration,
		image.rootSha256,
		image.fileCount,
		image.byteCount,
	]);
}
type ReadyFixture = {
	provider: LocalWorkspaceProvider;
	candidate: RuntimeCandidate;
	replica: RuntimeReplicaRef;
	plan: RuntimeLeasePlan;
	fence: RuntimeFence;
	acquired: RuntimeAcquireResult;
	context: RuntimeAccessContext;
	image: WorkspaceSnapshot;
	pushRequest: RuntimePushRequest;
};

async function readyFixture(
	name: string,
	deletionAuthorityDomain: RuntimeLeasePlan["deletionAuthorityDomain"] = "transient_task",
	leaseTtlMs = 60_000,
): Promise<ReadyFixture> {
	const provider = new LocalWorkspaceProvider(availability);
	const discovered = await provider.discoverCandidates(requirements);
	expect(discovered.status).toBe("available");
	if (discovered.status !== "available") throw new Error("local sandbox unavailable");
	const candidate = discovered.candidates[0]!;
	const replica = {
		providerId: "local" as ProviderId,
		profileId: candidate.profileId,
		replicaId: `${name}-replica`,
		workspaceId: `${name}-workspace` as WorkspaceId,
	};
	const image = snapshot(replica.workspaceId, [
		{ path: "alpha.txt", contentUtf8: "alpha\n" },
		{ path: "beta.txt", contentUtf8: "beta\n" },
		{ path: "nested/gamma.txt", contentUtf8: "gamma\n" },
	]);
	const plan: RuntimeLeasePlan = {
		replica,
		leaseId: `${name}-lease` as RuntimeLeaseId,
		fenceId: `${name}-fence` as RuntimeFenceId,
		initialRenewalSequence: 0,
		baseCheckpoint: image.checkpoint,
		deletionAuthorityDomain,
		leaseTtlMs,
	};
	const transitionId = `${name}-acquire`;
	const fence = { fenceId: plan.fenceId, token: `${name}-fence-token` };
	const acquired = await provider.acquire({
		transitionId: id(transitionId),
		requestId: id(`${name}-acquire-request`),
		requestSha256: await acquireHash(candidate, plan, transitionId),
		candidate,
		plan,
		fence,
	});
	const context = {
		operationLeaseId: id(`${name}-operation`),
		workspaceId: replica.workspaceId,
		expectedGeneration: 0,
		replicaId: id(replica.replicaId),
		leaseId: plan.leaseId,
		fence,
	};
	const pushRequest = {
		transitionId: id(`${name}-push`),
		requestId: id(`${name}-push-request`),
		requestSha256: await pushHash(acquired.lease, `${name}-push`, image.checkpoint),
		lease: acquired.lease,
		fence,
		snapshot: image,
	};
	return { provider, candidate, replica, plan, fence, acquired, context, image, pushRequest };
}

function command(
	fixture: ReadyFixture,
	commandId: string,
	requestSha256: Sha256Hex,
	source: string,
	timeoutMs = 1_000,
	outputByteLimit = 1_024,
) {
	return fixture.acquired.binding.bridge.submitCommand({
		...fixture.context,
		commandId: id(commandId),
		requestSha256,
		command: {
			shell: "/bin/bash",
			source,
			cwd: "/workspace" as never,
			environment: "omp-runtime-scrubbed-v1",
			timeoutMs,
			outputByteLimit,
			pty: false,
		},
	});
}

if (process.platform === "darwin") {
	describe("LocalWorkspaceProvider Darwin production probe", () => {
		it("discovers a production candidate only after the hardened built-in probe", async () => {
			const discovered = await new LocalWorkspaceProvider().discoverCandidates(requirements);
			expect(discovered).toMatchObject({
				status: "available",
				candidates: [
					{
						providerId: "local",
						profileId: "local-isolated-v1",
						os: "darwin",
						arch: "arm64",
						network: "none",
						available: true,
					},
				],
			});
		});
	});
}

if (process.platform === "darwin" || process.platform === "linux") {
	describe("LocalWorkspaceProvider local contract", () => {
		it("opens the bridge only after a canonical push and authenticates the volatile fence", async () => {
			const fixture = await readyFixture("admission");
			await expect(
				command(fixture, "reserved-command", sha256("reserved-command"), "printf forbidden"),
			).rejects.toThrow();
			await expect(
				fixture.acquired.binding.bridge.readTextFile({
					...fixture.context,
					fence: { ...fixture.fence, token: "forged" },
					path: "/workspace/alpha.txt" as never,
					line: null,
					limit: null,
					byteLimit: 1_024,
				}),
			).rejects.toThrow("runtime_fence_rejected");
			await expect(
				fixture.provider.acquire({
					transitionId: fixture.acquired.request.transitionId,
					requestId: fixture.acquired.request.requestId,
					requestSha256: fixture.acquired.request.requestSha256,
					candidate: fixture.candidate,
					plan: fixture.plan,
					fence: { ...fixture.fence, token: "forged" },
				}),
			).rejects.toThrow("runtime_fence_rejected");
			await expect(fixture.provider.push(fixture.pushRequest)).resolves.toMatchObject({ status: "materialized" });
			await expect(
				fixture.acquired.binding.bridge.readTextFile({
					...fixture.context,
					path: "/workspace/alpha.txt" as never,
					line: null,
					limit: null,
					byteLimit: 1_024,
				}),
			).resolves.toMatchObject({ content: "alpha\n" });
			await expect(
				fixture.provider.push({ ...fixture.pushRequest, requestSha256: sha256("push-conflict") }),
			).rejects.toThrow("request_conflict");
		});

		it("reports an unsubmitted exact renewal as absent without consuming it", async () => {
			const fixture = await readyFixture("renewal-inspection");
			const renewal = {
				renewalId: id("renewal-inspection-1"),
				sequence: 1,
				expectedLease: fixture.acquired.lease,
				leaseTtlMs: 60_000,
				request: {
					requestId: id("renewal-inspection-request"),
					requestSha256: sha256("renewal-inspection-request"),
				},
			};
			await expect(fixture.provider.inspectRenewal(renewal)).resolves.toEqual({
				status: "absent",
				renewalId: renewal.renewalId,
				sequence: renewal.sequence,
				requestId: renewal.request.requestId,
			});
			const renewed = await fixture.provider.renew({ plan: renewal, fence: fixture.fence });
			await expect(fixture.provider.inspectRenewal(renewal)).resolves.toEqual({
				status: "complete",
				receipt: renewed,
			});
			await expect(
				fixture.provider.inspectRenewal({
					...renewal,
					renewalId: id("renewal-inspection-mismatch"),
					expectedLease: { ...fixture.acquired.lease, renewalSequence: 9 },
					request: {
						requestId: id("renewal-inspection-mismatch-request"),
						requestSha256: sha256("renewal-inspection-mismatch-request"),
					},
				}),
			).resolves.toMatchObject({ status: "rejected", reason: "expected_lease_mismatch" });
		});

		it("records exact renewal and lifecycle effects, and closes bridge admission after each drain state", async () => {
			const fixture = await readyFixture("lifecycle");
			await fixture.provider.push(fixture.pushRequest);
			const renewal = {
				renewalId: id("renewal-1"),
				sequence: 1,
				expectedLease: fixture.acquired.lease,
				leaseTtlMs: 60_000,
				request: { requestId: id("renewal-request"), requestSha256: sha256("renewal-request") },
			};
			const renewed = await fixture.provider.renew({ plan: renewal, fence: fixture.fence });
			await expect(fixture.provider.renew({ plan: renewal, fence: fixture.fence })).resolves.toEqual(renewed);
			await expect(fixture.provider.inspectRenewal(renewal)).resolves.toEqual({
				status: "complete",
				receipt: renewed,
			});
			await expect(
				fixture.provider.inspectRenewal({
					...renewal,
					request: { ...renewal.request, requestSha256: sha256("renewal-conflict") },
				}),
			).rejects.toThrow("request_conflict");

			const quiesce = {
				transitionId: id("quiesce-1"),
				requestId: id("quiesce-request"),
				requestSha256: sha256("quiesce-request"),
				lease: renewed.lease,
				fence: fixture.fence,
			};
			const quiesced = await fixture.provider.quiesce(quiesce);
			await expect(fixture.provider.quiesce(quiesce)).resolves.toEqual({ ...quiesced, status: "already_quiesced" });
			await expect(
				fixture.provider.inspectQuiesce({
					transitionId: quiesce.transitionId,
					requestId: quiesce.requestId,
					requestSha256: quiesce.requestSha256,
					lease: renewed.lease,
				}),
			).resolves.toEqual({ status: "complete", result: quiesced });
			await expect(
				fixture.acquired.binding.bridge.exists({
					...fixture.context,
					leaseId: renewed.lease.leaseId,
					path: "/workspace/alpha.txt" as never,
				}),
			).rejects.toThrow();

			const revoke = {
				transitionId: id("revoke-1"),
				requestId: id("revoke-request"),
				requestSha256: sha256("revoke-request"),
				replica: fixture.replica,
				leaseId: renewed.lease.leaseId,
				fenceId: renewed.lease.fenceId,
				reasonCode: "lease_revoked" as never,
			};
			const revoked = await fixture.provider.revoke(revoke);
			await expect(fixture.provider.inspectRevoke(revoke)).resolves.toEqual({ status: "complete", result: revoked });
			const release = {
				parentOperationId: id("release-parent"),
				requestId: id("release-request"),
				requestSha256: sha256("release-request"),
				replica: fixture.replica,
				leaseId: renewed.lease.leaseId,
			};
			const released = await fixture.provider.release(release);
			await expect(fixture.provider.inspectRelease(release)).resolves.toEqual({
				status: "complete",
				result: released,
			});
			await expect(
				fixture.acquired.binding.bridge.exists({
					...fixture.context,
					leaseId: renewed.lease.leaseId,
					path: "/workspace/alpha.txt" as never,
				}),
			).rejects.toThrow();
		});

		it("rejects recovery reuse of a checkpoint owned by an earlier live snapshot", async () => {
			const fixture = await readyFixture("recovery-checkpoint-conflict");
			await fixture.provider.push(fixture.pushRequest);
			const checkpointId = id("reused-checkpoint");
			const earlierCheckpoint = await fixture.provider.checkpoint({
				transitionId: id("earlier-checkpoint"),
				requestId: id("earlier-checkpoint-request"),
				requestSha256: sha256("earlier-checkpoint-request"),
				checkpointId,
				lease: fixture.acquired.lease,
				fence: fixture.fence,
			});
			await fixture.acquired.binding.bridge.writeTextFile({
				...fixture.context,
				requestId: id("later-recovery-mutation"),
				requestSha256: sha256("later-recovery-mutation"),
				path: "/workspace/later.txt" as never,
				content: "later\n",
				contentSha256: sha256("later\n"),
			});
			const recovery = {
				requestId: id("recovery-conflict-request"),
				requestSha256: sha256("recovery-conflict-request"),
				locator: {
					recoveryFreezeId: id("recovery-conflict-freeze"),
					replica: fixture.replica,
					leaseId: fixture.acquired.lease.leaseId,
					fenceId: fixture.acquired.lease.fenceId,
					baseGeneration: fixture.acquired.lease.baseGeneration,
					checkpointId,
				},
			};
			await expect(fixture.provider.recoveryFreeze(recovery)).rejects.toThrow("request_conflict");
			await expect(fixture.provider.inspectRecoveryFreeze(recovery)).resolves.toEqual({
				status: "absent",
				locator: recovery.locator,
			});
			await expect(
				fixture.provider.fetchCheckpoint({ reference: earlierCheckpoint.reference }),
			).resolves.toMatchObject({
				checkpoint: {
					files: expect.not.arrayContaining([
						expect.objectContaining({ path: "later.txt", contentUtf8: "later\n" }),
					]),
				},
			});
		});

		it("freezes live mutations for checkpoint and recovery, with immutable fetchable data", async () => {
			const checkpointFixture = await readyFixture("checkpoint");
			await checkpointFixture.provider.push(checkpointFixture.pushRequest);
			await checkpointFixture.acquired.binding.bridge.writeTextFile({
				...checkpointFixture.context,
				requestId: id("live-write"),
				requestSha256: sha256("live-write"),
				path: "/workspace/live.txt" as never,
				content: "live\n",
				contentSha256: sha256("live\n"),
			});
			const checkpoint = await checkpointFixture.provider.checkpoint({
				transitionId: id("checkpoint-1"),
				requestId: id("checkpoint-request"),
				requestSha256: sha256("checkpoint-request"),
				checkpointId: id("checkpoint-id"),
				lease: checkpointFixture.acquired.lease,
				fence: checkpointFixture.fence,
			});
			const fetched = await checkpointFixture.provider.fetchCheckpoint({ reference: checkpoint.reference });
			expect(fetched.checkpoint.files).toContainEqual(
				expect.objectContaining({ path: "live.txt", contentUtf8: "live\n" }),
			);
			await checkpointFixture.acquired.binding.bridge.writeTextFile({
				...checkpointFixture.context,
				requestId: id("after-checkpoint"),
				requestSha256: sha256("after-checkpoint"),
				path: "/workspace/live.txt" as never,
				content: "changed\n",
				contentSha256: sha256("changed\n"),
			});
			await expect(checkpointFixture.provider.fetchCheckpoint({ reference: checkpoint.reference })).resolves.toEqual(
				fetched,
			);

			const recoveryFixture = await readyFixture("recovery");
			await recoveryFixture.provider.push(recoveryFixture.pushRequest);
			await recoveryFixture.acquired.binding.bridge.writeTextFile({
				...recoveryFixture.context,
				requestId: id("recovery-write"),
				requestSha256: sha256("recovery-write"),
				path: "/workspace/recovered.txt" as never,
				content: "recover\n",
				contentSha256: sha256("recover\n"),
			});
			const recoveryRequest = {
				requestId: id("recovery-request"),
				requestSha256: sha256("recovery-request"),
				locator: {
					recoveryFreezeId: id("recovery-freeze"),
					replica: recoveryFixture.replica,
					leaseId: recoveryFixture.acquired.lease.leaseId,
					fenceId: recoveryFixture.acquired.lease.fenceId,
					baseGeneration: 0,
					checkpointId: id("recovery-checkpoint"),
				},
			};
			const freeze = await recoveryFixture.provider.recoveryFreeze(recoveryRequest);
			expect(freeze).toMatchObject({
				status: "frozen",
				commandAdmission: "closed",
				acknowledgedMutationsSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			});
			if (freeze.status !== "frozen") throw new Error("recovery freeze did not preserve the replica");
			await expect(recoveryFixture.provider.fetchCheckpoint({ reference: freeze.reference })).resolves.toMatchObject(
				{
					checkpoint: {
						files: expect.arrayContaining([
							expect.objectContaining({ path: "recovered.txt", contentUtf8: "recover\n" }),
						]),
					},
				},
			);
			const changedRecoveryRequest = {
				...recoveryRequest,
				requestId: id("changed-recovery-request"),
				requestSha256: sha256("changed-recovery-request"),
				locator: { ...recoveryRequest.locator, recoveryFreezeId: id("changed-recovery-freeze") },
			};
			await expect(recoveryFixture.provider.recoveryFreeze(changedRecoveryRequest)).rejects.toThrow(
				"request_conflict",
			);
			await expect(recoveryFixture.provider.inspectRecoveryFreeze(changedRecoveryRequest)).resolves.toEqual({
				status: "absent",
				locator: changedRecoveryRequest.locator,
			});
			await expect(recoveryFixture.provider.recoveryFreeze(recoveryRequest)).resolves.toEqual({
				...freeze,
				status: "already_frozen",
			});
			await expect(
				recoveryFixture.acquired.binding.bridge.exists({
					...recoveryFixture.context,
					path: "/workspace/recovered.txt" as never,
				}),
			).rejects.toThrow();
		});

		it("rejects non-exact checkpoint acknowledgements and replays an exact acknowledgement", async () => {
			const fixture = await readyFixture("checkpoint-acknowledgement");
			await fixture.provider.push(fixture.pushRequest);
			const checkpoint = await fixture.provider.checkpoint({
				transitionId: id("checkpoint-acknowledgement-checkpoint"),
				requestId: id("checkpoint-acknowledgement-checkpoint-request"),
				requestSha256: sha256("checkpoint-acknowledgement-checkpoint-request"),
				checkpointId: id("checkpoint-acknowledgement-checkpoint-id"),
				lease: fixture.acquired.lease,
				fence: fixture.fence,
			});
			const canonicalCommit: CanonicalWorkspaceCommitReceipt = {
				workspaceId: checkpoint.reference.workspaceId,
				commitId: id("checkpoint-acknowledgement-commit"),
				expectedGeneration: checkpoint.reference.baseGeneration,
				checkpoint: {
					workspaceId: checkpoint.reference.workspaceId,
					generation: checkpoint.reference.baseGeneration + 1,
					rootSha256: checkpoint.reference.rootSha256,
					fileCount: checkpoint.reference.fileCount,
					byteCount: checkpoint.reference.byteCount,
					committedAt: checkpoint.reference.frozenAt,
				},
				durableAt: checkpoint.reference.frozenAt,
			};
			const acknowledgement = {
				parentOperationId: id("checkpoint-acknowledgement-parent"),
				reference: checkpoint.reference,
				canonicalCommit,
			};
			for (const [name, canonicalCommit] of [
				[
					"foreign-workspace",
					{
						...acknowledgement.canonicalCommit,
						checkpoint: { ...acknowledgement.canonicalCommit.checkpoint, workspaceId: id("foreign-workspace") },
					},
				],
				[
					"altered-committed-at",
					{
						...acknowledgement.canonicalCommit,
						checkpoint: {
							...acknowledgement.canonicalCommit.checkpoint,
							committedAt: new Date(Date.parse(checkpoint.reference.frozenAt) + 1).toISOString() as never,
						},
					},
				],
			] satisfies readonly (readonly [string, CanonicalWorkspaceCommitReceipt])[]) {
				const request: RuntimeCheckpointAcknowledgeRequest = {
					...acknowledgement,
					requestId: id(`checkpoint-acknowledgement-${name}-request`),
					requestSha256: sha256(`checkpoint-acknowledgement-${name}-request`),
					canonicalCommit,
				};
				await expect(fixture.provider.acknowledgeCheckpoint(request)).rejects.toThrow("request_conflict");
				await expect(fixture.provider.inspectCheckpointAcknowledgement(request)).resolves.toMatchObject({
					status: "not_requested",
				});
			}
			const request: RuntimeCheckpointAcknowledgeRequest = {
				...acknowledgement,
				requestId: id("checkpoint-acknowledgement-exact-request"),
				requestSha256: sha256("checkpoint-acknowledgement-exact-request"),
			};
			const acknowledged = await fixture.provider.acknowledgeCheckpoint(request);
			expect(acknowledged).toMatchObject({
				status: "acknowledged",
				canonicalCommit: acknowledgement.canonicalCommit,
			});
			await expect(fixture.provider.acknowledgeCheckpoint(request)).resolves.toEqual({
				...acknowledged,
				status: "already_acknowledged",
			});
			await expect(fixture.provider.inspectCheckpointAcknowledgement(request)).resolves.toEqual({
				status: "complete",
				result: acknowledged,
			});
		});

		it("rejects symlink publication and external writes, preserves model paths, and pages deterministically", async () => {
			const fixture = await readyFixture("filesystem");
			await fixture.provider.push(fixture.pushRequest);
			const external = await mkdtemp(join(tmpdir(), "omp-local-provider-external-"));
			try {
				await expect(
					command(fixture, "make-link", sha256("make-link"), `/bin/ln -s ${external} /workspace/out`),
				).resolves.toMatchObject({ status: "succeeded" });
				await expect(
					fixture.acquired.binding.bridge.writeTextFile({
						...fixture.context,
						requestId: id("symlink-write"),
						requestSha256: sha256("symlink-write"),
						path: "/workspace/out/escape.txt" as never,
						content: "escape",
						contentSha256: sha256("escape"),
					}),
				).rejects.toThrow();
				const malicious = snapshot(fixture.replica.workspaceId, [
					{ path: "out/escape.txt", contentUtf8: "escape" },
				]);
				await expect(
					fixture.provider.push({
						...fixture.pushRequest,
						requestId: id("push-symlink"),
						requestSha256: await pushHash(
							fixture.acquired.lease,
							"filesystem-push-symlink",
							malicious.checkpoint,
						),
						transitionId: id("filesystem-push-symlink"),
						snapshot: malicious,
					}),
				).rejects.toThrow();
				await expect(access(join(external, "escape.txt"))).rejects.toThrow();
			} finally {
				await rm(external, { recursive: true, force: true });
			}
			const firstPage = await fixture.acquired.binding.bridge.listFiles({
				...fixture.context,
				directory: "/workspace" as never,
				pattern: "**/*",
				limit: 1,
				cursor: null,
			});
			expect(firstPage.nextCursor).not.toBeNull();
			const secondPage = await fixture.acquired.binding.bridge.listFiles({
				...fixture.context,
				directory: "/workspace" as never,
				pattern: "**/*",
				limit: 1,
				cursor: firstPage.nextCursor,
			});
			expect(secondPage.entries[0]?.path).not.toBe(firstPage.entries[0]?.path);
			expect(
				[...firstPage.entries, ...secondPage.entries].every(
					entry => entry.path.startsWith("/workspace/") && !entry.path.includes("omp-local-replica-"),
				),
			).toBe(true);
		});

		if (process.platform === "linux") {
		it("denies every private-proc mount metadata view while preserving the closed runtime allowlist", async () => {
			const fixture = await readyFixture("proc-metadata");
			await fixture.provider.push(fixture.pushRequest);
			const result = await command(
				fixture,
				"proc-metadata",
				sha256("proc-metadata"),
				`for base in /proc/1 /proc/"$$" /proc/"$PPID" /proc/self /proc/thread-self /proc/"$$"/task/"$$"; do
	for name in mountinfo mounts mountstats; do
		if IFS= read -r metadata 2>/dev/null < "$base/$name"; then
			printf 'readable:%s:%s\\n' "$base/$name" "$metadata"
			exit 91
		fi
	done
done
IFS= read -r workspace < /workspace/alpha.txt
test "$workspace" = alpha
IFS= read -r private_proc < /proc/self/status
case "$private_proc" in Name:*) ;; *) exit 92 ;; esac
/bin/bash --noprofile --norc -c 'test -r /workspace/alpha.txt'
printf 'landlock-ok\\n'`,
			);
			expect(result).toMatchObject({ status: "succeeded", output: "landlock-ok\n" });
			expect(result.output).not.toContain("omp-local-replica-");
			expect(result.output).not.toContain(`${tmpdir()}/`);
		});
		}

		it("contains command environment, host data, support writes, networking, and timeout descendants", async () => {
			const fixture = await readyFixture("commands");
			await fixture.provider.push(fixture.pushRequest);
			const parentVariable = "OMP_LOCAL_PROVIDER_PARENT_ENV_TEST";
			const prior = process.env[parentVariable];
			process.env[parentVariable] = "present";
			try {
				await expect(
					command(
						fixture,
						"environment",
						sha256("environment"),
						`test "$HOME" = /workspace && test "$TMPDIR" = /workspace && test "$LANG" = C && test "$LC_ALL" = C && test "$PATH" = /usr/bin:/bin && test -z "\${${parentVariable}+present}" && /bin/pwd`,
					),
				).resolves.toMatchObject({ status: "succeeded", output: "/workspace\n" });
			} finally {
				if (prior === undefined) delete process.env[parentVariable];
				else process.env[parentVariable] = prior;
			}
			const home = process.env.HOME;
			if (!home) throw new Error("home unavailable");
			const homeCanaryRoot = await mkdtemp(join(home, ".omp-local-provider-home-"));
			const controlCanaryRoot = await mkdtemp(join(process.cwd(), ".omp-local-provider-control-"));
			const homeCanary = join(homeCanaryRoot, "secret");
			const controlCanary = join(controlCanaryRoot, "secret");
			await Promise.all([writeFile(homeCanary, "home\n"), writeFile(controlCanary, "control\n")]);
			try {
				await expect(
					command(
						fixture,
						"host-control-denial",
						sha256("host-control-denial"),
						`test ! -r ${JSON.stringify(homeCanary)} && test ! -r ${JSON.stringify(controlCanary)} && test ! -r /etc/hosts && ! /usr/bin/touch /bin/.omp-local-provider-write-test && printf 'denied\\n'`,
					),
				).resolves.toMatchObject({ status: "succeeded", output: "denied\n" });
			} finally {
				await Promise.all([
					rm(homeCanaryRoot, { recursive: true, force: true }),
					rm(controlCanaryRoot, { recursive: true, force: true }),
				]);
			}
			const server = createServer();
			await new Promise<void>((resolve, reject) =>
				server.listen(0, "127.0.0.1", () => resolve()).once("error", reject),
			);
			try {
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("listener unavailable");
				await expect(
					command(
						fixture,
						"network-connect",
						sha256("network-connect"),
						`/usr/bin/python3 -I -S -c 'import socket; socket.create_connection(("127.0.0.1", ${address.port}), .2)'`,
					),
				).resolves.toMatchObject({ status: "failed" });
				await expect(
					command(
						fixture,
						"network-bind",
						sha256("network-bind"),
						`/usr/bin/python3 -I -S -c 'import socket; socket.socket().bind(("127.0.0.1", 0))'`,
					),
				).resolves.toMatchObject({ status: "failed" });
			} finally {
				await new Promise<void>(resolve => server.close(() => resolve()));
			}
			const replay = await command(
				fixture,
				"replay",
				sha256("replay"),
				"printf x >> /workspace/replay.txt; /bin/cat /workspace/replay.txt",
			);
			await expect(
				command(
					fixture,
					"replay",
					sha256("replay"),
					"printf x >> /workspace/replay.txt; /bin/cat /workspace/replay.txt",
				),
			).resolves.toEqual(replay);
			await expect(
				fixture.provider.inspectCommand({
					replica: fixture.replica,
					leaseId: fixture.acquired.lease.leaseId,
					commandId: id("replay"),
					requestSha256: sha256("wrong-locator"),
				}),
			).rejects.toThrow("request_conflict");
			await expect(
				fixture.acquired.binding.bridge.disposeCommand({
					...fixture.context,
					requestId: id("dispose-replay"),
					requestSha256: sha256("dispose-replay"),
					commandId: id("replay"),
				}),
			).resolves.toMatchObject({ status: "disposed" });
			await expect(
				command(
					fixture,
					"replay",
					sha256("replay"),
					"printf x >> /workspace/replay.txt; /bin/cat /workspace/replay.txt",
				),
			).resolves.toEqual(replay);

			await expect(
				command(
					fixture,
					"timeout-descendant",
					sha256("timeout-descendant"),
					process.platform === "darwin"
						? "( /bin/sleep .25; printf escape > /workspace/escaped.txt ) & /bin/sleep 30"
						: `/usr/bin/python3 -I -S -c 'import os,time;\nif os.fork() == 0:\n os.setsid(); time.sleep(.25); open("/workspace/escaped.txt", "w").write("escape"); os._exit(0)\ntime.sleep(30)'`,
					100,
				),
			).resolves.toMatchObject({ status: "cancelled" });
			await expect(
				command(
					fixture,
					"descendant-proof",
					sha256("descendant-proof"),
					process.platform === "darwin"
						? "/bin/sleep .5; test ! -e /workspace/escaped.txt"
						: `/usr/bin/python3 -I -S -c 'import os,time; time.sleep(.5); raise SystemExit(os.path.exists("/workspace/escaped.txt"))'`,
					1_000,
				),
			).resolves.toMatchObject({ status: "succeeded" });
		});
		it("rejects malformed and self-consistent persistent plans for another workspace, then replays exact deletion", async () => {
			const fixture = await readyFixture("persistent-deletion", "persistent");
			await fixture.provider.push(fixture.pushRequest);
			const plannedAt = "2026-08-06T00:00:00.000Z" as ISO8601;
			const core = {
				deleteId: id("persistent-delete"),
				deletionAuthorityId: id("persistent-delete-authority"),
				quarantineId: id("persistent-delete-quarantine"),
				workspaceId: fixture.replica.workspaceId,
				expectedCheckpoint: fixture.image.checkpoint,
				expectedRuntimeAttachmentCreateId: id("persistent-attachment"),
				expectedRuntimeAttachmentRevision: 1,
				expectedKnownReplicaCatalogRevision: 1,
				plannedDeletionAt: plannedAt,
				deletedBytesGraceMs: 60_000,
				purgeAfter: "2026-08-06T00:01:00.000Z" as ISO8601,
				replicaRequests: [
					{
						replica: fixture.replica,
						deletionAuthorityDomain: "persistent" as const,
						requestId: id("persistent-delete-request"),
					},
				],
			};
			const planned = await materializeWorkspaceDeletionPlanV1(core);
			const authorization = {
				domain: "persistent" as const,
				deletion: planned.deletion,
				deletionPlanCoreSha256: planned.deletionPlanCoreSha256,
				deletionPlanSha256: planned.deletionPlanSha256,
				tombstone: planned.tombstone,
			};
			const persistentRequest = planned.deletion.replicaRequests[0]!.request;
			const foreignWorkspaceId = id("persistent-foreign-workspace");
			const foreignReplica = { ...fixture.replica, workspaceId: foreignWorkspaceId };
			const foreignPlan = await materializeWorkspaceDeletionPlanV1({
				...core,
				workspaceId: foreignWorkspaceId,
				expectedCheckpoint: snapshot(foreignWorkspaceId).checkpoint,
				replicaRequests: [
					{
						replica: foreignReplica,
						deletionAuthorityDomain: "persistent",
						requestId: id("persistent-foreign-delete-request"),
					},
				],
			});
			await expect(
				fixture.provider.deleteReplica({
					requestId: foreignPlan.deletion.replicaRequests[0]!.request.requestId,
					requestSha256: foreignPlan.deletion.replicaRequests[0]!.request.requestSha256,
					replica: fixture.replica,
					authorization: {
						domain: "persistent",
						deletion: foreignPlan.deletion,
						deletionPlanCoreSha256: foreignPlan.deletionPlanCoreSha256,
						deletionPlanSha256: foreignPlan.deletionPlanSha256,
						tombstone: foreignPlan.tombstone,
					},
				}),
			).rejects.toThrow("request_conflict");
			await expect(
				fixture.provider.deleteReplica({
					requestId: persistentRequest.requestId,
					requestSha256: persistentRequest.requestSha256,
					replica: fixture.replica,
					authorization: { ...authorization, deletion: { ...authorization.deletion, replicaRequests: [] } },
				}),
			).rejects.toThrow("request_conflict");
			const deleted = await fixture.provider.deleteReplica({
				requestId: persistentRequest.requestId,
				requestSha256: persistentRequest.requestSha256,
				replica: fixture.replica,
				authorization,
			});
			if (deleted.status !== "deleted") throw new Error(`Expected deletion, received ${deleted.status}`);
			expect(deleted.status).toBe("deleted");
			await expect(
				fixture.provider.deleteReplica({
					requestId: persistentRequest.requestId,
					requestSha256: persistentRequest.requestSha256,
					replica: fixture.replica,
					authorization,
				}),
			).resolves.toEqual({ ...deleted, status: "already_deleted" });
		});

		it("automatically evicts an accepted cache request after an expired terminal release", async () => {
			const rootsBefore = new Set((await readdir(tmpdir())).filter(entry => entry.startsWith("omp-local-replica-")));
			const fixture = await readyFixture("automatic-cache-eviction", "transient_task", 100);
			await fixture.provider.push(fixture.pushRequest);
			const rootName = (await readdir(tmpdir())).find(
				entry => entry.startsWith("omp-local-replica-") && !rootsBefore.has(entry),
			);
			if (!rootName) throw new Error("Expected local replica root");
			const physicalRoot = join(tmpdir(), rootName);
			await access(join(physicalRoot, "alpha.txt"));

			await Bun.sleep(110);
			try {
				const plannedAt = new Date().toISOString() as ISO8601;
				const cache = {
					requestId: id("automatic-cache-request"),
					requestSha256: sha256("automatic-cache-request"),
					requestedByOperationId: id("automatic-cache-operation"),
					replica: fixture.replica,
					mode: "explicit" as const,
					delayMs: 0,
					plannedAt,
					retentionDeadline: plannedAt,
				};
				await expect(fixture.provider.requestReplicaCacheEviction(cache)).resolves.toMatchObject({
					status: "accepted",
				});
				await expect(fixture.provider.inspectReplicaCacheEviction(cache)).resolves.toMatchObject({
					status: "deferred",
					reason: "not_released",
				});

				const release = {
					parentOperationId: id("automatic-cache-release-parent"),
					requestId: id("automatic-cache-release"),
					requestSha256: sha256("automatic-cache-release"),
					replica: fixture.replica,
					leaseId: fixture.acquired.lease.leaseId,
				};
				const expiredRelease = await fixture.provider.release(release);
				expect(expiredRelease.status).toBe("expired");
				await expect(fixture.provider.release(release)).resolves.toEqual(expiredRelease);

				let inspection = await fixture.provider.inspectReplicaCacheEviction(cache);
				for (let attempt = 0; inspection.status !== "complete" && attempt < 100; attempt++) {
					await access(physicalRoot).catch(() => undefined);
					inspection = await fixture.provider.inspectReplicaCacheEviction(cache);
				}
				expect(inspection).toMatchObject({ status: "complete", result: { outcome: "evicted" } });
				if (inspection.status !== "complete") throw new Error("Expected complete cache eviction inspection");
				await expect(fixture.provider.inspectReplicaCacheEviction(cache)).resolves.toEqual(inspection);
				await expect(fixture.provider.requestReplicaCacheEviction(cache)).resolves.toEqual({
					status: "complete",
					result: inspection.result,
				});
				await expect(access(physicalRoot)).rejects.toThrow();
			} finally {
				await rm(physicalRoot, { recursive: true, force: true });
			}
		});

		it("cancels active commands and purges data after exact cache and deletion inspection", async () => {
			const fixture = await readyFixture("deletion");
			await fixture.provider.push(fixture.pushRequest);
			const running = command(fixture, "cancel", sha256("cancel"), "/bin/sleep 30", 30_000);
			await Promise.resolve();
			const cancelled = await fixture.acquired.binding.bridge.cancelCommand({
				...fixture.context,
				requestId: id("cancel-request"),
				requestSha256: sha256("cancel-request"),
				commandId: id("cancel"),
				signal: "SIGTERM",
			});
			expect(cancelled.status).toBe("cancelled");
			await expect(running).resolves.toEqual(cancelled);
			await expect(
				fixture.provider.inspectCommand({
					replica: fixture.replica,
					leaseId: fixture.acquired.lease.leaseId,
					commandId: id("cancel"),
					requestSha256: sha256("cancel"),
				}),
			).resolves.toMatchObject({ status: "present", snapshot: { status: "cancelled" } });
			const frozen = await fixture.provider.checkpoint({
				transitionId: id("deletion-checkpoint"),
				requestId: id("deletion-checkpoint-request"),
				requestSha256: sha256("deletion-checkpoint-request"),
				checkpointId: id("deletion-checkpoint-id"),
				lease: fixture.acquired.lease,
				fence: fixture.fence,
			});

			const deletionSensitive = await command(
				fixture,
				"delete-sensitive",
				sha256("delete-sensitive"),
				"printf deletion-sensitive-output",
				30_000,
			);
			expect(deletionSensitive).toMatchObject({
				status: "succeeded",
				output: "deletion-sensitive-output",
				execution: { certainty: "completed" },
			});
			const deletionRunning = command(
				fixture,
				"delete-terminated",
				sha256("delete-terminated"),
				"/bin/sleep 30",
				30_000,
			);
			await expect(
				fixture.provider.inspectCommand({
					replica: fixture.replica,
					leaseId: fixture.acquired.lease.leaseId,
					commandId: id("delete-terminated"),
					requestSha256: sha256("delete-terminated"),
				}),
			).resolves.toMatchObject({ status: "present", snapshot: { status: "start_unknown" } });
			const unknownOutcome = Promise.withResolvers<boolean>();
			const raceSpy = vi.spyOn(Promise, "race").mockReturnValueOnce(unknownOutcome.promise as never);
			const deletionUnknown = command(
				fixture,
				"delete-unknown",
				sha256("delete-unknown"),
				`/usr/bin/python3 -I -S -c 'import os,time\nif os.fork() == 0:\n os.setsid(); time.sleep(.25); open("/workspace/delete-unknown-escaped", "w").write("escape"); os._exit(0)\ntime.sleep(30)'`,
				1,
			);
			await expect(
				fixture.provider.inspectCommand({
					replica: fixture.replica,
					leaseId: fixture.acquired.lease.leaseId,
					commandId: id("delete-unknown"),
					requestSha256: sha256("delete-unknown"),
				}),
			).resolves.toMatchObject({
				status: "present",
				snapshot: { status: "start_unknown", execution: { certainty: "unknown" } },
			});
			expect(raceSpy).toHaveBeenCalledTimes(1);
			raceSpy.mockRestore();
			unknownOutcome.reject(new Error("simulated isolated outcome loss"));
			const deletionUnknownLive = await deletionUnknown;
			expect(deletionUnknownLive).toMatchObject({
				status: "start_unknown",
				output: "",
				execution: { certainty: "unknown" },
			});
			await expect(
				command(fixture, "delete-unknown-observer", sha256("delete-unknown-observer"), "/bin/sleep .4", 2_000),
			).resolves.toMatchObject({ status: "succeeded", execution: { certainty: "completed" } });
			await expect(
				fixture.acquired.binding.bridge.exists({
					...fixture.context,
					path: "/workspace/delete-unknown-escaped" as never,
				}),
			).resolves.toBe(false);
			const now = new Date().toISOString() as never;
			const cache = {
				requestId: id("cache-request"),
				requestSha256: sha256("cache-request"),
				requestedByOperationId: id("cache-operation"),
				replica: fixture.replica,
				mode: "explicit" as const,
				delayMs: 0,
				plannedAt: now,
				retentionDeadline: now,
			};
			const cacheResult = await fixture.provider.requestReplicaCacheEviction(cache);
			expect(cacheResult).toMatchObject({ status: "accepted" });
			await expect(fixture.provider.inspectReplicaCacheEviction(cache)).resolves.toMatchObject({
				status: "deferred",
				reason: "not_released",
			});

			const authorization = {
				domain: "transient_task" as const,
				taskId: id("task"),
				runId: id("run"),
				workspaceId: fixture.replica.workspaceId,
				cleanupId: id("cleanup"),
				cleanupAuthorityId: id("cleanup-authority"),
				cleanupPlanSha256: `sha256:${"a".repeat(64)}` as Sha256Ref,
				finalCheckpoint: fixture.image.checkpoint,
				replicaDeleteRequestId: id("delete-request"),
				replicaDeletionQuarantineId: id("quarantine"),
				replicaDeletionPlannedAt: "2026-08-06T00:00:00.000Z" as never,
				replicaDeletionPurgeAfter: "2026-08-06T00:01:00.000Z" as never,
			};
			const deletionHash = await canonicalRuntimeSha256([
				"omp-runtime-provider-v1",
				"replica_delete",
				"transient_task",
				fixture.replica.providerId,
				fixture.replica.profileId,
				fixture.replica.workspaceId,
				fixture.replica.replicaId,
				authorization.taskId,
				authorization.runId,
				authorization.workspaceId,
				authorization.cleanupId,
				authorization.cleanupAuthorityId,
				authorization.cleanupPlanSha256,
				[
					fixture.image.checkpoint.workspaceId,
					fixture.image.checkpoint.generation,
					fixture.image.checkpoint.rootSha256,
					fixture.image.checkpoint.fileCount,
					fixture.image.checkpoint.byteCount,
					fixture.image.checkpoint.committedAt,
				],
				authorization.replicaDeleteRequestId,
				authorization.replicaDeletionQuarantineId,
				authorization.replicaDeletionPlannedAt,
				authorization.replicaDeletionPurgeAfter,
			]);
			const deletionRequest = {
				requestId: authorization.replicaDeleteRequestId,
				requestSha256: deletionHash,
				replica: fixture.replica,
				authorization,
			};
			const deleting = fixture.provider.deleteReplica(deletionRequest);
			const deleted = await deleting;
			if (deleted.status !== "deleted") throw new Error(`Expected deletion, received ${deleted.status}`);
			expect(deleted.status).toBe("deleted");
			const deletionTerminated = await deletionRunning;
			expect(deletionTerminated).toMatchObject({
				status: "cancelled",
				output: "",
				execution: { certainty: "completed" },
			});
			const postDeletionCommand = await fixture.provider.inspectCommand({
				replica: fixture.replica,
				leaseId: fixture.acquired.lease.leaseId,
				commandId: id("delete-terminated"),
				requestSha256: sha256("delete-terminated"),
			});
			expect(postDeletionCommand).toMatchObject({
				status: "present",
				snapshot: {
					commandId: id("delete-terminated"),
					requestSha256: sha256("delete-terminated"),
					status: "cancelled",
					output: "",
					truncated: false,
					execution: { certainty: "completed" },
				},
			});
			const postDeletionSensitive = await fixture.provider.inspectCommand({
				replica: fixture.replica,
				leaseId: fixture.acquired.lease.leaseId,
				commandId: id("delete-sensitive"),
				requestSha256: sha256("delete-sensitive"),
			});
			expect(postDeletionSensitive).toMatchObject({
				status: "present",
				snapshot: {
					status: "succeeded",
					output: "",
					truncated: false,
					execution: { certainty: "completed" },
				},
			});
			expect(JSON.stringify(postDeletionSensitive)).not.toContain("deletion-sensitive-output");
			await expect(
				fixture.provider.inspectCommand({
					replica: fixture.replica,
					leaseId: fixture.acquired.lease.leaseId,
					commandId: id("delete-unknown"),
					requestSha256: sha256("delete-unknown"),
				}),
			).resolves.toMatchObject({
				status: "present",
				snapshot: { status: "start_unknown", output: "", execution: { certainty: "unknown" } },
			});
			await expect(
				fixture.provider.inspectCommand({
					replica: fixture.replica,
					leaseId: fixture.acquired.lease.leaseId,
					commandId: id("delete-unknown"),
					requestSha256: sha256("delete-unknown-conflict"),
				}),
			).rejects.toThrow("request_conflict");
			await expect(
				fixture.provider.inspectCommand({
					replica: fixture.replica,
					leaseId: fixture.acquired.lease.leaseId,
					commandId: id("delete-terminated"),
					requestSha256: sha256("delete-terminated-conflict"),
				}),
			).rejects.toThrow("request_conflict");
			await expect(fixture.provider.deleteReplica(deletionRequest)).resolves.toEqual({
				...deleted,
				status: "already_deleted",
			});
			await expect(
				fixture.acquired.binding.bridge.readTextFile({
					...fixture.context,
					path: "/workspace/alpha.txt" as never,
					line: null,
					limit: null,
					byteLimit: 1_024,
				}),
			).rejects.toThrow();
			await expect(fixture.provider.fetchCheckpoint({ reference: frozen.reference })).rejects.toThrow();
		});
	});
} else {
	describe("LocalWorkspaceProvider unsupported platforms", () => {
		it("fails local discovery closed", async () => {
			await expect(new LocalWorkspaceProvider(availability).discoverCandidates(requirements)).resolves.toMatchObject(
				{ status: "unavailable", candidates: [] },
			);
		});
	});
}
