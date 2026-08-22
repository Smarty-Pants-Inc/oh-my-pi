import type { Agent, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model, ToolChoice } from "@oh-my-pi/pi-ai";
import { isRecord, logger, prompt, stringProperty } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { agentBehavior } from "../context/registry";
import type { AgentClosureRejection } from "../extensibility/shared-events";
import eagerTaskPrompt from "../prompts/system/eager-task.md" with { type: "text" };
import eagerTodoPrompt from "../prompts/system/eager-todo.md" with { type: "text" };
import passiveTodoSnapshotPrompt from "../prompts/todos/current.md" with { type: "text" };
import { getLatestTodoPhasesFromEntries, isTodoPhase, type TodoPhase } from "../tools/todo";
import { buildNamedToolChoice } from "../utils/tool-choice";
import type { AgentSessionEvent } from "./agent-session-events";
import type { SessionManager } from "./session-manager";

const PASSIVE_TODO_STATUSES = new Set<string>(agentBehavior.todo.contextItems);

export interface PassiveTodoSnapshot {
	semanticRole: "internal_context";
	source: "omp.todo";
	content: string;
	open: number;
	closed: number;
	phases: TodoPhase[];
}

function snapshotText(value: string): string {
	return value
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.replaceAll("\n", "\\n")
		.replaceAll("\t", "\\t")
		.replace(/[\u0085\u2028\u2029]/g, " ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

/** Render the provider-neutral todo working-memory component for a main turn. */
export function renderPassiveTodoSnapshot(phases: TodoPhase[]): PassiveTodoSnapshot | undefined {
	const openPhases = phases
		.map(phase => ({
			name: snapshotText(phase.name),
			tasks: phase.tasks
				.filter(task => PASSIVE_TODO_STATUSES.has(task.status))
				.map(task =>
					task.blocker === undefined
						? { content: snapshotText(task.content), status: task.status }
						: {
								content: snapshotText(task.content),
								status: task.status,
								blocker: snapshotText(task.blocker),
							},
				),
		}))
		.filter(phase => phase.tasks.length > 0);
	const open = openPhases.reduce((count, phase) => count + phase.tasks.length, 0);
	if (open === 0) return undefined;
	const closed = phases
		.flatMap(phase => phase.tasks)
		.filter(task => task.status === "completed" || task.status === "abandoned").length;
	return {
		semanticRole: "internal_context",
		source: "omp.todo",
		content: prompt.render(passiveTodoSnapshotPrompt, { phases: openPhases, open, closed }),
		open,
		closed,
		phases: openPhases,
	};
}

/** Capabilities the todo tracker borrows from its owning session. */
export interface TodoTrackerHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	model(): Model | undefined;
	usesOwnedToolDialect(): boolean;
	agentKind(): "main" | "sub";
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	queueTodoReconciliation(): (() => void) | undefined;
	promptGeneration(): number;
	hasPendingAsyncWake(): boolean;
	getActiveToolNames(): string[];
	getEnabledToolNames(): string[];
	toolRegistry(): Map<string, AgentTool>;
	planModeEnabled(): boolean;
	consumeLastServedToolChoiceLabel(): string | undefined;
}

/** Result of a stop-time todo completion check; undefined means no todo gate applies. */
export type TodoCompletionResult = AgentClosureRejection | "deferred" | undefined;

/** Owns canonical todo state, eager preludes, and passive snapshots. */
export class TodoTracker {
	readonly #host: TodoTrackerHost;
	#phases: TodoPhase[] = [];
	#reminderCount = 0;
	#stopReminderSent = false;

	constructor(host: TodoTrackerHost) {
		this.#host = host;
	}

	/** Returns a defensive clone of the current todo phases. */
	get phases(): TodoPhase[] {
		return this.#clonePhases(this.#phases);
	}

	/** Replaces todo phases with a defensive clone. */
	setPhases(phases: TodoPhase[]): void {
		this.#phases = this.#clonePhases(phases);
	}

	/** Rehydrates todo phases from the current transcript branch. */
	syncFromBranch(): void {
		this.setPhases(getLatestTodoPhasesFromEntries(this.#host.sessionManager.getBranch()));
	}

	/** Returns a defensive clone suitable for snapshots and branch state. */
	clonePhases(phases: TodoPhase[]): TodoPhase[] {
		return this.#clonePhases(phases);
	}

	/** Resets the stop-time reminder state for a new prompt. */
	resetCycle(): void {
		this.#reminderCount = 0;
		this.#stopReminderSent = false;
	}

	/** Compatibility no-op: subagent completion never starts todo reconciliation. */
	noteTaskCompletion(): void {}

	/** Compatibility no-op: tool results never trigger todo reconciliation. */
	onToolResult(_toolName: string, _isError: boolean, _details?: Record<string, unknown>): void {}

	/** Detects whether a successful todo result came from an init operation. */
	onTodoResultDetails(details: Record<string, unknown>, toolCallId: string | undefined): boolean {
		const phases = details.phases;
		if (!Array.isArray(phases) || !phases.every(isTodoPhase)) return false;
		const detailOp = stringProperty(details, "op");
		if (detailOp) return detailOp === "init";
		if (!toolCallId) return false;
		for (let index = this.#host.agent.state.messages.length - 1; index >= 0; index--) {
			const message = this.#host.agent.state.messages[index];
			if (!message) continue;
			const op = toolCallOpFromMessage(message, toolCallId);
			if (op) return op === "init";
		}
		return false;
	}

	/** Builds the first-turn eager todo prelude and optional forced tool choice. */
	createEagerTodoPrelude(
		promptText: string | undefined,
	): { message: AgentMessage; toolChoice?: ToolChoice } | undefined {
		const mode = this.#host.settings.get("todo.eager");
		if (mode === "default" || !this.#host.settings.get("todo.enabled")) return undefined;
		if (this.#host.planModeEnabled() || this.#phases.length > 0) return undefined;
		if (promptText !== undefined) {
			if (this.#host.agent.state.messages.some(message => message.role === "user")) return undefined;
			const trimmedPromptText = promptText.trimEnd();
			if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) return undefined;
		}
		const activeToolNames = this.#host.getActiveToolNames();
		if (!activeToolNames.includes("todo")) {
			logger.warn("Eager todo enforcement skipped because todo is not active", { activeToolNames });
			return undefined;
		}
		const message: AgentMessage = {
			role: "custom",
			customType: "eager-todo-prelude",
			content: prompt.render(eagerTodoPrompt, { ...this.#buildEagerPreludeContext(), forced: mode === "always" }),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		if (promptText === undefined || mode === "preferred") return { message };
		const model = this.#host.model();
		const toolChoice = buildNamedToolChoice("todo", model, this.#host.usesOwnedToolDialect());
		if (!toolChoice) {
			logger.warn(
				"Eager todo proceeding with the reminder only because the current model does not support a forced todo tool_choice",
				{ modelApi: model?.api, modelId: model?.id },
			);
			return { message };
		}
		return { message, toolChoice };
	}

	/** Builds the first-turn eager task-delegation prelude. */
	createEagerTaskPrelude(promptText: string | undefined): AgentMessage | undefined {
		if (this.#host.settings.get("task.eager") !== "always") return undefined;
		if (this.#host.agentKind() === "sub" || this.#host.planModeEnabled()) return undefined;
		if (promptText !== undefined) {
			if (this.#host.agent.state.messages.some(message => message.role === "user")) return undefined;
			const trimmed = promptText.trimEnd();
			if (trimmed.endsWith("?") || trimmed.endsWith("!")) return undefined;
		}
		if (!this.#host.getEnabledToolNames().includes("task")) return undefined;
		return {
			role: "custom",
			customType: "eager-task-prelude",
			content: prompt.render(eagerTaskPrompt, this.#buildEagerPreludeContext()),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}

	/** Builds reminder-only eager preludes after compaction. */
	buildPostCompactionEagerNudges(): AgentMessage[] {
		const nudges: AgentMessage[] = [];
		const todo = this.createEagerTodoPrelude(undefined);
		if (todo) nudges.push(todo.message);
		const task = this.createEagerTaskPrelude(undefined);
		if (task) nudges.push(task);
		return nudges;
	}

	/** Emits one bounded stop-time notification and reports stale or deferred todo closure. */
	async checkCompletion(): Promise<TodoCompletionResult> {
		if (this.#host.consumeLastServedToolChoiceLabel() === "user-force" || this.#host.planModeEnabled())
			return undefined;
		if (!this.#host.settings.get("todo.reminders") || !this.#host.settings.get("todo.enabled")) {
			this.#reminderCount = 0;
			this.#stopReminderSent = false;
			return undefined;
		}
		if (!this.#host.getActiveToolNames().includes("todo")) return undefined;
		const todos = this.phases
			.flatMap(phase => phase.tasks)
			.filter(task => task.status === "pending" || task.status === "in_progress");
		if (todos.length === 0) return undefined;
		if (this.#host.hasPendingAsyncWake()) return "deferred";
		const maxAttempts = this.#host.settings.get("todo.remindersMax");
		if (!this.#stopReminderSent && this.#reminderCount < maxAttempts) {
			this.#reminderCount++;
			await this.#host.emitSessionEvent({
				type: "todo_reminder",
				todos,
				attempt: this.#reminderCount,
				maxAttempts,
			});
			this.#stopReminderSent = true;
		}
		return { reason: "stale_todos", todos };
	}

	/** Todo state never injects a mid-turn nudge. */
	takeMidRunNudge(): null {
		return null;
	}

	/** Renders the compact, provider-neutral working-memory component for a main turn. */
	buildPassiveSnapshot(): PassiveTodoSnapshot | undefined {
		if (this.#host.agentKind() !== "main") return undefined;
		return renderPassiveTodoSnapshot(this.#clonePhases(this.#phases));
	}

	#buildEagerPreludeContext(): { toolRefs: Record<string, string>; taskBatch: boolean } {
		const wireName = (name: string): string => {
			const tool = this.#host.toolRegistry().get(name);
			return typeof tool?.customWireName === "string" ? tool.customWireName : name;
		};
		return {
			toolRefs: { task: wireName("task"), todo: wireName("todo") },
			taskBatch: this.#host.settings.get("task.batch"),
		};
	}

	#clonePhases(phases: TodoPhase[]): TodoPhase[] {
		return phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task =>
				task.blocker !== undefined
					? { content: task.content, status: task.status, blocker: task.blocker }
					: { content: task.content, status: task.status },
			),
		}));
	}
}

function toolCallOpFromMessage(message: AgentMessage, toolCallId: string): string | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall" || block.id !== toolCallId) continue;
		return isRecord(block.arguments) ? stringProperty(block.arguments, "op") : undefined;
	}
	return undefined;
}
