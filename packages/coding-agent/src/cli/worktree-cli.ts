import { constants as fsConstants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreesDir, isEnoent } from "@oh-my-pi/pi-utils";
import {
	type ConfidentialTransientTaskIsolationPreparingAuthorityV1,
	TASK_ADAPTER_WORKTREE_MANAGED_SKIP_MESSAGE_V1,
	TASK_ADAPTER_WORKTREE_MANAGED_SKIP_REASON_V1,
	type TaskAdapterWorktreeCliClearEntryResultV1,
	type TaskAdapterWorktreeCliEntryV1,
} from "../session/workspace-runtime-contracts";
import {
	isTaskIsolationExclusionLockSidecar,
	recognizeManagedTaskIsolationEntryV1,
	tryAcquireTaskIsolationExclusionLock,
} from "../task/isolation-ownership";
import * as git from "../utils/git";

const CLAIM_SUFFIX = ".owner-v1";
const LEGACY_OWNER_FILE = ".omp-isolation-owner.json";
type LegacyKind = Extract<TaskAdapterWorktreeCliEntryV1, { kind: "unmanaged_legacy" }>["legacyKind"];
export type WorktreeEntry = TaskAdapterWorktreeCliEntryV1;
export interface ListWorktreesOptions {
	json: boolean;
	currentPreparations?: readonly ConfidentialTransientTaskIsolationPreparingAuthorityV1[];
}
export interface ClearWorktreesOptions extends ListWorktreesOptions {
	all: boolean;
	dryRun: boolean;
}
interface Scanned {
	entry: WorktreeEntry;
	physicalPath: string;
	parentRepo?: string;
	root?: string;
	rootDev?: number;
	rootIno?: number;
	candidateDev?: number;
	candidateIno?: number;
}

export async function listWorktrees(options: ListWorktreesOptions): Promise<void> {
	const entries = (await scan(options.currentPreparations)).map(item => item.entry);
	const counts = countsFor(entries);
	if (options.json)
		return void console.log(JSON.stringify({ schemaVersion: 1, command: "list", entries, counts }, null, 2));
	if (entries.length === 0) return void console.log(`No agent-managed worktrees found under ${getWorktreesDir()}.`);
	for (const entry of entries) {
		if (entry.kind === "managed_task_isolation") {
			console.log(
				`managed  ${entry.isolationNamespaceSha256 ?? "unknown"} — task isolation; not removable by omp worktree clear`,
			);
			console.log("         action: resume the owning task so authorized cleanup can complete");
		} else console.log(`${entry.kind}  ${entry.path}`);
	}
}

