import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui";
import { getProjectDir, isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { canonicalPath } from "../capability/session-capabilities";
import type { Settings } from "../config/settings";
import { applyDirenvPreflight, type BashResult, executeBash } from "../exec/bash-executor";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { truncateToVisualLines } from "../modes/components/visual-truncate";
import { highlightCode, type Theme } from "../modes/theme/theme";
import bashDescription from "../prompts/tools/bash.md" with { type: "text" };
import type {
	ClientBridgeCreateTerminalParams,
	ClientBridgeTerminalExitStatus,
	ClientBridgeTerminalHandle,
	ClientBridgeTerminalOutput,
} from "../session/client-bridge";
import { type ExecutionEnvironmentBinding, mapExecutionEnvironmentPath } from "../session/execution-environment";
import { DEFAULT_MAX_BYTES, enforceInlineByteCap, streamTailUpdates, TailBuffer } from "../session/streaming-output";
import { renderStatusLine } from "../tui";
import { CachedOutputBlock, markFramedBlockComponent, outputBlockContentWidth } from "../tui/output-block";
import { getSixelLineMask } from "../utils/sixel";
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { type BashInteractiveResult, runInteractiveBashPty } from "./bash-interactive";
import { checkBashInterception } from "./bash-interceptor";
import { canUseInteractiveBashPty } from "./bash-pty-selection";
import { expandInternalUrls, type InternalUrlExpansionOptions } from "./bash-skill-urls";
import { resolveEvalBackends } from "./eval-backends";
import { invalidateGithubCacheForBashCommand } from "./gh-cache-invalidation";
import {
	formatStyledTruncationWarning,
	type OutputMeta,
	resolveInlineByteCapBudget,
	stripOutputNotice,
	stripRawOutputArtifactNotice,
} from "./output-meta";
import { resolveToCwd } from "./path-utils";
import {
	capPreviewLines,
	DEFAULT_TERMINAL_PREVIEW_LINES,
	formatToolWorkingDirectory,
	previewWindowRows,
	replaceTabs,
} from "./render-utils";
import { extractLeadingCdTarget, tokenizeShellSegments } from "./shell-tokenize";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout, TOOL_TIMEOUTS } from "./tool-timeouts";

export const BASH_DEFAULT_PREVIEW_LINES = DEFAULT_TERMINAL_PREVIEW_LINES;

const BASH_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 60_000;
const BASH_APPROVAL_SHELL_CONTROL_CHARS: Record<string, true> = {
	"\n": true,
	"\r": true,
	";": true,
	"&": true,
	"|": true,
	"<": true,
	">": true,
	"`": true,
	$: true,
	"(": true,
	")": true,
};
const BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE = /(?:^|[ \t])(?:-[^-]*[ce]|--(?:command|eval))(?:[= \t]|$)/u;
const BASH_WRITE_COMMANDS_ALL_TARGETS = new Set(["chmod", "chown", "mkdir", "rm", "rmdir", "tee", "touch", "truncate"]);
const BASH_WRITE_COMMANDS_LAST_TARGET = new Set(["cp", "install", "ln", "mv"]);
const BASH_SAFE_READONLY_COMMANDS = new Set([
	"[",
	"cat",
	"dirname",
	"echo",
	"false",
	"head",
	"ls",
	"pwd",
	"printf",
	"readlink",
	"realpath",
	"stat",
	"tail",
	"test",
	"true",
	"wc",
]);
const BASH_SAFE_GIT_READ_SUBCOMMANDS = new Set(["diff", "log", "ls-files", "rev-parse", "show", "status"]);
const BASH_SAFE_BUN_RUN_SCRIPTS = new Set(
	[
		["build", "bun run --workspaces --if-present build"],
		["build", "bun ../../scripts/bazel-natives.ts host --dest native"],
		["build", "bun scripts/build-binary.ts"],
		["build", "bun scripts/build-extension.ts"],
		["build", "bun run build.ts"],
		["build", "vite build"],
		["build:native", "bun --cwd=packages/natives run build"],
		["check", "biome check . && bun run check:types"],
		["check", "biome check . && tsgo -p tsconfig.json --noEmit"],
		["check", "bun run --parallel check:ts check:rs"],
		["check:rs", "bun scripts/run-rs-task.ts check:rs"],
		["check:tools", "biome check . --no-errors-on-unmatched"],
		["check:ts", "bun run check:tools && bun run --workspaces --if-present check"],
		["check:types", "tsc --noEmit"],
		["check:types", "tsgo -p tsconfig.json --noEmit"],
		["check:types", "tsgo -p tsconfig.json --noEmit && tsgo -p tsconfig.client.json --noEmit"],
		["check:types", "tsgo -p tsconfig.json --noEmit && tsgo -p tsconfig.worker.json --noEmit"],
		["ci:check:full", "bun run check:ts"],
		["ci:test:full", "bun run ci:test:ts && bun run test:rs"],
		[
			"ci:test:smoke",
			"bun packages/coding-agent/src/cli.ts --version && bun packages/coding-agent/src/cli.ts --help && bun packages/coding-agent/src/cli.ts stats --help && bun packages/coding-agent/src/cli.ts --smoke-test",
		],
		["ci:test:ts", "bun scripts/ci-test-ts.ts all"],
		["collab:web:build", "bun --cwd=packages/collab-web run build"],
		["test", "bun ../../scripts/ci-test-ts.ts coding-agent-heavy --full"],
		["test", "bun scripts/ci-test-ts.ts local"],
		["test", "bun test"],
		["test", "bun test --parallel"],
		["test", "bun test --parallel test/*.test.ts"],
		["test", "bun test --timeout 30000 test"],
		["test:rs", "bun scripts/run-rs-task.ts test:rs"],
		[
			"test:scripts",
			"bun test scripts/ci-test-ts.test.ts scripts/ci-release-build-binaries.test.ts scripts/musl-release.test.ts scripts/ci-release-publish.test.ts scripts/release.test.ts",
		],
		["test:ts", "bun scripts/ci-test-ts.ts local-ts"],
	].map(([name, body]) => `${name}\0${body}`),
);
const BASH_SAFE_BUN_TEST_BOOLEAN_FLAGS = new Set([
	"--bail",
	"--concurrent",
	"--coverage",
	"--help",
	"--only-failures",
	"--parallel",
	"--pass-with-no-tests",
	"--randomize",
	"--todo",
	"--update-snapshots",
	"-h",
	"-u",
]);
const BASH_SAFE_BUN_TEST_NUMERIC_VALUE_FLAGS = new Set(["--max-concurrency", "--rerun-each", "--seed", "--timeout"]);
const BASH_SAFE_BUN_TEST_ENUM_VALUE_FLAGS = new Map<string, ReadonlySet<string>>([
	["--coverage-reporter", new Set(["lcov", "text"])],
	["--reporter", new Set(["dots", "junit"])],
]);
const BASH_SAFE_BUN_TEST_STRING_VALUE_FLAGS = new Set(["--test-name-pattern"]);
const BASH_GITHUB_PR_EFFECTS = new Set([
	"close",
	"comment",
	"create",
	"delete",
	"edit",
	"lock",
	"merge",
	"ready",
	"reopen",
	"review",
	"unlock",
	"update-branch",
]);

function hasBashApprovalShellControl(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let hasReinterpretableShellControl = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") {
				quote = undefined;
			} else if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) {
				hasReinterpretableShellControl = true;
			}
			continue;
		}
		if (ch === "\\") {
			const escaped = command[i + 1];
			if (escaped && Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, escaped)) {
				hasReinterpretableShellControl = true;
			}
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			// Expansion is active inside double quotes even in the original line.
			if (ch === "`" || ch === "$") return true;
			// Other control characters are literal here but become executable if a
			// `-c`/`-e` option reinterprets the argument through another shell.
			if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) hasReinterpretableShellControl = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (Object.hasOwn(BASH_APPROVAL_SHELL_CONTROL_CHARS, ch)) return true;
	}
	// Options such as `git -c alias.x='!...'` and `sh -c "..."` reinterpret
	// otherwise literal quoted or escaped arguments as executable code.
	return hasReinterpretableShellControl && BASH_APPROVAL_REINTERPRETED_ARGUMENT_RE.test(command);
}

function isShellAssignment(token: string): boolean {
	const equalsIndex = token.indexOf("=");
	return equalsIndex > 0 && BASH_ENV_NAME_PATTERN.test(token.slice(0, equalsIndex));
}

function shellCommandIndex(tokens: readonly string[]): number | undefined {
	for (let index = 0; index < tokens.length; index++) {
		if (!isShellAssignment(tokens[index]!)) return index;
	}
	return undefined;
}

function shellPositionals(tokens: readonly string[]): string[] {
	const positionals: string[] = [];
	let optionsEnded = false;
	for (const token of tokens) {
		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && token.startsWith("-")) continue;
		positionals.push(token);
	}
	return positionals;
}

function bashWriteTargets(tokens: readonly string[]): string[] {
	const commandIndex = shellCommandIndex(tokens);
	if (commandIndex === undefined) return [];
	const command = tokens[commandIndex]!;
	const args = tokens.slice(commandIndex + 1);
	const positionals = shellPositionals(args);
	const targets: string[] = [];

	if (BASH_WRITE_COMMANDS_ALL_TARGETS.has(command)) {
		targets.push(...positionals);
	} else if (BASH_WRITE_COMMANDS_LAST_TARGET.has(command) && positionals.length > 0) {
		targets.push(positionals.at(-1)!);
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (arg === "-t" || arg === "--target-directory") {
				const target = args[index + 1];
				if (target) targets.push(target);
				index++;
			} else if (arg.startsWith("--target-directory=")) {
				targets.push(arg.slice("--target-directory=".length));
			}
		}
	} else if ((command === "sed" || command === "perl") && args.some(arg => arg === "-i" || arg.startsWith("-i"))) {
		// The in-place form writes every input path after its program expression.
		// It is intentionally conservative: validating an extra literal token only
		// denies a request that cannot prove all of its write destinations.
		targets.push(...positionals.slice(1));
	} else if (command === "dd") {
		for (const arg of args) {
			if (arg.startsWith("of=")) targets.push(arg.slice("of=".length));
		}
	} else if (command === "git") {
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!;
			if (arg === "--output") {
				const target = args[index + 1];
				if (target) targets.push(target);
				index++;
			} else if (arg.startsWith("--output=")) {
				targets.push(arg.slice("--output=".length));
			}
		}
	}

	return targets;
}

function readShellRedirectTarget(command: string, start: number): { target: string; end: number } | undefined {
	let index = start;
	while (command[index] === " " || command[index] === "\t") index++;
	if (index >= command.length || /[\n\r;&|()<>]/u.test(command[index]!)) return undefined;

	let target = "";
	let quote: "'" | '"' | undefined;
	for (; index < command.length; index++) {
		const ch = command[index]!;
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else target += ch;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
			} else if (ch === "\\" && index + 1 < command.length) {
				target += command[++index]!;
			} else {
				target += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\" && index + 1 < command.length) {
			target += command[++index]!;
			continue;
		}
		if (/[ \t\n\r;&|()<>]/u.test(ch)) break;
		target += ch;
	}
	return target.length > 0 ? { target, end: index } : undefined;
}

/**
 * Extract literal write destinations from raw shell syntax, including attached
 * redirects (`x>file`, `2>>file`, `1<>file`) that the word tokenizer keeps in
 * one token. Input-only redirects are intentionally ignored; `<>` may create
 * or modify its target and therefore requires write authority.
 */
function shellRedirectWriteTargets(command: string): string[] {
	const targets: string[] = [];
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index++) {
		const ch = command[index]!;
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\") index++;
			else if (ch === '"') quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\") {
			index++;
			continue;
		}

		const inputOutput = ch === "<" && command[index + 1] === ">";
		if (ch !== ">" && !inputOutput) continue;
		let targetStart = index + (inputOutput || command[index + 1] === ">" ? 2 : 1);
		if (!inputOutput && command[targetStart] === "|") targetStart++;
		const ampersandTarget = command[targetStart] === "&";
		if (ampersandTarget) targetStart++;
		const target = readShellRedirectTarget(command, targetStart);
		if (!target) continue;
		// `2>&1` / `>&-` duplicate or close a descriptor. `>&path` redirects to
		// a path and must remain subject to the same capability check.
		if (!ampersandTarget || !/^(?:\d+|-)$/.test(target.target)) targets.push(target.target);
		index = target.end - 1;
	}
	return targets;
}

