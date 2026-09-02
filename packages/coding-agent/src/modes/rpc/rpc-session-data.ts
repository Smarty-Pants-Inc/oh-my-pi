import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { parseSkillInvocation } from "../../extensibility/skills";
import type { AgentSession } from "../../session/agent-session";
import { BLOB_HASH_RE } from "../../session/blob-store";
import {
	getRpcHistoryChunk,
	getRpcHistoryDigest,
	getRpcHistoryPage,
	getRpcHistorySnapshot,
	RpcHistoryError,
} from "./rpc-history";
import type { RpcCommand, RpcMutationCommand, RpcResponse } from "./rpc-types";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_LIST_RESULTS = 4096;
const MAX_CUSTOM_MESSAGE_BYTES = 1024 * 1024;
const MAX_CUSTOM_DETAILS_BYTES = 64 * 1024;
const MAX_CUSTOM_CONTENT_BLOCKS = 64;
const MAX_TOOL_NAME_BYTES = 128;
const MAX_ARTIFACT_TOOL_TYPE_BYTES = 64;
const MAX_CUSTOM_TYPE_BYTES = 128;
const ARTIFACT_ID_RE = /^(0|[1-9][0-9]*)$/;
const ARTIFACT_TOOL_TYPE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface RpcArtifactInfo {
	id: string;
	filename: string;
	size: number;
}

export interface RpcArtifactListResult {
	artifacts: RpcArtifactInfo[];
}

export interface RpcArtifactReadResult {
	id: string;
	content: string;
	size: number;
}

export interface RpcArtifactWriteResult {
	id: string;
	size: number;
}

export interface RpcBlobInfo {
	hash: string;
	size: number;
}

export interface RpcBlobListResult {
	blobs: RpcBlobInfo[];
}

export interface RpcBlobReadResult {
	hash: string;
	size: number;
	encoding: "base64";
	content: string;
}

export interface RpcBlobWriteResult {
	hash: string;
	size: number;
}

export type RpcCustomMessageContent = string | Array<TextContent | ImageContent>;

export interface RpcCustomMessagePayload {
	customType: string;
	content: RpcCustomMessageContent;
	display: boolean;
	details?: unknown;
	when?: "idle" | "any";
}

export interface RpcCustomMessageResult {
	accepted: true;
}

const RPC_DURABLE_ONLY_MUTATIONS: Partial<Record<RpcMutationCommand["type"], true>> = {
	artifact_write: true,
	blob_write: true,
	custom_message: true,
};

function success(command: RpcCommand, data?: unknown): RpcResponse {
	return { id: command.id, type: "response", command: command.type, success: true, data } as RpcResponse;
}

function failure(command: RpcCommand, error: string, code: string): RpcResponse {
	return { id: command.id, type: "response", command: command.type, success: false, error, code };
}

function isWellFormedString(value: string): boolean {
	return value.isWellFormed();
}

function hasCanonicalArtifactId(value: unknown): value is string {
	if (typeof value !== "string" || !ARTIFACT_ID_RE.test(value)) return false;
	const numeric = Number(value);
	return Number.isSafeInteger(numeric) && numeric >= 0;
}

function validateJsonValue(value: unknown, maximumBytes: number, label: string): string | undefined {
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) return `${label} must be JSON-serializable`;
		if (Buffer.byteLength(serialized, "utf8") > maximumBytes) return `${label} exceeds ${maximumBytes} bytes`;
		return undefined;
	} catch {
		return `${label} must be JSON-serializable`;
	}
}

function validateCustomContent(content: unknown): string | undefined {
	if (typeof content === "string") {
		if (!isWellFormedString(content)) return "Custom message content contains malformed Unicode";
		if (Buffer.byteLength(content, "utf8") > MAX_CUSTOM_MESSAGE_BYTES) {
			return `Custom message content exceeds ${MAX_CUSTOM_MESSAGE_BYTES} bytes`;
		}
		return undefined;
	}
	if (!Array.isArray(content) || content.length > MAX_CUSTOM_CONTENT_BLOCKS) {
		return `Custom message content must be text or at most ${MAX_CUSTOM_CONTENT_BLOCKS} text/image blocks`;
	}
	for (const block of content) {
		if (!isRecord(block) || (block.type !== "text" && block.type !== "image")) {
			return "Custom message content contains an invalid block";
		}
		if (block.type === "text") {
			if (typeof block.text !== "string" || !isWellFormedString(block.text)) {
				return "Custom message text contains malformed Unicode";
			}
			if (block.textSignature !== undefined && typeof block.textSignature !== "string") {
				return "Custom message textSignature must be a string";
			}
		} else if (
			typeof block.data !== "string" ||
			typeof block.mimeType !== "string" ||
			(block.detail !== undefined &&
				block.detail !== "auto" &&
				block.detail !== "low" &&
				block.detail !== "high" &&
				block.detail !== "original")
		) {
			return "Custom message image block is invalid";
		}
	}
	return validateJsonValue(content, MAX_CUSTOM_MESSAGE_BYTES, "Custom message content");
}

