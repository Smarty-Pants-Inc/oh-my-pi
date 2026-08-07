/**
 * Extension system for lifecycle events and custom tools.
 */

export type { ExecutionEnvironmentProvider } from "../../session/execution-environment";
export type { RuntimeProvider, RuntimeProviderRegistry } from "../../session/workspace-runtime-contracts.js";
export type { SlashCommandInfo, SlashCommandLocation, SlashCommandSource } from "../slash-commands";
export {
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	ExtensionRuntimeNotInitializedError,
	loadExtensionFromFactory,
	loadExtensions,
} from "./loader";
export * from "./runner";
// Type guards
export * from "./types";
export * from "./wrapper";