function bashCommandWriteTargets(command: string): string[] {
	return [...tokenizeShellSegments(command).flatMap(bashWriteTargets), ...shellRedirectWriteTargets(command)];
}

function executableEnvironmentOverrideName(name: string): boolean {
	const normalized = name.toUpperCase();
	return (
		normalized === "PATH" ||
		normalized === "HOME" ||
		normalized === "XDG_CONFIG_HOME" ||
		normalized === "XDG_CONFIG_DIRS" ||
		normalized === "ENV" ||
		normalized === "BASH_ENV" ||
		normalized === "ZDOTDIR" ||
		normalized === "SHELL" ||
		normalized === "SHELLOPTS" ||
		normalized === "BASHOPTS" ||
		normalized === "EDITOR" ||
		normalized === "VISUAL" ||
		normalized === "BROWSER" ||
		normalized === "PAGER" ||
		normalized === "SSH_ASKPASS" ||
		normalized === "SSH_ASKPASS_REQUIRE" ||
		normalized === "NODE_OPTIONS" ||
		normalized === "BUN_OPTIONS" ||
		normalized === "LD_PRELOAD" ||
		normalized === "LD_LIBRARY_PATH" ||
		normalized === "DYLD_INSERT_LIBRARIES" ||
		normalized === "DYLD_LIBRARY_PATH" ||
		normalized.startsWith("GIT_") ||
		normalized.startsWith("GH_")
	);
}

function hasExecutableEnvironmentOverride(env: Record<string, string> | undefined): boolean {
	return Boolean(env && Object.keys(env).some(executableEnvironmentOverrideName));
}

function effectCommandIndex(tokens: readonly string[], env: Record<string, string> | undefined): number | undefined {
	const gitIndex = shellCommandIndex(tokens);
	if (gitIndex === undefined || hasExecutableEnvironmentOverride(env)) return undefined;
	for (const token of tokens.slice(0, gitIndex)) {
		const name = token.slice(0, token.indexOf("="));
		if (executableEnvironmentOverrideName(name)) return undefined;
	}
	return gitIndex;
}

function commandHasGitPush(tokens: readonly string[], env?: Record<string, string>): boolean {
	const gitIndex = effectCommandIndex(tokens, env);
	if (gitIndex === undefined || tokens[gitIndex] !== "git") return false;
	// A named push grant authorizes the push subcommand, not Git's global
	// config, repository, cwd, helper, or execution-path overrides.
	if (tokens[gitIndex + 1] !== "push") return false;
	return !tokens
		.slice(gitIndex + 2)
		.some(
			arg =>
				arg === "--exec" ||
				arg.startsWith("--exec=") ||
				arg === "--receive-pack" ||
				arg.startsWith("--receive-pack="),
		);
}

function commandHasGithubPrEffect(tokens: readonly string[], env?: Record<string, string>): boolean {
	const ghIndex = effectCommandIndex(tokens, env);
	if (ghIndex === undefined || tokens[ghIndex] !== "gh") return false;
	const args = tokens.slice(ghIndex + 1).filter(arg => !arg.startsWith("-"));
	return args[0] === "pr" && BASH_GITHUB_PR_EFFECTS.has(args[1] ?? "");
}

function isCanonicalPathContained(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isPathContained(root: string, target: string, base = root): boolean {
	try {
		return isCanonicalPathContained(canonicalPath(root), canonicalPath(target, base));
	} catch {
		return false;
	}
}

function hasUnsafeShellExpansion(value: string): boolean {
	return /[~*?[\]{}$`]/u.test(value);
}

function bunTestIsKnownSafe(args: readonly string[], cwd: string): boolean {
	if (args[0] !== "test") return false;
	for (let index = 1; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--") return false;
		if (BASH_SAFE_BUN_TEST_BOOLEAN_FLAGS.has(arg)) continue;
		if (/^--(?:bail|parallel)=\d+$/u.test(arg)) continue;
		if (BASH_SAFE_BUN_TEST_NUMERIC_VALUE_FLAGS.has(arg)) {
			if (index + 1 >= args.length) return false;
			if (!/^\d+$/u.test(args[index + 1]!)) return false;
			index++;
			continue;
		}
		if (BASH_SAFE_BUN_TEST_STRING_VALUE_FLAGS.has(arg)) {
			if (index + 1 >= args.length) return false;
			if (hasUnsafeShellExpansion(args[index + 1]!)) return false;
			index++;
			continue;
		}
		const equalsIndex = arg.indexOf("=");
		if (equalsIndex > 0) {
			const flag = arg.slice(0, equalsIndex);
			const value = arg.slice(equalsIndex + 1);
			if (BASH_SAFE_BUN_TEST_NUMERIC_VALUE_FLAGS.has(flag) && /^\d+$/u.test(value)) continue;
			if (BASH_SAFE_BUN_TEST_STRING_VALUE_FLAGS.has(flag) && !hasUnsafeShellExpansion(value)) continue;
			if (BASH_SAFE_BUN_TEST_ENUM_VALUE_FLAGS.get(flag)?.has(value)) continue;
		}
		const enumValues = BASH_SAFE_BUN_TEST_ENUM_VALUE_FLAGS.get(arg);
		if (enumValues) {
			if (index + 1 >= args.length || !enumValues.has(args[index + 1]!)) return false;
			index++;
			continue;
		}
		if (
			arg.startsWith("-") ||
			hasUnsafeShellExpansion(arg) ||
			path.isAbsolute(arg) ||
			/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(arg) ||
			/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(arg) ||
			!isPathContained(cwd, arg)
		) {
			return false;
		}
	}
	return true;
}

function bunCommandIsKnownSafe(
	tokens: readonly string[],
	commandIndex: number,
	cwd: string,
	env: Record<string, string> | undefined,
): boolean {
	if (commandIndex !== 0) return false;
	if (hasExecutableEnvironmentOverride(env)) return false;
	const args = tokens.slice(commandIndex + 1);
	if (args[0] === "run") {
		if (args.length !== 2) return false;
		const manifestPath = resolveToCwd("package.json", cwd);
		try {
			if (fs.lstatSync(manifestPath).isSymbolicLink()) return false;
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { scripts?: Record<string, unknown> };
			const name = args[1]!;
			const scripts = manifest.scripts;
			const body = scripts?.[name];
			if (scripts && (Object.hasOwn(scripts, `pre${name}`) || Object.hasOwn(scripts, `post${name}`))) return false;
			return typeof body === "string" && BASH_SAFE_BUN_RUN_SCRIPTS.has(`${name}\0${body}`);
		} catch {
			return false;
		}
	}
	return bunTestIsKnownSafe(args, cwd);
}

function rgCommandIsKnownSafe(
	tokens: readonly string[],
	commandIndex: number,
	env: Record<string, string> | undefined,
): boolean {
	if (commandIndex !== 0 || hasExecutableEnvironmentOverride(env)) return false;
	const args = tokens.slice(commandIndex + 1);
	if (
		args.some(
			arg => arg === "--pre" || arg.startsWith("--pre=") || arg === "--pre-glob" || arg.startsWith("--pre-glob="),
		)
	) {
		return false;
	}
	const noConfig = args.includes("--no-config");
	if (!noConfig && (env?.RIPGREP_CONFIG_PATH || process.env.RIPGREP_CONFIG_PATH)) return false;
	return true;
}

function gitCommandIsKnownSafe(
	tokens: readonly string[],
	commandIndex: number,
	env: Record<string, string> | undefined,
): boolean {
	if (commandIndex !== 0 || hasExecutableEnvironmentOverride(env)) return false;
	const helperEnvironment = (name: string): boolean =>
		name === "GIT_EXTERNAL_DIFF" || name === "GIT_PAGER" || name === "PAGER" || name.startsWith("GIT_CONFIG_");
	if (env && Object.keys(env).some(helperEnvironment)) return false;
	if (
		Object.entries(process.env).some(
			([name, value]) => Boolean(value) && (name === "GIT_EXTERNAL_DIFF" || name.startsWith("GIT_CONFIG_")),
		)
	) {
		return false;
	}

	const args = tokens.slice(commandIndex + 1);
	let subcommandIndex = 0;
	while (args[subcommandIndex] === "--no-pager") subcommandIndex++;
	const subcommand = args[subcommandIndex];
	if (!subcommand || !BASH_SAFE_GIT_READ_SUBCOMMANDS.has(subcommand)) return false;
	if (args.slice(0, subcommandIndex).some(arg => arg !== "--no-pager")) return false;
	if (
		args.some(
			arg =>
				arg === "-c" ||
				(arg.startsWith("-c") && arg.length > 2) ||
				arg === "--config-env" ||
				arg.startsWith("--config-env=") ||
				arg === "--ext-diff" ||
				arg.startsWith("--ext-diff=") ||
				arg === "--textconv" ||
				arg.startsWith("--textconv="),
		)
	) {
		return false;
	}
	if (subcommand === "diff" || subcommand === "log" || subcommand === "show") {
		const subcommandArgs = args.slice(subcommandIndex + 1);
		return subcommandArgs.includes("--no-ext-diff") && subcommandArgs.includes("--no-textconv");
	}
	return true;
}

function commandIsKnownSafe(tokens: readonly string[], cwd: string, env: Record<string, string> | undefined): boolean {
	const commandIndex = shellCommandIndex(tokens);
	if (commandIndex === undefined) return true;
	const command = tokens[commandIndex]!;
	if (BASH_SAFE_READONLY_COMMANDS.has(command)) return true;
	if (command === "rg") return rgCommandIsKnownSafe(tokens, commandIndex, env);
	if (BASH_WRITE_COMMANDS_ALL_TARGETS.has(command) || BASH_WRITE_COMMANDS_LAST_TARGET.has(command)) {
		// Flags alter many mutators' target semantics (`cp -t`, in-place
		// editors, archive extraction). Their complete grammar is not an
		// authority parser, so a generic capability is required as well.
		return !tokens.slice(commandIndex + 1).some(arg => arg.startsWith("-") && arg !== "--");
	}
	if (command === "dd") return tokens.slice(commandIndex + 1).some(arg => arg.startsWith("of="));
	if (command === "sed" || command === "perl") {
		return tokens.slice(commandIndex + 1).some(arg => arg === "-i" || arg.startsWith("-i"));
	}
	if (command === "bun") return bunCommandIsKnownSafe(tokens, commandIndex, cwd, env);
	if (command === "git") return gitCommandIsKnownSafe(tokens, commandIndex, env) || commandHasGitPush(tokens, env);
	return commandHasGitPush(tokens, env) || commandHasGithubPrEffect(tokens, env);
}

function commandNeedsGenericExternalCapability(
	command: string,
	tokens: readonly string[],
	cwd: string,
	env: Record<string, string> | undefined,
): boolean {
	// Substitutions and nested shell expressions cannot prove which executable or
	// paths the shell will select. Simple compound segments are checked one by one.
	if (/[`$()]/u.test(command)) return true;
	return !commandIsKnownSafe(tokens, cwd, env);
}

function assertBashExternalCapability(session: ToolSession, capability: string): void {
	const decision = session.capabilities?.decideExternalEffect(capability);
	if (!decision || decision.outcome === "allow") return;
	throw new ToolError(`Bash command requires explicit session capability '${capability}'.`);
}

function assertBashCommandCapability(session: ToolSession, command: string): void {
	if (session.capabilities?.decideExternalEffect("bash.external").outcome === "allow") return;
	assertBashExternalCapability(session, `bash.command:${command.trim()}`);
}

function assertBashWriteCapability(
	session: ToolSession,
	target: string,
	cwd: string,
	env: Record<string, string> | undefined,
): void {
	if (target.includes("$") || target.includes("`") || /[*?[\]{}]/u.test(target)) {
		throw new ToolError(`Bash write target '${target}' cannot be validated safely.`);
	}
	if (target.startsWith("~") && target !== "~" && !target.startsWith("~/")) {
		throw new ToolError(`Bash write target '${target}' cannot be validated safely.`);
	}
	const home = env?.HOME;
	if ((target === "~" || target.startsWith("~/")) && !home?.startsWith("/")) {
		throw new ToolError(
			`Bash write target '${target}' cannot be validated safely without an explicit absolute HOME.`,
		);
	}
	const normalizedTarget = target === "~" || target.startsWith("~/") ? `${home}${target.slice(1)}` : target;
	const resolvedTarget = resolveToCwd(normalizedTarget, cwd);
	const decision = session.capabilities?.decideWrite(resolvedTarget, session.cwd);
	if (!decision) return;
	if (decision.outcome === "allow") return;
	if (decision.outcome === "request") {
		throw new ToolError(
			`Bash write target '${decision.target}' requires an explicit session writePath capability outside '${session.cwd}'.`,
		);
	}
	throw new ToolError(`Bash write target '${decision.target}' cannot be canonicalized safely.`);
}