function decodeBlobWrite(command: Extract<RpcCommand, { type: "blob_write" }>): Buffer | string {
	if (typeof command.hash !== "string" || !BLOB_HASH_RE.test(command.hash)) {
		return "Blob hash must be exactly 64 lowercase hexadecimal characters";
	}
	if (!Number.isSafeInteger(command.size) || command.size < 0 || command.size > MAX_BLOB_BYTES) {
		return `Blob size must be an integer between 0 and ${MAX_BLOB_BYTES}`;
	}
	if (
		typeof command.content !== "string" ||
		command.content.length > Math.ceil(MAX_BLOB_BYTES / 3) * 4 ||
		!BASE64_RE.test(command.content)
	) {
		return "Blob content must be canonical base64 within the configured bound";
	}
	const data = Buffer.from(command.content, "base64");
	if (data.toString("base64") !== command.content) return "Blob content must use canonical padded base64";
	if (data.byteLength !== command.size) return "Blob size does not match decoded content";
	const hash = new Bun.SHA256().update(data).digest("hex");
	if (hash !== command.hash) return "Blob hash does not match decoded content";
	return data;
}

function validateCustomMessage(command: Extract<RpcCommand, { type: "custom_message" }>): string | undefined {
	if (
		typeof command.customType !== "string" ||
		command.customType.length === 0 ||
		Buffer.byteLength(command.customType, "utf8") > MAX_CUSTOM_TYPE_BYTES ||
		!isWellFormedString(command.customType)
	) {
		return `customType must be non-empty, well-formed Unicode within ${MAX_CUSTOM_TYPE_BYTES} bytes`;
	}
	if (typeof command.display !== "boolean") return "Custom message display must be a boolean";
	if (command.when !== undefined && command.when !== "idle" && command.when !== "any") {
		return 'Custom message when must be "idle" or "any"';
	}
	const contentError = validateCustomContent(command.content);
	if (contentError) return contentError;
	if (command.details !== undefined) {
		return validateJsonValue(command.details, MAX_CUSTOM_DETAILS_BYTES, "Custom message details");
	}
	return undefined;
}

