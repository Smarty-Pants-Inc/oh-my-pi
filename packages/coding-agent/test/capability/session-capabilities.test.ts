import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionCapabilities } from "@oh-my-pi/pi-coding-agent/capability/session-capabilities";

const tempDirs: string[] = [];

async function tempDir(name: string): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), name));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe("SessionCapabilities", () => {
	it("accepts a typed grant only during the current direct-user turn and records provenance", async () => {
		const workspace = await tempDir("omp-session-workspace-");
		const outside = await tempDir("omp-session-outside-");
		const target = path.join(outside, "release.json");
		const capabilities = new SessionCapabilities({ workspace });

		expect(() => capabilities.grantFromCurrentDirectUserTurn({ kind: "writePath", value: target })).toThrow(
			"current direct-user turn",
		);
		capabilities.beginDirectUserTurn("turn-1", "Write the approved release record");
		const grant = capabilities.grantFromCurrentDirectUserTurn({ kind: "writePath", value: target });
		expect(grant).toMatchObject({
			turnId: "turn-1",
			source: "direct_user_turn",
			kind: "writePath",
			value: `${fs.realpathSync.native(outside)}/release.json`,
		});
		expect(grant.userPromptSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(capabilities.decideWrite(target).outcome).toBe("allow");
		capabilities.endTurn("turn-1");
		expect(() =>
			capabilities.grantFromCurrentDirectUserTurn({ kind: "externalCapability", value: "git.push" }),
		).toThrow("current direct-user turn");
		expect(capabilities.grantProvenance).toEqual([grant]);
	});

	it("denies grants during async and retry continuations inside an open direct-user lifecycle", async () => {
		const workspace = await tempDir("omp-session-workspace-");
		const capabilities = new SessionCapabilities({ workspace });
		capabilities.beginDirectUserTurn("turn-1", "You may grant the exact requested capability");

		for (const source of ["active_async_result_wake", "bounded_transport_or_protocol_retry"] as const) {
			await capabilities.withContinuationAuthority(source, "turn-1", async () => {
				expect(() =>
					capabilities.grantFromCurrentDirectUserTurn({ kind: "externalCapability", value: `test.${source}` }),
				).toThrow("direct_user_input continuation authority");
			});
		}

		expect(() =>
			capabilities.grantFromCurrentDirectUserTurn({ kind: "externalCapability", value: "test.direct" }),
		).not.toThrow();
	});

	it("allows workspace writes but requests a narrow grant for sibling and symlink escapes", async () => {
		const parent = await tempDir("omp-session-capability-");
		const workspace = path.join(parent, "work");
		const outside = path.join(parent, "outside");
		await fs.promises.mkdir(workspace);
		await fs.promises.mkdir(outside);
		await fs.promises.symlink(outside, path.join(workspace, "escape"));
		await fs.promises.symlink(path.join(parent, "missing"), path.join(workspace, "dangling"));
		const capabilities = new SessionCapabilities({ workspace });

		expect(capabilities.decideWrite("src/new.ts")).toMatchObject({
			outcome: "allow",
			authority: "workspace",
			target: path.join(capabilities.workspace, "src/new.ts"),
		});
		expect(capabilities.decideWrite(path.join(parent, "work-other/file.ts"))).toMatchObject({
			outcome: "request",
			reason: "outsideWorkspaceAndAllowlist",
		});
		expect(capabilities.decideWrite(path.join(workspace, "escape/new.ts"))).toMatchObject({
			outcome: "request",
			target: path.join(fs.realpathSync.native(outside), "new.ts"),
		});
		expect(capabilities.decideWrite(path.join(workspace, "dangling/new.ts"))).toMatchObject({
			outcome: "deny",
			reason: "pathCannotBeCanonicalized",
		});
	});

	it("reuses an exact write grant without broadening it to descendants", async () => {
		const workspace = await tempDir("omp-session-workspace-");
		const outside = await tempDir("omp-session-outside-");
		const granted = path.join(outside, "release.json");
		const capabilities = new SessionCapabilities({ workspace });

		capabilities.grantWritePath(granted);
		expect(capabilities.decideWrite(granted)).toMatchObject({ outcome: "allow", authority: "writeAllowlist" });
		expect(capabilities.decideWrite(granted)).toMatchObject({ outcome: "allow", authority: "writeAllowlist" });
		expect(capabilities.decideWrite(path.join(granted, "child"))).toMatchObject({ outcome: "request" });
	});

	it("allows descendants of explicit additional workspace roots", async () => {
		const workspace = await tempDir("omp-session-workspace-");
		const additionalRoot = await tempDir("omp-session-additional-");
		const capabilities = new SessionCapabilities({ workspace, workspaceRoots: [additionalRoot] });

		expect(capabilities.workspaceRoots).toContain(fs.realpathSync.native(additionalRoot));
		expect(capabilities.decideWrite(path.join(additionalRoot, "src/new.ts"))).toMatchObject({
			outcome: "allow",
			authority: "workspace",
		});
	});

	it("requires exact named external capabilities and reuses explicit grants", async () => {
		const workspace = await tempDir("omp-session-workspace-");
		const capabilities = new SessionCapabilities({ workspace, externalCapabilities: ["git.push"] });

		expect(capabilities.decideExternalEffect("git.push")).toEqual({
			kind: "externalEffect",
			outcome: "allow",
			capability: "git.push",
		});
		expect(capabilities.decideExternalEffect("git.push").outcome).toBe("allow");
		expect(capabilities.decideExternalEffect("github.pr")).toMatchObject({
			outcome: "request",
			requiredGrant: { kind: "externalCapability", capability: "github.pr" },
		});
	});

	it("denies cleanup of a pre-existing resource even when it is clean, integrated, and recoverable", async () => {
		const workspace = await tempDir("omp-session-workspace-");
		const capabilities = new SessionCapabilities({ workspace });

		expect(
			capabilities.decideResourceCleanup({
				kind: "worktree",
				id: "/tmp/pre-existing-worktree",
				clean: true,
				integrated: true,
				recoverable: true,
			}),
		).toEqual({
			kind: "resourceCleanup",
			outcome: "deny",
			resource: { kind: "worktree", id: "/tmp/pre-existing-worktree" },
			reason: "notTaskOwned",
		});
	});

	it("allows cleanup only after a task-created resource is clean, integrated, and recoverable", async () => {
		const workspace = await tempDir("omp-session-workspace-");
		const capabilities = new SessionCapabilities({
			workspace,
			taskOwnedResources: [{ kind: "branch", id: "task/topic", createdByCurrentTask: true }],
		});
		const ready = { kind: "branch" as const, id: "task/topic", clean: true, integrated: true, recoverable: true };

		expect(capabilities.decideResourceCleanup({ ...ready, clean: false })).toMatchObject({
			outcome: "deny",
			reason: "notClean",
		});
		expect(capabilities.decideResourceCleanup({ ...ready, integrated: false })).toMatchObject({
			outcome: "deny",
			reason: "notIntegrated",
		});
		expect(capabilities.decideResourceCleanup({ ...ready, recoverable: false })).toMatchObject({
			outcome: "deny",
			reason: "notRecoverable",
		});
		expect(capabilities.decideResourceCleanup(ready)).toMatchObject({ outcome: "allow" });
	});
});