function isCurrentWorkspacePath(session: ToolSession, target: string): boolean {
	return session.capabilities?.isWorkspacePath(target, session.cwd) ?? isPathContained(session.cwd, target);
}

/**
 * Apply session authority before choosing any Bash backend. This is deliberately
 * a small syntax-based gate, not a claim to understand arbitrary shell code:
 * known write destinations and the capabilities exposed by the GitHub tool are
 * checked; dynamic write destinations fail closed rather than bypassing policy.
 */
function assertBashCapabilities(
	session: ToolSession,
	command: string,
	cwd: string,
	env: Record<string, string> | undefined,
): void {
	if (!session.capabilities) return;
	for (const target of bashCommandWriteTargets(command)) {
		assertBashWriteCapability(session, target, cwd, env);
	}
	for (const tokens of tokenizeShellSegments(command)) {
		if (commandHasGitPush(tokens, env)) {
			assertBashExternalCapability(session, "git.push");
		}
		if (commandHasGithubPrEffect(tokens, env)) {
			assertBashExternalCapability(session, "github.pr");
		}
		const cwdIsWorkspace = isCurrentWorkspacePath(session, cwd);
		if (!cwdIsWorkspace || commandNeedsGenericExternalCapability(command, tokens, cwd, env)) {
			assertBashCommandCapability(session, command);
		}
	}
}

const BASH_PATTERN_APPROVAL_VALUES = new Set(["allow", "deny", "prompt"]);

/**
 * Shape a shell command line for an ACP-conformant `terminal/create` request.
 *
 * ACP's `command` field is documented as the executable and `args` as its
 * argv tail (see https://agentclientprotocol.com/protocol/v1/terminals), so a
 * spec-conformant client `spawn(command, args)`s them directly — no implicit
 * shell. A raw `bash` tool line ("git status && echo x | head") therefore has
 * to be wrapped in an explicit shell invocation, otherwise the client tries
 * to spawn the whole line as argv[0] and fails with `ENOENT` for anything
 * containing a space, pipe, `&&`, redirect, or `$(...)`.
 *
 * The wrap reuses the same shell binary + args the local `bash-executor` would
 * pick via `settings.getShellConfig()` — Git Bash / `bash.exe` on Windows
 * (`cmd.exe /c` as the last-resort fallback when no bash exists on the host),
 * `$SHELL` (bash/zsh) with the `sh` fallback on POSIX — so the ACP path
 * preserves `bash` tool semantics (`$VAR`, `$(...)`, `source`, POSIX quoting,
 * `-l`) wherever a POSIX shell is available. The agent host's shell path is
 * used as a proxy for the client's, matching the near-universal ACP
 * deployment shape of an editor spawning omp as a co-hosted subprocess.
 */
export function wrapShellLineForClientTerminal(
	line: string,
	shellConfig: { shell: string; args: string[]; prefix?: string | undefined },
): { command: string; args: string[] } {
	const finalLine = shellConfig.prefix ? `${shellConfig.prefix} ${line}` : line;
	return { command: shellConfig.shell, args: [...shellConfig.args, finalLine] };
}

/**
 * Mirrors pi-shell's `uutils_env_disabled` gate for `PI_DISABLE_UUTILS_BUILTINS`:
 * session shell env first, then process env; truthy = present and not "", "0",
 * or "false". Controls whether the prompt advertises the in-process builtins.
 */
function shellBuiltinsDisabled(settings: Settings): boolean {
	const raw = settings.getShellConfig().env?.PI_DISABLE_UUTILS_BUILTINS ?? Bun.env.PI_DISABLE_UUTILS_BUILTINS;
	return !!raw && raw !== "0" && raw.toLowerCase() !== "false";
}

/**
 * Bash patterns flagged as safety critical for approval policy.
 *
 * Kept intentionally tight — the cost of a false negative is data loss or a compromised host,
 * while false positives remain actionable through user policy control.
 * New patterns should target shapes that are virtually never legitimate in automation.
 */
export const CRITICAL_BASH_PATTERNS = [
	// Recursive destruction.
	/\brm\s+-[a-z]*[rRfF][a-z]*\s+\//i, // rm -rf /, rm -fr /, rm -r /, rm -f /…
	/\bsudo\s+rm\b/i, // any `sudo rm`.
	/\bchmod\s+-R\s+[0-7]+\s+\//i, // `chmod -R 777 /`.
	/\bchmod\s+-R\s+[ugoa+\-=rwxXst,]+\s+\//, // `chmod -R u+x /`, `chmod -R u+rwx,o+w /etc` (symbolic mode, root target).
	/\bchown\s+-R\s+\S+\s+\//i, // `chown -R user /`.

	// Fork bomb (a few common spacings).
	/:\(\)\s*\{\s*:\s*\|\s*:/i,

	// Disk / filesystem destruction.
	/>\s*\/dev\/sd[a-z]/i, // write to disk device.
	/\bmkfs(\.|\b)/i, // format filesystem.
	/\bdd\s+if=.+of=\/dev\//i, // dd to a device.
	/\bshred\s+\/dev\//i,
	/\bcryptsetup\b/i,

	// System-config destruction.
	/>\s*\/etc\/(?:passwd|shadow|sudoers)\b/i,
	/\btee\s+(?:-a\s+)?\/etc\/(?:passwd|shadow|sudoers)\b/i, // `tee /etc/passwd`, `tee -a /etc/sudoers`.

	// Remote-fetch-then-execute (curl/wget piped to a shell or process-subbed).
	/\b(?:curl|wget|fetch)\b[^|]*\|\s*(?:bash|sh|zsh|fish)\b/i,
	// Process-sub variants — `bash <(curl …)`, `source <(curl …)`, `. <(curl …)`. `.` and `source` are
	// anchored to a command boundary so `find . -name` and similar don't false-positive.
	/(?:^|[\s;&|(])(?:bash|sh|zsh|source|\.)\s+<\(\s*(?:curl|wget|fetch)\b/i,
	// `eval "$(curl …)"` / `eval $(curl …)` / `eval \`curl …\``.
	/\beval\s+["'`]?\$\(\s*(?:curl|wget|fetch)\b|\beval\s+`\s*(?:curl|wget|fetch)\b/i,

	// Process/host control.
	/\bkill\s+-9\s+1\b/, // kill PID 1.
	// Process/host control — must sit at command position so `npm run reboot-tests`
	// or `echo 'shutdown the queue'` don't false-positive.
	/(?:^|[\s;&|(])(?:shutdown|poweroff|reboot|halt)(?:\s|$|[;|&])/i,
	/(?:^|[\s;&|(])init\s+0\b/i,

	// Network-shell exfil.
	/\bnc\b[^|;]*\s-[a-zA-Z]*[ec][a-zA-Z]*\s/i, // `nc -e` / `nc -c`.
] as const;

type BashPatternApproval = "allow" | "deny" | "prompt";

interface BashApprovalPatternRule {
	match: string;
	approval: BashPatternApproval;
}

function normalizeBashApprovalPattern(value: string): string {
	return value.trim().replace(/\s+/gu, " ");
}

function bashApprovalPatternToRegExp(pattern: string): RegExp {
	const escaped = normalizeBashApprovalPattern(pattern)
		.split("*")
		.map(part => part.replace(/[\\^$+?.()|[\]{}]/gu, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "u");
}

function normalizeBashPatternApproval(value: unknown): BashPatternApproval | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return BASH_PATTERN_APPROVAL_VALUES.has(normalized) ? (normalized as BashPatternApproval) : undefined;
}

function getBashApprovalPatternRules(value: unknown): BashApprovalPatternRule[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(item => {
			if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
			const record = item as Record<string, unknown>;
			if (typeof record.match !== "string") return undefined;
			const match = normalizeBashApprovalPattern(record.match);
			const approval = normalizeBashPatternApproval(record.approval);
			return match.length > 0 && approval ? { match, approval } : undefined;
		})
		.filter((rule): rule is BashApprovalPatternRule => !!rule);
}

function commandMatchesBashApprovalPattern(command: string, pattern: string): boolean {
	const normalizedCommand = normalizeBashApprovalPattern(command);
	if (normalizedCommand.length === 0) return false;
	return bashApprovalPatternToRegExp(pattern).test(normalizedCommand);
}

// `deny`/`prompt` rules are matched per segment so a dangerous command buried in
// a compound line (`cd x && rm -rf /`, `sleep 1 & rm -rf /`) is still caught.
// Reuse the shared shell tokenizer so segmentation stays in one place and honors
// every command boundary (`;`, `&&`, `||`, `|`, `&`, subshells, newlines).
function bashCommandSegments(command: string): string[] {
	return tokenizeShellSegments(command)
		.map(segment => segment.join(" "))
		.filter(segment => segment.length > 0);
}

// `deny`/`prompt` matching: the rule fires when its glob matches the whole
// command or any single segment of a compound command.
function commandSegmentMatchesBashApprovalPattern(command: string, pattern: string): boolean {
	const regex = bashApprovalPatternToRegExp(pattern);
	const normalizedCommand = normalizeBashApprovalPattern(command);
	if (normalizedCommand.length === 0) return false;
	if (regex.test(normalizedCommand)) return true;
	return bashCommandSegments(command).some(segment => regex.test(segment));
}

// A rule "applies" to a command under approval-specific semantics: `allow` must
// vouch for the ENTIRE command and never rides a compound line (shell control
// syntax could smuggle an unsafe segment past a narrow allow), while `deny` and
// `prompt` fire on any matching segment so they mean what they appear to.
function bashApprovalRuleMatches(command: string, rule: BashApprovalPatternRule): boolean {
	if (rule.approval === "allow") {
		if (hasBashApprovalShellControl(command)) return false;
		return commandMatchesBashApprovalPattern(command, rule.match);
	}
	return commandSegmentMatchesBashApprovalPattern(command, rule.match);
}

function findBashApprovalPatternRule(
	command: string,
	rules: readonly BashApprovalPatternRule[],
): BashApprovalPatternRule | undefined {
	return rules.find(rule => bashApprovalRuleMatches(command, rule));
}

async function saveBashOriginalArtifact(session: ToolSession, originalText: string): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.("bash-original");
		if (!alloc?.path || !alloc.id) {
			alloc?.release?.();
			return undefined;
		}
		try {
			await Bun.write(alloc.path, originalText);
			return alloc.id;
		} finally {
			alloc.release?.();
		}
	} catch {
		return undefined;
	}
}

const BASH_TIMEOUT_DESCRIPTION = `timeout in seconds; 0 disables the command deadline; nonzero values are clamped to ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}`;

const bashSchemaBase = type({
	command: type("string").describe("command to execute"),
	"env?": type({ "[string]": "string" }).describe("extra env vars"),
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": type("string").describe("working directory"),
	"pty?": type("boolean").describe("run in pty mode"),
});

const bashSchemaWithAsync = type({
	command: "string",
	"env?": { "[string]": "string" },
	"timeout?": type("number").describe(BASH_TIMEOUT_DESCRIPTION),
	"cwd?": "string",
	"pty?": "boolean",
	"async?": type("boolean").describe("run in background"),
});

type BashToolSchema = typeof bashSchemaBase | typeof bashSchemaWithAsync;

export interface BashToolInput {
	command: string;
	env?: Record<string, string>;
	timeout?: number;
	cwd?: string;

	async?: boolean;
	pty?: boolean;
}

export interface BashToolDetails {
	meta?: OutputMeta;
	timeoutSeconds?: number;
	requestedTimeoutSeconds?: number;
	timeoutDisabled?: boolean;
	wallTimeMs?: number;
	/** Exit code of a command that ran to completion but failed (non-zero). */
	exitCode?: number;
	/** True when the command was killed by its timeout deadline (not a failure). */
	timedOut?: boolean;
	terminalId?: string;
	async?: {
		state: "running" | "completed" | "failed";
		jobId: string;
		type: "bash";
	};
}

export interface BashToolOptions {}

type ManagedBashJobCompletion =
	| {
			kind: "completed";
			result: AgentToolResult<BashToolDetails>;
	  }
	| {
			kind: "failed";
			error: unknown;
	  };

interface ManagedBashJobHandle {
	jobId: string;
	completion: Promise<ManagedBashJobCompletion>;
	getLatestText: () => string;
	stopUpdates: () => void;
}

function normalizeResultOutput(result: BashResult | BashInteractiveResult): string {
	return result.output || "";
}

function normalizeBashEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!env || Object.keys(env).length === 0) return undefined;
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!BASH_ENV_NAME_PATTERN.test(key)) {
			throw new ToolError(`Invalid bash env name: ${key}`);
		}
		normalized[key] = value;
	}
	return normalized;
}