export function validateRpcMutationBeforeIntent(
	session: AgentSession,
	command: RpcMutationCommand,
): RpcResponse | undefined {
	if (RPC_DURABLE_ONLY_MUTATIONS[command.type] && !command.mutation) {
		return failure(command, `${command.type} requires mutation provenance`, "protocol-error");
	}
	switch (command.type) {
		case "prompt": {
			if (command.toolChoice === undefined) return undefined;
			if (!command.mutation) {
				return failure(command, "Prompt toolChoice requires mutation provenance", "protocol-error");
			}
			if (
				typeof command.toolChoice !== "string" ||
				command.toolChoice.length === 0 ||
				Buffer.byteLength(command.toolChoice, "utf8") > MAX_TOOL_NAME_BYTES ||
				!isWellFormedString(command.toolChoice)
			) {
				return failure(command, "Prompt toolChoice must be a bounded exact tool name", "protocol-error");
			}
			if (!session.getActiveToolNames().includes(command.toolChoice)) {
				return failure(command, `Tool "${command.toolChoice}" is not currently active`, "not-found");
			}
			try {
				session.resolveNamedToolChoice(command.toolChoice);
			} catch (error) {
				return failure(command, error instanceof Error ? error.message : String(error), "protocol-error");
			}
			const trimmedMessage = command.message.trimStart();
			if (trimmedMessage.startsWith("/")) {
				const skillInvocation = parseSkillInvocation(command.message);
				const knownSkill =
					session.skillsSettings?.enableSkillCommands === true &&
					skillInvocation !== undefined &&
					session.skills.some(skill => skill.name === skillInvocation.name);
				if (!knownSkill) {
					return failure(
						command,
						"Prompt toolChoice cannot be combined with a builtin or unresolved slash command",
						"protocol-error",
					);
				}
			}
			return undefined;
		}
		case "fork":
			if (command.entryId === undefined) return undefined;
			if (!command.mutation) {
				return failure(command, "Fork entryId requires mutation provenance", "protocol-error");
			}
			if (
				typeof command.entryId !== "string" ||
				command.entryId.length === 0 ||
				Buffer.byteLength(command.entryId, "utf8") > 256 ||
				!isWellFormedString(command.entryId)
			) {
				return failure(command, "Fork entryId must be a bounded canonical entry reference", "protocol-error");
			}
			if (!session.sessionManager.getEntry(command.entryId)) {
				return failure(command, `Session entry ${command.entryId} was not found`, "not-found");
			}
			return undefined;
		case "artifact_write": {
			if (typeof command.content !== "string" || !isWellFormedString(command.content)) {
				return failure(command, "Artifact content must be well-formed Unicode text", "protocol-error");
			}
			if (Buffer.byteLength(command.content, "utf8") > MAX_ARTIFACT_BYTES) {
				return failure(command, `Artifact content exceeds ${MAX_ARTIFACT_BYTES} bytes`, "protocol-error");
			}
			if (
				command.toolType !== undefined &&
				(typeof command.toolType !== "string" ||
					!ARTIFACT_TOOL_TYPE_RE.test(command.toolType) ||
					Buffer.byteLength(command.toolType, "utf8") > MAX_ARTIFACT_TOOL_TYPE_BYTES)
			) {
				return failure(command, "Artifact toolType is not a canonical bounded name", "protocol-error");
			}
			return undefined;
		}
		case "blob_write": {
			const decoded = decodeBlobWrite(command);
			return typeof decoded === "string" ? failure(command, decoded, "protocol-error") : undefined;
		}
		case "custom_message": {
			const error = validateCustomMessage(command);
			return error ? failure(command, error, "protocol-error") : undefined;
		}
		default:
			return undefined;
	}
}

async function listArtifacts(session: AgentSession): Promise<RpcArtifactListResult> {
	const manager = session.sessionManager.getArtifactManager();
	if (!manager) throw new Error("ArtifactManager is unavailable for this session");
	const files = (await manager.listFiles()).sort((left, right) => left.localeCompare(right, "en"));
	const artifacts: RpcArtifactInfo[] = [];
	for (const filename of files) {
		const id = filename.split(".", 1)[0];
		if (!hasCanonicalArtifactId(id)) continue;
		const artifactPath = await manager.getPath(id);
		if (!artifactPath) continue;
		if (path.basename(artifactPath) !== filename) continue;
		const stat = await fs.lstat(artifactPath);
		if (!stat.isFile()) continue;
		artifacts.push({ id, filename, size: stat.size });
		if (artifacts.length > MAX_LIST_RESULTS) throw new Error(`Artifact list exceeds ${MAX_LIST_RESULTS} entries`);
	}
	artifacts.sort((left, right) => Number(left.id) - Number(right.id));
	return { artifacts };
}

