import { HookEditorComponent, HookInputComponent, HookSelectorComponent } from "./modes/components";

// Core session management

// Re-export TUI components for custom tool rendering
export { Container, Markdown, Spacer, Text } from "@oh-my-pi/pi-tui";
// Logging
export { getAgentDir, logger, VERSION } from "@oh-my-pi/pi-utils";
export * as zod from "zod/v4";
export { z } from "zod/v4";
export * from "./config/keybindings";
export * from "./config/model-connection-contracts.js";
export * from "./config/model-registry";
// Prompt templates
export type * from "./config/prompt-templates";
export * from "./config/prompt-templates";
export type { RetrySettings, SkillsSettings } from "./config/settings";
export { Settings, settings } from "./config/settings";
// Custom commands
export type * from "./extensibility/custom-commands/types";
export type * from "./extensibility/custom-tools";
// Custom tools
export * from "./extensibility/custom-tools";
export type * from "./extensibility/extensions";
// Extension types and utilities
export * from "./extensibility/extensions";
// Hook system types (legacy re-export)
// Skills
export * from "./extensibility/skills";
// Slash commands
export { type FileSlashCommand, loadSlashCommands as discoverSlashCommands } from "./extensibility/slash-commands";
export type * from "./lsp";
// Main entry point
export * from "./main";
// Run modes for programmatic SDK usage
export * from "./modes";
export * from "./modes/components";
// Theme utilities for custom tools
export * from "./modes/theme/theme";
// SDK for programmatic usage
export * from "./sdk";
export * from "./session/agent-session";
// Auth and model registry
export * from "./session/auth-storage";
export * from "./session/execution-environment";
export * from "./session/indexed-session-storage";
export * from "./session/messages";
export * from "./session/redis-session-storage";
export * from "./session/session-context";
export * from "./session/session-dump-format";
export * from "./session/session-entries";
export * from "./session/session-journal-contracts.js";
export * from "./session/session-listing";
export * from "./session/session-loader";
export * from "./session/session-manager";
export * from "./session/session-migrations";
export * from "./session/session-storage";
export * from "./session/sql-session-storage";
export * from "./session/workspace-runtime-contracts.js";
export * from "./task/executor";
export type * from "./task/types";
export {
	validateAndProjectTransientEvalForegroundSourceAgentToolResultV1,
	validateAndProjectTransientTaskForegroundSourceAgentToolResultV1,
} from "./task/types";
// Tools (detail types and utilities)
export * from "./tools";
export type {
	CloneOptions,
	CommitAuthor,
	CommitDetails,
	CommitOptions,
	DetachGitDirResult,
	DiffOptions,
	FetchOptions,
	GhCommandOptions,
	GhCommandResult,
	GitCommandResult,
	GitDetachedHead,
	GitHeadState,
	GitRefHead,
	GitRepository,
	GitStatusSummary,
	GitWorktreeEntry,
	HunkSelection,
	HunkSelectionValidationError,
	PatchOptions,
	PushOptions,
	RestoreOptions,
	StageHunksOptions,
	StatusOptions,
} from "./utils/git";
export {
	branch,
	checkout,
	cherryPick,
	clean,
	clone,
	commit,
	commitDetails,
	config,
	createHunkSelectionValidator,
	detachGitDir,
	diff,
	fetch,
	GIT_COMMAND_OUTPUT_LIMIT_BYTES,
	GIT_COMMAND_TIMEOUT_MS,
	GIT_NETWORK_TIMEOUT_MS,
	GIT_SPAWN_SYNC_TIMEOUT_MS,
	GitCommandError,
	github,
	head,
	log,
	ls,
	patch,
	push,
	readTree,
	ref,
	remote,
	repo,
	reset,
	restore,
	revList,
	show,
	stage,
	stash,
	status,
	validateHunkSelections,
	withRepoLock,
	worktree,
	writeTree,
} from "./utils/git";
// UI components for extensions
export {
	HookEditorComponent as ExtensionEditorComponent,
	HookInputComponent as ExtensionInputComponent,
	HookSelectorComponent as ExtensionSelectorComponent,
};