function escapeBashEnvValueForDisplay(value: unknown): string {
	return String(value)
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t")
		.replaceAll('"', '\\"')
		.replaceAll("$", "\\$")
		.replaceAll("`", "\\`");
}

function formatBashEnvAssignments(env: Record<string, unknown> | undefined): string {
	if (!env || Object.keys(env).length === 0) return "";
	return Object.entries(env)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}="${escapeBashEnvValueForDisplay(value)}"`)
		.join(" ");
}

function unescapePartialJsonString(value: string): string {
	let output = "";
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (char !== "\\") {
			output += char;
			continue;
		}
		const next = value[index + 1];
		if (!next) {
			output += "\\";
			break;
		}
		index += 1;
		switch (next) {
			case '"':
				output += '"';
				break;
			case "\\":
				output += "\\";
				break;
			case "/":
				output += "/";
				break;
			case "b":
				output += "\b";
				break;
			case "f":
				output += "\f";
				break;
			case "n":
				output += "\n";
				break;
			case "r":
				output += "\r";
				break;
			case "t":
				output += "\t";
				break;
			case "u": {
				const hex = value.slice(index + 1, index + 5);
				if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
					output += String.fromCharCode(Number.parseInt(hex, 16));
					index += 4;
				} else {
					output += "\\u";
				}
				break;
			}
			default:
				output += next;
		}
	}
	return output;
}

function extractPartialBashEnv(partialJson: string | undefined): Record<string, string> | undefined {
	if (!partialJson) return undefined;
	const envStart = partialJson.search(/"env"\s*:\s*\{/u);
	if (envStart === -1) return undefined;
	const objectStart = partialJson.indexOf("{", envStart);
	if (objectStart === -1) return undefined;
	const envBody = partialJson.slice(objectStart + 1);
	const env: Record<string, string> = {};
	const matcher = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:\\.|[^"\\])*)(?:"|$)/gu;
	for (const match of envBody.matchAll(matcher)) {
		env[match[1]!] = unescapePartialJsonString(match[2]!);
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

function formatTimeoutClampNotice(
	requestedTimeoutSec: number,
	effectiveTimeoutSec: number,
	maxTimeout: number,
): string | undefined {
	if (requestedTimeoutSec === effectiveTimeoutSec) return undefined;
	const cappedByGlobal = maxTimeout > 0 && effectiveTimeoutSec === maxTimeout && maxTimeout < TOOL_TIMEOUTS.bash.max;
	const limit = cappedByGlobal
		? `global tools.maxTimeout ceiling ${maxTimeout}s`
		: `allowed range ${TOOL_TIMEOUTS.bash.min}-${TOOL_TIMEOUTS.bash.max}s`;
	return `Timeout clamped to ${effectiveTimeoutSec}s (requested ${requestedTimeoutSec}s; ${limit}).`;
}

function formatWallTimeSeconds(wallTimeMs: number): string {
	return (wallTimeMs / 1000).toFixed(2);
}

function formatWallTimeNotice(wallTimeMs: number): string {
	return `Wall time: ${formatWallTimeSeconds(wallTimeMs)} seconds`;
}

function formatExitCodeNotice(exitCode: number): string {
	return `Command exited with code ${exitCode}`;
}

function formatBackgroundNotice(jobId: string): string {
	return `Backgrounded as job ${jobId}; result will be delivered automatically.`;
}

/**
 * Strip the trailing occurrence of `notice` (plus a single surrounding newline
 * on each side) so the TUI can echo the value via a styled footer label
 * instead of repeating it verbatim in the output pane. The notice is
 * reconstructed from the same value the result was tagged with, so a literal
 * sub-string match never strips a coincidental in-output token — only the
 * exact line we appended in #buildCompletedResult.
 */
function stripTrailingNotice(text: string, notice: string): string {
	const idx = text.lastIndexOf(notice);
	if (idx === -1) return text;
	let start = idx;
	let end = idx + notice.length;
	if (text[start - 1] === "\n") start -= 1;
	if (text[end] === "\n") end += 1;
	return (text.slice(0, start) + text.slice(end)).trimEnd();
}

function stripWallTimeNotice(text: string, wallTimeMs: number | undefined): string {
	if (wallTimeMs === undefined) return text;
	return stripTrailingNotice(text, formatWallTimeNotice(wallTimeMs));
}

function stripExitCodeNotice(text: string, exitCode: number | undefined): string {
	if (exitCode === undefined) return text;
	return stripTrailingNotice(text, formatExitCodeNotice(exitCode));
}

function stripBackgroundNotice(text: string, async: BashToolDetails["async"] | undefined): string {
	if (async?.state !== "running") return text;
	return stripTrailingNotice(text, formatBackgroundNotice(async.jobId));
}

type BridgeTerminalFailurePolicy = "best-effort" | "terminal";

interface BridgeTerminalCompletion {
	terminalId: string;
	exitStatus: ClientBridgeTerminalExitStatus;
	output: ClientBridgeTerminalOutput;
	wallTimeMs: number;
}
type BridgeTerminalRaceResult =
	| { kind: "exit"; status: ClientBridgeTerminalExitStatus }
	| { kind: "poll" }
	| { kind: "timeout" }
	| { kind: "aborted" };

interface BridgeTerminalLifecycleOptions<T> {
	createTerminal: (params: ClientBridgeCreateTerminalParams) => Promise<ClientBridgeTerminalHandle>;
	createParams: ClientBridgeCreateTerminalParams;
	timeoutMs: number | undefined;
	timeoutSec: number | undefined;
	signal?: AbortSignal;
	failurePolicy: BridgeTerminalFailurePolicy;
	readOutputAfterAbort?: boolean;
	onCreated?: (terminalId: string) => void;
	onOutput?: (terminalId: string, output: ClientBridgeTerminalOutput) => void;
	onCompleted: (completion: BridgeTerminalCompletion) => Promise<T>;
}

const BRIDGE_TERMINAL_KILL_GRACE_MS = 1_000;
const BRIDGE_TERMINAL_OUTPUT_GRACE_MS = 2_000;

function bridgeTerminalFailure(operation: string, error: unknown): ToolError {
	const message = error instanceof Error ? error.message : String(error);
	return new ToolError(`Execution environment terminal ${operation} failed: ${message}`);
}

async function runBridgeTerminal<T>(options: BridgeTerminalLifecycleOptions<T>): Promise<T> {
	if (options.signal?.aborted) {
		throw new ToolAbortError("Command aborted");
	}

	const wallTimeStart = performance.now();
	const { promise: timeoutPromise, resolve: resolveTimeout } = Promise.withResolvers<{ kind: "timeout" }>();
	const timeoutTimer = options.timeoutMs
		? setTimeout(() => resolveTimeout({ kind: "timeout" }), options.timeoutMs)
		: undefined;
	const { promise: abortedPromise, resolve: resolveAborted } = Promise.withResolvers<void>();
	let handle: ClientBridgeTerminalHandle | undefined;
	let killPromise: Promise<void> | undefined;
	let outcome: { kind: "completed"; value: T } | { kind: "failed"; error: unknown } | undefined;
	let terminalReleaseFailure: ToolError | undefined;

	const handleOperationError = (operation: string, error: unknown): never => {
		if (options.failurePolicy === "terminal") throw bridgeTerminalFailure(operation, error);
		throw error;
	};

	const fireKill = (): Promise<void> => {
		if (killPromise) return killPromise;
		const currentHandle = handle;
		if (!currentHandle) return Promise.resolve();
		killPromise = Promise.resolve()
			.then(() => currentHandle.kill())
			.catch((error: unknown) => {
				if (options.failurePolicy === "terminal") throw bridgeTerminalFailure("kill", error);
				logger.warn("ACP terminal kill failed", { terminalId: currentHandle.terminalId, error });
			});
		return killPromise;
	};

	const awaitKill = async (): Promise<void> => {
		const result = await Promise.race([
			fireKill().then(
				() => ({ kind: "completed" as const }),
				error => ({ kind: "failed" as const, error }),
			),
			Bun.sleep(BRIDGE_TERMINAL_KILL_GRACE_MS).then(() => ({ kind: "timed-out" as const })),
		]);
		if (result.kind === "failed") throw result.error;
		if (result.kind === "timed-out" && options.failurePolicy === "terminal") {
			throw bridgeTerminalFailure("kill", new Error("operation did not complete within 1 second"));
		}
	};

	const readFinalOutput = async (
		currentHandle: ClientBridgeTerminalHandle,
		fallback: ClientBridgeTerminalOutput,
	): Promise<ClientBridgeTerminalOutput> => {
		const result = await Promise.race([
			Promise.resolve()
				.then(() => currentHandle.currentOutput())
				.then(
					output => ({ kind: "output" as const, output }),
					error => ({ kind: "failed" as const, error }),
				),
			Bun.sleep(BRIDGE_TERMINAL_OUTPUT_GRACE_MS).then(() => ({ kind: "timed-out" as const })),
		]);
		if (result.kind === "output") return result.output;
		if (options.failurePolicy === "terminal") {
			const error =
				result.kind === "failed" ? result.error : new Error("operation did not complete within 2 seconds");
			throw bridgeTerminalFailure("output", error);
		}
		if (result.kind === "failed") {
			logger.warn("ACP terminal final output read failed", {
				terminalId: currentHandle.terminalId,
				error: result.error,
			});
		}
		return fallback;
	};

	const cleanupLateCreate = (createPromise: Promise<ClientBridgeTerminalHandle>): void => {
		const logPrefix = options.failurePolicy === "terminal" ? "Execution environment terminal" : "ACP terminal";
		void createPromise
			.then(async lateHandle => {
				try {
					await lateHandle.kill();
				} catch (error) {
					logger.warn(`${logPrefix} kill failed`, { terminalId: lateHandle.terminalId, error });
				}
				try {
					await lateHandle.release();
				} catch (error) {
					logger.warn(`${logPrefix} release failed`, { terminalId: lateHandle.terminalId, error });
				}
			})
			.catch((error: unknown) => {
				logger.warn(`${logPrefix} create failed after cancellation`, { error });
			});
	};

	const onAbort = () => {
		resolveAborted();
		// Start cancellation immediately. The loop awaits this same promise before
		// any final output read; observe the rejection here to avoid an unhandled
		// promise while preserving it for the ordered await.
		void fireKill().catch(() => {});
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const createPromise = (() => {
			try {
				return options.createTerminal(options.createParams);
			} catch (error) {
				return handleOperationError("create", error);
			}
		})();
		const createRaced = await Promise.race([
			createPromise.then(
				createdHandle => ({ kind: "created" as const, handle: createdHandle }),
				error => handleOperationError("create", error),
			),
			timeoutPromise,
			abortedPromise.then(() => ({ kind: "aborted" as const })),
		]);
		if (createRaced.kind === "aborted" || options.signal?.aborted) {
			cleanupLateCreate(createPromise);
			throw new ToolAbortError("Command aborted");
		}
		if (createRaced.kind === "timeout") {
			cleanupLateCreate(createPromise);
			const message =
				options.timeoutSec === undefined
					? "Command timed out"
					: `Command timed out after ${options.timeoutSec} seconds`;
			throw new ToolError(message);
		}

		handle = createRaced.handle;
		options.onCreated?.(handle.terminalId);

		const exitPromise = (() => {
			try {
				return handle.waitForExit();
			} catch (error) {
				return handleOperationError("wait for exit", error);
			}
		})();
		const exitRacer = exitPromise.then(
			status => ({ kind: "exit" as const, status }),
			error => handleOperationError("wait for exit", error),
		);
		const abortRacer = abortedPromise.then(() => ({ kind: "aborted" as const }));
		const abortPollRacer = abortedPromise.then(() => undefined as ClientBridgeTerminalOutput | undefined);
		const timeoutPollRacer = timeoutPromise.then(() => undefined as ClientBridgeTerminalOutput | undefined);
		let lastPolledOutput: ClientBridgeTerminalOutput = { output: "", truncated: false };
		let exitStatus!: ClientBridgeTerminalExitStatus;

		for (;;) {
			const racers: Array<Promise<BridgeTerminalRaceResult>> = [
				exitRacer,
				timeoutPromise,
				Bun.sleep(250).then(() => ({ kind: "poll" as const })),
			];
			if (options.signal) racers.push(abortRacer);
			const raced = await Promise.race(racers);

			if (raced.kind === "aborted" || options.signal?.aborted) {
				await awaitKill();
				if (options.readOutputAfterAbort) {
					const current = await readFinalOutput(handle, lastPolledOutput);
					throw new ToolAbortError(current.output ? `${current.output}\n\n[Command aborted]` : "Command aborted");
				}
				throw new ToolAbortError("Command aborted");
			}

			if (raced.kind === "timeout") {
				await awaitKill();
				const current = await readFinalOutput(handle, lastPolledOutput);
				const message =
					options.timeoutSec === undefined
						? "Command timed out"
						: `Command timed out after ${options.timeoutSec} seconds`;
				throw new ToolError(current.output ? `${current.output}\n\n[${message}]` : message);
			}

			if (raced.kind === "exit") {
				exitStatus = raced.status;
				break;
			}

			const pollPromise = (() => {
				try {
					return handle.currentOutput();
				} catch (error) {
					return handleOperationError("output polling", error);
				}
			})();
			const pollOutput = await Promise.race([
				pollPromise.catch(error => handleOperationError("output polling", error)),
				abortPollRacer,
				timeoutPollRacer,
			]);
			if (pollOutput === undefined) continue;
			lastPolledOutput = pollOutput;
			options.onOutput?.(handle.terminalId, pollOutput);
		}

		const finalOutput = await readFinalOutput(handle, lastPolledOutput);
		outcome = {
			kind: "completed",
			value: await options.onCompleted({
				terminalId: handle.terminalId,
				exitStatus,
				output: finalOutput,
				wallTimeMs: performance.now() - wallTimeStart,
			}),
		};
	} catch (error) {
		outcome = { kind: "failed", error };
	} finally {
		clearTimeout(timeoutTimer);
		options.signal?.removeEventListener("abort", onAbort);
		if (handle) {
			const releaseHandle = handle;
			const releaseResult = await Promise.race([
				Promise.resolve()
					.then(() => releaseHandle.release())
					.then(
						() => ({ kind: "completed" as const }),
						error => ({ kind: "failed" as const, error }),
					),
				Bun.sleep(BRIDGE_TERMINAL_KILL_GRACE_MS).then(() => ({ kind: "timed-out" as const })),
			]);
			if (releaseResult.kind !== "completed") {
				const error =
					releaseResult.kind === "failed"
						? releaseResult.error
						: new Error("operation did not complete within 1 second");
				if (options.failurePolicy === "terminal") {
					terminalReleaseFailure = bridgeTerminalFailure("release", error);
				}
				if (releaseResult.kind === "failed") {
					logger.warn("ACP terminal release failed", { terminalId: releaseHandle.terminalId, error });
				}
			}
		}
	}
	if (!outcome) throw new ToolError("Bridge terminal did not produce a result.");
	if (terminalReleaseFailure) {
		if (outcome.kind === "completed") throw terminalReleaseFailure;
		const primaryMessage = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
		throw new ToolError(`${primaryMessage}\n\n${terminalReleaseFailure.message}`);
	}
	if (outcome.kind === "failed") throw outcome.error;
	return outcome.value;
}

const EXECUTION_ENVIRONMENT_INTERNAL_REFERENCE_RE =
	/(?:agent|artifact|history|issue|local|mcp|memory|omp|plan|pr|rule|security|skill|ssh|vault|xd):\/{1,2}/iu;

function assertNoExecutionEnvironmentInternalReference(value: string | undefined, field: string): void {
	if (value && EXECUTION_ENVIRONMENT_INTERNAL_REFERENCE_RE.test(value)) {
		throw new ToolError(`Execution environment bash does not accept internal protocol references in ${field}.`);
	}
}

function assertNoExecutionEnvironmentSourceRoot(
	value: string | undefined,
	field: string,
	environment: ExecutionEnvironmentBinding,
): void {
	if (value?.includes(environment.sourceRoot)) {
		throw new ToolError(`Execution environment bash does not accept the local sourceRoot in ${field}.`);
	}
}

function bridgeCompletionToBashResult(completion: BridgeTerminalCompletion): BashResult {
	const rawExitCode = completion.exitStatus.exitCode;
	const exitCode: number | undefined =
		rawExitCode != null ? rawExitCode : completion.exitStatus.signal ? 137 : undefined;
	const outputText = completion.output.output;
	const outputByteLength = outputText.length;
	const outputLineCount = outputText.length > 0 ? outputText.split("\n").length : 0;
	return {
		output: outputText,
		exitCode,
		cancelled: false,
		truncated: completion.output.truncated,
		totalLines: outputLineCount,
		totalBytes: outputByteLength,
		outputLines: outputLineCount,
		outputBytes: outputByteLength,
	};
}

/**
 * Bash tool implementation.
 *
 * Executes bash commands with optional timeout and working directory.
 */
export class BashTool implements AgentTool<typeof bashSchemaBase | typeof bashSchemaWithAsync, BashToolDetails> {
	readonly name = "bash";
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const rawCommand = (args as Partial<BashToolInput>).command;
		const command = typeof rawCommand === "string" ? rawCommand : "";
		const patternRules = getBashApprovalPatternRules(this.session.settings.get("bash.patterns"));
		const patternRule = findBashApprovalPatternRule(command, patternRules);
		if (patternRule?.approval === "deny") {
			return {
				tier: "exec",
				override: true,
				policy: "deny",
				reason: `Blocked by bash pattern: ${patternRule.match}`,
			};
		}
		if (command !== "" && CRITICAL_BASH_PATTERNS.some(pattern => pattern.test(command))) {
			return { tier: "exec", override: true, reason: "Critical pattern detected" };
		}
		if (patternRule?.approval === "allow") return { tier: "write", policy: "allow" };
		if (patternRule?.approval === "prompt") {
			return {
				tier: "exec",
				override: true,
				policy: "prompt",
				reason: `Prompt required by bash pattern: ${patternRule.match}`,
			};
		}
		return "exec";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const rawCommand = (args as Partial<BashToolInput>).command;
		const command = typeof rawCommand === "string" ? rawCommand : "(missing)";
		return [`Command: ${truncateForPrompt(command)}`];
	};
	readonly label = "Bash";
	readonly loadMode = "essential";
	get description(): string {
		const evalBackends = resolveEvalBackends(this.session);
		const isToolActive = (name: string, fallback: boolean): boolean => this.session.isToolActive?.(name) ?? fallback;
		return prompt.render(bashDescription, {
			asyncEnabled: this.#asyncEnabled,
			autoBackgroundEnabled: this.#autoBackgroundEnabled,
			autoBackgroundThresholdSeconds: Math.max(0, Math.floor(this.#autoBackgroundThresholdMs / 1000)),
			hasAstGrep: isToolActive("ast_grep", this.session.settings.get("astGrep.enabled")),
			hasAstEdit: isToolActive("ast_edit", this.session.settings.get("astEdit.enabled")),
			hasGrep: isToolActive("grep", this.session.settings.get("grep.enabled")),
			hasGlob: isToolActive("glob", this.session.settings.get("glob.enabled")),
			hasRead: isToolActive("read", true),
			hasLaunch: isToolActive("hub", this.session.settings.get("launch.enabled")),
			hasEval: isToolActive(
				"eval",
				evalBackends.python || evalBackends.js || evalBackends.ruby || evalBackends.julia,
			),
			hasShellBuiltins: !shellBuiltinsDisabled(this.session.settings),
			isWindows: process.platform === "win32",
		});
	}
	readonly parameters: BashToolSchema;
	// Non-pty calls run alongside each other (the executor isolates overlapping
	// runs on the same shell session); pty takes over the terminal UI and must
	// run alone.
	readonly concurrency = (args: Partial<BashToolInput>): "shared" | "exclusive" =>
		args.pty === true ? "exclusive" : "shared";
	readonly strict = true;
	readonly #asyncEnabled: boolean;
	readonly #autoBackgroundEnabled: boolean;
	readonly #autoBackgroundThresholdMs: number;

	constructor(private readonly session: ToolSession) {
		this.#asyncEnabled = this.session.settings.get("async.enabled");
		this.#autoBackgroundEnabled = this.session.settings.get("bash.autoBackground.enabled");
		this.#autoBackgroundThresholdMs = Math.max(
			0,
			Math.floor(
				this.session.settings.get("bash.autoBackground.thresholdMs") ?? DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
			),
		);
		this.parameters = this.#asyncEnabled ? bashSchemaWithAsync : bashSchemaBase;
	}

	#formatResultOutput(result: BashResult | BashInteractiveResult): string {
		const outputText = normalizeResultOutput(result);
		return outputText || "(no output)";
	}

	/**
	 * Throw for outcomes that are *not* a completed command: user aborts and a
	 * missing exit status. Timeouts are handled separately by
	 * #buildCompletedResult, which returns a non-throwing error result with
	 * details.timedOut=true so the renderer can show a warning border. The
	 * foreground and bridge callers plus the async job manager rely on these
	 * throwing so cancellations surface as aborts and jobs are recorded as
	 * failed. A definite non-zero exit is a completed command that failed;
	 * #buildCompletedResult surfaces it as an error *result* (carrying
	 * execution details) rather than a throw.
	 */
	#throwIfUnfinished(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		outputText: string,
	): void {
		if (result.cancelled) {
			// Local executor output already carries a leading `[Command cancelled]`
			// notice from the sink; PTY/bridge output does not, so annotate only
			// the latter.
			const out = normalizeResultOutput(result);
			const annotated = out.startsWith("[Command cancelled]") ? out : out ? `${out}\n\n[Command aborted]` : out;
			throw new ToolError(annotated || "Command aborted");
		}
		if (result.timedOut === true) {
			const out = normalizeResultOutput(result);
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			throw new ToolError(out ? `${out}\n\n[${message}]` : message);
		}
		if (result.exitCode === undefined) {
			throw new ToolError(`${outputText}\n\nCommand failed: missing exit status`);
		}
	}

	async #buildCompletedResult(
		result: BashResult | BashInteractiveResult,
		timeoutSec: number | undefined,
		options: {
			requestedTimeoutSec?: number;
			notices?: readonly string[];
			terminalId?: string;
			wallTimeMs?: number;
		} = {},
	): Promise<AgentToolResult<BashToolDetails>> {
		const exitCode = result.exitCode;
		const failedExit = exitCode !== undefined && exitCode !== 0;

		const outputLines = [this.#formatResultOutput(result)];
		const notices: string[] = [];
		if (options.wallTimeMs !== undefined) {
			notices.push(formatWallTimeNotice(options.wallTimeMs));
		}
		if (options.notices) {
			for (const notice of options.notices) {
				if (notice) notices.push(notice);
			}
		}
		if (notices.length > 0) outputLines.push("", ...notices);
		if (failedExit) outputLines.push("", formatExitCodeNotice(exitCode));
		const outputText = outputLines.join("\n");

		// Timeouts are not failures — the command ran its course. Return an error
		// result (isError=true for the model) but flag timedOut so the renderer
		// uses a warning border instead of error red. Both interactive and
		// non-interactive results carry an explicit `timedOut` field from the
		// executor/PTY layer.
		const isTimeout = result.timedOut === true;

		const details: BashToolDetails = {};
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		if (options.terminalId !== undefined) {
			details.terminalId = options.terminalId;
		}
		if (options.wallTimeMs !== undefined) {
			details.wallTimeMs = options.wallTimeMs;
		}
		if (failedExit) {
			details.exitCode = exitCode;
		}

		// Final-defense inline cap config, shared by the timeout and normal
		// completion paths. The sink already bounds inline bodies to the spill
		// threshold, so with the notice slack this only fires on paths that
		// bypass the sink (client-bridge terminals, minimizer misses). When the
		// sink spilled, its artifact already holds the full raw stream — reuse
		// that id instead of saving a second (already-truncated) copy, so the
		// `[raw output: artifact://N]` footer and the truncation notice agree.
		const inlineCap = {
			maxBytes: resolveInlineByteCapBudget(this.session.settings),
			saveArtifact: (full: string) => result.artifactId ?? saveBashOriginalArtifact(this.session, full),
		};

		if (isTimeout) {
			details.timedOut = true;
			const message =
				timeoutSec === undefined ? "Command timed out" : `Command timed out after ${timeoutSec} seconds`;
			// executeBash has already emitted this leading sink notice. PTY output
			// has not, so provide the LLM-facing annotation exactly once.
			if (!normalizeResultOutput(result).startsWith(`[${message}]\n`)) {
				outputLines.push("", `[${message}]`);
			}
			const timeoutOutputText = await enforceInlineByteCap(outputLines.join("\n"), inlineCap);
			return toolResult(details)
				.text(timeoutOutputText)
				.truncationFromSummary(result, { direction: "tail" })
				.error()
				.done();
		}

		// Non-timeout cancellations and missing exit status still propagate as thrown errors.
		this.#throwIfUnfinished(result, timeoutSec, outputText);

		// No-op for already-bounded output; see `inlineCap` above.
		const cappedOutputText = await enforceInlineByteCap(outputText, inlineCap);

		const resultBuilder = toolResult(details)
			.text(cappedOutputText)
			.truncationFromSummary(result, { direction: "tail" });
		if (failedExit) resultBuilder.error();
		return resultBuilder.done();
	}

	#buildBackgroundStartResult(
		jobId: string,
		previewText: string,
		timeoutSec: number | undefined,
		options: { requestedTimeoutSec?: number; notices?: readonly string[] } = {},
	): AgentToolResult<BashToolDetails> {
		const details: BashToolDetails = {
			async: { state: "running", jobId, type: "bash" },
		};
		if (timeoutSec === undefined) {
			details.timeoutDisabled = true;
		} else {
			details.timeoutSeconds = timeoutSec;
		}
		if (options.requestedTimeoutSec !== undefined && options.requestedTimeoutSec !== timeoutSec) {
			details.requestedTimeoutSeconds = options.requestedTimeoutSec;
		}
		const lines: string[] = [];
		const trimmedPreview = previewText.trimEnd();
		if (trimmedPreview.length > 0) {
			lines.push(trimmedPreview, "");
		}
		if (options.notices?.length) {
			lines.push(...options.notices, "");
		}
		lines.push(formatBackgroundNotice(jobId));
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details,
		};
	}

	#extractTextResult(result: AgentToolResult<BashToolDetails>): string {
		return result.content.find(block => block.type === "text")?.text ?? "";
	}

	#startManagedBashJob(options: {
		command: string;
		commandCwd: string;
		timeoutMs: number | undefined;
		timeoutSec: number | undefined;
		requestedTimeoutSec?: number;
		notices?: readonly string[];

		resolvedEnv?: Record<string, string>;
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>;
		forwardUpdates: boolean;
	}): ManagedBashJobHandle {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			throw new ToolError("Background job manager unavailable for this session.");
		}

		const label = options.command.length > 120 ? `${options.command.slice(0, 117)}...` : options.command;
		let latestText = "";
		let forwardUpdates = options.forwardUpdates;
		const completion = Promise.withResolvers<ManagedBashJobCompletion>();

		const jobId = manager.register(
			"bash",
			label,
			async ({ jobId, signal: runSignal, reportProgress }) => {
				const artifact = (await this.session.allocateOutputArtifact?.("bash")) ?? {};
				const { path: artifactPath, id: artifactId } = artifact;
				try {
					const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
					const wallTimeStart = performance.now();
					const result = await executeBash(options.command, {
						cwd: options.commandCwd,
						sessionKey: `${this.session.getSessionId?.() ?? ""}:async:${jobId}`,
						timeout: options.timeoutMs ?? 0,
						signal: runSignal,
						env: options.resolvedEnv,
						artifactPath,
						artifactId,
						onChunk: chunk => {
							tailBuffer.append(chunk);
							latestText = tailBuffer.text();
							void reportProgress(latestText, { async: { state: "running", jobId, type: "bash" } });
						},
						onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
					});
					const wallTimeMs = performance.now() - wallTimeStart;
					const finalResult = await this.#buildCompletedResult(result, options.timeoutSec, {
						requestedTimeoutSec: options.requestedTimeoutSec,
						notices: options.notices ?? [],
						wallTimeMs,
					});
					const finalText = this.#extractTextResult(finalResult);
					latestText = finalText;
					// Hand the detailed result to the foreground auto-background
					// waiter (which renders it, footer included) before deciding
					// the job's terminal state.
					completion.resolve({ kind: "completed", result: finalResult });
					if (finalResult.isError === true) {
						// A non-zero exit is a completed command that failed. Re-enter
						// the failure path so the job manager records it as failed and
						// delivers the error text, matching prior throw-based behavior.
						throw new ToolError(finalText);
					}
					await reportProgress(finalText, { async: { state: "completed", jobId, type: "bash" } });
					return finalText;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					latestText = message;
					completion.resolve({ kind: "failed", error });
					await reportProgress(message, { async: { state: "failed", jobId, type: "bash" } });
					throw error;
				} finally {
					artifact.release?.();
				}
			},
			{
				ownerId: this.session.getAgentId?.() ?? undefined,
				originTurnId: this.session.getCurrentTurnId?.(),
				onProgress: async text => {
					latestText = text;
					if (!forwardUpdates) return;
					await options.onUpdate?.({
						content: [{ type: "text", text }],
						details: {},
					});
				},
			},
		);

		return {
			jobId,
			completion: completion.promise,
			getLatestText: () => latestText,
			stopUpdates: () => {
				forwardUpdates = false;
			},
		};
	}

	async #waitForManagedBashJob(
		job: ManagedBashJobHandle,
		thresholdMs: number,
		signal?: AbortSignal,
		steeringSignal?: AbortSignal,
	): Promise<ManagedBashJobCompletion | { kind: "running" } | { kind: "steer" } | { kind: "aborted" }> {
		if (signal?.aborted) {
			return { kind: "aborted" };
		}
		if (steeringSignal?.aborted) {
			return { kind: "steer" };
		}

		// Cancellable threshold: a bare Bun.sleep(thresholdMs) leaves a live, ref'd
		// timer for the full threshold after the command finishes (or abort/steer)
		// wins the race first — delaying SDK/headless shutdown and accumulating
		// timers under fast command rates. Settle a withResolvers promise from
		// setTimeout so the finally can clear it regardless of which waiter wins.
		const { promise: thresholdPromise, resolve: resolveThreshold } = Promise.withResolvers<{
			kind: "running";
		}>();
		const thresholdTimer = setTimeout(() => resolveThreshold({ kind: "running" }), thresholdMs);
		const waiters: Array<
			Promise<ManagedBashJobCompletion | { kind: "running" } | { kind: "steer" } | { kind: "aborted" }>
		> = [job.completion, thresholdPromise];

		const { promise: abortedPromise, resolve: resolveAborted } = Promise.withResolvers<{ kind: "aborted" }>();
		const onAbort = () => resolveAborted({ kind: "aborted" });
		const { promise: steerPromise, resolve: resolveSteer } = Promise.withResolvers<{ kind: "steer" }>();
		const onSteer = () => resolveSteer({ kind: "steer" });
		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			waiters.push(abortedPromise);
		}
		if (steeringSignal) {
			steeringSignal.addEventListener("abort", onSteer, { once: true });
			waiters.push(steerPromise);
		}
		try {
			return await Promise.race(waiters);
		} finally {
			clearTimeout(thresholdTimer);
			signal?.removeEventListener("abort", onAbort);
			steeringSignal?.removeEventListener("abort", onSteer);
		}
	}

	#resolveAutoBackgroundWaitMs(timeoutMs: number | undefined): number {
		if (this.#autoBackgroundThresholdMs <= 0) return 0;
		if (timeoutMs === undefined) return this.#autoBackgroundThresholdMs;
		const timeoutBufferMs = 1_000;
		return Math.max(0, Math.min(this.#autoBackgroundThresholdMs, timeoutMs - timeoutBufferMs));
	}

	async #executeInEnvironment(options: {
		environment: ExecutionEnvironmentBinding;
		rawCommand: string;
		rawEnv: Record<string, string> | undefined;
		rawCwd: string | undefined;
		rawTimeout: number;
		asyncRequested: boolean;
		pty: boolean;
		signal?: AbortSignal;
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>;
	}): Promise<AgentToolResult<BashToolDetails>> {
		const { environment, rawCommand, rawEnv, rawCwd, rawTimeout, asyncRequested, pty, signal, onUpdate } = options;
		if (asyncRequested) {
			throw new ToolError("Execution environment bash supports only foreground execution.");
		}
		if (pty) {
			throw new ToolError("Execution environment bash does not support PTY execution.");
		}
		if (!Number.isFinite(rawTimeout) || rawTimeout < 1 || rawTimeout > 120) {
			throw new ToolError("Execution environment bash requires a timeout between 1 and 120 seconds.");
		}

		assertNoExecutionEnvironmentInternalReference(rawCommand, "command");
		assertNoExecutionEnvironmentInternalReference(rawCwd, "cwd");
		assertNoExecutionEnvironmentSourceRoot(rawCommand, "command", environment);
		for (const value of Object.values(rawEnv ?? {})) {
			assertNoExecutionEnvironmentInternalReference(value, "env");
			assertNoExecutionEnvironmentSourceRoot(value, "env", environment);
		}
		if (rawEnv && Object.keys(rawEnv).length > 0) {
			throw new ToolError("Execution environment bash does not accept model-supplied environment variables.");
		}

		let remoteCwd: string;
		try {
			remoteCwd = mapExecutionEnvironmentPath(environment, rawCwd ?? ".");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new ToolError(`Invalid execution environment bash cwd: ${message}`);
		}

		return runBridgeTerminal({
			createTerminal: params => environment.bridge.createTerminal(params),
			createParams: {
				command: "/bin/bash",
				args: ["--noprofile", "--norc", "-c", rawCommand],
				cwd: remoteCwd,
				env: undefined,
				timeoutMs: rawTimeout * 1_000,
				outputByteLimit: DEFAULT_MAX_BYTES,
			},
			timeoutMs: rawTimeout * 1_000,
			timeoutSec: rawTimeout,
			signal,
			failurePolicy: "terminal",
			readOutputAfterAbort: true,
			onOutput: (_terminalId, output) => {
				onUpdate?.({ content: [{ type: "text", text: output.output }], details: {} });
			},
			onCompleted: async completion => {
				const result = bridgeCompletionToBashResult(completion);
				const notices = completion.output.truncated ? ["(output truncated)"] : [];
				return this.#buildCompletedResult(result, rawTimeout, {
					requestedTimeoutSec: rawTimeout,
					notices,
					wallTimeMs: completion.wallTimeMs,
				});
			},
		});
	}

	async execute(
		_toolCallId: string,
		{
			command: rawCommand,
			env: rawEnv,
			timeout: rawTimeout = 300,
			cwd,

			async: asyncRequested = false,
			pty = false,
		}: BashToolInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<BashToolDetails>> {
		const rawCwd = cwd;
		const executionEnvironment = this.session.getExecutionEnvironment?.();
		let command = rawCommand;
		const env = normalizeBashEnv(rawEnv);

		// Extract a leading `cd <path> && ...` into cwd when the model ignores the
		// cwd parameter. The scanner captures only a single path token and defers
		// to the shell for anything else (redirects, extra args, shell expansion),
		// so it never absorbs shell syntax like `cd /tmp 2>/dev/null && ...` into
		// the structured cwd. Constrained to a top-level `&&` on the first line.
		if (!cwd) {
			const cd = extractLeadingCdTarget(command);
			if (cd) {
				cwd = cd.path;
				command = cd.rest;
			}
		}
		if (asyncRequested && !this.#asyncEnabled && !executionEnvironment) {
			throw new ToolError("Async bash execution is disabled. Enable async.enabled to use async mode.");
		}

		// Check both the original command and the cwd-normalized command so
		// leading `cd ... &&` wrappers do not hide either shell-navigation rules
		// or the dedicated-tool command that follows the directory change.
		if (this.session.settings.get("bashInterceptor.enabled")) {
			const rules = this.session.settings.getBashInterceptorRules();
			const commandsToCheck = rawCommand === command ? [command] : [rawCommand, command];
			for (const commandToCheck of commandsToCheck) {
				const interception = checkBashInterception(commandToCheck, ctx?.toolNames ?? [], rules, rawCommand);
				if (interception.block) {
					throw new ToolError(interception.message ?? "Command blocked");
				}
			}
		}

		// This sits inside the tool, rather than the approval wrapper, so yolo
		// and every execution backend retain the same session authority boundary.
		assertBashCapabilities(this.session, rawCommand, this.session.cwd, env);

		if (executionEnvironment) {
			return this.#executeInEnvironment({
				environment: executionEnvironment,
				rawCommand,
				rawEnv,
				rawCwd,
				rawTimeout,
				asyncRequested,
				pty,
				signal,
				onUpdate,
			});
		}

		const internalUrlOptions: InternalUrlExpansionOptions = {
			skills: this.session.skills ?? [],
			internalRouter: InternalUrlRouter.instance(),
			cwd: this.session.cwd,
			localOptions: {
				getArtifactsDir: this.session.getArtifactsDir,
				getSessionId: this.session.getSessionId,
			},
		};
		command = await expandInternalUrls(command, { ...internalUrlOptions, ensureLocalParentDirs: true });
		const resolvedEnv = env
			? Object.fromEntries(
					await Promise.all(
						Object.entries(env).map(async ([key, value]) => [
							key,
							await expandInternalUrls(value, {
								...internalUrlOptions,
								ensureLocalParentDirs: true,
								noEscape: true,
							}),
						]),
					),
				)
			: undefined;

		// Resolve protocol URLs (skill://, agent://, etc.) in extracted cwd.
		if (cwd?.includes("://") || cwd?.includes("local:/")) {
			cwd = await expandInternalUrls(cwd, { ...internalUrlOptions, noEscape: true });
		}

		// Best-effort cache invalidation: drop github-cache rows for any issue/PR
		// number touched by a mutating `gh` subcommand inside this bash call so
		// subsequent issue:// / pr:// reads pick up the post-mutation state
		// instead of the cached pre-mutation snapshot.
		invalidateGithubCacheForBashCommand(command);

		const commandCwd = cwd ? resolveToCwd(cwd, this.session.cwd) : this.session.cwd;
		// Internal URL expansion can replace a literal path, so validate the
		// command that the local, PTY, and ACP backends will actually receive.
		assertBashCapabilities(this.session, command, commandCwd, resolvedEnv);
		let cwdStat: fs.Stats;
		try {
			cwdStat = await fs.promises.stat(commandCwd);
		} catch (err) {
			if (isEnoent(err)) {
				throw new ToolError(`Working directory does not exist: ${commandCwd}`);
			}
			throw err;
		}
		if (!cwdStat.isDirectory()) {
			throw new ToolError(`Working directory is not a directory: ${commandCwd}`);
		}

		// A timeout of 0 is an explicit long-running-command contract: the user
		// must still cancel the call or job, but OMP does not impose a deadline.
		const requestedTimeoutSec = rawTimeout;
		const timeoutDisabled = requestedTimeoutSec === 0;
		const maxTimeout = this.session.settings.get("tools.maxTimeout");
		const timeoutSec = timeoutDisabled ? undefined : clampTimeout("bash", requestedTimeoutSec, maxTimeout);
		const timeoutMs = timeoutSec === undefined ? undefined : timeoutSec * 1000;
		const pendingNotices: string[] = [];
		if (timeoutSec !== undefined) {
			const timeoutClampNotice = formatTimeoutClampNotice(requestedTimeoutSec, timeoutSec, maxTimeout);
			if (timeoutClampNotice) pendingNotices.push(timeoutClampNotice);
		}

		if (asyncRequested) {
			if (!this.session.asyncJobManager) {
				throw new ToolError("Async job manager unavailable for this session.");
			}
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,

				resolvedEnv,
				onUpdate,
				forwardUpdates: false,
			});
			return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
				requestedTimeoutSec,
				notices: pendingNotices,
			});
		}

		// The client-bridge terminal provides a live terminal card in the editor;
		// when available it wins over auto-backgrounding (both are opt-in, and
		// auto-background would otherwise silently disable the terminal route).
		const clientBridge = this.session.getClientBridge?.();
		const bridgeTerminalAvailable = Boolean(
			clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty,
		);

		const autoBgManager = this.session.asyncJobManager;
		// At the running-job cap, fall through to direct foreground execution
		// instead of failing every bash call until a slot frees up.
		if (
			this.#autoBackgroundEnabled &&
			!pty &&
			!bridgeTerminalAvailable &&
			autoBgManager &&
			!autoBgManager.atCapacity
		) {
			const autoBackgroundWaitMs = this.#resolveAutoBackgroundWaitMs(timeoutMs);
			const startBackgrounded = autoBackgroundWaitMs === 0;
			const job = this.#startManagedBashJob({
				command,
				commandCwd,
				timeoutMs,
				timeoutSec,
				requestedTimeoutSec,
				notices: pendingNotices,

				resolvedEnv,
				onUpdate,
				forwardUpdates: !startBackgrounded,
			});
			if (startBackgrounded) {
				return this.#buildBackgroundStartResult(job.jobId, "", timeoutSec, {
					requestedTimeoutSec,
					notices: pendingNotices,
				});
			}
			// Suppress the completion delivery up front so a job finishing while we
			// foreground-wait cannot also be injected by the delivery loop. Lifted
			// via resumeDeliveries() if we end up backgrounding after all.
			autoBgManager.acknowledgeDeliveries([job.jobId]);
			const waitResult = await this.#waitForManagedBashJob(
				job,
				autoBackgroundWaitMs,
				signal,
				ctx?.toolCall?.steeringSignal,
			);
			if (waitResult.kind === "completed") {
				return waitResult.result;
			}
			if (waitResult.kind === "failed") {
				throw waitResult.error;
			}
			if (waitResult.kind === "aborted") {
				autoBgManager.cancel(job.jobId);
				throw new ToolAbortError(job.getLatestText() || "Command aborted");
			}
			job.stopUpdates();
			autoBgManager.resumeDeliveries([job.jobId]);
			// "steer": a queued user/peer message arrived mid-wait — background
			// the command (it keeps running) so the message injects promptly.
			const notices =
				waitResult.kind === "steer"
					? [...pendingNotices, "Backgrounded early to handle an incoming message; the command keeps running."]
					: pendingNotices;
			return this.#buildBackgroundStartResult(job.jobId, job.getLatestText(), timeoutSec, {
				requestedTimeoutSec,
				notices,
			});
		}

		// Fold direnv/devenv env into (command, env) ONCE for the two backends
		// that bypass `executeBash` — the ACP client terminal and the PTY. The
		// `executeBash` branch below is intentionally excluded: it runs its own
		// preflight internally, so routing the pre-applied command there too
		// would double-apply the unset prefix and re-merge the env. No
		// `commandPrefix` here: ACP applies the shell prefix via
		// `wrapShellLineForClientTerminal`, and the PTY path never wrapped one.
		// `callerTimeoutMs` clamps the direnv load to a positive command timeout
		// (the backend's own timeout is installed only after this await), matching
		// the executeBash branch so a cold `.envrc` can't outlast a short call.
		const backendPreflight =
			(clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty) ||
			canUseInteractiveBashPty(pty, ctx)
				? await applyDirenvPreflight(command, commandCwd, {
						callerEnv: resolvedEnv,
						signal,
						timeoutMs: this.session.settings.get("bash.direnvLoadTimeoutMs"),
						callerTimeoutMs: timeoutMs,
						direnvSetting: this.session.settings.get("bash.direnv"),
					})
				: undefined;

		// Route through the client terminal when the client advertises the terminal capability.
		// Skip when pty=true (PTY needs the local terminal UI). ACP keeps its shell
		// wrapping, direnv preflight, live terminal details, and best-effort cleanup.
		if (clientBridge?.capabilities.terminal && clientBridge.createTerminal && !pty) {
			const bridgeCommand = backendPreflight?.command ?? command;
			const bridgeEnv = backendPreflight?.env ?? resolvedEnv;
			const shellSpawn = wrapShellLineForClientTerminal(bridgeCommand, this.session.settings.getShellConfig());
			const createTerminal = clientBridge.createTerminal.bind(clientBridge);
			return runBridgeTerminal({
				createTerminal,
				createParams: {
					command: shellSpawn.command,
					args: shellSpawn.args,
					cwd: commandCwd,
					env: bridgeEnv
						? Object.entries(bridgeEnv).map(([name, value]) => ({ name, value: value as string }))
						: undefined,
					outputByteLimit: DEFAULT_MAX_BYTES,
				},
				timeoutMs,
				timeoutSec,
				signal,
				failurePolicy: "best-effort",
				onCreated: terminalId => {
					onUpdate?.({ content: [], details: { terminalId } });
				},
				onOutput: (terminalId, output) => {
					onUpdate?.({
						content: [{ type: "text", text: output.output }],
						details: { terminalId },
					});
				},
				onCompleted: async completion => {
					const bridgeResult = bridgeCompletionToBashResult(completion);
					const bridgeNotices: string[] = [];
					if (completion.output.truncated) bridgeNotices.push("(output truncated)");
					for (const notice of pendingNotices) bridgeNotices.push(notice);
					return this.#buildCompletedResult(bridgeResult, timeoutSec, {
						requestedTimeoutSec,
						notices: bridgeNotices,
						terminalId: completion.terminalId,
						wallTimeMs: completion.wallTimeMs,
					});
				},
			});
		}

		// Track output for streaming updates (tail only)
		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);

		// Allocate artifact for truncated output storage
		const artifact = (await this.session.allocateOutputArtifact?.("bash")) ?? {};
		const { path: artifactPath, id: artifactId } = artifact;

		const interactiveUi = canUseInteractiveBashPty(pty, ctx) ? ctx?.ui : undefined;
		if (pty && !interactiveUi) {
			pendingNotices.push("pty requested but unavailable in this environment; ran without a terminal");
		}
		const wallTimeStart = performance.now();
		let result: BashResult | BashInteractiveResult;
		try {
			result = interactiveUi
				? await runInteractiveBashPty(interactiveUi, {
						// PTY bypasses executeBash, so feed it the direnv-transformed
						// command + merged env (backendPreflight is defined whenever this
						// branch runs, since both gate on canUseInteractiveBashPty).
						command: backendPreflight?.command ?? command,
						cwd: commandCwd,
						timeoutMs,
						signal,
						env: backendPreflight?.env ?? resolvedEnv,
						artifactPath,
						artifactId,
					})
				: // executeBash runs its OWN direnv preflight internally — pass the RAW
					// command + resolvedEnv here so the unset prefix / env merge is not
					// applied twice.
					await executeBash(command, {
						cwd: commandCwd,
						sessionKey: this.session.getSessionId?.() ?? undefined,
						timeout: timeoutMs ?? 0,
						signal,
						env: resolvedEnv,
						artifactPath,
						artifactId,
						onChunk: streamTailUpdates(tailBuffer, onUpdate),
						onMinimizedSave: originalText => saveBashOriginalArtifact(this.session, originalText),
					});
		} finally {
			artifact.release?.();
		}
		const wallTimeMs = performance.now() - wallTimeStart;
		if (result.cancelled) {
			// A cancelled result is either a timeout (the command's deadline fired)
			// or a user/system abort. Timeouts are handled by #buildCompletedResult
			// which returns a non-throwing error result with details.timedOut=true
			// so the renderer can show a warning border instead of error red.
			// Both interactive and non-interactive results carry an explicit
			// `timedOut` field from the executor/PTY layer.
			const isTimeout = result.timedOut === true;
			if (!isTimeout) {
				const out = normalizeResultOutput(result);
				// The local executor already prepends `[Command cancelled]`; PTY
				// output does not, so preserve one cancellation notice in either case.
				const message = out.startsWith("[Command cancelled]")
					? out
					: out
						? `${out}\n\n[Command aborted]`
						: "Command aborted";
				if (signal?.aborted) {
					throw new ToolAbortError(message);
				}
				throw new ToolError(message);
			}
		}
		return this.#buildCompletedResult(result, timeoutSec, {
			requestedTimeoutSec,
			notices: pendingNotices,
			wallTimeMs,
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================
export interface BashRenderArgs {
	command?: string;
	env?: Record<string, unknown>;
	timeout?: number;
	cwd?: string;
	__partialJson?: string;
	[key: string]: unknown;
}

