/**
 * Stable, dependency-free classification for changes that need explicit review
 * during an upstream merge. Callers pass the paths and, when available, the
 * parsed manifests from their own diff reader.
 */
export const PROTECTED_SURFACE_DELTA_SCHEMA = "smarty.protected_delta.v1" as const;

export type ProtectedSurface =
	| "instruction"
	| "configuration"
	| "skill"
	| "guard"
	| "prompt-entry"
	| "prompt-content"
	| "prompt-visibility"
	| "prompt-role"
	| "prompt-target"
	| "prompt-trigger"
	| "prompt-order"
	| "prompt-default"
	| "provider-mapping"
	| "provider-wrapper"
	| "tool-description"
	| "tool-schema"
	| "behavior"
	| "automatic-turn"
	| "goal"
	| "todo"
	| "task"
	| "subagent"
	| "approval"
	| "capability";

export type ProtectedChangeKind = "added" | "changed" | "removed";

export interface ProtectedSurfaceChange {
	path: string;
	surface: ProtectedSurface;
	kind: ProtectedChangeKind;
}

export interface ProtectedSurfaceInput {
	/** A repository-relative path, when this is a file-backed change. */
	path?: string;
	/** Immutable Git comparison result for the path. Defaults to changed. */
	kind?: ProtectedChangeKind;
	/** Parsed manifest before the change. */
	before?: unknown;
	/** Parsed manifest after the change. */
	after?: unknown;
}

export interface ProtectedSurfaceClassification {
	protectedDelta: boolean;
	classifications: readonly ProtectedSurfaceChange[];
}

type ManifestScope = "none" | "prompt" | "provider" | "tool";

interface PathRule {
	pattern: RegExp;
	surface: ProtectedSurface;
}

// Keep file rules narrow. Semantic manifests cover broad configuration while
// ordinary implementation changes outside these seams remain unblocked.
const PATH_RULES: readonly PathRule[] = [
	{ pattern: /(?:^|\/)AGENTS\.md$/i, surface: "instruction" },
	{ pattern: /(?:^|\/)SMARTY_PANTS\.md$/i, surface: "instruction" },
	{ pattern: /(?:^|\/)skills?(?:\/|$)/i, surface: "skill" },
	{ pattern: /(?:^|\/)(?:agent-behavior|prompt-registry)\.ya?ml$/i, surface: "configuration" },
	{ pattern: /(?:^|\/)(?:config|settings)\.(?:ya?ml|json|toml)$/i, surface: "configuration" },
	{ pattern: /(?:^|\/)agent-behavior\.ya?ml$/i, surface: "behavior" },
	{ pattern: /(?:^|\/)prompt-registry\.ya?ml$/i, surface: "prompt-entry" },
	{ pattern: /(?:^|\/)src\/config\/(?:settings|settings-schema)\.[cm]?[jt]s$/i, surface: "configuration" },
	{
		pattern:
			/(?:^|\/)src\/(?:commands\/context|context\/(?:approved-policy|canonical|diff|explain|manifest)|policy\/protected-surface|utils\/git)\.[cm]?[jt]s$/i,
		surface: "guard",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/(?:package\.json|scripts\/generate-prompt-manifest\.ts)$/i,
		surface: "guard",
	},
	{ pattern: /(?:^|\/)generated\/prompt-manifest\.json$/i, surface: "prompt-entry" },
	{ pattern: /(?:^|\/)src\/context\/(?:registry|prompt-sources\.generated)\.[cm]?[jt]s$/i, surface: "prompt-entry" },
	{ pattern: /(?:^|\/)src\/context\/tool-contracts\.[cm]?[jt]s$/i, surface: "tool-schema" },
	{ pattern: /(?:^|\/)src\/context\/smarty-skills\.[cm]?[jt]s$/i, surface: "provider-wrapper" },
	{
		pattern: /(?:^|\/)packages\/ai\/src\/(?:context-instructions|types|index)\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:sdk|commands\/(?:launch|acp)|extensibility\/extensions\/(?:types|runner|loader))\.[cm]?[jt]s$/i,
		surface: "guard",
	},
	{ pattern: /(?:^|\/)(?:prompts?|prompt-templates?)(?:\/|$)/i, surface: "prompt-content" },
	{ pattern: /(?:^|\/)providers?(?:\/|$)/i, surface: "provider-mapping" },
	{ pattern: /(?:^|\/)wrappers?(?:\/|$)/i, surface: "provider-wrapper" },
	{
		pattern: /(?:^|\/)(?:model-registry|provider-mapping)\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)(?:provider-wrapper|providers?\/.*\/wrappers?)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)(?:tool|tools)\/.*\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{ pattern: /(?:^|\/)(?:tool|tools)\/.*description\.[cm]?[jt]s$/i, surface: "tool-description" },
	{ pattern: /(?:^|\/)(?:automatic-turn|auto-turn)[^/]*\.[cm]?[jt]s$/i, surface: "automatic-turn" },
	{
		pattern:
			/(?:^|\/)(?:session\/agent-session|modes\/interactive-mode|session\/(?:stream-guards|turn-recovery|session-maintenance|ttsr-coordinator))\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{ pattern: /(?:^|\/)src\/edit\/index\.[cm]?[jt]s$/i, surface: "capability" },
	{ pattern: /(?:^|\/)src\/modes\/fresh-omp-companion-wire\.[cm]?[jt]s$/i, surface: "goal" },
	{ pattern: /(?:^|\/)(?:goal|goals)(?:\/|\.[cm]?[jt]s$)/i, surface: "goal" },
	{ pattern: /(?:^|\/)(?:todo|todos)(?:\/|\.[cm]?[jt]s$)/i, surface: "todo" },
	{ pattern: /(?:^|\/)(?:task|tasks)(?:\/|\.[cm]?[jt]s$)/i, surface: "task" },
	{ pattern: /(?:^|\/)(?:subagent|subagents|spawn-policy)(?:\/|\.[cm]?[jt]s$)/i, surface: "subagent" },
	{ pattern: /(?:^|\/)(?:approval|approvals)(?:\/|\.[cm]?[jt]s$)/i, surface: "approval" },
	{ pattern: /(?:^|\/)(?:capability|capabilities)(?:\/|\.[cm]?[jt]s$)/i, surface: "capability" },
];

