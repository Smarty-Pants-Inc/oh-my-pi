import * as path from "node:path";
import { MismatchError as HashlineMismatchError, Patch } from "@oh-my-pi/hashline";
import hashlineGrammar from "@oh-my-pi/hashline/grammar.lark" with { type: "text" };
import hashlineDescription from "@oh-my-pi/hashline/prompt.md" with { type: "text" };
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { isEnoent, isEnotdir, prompt } from "@oh-my-pi/pi-utils";
import { createLspWritethrough, flushLspWritethroughBatch, type WritethroughCallback, writethroughNoop } from "../lsp";
import { DeferredDiagnostics } from "../lsp/deferred-diagnostics";
import { getDiagnosticsLedger } from "../lsp/diagnostics-ledger";
import applyPatchDescription from "../prompts/tools/apply-patch.md" with { type: "text" };
import patchDescription from "../prompts/tools/patch.md" with { type: "text" };
import replaceDescription from "../prompts/tools/replace.md" with { type: "text" };
import {
	canonicalRuntimeSha256,
	deriveProviderSubrequestId,
	type PersistentModelWorkspacePath,
	type PersistentWorkspacePathMapper,
	type WorkspaceOperationLease,
} from "../session/workspace-runtime-contracts";
import type { ToolSession } from "../tools";
import { truncateForPrompt } from "../tools/approval";
import { findUniqueWorkspaceSuffix, isInternalUrlPath } from "../tools/path-utils";
import { resolvePlanPath } from "../tools/plan-mode-guard";
import { ToolError } from "../tools/tool-errors";
import { type EditMode, normalizeEditMode, resolveEditMode } from "../utils/edit-mode";
import { executeHashlineSingle, hashlineEditParamsSchema } from "./hashline";
import { type ApplyPatchParams, applyPatchSchema, expandApplyPatchToEntries } from "./modes/apply-patch";
import applyPatchGrammar from "./modes/apply-patch.lark" with { type: "text" };
import {
	executePatchSingle,
	type PatchEditEntry,
	type PatchParams,
	type PersistentEditMutation,
	type PersistentEditMutationExecutor,
	patchEditSchema,
} from "./modes/patch";
import { executeReplace, type ReplaceBatchParams, type ReplaceParams, replaceEditSchema } from "./modes/replace";
import { type EditToolDetails, type EditToolPerFileResult, getLspBatchRequest, type LspBatchRequest } from "./renderer";
import { pruneOversizedEditSnapshots } from "./snapshot-details";
import { EDIT_MODE_STRATEGIES } from "./streaming";

export * from "@oh-my-pi/hashline";
export { DEFAULT_EDIT_MODE, type EditMode, normalizeEditMode } from "../utils/edit-mode";
export * from "./apply-patch";
export * from "./diff";
export * from "./file-snapshot-store";
export * from "./hashline";
export * from "./modes/apply-patch";
export * from "./modes/patch";
export * from "./modes/replace";
export * from "./normalize";
export * from "./renderer";
export * from "./snapshot-details";
export * from "./streaming";

type TInput =
	| typeof replaceEditSchema
	| typeof patchEditSchema
	| typeof hashlineEditParamsSchema
	| typeof applyPatchSchema;

type HashlineParams = typeof hashlineEditParamsSchema.infer;

type EditParams = ReplaceParams | ReplaceBatchParams | PatchParams | HashlineParams | ApplyPatchParams;

export interface PersistentEditRouteV1 {
	readonly paths: PersistentWorkspacePathMapper;
	begin(signal?: AbortSignal): Promise<WorkspaceOperationLease>;
}

function preparePersistentEditPaths(
	route: PersistentEditRouteV1,
	mode: EditMode,
	params: EditParams,
	session: ToolSession,
): ReadonlyMap<string, PersistentModelWorkspacePath> {
	const authoredPaths: string[] = [];
	switch (mode) {
		case "replace":
			authoredPaths.push((params as ReplaceParams | ReplaceBatchParams).path);
			break;
		case "patch": {
			const patchParams = params as PatchParams;
			authoredPaths.push(patchParams.path);
			for (const edit of patchParams.edits) {
				if (edit.rename !== undefined) authoredPaths.push(edit.rename);
			}
			break;
		}
		case "apply_patch":
			for (const entry of expandApplyPatchToEntries(params as ApplyPatchParams)) {
				authoredPaths.push(entry.path);
				if (entry.rename !== undefined) authoredPaths.push(entry.rename);
			}
			break;
		case "hashline": {
			const patch = Patch.parse((params as HashlineParams).input, { cwd: session.cwd });
			if (patch.sections.length === 0) throw new ToolError("No hashline sections found in input.");
			for (const section of patch.sections) {
				authoredPaths.push(section.path);
				const fileOp = section.fileOp;
				if (fileOp?.kind === "move") authoredPaths.push(fileOp.dest);
			}
			break;
		}
		default: {
			const unsupportedMode: never = mode;
			throw new ToolError(`Unsupported persistent edit mode: ${unsupportedMode}`);
		}
	}

	const admitted = new Map<string, PersistentModelWorkspacePath>();
	for (const authoredPath of authoredPaths) {
		let modelPath: PersistentModelWorkspacePath;
		try {
			modelPath = route.paths.parse(authoredPath).modelPath;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new ToolError(`Persistent edit path '${authoredPath}' is outside ${route.paths.modelRoot}: ${message}`);
		}
		if (modelPath === route.paths.modelRoot) {
			throw new ToolError(`Persistent edits require file paths below ${route.paths.modelRoot}.`);
		}
		admitted.set(authoredPath, modelPath);
		admitted.set(modelPath, modelPath);
		let parentPath = path.posix.dirname(modelPath);
		while (parentPath === route.paths.modelRoot || parentPath.startsWith(`${route.paths.modelRoot}/`)) {
			admitted.set(parentPath, parentPath as PersistentModelWorkspacePath);
			if (parentPath === route.paths.modelRoot) break;
			parentPath = path.posix.dirname(parentPath);
		}
	}
	return admitted;
}