export interface BashRenderContext {
	/** Raw output text */
	output?: string;
	/** Whether output came from artifact storage */
	isFullOutput?: boolean;
	/** Whether output is expanded */
	expanded?: boolean;
	/** Number of preview lines when collapsed */
	previewLines?: number;
	/** Timeout in seconds */
	timeout?: number;
}

export interface ShellRendererConfig<TArgs> {
	resolveTitle: (args: TArgs | undefined, options: RenderResultOptions) => string;
	resolveCommand?: (args: TArgs | undefined) => string | undefined;
	resolveCwd?: (args: TArgs | undefined) => string | undefined;
	resolveEnv?: (args: TArgs | undefined) => Record<string, unknown> | undefined;
	showHeader?: boolean;
}

function getPartialJson<TArgs>(args: TArgs | undefined): string | undefined {
	if (!args || typeof args !== "object" || !("__partialJson" in args)) return undefined;
	const value = (args as { __partialJson?: unknown }).__partialJson;
	return typeof value === "string" ? value : undefined;
}

export function getBashEnvForDisplay(args: BashRenderArgs): Record<string, unknown> | undefined {
	// The parsed args don't always mirror the exact current stream prefix, so recover
	// env from the raw JSON buffer to surface `NAME="..." cmd` in the preview as it
	// streams rather than only once the args object finishes.
	const partialEnv = extractPartialBashEnv(args.__partialJson);
	if (partialEnv && args.env) return { ...partialEnv, ...args.env };
	return args.env ?? partialEnv;
}

