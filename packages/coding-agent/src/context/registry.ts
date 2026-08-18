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

export type AutomaticTurnBehaviorSource =
	| "active_goal_continuation"
	| "active_async_result_wake"
	| "bounded_transport_or_protocol_retry";

export interface AgentBehavior {
	version: 1;
	automaticTurns: {
		allowed: AutomaticTurnBehaviorSource[];
		forbidden: string[];
	};
	goal: {
		enabled: boolean;
		create: "clear_user_or_system_request_only";
		autoContinue: "active_only";
		continuationModes: string[];
		continuationRole: "internal_context";
		modelOperations: string[];
		ownerOrSystemOperations: string[];
		sameRouteFailureLimit: number;
	};
	todo: {
		enabled: boolean;
		context: "every_turn_when_present";
		contextItems: Array<"pending" | "in_progress" | "blocked">;
		autoContinue: false;
		stopReminders: boolean;
		midRunNudges: boolean;
		eager: "default" | "preferred" | "always";
	};
	task: {
		enabled: boolean;
		eager: "default" | "preferred" | "always";
		forcedFanout: false;
		maxRecursionDepth: number;
	};
	subagent: {
		forceToolCallBeforeYield: false;
		semanticAutoRetry: false;
		boundedTransportRetry: true;
	};
	roles: { internalInstructionMayUseUserRole: false };
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

function requireRecord(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`agent behavior ${field} must be an object`);
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`agent behavior ${field} has unknown or missing fields`);
	}
	return value;
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(`agent behavior ${field} must be a boolean`);
	return value;
}

function requireInteger(value: unknown, field: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) {
		throw new Error(`agent behavior ${field} must be an integer >= ${minimum}`);
	}
	return value as number;
}

function requireLiteral<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		throw new Error(`agent behavior ${field} has an invalid value`);
	}
	return value as T;
}

function requireFalse(value: unknown, field: string): false {
	if (value !== false) throw new Error(`agent behavior ${field} must be false`);
	return false;
}

function requireTrue(value: unknown, field: string): true {
	if (value !== true) throw new Error(`agent behavior ${field} must be true`);
	return true;
}

function requireUniqueStrings(value: unknown, field: string): string[] {
	const items = parseStringArray(value, `agent behavior ${field}`);
	if (new Set(items).size !== items.length) throw new Error(`agent behavior ${field} must be unique`);
	return items;
}

