import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AutomaticTurnSource } from "../session/automatic-turn-authority";

export type ExternalCapability = string;
export type TaskResourceKind = "worktree" | "branch" | "agent" | "resource";

export interface TaskResourceRef {
	kind: TaskResourceKind;
	id: string;
}

/** Records creation by this task. Existing resources must never be adopted implicitly. */
export interface TaskOwnedResource extends TaskResourceRef {
	createdByCurrentTask: true;
}

export interface SessionCapabilityInit {
	workspace: string;
	workspaceRoots?: readonly string[];
	writeAllowlist?: readonly string[];
	externalCapabilities?: readonly ExternalCapability[];
	taskOwnedResources?: readonly TaskOwnedResource[];
}

export type CapabilityGrantRequest =
	| { kind: "writePath"; value: string }
	| { kind: "externalCapability"; value: string };

export interface CapabilityGrantProvenance {
	turnId: string;
	source: "direct_user_turn";
	userPromptSha256: string;
	grantedAt: string;
	kind: CapabilityGrantRequest["kind"];
	value: string;
}

export type WriteDecision =
	| {
			kind: "write";
			outcome: "allow";
			target: string;
			authority: "workspace" | "writeAllowlist";
	  }
	| {
			kind: "write";
			outcome: "request";
			target: string;
			requiredGrant: { kind: "writePath"; path: string };
			reason: "outsideWorkspaceAndAllowlist";
	  }
	| {
			kind: "write";
			outcome: "deny";
			target: string;
			reason: "pathCannotBeCanonicalized";
	  };

export type ExternalEffectDecision =
	| {
			kind: "externalEffect";
			outcome: "allow";
			capability: ExternalCapability;
	  }
	| {
			kind: "externalEffect";
			outcome: "request";
			capability: ExternalCapability;
			requiredGrant: { kind: "externalCapability"; capability: ExternalCapability };
			reason: "externalCapabilityNotGranted";
	  };

export interface ResourceCleanupRequest extends TaskResourceRef {
	clean: boolean;
	integrated: boolean;
	recoverable: boolean;
}

export type ResourceCleanupDecision =
	| {
			kind: "resourceCleanup";
			outcome: "allow";
			resource: TaskResourceRef;
	  }
	| {
			kind: "resourceCleanup";
			outcome: "deny";
			resource: TaskResourceRef;
			reason: "notTaskOwned" | "notClean" | "notIntegrated" | "notRecoverable";
	  };

function isMissingPathError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/** Resolve symlinks in the longest existing prefix, including for a new write target. */
export function canonicalPath(filePath: string, base = process.cwd()): string {
	let candidate = path.resolve(base, filePath);
	const missingSegments: string[] = [];

	while (true) {
		try {
			return path.join(fs.realpathSync.native(candidate), ...missingSegments);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			try {
				if (fs.lstatSync(candidate).isSymbolicLink()) {
					throw new Error(`Cannot resolve symbolic link in path: ${filePath}`);
				}
			} catch (lstatError) {
				if (!isMissingPathError(lstatError)) throw lstatError;
			}
		}

		const parent = path.dirname(candidate);
		if (parent === candidate) {
			throw new Error(`Cannot resolve an existing ancestor for path: ${filePath}`);
		}
		missingSegments.unshift(path.basename(candidate));
		candidate = parent;
	}
}