class PersistentEditOperation implements PersistentEditMutationExecutor {
	readonly modelRoot: string;
	#ordinal = 0;
	#plan: PersistentEditMutation[] = [];
	#next = 0;

	constructor(
		private readonly lease: WorkspaceOperationLease,
		private readonly paths: PersistentWorkspacePathMapper,
		private readonly admittedPaths: ReadonlyMap<string, PersistentModelWorkspacePath>,
	) {
		this.modelRoot = paths.modelRoot;
	}

	modelPath(input: string): string {
		const modelPath = this.admittedPaths.get(input);
		if (!modelPath) throw new ToolError(`Persistent edit attempted to use an unadmitted path: ${input}`);
		return modelPath;
	}

	#access() {
		const { binding, operationLeaseId } = this.lease;
		return {
			operationLeaseId,
			workspaceId: binding.lease.replica.workspaceId,
			expectedGeneration: binding.lease.baseGeneration,
			replicaId: binding.lease.replica.replicaId,
			leaseId: binding.lease.leaseId,
			fence: binding.fence,
		};
	}

	async freeze(mutations: readonly PersistentEditMutation[]): Promise<void> {
		if (this.#next !== this.#plan.length) {
			throw new ToolError("Persistent edit mutation plan changed before completion.");
		}
		for (const mutation of mutations) {
			switch (mutation.operation) {
				case "write_text":
					this.modelPath(mutation.path);
					break;
				case "mkdir":
					this.modelPath(mutation.path);
					if (!mutation.recursive) throw new ToolError("Persistent edit mkdir must be recursive.");
					break;
				case "remove":
					this.modelPath(mutation.path);
					if (mutation.recursive) throw new ToolError("Persistent edit remove must target one file.");
					break;
				case "rename":
					this.modelPath(mutation.from);
					this.modelPath(mutation.to);
					break;
				default: {
					const unsupportedMutation: never = mutation;
					throw new ToolError(`Unsupported persistent edit mutation: ${String(unsupportedMutation)}`);
				}
			}
		}
		this.#plan.push(...mutations);
	}

	#take(): PersistentEditMutation {
		const mutation = this.#plan[this.#next++];
		if (!mutation) throw new ToolError("Persistent edit attempted a mutation outside its frozen plan.");
		return mutation;
	}

	async #identity(operation: string, tuple: readonly (string | number | boolean)[]) {
		const access = this.#access();
		const requestId = await deriveProviderSubrequestId({
			workspaceId: access.workspaceId,
			parentKind: "workspace_operation",
			parentId: access.operationLeaseId,
			ordinal: this.#ordinal++,
			operation,
		});
		const requestSha256 = await canonicalRuntimeSha256([
			"omp-runtime-request-v1",
			operation,
			access.operationLeaseId,
			access.workspaceId,
			access.expectedGeneration,
			access.replicaId,
			access.leaseId,
			access.fence.fenceId,
			...tuple,
		]);
		return { requestId, requestSha256 };
	}

	async read(input: string): Promise<string> {
		const modelPath = this.modelPath(input) as PersistentModelWorkspacePath;
		const result = await this.lease.binding.bridge.readTextFile({
			...this.#access(),
			path: modelPath,
			line: null,
			limit: null,
			byteLimit: 2_097_152,
		});
		const returnedPath = this.paths.parseReturnedModelPath(result.path).modelPath;
		const contentSha256 = new Bun.SHA256().update(result.content).digest("hex");
		if (
			returnedPath !== modelPath ||
			result.sha256 !== contentSha256 ||
			result.byteLength !== Buffer.byteLength(result.content, "utf8")
		) {
			throw new ToolError("Persistent runtime returned an invalid text read result.");
		}
		return result.content;
	}

	async readBinary(input: string): Promise<Uint8Array> {
		const modelPath = this.modelPath(input) as PersistentModelWorkspacePath;
		const result = await this.lease.binding.bridge.readBinaryFile({
			...this.#access(),
			path: modelPath,
			offset: 0,
			byteLimit: 2_097_152,
		});
		const returnedPath = this.paths.parseReturnedModelPath(result.path).modelPath;
		const bytes = Buffer.from(result.contentBase64, "base64");
		if (
			returnedPath !== modelPath ||
			result.truncated ||
			result.byteLength !== bytes.byteLength ||
			result.sha256 !== new Bun.SHA256().update(bytes).digest("hex")
		) {
			throw new ToolError("Persistent runtime returned an invalid binary read result.");
		}
		return bytes;
	}

	async exists(input: string): Promise<boolean> {
		return this.lease.binding.bridge.exists({
			...this.#access(),
			path: this.modelPath(input) as PersistentModelWorkspacePath,
		});
	}

	async #stat(input: string) {
		const modelPath = this.modelPath(input) as PersistentModelWorkspacePath;
		const result = await this.lease.binding.bridge.stat({ ...this.#access(), path: modelPath });
		if (this.paths.parseReturnedModelPath(result.path).modelPath !== modelPath) {
			throw new ToolError("Persistent runtime returned an invalid stat result.");
		}
		return result;
	}

	async write(input: string, content: string): Promise<void> {
		const mutation = this.#take();
		switch (mutation.operation) {
			case "write_text": {
				if (mutation.path !== input || mutation.content !== content) {
					throw new ToolError("Persistent edit write diverged from its frozen plan.");
				}
				const modelPath = this.modelPath(input) as PersistentModelWorkspacePath;
				const contentSha256 = new Bun.SHA256().update(content).digest("hex");
				const byteLength = Buffer.byteLength(content, "utf8");
				const identity = await this.#identity("write_text", [modelPath, contentSha256, byteLength]);
				const result = await this.lease.binding.bridge.writeTextFile({
					...this.#access(),
					...identity,
					path: modelPath,
					content,
					contentSha256,
				});
				if (
					(result.status !== "written" && result.status !== "already_written") ||
					result.path !== modelPath ||
					result.sha256 !== contentSha256 ||
					result.byteLength !== byteLength
				) {
					throw new ToolError("Persistent runtime returned an invalid write result.");
				}
				if ((await this.read(modelPath)) !== content) {
					throw new ToolError("Persistent edit write verification failed.");
				}
				return;
			}
			case "mkdir":
			case "remove":
			case "rename":
				break;
			default: {
				const unsupportedMutation: never = mutation;
				throw new ToolError(`Unsupported persistent edit mutation: ${String(unsupportedMutation)}`);
			}
		}
		throw new ToolError("Persistent edit attempted a write outside its frozen plan.");
	}

	async mkdir(input: string): Promise<void> {
		const mutation = this.#take();
		switch (mutation.operation) {
			case "mkdir": {
				if (mutation.path !== input || !mutation.recursive) {
					throw new ToolError("Persistent edit mkdir diverged from its frozen plan.");
				}
				const modelPath = this.modelPath(input) as PersistentModelWorkspacePath;
				const result = await this.lease.binding.bridge.mkdir({
					...this.#access(),
					...(await this.#identity("mkdir", [modelPath, true])),
					path: modelPath,
					recursive: true,
				});
				if (result.status !== "created" && result.status !== "already_exists") {
					throw new ToolError("Persistent runtime returned an invalid mkdir result.");
				}
				if ((await this.#stat(modelPath)).kind !== "directory") {
					throw new ToolError("Persistent edit mkdir verification failed.");
				}
				return;
			}
			case "write_text":
			case "remove":
			case "rename":
				break;
			default: {
				const unsupportedMutation: never = mutation;
				throw new ToolError(`Unsupported persistent edit mutation: ${String(unsupportedMutation)}`);
			}
		}
		throw new ToolError("Persistent edit attempted a mkdir outside its frozen plan.");
	}

	async delete(input: string): Promise<void> {
		const mutation = this.#take();
		switch (mutation.operation) {
			case "remove": {
				if (mutation.path !== input || mutation.recursive) {
					throw new ToolError("Persistent edit remove diverged from its frozen plan.");
				}
				const modelPath = this.modelPath(input) as PersistentModelWorkspacePath;
				const result = await this.lease.binding.bridge.remove({
					...this.#access(),
					...(await this.#identity("remove", [modelPath, false])),
					path: modelPath,
					recursive: false,
				});
				if (result.status !== "removed" && result.status !== "already_absent") {
					throw new ToolError("Persistent runtime returned an invalid remove result.");
				}
				if (await this.exists(modelPath)) {
					throw new ToolError("Persistent edit remove verification failed.");
				}
				return;
			}
			case "write_text":
			case "mkdir":
			case "rename":
				break;
			default: {
				const unsupportedMutation: never = mutation;
				throw new ToolError(`Unsupported persistent edit mutation: ${String(unsupportedMutation)}`);
			}
		}
		throw new ToolError("Persistent edit attempted a remove outside its frozen plan.");
	}

	async rename(from: string, to: string): Promise<void> {
		const mutation = this.#take();
		switch (mutation.operation) {
			case "rename": {
				if (mutation.from !== from || mutation.to !== to) {
					throw new ToolError("Persistent edit rename diverged from its frozen plan.");
				}
				const source = this.modelPath(from) as PersistentModelWorkspacePath;
				const destination = this.modelPath(to) as PersistentModelWorkspacePath;
				const sourceStat = await this.#stat(source);
				const result = await this.lease.binding.bridge.rename({
					...this.#access(),
					...(await this.#identity("rename", [source, destination])),
					from: source,
					to: destination,
				});
				if (result.status !== "renamed" && result.status !== "already_renamed") {
					throw new ToolError("Persistent runtime returned an invalid rename result.");
				}
				const sourceStillExists = await this.exists(source);
				const destinationStat = await this.#stat(destination);
				if (
					sourceStillExists ||
					destinationStat.kind !== sourceStat.kind ||
					destinationStat.byteLength !== sourceStat.byteLength ||
					destinationStat.sha256 !== sourceStat.sha256
				) {
					throw new ToolError("Persistent edit rename verification failed.");
				}
				return;
			}
			case "write_text":
			case "mkdir":
			case "remove":
				break;
			default: {
				const unsupportedMutation: never = mutation;
				throw new ToolError(`Unsupported persistent edit mutation: ${String(unsupportedMutation)}`);
			}
		}
		throw new ToolError("Persistent edit attempted a rename outside its frozen plan.");
	}
}

type EditModeDefinition = {
	description: (session: ToolSession) => string;
	parameters: TInput;
	examples?: readonly ToolExample[];
	execute: (
		tool: EditTool,
		params: EditParams,
		signal: AbortSignal | undefined,
		batchRequest: LspBatchRequest | undefined,
		onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
		persistent?: PersistentEditMutationExecutor,
	) => Promise<AgentToolResult<EditToolDetails, TInput>>;
};

function resolveConfiguredEditMode(rawEditMode: string): EditMode | undefined {
	if (!rawEditMode || rawEditMode === "auto") {
		return undefined;
	}

	const editMode = normalizeEditMode(rawEditMode);
	if (!editMode) {
		throw new Error(`Invalid PI_EDIT_VARIANT: ${rawEditMode}`);
	}

	return editMode;
}

async function resolveEditPath(
	session: ToolSession,
	authoredPath: string,
	options: { mustExist: boolean; signal?: AbortSignal },
): Promise<string> {
	if (!options.mustExist || isInternalUrlPath(authoredPath)) return authoredPath;

	try {
		await Bun.file(resolvePlanPath(session, authoredPath)).stat();
		return authoredPath;
	} catch (error) {
		if (!isEnoent(error) && !isEnotdir(error)) throw error;
	}

	const match = await findUniqueWorkspaceSuffix(authoredPath, session.cwd, options.signal);
	return match?.displayPath ?? authoredPath;
}

function resolveAllowFuzzy(session: ToolSession, rawValue: string): boolean {
	switch (rawValue) {
		case "true":
		case "1":
			return true;
		case "false":
		case "0":
			return false;
		case "auto":
			return session.settings.get("edit.fuzzyMatch");
		default:
			throw new Error(`Invalid PI_EDIT_FUZZY: ${rawValue}`);
	}
}

function resolveFuzzyThreshold(session: ToolSession, rawValue: string): number {
	if (rawValue === "auto") {
		return session.settings.get("edit.fuzzyThreshold");
	}

	const threshold = Number.parseFloat(rawValue);
	if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
		throw new Error(`Invalid PI_EDIT_FUZZY_THRESHOLD: ${rawValue}`);
	}

	return threshold;
}

function createEditWritethrough(session: ToolSession): WritethroughCallback {
	const enableLsp = session.enableLsp ?? true;
	const enableDiagnostics = enableLsp && session.settings.get("lsp.diagnosticsOnEdit");
	const enableFormat = enableLsp && session.settings.get("lsp.formatOnWrite");
	const dedup = enableDiagnostics && session.settings.get("lsp.diagnosticsDeduplicate");
	return enableLsp
		? createLspWritethrough(session.cwd, {
				enableFormat,
				enableDiagnostics,
				transformDiagnostics: dedup
					? (path, result) => getDiagnosticsLedger(session).reduce(path, result)
					: undefined,
			})
		: writethroughNoop;
}

/** Run apply_patch file operations and aggregate their multi-file result. */
async function executeApplyPatchPerFile(
	fileEntries: {
		path: string;
		run: (batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>;
	}[],
	outerBatchRequest: LspBatchRequest | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (fileEntries.length === 1) {
		// Single file — just run directly, no wrapping
		return fileEntries[0].run(outerBatchRequest);
	}

	const perFileResults: EditToolPerFileResult[] = [];
	const contentTexts: string[] = [];
	let hasError = false;

	for (let i = 0; i < fileEntries.length; i++) {
		const { path, run } = fileEntries[i];
		const isLast = i === fileEntries.length - 1;
		// Per-file writes join the outer LSP write batch; only the last entry
		// flushes it, so cross-file writes coalesce into a single
		// format+diagnostics pass. The failure path below flushes explicitly
		// when the loop stops early.
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await run(batchRequest);
			const details = result.details;
			perFileResults.push({
				path: details?.path ?? path,
				diff: details?.diff ?? "",
				firstChangedLine: details?.firstChangedLine,
				diagnostics: details?.diagnostics,
				op: details?.op,
				move: details?.move,
				sourcePath: details?.sourcePath,
				meta: details?.meta,
				oldText: details?.oldText,
				newText: details?.newText,
				snapshotsPruned: details?.snapshotsPruned,
			});
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			const displayErrorText = err instanceof HashlineMismatchError ? err.displayMessage : undefined;
			perFileResults.push({ path, diff: "", isError: true, errorText, displayErrorText });
			contentTexts.push(`Error editing ${path}: ${errorText}`);
			hasError = true;
			// Later entries were authored assuming this file's post-state; a
			// partial cascade after failure typically compounds damage. Stop
			// here, report applied vs. skipped, and let the caller re-issue
			// only the failed and unapplied files. Matches
			// `executeSinglePathEntries` semantics.
			if (i > 0) {
				const appliedPaths = fileEntries
					.slice(0, i)
					.map(e => e.path)
					.join(", ");
				contentTexts.push(`Files already applied: ${appliedPaths}.`);
			}
			if (i + 1 < fileEntries.length) {
				const skippedPaths = fileEntries
					.slice(i + 1)
					.map(e => e.path)
					.join(", ");
				contentTexts.push(
					`Files NOT applied: ${skippedPaths}; re-read the affected files and re-issue only the failed and unapplied files.`,
				);
			}
			// Stopping early skips the last-entry flush above; finalize the
			// already-written files so an intervening failure cannot leave them
			// sitting in an unfinalized LSP write batch (mirrors the delete-path
			// flush in executePatchSingle).
			if (outerBatchRequest?.flush) {
				await flushLspWritethroughBatch(outerBatchRequest.id, cwd, signal);
			}
			break;
		}

		// Emit partial result after each file so UI shows progressive completion
		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: perFileResults
						.map(r => r.diff)
						.filter(Boolean)
						.join("\n"),
					firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
					perFileResults: [...perFileResults],
				},
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: pruneOversizedEditSnapshots({
			diff: perFileResults
				.map(r => r.diff)
				.filter(Boolean)
				.join("\n"),
			firstChangedLine: perFileResults.find(r => r.firstChangedLine)?.firstChangedLine,
			perFileResults,
		}),
		// Any per-file failure marks the aggregate result as an error so the
		// agent loop and renderer take the error branch instead of treating
		// a mixed partial application as a successful edit.
		...(hasError ? { isError: true } : {}),
	};
}

async function executeSinglePathEntries(
	path: string,
	runs: ((batchRequest: LspBatchRequest | undefined) => Promise<AgentToolResult<EditToolDetails>>)[],
	outerBatchRequest: LspBatchRequest | undefined,
	onUpdate: ((partialResult: AgentToolResult<EditToolDetails, TInput>) => void) | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<EditToolDetails, TInput>> {
	if (runs.length === 1) {
		return runs[0](outerBatchRequest);
	}

	const contentTexts: string[] = [];
	const diffTexts: string[] = [];
	let firstChangedLine: number | undefined;
	let hasError = false;
	let metadataPath: string | undefined;
	let hasFirstOldText = false;
	let firstOldText: string | undefined;
	let hasLastNewText = false;
	let lastNewText: string | undefined;
	// Any pruned child invalidates the aggregate snapshot: combining a kept
	// first-entry oldText with a pruned next entry's newText (or vice-versa)
	// would describe a transition the file never made. Suppress aggregate
	// snapshots and stamp the marker so ACP/downstream can degrade cleanly.
	let snapshotsPruned = false;

	for (let i = 0; i < runs.length; i++) {
		const isLast = i === runs.length - 1;
		const batchRequest: LspBatchRequest | undefined = outerBatchRequest
			? { id: outerBatchRequest.id, flush: isLast && outerBatchRequest.flush }
			: undefined;

		try {
			const result = await runs[i](batchRequest);
			const details = result.details;
			if (details?.diff) diffTexts.push(details.diff);
			firstChangedLine ??= details?.firstChangedLine;
			if (details?.path) {
				metadataPath ??= details.path;
			}
			if (details && "oldText" in details && !hasFirstOldText) {
				firstOldText = details.oldText;
				hasFirstOldText = true;
			}
			if (details && "newText" in details) {
				lastNewText = details.newText;
				hasLastNewText = true;
			}
			if (details?.snapshotsPruned) snapshotsPruned = true;
			const text = result.content?.find(c => c.type === "text")?.text ?? "";
			if (text) contentTexts.push(text);
		} catch (err) {
			const errorText = err instanceof Error ? err.message : String(err);
			contentTexts.push(`Error editing ${path} (entry ${i + 1} of ${runs.length}): ${errorText}`);
			if (i > 0) {
				contentTexts.push(i === 1 ? `Entry 1 was already applied.` : `Entries 1-${i} were already applied.`);
			}
			if (i + 1 < runs.length) {
				contentTexts.push(
					(i + 2 === runs.length
						? `Entry ${runs.length} was NOT applied`
						: `Entries ${i + 2}-${runs.length} were NOT applied`) +
						`; re-read the file and re-issue only the failed and unapplied entries.`,
				);
			}
			hasError = true;
			// Stop at the first failure: later entries were authored against
			// line numbers/content that assumed this entry succeeded, and
			// applying them after a failure compounds the damage.
			if (outerBatchRequest?.flush) {
				await flushLspWritethroughBatch(outerBatchRequest.id, cwd, signal);
			}
			break;
		}

		if (!isLast && onUpdate) {
			onUpdate({
				content: [{ type: "text", text: contentTexts.join("\n") }],
				details: {
					diff: diffTexts.join("\n"),
					firstChangedLine,
				},
				...(hasError ? { isError: true } : {}),
			});
		}
	}

	return {
		content: [{ type: "text", text: contentTexts.join("\n") }],
		details: pruneOversizedEditSnapshots({
			diff: diffTexts.join("\n"),
			firstChangedLine,
			path: metadataPath ?? path,
			...(snapshotsPruned
				? { snapshotsPruned: true as const }
				: {
						...(hasFirstOldText ? { oldText: firstOldText } : {}),
						...(hasLastNewText ? { newText: lastNewText } : {}),
					}),
		}),
		// Any per-entry failure marks the aggregate result as an error so the
		// renderer takes the error branch instead of falling through to the
		// streaming-edit preview (which displays the *proposed* diff and looks
		// indistinguishable from success).
		...(hasError ? { isError: true } : {}),
	};
}

function extractApprovalPath(args: unknown): string {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const input = typeof record.input === "string" ? record.input : undefined;
	if (input) {
		const hashlineMatch = /^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/m.exec(input);
		if (hashlineMatch?.[1]) return hashlineMatch[1];

		const applyPatchMatch = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(input);
		if (applyPatchMatch?.[1]) return applyPatchMatch[1].trim();
	}

	const targetPath = record.path;
	return typeof targetPath === "string" && targetPath.length > 0 ? targetPath : "(unknown)";
}

export class EditTool implements AgentTool<TInput> {
	readonly approval = (args: unknown) => {
		const targetPath = extractApprovalPath(args);
		return targetPath !== "(unknown)" && isInternalUrlPath(targetPath) ? "read" : "write";
	};
	readonly formatApprovalDetails = (args: unknown): string[] => [
		`File: ${truncateForPrompt(extractApprovalPath(args))}`,
	];
	readonly name = "edit";
	readonly label = "Edit";
	readonly loadMode = "essential";
	readonly concurrency = "exclusive";
	readonly strict = true;

	readonly #allowFuzzy: boolean;
	readonly #fuzzyThreshold: number;
	readonly #writethrough: WritethroughCallback;
	readonly #editMode?: EditMode;
	readonly #persistentRoute?: PersistentEditRouteV1;
	readonly #deferredDiagnostics: DeferredDiagnostics;

	/**
	 * `mode` pins the edit variant for this instance, for callers whose protocol
	 * fixes the shape of an edit. The Cursor `pi_edit` frame carries
	 * `old_string`/`new_string` args, which only `replace` accepts — under the
	 * default `hashline` mode those args do not match the schema at all. Left
	 * unset, the env/settings resolution applies as before.
	 */
	constructor(
		private readonly session: ToolSession,
		mode?: EditMode,
		persistentRoute?: PersistentEditRouteV1,
	) {
		this.#persistentRoute = persistentRoute;
		const {
			PI_EDIT_FUZZY: editFuzzy = "auto",
			PI_EDIT_FUZZY_THRESHOLD: editFuzzyThreshold = "auto",
			PI_EDIT_VARIANT: envEditVariant = "auto",
		} = Bun.env;

		this.#editMode = mode ?? resolveConfiguredEditMode(envEditVariant);
		this.#allowFuzzy = resolveAllowFuzzy(session, editFuzzy);
		this.#fuzzyThreshold = resolveFuzzyThreshold(session, editFuzzyThreshold);
		const deduplicateDiagnostics =
			(session.enableLsp ?? true) &&
			session.settings.get("lsp.diagnosticsOnEdit") &&
			session.settings.get("lsp.diagnosticsDeduplicate");
		this.#deferredDiagnostics = new DeferredDiagnostics(session, deduplicateDiagnostics);
		this.#writethrough = createEditWritethrough(session);
	}

	get mode(): EditMode {
		if (this.#editMode) return this.#editMode;
		return resolveEditMode(this.session);
	}

	get description(): string {
		return this.#getModeDefinition().description(this.session);
	}

	get parameters(): TInput {
		return this.#getModeDefinition().parameters;
	}

	get examples(): readonly ToolExample[] | undefined {
		return this.#getModeDefinition().examples;
	}

	/**
	 * When in `apply_patch` mode, expose the Codex Lark grammar so providers
	 * that support OpenAI-style custom tools can emit a grammar-constrained
	 * variant. Providers that don't support custom tools ignore this field
	 * and fall back to emitting a JSON function tool from `parameters`.
	 */
	get customFormat(): { syntax: "lark"; definition: string } | undefined {
		if (this.mode === "apply_patch") return { syntax: "lark", definition: applyPatchGrammar };
		if (this.mode === "hashline") return { syntax: "lark", definition: hashlineGrammar };
		return undefined;
	}

	/**
	 * Wire-level tool name used when the custom-tool variant is active. GPT-5+
	 * is trained on the literal name `apply_patch`; internally this is just a
	 * mode of the `edit` tool. The agent-loop dispatcher matches both the
	 * internal `name` and `customWireName`, so returned calls route correctly.
	 */
	get customWireName(): string | undefined {
		if (this.mode !== "apply_patch") return undefined;
		return "apply_patch";
	}

	/**
	 * Normalize streamed args into the source text this edit introduces, so
	 * stream matchers (TTSR rules) run against real file content instead of the
	 * mode-specific patch grammar.
	 */
	matcherDigest(args: unknown): string | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherDigest(args);
	}

	/**
	 * Project the streamed args onto their target file paths so path-scoped
	 * stream matchers (e.g. TTSR `tool:edit(*.ts)` globs) match hashline and
	 * apply_patch edits even though the path lives in the wire payload (a
	 * section header / envelope marker) rather than a top-level argument.
	 */
	matcherPaths(args: unknown): readonly string[] | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherPaths(args);
	}

	/**
	 * Per-file projection of the streamed args, splitting multi-section
	 * hashline / multi-hunk apply_patch payloads into one (path, digest) entry
	 * per touched file. Path-scoped stream matchers (TTSR) then evaluate each
	 * file in isolation, so a `tool:edit(*.ts)` rule never fires on text that
	 * actually belongs to a sibling Markdown hunk.
	 */
	matcherEntries(args: unknown): readonly { path: string; digest: string }[] | undefined {
		return EDIT_MODE_STRATEGIES[this.mode].matcherEntries(args);
	}

	async execute(
		_toolCallId: string,
		params: EditParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<EditToolDetails, TInput>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<EditToolDetails, TInput>> {
		const modeDefinition = this.#getModeDefinition();
		if (!this.#persistentRoute) {
			return modeDefinition.execute(this, params, signal, getLspBatchRequest(context?.toolCall), onUpdate);
		}
		const admittedPaths = preparePersistentEditPaths(this.#persistentRoute, this.mode, params, this.session);
		const lease = await this.#persistentRoute.begin(signal);
		try {
			const operation = new PersistentEditOperation(lease, this.#persistentRoute.paths, admittedPaths);
			return await modeDefinition.execute(this, params, signal, undefined, onUpdate, operation);
		} finally {
			lease.end();
		}
	}

	#getModeDefinition(): EditModeDefinition {
		return {
			patch: {
				description: () => prompt.render(patchDescription),
				parameters: patchEditSchema,
				examples: [
					{
						caption: "Create",
						call: { path: "hello.txt", edits: [{ op: "create", diff: "Hello\n" }] },
					},
					{
						caption: "Update",
						call: {
							path: "src/app.py",
							edits: [
								{
									op: "update",
									diff: "@@ def greet():\n def greet():\n-print('Hi')\n+print('Hello')\n",
								},
							],
						},
					},
					{
						caption: "Rename",
						call: {
							path: "src/app.py",
							edits: [{ op: "update", rename: "src/main.py", diff: "@@\n …\n" }],
						},
					},
					{
						caption: "Delete",
						call: { path: "obsolete.txt", edits: [{ op: "delete" }] },
					},
					{
						caption: "Multiple entries",
						note: "All entries in one call apply to the top-level `path`; use separate calls for different files.",
					},
				] satisfies readonly ToolExample<PatchParams>[],
				execute: async (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
					persistent?: PersistentEditMutationExecutor,
				) => {
					const { edits, path } = params as PatchParams;
					const targetPath = persistent
						? path
						: await resolveEditPath(tool.session, path, {
								mustExist: (edits[0]?.op ?? "update") !== "create",
								signal,
							});
					const runs = (edits as PatchEditEntry[]).map(
						entry => (br: LspBatchRequest | undefined) =>
							executePatchSingle({
								session: tool.session,
								path: targetPath,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								// The JSON grammar has no `*** Update File`; its `op: "create"`
								// doubles as the documented full-file overwrite (patch.md <avoid>).
								allowCreateOverwrite: true,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
								persistent,
							}),
					);
					return executeSinglePathEntries(targetPath, runs, batchRequest, onUpdate, tool.session.cwd, signal);
				},
			},
			apply_patch: {
				description: () => prompt.render(applyPatchDescription),
				parameters: applyPatchSchema,
				examples: [
					{
						caption: "Apply a combined patch file",
						call: {
							input: '*** Begin Patch\n*** Add File: hello.txt\n+Hello world\n*** Update File: src/app.py\n*** Move to: src/main.py\n@@ def greet():\n-print("Hi")\n+print("Hello, world!")\n*** Delete File: obsolete.txt\n*** End Patch\n',
						},
					},
				] satisfies readonly ToolExample<ApplyPatchParams>[],
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
					persistent?: PersistentEditMutationExecutor,
				) => {
					const entries = expandApplyPatchToEntries(params as ApplyPatchParams);
					// Resolve each authored path once per patch so paired hunks (e.g. delete
					// then re-add of the same file) share the same workspace target.
					const resolvedTargets = new Map<string, Promise<string>>();
					const resolveOnce = (path: string, mustExist: boolean): Promise<string> => {
						let pending = resolvedTargets.get(path);
						if (!pending) {
							pending = persistent
								? Promise.resolve(path)
								: resolveEditPath(tool.session, path, { mustExist, signal });
							resolvedTargets.set(path, pending);
						}
						return pending;
					};
					const perFile = entries.map(entry => {
						const { path, ...patchParams } = entry;
						return {
							path,
							run: async (br: LspBatchRequest | undefined) => {
								const targetPath = await resolveOnce(path, patchParams.op !== "create");
								return executePatchSingle({
									session: tool.session,
									path: targetPath,
									params: patchParams,
									signal,
									batchRequest: br,
									allowFuzzy: tool.#allowFuzzy,
									fuzzyThreshold: tool.#fuzzyThreshold,
									writethrough: tool.#writethrough,
									beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
									persistent,
								});
							},
						};
					});
					return executeApplyPatchPerFile(perFile, batchRequest, tool.session.cwd, signal, onUpdate);
				},
			},
			hashline: {
				description: () => prompt.render(hashlineDescription),
				parameters: hashlineEditParamsSchema,
				execute: (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					_onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
					persistent?: PersistentEditMutationExecutor,
				) => {
					const { input } = params as HashlineParams;
					return executeHashlineSingle({
						session: tool.session,
						input,
						signal,
						batchRequest,
						writethrough: tool.#writethrough,
						beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
						persistent,
					});
				},
			},
			replace: {
				description: () => prompt.render(replaceDescription),
				parameters: replaceEditSchema,
				execute: async (
					tool: EditTool,
					params: EditParams,
					signal: AbortSignal | undefined,
					batchRequest: LspBatchRequest | undefined,
					onUpdate?: (partialResult: AgentToolResult<EditToolDetails, TInput>) => void,
					persistent?: PersistentEditMutationExecutor,
				) => {
					// `edits` is the internal `ReplaceBatchParams` form only the Cursor
					// exec bridge produces (multi-replacement `pi_edit` frames run as one
					// lifecycle); model calls always arrive in the single-edit schema shape.
					const replaceParams = params as ReplaceParams | ReplaceBatchParams;
					const entries =
						"edits" in replaceParams
							? replaceParams.edits
							: [
									{
										old_string: replaceParams.old_string,
										new_string: replaceParams.new_string,
										replace_all: replaceParams.replace_all,
									},
								];
					const targetPath = persistent
						? replaceParams.path
						: await resolveEditPath(tool.session, replaceParams.path, { mustExist: true, signal });
					const runs = entries.map(
						entry => (br: LspBatchRequest | undefined) =>
							executeReplace({
								session: tool.session,
								path: targetPath,
								params: entry,
								signal,
								batchRequest: br,
								allowFuzzy: tool.#allowFuzzy,
								fuzzyThreshold: tool.#fuzzyThreshold,
								writethrough: tool.#writethrough,
								beginDeferredDiagnosticsForPath: p => tool.#deferredDiagnostics.begin(p),
								persistent,
							}),
					);
					return executeSinglePathEntries(targetPath, runs, batchRequest, onUpdate, tool.session.cwd, signal);
				},
			},
		}[this.mode];
	}
}