async function readArtifact(
	session: AgentSession,
	command: Extract<RpcCommand, { type: "artifact_read" }>,
): Promise<RpcArtifactReadResult> {
	if (!hasCanonicalArtifactId(command.artifactId))
		throw new RpcSessionDataError("Invalid artifact ID", "protocol-error");
	const manager = session.sessionManager.getArtifactManager();
	if (!manager) throw new RpcSessionDataError("ArtifactManager is unavailable for this session", "unavailable");
	const artifactPath = await manager.getPath(command.artifactId);
	if (!artifactPath) throw new RpcSessionDataError(`Artifact ${command.artifactId} was not found`, "not-found");
	if (!path.basename(artifactPath).startsWith(`${command.artifactId}.`)) {
		throw new RpcSessionDataError("Artifact path did not match its canonical ID", "protocol-error");
	}
	let stat: Stats;
	try {
		stat = await fs.lstat(artifactPath);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			throw new RpcSessionDataError(`Artifact ${command.artifactId} was not found`, "not-found");
		}
		throw error;
	}
	if (!stat.isFile()) throw new RpcSessionDataError("Artifact path is not a regular file", "protocol-error");
	if (stat.size > MAX_ARTIFACT_BYTES) {
		throw new RpcSessionDataError(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`, "artifact_too_large");
	}
	const bytes = await fs.readFile(artifactPath);
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new RpcSessionDataError("Artifact is not valid UTF-8 text", "protocol-error");
	}
	return { id: command.artifactId, content, size: bytes.byteLength };
}

async function writeArtifact(
	session: AgentSession,
	command: Extract<RpcCommand, { type: "artifact_write" }>,
): Promise<RpcArtifactWriteResult> {
	await session.sessionManager.ensureOnDisk();
	const manager = session.sessionManager.getArtifactManager();
	if (!manager) throw new Error("ArtifactManager is unavailable for this session");
	const id = await manager.save(command.content, command.toolType ?? "rpc");
	return { id, size: Buffer.byteLength(command.content, "utf8") };
}

async function listBlobs(session: AgentSession): Promise<RpcBlobListResult> {
	const blobs = await session.sessionManager.getBlobStore().list();
	if (blobs.length > MAX_LIST_RESULTS) throw new Error(`Blob list exceeds ${MAX_LIST_RESULTS} entries`);
	return { blobs };
}

async function readBlob(
	session: AgentSession,
	command: Extract<RpcCommand, { type: "blob_read" }>,
): Promise<RpcBlobReadResult> {
	if (typeof command.hash !== "string" || !BLOB_HASH_RE.test(command.hash)) {
		throw new RpcSessionDataError("Blob hash must be exactly 64 lowercase hexadecimal characters", "protocol-error");
	}
	const data = await session.sessionManager.getBlobStore().get(command.hash);
	if (!data) throw new RpcSessionDataError(`Blob ${command.hash} was not found`, "not-found");
	if (data.byteLength > MAX_BLOB_BYTES) {
		throw new RpcSessionDataError(`Blob exceeds ${MAX_BLOB_BYTES} bytes`, "blob_too_large");
	}
	const actualHash = new Bun.SHA256().update(data).digest("hex");
	if (actualHash !== command.hash)
		throw new RpcSessionDataError("Blob content failed its hash check", "protocol-error");
	return { hash: command.hash, size: data.byteLength, encoding: "base64", content: data.toString("base64") };
}

async function writeBlob(
	session: AgentSession,
	command: Extract<RpcCommand, { type: "blob_write" }>,
): Promise<RpcBlobWriteResult> {
	const decoded = decodeBlobWrite(command);
	if (typeof decoded === "string") throw new RpcSessionDataError(decoded, "protocol-error");
	const result = await session.sessionManager.getBlobStore().put(decoded);
	if (result.hash !== command.hash) throw new Error("BlobStore returned a different content hash");
	return { hash: result.hash, size: decoded.byteLength };
}

export class RpcSessionDataError extends Error {
	constructor(
		message: string,
		readonly code: string,
	) {
		super(message);
		this.name = "RpcSessionDataError";
	}
}

export async function executeRpcSessionDataCommand(
	session: AgentSession,
	command: RpcCommand,
): Promise<RpcResponse | undefined> {
	try {
		switch (command.type) {
			case "artifact_list":
				return success(command, await listArtifacts(session));
			case "artifact_read":
				return success(command, await readArtifact(session, command));
			case "artifact_write":
				return success(command, await writeArtifact(session, command));
			case "blob_list":
				return success(command, await listBlobs(session));
			case "blob_read":
				return success(command, await readBlob(session, command));
			case "blob_write":
				return success(command, await writeBlob(session, command));
			case "history_snapshot":
				return success(command, getRpcHistorySnapshot(session));
			case "history_page":
				return success(command, getRpcHistoryPage(session, command));
			case "history_chunk":
				return success(command, getRpcHistoryChunk(session, command));
			case "history_digest":
				return success(command, getRpcHistoryDigest(session));
			case "custom_message": {
				const disposition = await session.sendCustomMessage(
					{
						customType: command.customType,
						content: command.content,
						display: command.display,
						details: command.details,
					},
					{ deliveryMode: "steer", ...(command.when === undefined ? {} : { when: command.when }) },
				);
				if (disposition.status === "unavailable") {
					return disposition.reason === "session_busy"
						? failure(command, "Session is busy", "session_busy")
						: failure(command, "Session cannot accept a custom message", "unavailable");
				}
				await session.sessionManager.ensureOnDisk();
				return success(command, { accepted: true } satisfies RpcCustomMessageResult);
			}
			default:
				return undefined;
		}
	} catch (error) {
		if (error instanceof RpcHistoryError || error instanceof RpcSessionDataError) {
			return failure(command, error.message, error.code);
		}
		throw error;
	}
}