const behaviorSurfaces: Readonly<Record<string, ProtectedSurface>> = {
	behavior: "behavior",
	automaticturn: "automatic-turn",
	automaticturns: "automatic-turn",
	goal: "goal",
	goals: "goal",
	todo: "todo",
	todos: "todo",
	task: "task",
	tasks: "task",
	subagent: "subagent",
	subagents: "subagent",
	approval: "approval",
	approvals: "approval",
	capability: "capability",
	capabilities: "capability",
};

const promptSurfaces: Readonly<Record<string, ProtectedSurface>> = {
	content: "prompt-content",
	visibility: "prompt-visibility",
	role: "prompt-role",
	target: "prompt-target",
	trigger: "prompt-trigger",
	order: "prompt-order",
	default: "prompt-default",
};

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function keyName(key: string): string {
	return key.replaceAll(/[-_]/g, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopeFor(key: string, inherited: ManifestScope): ManifestScope {
	const normalized = keyName(key);
	if (normalized === "prompt" || normalized === "prompts" || normalized === "promptentries") return "prompt";
	if (
		normalized === "provider" ||
		normalized === "providers" ||
		normalized === "providermappings" ||
		normalized === "modelmappings" ||
		normalized === "wrappers"
	) {
		return "provider";
	}
	if (normalized === "tool" || normalized === "tools") return "tool";
	return inherited;
}

function initialScope(path: string | undefined): ManifestScope {
	if (!path) return "none";
	const normalized = normalizePath(path);
	if (/(?:^|\/)(?:prompts?|prompt-templates?)(?:\/|$)/i.test(normalized)) return "prompt";
	if (/(?:^|\/)(?:providers?|wrappers?)(?:\/|$)/i.test(normalized)) return "provider";
	if (/(?:^|\/)(?:tool|tools)(?:\/|$)/i.test(normalized)) return "tool";
	return "none";
}

function appendPath(parent: string, key: string | number): string {
	return typeof key === "number" ? `${parent}[${key}]` : parent ? `${parent}.${key}` : key;
}

function stableValue(value: unknown): string {
	if (value === null) return "null";
	if (typeof value !== "object") return JSON.stringify(value) ?? String(value);
	if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
	const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
	return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`).join(",")}}`;
}

function sameValue(left: unknown, right: unknown): boolean {
	return stableValue(left) === stableValue(right);
}

function surfacesForField(key: string, scope: ManifestScope): readonly ProtectedSurface[] {
	const normalized = keyName(key);
	const surfaces: ProtectedSurface[] = [];
	const behaviorSurface = behaviorSurfaces[normalized];
	if (behaviorSurface) surfaces.push(behaviorSurface);

	if (scope === "prompt") {
		if (normalized === "entries" || normalized === "prompts" || normalized === "promptentries") {
			surfaces.push("prompt-entry");
		}
		const promptSurface = promptSurfaces[normalized];
		if (promptSurface) surfaces.push(promptSurface);
	}
	if (scope === "provider") {
		if (
			normalized === "provider" ||
			normalized === "providers" ||
			normalized === "mapping" ||
			normalized === "mappings" ||
			normalized === "providermappings" ||
			normalized === "modelmappings"
		) {
			surfaces.push("provider-mapping");
		}
		if (normalized === "wrapper" || normalized === "wrappers") surfaces.push("provider-wrapper");
	}
	if (scope === "tool") {
		if (normalized === "description") surfaces.push("tool-description");
		if (normalized === "schema" || normalized === "inputschema" || normalized === "parameters") {
			surfaces.push("tool-schema");
		}
	}
	return surfaces;
}

function collectSemanticChanges(
	before: unknown,
	after: unknown,
	path: string,
	scope: ManifestScope,
	changes: ProtectedSurfaceChange[],
): void {
	if (sameValue(before, after)) return;
	if (isRecord(before) || isRecord(after)) {
		const beforeRecord = isRecord(before) ? before : {};
		const afterRecord = isRecord(after) ? after : {};
		const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort((left, right) =>
			left.localeCompare(right),
		);
		for (const key of keys) {
			const previous = beforeRecord[key];
			const next = afterRecord[key];
			if (sameValue(previous, next)) continue;
			const childPath = appendPath(path, key);
			const childScope = scopeFor(key, scope);
			const kind: ProtectedChangeKind =
				previous === undefined ? "added" : next === undefined ? "removed" : "changed";
			for (const surface of surfacesForField(key, childScope)) {
				changes.push({ path: childPath, surface, kind });
			}
			collectSemanticChanges(previous, next, childPath, childScope, changes);
		}
		return;
	}
	if (Array.isArray(before) || Array.isArray(after)) {
		const previous = Array.isArray(before) ? before : [];
		const next = Array.isArray(after) ? after : [];
		const length = Math.max(previous.length, next.length);
		for (let index = 0; index < length; index += 1) {
			collectSemanticChanges(previous[index], next[index], appendPath(path, index), scope, changes);
		}
	}
}

function sortedUnique(changes: readonly ProtectedSurfaceChange[]): ProtectedSurfaceChange[] {
	const entries = new Map<string, ProtectedSurfaceChange>();
	for (const change of changes) {
		entries.set(`${change.path}\u0000${change.surface}\u0000${change.kind}`, change);
	}
	return [...entries.values()].sort(
		(left, right) =>
			left.path.localeCompare(right.path) ||
			left.surface.localeCompare(right.surface) ||
			left.kind.localeCompare(right.kind),
	);
}

/** Returns every protected surface selected solely by a repository path. */
export function classifyProtectedPath(
	path: string,
	kind: ProtectedChangeKind = "changed",
): readonly ProtectedSurfaceChange[] {
	const normalized = normalizePath(path);
	return sortedUnique(
		PATH_RULES.filter(rule => rule.pattern.test(normalized)).map(rule => ({
			path: normalized,
			surface: rule.surface,
			kind,
		})),
	);
}

/**
 * Classifies one context-diff entry. It is intentionally pure so both merge
 * guards and context-diff output can use the same decision without filesystem
 * access or parser-dependent behavior.
 */
export function diffProtectedSurface(input: ProtectedSurfaceInput): ProtectedSurfaceClassification {
	const path = input.path ? normalizePath(input.path) : "<manifest>";
	const changes = input.path ? [...classifyProtectedPath(path, input.kind)] : [];
	collectSemanticChanges(input.before, input.after, "", initialScope(input.path), changes);
	const sorted = sortedUnique(changes);
	return { protectedDelta: sorted.length > 0, classifications: sorted };
}

/** Aggregates context-diff entries into one deterministic upstream-merge result. */
export function diffProtectedSurfaces(inputs: readonly ProtectedSurfaceInput[]): ProtectedSurfaceClassification {
	const changes = inputs.flatMap(input => diffProtectedSurface(input).classifications);
	const sorted = sortedUnique(changes);
	return { protectedDelta: sorted.length > 0, classifications: sorted };
}