export function parseAgentBehavior(source = behaviorSource): AgentBehavior {
	const root = requireRecord(YAML.parse(source), "root", [
		"version",
		"automaticTurns",
		"goal",
		"todo",
		"task",
		"subagent",
		"roles",
	]);
	if (root.version !== 1) throw new Error("agent behavior version must be 1");

	const automaticTurns = requireRecord(root.automaticTurns, "automaticTurns", ["allowed", "forbidden"]);
	const allowedValues = [
		"active_goal_continuation",
		"active_async_result_wake",
		"bounded_transport_or_protocol_retry",
	] as const;
	const allowed: AutomaticTurnBehaviorSource[] = requireUniqueStrings(
		automaticTurns.allowed,
		"automaticTurns.allowed",
	).map(value => requireLiteral(value, "automaticTurns.allowed", allowedValues));
	const goal = requireRecord(root.goal, "goal", [
		"enabled",
		"create",
		"autoContinue",
		"continuationModes",
		"continuationRole",
		"modelOperations",
		"ownerOrSystemOperations",
		"sameRouteFailureLimit",
	]);
	const todo = requireRecord(root.todo, "todo", [
		"enabled",
		"context",
		"contextItems",
		"autoContinue",
		"stopReminders",
		"midRunNudges",
		"eager",
	]);
	const task = requireRecord(root.task, "task", ["enabled", "eager", "forcedFanout", "maxRecursionDepth"]);
	const subagent = requireRecord(root.subagent, "subagent", [
		"forceToolCallBeforeYield",
		"semanticAutoRetry",
		"boundedTransportRetry",
	]);
	const roles = requireRecord(root.roles, "roles", ["internalInstructionMayUseUserRole"]);

	const stopReminders = requireBoolean(todo.stopReminders, "todo.stopReminders");
	const midRunNudges = requireBoolean(todo.midRunNudges, "todo.midRunNudges");
	if (stopReminders !== midRunNudges) {
		throw new Error("agent behavior todo.stopReminders and todo.midRunNudges must match the shared reminder default");
	}

	return {
		version: 1,
		automaticTurns: {
			allowed,
			forbidden: requireUniqueStrings(automaticTurns.forbidden, "automaticTurns.forbidden"),
		},
		goal: {
			enabled: requireBoolean(goal.enabled, "goal.enabled"),
			create: requireLiteral(goal.create, "goal.create", ["clear_user_or_system_request_only"]),
			autoContinue: requireLiteral(goal.autoContinue, "goal.autoContinue", ["active_only"]),
			continuationModes: requireUniqueStrings(goal.continuationModes, "goal.continuationModes"),
			continuationRole: requireLiteral(goal.continuationRole, "goal.continuationRole", ["internal_context"]),
			modelOperations: requireUniqueStrings(goal.modelOperations, "goal.modelOperations"),
			ownerOrSystemOperations: requireUniqueStrings(goal.ownerOrSystemOperations, "goal.ownerOrSystemOperations"),
			sameRouteFailureLimit: requireInteger(goal.sameRouteFailureLimit, "goal.sameRouteFailureLimit", 1),
		},
		todo: {
			enabled: requireBoolean(todo.enabled, "todo.enabled"),
			context: requireLiteral(todo.context, "todo.context", ["every_turn_when_present"]),
			contextItems: requireUniqueStrings(todo.contextItems, "todo.contextItems").map(value =>
				requireLiteral(value, "todo.contextItems", ["pending", "in_progress", "blocked"]),
			),
			autoContinue: requireFalse(todo.autoContinue, "todo.autoContinue"),
			stopReminders,
			midRunNudges,
			eager: requireLiteral(todo.eager, "todo.eager", ["default", "preferred", "always"]),
		},
		task: {
			enabled: requireBoolean(task.enabled, "task.enabled"),
			eager: requireLiteral(task.eager, "task.eager", ["default", "preferred", "always"]),
			forcedFanout: requireFalse(task.forcedFanout, "task.forcedFanout"),
			maxRecursionDepth: requireInteger(task.maxRecursionDepth, "task.maxRecursionDepth"),
		},
		subagent: {
			forceToolCallBeforeYield: requireFalse(subagent.forceToolCallBeforeYield, "subagent.forceToolCallBeforeYield"),
			semanticAutoRetry: requireFalse(subagent.semanticAutoRetry, "subagent.semanticAutoRetry"),
			boundedTransportRetry: requireTrue(subagent.boundedTransportRetry, "subagent.boundedTransportRetry"),
		},
		roles: {
			internalInstructionMayUseUserRole: requireFalse(
				roles.internalInstructionMayUseUserRole,
				"roles.internalInstructionMayUseUserRole",
			),
		},
	};
}

export const agentBehavior = parseAgentBehavior();

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
	if (
		typeof path !== "string" ||
		!path.endsWith(".md") ||
		path.startsWith("/") ||
		path.includes("..") ||
		path.startsWith("@")
	) {
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

export function registeredPromptRepositoryPath(sourcePath: string): string {
	return sourcePath.startsWith("_agent/")
		? `packages/agent/src/${sourcePath.slice("_agent/".length)}`
		: `packages/coding-agent/src/${sourcePath}`;
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
		sourcePath: registeredPromptRepositoryPath(entry.path),
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
	const rendered =
		entry.role === "internal_context" && id !== "provider.internal_context"
			? renderInstruction("provider.internal_context", { source: id, content: renderedText }, selectedTarget)
					.renderedText
			: renderedText;
	return {
		id,
		sourcePath: registeredPromptRepositoryPath(entry.path),
		role: entry.role,
		target: selectedTarget,
		trigger: entry.trigger,
		visibility: entry.visibility,
		sha256: sha256(rendered),
		renderedText: rendered,
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