function isCanonicalPathContained(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeCapability(capability: ExternalCapability): ExternalCapability {
	const normalized = capability.trim();
	if (normalized.length === 0) throw new TypeError("External capability name must not be empty");
	return normalized;
}

function normalizeResource(resource: TaskResourceRef): TaskResourceRef {
	const id = resource.id.trim();
	if (id.length === 0) throw new TypeError("Task-owned resource ID must not be empty");
	return { kind: resource.kind, id };
}

function resourceKey(resource: TaskResourceRef): string {
	return JSON.stringify([resource.kind, resource.id]);
}

/** Session-scoped grants used to constrain YOLO execution to explicit authority. */
export class SessionCapabilities {
	#workspace: string;
	#workspaceRoots = new Set<string>();
	#writeAllowlist = new Set<string>();
	#externalCapabilities = new Set<ExternalCapability>();
	#taskOwnedResources = new Map<string, TaskOwnedResource>();
	#directUserTurn: { turnId: string; userPromptSha256: string } | undefined;
	#continuationAuthority: { source: AutomaticTurnSource; turnId?: string } | undefined;
	readonly #grantProvenance: CapabilityGrantProvenance[] = [];

	constructor(init: SessionCapabilityInit) {
		this.#workspace = canonicalPath(init.workspace);
		this.#workspaceRoots.add(this.#workspace);
		for (const filePath of init.workspaceRoots ?? []) {
			this.#workspaceRoots.add(canonicalPath(filePath, this.#workspace));
		}
		for (const filePath of init.writeAllowlist ?? []) this.grantWritePath(filePath);
		for (const capability of init.externalCapabilities ?? []) this.grantExternalCapability(capability);
		for (const resource of init.taskOwnedResources ?? []) this.recordTaskOwnedResource(resource);
	}

	get workspace(): string {
		return this.#workspace;
	}

	get workspaceRoots(): readonly string[] {
		return [...this.#workspaceRoots];
	}

	get writeAllowlist(): readonly string[] {
		return [...this.#writeAllowlist];
	}

	get externalCapabilities(): readonly ExternalCapability[] {
		return [...this.#externalCapabilities];
	}

	get taskOwnedResources(): readonly TaskOwnedResource[] {
		return [...this.#taskOwnedResources.values()];
	}

	get grantProvenance(): readonly CapabilityGrantProvenance[] {
		return this.#grantProvenance.map(record => ({ ...record }));
	}

	/** Test a path against the live session root plus explicitly configured extra roots. */
	isWorkspacePath(filePath: string, currentWorkspace = this.#workspace): boolean {
		try {
			const workspace = canonicalPath(currentWorkspace, this.#workspace);
			const target = canonicalPath(filePath, workspace);
			if (isCanonicalPathContained(workspace, target)) return true;
			return [...this.#workspaceRoots].some(
				root => root !== this.#workspace && isCanonicalPathContained(root, target),
			);
		} catch {
			return false;
		}
	}

	beginDirectUserTurn(turnId: string, userPrompt: string): void {
		this.#directUserTurn = {
			turnId,
			userPromptSha256: createHash("sha256").update(userPrompt).digest("hex"),
		};
		this.#continuationAuthority = { source: "direct_user_input", turnId };
	}

	endTurn(turnId: string | undefined): void {
		if (turnId && this.#directUserTurn?.turnId === turnId) this.#directUserTurn = undefined;
		if (turnId && this.#continuationAuthority?.turnId === turnId) this.#continuationAuthority = undefined;
	}

	async withContinuationAuthority<T>(
		source: AutomaticTurnSource,
		turnId: string | undefined,
		action: () => Promise<T>,
	): Promise<T> {
		const previous = this.#continuationAuthority;
		this.#continuationAuthority = { source, ...(turnId ? { turnId } : {}) };
		try {
			return await action();
		} finally {
			this.#continuationAuthority = previous;
		}
	}

	/** The structured model call is the authorization act; only a live direct-user turn may make it. */
	grantFromCurrentDirectUserTurn(request: CapabilityGrantRequest): CapabilityGrantProvenance {
		const turn = this.#directUserTurn;
		if (
			!turn ||
			this.#continuationAuthority?.source !== "direct_user_input" ||
			this.#continuationAuthority.turnId !== turn.turnId
		) {
			throw new Error(
				"capability grants require the current direct-user turn with direct_user_input continuation authority",
			);
		}
		const value =
			request.kind === "writePath"
				? this.grantWritePath(request.value)
				: this.grantExternalCapability(request.value);
		const record: CapabilityGrantProvenance = {
			...turn,
			source: "direct_user_turn",
			grantedAt: new Date().toISOString(),
			kind: request.kind,
			value,
		};
		this.#grantProvenance.push(record);
		return { ...record };
	}

	/** Install a narrow path grant once; later decisions reuse it without another prompt. */
	grantWritePath(filePath: string): string {
		const grantedPath = canonicalPath(filePath, this.workspace);
		this.#writeAllowlist.add(grantedPath);
		return grantedPath;
	}

	/** Install a named external-effect grant once; later decisions require an exact match. */
	grantExternalCapability(capability: ExternalCapability): ExternalCapability {
		const normalized = normalizeCapability(capability);
		this.#externalCapabilities.add(normalized);
		return normalized;
	}

	/** Record only resources created by the current task; cleanliness never creates ownership. */
	recordTaskOwnedResource(resource: TaskOwnedResource): TaskOwnedResource {
		if (resource.createdByCurrentTask !== true) {
			throw new TypeError("Task-owned resources must be created by the current task");
		}
		const normalized = Object.freeze({ ...normalizeResource(resource), createdByCurrentTask: true as const });
		this.#taskOwnedResources.set(resourceKey(normalized), normalized);
		return normalized;
	}

	decideWrite(filePath: string, currentWorkspace = this.#workspace): WriteDecision {
		let workspace: string;
		let target: string;
		try {
			workspace = canonicalPath(currentWorkspace, this.#workspace);
			target = canonicalPath(filePath, workspace);
		} catch {
			return {
				kind: "write",
				outcome: "deny",
				target: path.resolve(currentWorkspace, filePath),
				reason: "pathCannotBeCanonicalized",
			};
		}
		if (
			isCanonicalPathContained(workspace, target) ||
			[...this.#workspaceRoots].some(root => root !== this.#workspace && isCanonicalPathContained(root, target))
		) {
			return { kind: "write", outcome: "allow", target, authority: "workspace" };
		}
		if (this.#writeAllowlist.has(target)) {
			return { kind: "write", outcome: "allow", target, authority: "writeAllowlist" };
		}
		return {
			kind: "write",
			outcome: "request",
			target,
			requiredGrant: { kind: "writePath", path: target },
			reason: "outsideWorkspaceAndAllowlist",
		};
	}

	decideExternalEffect(capability: ExternalCapability): ExternalEffectDecision {
		const normalized = normalizeCapability(capability);
		if (this.#externalCapabilities.has(normalized)) {
			return { kind: "externalEffect", outcome: "allow", capability: normalized };
		}
		return {
			kind: "externalEffect",
			outcome: "request",
			capability: normalized,
			requiredGrant: { kind: "externalCapability", capability: normalized },
			reason: "externalCapabilityNotGranted",
		};
	}

	decideResourceCleanup(request: ResourceCleanupRequest): ResourceCleanupDecision {
		const resource = normalizeResource(request);
		if (!this.#taskOwnedResources.has(resourceKey(resource))) {
			return { kind: "resourceCleanup", outcome: "deny", resource, reason: "notTaskOwned" };
		}
		if (!request.clean) {
			return { kind: "resourceCleanup", outcome: "deny", resource, reason: "notClean" };
		}
		if (!request.integrated) {
			return { kind: "resourceCleanup", outcome: "deny", resource, reason: "notIntegrated" };
		}
		if (!request.recoverable) {
			return { kind: "resourceCleanup", outcome: "deny", resource, reason: "notRecoverable" };
		}
		return { kind: "resourceCleanup", outcome: "allow", resource };
	}
}
