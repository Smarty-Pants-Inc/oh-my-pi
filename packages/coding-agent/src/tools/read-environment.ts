import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { parseArchivePathCandidates } from "@oh-my-pi/pi-utils/ar";
import { getFileSnapshotStore, parseSeenLinesFromHashlineBody } from "../edit/file-snapshot-store";
import { normalizeToLF } from "../edit/normalize";
import type { ToolSession } from "../sdk";
import { type ExecutionEnvironmentBinding, mapExecutionEnvironmentPath } from "../session/execution-environment";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { CONVERTIBLE_EXTENSIONS } from "../utils/markit";
import { splitPathAndSel } from "./path-utils";
import type { ReadToolDetails } from "./read";
import {
	buildInMemoryMultiRangeResult,
	buildInMemoryTextResult,
	countTextLines,
	formatSummaryElisionFooter,
	type HashlineHeaderContext,
	hashlineHeaderContext,
	markMarkdownContentType,
	prependHashlineHeader,
} from "./read-format";
import { isMultiRange, isRawSelector, parseSel, selToOffsetLimit } from "./read-selector";
import { isProseSummaryPath, renderSummary, trySummarizeText } from "./read-summary";
import { parseSqlitePathCandidates } from "./sqlite-reader";
import { ToolAbortError, ToolError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";

export async function readEnvironmentFile(
	session: ToolSession,
	readPath: string,
	environment: ExecutionEnvironmentBinding,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	const target = splitPathAndSel(readPath);
	const parsed = parseSel(target.sel);
	if (target.path.length === 0 || target.path === "." || target.path.endsWith("/")) {
		throw new ToolError("Environment reads support regular UTF-8 files only; directories are unsupported.");
	}
	if (parsed.kind === "conflicts") {
		throw new ToolError("The :conflicts selector is unsupported for environment reads.");
	}
	if (parseArchivePathCandidates(readPath).length > 0) {
		throw new ToolError("Archive paths and archive member selectors are unsupported for environment reads.");
	}
	if (parseSqlitePathCandidates(readPath).length > 0) {
		throw new ToolError("Database paths and selectors are unsupported for environment reads.");
	}
	if (CONVERTIBLE_EXTENSIONS.has(path.extname(target.path).toLowerCase())) {
		throw new ToolError("Binary document conversion is unsupported for environment reads.");
	}

	let remotePath: string;
	try {
		remotePath = mapExecutionEnvironmentPath(environment, target.path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(`Environment read path '${target.path}' is outside the workspace: ${message}`);
	}
	if (remotePath === environment.remoteRoot) {
		throw new ToolError("Environment reads support regular UTF-8 files only; directories are unsupported.");
	}

	let text: string;
	try {
		throwIfAborted(signal);
		text = await environment.bridge.readTextFile({ path: remotePath });
		throwIfAborted(signal);
	} catch (error) {
		if (error instanceof ToolAbortError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new ToolError(
			`Environment read failed for '${remotePath}': only regular UTF-8 files are supported; directories, symlinks, and binary files are rejected by the provider. ${message}`,
		);
	}

	const details = markMarkdownContentType(
		session,
		{ resolvedPath: remotePath, fileSize: Buffer.byteLength(text, "utf-8") },
		remotePath,
	);
	if (
		parsed.kind === "none" &&
		session.settings.get("read.summarize.enabled") &&
		(session.settings.get("read.summarize.prose") || !isProseSummaryPath(remotePath))
	) {
		const summary = trySummarizeText(session, text, remotePath, signal);
		if (summary?.parsed && summary.elided) {
			const renderedSummary = renderSummary(session, summary);
			const footer = formatSummaryElisionFooter(
				remotePath,
				renderedSummary.elidedRanges,
				renderedSummary.elidedLines,
			);
			let summaryHashContext: HashlineHeaderContext | undefined;
			if (resolveFileDisplayMode(session).hashLines) {
				const tag = getFileSnapshotStore(session).record(remotePath, normalizeToLF(text));
				summaryHashContext = hashlineHeaderContext(remotePath, tag);
			}
			const bodyText = footer ? `${renderedSummary.text}\n\n${footer}` : renderedSummary.text;
			const modelText = prependHashlineHeader(bodyText, summaryHashContext);
			if (summaryHashContext?.tag) {
				getFileSnapshotStore(session).recordSeenLines(
					remotePath,
					summaryHashContext.tag,
					parseSeenLinesFromHashlineBody(renderedSummary.text),
				);
			}
			return toolResult<ReadToolDetails>({
				...details,
				displayContent: { text: renderedSummary.displayText, startLine: 1 },
				summary: {
					lines: countTextLines(renderedSummary.text),
					elidedSpans: renderedSummary.elidedRanges.length,
					elidedLines: renderedSummary.elidedLines,
				},
			})
				.text(modelText)
				.sourcePath(remotePath)
				.done();
		}
	}

	if (isMultiRange(parsed) && parsed.kind === "lines") {
		return buildInMemoryMultiRangeResult(session, text, parsed.ranges, {
			details,
			sourcePath: remotePath,
			entityLabel: "file",
			raw: isRawSelector(parsed),
			environment: true,
		});
	}
	const { offset, limit } = selToOffsetLimit(parsed);
	return buildInMemoryTextResult(session, text, offset, limit, {
		details,
		sourcePath: remotePath,
		entityLabel: "file",
		raw: isRawSelector(parsed),
		environment: true,
	});
}
