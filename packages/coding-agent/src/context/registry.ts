import * as prompt from "@oh-my-pi/pi-utils/prompt";
import { YAML } from "bun";
import behaviorSource from "../agent-behavior.yml" with { type: "text" };
import registrySource from "../prompt-registry.yml" with { type: "text" };
import { sha256 } from "./canonical";
import { PROMPT_SOURCES } from "./prompt-sources.generated";

export const CONTEXT_ROLES = ["system", "developer", "internal_context"] as const;
export const CONTEXT_TARGETS = ["main", "subagent", "side_model"] as const;
export const CONTEXT_VISIBILITIES = ["model", "conditional", "offline_only"] as const;

export type ContextRole = (typeof CONTEXT_ROLES)[number];
export type ContextTarget = (typeof CONTEXT_TARGETS)[number];
export type ContextVisibility = (typeof CONTEXT_VISIBILITIES)[number];

export interface PromptRegistryEntry {
	id: string;
	path: string;
	role: ContextRole;
	target: ContextTarget[];
	trigger: string;
	visibility: ContextVisibility;
	defaultEnabled: boolean;
	order: number;
}

export interface PromptRegistry {
	version: 1;
	triggers: string[];
	prompts: PromptRegistryEntry[];
	nonModelDocumentation: string[];
}

export interface RegisteredContextComponent {
	id: string;
	sourcePath: string;
	role: ContextRole;
	target: ContextTarget;
	trigger: string;
	visibility: ContextVisibility;
	sha256: string;
	renderedText: string;
	order: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
		throw new Error(`prompt registry ${field} must be a string array`);
	}
	return value;
}

function parseEntry(value: unknown, index: number, triggers: ReadonlySet<string>): PromptRegistryEntry {
	if (!isRecord(value)) throw new Error(`prompt registry entry ${index} must be an object`);
	const { id, path, role, target, trigger, visibility, defaultEnabled, order } = value;
	if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
		throw new Error(`prompt registry entry ${index} has invalid id`);
	}
	if (typeof path !== "string" || !path.endsWith(".md") || path.startsWith("/") || path.includes("..")) {
		throw new Error(`prompt registry ${id} has invalid path`);
	}
	if (typeof role !== "string" || !(CONTEXT_ROLES as readonly string[]).includes(role)) {
		throw new Error(`prompt registry ${id} has invalid role`);
	}
	const targets = parseStringArray(target, `${id}.target`);
	if (targets.length === 0 || targets.some(item => !(CONTEXT_TARGETS as readonly string[]).includes(item))) {
		throw new Error(`prompt registry ${id} has invalid target`);
	}
	if (typeof trigger !== "string" || !triggers.has(trigger)) {
		throw new Error(`prompt registry ${id} has invalid trigger`);
	}
	if (typeof visibility !== "string" || !(CONTEXT_VISIBILITIES as readonly string[]).includes(visibility)) {
		throw new Error(`prompt registry ${id} has invalid visibility`);
	}
	if (typeof defaultEnabled !== "boolean") throw new Error(`prompt registry ${id} has invalid defaultEnabled`);
	if (!Number.isSafeInteger(order) || (order as number) < 0)
		throw new Error(`prompt registry ${id} has invalid order`);
	return {
		id,
		path,
		role: role as ContextRole,
		target: targets as ContextTarget[],
		trigger,
		visibility: visibility as ContextVisibility,
		defaultEnabled,
		order: order as number,
	};
}

export function loadPromptRegistry(): PromptRegistry {
	const raw: unknown = YAML.parse(registrySource);
	if (!isRecord(raw) || raw.version !== 1) throw new Error("prompt registry version must be 1");
	const triggers = parseStringArray(raw.triggers, "triggers");
	const triggerSet = new Set(triggers);
	if (triggerSet.size !== triggers.length) throw new Error("prompt registry triggers must be unique");
	if (!Array.isArray(raw.prompts)) throw new Error("prompt registry prompts must be an array");
	const prompts = raw.prompts.map((entry, index) => parseEntry(entry, index, triggerSet));
	const ids = new Set<string>();
	const paths = new Set<string>();
	for (const entry of prompts) {
		if (ids.has(entry.id)) throw new Error(`duplicate prompt registry id: ${entry.id}`);
		if (paths.has(entry.path)) throw new Error(`duplicate prompt registry path: ${entry.path}`);
		if (!(entry.path in PROMPT_SOURCES)) throw new Error(`registered prompt source is missing: ${entry.path}`);
		ids.add(entry.id);
		paths.add(entry.path);
	}
	return {
		version: 1,
		triggers,
		prompts,
		nonModelDocumentation: parseStringArray(raw.nonModelDocumentation ?? [], "nonModelDocumentation"),
	};
}

let registryCache: PromptRegistry | undefined;

export function promptRegistry(): PromptRegistry {
	if (!registryCache) registryCache = loadPromptRegistry();
	return registryCache;
}

export function promptEntry(id: string): PromptRegistryEntry {
	const entry = promptRegistry().prompts.find(candidate => candidate.id === id);
	if (!entry) throw new Error(`unknown registered prompt id: ${id}`);
	return entry;
}

export function renderInstruction(
	id: string,
	variables: Record<string, unknown> = {},
	target?: ContextTarget,
): RegisteredContextComponent {
	const entry = promptEntry(id);
	const selectedTarget = target ?? entry.target[0];
	if (!selectedTarget || !entry.target.includes(selectedTarget)) {
		throw new Error(`prompt ${id} does not target ${selectedTarget ?? "<none>"}`);
	}
	const source = PROMPT_SOURCES[entry.path];
	if (source === undefined) throw new Error(`registered prompt source is missing: ${entry.path}`);
	const renderedText = prompt.render(source, variables);
	return {
		id,
		sourcePath: `packages/coding-agent/src/${entry.path}`,
		role: entry.role,
		target: selectedTarget,
		trigger: entry.trigger,
		visibility: entry.visibility,
		sha256: sha256(renderedText),
		renderedText,
		order: entry.order,
	};
}

/** Attach already-rendered dynamic data to a registered instruction wrapper. */
export function bindRenderedInstruction(
	id: string,
	renderedText: string,
	target?: ContextTarget,
): RegisteredContextComponent {
	const entry = promptEntry(id);
	const selectedTarget = target ?? entry.target[0];
	if (!selectedTarget || !entry.target.includes(selectedTarget)) {
		throw new Error(`prompt ${id} does not target ${selectedTarget ?? "<none>"}`);
	}
	return {
		id,
		sourcePath: `packages/coding-agent/src/${entry.path}`,
		role: entry.role,
		target: selectedTarget,
		trigger: entry.trigger,
		visibility: entry.visibility,
		sha256: sha256(renderedText),
		renderedText,
		order: entry.order,
	};
}

export function registeredPromptSource(id: string): string {
	const entry = promptEntry(id);
	const source = PROMPT_SOURCES[entry.path];
	if (source === undefined) throw new Error(`registered prompt source is missing: ${entry.path}`);
	return source;
}

export function behaviorRegistrySource(): string {
	return behaviorSource;
}