/**
 * Returns the bash command formatted for the result body: the dim `$ cd … &&`
 * prefix joined with syntax-highlighted command lines. The prefix is applied
 * only to the first line so multi-line commands display cleanly — terminals
 * reset SGR state at line boundaries, which made the previous single-string
 * `theme.fg("dim", ...)` form render only the first line as dim.
 */
export function formatBashCommandLines(args: BashRenderArgs, uiTheme: Theme): string[] {
	const command = replaceTabs(args.command || "…");
	const cwd = getProjectDir();
	const displayWorkdir = formatToolWorkingDirectory(args.cwd, cwd);
	const envAssignments = formatBashEnvAssignments(getBashEnvForDisplay(args));
	const prefixParts = ["$"];
	if (displayWorkdir) prefixParts.push(`cd ${displayWorkdir} &&`);
	if (envAssignments) prefixParts.push(envAssignments);
	const prefix = uiTheme.fg("dim", `${prefixParts.join(" ")} `);
	const highlightedLines = highlightCode(command, "bash");
	if (highlightedLines.length === 0) return [prefix.trimEnd()];
	return highlightedLines.map((line, i) => (i === 0 ? `${prefix}${line}` : line));
}

function toBashRenderArgs<TArgs>(args: TArgs | undefined, config: ShellRendererConfig<TArgs>): BashRenderArgs {
	return {
		command: config.resolveCommand?.(args),
		cwd: config.resolveCwd?.(args),
		env: config.resolveEnv?.(args),
		__partialJson: getPartialJson(args),
	};
}

