import type { Dirent, Stats } from "node:fs";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger, toError } from "@oh-my-pi/pi-utils";

const ARTIFACT_OPERATION_PREFIX = ".omp-artifact-operation-";
const ARTIFACT_OPERATION_SUFFIX = ".json";
const ARTIFACT_OWNERSHIP_PREFIX = ".omp-artifact-owner-";

interface ArtifactPublicationIntent {
	version: 1;
	kind: "clone" | "relocate";
	ownerPid: number;
	sourceDir: string;
	sourceSessionFile: string;
	destinationDir: string;
	destinationSessionFile: string;
	stagingDir: string;
	ownershipFile: string;
	ownershipToken: string;
}

interface ArtifactDeletionIntent {
	version: 1;
	kind: "delete";
	ownerPid: number;
	sessionFile: string;
	artifactsDir: string;
}

type ArtifactOperationIntent = ArtifactPublicationIntent | ArtifactDeletionIntent;

export interface ArtifactPublication {
	intent: ArtifactPublicationIntent;
	intentPaths: string[];
	published: boolean;
}

function hasCode(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function sessionFileForArtifactsDir(artifactsDir: string): string {
	return `${artifactsDir}.jsonl`;
}

async function writeIntent(intentPath: string, intent: ArtifactOperationIntent): Promise<void> {
	const dir = path.dirname(intentPath);
	await fs.mkdir(dir, { recursive: true });
	const tempPath = `${intentPath}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(tempPath, `${JSON.stringify(intent)}\n`, { flag: "wx", mode: 0o600 });
		await fs.rename(tempPath, intentPath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function removeIfPresent(target: string): Promise<void> {
	try {
		await fs.unlink(target);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

function removeIfPresentSync(target: string): void {
	try {
		nodeFs.unlinkSync(target);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

function processIsAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !hasCode(error, "ESRCH");
	}
}

function validPublicationIntent(intent: ArtifactPublicationIntent, sessionDir: string): boolean {
	if (typeof intent.ownershipToken !== "string" || intent.ownershipToken.length === 0) return false;
	const destinationDir = path.resolve(intent.destinationDir);
	const destinationSessionFile = path.resolve(intent.destinationSessionFile);
	const stagingDir = path.resolve(intent.stagingDir);
	const ownershipFile = path.resolve(intent.ownershipFile);
	const sourceSessionFile = path.resolve(intent.sourceSessionFile);
	const markerDir = path.resolve(sessionDir);
	const destinationParent = path.dirname(destinationDir);
	const markerOwnsOperation = markerDir === destinationParent || markerDir === path.dirname(sourceSessionFile);
	return (
		markerOwnsOperation &&
		destinationSessionFile === sessionFileForArtifactsDir(destinationDir) &&
		sourceSessionFile === sessionFileForArtifactsDir(path.resolve(intent.sourceDir)) &&
		path.dirname(stagingDir) === destinationParent &&
		path.basename(stagingDir) === `.${path.basename(destinationDir)}.artifact-stage-${intent.ownershipToken}` &&
		path.dirname(destinationSessionFile) === destinationParent &&
		path.dirname(ownershipFile) === destinationDir &&
		path.basename(ownershipFile) === `${ARTIFACT_OWNERSHIP_PREFIX}${intent.ownershipToken}`
	);
}

function validDeletionIntent(intent: ArtifactDeletionIntent, sessionDir: string): boolean {
	const sessionFile = path.resolve(intent.sessionFile);
	return (
		path.dirname(sessionFile) === path.resolve(sessionDir) &&
		sessionFile.endsWith(".jsonl") &&
		path.resolve(intent.artifactsDir) === sessionFile.slice(0, -".jsonl".length)
	);
}

function readOperationIntentSync(intentPath: string, sessionDir: string): ArtifactOperationIntent | undefined {
	let value: unknown;
	try {
		value = JSON.parse(nodeFs.readFileSync(intentPath, "utf8"));
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<ArtifactOperationIntent>;
	if (candidate.version !== 1 || typeof candidate.ownerPid !== "number") return undefined;
	if (candidate.kind === "delete") {
		return validDeletionIntent(candidate as ArtifactDeletionIntent, sessionDir)
			? (candidate as ArtifactDeletionIntent)
			: undefined;
	}
	if (candidate.kind !== "clone" && candidate.kind !== "relocate") return undefined;
	return validPublicationIntent(candidate as ArtifactPublicationIntent, sessionDir)
		? (candidate as ArtifactPublicationIntent)
		: undefined;
}

function directoryHasOwnershipSync(intent: ArtifactPublicationIntent): boolean {
	try {
		return nodeFs.readFileSync(intent.ownershipFile, "utf8") === intent.ownershipToken;
	} catch {
		return false;
	}
}

function reconcileOperationIntentSync(intentPath: string, intent: ArtifactOperationIntent): void {
	if (processIsAlive(intent.ownerPid)) return;
	if (intent.kind === "delete") {
		removeIfPresentSync(intent.sessionFile);
		nodeFs.rmSync(intent.artifactsDir, { recursive: true, force: true });
		removeIfPresentSync(intentPath);
		return;
	}

	nodeFs.rmSync(intent.stagingDir, { recursive: true, force: true });
	const sourceJournalExists = nodeFs.existsSync(intent.sourceSessionFile);
	const destinationJournalExists = nodeFs.existsSync(intent.destinationSessionFile);
	if (intent.kind === "relocate" && destinationJournalExists && !sourceJournalExists) {
		if (nodeFs.existsSync(intent.sourceDir) && !directoryHasOwnershipSync(intent)) return;
		nodeFs.rmSync(intent.sourceDir, { recursive: true, force: true });
		removeIfPresentSync(intent.ownershipFile);
		removeIfPresentSync(intentPath);
		return;
	}
	if (intent.kind === "clone" && destinationJournalExists) {
		removeIfPresentSync(intent.ownershipFile);
		removeIfPresentSync(intentPath);
		return;
	}
	if (directoryHasOwnershipSync(intent)) {
		nodeFs.rmSync(intent.destinationDir, { recursive: true, force: true });
	}
	removeIfPresentSync(intentPath);
}

/** Retry durable artifact clone, relocation, and deletion intents in one session directory. */
export function reconcileArtifactOperationsSync(sessionDir: string): void {
	let entries: Dirent[];
	try {
		entries = nodeFs.readdirSync(sessionDir, { withFileTypes: true });
	} catch (error) {
		if (hasCode(error, "ENOENT")) return;
		throw error;
	}
	for (const entry of entries) {
		if (
			!entry.isFile() ||
			!entry.name.startsWith(ARTIFACT_OPERATION_PREFIX) ||
			!entry.name.endsWith(ARTIFACT_OPERATION_SUFFIX)
		) {
			continue;
		}
		const intentPath = path.join(sessionDir, entry.name);
		const intent = readOperationIntentSync(intentPath, sessionDir);
		if (!intent) continue;
		try {
			reconcileOperationIntentSync(intentPath, intent);
		} catch (error) {
			logger.warn("Failed to reconcile durable artifact operation", {
				intentPath,
				error: toError(error).message,
			});
		}
	}
}

/** Retry durable artifact intents in a managed sessions root and each project directory below it. */
export function reconcileArtifactOperationsUnderRootSync(sessionsRoot: string): void {
	reconcileArtifactOperationsSync(sessionsRoot);
	let entries: Dirent[];
	try {
		entries = nodeFs.readdirSync(sessionsRoot, { withFileTypes: true });
	} catch (error) {
		if (hasCode(error, "ENOENT")) return;
		throw error;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) reconcileArtifactOperationsSync(path.join(sessionsRoot, entry.name));
	}
}

/** Publish a durable deletion intent before either the session journal or artifacts are removed. */
export async function writeArtifactDeletionIntent(sessionFile: string): Promise<string> {
	if (!sessionFile.endsWith(".jsonl")) throw new Error(`Session deletion path must end with .jsonl: ${sessionFile}`);
	const resolvedSessionFile = path.resolve(sessionFile);
	const intentPath = path.join(
		path.dirname(resolvedSessionFile),
		`${ARTIFACT_OPERATION_PREFIX}delete-${path.basename(resolvedSessionFile)}${ARTIFACT_OPERATION_SUFFIX}`,
	);
	const intent: ArtifactDeletionIntent = {
		version: 1,
		kind: "delete",
		ownerPid: process.pid,
		sessionFile: resolvedSessionFile,
		artifactsDir: resolvedSessionFile.slice(0, -".jsonl".length),
	};
	await writeIntent(intentPath, intent);
	return intentPath;
}

/** Remove a completed durable artifact operation intent. */
export async function removeArtifactOperationIntent(intentPath: string): Promise<void> {
	await removeIfPresent(intentPath);
}

async function copyArtifactFile(source: string, destination: string): Promise<void> {
	await fs.copyFile(source, destination);
}

async function cloneArtifactTree(sourceDir: string, destinationDir: string, root = true): Promise<void> {
	await fs.mkdir(destinationDir);
	const entries = await fs.readdir(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
		if (root && entry.name.startsWith(ARTIFACT_OWNERSHIP_PREFIX)) continue;
		const source = path.join(sourceDir, entry.name);
		const destination = path.join(destinationDir, entry.name);
		const stat = await fs.lstat(source);
		if (stat.isDirectory()) {
			await cloneArtifactTree(source, destination, false);
		} else if (stat.isFile()) {
			await copyArtifactFile(source, destination);
		} else if (stat.isSymbolicLink()) {
			await fs.symlink(await fs.readlink(source), destination);
		} else {
			throw new Error(`Unsupported artifact entry type: ${source}`);
		}
	}
}

/** Write a complete artifact graph to a sibling stage and atomically publish it. */
export async function publishArtifactGraph(
	kind: "clone" | "relocate",
	sourcePath: string,
	destinationPath: string,
	additionalFiles: ReadonlySet<string>,
): Promise<ArtifactPublication | undefined> {
	const sourceDir = path.resolve(sourcePath);
	const destinationDir = path.resolve(destinationPath);
	if (destinationDir === sourceDir) throw new Error("Artifact clone destination must differ from its source");
	try {
		await fs.lstat(destinationDir);
		throw Object.assign(new Error(`Artifact clone destination already exists: ${destinationDir}`), {
			code: "EEXIST",
		});
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}

	let sourceStat: Stats;
	try {
		sourceStat = await fs.lstat(sourceDir);
	} catch (error) {
		if (hasCode(error, "ENOENT")) {
			if (additionalFiles.size > 0) {
				throw new Error(
					`Artifact clone source is missing requested companion files: ${[...additionalFiles].join(", ")}`,
				);
			}
			return undefined;
		}
		throw error;
	}
	if (!sourceStat.isDirectory()) {
		throw Object.assign(new Error(`Artifact source is not a directory: ${sourceDir}`), { code: "ENOTDIR" });
	}

	const topLevel = new Set(await fs.readdir(sourceDir));
	const missingAdditionalFiles = [...additionalFiles].filter(filename => !topLevel.has(filename));
	if (missingAdditionalFiles.length > 0) {
		throw new Error(`Artifact clone companion file is missing: ${missingAdditionalFiles.join(", ")}`);
	}

	const operationId = crypto.randomUUID();
	const parentDir = path.dirname(destinationDir);
	const stagingDir = path.join(parentDir, `.${path.basename(destinationDir)}.artifact-stage-${operationId}`);
	const ownershipFile = path.join(destinationDir, `.omp-artifact-owner-${operationId}`);
	const intentName = `${ARTIFACT_OPERATION_PREFIX}${kind}-${operationId}${ARTIFACT_OPERATION_SUFFIX}`;
	const intentPaths = [path.join(parentDir, intentName)];
	const sourceParent = path.dirname(sourceDir);
	if (sourceParent !== parentDir) intentPaths.push(path.join(sourceParent, intentName));
	const intent: ArtifactPublicationIntent = {
		version: 1,
		kind,
		ownerPid: process.pid,
		sourceDir,
		sourceSessionFile: sessionFileForArtifactsDir(sourceDir),
		destinationDir,
		destinationSessionFile: sessionFileForArtifactsDir(destinationDir),
		stagingDir,
		ownershipFile,
		ownershipToken: operationId,
	};
	const writtenIntents: string[] = [];
	try {
		for (const intentPath of intentPaths) {
			await writeIntent(intentPath, intent);
			writtenIntents.push(intentPath);
		}
	} catch (error) {
		await Promise.all(writtenIntents.map(intentPath => removeIfPresent(intentPath).catch(() => undefined)));
		throw error;
	}
	const publication: ArtifactPublication = { intent, intentPaths, published: false };
	try {
		await cloneArtifactTree(sourceDir, stagingDir);
		await fs.writeFile(path.join(stagingDir, path.basename(ownershipFile)), operationId, { flag: "wx", mode: 0o600 });
		await fs.rename(stagingDir, destinationDir);
		publication.published = true;
		return publication;
	} catch (error) {
		try {
			await rollbackArtifactPublication(publication);
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Artifact clone publication and cleanup failed");
		}
		throw error;
	}
}

/** Remove only clone output proven to belong to this publication. */
export async function rollbackArtifactPublication(publication: ArtifactPublication): Promise<void> {
	const failures: unknown[] = [];
	try {
		await fs.rm(publication.intent.stagingDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
	} catch (error) {
		failures.push(error);
	}
	if (publication.published) {
		let owned = false;
		try {
			owned = (await fs.readFile(publication.intent.ownershipFile, "utf8")) === publication.intent.ownershipToken;
		} catch (error) {
			if (!hasCode(error, "ENOENT")) failures.push(error);
		}
		if (owned) {
			try {
				await fs.rm(publication.intent.destinationDir, {
					recursive: true,
					force: true,
					maxRetries: 3,
					retryDelay: 25,
				});
			} catch (error) {
				failures.push(error);
			}
		}
	}
	if (failures.length === 0) {
		for (const intentPath of publication.intentPaths) {
			try {
				await removeIfPresent(intentPath);
			} catch (error) {
				failures.push(error);
			}
		}
	}
	if (failures.length > 0) throw new AggregateError(failures, "Artifact clone rollback failed");
}

/** Retire clone bookkeeping after its destination journal is durable. */
export async function commitClonePublication(publication: ArtifactPublication | undefined): Promise<void> {
	if (!publication) return;
	try {
		await removeIfPresent(publication.intent.ownershipFile);
		for (const intentPath of publication.intentPaths) await removeIfPresent(intentPath);
	} catch {
		// The durable intent remains retryable at startup. Journal publication is
		// already the commit point, so cleanup failure must not roll it back.
	}
}

/** Retire the old artifact graph after the relocation journal commit point. */
export async function commitRelocationPublication(
	publication: ArtifactPublication | undefined,
	sourceDir: string,
): Promise<void> {
	if (!publication) return;
	try {
		await fs.rm(sourceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
		await removeIfPresent(publication.intent.ownershipFile);
		for (const intentPath of publication.intentPaths) await removeIfPresent(intentPath);
	} catch {
		// Startup reconciliation reads the journals to select the committed side
		// and retries old-source cleanup without risking the published destination.
	}
}
