import {
	diffProtectedSurfaces,
	PROTECTED_SURFACE_DELTA_SCHEMA,
	type ProtectedChangeKind,
	type ProtectedSurfaceChange,
	type ProtectedSurfaceInput,
} from "../policy/protected-surface";
import { diff, ref, remote, repo, show } from "../utils/git";
import { canonicalJson, type JsonValue, sha256 } from "./canonical";
import { type ContentManifest, canonicalGithubRepository, parseContentManifest } from "./manifest";

export interface ContextDiff {
	schema: "omp.context_diff.v1";
	base: string;
	target: string;
	baseRootSha256: string | null;
	targetRootSha256: string | null;
	changed: boolean;
	changedPaths: string[];
	protectedDelta: ProtectedSurfaceDeltaEvidence;
}

export interface ProtectedSurfaceDeltaEvidence {
	schema: typeof PROTECTED_SURFACE_DELTA_SCHEMA;
	repository: string;
	baseCommit: string;
	baseTree: string;
	headCommit: string;
	headTree: string;
	protectedDelta: boolean;
	classifications: readonly ProtectedSurfaceChange[];
	classificationSha256: string;
}

const MANIFEST_PATH = "packages/coding-agent/generated/prompt-manifest.json";

async function manifestAt(cwd: string, ref: string): Promise<ContentManifest> {
	return parseContentManifest(await show(cwd, `${ref}:${MANIFEST_PATH}`));
}

async function optionalManifestAt(cwd: string, ref: string): Promise<ContentManifest | undefined> {
	try {
		return await manifestAt(cwd, ref);
	} catch {
		return undefined;
	}
}

export function diffManifestRoots(
	base: Pick<ContentManifest, "rootSha256"> | undefined,
	target: Pick<ContentManifest, "rootSha256"> | undefined,
): Pick<ContextDiff, "baseRootSha256" | "targetRootSha256" | "changed"> {
	const baseRootSha256 = base?.rootSha256 ?? null;
	const targetRootSha256 = target?.rootSha256 ?? null;
	return { baseRootSha256, targetRootSha256, changed: baseRootSha256 !== targetRootSha256 };
}

export function buildProtectedDeltaEvidence(
	input: Omit<ProtectedSurfaceDeltaEvidence, "schema" | "classificationSha256">,
): ProtectedSurfaceDeltaEvidence {
	const payload = { schema: PROTECTED_SURFACE_DELTA_SCHEMA, ...input };
	return {
		...payload,
		classificationSha256: sha256(canonicalJson(payload as unknown as JsonValue)),
	};
}

export async function diffProtectedRepository(options: {
	repository: string;
	base: string;
	target: string;
}): Promise<ProtectedSurfaceDeltaEvidence> {
	const cwd = await repo.root(options.repository);
	if (!cwd) throw new Error("omp context protected-delta requires a Git checkout");
	const [baseIdentity, headIdentity] = await Promise.all([
		ref.commitIdentity(cwd, options.base),
		ref.commitIdentity(cwd, options.target),
	]);
	if (!baseIdentity || !headIdentity) throw new Error("base and target must resolve to immutable Git commits");
	const [origin, baseManifest, targetManifest, changedPathText] = await Promise.all([
		remote.url(cwd, "origin"),
		optionalManifestAt(cwd, baseIdentity.commit),
		optionalManifestAt(cwd, headIdentity.commit),
		diff(cwd, {
			base: baseIdentity.commit,
			head: headIdentity.commit,
			nameStatus: true,
			noRenames: true,
			z: true,
		}),
	]);
	const repository = canonicalGithubRepository(origin);
	if (!repository) throw new Error("origin must identify a canonical GitHub owner/name repository");
	const fields = changedPathText.split("\0").filter(Boolean);
	if (fields.length % 2 !== 0) throw new Error("unexpected Git name-status output");
	const inputs: ProtectedSurfaceInput[] = [];
	for (let index = 0; index < fields.length; index += 2) {
		const status = fields[index]!;
		const path = fields[index + 1]!;
		const kind: ProtectedChangeKind = status === "A" ? "added" : status === "D" ? "removed" : "changed";
		inputs.push({ path, kind });
	}
	inputs.sort((left, right) => left.path!.localeCompare(right.path!));
	if (baseManifest && targetManifest) {
		inputs.unshift({ path: MANIFEST_PATH, before: baseManifest, after: targetManifest });
	}
	const classification = diffProtectedSurfaces(inputs);
	return buildProtectedDeltaEvidence({
		repository,
		baseCommit: baseIdentity.commit,
		baseTree: baseIdentity.tree,
		headCommit: headIdentity.commit,
		headTree: headIdentity.tree,
		...classification,
	});
}

export async function diffContext(options: { cwd?: string; base: string; target: string }): Promise<ContextDiff> {
	const cwd = await repo.root(options.cwd ?? process.cwd());
	if (!cwd) throw new Error("omp context diff requires a Git checkout");
	const [baseManifest, targetManifest, changedPathText] = await Promise.all([
		optionalManifestAt(cwd, options.base),
		optionalManifestAt(cwd, options.target),
		diff(cwd, { base: options.base, head: options.target, nameOnly: true }),
	]);
	const changedPaths = changedPathText.split("\n").filter(Boolean).sort();
	const protectedDelta = await diffProtectedRepository({
		repository: cwd,
		base: options.base,
		target: options.target,
	});
	return {
		schema: "omp.context_diff.v1",
		base: options.base,
		target: options.target,
		...diffManifestRoots(baseManifest, targetManifest),
		changedPaths,
		protectedDelta,
	};
}