export async function clearWorktrees(options: ClearWorktreesOptions): Promise<void> {
	const lock = tryAcquireTaskIsolationExclusionLock();
	if (!lock) {
		const output = {
			schemaVersion: 1,
			command: "clear",
			all: options.all,
			dryRun: options.dryRun,
			results: [],
			counts: { removed: 0, wouldRemove: 0, failed: 0, kept: 0, skippedManaged: 0, skippedUnsafe: 0, total: 0 },
		};
		if (options.json) console.log(JSON.stringify(output, null, 2));
		else console.log("Worktree isolation exclusion lock is unavailable; nothing was removed.");
		return;
	}
	try {
		const results: TaskAdapterWorktreeCliClearEntryResultV1[] = [];
		for (const item of await scan(options.currentPreparations)) {
			const entry = item.entry;
			if (entry.kind === "managed_task_isolation") {
				results.push({
					schemaVersion: 1,
					entryOrdinal: entry.entryOrdinal,
					kind: entry.kind,
					disposition: "managed_entry_skipped",
					reason: TASK_ADAPTER_WORKTREE_MANAGED_SKIP_REASON_V1,
					message: TASK_ADAPTER_WORKTREE_MANAGED_SKIP_MESSAGE_V1,
					isolationNamespaceSha256: entry.isolationNamespaceSha256,
					isolationOwnerManifestSha256: entry.isolationOwnerManifestSha256,
					isolationCreatorDescriptorSha256: entry.isolationCreatorDescriptorSha256,
					path: null,
				});
				continue;
			}
			if (entry.kind === "unclassified") {
				results.push({
					schemaVersion: 1,
					entryOrdinal: entry.entryOrdinal,
					kind: entry.kind,
					disposition: "unsafe_entry_skipped",
					path: entry.path,
					error: null,
				});
				continue;
			}
			if (entry.kind === "registered_pr_checkout" && !options.all) {
				results.push({
					schemaVersion: 1,
					entryOrdinal: entry.entryOrdinal,
					kind: entry.kind,
					disposition: "kept",
					path: entry.path,
					error: null,
				});
				continue;
			}
			if (options.dryRun) {
				results.push({
					schemaVersion: 1,
					entryOrdinal: entry.entryOrdinal,
					kind: entry.kind,
					disposition: "would_remove",
					path: entry.path,
					error: null,
				});
				continue;
			}
			if (entry.kind === "registered_pr_checkout") {
				if (!(await mayEffect(item, "registered_pr_checkout", options.currentPreparations))) {
					results.push({
						schemaVersion: 1,
						entryOrdinal: entry.entryOrdinal,
						kind: entry.kind,
						disposition: "kept",
						path: entry.path,
						error: null,
					});
					continue;
				}
				try {
					const removed = await git.worktree.tryRemove(item.parentRepo!, item.physicalPath, { force: true });
					results.push({
						schemaVersion: 1,
						entryOrdinal: entry.entryOrdinal,
						kind: entry.kind,
						disposition: removed ? "removed" : "remove_failed",
						path: entry.path,
						error: removed ? null : "git worktree removal was refused",
					});
				} catch (error) {
					results.push({
						schemaVersion: 1,
						entryOrdinal: entry.entryOrdinal,
						kind: entry.kind,
						disposition: "remove_failed",
						path: entry.path,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				continue;
			}
			if (!(await mayEffect(item, "unmanaged_legacy", options.currentPreparations))) {
				results.push({
					schemaVersion: 1,
					entryOrdinal: entry.entryOrdinal,
					kind: entry.kind,
					disposition: "kept",
					path: entry.path,
					error: null,
				});
				continue;
			}
			try {
				await fs.rmdir(item.physicalPath);
				results.push({
					schemaVersion: 1,
					entryOrdinal: entry.entryOrdinal,
					kind: entry.kind,
					disposition: "removed",
					path: entry.path,
					error: null,
				});
			} catch (error) {
				results.push({
					schemaVersion: 1,
					entryOrdinal: entry.entryOrdinal,
					kind: entry.kind,
					disposition: "remove_failed",
					path: entry.path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const counts = {
			removed: results.filter(x => x.disposition === "removed").length,
			wouldRemove: results.filter(x => x.disposition === "would_remove").length,
			failed: results.filter(x => x.disposition === "remove_failed").length,
			kept: results.filter(x => x.disposition === "kept").length,
			skippedManaged: results.filter(x => x.disposition === "managed_entry_skipped").length,
			skippedUnsafe: results.filter(x => x.disposition === "unsafe_entry_skipped").length,
			total: results.length,
		};
		const output = { schemaVersion: 1, command: "clear", all: options.all, dryRun: options.dryRun, results, counts };
		if (options.json) console.log(JSON.stringify(output, null, 2));
		else
			for (const result of results)
				console.log(
					result.kind === "managed_task_isolation"
						? `skipped  ${result.isolationNamespaceSha256 ?? "unknown"} — ${result.message}`
						: `${result.disposition}  ${result.path}${result.error ? ` — ${result.error}` : ""}`,
				);
		if (counts.failed > 0) process.exitCode = 1;
	} finally {
		lock.release();
	}
}

function countsFor(entries: readonly WorktreeEntry[]) {
	return {
		managed: entries.filter(x => x.kind === "managed_task_isolation").length,
		registeredPrCheckout: entries.filter(x => x.kind === "registered_pr_checkout").length,
		unmanagedLegacy: entries.filter(x => x.kind === "unmanaged_legacy").length,
		unclassified: entries.filter(x => x.kind === "unclassified").length,
		total: entries.length,
	};
}

async function scan(
	preparations: readonly ConfidentialTransientTaskIsolationPreparingAuthorityV1[] | undefined,
): Promise<Scanned[]> {
	const root = getWorktreesDir();
	let rootStat: Stats;
	try {
		rootStat = await fs.lstat(root);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
		throw new Error(`Refusing to scan unsafe worktree root: ${root}`);
	const entries: Scanned[] = [];
	for (const name of (await fs.readdir(root)).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
		if (name.endsWith(CLAIM_SUFFIX) || isTaskIsolationExclusionLockSidecar(name)) continue;
		const candidate = path.join(root, name),
			stat = await fs.lstat(candidate).catch(() => null),
			ordinal = entries.length;
		const classified =
			stat?.isDirectory() && !stat.isSymbolicLink() && stat.dev === rootStat.dev
				? await classify(candidate, ordinal, preparations)
				: null;
		const item =
			classified ??
			({
				physicalPath: candidate,
				entry: {
					schemaVersion: 1,
					entryOrdinal: ordinal,
					kind: "unclassified",
					path: candidate,
					removalMode: "none",
					reason: "unsafe_or_unrecognized",
				},
			} as Scanned);
		entries.push({
			...item,
			root,
			rootDev: rootStat.dev,
			rootIno: rootStat.ino,
			candidateDev: stat?.dev ?? -1,
			candidateIno: stat?.ino ?? -1,
		});
	}
	return entries;
}

async function mayEffect(
	item: Scanned,
	expected: "registered_pr_checkout" | "unmanaged_legacy",
	preparations: readonly ConfidentialTransientTaskIsolationPreparingAuthorityV1[] | undefined,
): Promise<boolean> {
	if (
		item.root === undefined ||
		item.rootDev === undefined ||
		item.rootIno === undefined ||
		item.candidateDev === undefined ||
		item.candidateIno === undefined
	)
		return false;
	const [root, candidate] = await Promise.all([
		fs.lstat(item.root).catch(() => null),
		fs.lstat(item.physicalPath).catch(() => null),
	]);
	if (
		!root?.isDirectory() ||
		root.isSymbolicLink() ||
		root.dev !== item.rootDev ||
		root.ino !== item.rootIno ||
		!candidate?.isDirectory() ||
		candidate.isSymbolicLink() ||
		candidate.dev !== item.candidateDev ||
		candidate.ino !== item.candidateIno ||
		candidate.dev !== root.dev
	)
		return false;
	try {
		await fs.lstat(`${item.physicalPath}${CLAIM_SUFFIX}`);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
	}
	const current = await classify(item.physicalPath, item.entry.entryOrdinal, preparations);
	return (
		current?.entry.kind === expected &&
		(expected !== "registered_pr_checkout" || current.parentRepo === item.parentRepo)
	);
}

async function classify(
	candidate: string,
	entryOrdinal: number,
	preparations: readonly ConfidentialTransientTaskIsolationPreparingAuthorityV1[] | undefined,
): Promise<Scanned | null> {
	let managed = null;
	for (const preparation of preparations ?? []) {
		managed = await recognizeManagedTaskIsolationEntryV1(candidate, preparation);
		if (managed?.source !== "canonical_namespace_guard") break;
	}
	managed ??= await recognizeManagedTaskIsolationEntryV1(candidate);
	if (managed)
		return {
			physicalPath: candidate,
			entry: {
				schemaVersion: 1,
				entryOrdinal,
				kind: "managed_task_isolation",
				isolationNamespaceSha256: managed.isolationNamespaceSha256,
				isolationOwnerManifestSha256: managed.isolationOwnerManifestSha256,
				isolationCreatorDescriptorSha256: managed.isolationCreatorDescriptorSha256,
				removable: false,
				path: null,
			},
		};
	const gitFile = path.join(candidate, ".git"),
		text = await readRegular(gitFile),
		match = text === null ? null : /^gitdir:\s*(.+?)\s*$/.exec(text);
	if (match) {
		const adminPath = path.resolve(path.dirname(gitFile), match[1]),
			parentRepo = path.dirname(path.dirname(path.dirname(adminPath)));
		const [admin, repo, repoGit] = await Promise.all([
			fs.lstat(adminPath).catch(() => null),
			fs.lstat(parentRepo).catch(() => null),
			fs.lstat(path.join(parentRepo, ".git")).catch(() => null),
		]);
		if (
			admin?.isDirectory() &&
			!admin.isSymbolicLink() &&
			repo?.isDirectory() &&
			!repo.isSymbolicLink() &&
			repoGit?.isDirectory() &&
			!repoGit.isSymbolicLink()
		)
			return {
				physicalPath: candidate,
				parentRepo,
				entry: {
					schemaVersion: 1,
					entryOrdinal,
					kind: "registered_pr_checkout",
					path: candidate,
					state: "registered",
					removalMode: "git_worktree_remove_only",
				},
			};
	}
	const legacyKind = await legacy(candidate, text, match);
	if (!legacyKind) return null;
	return {
		physicalPath: candidate,
		entry: {
			schemaVersion: 1,
			entryOrdinal,
			kind: "unmanaged_legacy",
			path: candidate,
			legacyKind,
			removalMode: "raw_recursive_allowed",
		},
	};
}

async function readRegular(file: string): Promise<string | null> {
	const stat = await fs.lstat(file).catch(() => null);
	if (!stat?.isFile() || stat.isSymbolicLink()) return null;
	try {
		const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			return (await handle.stat()).isFile() ? await handle.readFile("utf8") : null;
		} finally {
			await handle.close();
		}
	} catch {
		return null;
	}
}

async function safeTree(directory: string): Promise<boolean> {
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch {
		return false;
	}
	for (const name of names) {
		const stat = await fs.lstat(path.join(directory, name)).catch(() => null);
		if (!stat || stat.isSymbolicLink() || (stat.isDirectory() && !(await safeTree(path.join(directory, name)))))
			return false;
	}
	return true;
}

async function legacy(
	candidate: string,
	gitText: string | null,
	gitMatch: RegExpExecArray | null,
): Promise<LegacyKind | null> {
	const names = await fs.readdir(candidate).catch(() => null);
	if (!names || !(await safeTree(candidate))) return null;
	const marker = await fs.lstat(path.join(candidate, LEGACY_OWNER_FILE)).catch(() => null);
	if (marker?.isFile() && !marker.isSymbolicLink()) return "in_directory_pid_marker";
	for (const mount of ["m", "merged"]) {
		const stat = await fs.lstat(path.join(candidate, mount)).catch(() => null);
		if (stat?.isDirectory() && !stat.isSymbolicLink()) return "task_isolation_mount";
	}
	if (gitText !== null) return gitMatch ? "orphaned_pr_checkout" : null;
	return names.length === 0 ? "empty_shell" : "stray";
}