export function createShellRenderer<TArgs>(config: ShellRendererConfig<TArgs>) {
	return {
		renderCall(args: TArgs, options: RenderResultOptions, uiTheme: Theme): Component {
			const renderArgs = toBashRenderArgs(args, config);
			const cmdLines = formatBashCommandLines(renderArgs, uiTheme);
			const outputBlock = new CachedOutputBlock();
			return markFramedBlockComponent({
				render: (width: number): readonly string[] => {
					const header =
						config.showHeader === false
							? undefined
							: renderStatusLine(
									{
										icon: options.spinnerFrame !== undefined ? "running" : "pending",
										spinnerFrame: options.spinnerFrame,
										title: config.resolveTitle(args, options),
									},
									uiTheme,
								);
					return outputBlock.render(
						{
							header,
							state: options.spinnerFrame !== undefined ? "running" : "pending",
							sections: [{ lines: capPreviewLines(cmdLines, uiTheme, { expanded: options.expanded }) }],
							width,
						},
						uiTheme,
					);
				},
				invalidate: () => {
					outputBlock.invalidate();
				},
			});
		},

		renderResult(
			result: {
				content: Array<{ type: string; text?: string }>;
				details?: BashToolDetails;
				isError?: boolean;
			},
			options: RenderResultOptions & { renderContext?: BashRenderContext },
			uiTheme: Theme,
			args?: TArgs,
		): Component {
			const renderArgs = toBashRenderArgs(args, config);
			const cmdLines = args ? formatBashCommandLines(renderArgs, uiTheme) : undefined;
			const isError = result.isError === true;
			const isPartial = options.isPartial === true;
			const success = !isPartial && !isError;
			const details = result.details;
			const isTimeout = details?.timedOut === true;
			const header =
				config.showHeader === false
					? undefined
					: renderStatusLine(
							success
								? {
										iconOverride: uiTheme.styledSymbol("tool.bash", "accent"),
										title: config.resolveTitle(args, options),
									}
								: {
										icon: isPartial ? "pending" : isTimeout ? "warning" : "error",
										title: config.resolveTitle(args, options),
									},
							uiTheme,
						);
			const outputBlock = new CachedOutputBlock();

			// Per-instance cache for the expensive inner lines computation. Mirrors
			// the eval-renderer pattern (`eval-render.ts:709-752`): without this,
			// every TUI repaint (one per keystroke when a long transcript is on
			// screen) re-runs `split` / `replaceTabs` / `truncateToVisualLines` over
			// the whole stored output for every bash row in scrollback. With a
			// 50KB-tail bash result times hundreds of rows, that re-rendering is
			// what pinned the main thread in issue #2081 and made keystrokes feel
			// like the CPU was at 100%. The cache key includes every render input
			// that materially affects the produced lines.
			let cachedWidth: number | undefined;
			let cachedPreviewLines: number | undefined;
			let cachedExpanded: boolean | undefined;
			let cachedRawOutput: string | undefined;
			let cachedIsPartial: boolean | undefined;
			let cachedLines: readonly string[] | undefined;
			let cachedPreviewWindow: number | undefined;

			return markFramedBlockComponent({
				render: (width: number): readonly string[] => {
					// REACTIVE: read mutable options at render time
					const { renderContext } = options;
					const expanded = renderContext?.expanded ?? options.expanded;
					const previewLines = renderContext?.previewLines ?? BASH_DEFAULT_PREVIEW_LINES;

					// Get output from context (preferred) or fall back to result content.
					// Strip the LLM-facing notice appended by wrappedExecute so we don't
					// double-print it alongside the styled warning line below.
					const rawOutput = renderContext?.output ?? result.content?.find(c => c.type === "text")?.text ?? "";

					const isPartial = options.isPartial === true;
					const previewWindow = previewWindowRows();

					if (
						cachedLines !== undefined &&
						cachedWidth === width &&
						cachedPreviewLines === previewLines &&
						cachedExpanded === expanded &&
						cachedRawOutput === rawOutput &&
						cachedIsPartial === isPartial &&
						cachedPreviewWindow === previewWindow
					) {
						return cachedLines;
					}
					const withoutBackground = stripBackgroundNotice(rawOutput, details?.async);
					const strippedOutput = stripOutputNotice(withoutBackground, details?.meta);
					const withoutExit = stripExitCodeNotice(strippedOutput, details?.exitCode);
					const withoutWall = stripWallTimeNotice(withoutExit, details?.wallTimeMs);
					const rawOutputArtifact = stripRawOutputArtifactNotice(withoutWall);
					const output = rawOutputArtifact.text;
					const displayOutput = output.trimEnd();
					const showingFullOutput = expanded && renderContext?.isFullOutput === true;

					// Build truncation warning
					const timeoutDisabled = details?.timeoutDisabled === true || renderContext?.timeout === 0;
					const timeoutSeconds = timeoutDisabled ? undefined : (details?.timeoutSeconds ?? renderContext?.timeout);
					const requestedTimeoutSeconds = details?.requestedTimeoutSeconds;
					const wallTimeMs = details?.wallTimeMs;
					const statsParts: string[] = [];
					if (details?.async?.state === "running") {
						statsParts.push(`Backgrounded: ${details.async.jobId}`);
					}
					if (wallTimeMs !== undefined) {
						statsParts.push(`Wall: ${formatWallTimeSeconds(wallTimeMs)}s`);
					}
					if (timeoutDisabled) {
						statsParts.push("Timeout: disabled");
					}
					if (typeof timeoutSeconds === "number") {
						statsParts.push(
							requestedTimeoutSeconds !== undefined && requestedTimeoutSeconds !== timeoutSeconds
								? `Timeout: ${timeoutSeconds}s (requested ${requestedTimeoutSeconds}s clamped)`
								: `Timeout: ${timeoutSeconds}s`,
						);
					}
					if (rawOutputArtifact.artifactId) {
						statsParts.push(`Artifact: ${rawOutputArtifact.artifactId}`);
					}
					if (isError && typeof details?.exitCode === "number") {
						statsParts.push(`Exit: ${details.exitCode}`);
					}
					const timeoutLine =
						statsParts.length > 0
							? uiTheme.fg(
									"dim",
									`${uiTheme.format.bracketLeft}${statsParts.join(" | ")}${uiTheme.format.bracketRight}`,
								)
							: undefined;
					let warningLine: string | undefined;
					if (details?.meta?.truncation && !showingFullOutput) {
						warningLine = formatStyledTruncationWarning(details.meta, uiTheme) ?? undefined;
					}

					const outputLines: string[] = [];
					const hasOutput = displayOutput.trim().length > 0;
					const rawOutputLines = displayOutput.split("\n");
					const sixelLineMask =
						TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(rawOutputLines) : undefined;
					const hasSixelOutput = sixelLineMask?.some(Boolean) ?? false;
					if (hasOutput) {
						if (hasSixelOutput) {
							outputLines.push(
								...rawOutputLines.map((line, index) =>
									sixelLineMask?.[index] ? line : uiTheme.fg("toolOutput", replaceTabs(line)),
								),
							);
						} else if (expanded) {
							outputLines.push(...rawOutputLines.map(line => uiTheme.fg("toolOutput", replaceTabs(line))));
						} else {
							const styledOutput = rawOutputLines
								.map(line => uiTheme.fg("toolOutput", replaceTabs(line)))
								.join("\n");
							const textContent = styledOutput;
							// Cap the collapsed/streaming output to a viewport-sized tail and
							// measure it at the box's INNER width. Otherwise a growing tail
							// window scrolls its (mutating) rows above the live-region window
							// and the engine re-commits a fresh snapshot every frame —
							// spraying duplicate "… ctrl+o to expand" banners into native
							// scrollback (the box never overflows the viewport now).
							const previewBudget = Math.min(previewLines, previewWindow);
							const result = truncateToVisualLines(textContent, previewBudget, outputBlockContentWidth(width));
							if (result.skippedCount > 0) {
								outputLines.push(
									uiTheme.fg(
										"dim",
										`… (${result.skippedCount} earlier lines, showing ${result.visualLines.length} of ${result.skippedCount + result.visualLines.length}) (ctrl+o to expand)`,
									),
								);
							}
							outputLines.push(...result.visualLines);
						}
					}
					if (timeoutLine) outputLines.push(timeoutLine);
					if (warningLine) outputLines.push(warningLine);

					const framed = outputBlock.render(
						{
							header,
							state: isPartial ? "pending" : isError ? (isTimeout ? "warning" : "error") : "success",
							sections: [
								{
									// Viewport-sized tail window in every state — streaming and final
									// render identically; only ctrl+o uncaps.
									lines: capPreviewLines(cmdLines ?? [], uiTheme, { expanded }),
								},
								{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
							],
							width,
						},
						uiTheme,
					);

					cachedWidth = width;
					cachedPreviewLines = previewLines;
					cachedExpanded = expanded;
					cachedRawOutput = rawOutput;
					cachedIsPartial = isPartial;
					cachedPreviewWindow = previewWindow;
					cachedLines = framed;
					return framed;
				},
				invalidate: () => {
					outputBlock.invalidate();
					cachedLines = undefined;
					cachedWidth = undefined;
					cachedPreviewLines = undefined;
					cachedExpanded = undefined;
					cachedRawOutput = undefined;
					cachedIsPartial = undefined;
					cachedPreviewWindow = undefined;
				},
			});
		},
		mergeCallAndResult: true,
		inline: true,
	};
}

export const bashToolRenderer = createShellRenderer<BashRenderArgs>({
	resolveTitle: () => "Bash",
	resolveCommand: args => args?.command,
	resolveCwd: args => args?.cwd,
	resolveEnv: args => args?.env,
	showHeader: false,
});
