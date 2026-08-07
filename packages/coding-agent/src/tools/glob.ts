import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import * as natives from "@oh-my-pi/pi-natives";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { formatGroupedPaths, isEnoent, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { InternalUrlRouter } from "../internal-urls";
import { splitMemoryGlobPattern } from "../internal-urls/memory-protocol";
import type { Theme } from "../modes/theme/theme";
import globDescription from "../prompts/tools/glob.md" with { type: "text" };
import { type TruncationResult, truncateHead } from "../session/streaming-output";
import type {
	PersistentWorkspacePathMapper,
	RuntimeListResult,
	WorkspaceOperationLease,
} from "../session/workspace-runtime-contracts";
import { isScoutSpawnable } from "../task/spawn-policy";
import { Ellipsis, fileHyperlink, renderFileList, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { applyListLimit } from "./list-limit";
import { formatFullOutputReference, type OutputMeta } from "./output-meta";
import {
	expandDelimitedPathEntries,
	formatPathRelativeToCwd,
	hasGlobPathChars,
	isSshUrl,
	normalizePathLikeInput,
	parseFindPattern,
	partitionExistingPaths,
	resolveExplicitFindPatterns,
	resolveToCwd,
	toPathList,
} from "./path-utils";
import {
	createCachedComponent,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	PREVIEW_LIMITS,
} from "./render-utils";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

const findSchema = type({
	"path?": type("string").describe(
		'glob, file, or directory to search — a single path or a semicolon-delimited list ("src/**/*.ts; test/**/*.ts"). Omitted -> searches the workspace root (".")',
	),
	"hidden?": type("boolean").describe("include hidden files"),
	"gitignore?": type("boolean").describe("respect gitignore"),
	"limit?": type("number").describe("max results"),
});

export type GlobToolInput = typeof findSchema.infer;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;
const DEFAULT_GLOB_TIMEOUT_MS = 5000;

export interface GlobToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
	meta?: OutputMeta;
	// Fields for TUI rendering
	scopePath?: string;
	fileCount?: number;
	files?: string[];
	truncated?: boolean;
	error?: string;
	/** Working directory at search time. Used by the renderer to resolve relative
	 * file paths to absolute paths for OSC 8 hyperlinks. */
	cwd?: string;
	/** User-supplied paths whose base directory was missing on disk. The tool
	 * skipped these and continued with the surviving entries; surfaced as a
	 * non-fatal warning in the renderer and in the model-facing text. */
	missingPaths?: string[];
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (e.g., SSH).
 */
export interface GlobOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Optional stat for distinguishing files vs directories. */
	stat?: (
		absolutePath: string,
	) => Promise<{ isFile(): boolean; isDirectory(): boolean }> | { isFile(): boolean; isDirectory(): boolean };
	/** Find files matching glob pattern. Returns relative paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

export interface PersistentGlobRouteV1 {
	readonly paths: PersistentWorkspacePathMapper;
	begin(signal?: AbortSignal): Promise<WorkspaceOperationLease>;
}

export interface GlobToolOptions {
	/** Custom operations for find. Default: local filesystem + native glob. */
	operations?: GlobOperations;
	/** Remap slash-only paths to the session cwd before root-search validation. */
	rootPathAlias?: boolean;
	/** Persistent-agent route. It never falls back to local filesystem enumeration. */
	persistentRoute?: PersistentGlobRouteV1;
}

interface GlobTarget {
	searchPath: string;
	globPattern: string;
	hasGlob: boolean;
}

export class GlobTool implements AgentTool<typeof findSchema, GlobToolDetails> {
	readonly name = "glob";
	readonly approval = "read" as const;
	readonly loadMode = "essential";
	readonly label = "Glob";
	get description(): string {
		return prompt.render(globDescription, {
			scoutAvailable: isScoutSpawnable(
				this.session.settings.get("task.disabledAgents") as string[] | undefined,
				this.session.getSessionSpawns?.() ?? "*",
			),
		});
	}
	readonly parameters = findSchema;

	readonly examples: readonly ToolExample<typeof findSchema.infer>[] = [
		{
			caption: "Glob files",
			call: { path: "src/**/*.ts" },
		},
		{
			caption: "Multiple targets — semicolon-delimited list",
			call: { path: "src/**/*.ts; test/**/*.ts" },
		},
		{
			caption: "Glob gitignored files like .env",
			call: { path: ".env*", gitignore: false },
		},
		{
			caption: "Glob directories matching a name (returns both files and dirs; directories are suffixed with `/`)",
			call: { path: "**/tests" },
		},
	];
	readonly strict = true;

	readonly #customOps?: GlobOperations;
	readonly #rootPathAlias: boolean;
	readonly #persistentRoute?: PersistentGlobRouteV1;

	constructor(
		private readonly session: ToolSession,
		options?: GlobToolOptions,
	) {
		this.#customOps = options?.operations;
		this.#rootPathAlias = options?.rootPathAlias === true;
		this.#persistentRoute = options?.persistentRoute;
	}

	#persistentGlobEntries(pathInput: string | string[] | undefined): string[] {
		const entries = toPathList(pathInput);
		const expanded: string[] = [];
		for (const entry of entries.length > 0 ? entries : ["."]) {
			let braceDepth = 0;
			let start = 0;
			for (let index = 0; index < entry.length; index++) {
				const character = entry[index];
				if (character === "{") braceDepth++;
				else if (character === "}" && braceDepth > 0) braceDepth--;
				else if (character === ";" && braceDepth === 0) {
					expanded.push(entry.slice(start, index));
					start = index + 1;
				}
			}
			expanded.push(entry.slice(start));
		}
		return expanded;
	}

	#preparePersistentParams(params: typeof findSchema.infer): typeof findSchema.infer {
		const route = this.#persistentRoute;
		if (!route) return params;
		const entries = this.#persistentGlobEntries(params.path);
		for (const entry of entries) {
			if (
				entry.length === 0 ||
				entry.trim() !== entry ||
				entry.includes("\\") ||
				entry.includes("'") ||
				entry.includes('"') ||
				entry.startsWith("~") ||
				/^[a-z][a-z0-9+.-]*:/i.test(entry) ||
				(path.win32.isAbsolute(entry) &&
					entry !== route.paths.modelRoot &&
					!entry.startsWith(`${route.paths.modelRoot}/`))
			) {
				throw new ToolError(
					`Persistent glob paths must be canonical relative paths or rooted at ${route.paths.modelRoot}: ${entry}`,
				);
			}
			const { basePath } = parseFindPattern(entry);
			try {
				route.paths.parse(basePath === "." ? route.paths.modelRoot : basePath);
			} catch {
				throw new ToolError(
					`Persistent glob paths must be canonical relative paths or rooted at ${route.paths.modelRoot}: ${entry}`,
				);
			}
		}
		return { ...params, path: entries as unknown as string };
	}

	async #executeRuntimeRoute(
		toolCallId: string,
		params: typeof findSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GlobToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<GlobToolDetails>> {
		const route = this.#persistentRoute;
		if (!route) throw new Error("Persistent glob route is unavailable");
		const routedParams = this.#preparePersistentParams(params);
		const timeoutSignal = AbortSignal.timeout(DEFAULT_GLOB_TIMEOUT_MS);
		const routeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		throwIfAborted(routeSignal);
		const lease = await route.begin(routeSignal);
		const inFlight = new Set<Promise<unknown>>();
		const track = <T>(request: Promise<T>): Promise<T> => {
			let settled!: Promise<T>;
			settled = request.finally(() => inFlight.delete(settled));
			inFlight.add(settled);
			return settled;
		};
		const access = {
			operationLeaseId: lease.operationLeaseId,
			workspaceId: lease.binding.lease.replica.workspaceId,
			expectedGeneration: lease.binding.lease.baseGeneration,
			replicaId: lease.binding.lease.replica.replicaId,
			leaseId: lease.binding.lease.leaseId,
			fence: lease.binding.fence,
		};
		const toModelPath = (input: string) => route.paths.parse(input).modelPath;
		const includeHidden = params.hidden ?? true;
		const useGitignore = params.gitignore ?? true;
		type IgnoreRule = { readonly pattern: string; readonly negated: boolean; readonly directoryOnly: boolean };
		const ignoreRules = new Map<string, Promise<readonly IgnoreRule[]>>();
		const globMatches = (pattern: string, candidate: string): boolean => {
			let expression = "";
			for (let index = 0; index < pattern.length; index++) {
				const character = pattern[index];
				if (character === "*") {
					if (pattern[index + 1] === "*") {
						while (pattern[index + 1] === "*") index++;
						if (pattern[index + 1] === "/") {
							index++;
							expression += "(?:.*/)?";
						} else expression += ".*";
					} else expression += "[^/]*";
				} else if (character === "?") expression += "[^/]";
				else expression += /[|\\{}()[\]^$+?.]/.test(character) ? `\\${character}` : character;
			}
			return new RegExp(`^${expression}$`).test(candidate);
		};
		const loadIgnoreRules = (directory: string): Promise<readonly IgnoreRule[]> => {
			const existing = ignoreRules.get(directory);
			if (existing) return existing;
			const loaded = (async () => {
				const ignorePath = path.posix.join(directory, ".gitignore");
				const exists = await track(lease.binding.bridge.exists({ ...access, path: toModelPath(ignorePath) }));
				throwIfAborted(routeSignal);
				if (!exists) return [];
				const { content } = await track(
					lease.binding.bridge.readTextFile({
						...access,
						path: toModelPath(ignorePath),
						line: null,
						limit: null,
						byteLimit: 1_048_576,
					}),
				);
				return content.split(/\r?\n/).flatMap(rawLine => {
					const line = rawLine.endsWith(" ") ? rawLine.replace(/ +$/, "") : rawLine;
					if (!line || line.startsWith("#")) return [];
					const negated = line.startsWith("!");
					const pattern = (negated ? line.slice(1) : line).replace(/^\//, "");
					if (!pattern) return [];
					return [{ pattern: pattern.replace(/\/$/, ""), negated, directoryOnly: pattern.endsWith("/") }];
				});
			})();
			ignoreRules.set(directory, loaded);
			return loaded;
		};
		const isGitIgnored = async (modelPath: string): Promise<boolean> => {
			if (!useGitignore) return false;
			const segments = path.posix.relative(route.paths.modelRoot, modelPath).split("/").filter(Boolean);
			let ignored = false;
			for (let depth = 0; depth < segments.length; depth++) {
				const directory =
					depth === 0
						? route.paths.modelRoot
						: path.posix.join(route.paths.modelRoot, ...segments.slice(0, depth));
				const candidate = segments.slice(depth).join("/");
				for (const rule of await loadIgnoreRules(directory)) {
					const matched = rule.directoryOnly
						? candidate.split("/").some(segment => globMatches(rule.pattern, segment))
						: rule.pattern.includes("/")
							? globMatches(rule.pattern, candidate)
							: candidate.split("/").some(segment => globMatches(rule.pattern, segment));
					if (matched) ignored = !rule.negated;
				}
			}
			return ignored;
		};
		const operations: GlobOperations = {
			exists: async input => {
				const exists = await track(lease.binding.bridge.exists({ ...access, path: toModelPath(input) }));
				throwIfAborted(routeSignal);
				return exists;
			},
			stat: async input => {
				const stat = await track(lease.binding.bridge.stat({ ...access, path: toModelPath(input) }));
				throwIfAborted(routeSignal);
				return {
					isFile: () => stat.kind === "file",
					isDirectory: () => stat.kind === "directory",
				};
			},
			glob: (pattern, cwd, options) =>
				track(
					(async () => {
						const root = toModelPath(cwd);
						const entries: Array<{ path: string; kind: "file" | "directory" | "symlink" }> = [];
						const pendingDirectories = [root];
						const visitedDirectories = new Set<string>([root]);
						while (pendingDirectories.length > 0 && entries.length < options.limit) {
							const directory = pendingDirectories.shift();
							if (!directory) break;
							const seenCursors = new Set<string>();
							let cursor: string | null = null;
							do {
								throwIfAborted(routeSignal);
								const page: RuntimeListResult = await track(
									lease.binding.bridge.listFiles({
										...access,
										directory,
										pattern: "*",
										limit: options.limit,
										cursor,
									}),
								);
								throwIfAborted(routeSignal);
								if (page.nextCursor !== null && seenCursors.has(page.nextCursor)) {
									throw new ToolError(`Persistent glob provider repeated cursor for ${directory}`);
								}
								if (cursor !== null) seenCursors.add(cursor);
								cursor = page.nextCursor;
								for (const entry of page.entries) {
									throwIfAborted(routeSignal);
									const returnedPath = route.paths.parseReturnedModelPath(entry.path).modelPath;
									const relativeToDirectory = path.posix.relative(directory, returnedPath);
									if (
										!relativeToDirectory ||
										relativeToDirectory === ".." ||
										relativeToDirectory.startsWith("../") ||
										path.posix.isAbsolute(relativeToDirectory)
									) {
										throw new ToolError(
											`Persistent glob provider returned path outside requested directory: ${returnedPath}`,
										);
									}
									if (entry.kind === "directory" && !visitedDirectories.has(returnedPath)) {
										visitedDirectories.add(returnedPath);
										pendingDirectories.push(returnedPath);
									}
									const relativeToRoot = path.posix.relative(root, returnedPath);
									const segments = relativeToRoot.split("/").filter(Boolean);
									const fixedIgnored =
										(options.ignore.includes("**/node_modules/**") && segments.includes("node_modules")) ||
										(options.ignore.includes("**/.git/**") && segments.includes(".git"));
									if (fixedIgnored || (!includeHidden && segments.some(segment => segment.startsWith("."))))
										continue;
									if (await isGitIgnored(returnedPath)) continue;
									if (entry.kind !== "directory" && !globMatches(pattern, relativeToRoot)) continue;
									entries.push({ path: returnedPath, kind: entry.kind });
									if (entries.length >= options.limit) break;
								}
							} while (cursor !== null && entries.length < options.limit);
						}
						entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
						return entries.map(entry => (entry.kind === "directory" ? `${entry.path}/` : entry.path));
					})(),
				),
		};
		const routedSession: ToolSession = { ...this.session, cwd: route.paths.modelRoot };
		try {
			return await new GlobTool(routedSession, { operations }).execute(
				toolCallId,
				routedParams,
				routeSignal,
				onUpdate,
				context,
			);
		} finally {
			await Promise.allSettled([...inFlight]);
			lease.end();
		}
	}

	async execute(
		toolCallId: string,
		params: typeof findSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<GlobToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<GlobToolDetails>> {
		if (this.#persistentRoute) return this.#executeRuntimeRoute(toolCallId, params, signal, onUpdate, context);
		const { path: pathInput, limit, hidden, gitignore } = params;

		return untilAborted(signal, async () => {
			const formatScopePath = (targetPath: string): string => formatPathRelativeToCwd(targetPath, this.session.cwd);
			const scopedPaths = toPathList(pathInput);
			const effectivePaths = scopedPaths.length > 0 ? scopedPaths : ["."];
			const rawPatternInputs = this.#customOps
				? effectivePaths
				: await expandDelimitedPathEntries(effectivePaths, this.session.cwd, { splitter: parseFindPattern });
			const rawPatterns = rawPatternInputs.map(input => normalizePathLikeInput(input).replace(/\\/g, "/"));
			const aliasResolvedPatterns = this.#rootPathAlias
				? rawPatterns.map(pattern => (/^\/+$/.test(pattern) ? "." : pattern))
				: rawPatterns;
			if (aliasResolvedPatterns.some(pattern => /^\/+$/.test(pattern))) {
				throw new ToolError("Searching from root directory '/' is not allowed");
			}
			const internalRouter = InternalUrlRouter.instance();
			const normalizedPatterns: string[] = [];
			for (const rawPattern of aliasResolvedPatterns) {
				if (!internalRouter.canHandle(rawPattern)) {
					normalizedPatterns.push(rawPattern);
					continue;
				}
				if (isSshUrl(rawPattern)) {
					throw new ToolError(
						`find cannot operate on a remote ssh:// path: ${rawPattern}. ssh:// has no local file to glob; use \`read ${rawPattern}\` to list or inspect the remote path.`,
					);
				}
				if (hasGlobPathChars(rawPattern)) {
					if (!/^memory:\/\//i.test(rawPattern)) {
						throw new ToolError(`Glob patterns are not supported for internal URLs: ${rawPattern}`);
					}
					const memoryGlob = splitMemoryGlobPattern(rawPattern);
					const resource = await internalRouter.resolve(memoryGlob.baseUrl, {
						cwd: this.session.cwd,
						settings: this.session.settings,
						signal,
						localProtocolOptions: this.session.localProtocolOptions,
						skills: this.session.skills,
						pathOnly: true,
					});
					if (!resource.sourcePath) {
						throw new ToolError(`Cannot find internal URL without a backing file: ${memoryGlob.baseUrl}`);
					}
					normalizedPatterns.push(
						path.join(resource.sourcePath.replace(/[*?[{]/g, "[$&]"), memoryGlob.globPattern),
					);
					continue;
				}
				const resource = await internalRouter.resolve(rawPattern, {
					cwd: this.session.cwd,
					settings: this.session.settings,
					signal,
					localProtocolOptions: this.session.localProtocolOptions,
					skills: this.session.skills,
					pathOnly: true,
				});
				if (!resource.sourcePath) {
					throw new ToolError(`Cannot find internal URL without a backing file: ${rawPattern}`);
				}
				normalizedPatterns.push(resource.sourcePath);
			}
			if (normalizedPatterns.some(pattern => pattern.length === 0)) {
				throw new ToolError("`path` must contain non-empty globs or paths");
			}

			// Tolerate missing entries in a multi-path call: skip ones whose base
			// directory is gone, and only error if every entry is missing. Single
			// missing path keeps the original ENOENT semantics — the user explicitly
			// asked about that one path, so silent empty results would be misleading.
			let missingPaths: string[] = [];
			let effectivePatterns = normalizedPatterns;
			if (normalizedPatterns.length > 1 && !this.#customOps) {
				const partition = await partitionExistingPaths(normalizedPatterns, this.session.cwd, parseFindPattern);
				if (partition.valid.length === 0) {
					throw new ToolError(`Path not found: ${partition.missing.join(", ")}`);
				}
				effectivePatterns = partition.valid;
				missingPaths = partition.missing;
			}

			const multiPattern = await resolveExplicitFindPatterns(effectivePatterns, this.session.cwd);
			const isSingle = !multiPattern;
			const targets: GlobTarget[] = multiPattern
				? multiPattern.targets.map(target => ({
						searchPath: resolveToCwd(target.basePath, this.session.cwd),
						globPattern: target.globPattern,
						hasGlob: target.hasGlob,
					}))
				: [
						(() => {
							const parsed = parseFindPattern(effectivePatterns[0] ?? ".");
							return {
								searchPath: resolveToCwd(parsed.basePath, this.session.cwd),
								globPattern: parsed.globPattern,
								hasGlob: parsed.hasGlob,
							};
						})(),
					];
			const scopePath = multiPattern?.scopePath ?? formatScopePath(targets[0].searchPath);

			for (const target of targets) {
				if (target.searchPath === "/") {
					throw new ToolError("Searching from root directory '/' is not allowed");
				}
			}

			const requestedLimit = limit ?? DEFAULT_LIMIT;
			if (!Number.isFinite(requestedLimit) || requestedLimit <= 0) {
				throw new ToolError("Limit must be a positive number");
			}
			const effectiveLimit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(requestedLimit)));
			const includeHidden = hidden ?? true;
			const useGitignore = gitignore ?? true;
			const timeoutMs = DEFAULT_GLOB_TIMEOUT_MS;
			const timeoutSignal = AbortSignal.timeout(timeoutMs);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const formatMatchPath = (matchPath: string, base: string, fileType?: natives.FileType): string => {
				const hadTrailingSlash = matchPath.endsWith("/") || matchPath.endsWith("\\");
				const absolutePath = path.isAbsolute(matchPath) ? matchPath : path.resolve(base, matchPath);
				return formatPathRelativeToCwd(absolutePath, this.session.cwd, {
					trailingSlash: fileType === natives.FileType.Dir || hadTrailingSlash,
				});
			};

			const missingPathsNote =
				missingPaths.length > 0 ? `Skipped missing paths: ${missingPaths.join(", ")}` : undefined;

			const buildResult = (
				files: string[],
				opts?: { notice?: string; forceTruncated?: boolean; timedOut?: boolean },
			): AgentToolResult<GlobToolDetails> => {
				const notice = opts?.notice;
				const forceTruncated = opts?.forceTruncated ?? false;
				if (files.length === 0) {
					const details: GlobToolDetails = {
						scopePath,
						fileCount: 0,
						files: [],
						truncated: forceTruncated,
						cwd: this.session.cwd,
						missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
					};
					// A timed-out empty result is an incomplete scan, not a verified
					// absence — never emit the definitive "No files found" claim next
					// to a timeout notice (the two statements contradict each other).
					const parts = opts?.timedOut ? [] : ["No files found matching pattern"];
					if (notice) parts.push(notice);
					if (missingPathsNote) parts.push(missingPathsNote);
					// Zero results is useless regardless of notices: the follow-up
					// call has already corrected course by the time compaction runs.
					return toolResult(details).text(parts.join("\n")).useless().done();
				}

				const listLimit = applyListLimit(files, { limit: effectiveLimit });
				const limited = listLimit.items;
				const limitMeta = listLimit.meta;
				const baseOutput = formatGroupedPaths(limited);
				const trailingNotes: string[] = [];
				if (notice) trailingNotes.push(notice);
				if (missingPathsNote) trailingNotes.push(missingPathsNote);
				const rawOutput = trailingNotes.length > 0 ? `${baseOutput}\n\n${trailingNotes.join("\n")}` : baseOutput;
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });

				const details: GlobToolDetails = {
					scopePath,
					fileCount: limited.length,
					files: limited,
					truncated: Boolean(forceTruncated || limitMeta.resultLimit || truncation.truncated),
					resultLimitReached: limitMeta.resultLimit?.reached,
					truncation: truncation.truncated ? truncation : undefined,
					cwd: this.session.cwd,
					missingPaths: missingPaths.length > 0 ? missingPaths : undefined,
				};

				const resultBuilder = toolResult(details)
					.text(truncation.content)
					.limits({ resultLimit: limitMeta.resultLimit?.reached });
				if (truncation.truncated) {
					resultBuilder.truncation(truncation, { direction: "head" });
				}

				return resultBuilder.done();
			};

			// Walk each user path as its own root and run the globs concurrently.
			// Collapsing multiple paths to a shared base would force the walker to
			// traverse and stat every unrelated sibling under that ancestor; per-path
			// roots keep each scan bounded to exactly what the user asked for.
			if (this.#customOps?.glob) {
				const customOps = this.#customOps;
				const perTarget = await Promise.all(
					targets.map(async target => {
						if (!(await customOps.exists(target.searchPath))) {
							if (isSingle) throw new ToolError(`Path not found: ${scopePath}`);
							return [] as string[];
						}
						if (!target.hasGlob && customOps.stat) {
							const stat = await customOps.stat(target.searchPath);
							if (stat.isFile()) return [formatScopePath(target.searchPath)];
						}
						const results = await customOps.glob(target.globPattern, target.searchPath, {
							ignore: ["**/node_modules/**", "**/.git/**"],
							limit: effectiveLimit,
						});
						return results.map(matchPath => formatMatchPath(matchPath, target.searchPath));
					}),
				);
				const seen = new Set<string>();
				const merged: string[] = [];
				for (const group of perTarget) {
					for (const entry of group) {
						if (seen.has(entry)) continue;
						seen.add(entry);
						merged.push(entry);
					}
				}
				return buildResult(merged);
			}

			const onUpdateMatches: string[] = [];
			const onUpdateMtimes: number[] = [];
			const updateIntervalMs = 200;
			let lastUpdate = 0;
			const emitUpdate = () => {
				if (!onUpdate) return;
				const now = Date.now();
				if (now - lastUpdate < updateIntervalMs) return;
				lastUpdate = now;
				const details: GlobToolDetails = {
					scopePath,
					fileCount: onUpdateMatches.length,
					files: onUpdateMatches.slice(),
					truncated: false,
				};
				onUpdate({
					content: [{ type: "text", text: onUpdateMatches.join("\n") }],
					details,
				});
			};
			const streamed = new Set<string>();
			const makeOnMatch =
				(base: string) =>
				(err: Error | null, match: natives.GlobMatch | null): void => {
					if (err || combinedSignal.aborted || !match?.path) return;
					const relativePath = formatMatchPath(match.path, base, match.fileType);
					if (streamed.has(relativePath)) return;
					streamed.add(relativePath);
					onUpdateMatches.push(relativePath);
					onUpdateMtimes.push(match.mtime ?? 0);
					emitUpdate();
				};

			let timedOut = false;
			const runTarget = async (target: GlobTarget): Promise<Array<{ path: string; mtime: number }>> => {
				throwIfAborted(signal);
				let stat: fs.Stats;
				try {
					stat = await fs.promises.stat(target.searchPath);
				} catch (err) {
					if (isEnoent(err)) {
						if (isSingle) throw new ToolError(`Path not found: ${scopePath}`);
						return [];
					}
					throw err;
				}
				if (!target.hasGlob && stat.isFile()) {
					return [{ path: formatScopePath(target.searchPath), mtime: stat.mtimeMs }];
				}
				if (!stat.isDirectory()) {
					if (isSingle) throw new ToolError(`Path is not a directory: ${target.searchPath}`);
					return [];
				}
				try {
					const result = await untilAborted(combinedSignal, () =>
						natives.glob(
							{
								pattern: target.globPattern,
								path: target.searchPath,
								hidden: includeHidden,
								maxResults: effectiveLimit,
								sortByMtime: true,
								gitignore: useGitignore,
								// parseFindPattern explicitly prepends "**/" when the user's
								// pattern begins with a glob (so `*.ts` becomes `**/*.ts`).
								// Anything that arrives here without "**/" was scoped to a
								// single directory by the user (e.g. `dir/*`); disable the
								// native auto-recursion so `dir/*` does not silently match
								// `dir/sub/nested.ts`.
								recursive: false,
								signal: combinedSignal,
							},
							makeOnMatch(target.searchPath),
						),
					);
					throwIfAborted(signal);
					const out: Array<{ path: string; mtime: number }> = [];
					for (const match of result.matches) {
						if (!match.path) continue;
						out.push({
							path: formatMatchPath(match.path, target.searchPath, match.fileType),
							mtime: match.mtime ?? 0,
						});
					}
					return out;
				} catch (error) {
					if (error instanceof Error && error.name === "AbortError") {
						if (timeoutSignal.aborted && !signal?.aborted) {
							timedOut = true;
							return [];
						}
						throw new ToolAbortError();
					}
					throw error;
				}
			};

			const perTarget = await Promise.all(targets.map(runTarget));

			if (timedOut) {
				// Drain the partial matches accumulated during streaming and return them
				// instead of throwing — empty results after a multi-second wait force the
				// caller to retry blind, which is the worst possible outcome.
				const partial = onUpdateMatches.map((entry, index) => ({ p: entry, m: onUpdateMtimes[index] ?? 0 }));
				partial.sort((a, b) => b.m - a.m);
				const sortedPaths = partial.map(entry => entry.p);
				const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
				// Walk cost tracks directory-tree size, not pattern specificity: a
				// mtime-ranked scan cannot early-exit, so a "narrow" pattern over a
				// huge tree still times out. Say so instead of implying the pattern
				// was too broad.
				const notice =
					sortedPaths.length > 0
						? `glob timed out after ${seconds}s; returning ${sortedPaths.length} partial matches — results are incomplete, scope to a deeper directory instead of retrying blindly`
						: `Glob timed out after ${seconds}s before finding any matches — the scan is incomplete, NOT proof of absence. The walk is bounded by directory size, not pattern width; scope the search to a deeper directory (e.g. \`sub/dir/*.ext\` instead of \`*.ext\` at a huge root).`;
				return buildResult(sortedPaths, { notice, forceTruncated: true, timedOut: true });
			}

			// Merge per-target results: native glob already ranks each target's own
			// matches by mtime and caps them at the limit, so a global mtime re-sort
			// plus dedup yields the correct top-N across all roots.
			const seen = new Set<string>();
			const merged: Array<{ path: string; mtime: number }> = [];
			for (const group of perTarget) {
				for (const entry of group) {
					if (seen.has(entry.path)) continue;
					seen.add(entry.path);
					merged.push(entry);
				}
			}
			merged.sort((a, b) => b.mtime - a.mtime);
			return buildResult(merged.map(entry => entry.path));
		});
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface GlobRenderArgs {
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string | string[];
	limit?: number;
}

function formatGlobRenderPaths(args: GlobRenderArgs | undefined): string | undefined {
	const list = toPathList(args?.path ?? args?.paths);
	return list.length > 0 ? list.join(", ") : undefined;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

function globStatusIcon(uiTheme: Theme): string {
	return uiTheme.fg("toolTitle", uiTheme.symbol("icon.search"));
}

export const globToolRenderer = {
	inline: true,
	renderCall(args: GlobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Glob",
				titleColor: "toolTitle",
				description: formatGlobRenderPaths(args) || "*",
				meta,
			},
			uiTheme,
		);
		return new Text(text, 1, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GlobToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GlobRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 1, 0);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find(c => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (
				!textContent ||
				textContent.includes("No files matching") ||
				textContent.includes("No files found") ||
				textContent.trim() === ""
			) {
				return new Text(formatEmptyMessage("No files found", uiTheme), 1, 0);
			}

			const lines = textContent.split("\n").filter(l => l.trim());
			const header = renderStatusLine(
				{
					iconOverride: globStatusIcon(uiTheme),
					title: "Glob",
					titleColor: "toolTitle",
					description: formatGlobRenderPaths(args),
					meta: [formatCount("file", lines.length)],
				},
				uiTheme,
			);
			return createCachedComponent(
				() => options.expanded,
				width => {
					const listLines = renderTreeList(
						{
							items: lines,
							expanded: options.expanded,
							maxCollapsed: COLLAPSED_LIST_LIMIT,
							itemType: "file",
							renderItem: line => uiTheme.fg("accent", line),
						},
						uiTheme,
					);
					return [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				},
				{ paddingX: 1 },
			);
		}

		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.truncation ?? details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || details?.resultLimitReached || limits?.resultLimit);
		const files = details?.files ?? [];

		const missingPaths = details?.missingPaths ?? [];
		const missingNote =
			missingPaths.length > 0 ? uiTheme.fg("warning", `skipped missing: ${missingPaths.join(", ")}`) : undefined;

		if (fileCount === 0) {
			// `truncated` on an empty result means the scan timed out mid-walk —
			// render "incomplete", not a definitive "No files found".
			const emptyLabel = truncated ? "No matches before timeout (scan incomplete)" : "No files found";
			const header = renderStatusLine(
				{
					icon: "warning",
					title: "Glob",
					titleColor: "toolTitle",
					description: formatGlobRenderPaths(args),
					meta: truncated ? ["0 files", uiTheme.fg("warning", "timed out")] : ["0 files"],
				},
				uiTheme,
			);
			const lines = [header, formatEmptyMessage(emptyLabel, uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 1, 0);
		}
		const meta: string[] = [formatCount("file", fileCount)];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const header = renderStatusLine(
			{
				...(truncated ? { icon: "warning" as const } : { iconOverride: globStatusIcon(uiTheme) }),
				title: "Glob",
				titleColor: "toolTitle",
				description: formatGlobRenderPaths(args),
				meta,
			},
			uiTheme,
		);

		const truncationReasons: string[] = [];
		if (details?.resultLimitReached) truncationReasons.push(`limit ${details.resultLimitReached} results`);
		if (limits?.resultLimit) truncationReasons.push(`limit ${limits.resultLimit.reached} results`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
		if (artifactId) truncationReasons.push(formatFullOutputReference(artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", `truncated: ${truncationReasons.join(", ")}`));
		}
		if (missingNote) extraLines.push(missingNote);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const cwd = details?.cwd;
				const fileLines = renderFileList(
					{
						files: files.map(entry => ({
							path: entry,
							isDirectory: entry.endsWith("/"),
							absPath: cwd && !entry.endsWith("/") ? path.resolve(cwd, entry) : undefined,
						})),
						expanded: options.expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
						hyperlinkFn: fileHyperlink,
					},
					uiTheme,
				);
				return [header, ...fileLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
			{ paddingX: 1 },
		);
	},
	mergeCallAndResult: true,
};
