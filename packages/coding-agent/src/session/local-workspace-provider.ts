import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type {
	ISO8601,
	ProfileId,
	ProviderId,
	ProviderRequestId,
	RuntimeLeaseId,
	Sha256Hex,
	Sha256Ref,
} from "../registry/persistent-agent-contracts.js";
import {
	materializeWorkspaceSnapshotV1,
	validatePersistentReplicaDeletionAuthorizationV1,
	validateWorkspaceSnapshotV1,
} from "./managed-workspace.js";
import {
	type CanonicalRuntimeValue,
	DARWIN_LOCAL_DEVICE_PATHS_V1,
	DARWIN_LOCAL_READONLY_SYSTEM_ROOTS_V1,
	encodeCanonicalRuntimeTupleV1,
	type FrozenReplicaCheckpointRef,
	LINUX_LOCAL_READONLY_SYSTEM_ROOTS_V1,
	type LocalIsolationAvailabilityV1,
	type LocalIsolationPolicyV1,
	PERSISTENT_RUNTIME_PROVIDER_ENVIRONMENT_V1,
	type RuntimeCommandSnapshot,
	type RuntimeExecutionBridge,
	type RuntimeParentOperationProviderRequestIdentity,
	type RuntimeProvider,
	type RuntimeProviderPhase,
	type RuntimeProviderRequestIdentity,
	type RuntimeReplicaDeletionAuthorizationV1,
	type RuntimeReplicaRef,
	type RuntimeTransitionProviderRequestIdentity,
	type WorkspaceImage,
	type WorkspaceSnapshot,
} from "./workspace-runtime-contracts.js";

const PROVIDER_ID = "local" as ProviderId;
const PROFILE_ID = "local-isolated-v1" as ProfileId;
const EPOCH = "1970-01-01T00:00:00.000Z" as ISO8601;
const DARWIN_DEVELOPER_ROOTS = [
	"/Applications/Xcode.app/Contents/Developer",
	"/Library/Developer/CommandLineTools",
] as const;
type DarwinHelperPython = {
	readonly developerRoot: (typeof DARWIN_DEVELOPER_ROOTS)[number];
	readonly executable: string;
	readonly frameworkRoot: string;
};
function resolveDarwinHelperPython(): DarwinHelperPython | null {
	if (process.platform !== "darwin") return null;
	try {
		const hostEnvironment = { PATH: "/usr/bin:/bin" };
		const developerRoot = execFileSync("/usr/bin/xcode-select", ["-p"], {
			encoding: "utf8",
			env: hostEnvironment,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const allowedRoot = DARWIN_DEVELOPER_ROOTS.find(root => root === developerRoot);
		if (!allowedRoot) return null;
		const executable = realpathSync(
			execFileSync("/usr/bin/xcrun", ["--sdk", "macosx", "--find", "python3"], {
				encoding: "utf8",
				env: hostEnvironment,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim(),
		);
		const versionsRoot = `${allowedRoot}/Library/Frameworks/Python3.framework/Versions/`;
		if (!executable.startsWith(versionsRoot)) return null;
		const bin = executable.lastIndexOf("/bin/");
		if (bin <= versionsRoot.length || !executable.slice(bin + "/bin/".length).startsWith("python")) return null;
		return { developerRoot: allowedRoot, executable, frameworkRoot: executable.slice(0, bin) };
	} catch {
		return null;
	}
}
const DARWIN_HELPER_PYTHON = resolveDarwinHelperPython();
const LOCAL_HELPER_PYTHON = DARWIN_HELPER_PYTHON?.executable ?? "/usr/bin/python3";
const MAX_COMMAND_TIMEOUT_MS = 300_000;
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_COMMAND_SOURCE_BYTES = 256 * 1024;
const MAX_BRIDGE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_BRIDGE_FILE_BYTES = 4 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 30_000;
const PROCESS_TERM_GRACE_MS = 100;
const PROCESS_REAP_DEADLINE_MS = 1_000;
const PROCESS_REAP_RETRY_MS = 1_000;
let sharedIsolationProbe: Promise<boolean> | null = null;

type EffectLedger<T> = { readonly fingerprint: Sha256Hex; readonly result: T };
type MutationRecord = {
	readonly fingerprint: Sha256Hex;
	readonly requestSha256: Sha256Hex;
	readonly kind: "write" | "mkdir" | "remove" | "rename" | "control";
	readonly result: unknown;
};
type CheckpointRecord = {
	readonly fingerprint: Sha256Hex;
	readonly requestId: ProviderRequestId;
	readonly request: RuntimeProviderRequestIdentity;
	readonly reference: FrozenReplicaCheckpointRef;
	readonly snapshot: WorkspaceSnapshot;
};
type CommandRecord = {
	readonly fingerprint: Sha256Hex;
	readonly requestSha256: Sha256Hex;
	readonly outputByteLimit: number;
	snapshot: RuntimeCommandSnapshot;
	liveResult: RuntimeCommandSnapshot | null;
	execution: IsolatedExecution | null;
	cancelRequested: boolean;
	disposed: boolean;
};
type Reservation = {
	readonly replicaKey: string;
	readonly domain: RuntimeReplicaDeletionAuthorizationV1["domain"];
	lease: Awaited<ReturnType<RuntimeProvider["acquire"]>>["lease"];
	readonly fenceDigest: Sha256Hex;
	root: string | null;
	image: WorkspaceImage | null;
	phase: RuntimeProviderPhase;
	readonly acquireFingerprint: Sha256Hex;
	readonly acquireRequestId: ProviderRequestId;
	releaseTerminal: boolean;
	pushRequestId: ProviderRequestId | null;
	readonly commands: Map<string, CommandRecord>;
	readonly checkpoints: Map<string, CheckpointRecord>;
	readonly mutations: Map<string, MutationRecord>;
	expiryTimer: ReturnType<typeof setTimeout> | null;
};
type CacheState = {
	readonly fingerprint: Sha256Hex;
	readonly acceptance: Extract<
		Awaited<ReturnType<RuntimeProvider["requestReplicaCacheEviction"]>>,
		{ status: "accepted" | "already_accepted" }
	>["acceptance"];
	completion:
		| Extract<Awaited<ReturnType<RuntimeProvider["requestReplicaCacheEviction"]>>, { status: "complete" }>["result"]
		| null;
	timer: NodeJS.Timeout | undefined;
	attempting: boolean;
	rearmRequested: boolean;
};
type TerminalDeletionResult = {
	readonly request: RuntimeProviderRequestIdentity;
	readonly replica: RuntimeReplicaRef;
	readonly authorization: RuntimeReplicaDeletionAuthorizationV1;
	readonly observedAt: ISO8601;
	readonly status: "deleted" | "already_deleted" | "absent";
	readonly retryAfter: null;
	readonly receiptSha256: Sha256Ref;
};
type DeletionCommandEvidence = {
	readonly requestSha256: Sha256Hex;
	readonly status: "start_unknown" | "succeeded" | "failed" | "cancelled";
};
type DeletionState = {
	readonly fingerprint: Sha256Hex;
	readonly result: TerminalDeletionResult;
	readonly tombstone: Extract<RuntimeReplicaDeletionAuthorizationV1, { domain: "persistent" }>["tombstone"] | null;
	readonly leaseId: RuntimeLeaseId | null;
	readonly commands: ReadonlyMap<string, DeletionCommandEvidence>;
};
type PendingDeletionState = {
	readonly fingerprint: Sha256Hex;
	readonly result: Extract<Awaited<ReturnType<RuntimeProvider["deleteReplica"]>>, { status: "cleanup_pending" }>;
};

const now = (): ISO8601 => new Date().toISOString();
const digest = (tuple: readonly unknown[]): Sha256Hex =>
	createHash("sha256")
		.update(encodeCanonicalRuntimeTupleV1(tuple as readonly CanonicalRuntimeValue[]))
		.digest("hex") as Sha256Hex;
const shaRef = (tuple: readonly unknown[]): Sha256Ref => `sha256:${digest(tuple)}` as Sha256Ref;
const rawSha256 = (bytes: Buffer): Sha256Hex => createHash("sha256").update(bytes).digest("hex") as Sha256Hex;
const tokenDigest = (token: string): Sha256Hex => rawSha256(Buffer.from(token, "utf8"));
const key = (replica: RuntimeReplicaRef): string =>
	`${replica.providerId}\0${replica.profileId}\0${replica.workspaceId}\0${replica.replicaId}`;
const sameReplica = (left: RuntimeReplicaRef, right: RuntimeReplicaRef): boolean => key(left) === key(right);
const checkpointTuple = (checkpoint: {
	workspaceId: string;
	generation: number;
	rootSha256: string;
	fileCount: number;
	byteCount: number;
	committedAt: string;
}): readonly unknown[] => [
	checkpoint.workspaceId,
	checkpoint.generation,
	checkpoint.rootSha256,
	checkpoint.fileCount,
	checkpoint.byteCount,
	checkpoint.committedAt,
];
function providerRequest(request: RuntimeProviderRequestIdentity): RuntimeProviderRequestIdentity {
	return { requestId: request.requestId, requestSha256: request.requestSha256 };
}

function transitionRequest(
	request: RuntimeTransitionProviderRequestIdentity,
): RuntimeTransitionProviderRequestIdentity {
	return {
		requestId: request.requestId,
		requestSha256: request.requestSha256,
		transitionId: request.transitionId,
	};
}

function parentOperationRequest(
	request: RuntimeParentOperationProviderRequestIdentity,
): RuntimeParentOperationProviderRequestIdentity {
	return {
		requestId: request.requestId,
		requestSha256: request.requestSha256,
		parentOperationId: request.parentOperationId,
	};
}

function replayPushResult(
	result: Awaited<ReturnType<RuntimeProvider["push"]>>,
): Awaited<ReturnType<RuntimeProvider["push"]>> {
	return { ...result, status: "already_materialized" };
}

function replayQuiesceResult(
	result: Awaited<ReturnType<RuntimeProvider["quiesce"]>>,
): Awaited<ReturnType<RuntimeProvider["quiesce"]>> {
	return { ...result, status: "already_quiesced" };
}

function replayCheckpointResult(
	result: Awaited<ReturnType<RuntimeProvider["checkpoint"]>>,
): Awaited<ReturnType<RuntimeProvider["checkpoint"]>> {
	return { ...result, status: "already_checkpointed" };
}

function replayRecoveryFreezeResult(
	result: Awaited<ReturnType<RuntimeProvider["recoveryFreeze"]>>,
): Awaited<ReturnType<RuntimeProvider["recoveryFreeze"]>> {
	if ("proof" in result) return { status: "already_proved_impossible", proof: result.proof };
	return { ...result, status: "already_frozen" };
}

function replayCheckpointAcknowledgementResult(
	result: Awaited<ReturnType<RuntimeProvider["acknowledgeCheckpoint"]>>,
): Awaited<ReturnType<RuntimeProvider["acknowledgeCheckpoint"]>> {
	return { ...result, status: "already_acknowledged" };
}

function replayRevokeResult(
	result: Awaited<ReturnType<RuntimeProvider["revoke"]>>,
): Awaited<ReturnType<RuntimeProvider["revoke"]>> {
	return result.status === "revoked" ? { ...result, status: "already_revoked" } : result;
}

function replayReleaseResult(
	result: Awaited<ReturnType<RuntimeProvider["release"]>>,
): Awaited<ReturnType<RuntimeProvider["release"]>> {
	return result.status === "released" ? { ...result, status: "already_released" } : result;
}

function replayDeletionResult(result: TerminalDeletionResult): TerminalDeletionResult {
	return result.status === "deleted" ? { ...result, status: "already_deleted" } : result;
}

function image(snapshot: WorkspaceSnapshot): WorkspaceImage {
	return {
		rootSha256: snapshot.checkpoint.rootSha256,
		fileCount: snapshot.checkpoint.fileCount,
		byteCount: snapshot.checkpoint.byteCount,
	};
}

function exactValue(value: unknown, omitted: ReadonlySet<string>): CanonicalRuntimeValue {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
		return value;
	}
	if (Array.isArray(value)) return value.map(item => exactValue(item, omitted));
	if (value && typeof value === "object") {
		return [
			"object",
			Object.keys(value)
				.filter(name => !omitted.has(name))
				.sort()
				.map(name => [name, exactValue((value as Record<string, unknown>)[name], omitted)]),
		];
	}
	if (value === undefined) return ["undefined"];
	throw new Error("request_conflict");
}

function exactDigest(value: unknown, omitted: readonly string[] = ["signal"]): Sha256Hex {
	return digest(["local-provider-ledger-v1", exactValue(value, new Set(omitted))]);
}

function sameExact(left: unknown, right: unknown): boolean {
	return exactDigest(left, []) === exactDigest(right, []);
}

function modelSegments(modelPath: string): string[] {
	if (modelPath === "/workspace") return [];
	if (!modelPath.startsWith("/workspace/")) throw new Error("runtime_path_rejected");
	const segments = modelPath.slice("/workspace/".length).split("/");
	if (segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
		throw new Error("runtime_path_rejected");
	}
	return segments;
}

function validPolicy(policy: LocalIsolationPolicyV1): boolean {
	return (
		((process.platform === "darwin" &&
			policy.driverId === "darwin-sandbox-exec-v1" &&
			policy.commandEnvironment === "omp-runtime-scrubbed-v1" &&
			policy.network === "none" &&
			policy.writableRootClass === "replica_only" &&
			policy.readonlyRootSet === "darwin-system-v1" &&
			policy.runtimeSupportSet === "darwin-device-paths-v1") ||
			(process.platform === "linux" &&
			policy.driverId === "linux-bubblewrap-v1" &&
			policy.commandEnvironment === "omp-runtime-scrubbed-v1" &&
			policy.network === "none" &&
			policy.writableRootClass === "replica_only" &&
			policy.readonlyRootSet === "linux-system-v1" &&
			policy.runtimeSupportSet === "linux-private-dev-proc-v1")) &&
		policy.temporaryDirectory === "/workspace" &&
		policy.hostHomeAccess === "denied" &&
		policy.controlDataAccess === "denied"
	);
}

function defaultAvailability(): LocalIsolationAvailabilityV1 {
	if (process.platform === "darwin")
		return existsSync("/usr/bin/sandbox-exec")
			? {
					availability: "available",
					policy: {
						driverId: "darwin-sandbox-exec-v1",
						commandEnvironment: "omp-runtime-scrubbed-v1",
						network: "none",
						writableRootClass: "replica_only",
						readonlyRootSet: "darwin-system-v1",
						runtimeSupportSet: "darwin-device-paths-v1",
						temporaryDirectory: "/workspace",
						hostHomeAccess: "denied",
						controlDataAccess: "denied",
					},
				}
			: { availability: "unavailable", code: "local_sandbox_driver_missing" };
	if (process.platform === "linux")
		return existsSync("/usr/bin/bwrap")
			? {
					availability: "available",
					policy: {
						driverId: "linux-bubblewrap-v1",
						commandEnvironment: "omp-runtime-scrubbed-v1",
						network: "none",
						writableRootClass: "replica_only",
						readonlyRootSet: "linux-system-v1",
						runtimeSupportSet: "linux-private-dev-proc-v1",
						temporaryDirectory: "/workspace",
						hostHomeAccess: "denied",
						controlDataAccess: "denied",
					},
				}
			: { availability: "unavailable", code: "local_sandbox_driver_missing" };
	return { availability: "unavailable", code: "local_sandbox_unsupported_platform" };
}

async function nestedFile(root: string, depth = 4): Promise<string | null> {
	try {
		for (const entry of await readdir(root, { withFileTypes: true })) {
			const path = join(root, entry.name);
			if (entry.isFile()) return path;
			if (depth > 0 && entry.isDirectory() && entry.name !== ".git" && entry.name !== "node_modules") {
				const child = await nestedFile(path, depth - 1);
				if (child) return child;
			}
		}
	} catch {}
	return null;
}

function environment(): Record<string, string> {
	return Object.fromEntries(PERSISTENT_RUNTIME_PROVIDER_ENVIRONMENT_V1.map(({ name, value }) => [name, value]));
}

function boundedInteger(value: number, maximum: number, allowZero = true): number {
	if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum)
		throw new Error("runtime_limit_rejected");
	return value;
}

function encodeCursor(kind: "list" | "search", query: Sha256Hex, offset: number): string {
	return Buffer.from(JSON.stringify([kind, query, offset]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null, kind: "list" | "search", query: Sha256Hex): number {
	if (cursor === null) return 0;
	if (cursor.length > 512) throw new Error("runtime_request_rejected");
	try {
		const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			!Array.isArray(parsed) ||
			parsed.length !== 3 ||
			parsed[0] !== kind ||
			parsed[1] !== query ||
			!Number.isSafeInteger(parsed[2]) ||
			(parsed[2] as number) < 0
		)
			throw new Error();
		return parsed[2] as number;
	} catch {
		throw new Error("runtime_request_rejected");
	}
}

const BRIDGE_HELPER_SOURCE = String.raw`
import base64, ctypes, errno, fnmatch, hashlib, json, os, re, socket, stat, sys
MODEL_ROOT = "/workspace"
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)
CLOEXEC = getattr(os, "O_CLOEXEC", 0)
O_PATH = getattr(os, "O_PATH", 0)
LANDLOCK_CREATE_RULESET = 444
LANDLOCK_ADD_RULE = 445
LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38
ACCESS_EXECUTE = 1 << 0
ACCESS_WRITE_FILE = 1 << 1
ACCESS_READ_FILE = 1 << 2
ACCESS_READ_DIR = 1 << 3
ACCESS_IOCTL_DEV = 1 << 15
BASE_FS_RIGHTS = (1 << 13) - 1
PRIVATE_DEVICE_PATHS = ("/dev/null", "/dev/zero", "/dev/random", "/dev/urandom")
PRIVATE_PROC_PATH = "/proc/self/status"

class LandlockRulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]

class LandlockPathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

LIBC = None
if sys.platform.startswith("linux"):
    LIBC = ctypes.CDLL(None, use_errno=True)
    LIBC.syscall.restype = ctypes.c_long
    LIBC.prctl.restype = ctypes.c_int

def checked(result):
    if result >= 0:
        return result
    code = ctypes.get_errno()
    raise OSError(code, os.strerror(code))

def create_landlock_ruleset(access):
    attributes = LandlockRulesetAttr(access)
    return checked(LIBC.syscall(
        ctypes.c_long(LANDLOCK_CREATE_RULESET),
        ctypes.byref(attributes),
        ctypes.c_size_t(ctypes.sizeof(attributes)),
        ctypes.c_uint32(0),
    ))

def supported_filesystem_rights():
    abi = checked(LIBC.syscall(
        ctypes.c_long(LANDLOCK_CREATE_RULESET),
        ctypes.c_void_p(),
        ctypes.c_size_t(0),
        ctypes.c_uint32(LANDLOCK_CREATE_RULESET_VERSION),
    ))
    if abi < 1:
        raise OSError(errno.ENOSYS, "Landlock unavailable")
    rights = 0
    for bit in range(64):
        candidate = 1 << bit
        try:
            descriptor = create_landlock_ruleset(candidate)
        except OSError as error:
            if error.errno in (errno.EINVAL, errno.ENOMSG):
                continue
            raise
        os.close(descriptor)
        rights |= candidate
    if rights & BASE_FS_RIGHTS != BASE_FS_RIGHTS:
        raise OSError(errno.EOPNOTSUPP, "Landlock filesystem rights unavailable")
    return rights

def add_landlock_path(ruleset, path, access, seen):
    descriptor = os.open(path, O_PATH | CLOEXEC)
    try:
        info = os.fstat(descriptor)
        identity = (info.st_dev, info.st_ino)
        if identity in seen:
            return
        attributes = LandlockPathBeneathAttr(access, descriptor)
        checked(LIBC.syscall(
            ctypes.c_long(LANDLOCK_ADD_RULE),
            ctypes.c_int(ruleset),
            ctypes.c_int(LANDLOCK_RULE_PATH_BENEATH),
            ctypes.byref(attributes),
            ctypes.c_uint32(0),
        ))
        seen.add(identity)
    finally:
        os.close(descriptor)

def install_filesystem_confinement():
    handled = supported_filesystem_rights()
    ruleset = create_landlock_ruleset(handled)
    try:
        seen = set()
        add_landlock_path(ruleset, MODEL_ROOT, handled, seen)
        readonly = handled & (ACCESS_EXECUTE | ACCESS_READ_FILE | ACCESS_READ_DIR)
        for path in READONLY_ROOTS:
            add_landlock_path(ruleset, path, readonly, seen)
        devices = handled & (ACCESS_WRITE_FILE | ACCESS_READ_FILE | ACCESS_IOCTL_DEV)
        for path in PRIVATE_DEVICE_PATHS:
            add_landlock_path(ruleset, path, devices, seen)
        add_landlock_path(ruleset, PRIVATE_PROC_PATH, handled & ACCESS_READ_FILE, seen)
        if LIBC.prctl(
            ctypes.c_int(PR_SET_NO_NEW_PRIVS),
            ctypes.c_ulong(1),
            ctypes.c_ulong(0),
            ctypes.c_ulong(0),
            ctypes.c_ulong(0),
        ) != 0:
            code = ctypes.get_errno()
            raise OSError(code, os.strerror(code))
        checked(LIBC.syscall(
            ctypes.c_long(LANDLOCK_RESTRICT_SELF),
            ctypes.c_int(ruleset),
            ctypes.c_uint32(0),
        ))
    finally:
        os.close(ruleset)


def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")))

def fail(code):
    emit({"error": code})
    raise SystemExit(2)

def parts(path):
    if path == MODEL_ROOT:
        return []
    if not isinstance(path, str) or not path.startswith(MODEL_ROOT + "/"):
        fail("runtime_path_rejected")
    value = path[len(MODEL_ROOT) + 1:].split("/")
    if any(not item or item in (".", "..") or "\0" in item for item in value):
        fail("runtime_path_rejected")
    return value

def open_dir(components, create=False):
    current = os.dup(ROOT_FD)
    try:
        for component in components:
            try:
                child = os.open(component, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(component, 0o700, dir_fd=current)
                child = os.open(component, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC, dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise

def parent_and_name(path, create=False):
    components = parts(path)
    if not components:
        fail("runtime_root_operation_rejected")
    return open_dir(components[:-1], create), components[-1]

def lstat_path(path):
    components = parts(path)
    if not components:
        return os.fstat(ROOT_FD)
    parent = open_dir(components[:-1])
    try:
        return os.stat(components[-1], dir_fd=parent, follow_symlinks=False)
    finally:
        os.close(parent)

def open_file(path):
    parent, name = parent_and_name(path)
    try:
        descriptor = os.open(name, os.O_RDONLY | NOFOLLOW | CLOEXEC, dir_fd=parent)
    finally:
        os.close(parent)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode):
        os.close(descriptor)
        fail("runtime_file_required")
    return descriptor, info

def read_all(descriptor, limit=None):
    chunks, remaining = [], limit
    while remaining is None or remaining > 0:
        chunk = os.read(descriptor, 65536 if remaining is None else min(65536, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        if remaining is not None:
            remaining -= len(chunk)
    return b"".join(chunks)

def atomic_write(path, content):
    parent, name = parent_and_name(path, True)
    temporary = ".omp-write-%d-%s" % (os.getpid(), os.urandom(8).hex())
    descriptor = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | CLOEXEC, 0o600, dir_fd=parent)
        offset = 0
        while offset < len(content):
            offset += os.write(descriptor, content[offset:])
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.rename(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)

def remove_entry(parent, name, recursive):
    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISDIR(info.st_mode):
        if not recursive:
            os.rmdir(name, dir_fd=parent)
            return
        child = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC, dir_fd=parent)
        try:
            for entry in os.listdir(child):
                remove_entry(child, entry, True)
        finally:
            os.close(child)
        current = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            fail("runtime_path_changed")
        os.rmdir(name, dir_fd=parent)
    else:
        os.unlink(name, dir_fd=parent)

def clear_root():
    for name in os.listdir(ROOT_FD):
        remove_entry(ROOT_FD, name, True)

def walk(directory_fd, model_path, include_directories=True):
    for name in sorted(os.listdir(directory_fd)):
        info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        child_path = model_path + "/" + name
        if stat.S_ISLNK(info.st_mode):
            yield child_path, "symlink", None
        elif stat.S_ISDIR(info.st_mode):
            if include_directories:
                yield child_path, "directory", None
            child = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC, dir_fd=directory_fd)
            try:
                yield from walk(child, child_path, include_directories)
            finally:
                os.close(child)
        elif stat.S_ISREG(info.st_mode):
            yield child_path, "file", info.st_size
        else:
            yield child_path, "other", None

def iter_files(path):
    info = lstat_path(path)
    if stat.S_ISREG(info.st_mode):
        yield path
    elif stat.S_ISDIR(info.st_mode):
        directory = open_dir(parts(path))
        try:
            for child_path, kind, _ in walk(directory, path, False):
                if kind == "file":
                    yield child_path
                elif kind != "directory":
                    fail("runtime_snapshot_invalid")
        finally:
            os.close(directory)
    else:
        fail("runtime_snapshot_invalid")

def snapshot_files():
    files = []
    for path in iter_files(MODEL_ROOT):
        descriptor, _ = open_file(path)
        try:
            raw = read_all(descriptor)
        finally:
            os.close(descriptor)
        try:
            content = raw.decode("utf-8", "strict")
        except UnicodeDecodeError:
            fail("runtime_snapshot_invalid")
        files.append({"path": path[len(MODEL_ROOT) + 1:], "contentUtf8": content})
    return files

def materialize(request):
    prepared, seen = [], set()
    if not isinstance(request.get("files"), list):
        fail("runtime_snapshot_invalid")
    for item in request["files"]:
        if not isinstance(item, dict) or set(item) != {"path", "contentUtf8", "sha256", "byteLength"}:
            fail("runtime_snapshot_invalid")
        relative = item["path"]
        path = MODEL_ROOT + "/" + relative
        parts(path)
        if relative in seen or not isinstance(item["contentUtf8"], str):
            fail("runtime_snapshot_invalid")
        seen.add(relative)
        content = item["contentUtf8"].encode("utf-8")
        if len(content) != item["byteLength"] or hashlib.sha256(content).hexdigest() != item["sha256"]:
            fail("runtime_snapshot_invalid")
        prepared.append((path, content))
    clear_root()
    for path, content in prepared:
        atomic_write(path, content)
    return {"files": snapshot_files()}

def read_text(request):
    descriptor, _ = open_file(request["path"])
    try:
        if request["line"] is None:
            content = read_all(descriptor, request["byteLimit"])
        else:
            raw = read_all(descriptor, request["scanByteLimit"])
            lines = raw.decode("utf-8", "replace").split("\n")
            start = request["line"]
            stop = None if request["limit"] is None else start + request["limit"]
            content = "\n".join(lines[start:stop]).encode("utf-8")[:request["byteLimit"]]
    finally:
        os.close(descriptor)
    return {"contentBase64": base64.b64encode(content).decode("ascii")}

def read_binary(request):
    descriptor, info = open_file(request["path"])
    try:
        os.lseek(descriptor, request["offset"], os.SEEK_SET)
        content = read_all(descriptor, request["byteLimit"])
    finally:
        os.close(descriptor)
    return {"contentBase64": base64.b64encode(content).decode("ascii"), "truncated": request["offset"] + len(content) < info.st_size}

def write(request):
    content = base64.b64decode(request["contentBase64"], validate=True)
    if hashlib.sha256(content).hexdigest() != request["contentSha256"]:
        fail("request_conflict")
    atomic_write(request["path"], content)
    return {"status": "written", "sha256": request["contentSha256"], "byteLength": len(content)}

def exists(request):
    try:
        lstat_path(request["path"])
        return {"exists": True}
    except FileNotFoundError:
        return {"exists": False}

def file_stat(request):
    info = lstat_path(request["path"])
    if stat.S_ISREG(info.st_mode):
        descriptor, _ = open_file(request["path"])
        checksum = hashlib.sha256()
        try:
            while True:
                chunk = os.read(descriptor, 65536)
                if not chunk:
                    break
                checksum.update(chunk)
        finally:
            os.close(descriptor)
        return {"kind": "file", "byteLength": info.st_size, "sha256": checksum.hexdigest()}
    if stat.S_ISDIR(info.st_mode):
        kind = "directory"
    elif stat.S_ISLNK(info.st_mode):
        kind = "symlink"
    else:
        kind = "other"
    return {"kind": kind, "byteLength": None, "sha256": None}

def make_directory(request):
    components = parts(request["path"])
    if not components:
        return {"status": "already_exists"}
    if request["recursive"]:
        directory = open_dir(components, True)
        os.close(directory)
        return {"status": "created"}
    parent, name = parent_and_name(request["path"])
    try:
        try:
            os.mkdir(name, 0o700, dir_fd=parent)
            return {"status": "created"}
        except FileExistsError:
            if not stat.S_ISDIR(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode):
                fail("runtime_directory_required")
            return {"status": "already_exists"}
    finally:
        os.close(parent)

def remove(request):
    parent, name = parent_and_name(request["path"])
    try:
        try:
            remove_entry(parent, name, request["recursive"])
            return {"status": "removed"}
        except FileNotFoundError:
            return {"status": "already_absent"}
    finally:
        os.close(parent)

def rename(request):
    source_parent, source_name = parent_and_name(request["from"])
    destination_parent, destination_name = parent_and_name(request["to"])
    try:
        source = os.stat(source_name, dir_fd=source_parent, follow_symlinks=False)
        current = os.stat(source_name, dir_fd=source_parent, follow_symlinks=False)
        if (source.st_dev, source.st_ino) != (current.st_dev, current.st_ino):
            fail("runtime_path_changed")
        os.rename(source_name, destination_name, src_dir_fd=source_parent, dst_dir_fd=destination_parent)
        return {"status": "renamed"}
    finally:
        os.close(source_parent)
        os.close(destination_parent)

def list_files(request):
    directory, entries, matched_count = open_dir(parts(request["directory"])), [], 0
    try:
        for path, kind, byte_length in walk(directory, request["directory"]):
            if kind == "other":
                continue
            relative, name = path[len(MODEL_ROOT) + 1:], path.rsplit("/", 1)[-1]
            pattern = request["pattern"]
            matched = fnmatch.fnmatchcase(relative, pattern) or fnmatch.fnmatchcase(name, pattern)
            matched = matched or (pattern.startswith("**/") and fnmatch.fnmatchcase(relative, pattern[3:]))
            if not matched:
                continue
            if matched_count < request["offset"]:
                matched_count += 1
                continue
            entries.append({"path": path, "kind": kind, "byteLength": byte_length})
            matched_count += 1
            if len(entries) > request["limit"]:
                break
    finally:
        os.close(directory)
    more = len(entries) > request["limit"]
    if more:
        entries.pop()
    return {"entries": entries, "nextOffset": request["offset"] + len(entries) if more else None}

def search(request):
    options = (re.IGNORECASE if "i" in request["flags"] else 0) | (re.MULTILINE if "m" in request["flags"] else 0) | (re.DOTALL if "s" in request["flags"] else 0)
    expression, matches, matched_count = re.compile(request["pattern"], options), [], 0
    for path in iter_files(request["path"]):
        descriptor, info = open_file(path)
        try:
            if info.st_size > request["scanByteLimit"]:
                fail("runtime_limit_rejected")
            text = read_all(descriptor).decode("utf-8", "replace")
        finally:
            os.close(descriptor)
        for match in expression.finditer(text):
            if matched_count < request["offset"]:
                matched_count += 1
                continue
            start = match.start()
            line_start = text.rfind("\n", 0, start) + 1
            line_end = text.find("\n", start)
            if line_end < 0:
                line_end = len(text)
            matches.append({
                "path": path,
                "line": text.count("\n", 0, start) + 1,
                "column": start - line_start + 1,
                "text": text[line_start:line_end],
            })
            matched_count += 1
            if len(matches) > request["limit"]:
                return {"matches": matches[:-1], "nextOffset": request["offset"] + request["limit"]}
    return {"matches": matches, "nextOffset": None}

def probe(request):
    if sys.platform.startswith("linux"):
        install_filesystem_confinement()
    if request["parentVariable"] in os.environ:
        fail("probe_environment_not_scrubbed")
    probe_path = MODEL_ROOT + "/probe/nested/file"
    atomic_write(probe_path, b"probe")
    descriptor, _ = open_file(probe_path)
    try:
        if read_all(descriptor) != b"probe":
            fail("probe_workspace_open_failed")
    finally:
        os.close(descriptor)
    with open("/bin/bash", "rb") as support:
        if not support.read(1):
            fail("probe_support_read_failed")
    if sys.platform.startswith("linux"):
        with open(PRIVATE_PROC_PATH, "rb") as private_proc:
            if not private_proc.readline().startswith(b"Name:"):
                fail("probe_private_proc_read_failed")
    if sys.platform.startswith("linux"):
        proc_bases = (
            "/proc/1",
            "/proc/self",
            "/proc/thread-self",
            "/proc/%d" % os.getpid(),
            "/proc/%d/task/%d" % (os.getpid(), os.getpid()),
        )
        for base in proc_bases:
            for name in ("mountinfo", "mounts", "mountstats"):
                try:
                    with open(base + "/" + name, "rb") as metadata:
                        metadata.read(1)
                except OSError:
                    pass
                else:
                    fail("probe_mount_metadata_read_allowed")
    try:
        descriptor = os.open("/bin/.omp-local-probe-write", os.O_WRONLY | os.O_CREAT, 0o600)
    except OSError:
        pass
    else:
        os.close(descriptor)
        fail("probe_support_write_allowed")
    for denied in (request["homeCanary"], request["controlCanary"], request["outsideCanary"]):
        try:
            with open(denied, "rb") as source:
                source.read(1)
        except OSError:
            pass
        else:
            fail("probe_host_read_allowed")
    for operation in ("connect", "bind"):
        candidate = None
        try:
            candidate = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            candidate.settimeout(0.2)
            if operation == "connect":
                candidate.connect(("127.0.0.1", request["connectPort"]))
            else:
                candidate.bind(("127.0.0.1", 0))
        except OSError:
            pass
        else:
            fail("probe_network_allowed")
        finally:
            if candidate is not None:
                candidate.close()
    return {"ok": True}

def execute(request):
    directory = open_dir(parts(request["cwd"]))
    os.fchdir(directory)
    os.close(directory)
    if sys.platform.startswith("linux"):
        install_filesystem_confinement()
    source = re.sub(r"(?<![A-Za-z0-9_])" + re.escape(MODEL_ROOT) + r"(?=$|/)", ROOT, request["source"])
    os.environ["PWD"] = request["cwd"]
    os.execve("/bin/bash", ["/bin/bash", "--noprofile", "--norc", "-c", source], os.environ)

OPERATIONS = {
    "materialize": materialize,
    "snapshot": lambda request: {"files": snapshot_files()},
    "read_text": read_text,
    "read_binary": read_binary,
    "write": write,
    "exists": exists,
    "stat": file_stat,
    "mkdir": make_directory,
    "remove": remove,
    "rename": rename,
    "list": list_files,
    "search": search,
    "probe": probe,
    "exec": execute,
}
try:
    REQUEST = json.loads(base64.b64decode(sys.argv[1], validate=True))
    ROOT = REQUEST.pop("root")
    MODEL_ROOT = REQUEST.pop("modelRoot")
    READONLY_ROOTS = REQUEST.pop("readOnlyRoots")
    if (
        not NOFOLLOW
        or (sys.platform.startswith("linux") and not O_PATH)
        or not isinstance(ROOT, str)
        or not ROOT.startswith("/")
        or "\0" in ROOT
        or MODEL_ROOT != "/workspace"
        or not isinstance(READONLY_ROOTS, list)
        or any(not isinstance(path, str) or not path.startswith("/") or "\0" in path for path in READONLY_ROOTS)
    ):
        fail("runtime_helper_unsupported")
    READONLY_ROOTS = tuple(READONLY_ROOTS)
    ROOT_FD = os.open(ROOT, os.O_RDONLY | DIRECTORY | NOFOLLOW | CLOEXEC)
    try:
        operation = OPERATIONS.get(REQUEST.pop("op", None))
        if operation is None:
            fail("runtime_operation_rejected")
        result = operation(REQUEST)
        if result is not None:
            emit(result)
    finally:
        os.close(ROOT_FD)
except SystemExit:
    raise
except (OSError, ValueError, TypeError, UnicodeError, re.error):
    fail("runtime_path_unsafe")
`;

function seccompFilter(): Buffer {
	const auditArch = process.arch === "arm64" ? 0xc00000b7 : process.arch === "x64" ? 0xc000003e : null;
	const denied =
		process.arch === "arm64"
			? [198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 242, 243, 269, 425, 426, 427]
			: process.arch === "x64"
				? [41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 288, 299, 307, 425, 426, 427]
				: null;
	if (auditArch === null || denied === null) throw new Error("local_sandbox_unsupported_platform");
	const instructions: number[][] = [
		[0x20, 0, 0, 4],
		[0x15, 1, 0, auditArch],
		[0x06, 0, 0, 0x80000000],
		[0x20, 0, 0, 0],
	];
	if (process.arch === "x64") instructions.push([0x35, 0, 1, 0x40000000], [0x06, 0, 0, 0x00050001]);
	for (const syscall of denied) instructions.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]);
	instructions.push([0x06, 0, 0, 0x7fff0000]);
	const filter = Buffer.alloc(instructions.length * 8);
	for (let index = 0; index < instructions.length; index++) {
		const [code, jumpTrue, jumpFalse, value] = instructions[index]!;
		const offset = index * 8;
		filter.writeUInt16LE(code!, offset);
		filter.writeUInt8(jumpTrue!, offset + 2);
		filter.writeUInt8(jumpFalse!, offset + 3);
		filter.writeUInt32LE(value! >>> 0, offset + 4);
	}
	return filter;
}

function sandboxLiteral(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function sandbox(root: string, file: string, args: readonly string[]) {
	if (process.platform === "darwin") {
		const literal = sandboxLiteral(root);
		const pythonSupport =
			DARWIN_HELPER_PYTHON && file === DARWIN_HELPER_PYTHON.executable
				? [`(allow file-read* (subpath "${sandboxLiteral(DARWIN_HELPER_PYTHON.frameworkRoot)}"))`]
				: [];
		const pythonMetadata =
			DARWIN_HELPER_PYTHON?.developerRoot === "/Applications/Xcode.app/Contents/Developer"
				? [
					"(allow file-read-metadata (literal \"/Applications\"))",
					"(allow file-read-metadata (subpath \"/Applications/Xcode.app\"))",
				]
				: DARWIN_HELPER_PYTHON?.developerRoot === "/Library/Developer/CommandLineTools"
					? [
						"(allow file-read-metadata (literal \"/Library\"))",
						"(allow file-read-metadata (subpath \"/Library/Developer/CommandLineTools\"))",
					]
					: [];
		const readonly = DARWIN_LOCAL_READONLY_SYSTEM_ROOTS_V1.filter(existsSync).map(
			path => `(allow file-read* (subpath "${sandboxLiteral(path)}"))`,
		);
		const devices = DARWIN_LOCAL_DEVICE_PATHS_V1.filter(existsSync).map(path =>
			path === "/dev/fd"
				? `(allow file-read* (subpath "${sandboxLiteral(path)}"))`
				: `(allow file-read* (literal "${sandboxLiteral(path)}"))`,
		);
		return {
			file: "/usr/bin/sandbox-exec",
			args: [
				"-p",
				[
					"(version 1)",
					"(deny default)",
					"(deny network*)",
					"(allow process-fork)",
					"(allow process-exec)",
					"(allow file-read* (literal \"/\"))",
					...pythonMetadata,
					`(allow file-read* (subpath "${literal}"))`,
					`(allow file-write* (subpath "${literal}"))`,
					...pythonSupport,
					...readonly,
					...devices,
				].join("\n"),
				file,
				...args,
			],
			cwd: root,
			env: environment(),
			seccomp: null,
		};
	}
	if (process.platform !== "linux") throw new Error("local_sandbox_probe_failed");
	const readOnlyBinds = LINUX_LOCAL_READONLY_SYSTEM_ROOTS_V1.filter(existsSync).flatMap(path => [
		"--ro-bind",
		path,
		path,
	]);
	return {
		file: "/usr/bin/bwrap",
		args: [
			"--die-with-parent",
			"--unshare-net",
			"--unshare-pid",
			"--unshare-ipc",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			...readOnlyBinds,
			"--bind",
			root,
			"/workspace",
			"--chdir",
			"/workspace",
			"--seccomp",
			"3",
			file,
			...args,
		],
		cwd: root,
		env: environment(),
		seccomp: seccompFilter(),
	};
}

type IsolatedOutcome = {
	readonly output: Buffer;
	readonly code: number | null;
	readonly signal: string | null;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
};
type IsolatedExecution = {
	readonly outcome: Promise<IsolatedOutcome>;
	terminateAndReap(signal: NodeJS.Signals): Promise<boolean>;
};

function startIsolated(
	root: string,
	file: string,
	args: readonly string[],
	timeoutMs: number,
	outputByteLimit: number,
): IsolatedExecution {
	const launch = sandbox(root, file, args);
	const child = spawn(launch.file, launch.args, {
		cwd: launch.cwd,
		env: launch.env,
		stdio: launch.seccomp ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
		detached: true,
	});
	const seccomp = launch.seccomp ? (child.stdio[3] as Writable | null) : null;
	if (!child.stdout || !child.stderr || (launch.seccomp && !seccomp)) {
		child.kill("SIGKILL");
		throw new Error("local_sandbox_launch_failed");
	}
	if (seccomp) {
		seccomp.on("error", () => {});
		seccomp.end(launch.seccomp!);
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	const collect = (value: Buffer | string): void => {
		const remaining = Math.max(0, outputByteLimit + 1 - bytes);
		if (remaining === 0) return;
		const chunk = Buffer.from(value).subarray(0, remaining);
		chunks.push(chunk);
		bytes += chunk.length;
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);
	let closed = false;
	let cancelled = false;
	const launchError = new Promise<never>((_, reject) => child.once("error", reject));
	const close = new Promise<void>(resolve => {
		child.once("close", () => {
			closed = true;
			resolve();
		});
	});
	const killTree = (signal: NodeJS.Signals): void => {
		if (child.pid === undefined) return;
		try {
			process.kill(-child.pid, signal);
		} catch {}
		try {
			process.kill(child.pid, signal);
		} catch {}
	};
	const waitForClose = (deadlineMs: number): Promise<boolean> => {
		if (closed) return Promise.resolve(true);
		return new Promise(resolve => {
			let settled = false;
			const finish = (reaped: boolean): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(reaped);
			};
			const timer = setTimeout(() => finish(false), deadlineMs);
			void close.then(() => finish(true));
		});
	};
	let termination: Promise<boolean> | null = null;
	const terminateAndReap = (signal: NodeJS.Signals): Promise<boolean> => {
		if (closed) return Promise.resolve(true);
		cancelled = true;
		killTree(signal);
		if (termination) return termination;
		const attempt = (async () => {
			if (signal !== "SIGKILL" && (await waitForClose(PROCESS_TERM_GRACE_MS))) return true;
			if (!closed) killTree("SIGKILL");
			return waitForClose(PROCESS_REAP_DEADLINE_MS);
		})();
		termination = attempt;
		return attempt;
	};
	const outcome = (async (): Promise<IsolatedOutcome> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const exited = await Promise.race([
			close.then(() => true),
			launchError,
			new Promise<false>(resolve => {
				timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
			}),
		]);
		clearTimeout(timer);
		const timedOut = !exited;
		if (timedOut && !(await terminateAndReap("SIGTERM"))) throw new Error("local_process_reap_timeout");
		const output = Buffer.concat(chunks);
		return {
			output:
				process.platform === "darwin"
					? Buffer.from(output.toString("utf8").replaceAll(root, "/workspace"), "utf8")
					: output,
			code: child.exitCode,
			signal: child.signalCode,
			timedOut,
			cancelled,
		};
	})();
	return { outcome, terminateAndReap };
}

async function isolated(
	root: string,
	file: string,
	args: readonly string[],
	timeoutMs: number,
	outputByteLimit: number,
): Promise<IsolatedOutcome> {
	return startIsolated(root, file, args, timeoutMs, outputByteLimit).outcome;
}

function helperPayload(root: string, request: Record<string, unknown>): string {
	return Buffer.from(
		JSON.stringify({
			...request,
			root: process.platform === "darwin" ? root : "/workspace",
			modelRoot: "/workspace",
			readOnlyRoots:
				(process.platform === "darwin" ? DARWIN_LOCAL_READONLY_SYSTEM_ROOTS_V1 : LINUX_LOCAL_READONLY_SYSTEM_ROOTS_V1).filter(
					existsSync,
				),
		}),
		"utf8",
	).toString("base64");
}

async function sandboxedHelper<T>(
	root: string,
	request: Record<string, unknown>,
	outputByteLimit = MAX_BRIDGE_OUTPUT_BYTES,
	_deniedReadFiles: readonly string[] = [],
): Promise<T> {
	const outcome = await isolated(
		root,
		LOCAL_HELPER_PYTHON,
		["-I", "-S", "-c", BRIDGE_HELPER_SOURCE, helperPayload(root, request)],
		HELPER_TIMEOUT_MS,
		outputByteLimit,
	);
	if (outcome.timedOut || outcome.signal || outcome.code !== 0 || outcome.output.length > outputByteLimit)
		throw new Error("runtime_bridge_helper_failed");
	let result: unknown;
	try {
		result = JSON.parse(outcome.output.toString("utf8"));
	} catch {
		throw new Error("runtime_bridge_helper_failed");
	}
	if (result && typeof result === "object" && "error" in result) {
		const code = (result as { error: unknown }).error;
		throw new Error(typeof code === "string" ? code : "runtime_bridge_helper_failed");
	}
	return result as T;
}

function sandboxedCommand(
	root: string,
	cwd: string,
	source: string,
	timeoutMs: number,
	outputByteLimit: number,
): IsolatedExecution {
	return startIsolated(
		root,
		LOCAL_HELPER_PYTHON,
		["-I", "-S", "-c", BRIDGE_HELPER_SOURCE, helperPayload(root, { op: "exec", cwd, source })],
		timeoutMs,
		outputByteLimit,
	);
}

export class LocalWorkspaceProvider implements RuntimeProvider {
	readonly id = PROVIDER_ID;
	readonly supportedLocations = ["local"] as const;
	readonly #availability: LocalIsolationAvailabilityV1;
	readonly #reservations = new Map<string, Reservation>();
	readonly #serials = new Map<string, Promise<void>>();
	readonly #effects = new Map<string, EffectLedger<unknown>>();
	readonly #inProgress = new Map<string, Sha256Hex>();
	readonly #cache = new Map<string, CacheState>();
	readonly #deletions = new Map<string, DeletionState>();
	readonly #pendingDeletions = new Map<string, PendingDeletionState>();
	readonly #acknowledgements = new Map<string, Awaited<ReturnType<RuntimeProvider["acknowledgeCheckpoint"]>>>();

	constructor(availability: LocalIsolationAvailabilityV1 = defaultAvailability()) {
		this.#availability = availability;
	}

	async discoverCandidates(
		...[_requirements]: Parameters<RuntimeProvider["discoverCandidates"]>
	): ReturnType<RuntimeProvider["discoverCandidates"]> {
		if (this.#availability.availability === "unavailable")
			return { status: "unavailable", code: this.#availability.code, candidates: [] };
		if (!validPolicy(this.#availability.policy) || !(await this.#probe()))
			return { status: "unavailable", code: "local_sandbox_probe_failed", candidates: [] };
		return {
			status: "available",
			candidates: [
				{
					providerId: this.id,
					profileId: PROFILE_ID,
					location: "local",
					capabilities: [
						"process.exec",
						"workspace.list",
						"workspace.read",
						"workspace.search",
						"workspace.write",
					],
					workspaceFormats: ["omp-text-v1"],
					os: process.platform === "darwin" ? "darwin" : "linux",
					arch: process.arch === "arm64" ? "arm64" : "x64",
					cpu: 1,
					memoryMiB: 1024,
					network: "none",
					available: true,
					estimatedIncrementalCostMicrosPerHour: 0,
					estimatedReadyLatencyMs: 0,
				},
			],
		};
	}

	async acquire(...[request]: Parameters<RuntimeProvider["acquire"]>): ReturnType<RuntimeProvider["acquire"]> {
		await this.#available();
		this.#acquireDigest(request);
		const replicaKey = key(request.plan.replica);
		const fingerprint = exactDigest(request, ["signal", "fence"]);
		return this.#exclusive(replicaKey, async () => {
			if (this.#deletions.has(replicaKey)) throw new Error("request_conflict");
			const existing = this.#reservations.get(replicaKey);
			if (existing) {
				if (
					existing.acquireRequestId !== request.requestId ||
					existing.acquireFingerprint !== fingerprint ||
					existing.domain !== request.plan.deletionAuthorityDomain
				)
					throw new Error("request_conflict");
				this.#fence(existing, request.fence);
				return this.#acquired(existing, request, "already_acquired");
			}
			const effectKey = this.#effectKey("acquire", request.plan.replica, request.requestId);
			this.#inProgress.set(effectKey, fingerprint);
			try {
				const acquiredAt = now();
				const lease = {
					leaseId: request.plan.leaseId,
					replica: request.plan.replica,
					fenceId: request.plan.fenceId,
					baseGeneration: request.plan.baseCheckpoint.generation,
					renewalSequence: request.plan.initialRenewalSequence,
					acquiredAt,
					renewBy: new Date(Date.now() + request.plan.leaseTtlMs / 2).toISOString(),
					expiresAt: new Date(Date.now() + request.plan.leaseTtlMs).toISOString(),
				};
				const reservation: Reservation = {
					replicaKey,
					domain: request.plan.deletionAuthorityDomain,
					lease,
					fenceDigest: tokenDigest(request.fence.token),
					root: await realpath(await mkdtemp(join(tmpdir(), "omp-local-replica-"))),
					image: null,
					phase: "reserved",
					acquireFingerprint: fingerprint,
					acquireRequestId: request.requestId,
					pushRequestId: null,
					releaseTerminal: false,
					commands: new Map(),
					checkpoints: new Map(),
					mutations: new Map(),
					expiryTimer: null,
				};
				this.#reservations.set(replicaKey, reservation);
				this.#scheduleExpiry(reservation);
				this.#storeEffect(effectKey, fingerprint, {
					status: "complete",
					request: transitionRequest(request),
					lease,
					deletionAuthorityDomain: reservation.domain,
					providerPhase: "reserved",
				});
				return this.#acquired(reservation, request, "acquired");
			} finally {
				this.#inProgress.delete(effectKey);
			}
		});
	}

	async inspectAcquire(
		...[request]: Parameters<RuntimeProvider["inspectAcquire"]>
	): ReturnType<RuntimeProvider["inspectAcquire"]> {
		this.#acquireDigest(request);
		const fingerprint = exactDigest(request, ["signal", "fence"]);
		const effectKey = this.#effectKey("acquire", request.plan.replica, request.requestId);
		const complete = this.#effect<Awaited<ReturnType<RuntimeProvider["inspectAcquire"]>>>(effectKey, fingerprint);
		if (complete) return complete;
		const inProgress = this.#inProgress.get(effectKey);
		if (inProgress) {
			if (inProgress !== fingerprint) throw new Error("request_conflict");
			return {
				status: "in_progress",
				request: transitionRequest(request),
				replica: request.plan.replica,
				leaseId: request.plan.leaseId,
				deletionAuthorityDomain: request.plan.deletionAuthorityDomain,
				providerPhase: "reserved",
				observedAt: now(),
			};
		}
		return {
			status: "not_started",
			request: transitionRequest(request),
			replica: request.plan.replica,
			leaseId: request.plan.leaseId,
			deletionAuthorityDomain: request.plan.deletionAuthorityDomain,
		};
	}

	async renew(...[request]: Parameters<RuntimeProvider["renew"]>): ReturnType<RuntimeProvider["renew"]> {
		const fingerprint = exactDigest(request.plan);
		const effectKey = this.#effectKey("renew", request.plan.expectedLease.replica, request.plan.request.requestId);
		return this.#exclusive(key(request.plan.expectedLease.replica), async () => {
			const found = this.#fencedReservation(
				request.plan.expectedLease.replica,
				request.plan.expectedLease.leaseId,
				request.fence,
			);
			const replay = this.#effect<Awaited<ReturnType<RuntimeProvider["renew"]>>>(effectKey, fingerprint);
			if (replay) return replay;
			if (found.phase === "revoked" || found.phase === "released") throw new Error("runtime_lease_revoked");
			if (Date.now() >= Date.parse(found.lease.expiresAt)) {
				found.phase = "expired";
				throw new Error("runtime_lease_expired");
			}
			if (
				!sameExact(request.plan.expectedLease, found.lease) ||
				request.plan.sequence !== found.lease.renewalSequence + 1
			)
				throw new Error("request_conflict");
			const priorLease = found.lease;
			found.lease = {
				...found.lease,
				renewalSequence: request.plan.sequence,
				renewBy: new Date(Date.now() + request.plan.leaseTtlMs / 2).toISOString(),
				expiresAt: new Date(Date.now() + request.plan.leaseTtlMs).toISOString(),
			};
			this.#scheduleExpiry(found);
			const result = {
				renewalId: request.plan.renewalId,
				sequence: request.plan.sequence,
				request: request.plan.request,
				priorLease,
				lease: found.lease,
				providerOutcome: "renewed" as const,
				completedAt: now(),
			};
			this.#storeEffect(effectKey, fingerprint, result);
			return result;
		});
	}

	async inspectRenewal(
		...[plan]: Parameters<RuntimeProvider["inspectRenewal"]>
	): ReturnType<RuntimeProvider["inspectRenewal"]> {
		const fingerprint = exactDigest(plan);
		const effectKey = this.#effectKey("renew", plan.expectedLease.replica, plan.request.requestId);
		const receipt = this.#effect<Awaited<ReturnType<RuntimeProvider["renew"]>>>(effectKey, fingerprint);
		if (receipt) return { status: "complete", receipt };
		const found = this.#reservations.get(key(plan.expectedLease.replica));
		if (!found)
			return {
				status: "absent",
				renewalId: plan.renewalId,
				sequence: plan.sequence,
				requestId: plan.request.requestId,
			};
		if (found.phase === "revoked" || found.phase === "released" || Date.now() >= Date.parse(found.lease.expiresAt))
			return {
				status: "rejected",
				renewalId: plan.renewalId,
				sequence: plan.sequence,
				reason: Date.now() >= Date.parse(found.lease.expiresAt) ? "lease_expired" : "lease_revoked",
				observedRenewalSequence: found.lease.renewalSequence,
				observedAt: now(),
			};
		if (sameExact(plan.expectedLease, found.lease) && plan.sequence === found.lease.renewalSequence + 1)
			return {
				status: "absent",
				renewalId: plan.renewalId,
				sequence: plan.sequence,
				requestId: plan.request.requestId,
			};
		return {
			status: "rejected",
			renewalId: plan.renewalId,
			sequence: plan.sequence,
			reason: "expected_lease_mismatch",
			observedRenewalSequence: found.lease.renewalSequence,
			observedAt: now(),
		};
	}

	async push(...[request]: Parameters<RuntimeProvider["push"]>): ReturnType<RuntimeProvider["push"]> {
		if (
			!validateWorkspaceSnapshotV1(request.snapshot) ||
			request.snapshot.checkpoint.workspaceId !== request.lease.replica.workspaceId ||
			request.snapshot.checkpoint.generation !== request.lease.baseGeneration
		)
			throw new Error("request_conflict");
		this.#pushDigest(request);
		const fingerprint = this.#pushFingerprint(request);
		const effectKey = this.#effectKey("push", request.lease.replica, request.requestId);
		return this.#exclusive(key(request.lease.replica), async () => {
			const found = this.#fencedReservation(request.lease.replica, request.lease.leaseId, request.fence);
			const replay = this.#effect<Awaited<ReturnType<RuntimeProvider["push"]>>>(effectKey, fingerprint);
			if (replay) {
				if ((found.phase !== "ready" && found.phase !== "quiesced") || found.image === null)
					throw new Error("runtime_admission_closed");
				return replayPushResult(replay);
			}
			this.#lease(found, request.lease);
			if (found.pushRequestId !== null || found.phase !== "reserved" || found.root === null)
				throw new Error("request_conflict");
			found.pushRequestId = request.requestId;
			found.phase = "materializing";
			this.#inProgress.set(effectKey, fingerprint);
			try {
				const staged = await sandboxedHelper<{ files: readonly { path: string; contentUtf8: string }[] }>(
					found.root,
					{
						op: "materialize",
						files: request.snapshot.files,
					},
				);
				const rebuilt = materializeWorkspaceSnapshotV1({
					workspaceId: request.snapshot.checkpoint.workspaceId,
					generation: request.snapshot.checkpoint.generation,
					committedAt: request.snapshot.checkpoint.committedAt,
					files: staged.files,
				});
				if (!validateWorkspaceSnapshotV1(rebuilt) || !sameExact(rebuilt, request.snapshot))
					throw new Error("runtime_snapshot_invalid");
				found.image = image(rebuilt);
				found.phase = "ready";
				const result = {
					status: "materialized" as const,
					request: transitionRequest(request),
					replica: request.lease.replica,
					canonicalGeneration: request.lease.baseGeneration,
					...found.image,
				};
				this.#storeEffect(effectKey, fingerprint, result);
				return result;
			} catch (error) {
				found.phase = "reserved";
				found.pushRequestId = null;
				throw error;
			} finally {
				this.#inProgress.delete(effectKey);
			}
		});
	}

	async inspectPush(
		...[request]: Parameters<RuntimeProvider["inspectPush"]>
	): ReturnType<RuntimeProvider["inspectPush"]> {
		this.#pushDigest(request);
		const fingerprint = this.#pushFingerprint(request);
		const effectKey = this.#effectKey("push", request.lease.replica, request.requestId);
		const result = this.#effect<Awaited<ReturnType<RuntimeProvider["push"]>>>(effectKey, fingerprint);
		if (result) return { status: "complete", result };
		const inProgress = this.#inProgress.get(effectKey);
		if (inProgress) {
			if (inProgress !== fingerprint) throw new Error("request_conflict");
			return {
				status: "in_progress",
				request: transitionRequest(request),
				replica: request.lease.replica,
				leaseId: request.lease.leaseId,
				providerPhase: "materializing",
				observedAt: now(),
			};
		}
		return {
			status: "not_started",
			request: transitionRequest(request),
			replica: request.lease.replica,
			leaseId: request.lease.leaseId,
		};
	}

	async inspect(...[request]: Parameters<RuntimeProvider["inspect"]>): ReturnType<RuntimeProvider["inspect"]> {
		const deletion = this.#deletions.get(key(request.replica));
		if (deletion?.tombstone) return { status: "tombstoned", tombstone: deletion.tombstone };
		const found = this.#reservations.get(key(request.replica));
		if (!found || found.lease.leaseId !== request.leaseId)
			return { status: "absent", replica: request.replica, leaseId: request.leaseId };
		if (request.fence) this.#fence(found, request.fence);
		return {
			status: "present",
			lease: found.lease,
			providerPhase: this.#observedPhase(found),
			compute: "not_applicable",
			activeCommands: this.#activeCommands(found),
			pendingSyncs: this.#activeCommands(found),
			replicaImage: found.image,
		};
	}

	async inspectCommand(
		...[request]: Parameters<RuntimeProvider["inspectCommand"]>
	): ReturnType<RuntimeProvider["inspectCommand"]> {
		const replicaKey = key(request.replica);
		return this.#exclusive(replicaKey, async () => {
			const found = this.#reservations.get(replicaKey);
			if (!found || found.lease.leaseId !== request.leaseId) {
				const deletion = this.#deletions.get(replicaKey);
				const evidence =
					deletion?.leaseId === request.leaseId ? deletion.commands.get(request.commandId) : undefined;
				if (deletion && evidence) {
					if (evidence.requestSha256 !== request.requestSha256) throw new Error("request_conflict");
					const updatedAt = deletion.result.observedAt;
					const snapshot: RuntimeCommandSnapshot =
						evidence.status === "start_unknown"
							? {
									commandId: request.commandId,
									requestSha256: evidence.requestSha256,
									status: "start_unknown",
									sync: "pending",
									output: "",
									truncated: false,
									exitCode: null,
									signal: null,
									updatedAt,
									execution: { certainty: "unknown" },
								}
							: {
									commandId: request.commandId,
									requestSha256: evidence.requestSha256,
									status: evidence.status,
									sync: "complete",
									output: "",
									truncated: false,
									exitCode: null,
									signal: null,
									updatedAt,
									execution: { certainty: "completed" },
								};
					return { status: "present", snapshot };
				}
				return {
					status: "absent",
					commandId: request.commandId,
					execution: { certainty: "not_started", proof: "provider_reservation_absent" },
				};
			}
			const command = found.commands.get(request.commandId);
			if (!command)
				return {
					status: "absent",
					commandId: request.commandId,
					execution: { certainty: "not_started", proof: "provider_reservation_absent" },
				};
			if (command.requestSha256 !== request.requestSha256) throw new Error("request_conflict");
			return { status: "present", snapshot: command.snapshot };
		});
	}

	async reconcileCommandStart(
		...[request]: Parameters<RuntimeProvider["reconcileCommandStart"]>
	): ReturnType<RuntimeProvider["reconcileCommandStart"]> {
		const inspected = await this.inspectCommand(request);
		if (inspected.status === "absent")
			return {
				status: "not_started",
				snapshot: {
					commandId: request.commandId,
					requestSha256: request.requestSha256,
					status: "reserved",
					sync: "pending",
					output: "",
					truncated: false,
					exitCode: null,
					signal: null,
					updatedAt: EPOCH,
					execution: { certainty: "not_started", proof: "backend_absent" },
				},
			};
		const command = inspected.snapshot;
		return command.status === "start_unknown"
			? { status: "unknown", snapshot: command }
			: command.status === "reserved"
				? { status: "not_started", snapshot: command }
				: { status: "observed", snapshot: command };
	}

	async quiesce(...[request]: Parameters<RuntimeProvider["quiesce"]>): ReturnType<RuntimeProvider["quiesce"]> {
		const fingerprint = exactDigest(request, ["signal", "fence"]);
		const effectKey = this.#effectKey("quiesce", request.lease.replica, request.requestId);
		return this.#exclusive(key(request.lease.replica), async () => {
			const found = this.#fencedReservation(request.lease.replica, request.lease.leaseId, request.fence);
			const replay = this.#effect<Awaited<ReturnType<RuntimeProvider["quiesce"]>>>(effectKey, fingerprint);
			if (replay) {
				if (found.phase !== "quiesced") throw new Error("runtime_admission_closed");
				return replayQuiesceResult(replay);
			}
			this.#lease(found, request.lease);
			if (found.phase !== "ready") throw new Error("request_conflict");
			found.phase = "quiescing";
			this.#inProgress.set(effectKey, fingerprint);
			try {
				await this.#terminateCommands(found, "SIGTERM");
				found.phase = "quiesced";
				const result = {
					status: "quiesced" as const,
					request: transitionRequest(request),
					lease: found.lease,
					activeCommands: 0 as const,
					pendingSyncs: 0 as const,
				};
				this.#storeEffect(effectKey, fingerprint, result);
				return result;
			} finally {
				this.#inProgress.delete(effectKey);
			}
		});
	}

	async inspectQuiesce(
		...[request]: Parameters<RuntimeProvider["inspectQuiesce"]>
	): ReturnType<RuntimeProvider["inspectQuiesce"]> {
		const fingerprint = exactDigest(request, ["signal", "fence"]);
		const effectKey = this.#effectKey("quiesce", request.lease.replica, request.requestId);
		const result = this.#effect<Awaited<ReturnType<RuntimeProvider["quiesce"]>>>(effectKey, fingerprint);
		if (result) return { status: "complete", result };
		const inProgress = this.#inProgress.get(effectKey);
		if (inProgress) {
			if (inProgress !== fingerprint) throw new Error("request_conflict");
			const found = this.#reservations.get(key(request.lease.replica));
			return {
				status: "in_progress",
				request: transitionRequest(request),
				lease: request.lease,
				activeCommands: found ? this.#activeCommands(found) : 0,
				pendingSyncs: found ? this.#activeCommands(found) : 0,
				observedAt: now(),
			};
		}
		return { status: "not_started", request: transitionRequest(request), lease: request.lease };
	}

	async checkpoint(
		...[request]: Parameters<RuntimeProvider["checkpoint"]>
	): ReturnType<RuntimeProvider["checkpoint"]> {
		const fingerprint = exactDigest(request, ["signal", "fence"]);
		const effectKey = this.#effectKey("checkpoint", request.lease.replica, request.requestId);
		return this.#exclusive(key(request.lease.replica), async () => {
			const found = this.#fencedReservation(request.lease.replica, request.lease.leaseId, request.fence);
			const replay = this.#effect<Awaited<ReturnType<RuntimeProvider["checkpoint"]>>>(effectKey, fingerprint);
			if (replay) {
				const checkpoint = found.checkpoints.get(request.checkpointId);
				if (
					(found.phase !== "ready" && found.phase !== "quiesced") ||
					!checkpoint ||
					checkpoint.requestId !== request.requestId
				)
					throw new Error("runtime_admission_closed");
				return replayCheckpointResult(replay);
			}
			this.#lease(found, request.lease);
			if ((found.phase !== "ready" && found.phase !== "quiesced") || found.root === null || !found.image)
				throw new Error("replica_image_missing");
			const existing = found.checkpoints.get(request.checkpointId);
			if (existing) throw new Error("request_conflict");
			this.#inProgress.set(effectKey, fingerprint);
			try {
				const frozenAt = now();
				const snapshot = await this.#snapshotLive(found, frozenAt);
				const reference = this.#checkpointReference(found, request.checkpointId, snapshot, frozenAt);
				found.checkpoints.set(request.checkpointId, {
					fingerprint,
					requestId: request.requestId,
					request: transitionRequest(request),
					reference,
					snapshot,
				});
				const result = { status: "checkpointed" as const, request: transitionRequest(request), reference };
				this.#storeEffect(effectKey, fingerprint, result);
				return result;
			} finally {
				this.#inProgress.delete(effectKey);
			}
		});
	}

	async recoveryFreeze(
		...[request]: Parameters<RuntimeProvider["recoveryFreeze"]>
	): ReturnType<RuntimeProvider["recoveryFreeze"]> {
		const fingerprint = exactDigest(request);
		const effectKey = this.#effectKey("recovery", request.locator.replica, request.requestId);
		const prior = this.#effect<Awaited<ReturnType<RuntimeProvider["recoveryFreeze"]>>>(effectKey, fingerprint);
		if (prior) return replayRecoveryFreezeResult(prior);
		return this.#exclusive(key(request.locator.replica), async () => {
			const replay = this.#effect<Awaited<ReturnType<RuntimeProvider["recoveryFreeze"]>>>(effectKey, fingerprint);
			if (replay) return replayRecoveryFreezeResult(replay);
			const found = this.#reservations.get(key(request.locator.replica));
			if (!found) {
				const result = this.#recoveryImpossible(request.locator, "replica_absent");
				this.#storeEffect(effectKey, fingerprint, result);
				return result;
			}
			if (
				found.lease.leaseId !== request.locator.leaseId ||
				found.lease.fenceId !== request.locator.fenceId ||
				found.lease.baseGeneration !== request.locator.baseGeneration
			)
				throw new Error("request_conflict");
			const existingCheckpoint = found.checkpoints.get(request.locator.checkpointId);
			if (
				existingCheckpoint &&
				(existingCheckpoint.requestId !== request.requestId ||
					existingCheckpoint.fingerprint !== fingerprint ||
					!sameExact(existingCheckpoint.request, providerRequest(request)) ||
					!validateWorkspaceSnapshotV1(existingCheckpoint.snapshot) ||
					existingCheckpoint.snapshot.checkpoint.workspaceId !== request.locator.replica.workspaceId ||
					existingCheckpoint.snapshot.checkpoint.generation !== request.locator.baseGeneration + 1 ||
					!sameExact(
						existingCheckpoint.reference,
						this.#checkpointReference(
							found,
							request.locator.checkpointId,
							existingCheckpoint.snapshot,
							existingCheckpoint.snapshot.checkpoint.committedAt,
						),
					))
			)
				throw new Error("request_conflict");
			const priorFence =
				Date.now() >= Date.parse(found.lease.expiresAt)
					? ("expired" as const)
					: found.phase === "revoked"
						? ("already_revoked" as const)
						: ("recovery_revoked" as const);
			found.phase = "recovery_freezing";
			this.#inProgress.set(effectKey, fingerprint);
			try {
				await this.#terminateCommands(found, "SIGTERM");
				if (found.root === null || !found.image) {
					const result = this.#recoveryImpossible(request.locator, "replica_image_missing");
					found.phase = priorFence === "expired" ? "expired" : "revoked";
					this.#storeEffect(effectKey, fingerprint, result);
					return result;
				}
				let checkpoint = existingCheckpoint;
				if (!checkpoint) {
					let snapshot: WorkspaceSnapshot;
					try {
						const frozenAt = now();
						snapshot = await this.#snapshotLive(found, frozenAt);
						const reference = this.#checkpointReference(found, request.locator.checkpointId, snapshot, frozenAt);
						checkpoint = {
							fingerprint,
							requestId: request.requestId,
							request: providerRequest(request),
							reference,
							snapshot,
						};
						found.checkpoints.set(request.locator.checkpointId, checkpoint);
					} catch {
						const result = this.#recoveryImpossible(request.locator, "replica_image_invalid");
						found.phase = priorFence === "expired" ? "expired" : "revoked";
						this.#storeEffect(effectKey, fingerprint, result);
						return result;
					}
				}
				found.phase = priorFence === "expired" ? "expired" : "revoked";
				const result = {
					status: "frozen" as const,
					reference: checkpoint.reference,
					acknowledgedMutationsSha256: this.#mutationDigest(found),
					observedRenewalSequence: found.lease.renewalSequence,
					commandAdmission: "closed" as const,
					activeCommands: 0 as const,
					pendingSyncs: 0 as const,
					priorFence,
				};
				this.#storeEffect(effectKey, fingerprint, result);
				return result;
			} finally {
				this.#inProgress.delete(effectKey);
			}
		});
	}

	async inspectRecoveryFreeze(
		...[request]: Parameters<RuntimeProvider["inspectRecoveryFreeze"]>
	): ReturnType<RuntimeProvider["inspectRecoveryFreeze"]> {
		const fingerprint = exactDigest(request);
		const effectKey = this.#effectKey("recovery", request.locator.replica, request.requestId);
		const result = this.#effect<Awaited<ReturnType<RuntimeProvider["recoveryFreeze"]>>>(effectKey, fingerprint);
		if (result) {
			if ("proof" in result) return { status: "preservation_impossible", proof: result.proof };
			return { ...result, status: "frozen" };
		}
		const inProgress = this.#inProgress.get(effectKey);
		if (inProgress) {
			if (inProgress !== fingerprint) throw new Error("request_conflict");
			const found = this.#reservations.get(key(request.locator.replica));
			return {
				status: "in_progress",
				locator: request.locator,
				phase: "freezing_checkpoint",
				activeCommands: found ? this.#activeCommands(found) : 0,
				pendingSyncs: found ? this.#activeCommands(found) : 0,
				observedAt: now(),
			};
		}
		return { status: "absent", locator: request.locator };
	}

	async inspectCheckpoint(
		...[request]: Parameters<RuntimeProvider["inspectCheckpoint"]>
	): ReturnType<RuntimeProvider["inspectCheckpoint"]> {
		const fingerprint = exactDigest(request, ["signal", "fence"]);
		const effectKey = this.#effectKey("checkpoint", request.lease.replica, request.requestId);
		const result = this.#effect<Awaited<ReturnType<RuntimeProvider["checkpoint"]>>>(effectKey, fingerprint);
		if (result) {
			const acknowledgement = this.#acknowledgements.get(this.#referenceKey(result.reference));
			if (acknowledgement)
				return {
					status: "acknowledged",
					request: result.request,
					reference: result.reference,
					canonicalCommit: acknowledgement.canonicalCommit,
					acknowledgedAt: acknowledgement.acknowledgedAt,
				};
			return { status: "frozen", request: result.request, reference: result.reference };
		}
		return {
			status: "absent",
			request: transitionRequest(request),
			locator: {
				providerId: request.lease.replica.providerId,
				profileId: request.lease.replica.profileId,
				workspaceId: request.lease.replica.workspaceId,
				replicaId: request.lease.replica.replicaId,
				leaseId: request.lease.leaseId,
				checkpointId: request.checkpointId,
			},
		};
	}

	async fetchCheckpoint(
		...[request]: Parameters<RuntimeProvider["fetchCheckpoint"]>
	): ReturnType<RuntimeProvider["fetchCheckpoint"]> {
		const found = this.#reservations.get(key(request.reference));
		const checkpoint = found?.checkpoints.get(request.reference.checkpointId);
		if (!found || !checkpoint || !sameExact(checkpoint.reference, request.reference))
			throw new Error("inspection_failed");
		return {
			status: "fetched",
			checkpoint: {
				reference: checkpoint.reference,
				files: checkpoint.snapshot.files,
				rootSha256: checkpoint.reference.rootSha256,
				fileCount: checkpoint.reference.fileCount,
				byteCount: checkpoint.reference.byteCount,
			},
		};
	}

	async acknowledgeCheckpoint(
		...[request]: Parameters<RuntimeProvider["acknowledgeCheckpoint"]>
	): ReturnType<RuntimeProvider["acknowledgeCheckpoint"]> {
		const fingerprint = exactDigest(request);
		const effectKey = this.#effectKey("checkpoint_ack", request.reference, request.requestId);
		const prior = this.#effect<Awaited<ReturnType<RuntimeProvider["acknowledgeCheckpoint"]>>>(effectKey, fingerprint);
		if (prior) return replayCheckpointAcknowledgementResult(prior);
		return this.#exclusive(key(request.reference), async () => {
			const replay = this.#effect<Awaited<ReturnType<RuntimeProvider["acknowledgeCheckpoint"]>>>(
				effectKey,
				fingerprint,
			);
			if (replay) return replayCheckpointAcknowledgementResult(replay);
			const found = this.#reservations.get(key(request.reference));
			const checkpoint = found?.checkpoints.get(request.reference.checkpointId);
			if (!checkpoint || !sameExact(checkpoint.reference, request.reference)) throw new Error("request_conflict");
			if (
				request.canonicalCommit.workspaceId !== request.reference.workspaceId ||
				request.canonicalCommit.expectedGeneration !== request.reference.baseGeneration ||
				request.canonicalCommit.checkpoint.generation !== request.reference.baseGeneration + 1 ||
				request.canonicalCommit.checkpoint.rootSha256 !== request.reference.rootSha256 ||
				request.canonicalCommit.checkpoint.fileCount !== request.reference.fileCount ||
				request.canonicalCommit.checkpoint.byteCount !== request.reference.byteCount ||
				!sameExact(request.canonicalCommit.checkpoint, checkpoint.snapshot.checkpoint)
			)
				throw new Error("request_conflict");
			const referenceKey = this.#referenceKey(request.reference);
			const old = this.#acknowledgements.get(referenceKey);
			if (old) throw new Error("request_conflict");
			const result = {
				status: "acknowledged" as const,
				request: parentOperationRequest(request),
				reference: request.reference,
				canonicalCommit: request.canonicalCommit,
				acknowledgedAt: now(),
			};
			this.#acknowledgements.set(referenceKey, result);
			this.#storeEffect(effectKey, fingerprint, result);
			this.#scheduleReplicaCacheEvictions(key(request.reference));
			return result;
		});
	}

	async inspectCheckpointAcknowledgement(
		...[request]: Parameters<RuntimeProvider["inspectCheckpointAcknowledgement"]>
	): ReturnType<RuntimeProvider["inspectCheckpointAcknowledgement"]> {
		const fingerprint = exactDigest(request);
		const effectKey = this.#effectKey("checkpoint_ack", request.reference, request.requestId);
		const result = this.#effect<Awaited<ReturnType<RuntimeProvider["acknowledgeCheckpoint"]>>>(
			effectKey,
			fingerprint,
		);
		return result
			? { status: "complete", result }
			: { status: "not_requested", request: parentOperationRequest(request), reference: request.reference };
	}

	async revoke(...[request]: Parameters<RuntimeProvider["revoke"]>): ReturnType<RuntimeProvider["revoke"]> {
		const fingerprint = exactDigest(request);
		const effectKey = this.#effectKey("revoke", request.replica, request.requestId);
		const prior = this.#effect<Awaited<ReturnType<RuntimeProvider["revoke"]>>>(effectKey, fingerprint);
		if (prior) return replayRevokeResult(prior);
		return this.#exclusive(key(request.replica), async () => {
			const replay = this.#effect<Awaited<ReturnType<RuntimeProvider["revoke"]>>>(effectKey, fingerprint);
			if (replay) return replayRevokeResult(replay);
			const found = this.#reservations.get(key(request.replica));
			let status: "revoked" | "expired" | "absent";
			if (!found) status = "absent";
			else {
				if (found.lease.leaseId !== request.leaseId || found.lease.fenceId !== request.fenceId)
					throw new Error("request_conflict");
				status = Date.now() >= Date.parse(found.lease.expiresAt) ? "expired" : "revoked";
				found.phase = status;
				await this.#terminateCommands(found, "SIGTERM");
			}
			const result = {
				status,
				request: transitionRequest(request),
				replica: request.replica,
				leaseId: request.leaseId,
				fenceId: request.fenceId,
			};
			this.#storeEffect(effectKey, fingerprint, result);
			return result;
		});
	}

	async inspectRevoke(
		...[request]: Parameters<RuntimeProvider["inspectRevoke"]>
	): ReturnType<RuntimeProvider["inspectRevoke"]> {
		const fingerprint = exactDigest(request);
		const effectKey = this.#effectKey("revoke", request.replica, request.requestId);
		const result = this.#effect<Awaited<ReturnType<RuntimeProvider["revoke"]>>>(effectKey, fingerprint);
		return result
			? { status: "complete", result }
			: {
					status: "not_started",
					request: transitionRequest(request),
					replica: request.replica,
					leaseId: request.leaseId,
					fenceId: request.fenceId,
				};
	}

	async release(...[request]: Parameters<RuntimeProvider["release"]>): ReturnType<RuntimeProvider["release"]> {
		const fingerprint = exactDigest(request);
		const effectKey = this.#effectKey("release", request.replica, request.requestId);
		const prior = this.#effect<Awaited<ReturnType<RuntimeProvider["release"]>>>(effectKey, fingerprint);
		if (prior) return replayReleaseResult(prior);
		return this.#exclusive(key(request.replica), async () => {
			const replay = this.#effect<Awaited<ReturnType<RuntimeProvider["release"]>>>(effectKey, fingerprint);
			if (replay) return replayReleaseResult(replay);
			const found = this.#reservations.get(key(request.replica));
			let status: "released" | "expired" | "absent";
			if (!found) status = "absent";
			else {
				if (found.lease.leaseId !== request.leaseId) throw new Error("request_conflict");
				status = Date.now() >= Date.parse(found.lease.expiresAt) ? "expired" : "released";
				found.phase = status;
				found.releaseTerminal = true;
				await this.#terminateCommands(found, "SIGTERM");
			}
			const result = {
				status,
				request: parentOperationRequest(request),
				replica: request.replica,
				leaseId: request.leaseId,
				compute: "not_applicable" as const,
			};
			this.#storeEffect(effectKey, fingerprint, result);
			this.#scheduleReplicaCacheEvictions(key(request.replica));
			return result;
		});
	}

	async inspectRelease(
		...[request]: Parameters<RuntimeProvider["inspectRelease"]>
	): ReturnType<RuntimeProvider["inspectRelease"]> {
		const fingerprint = exactDigest(request);
		const effectKey = this.#effectKey("release", request.replica, request.requestId);
		const result = this.#effect<Awaited<ReturnType<RuntimeProvider["release"]>>>(effectKey, fingerprint);
		return result
			? { status: "complete", result }
			: {
					status: "not_requested",
					request: parentOperationRequest(request),
					replica: request.replica,
					leaseId: request.leaseId,
				};
	}

	async requestReplicaCacheEviction(
		...[request]: Parameters<RuntimeProvider["requestReplicaCacheEviction"]>
	): ReturnType<RuntimeProvider["requestReplicaCacheEviction"]> {
		const fingerprint = exactDigest(request);
		const cacheKey = this.#effectKey("cache", request.replica, request.requestId);
		return this.#exclusive(key(request.replica), async () => {
			const terminal = this.#effect<Awaited<ReturnType<RuntimeProvider["requestReplicaCacheEviction"]>>>(
				cacheKey,
				fingerprint,
			);
			if (terminal) return terminal;
			let state = this.#cache.get(cacheKey);
			const created = state === undefined;
			if (state && state.fingerprint !== fingerprint) throw new Error("request_conflict");
			const planned = Date.parse(request.plannedAt);
			const received = Date.parse(request.retentionDeadline);
			const expected = planned + request.delayMs;
			if (!Number.isFinite(planned) || !Number.isFinite(received) || expected !== received) {
				const result = {
					status: "deadline_mismatch" as const,
					mismatch: {
						requestId: request.requestId,
						requestSha256: request.requestSha256,
						replica: request.replica,
						plannedRetentionDeadline: Number.isFinite(expected)
							? (new Date(expected).toISOString() as ISO8601)
							: request.retentionDeadline,
						providerRetentionDeadline: request.retentionDeadline,
						observedAt: now(),
					},
				};
				this.#storeEffect(cacheKey, fingerprint, result);
				return result;
			}
			if (!state) {
				state = {
					fingerprint,
					acceptance: {
						requestId: request.requestId,
						requestSha256: request.requestSha256,
						replica: request.replica,
						retentionDeadline: request.retentionDeadline,
						acceptedAt: now(),
					},
					completion: null,
					timer: undefined,
					attempting: false,
					rearmRequested: false,
				};
				this.#cache.set(cacheKey, state);
			}
			if (state.completion) return { status: "complete", result: state.completion };
			const found = this.#reservations.get(key(request.replica));
			const deferral = found ? this.#cacheDeferral(found) : null;
			if (Date.now() < received || deferral) {
				this.#scheduleCacheEviction(cacheKey, state);
				return { status: created ? "accepted" : "already_accepted", acceptance: state.acceptance };
			}
			const completion = await this.#completeCacheEviction(state, found);
			return { status: "complete", result: completion };
		});
	}

	async inspectReplicaCacheEviction(
		...[request]: Parameters<RuntimeProvider["inspectReplicaCacheEviction"]>
	): ReturnType<RuntimeProvider["inspectReplicaCacheEviction"]> {
		const fingerprint = exactDigest(request);
		const cacheKey = this.#effectKey("cache", request.replica, request.requestId);
		const terminal = this.#effect<Awaited<ReturnType<RuntimeProvider["inspectReplicaCacheEviction"]>>>(
			cacheKey,
			fingerprint,
		);
		if (terminal) return terminal;
		const state = this.#cache.get(cacheKey);
		if (!state)
			return {
				status: "not_started",
				requestId: request.requestId,
				requestSha256: request.requestSha256,
				replica: request.replica,
				retentionDeadline: request.retentionDeadline,
				observedAt: now(),
			};
		if (state.fingerprint !== fingerprint) throw new Error("request_conflict");
		if (state.completion) return { status: "complete", result: state.completion };
		const found = this.#reservations.get(key(request.replica));
		const deferral = found ? this.#cacheDeferral(found) : null;
		if (deferral)
			return {
				status: "deferred",
				acceptance: state.acceptance,
				reason: deferral,
				nextAttemptAt: new Date(
					Math.max(Date.now(), Date.parse(request.retentionDeadline)),
				).toISOString() as ISO8601,
				observedAt: now(),
			};
		return { status: "accepted", acceptance: state.acceptance };
	}

	async deleteReplica(
		...[request]: Parameters<RuntimeProvider["deleteReplica"]>
	): ReturnType<RuntimeProvider["deleteReplica"]> {
		await this.#deleteDigest(request);
		const fingerprint = exactDigest(request);
		const replicaKey = key(request.replica);
		return this.#exclusive(replicaKey, async () => {
			const terminal = this.#deletions.get(replicaKey);
			if (terminal) {
				if (terminal.fingerprint !== fingerprint) throw new Error("request_conflict");
				return replayDeletionResult(terminal.result);
			}
			const pending = this.#pendingDeletions.get(replicaKey);
			if (pending && pending.fingerprint !== fingerprint) throw new Error("request_conflict");
			const found = this.#reservations.get(replicaKey);
			if (!found && pending) return pending.result;
			let commandEvidence: ReadonlyMap<string, DeletionCommandEvidence> = new Map();
			if (found && found.domain !== request.authorization.domain) throw new Error("request_conflict");
			const cleanupPending = () => {
				const result = {
					status: "cleanup_pending" as const,
					request: providerRequest(request),
					replica: request.replica,
					authorization: request.authorization,
					observedAt: now(),
					retryAfter: new Date(Date.now() + PROCESS_REAP_RETRY_MS).toISOString() as ISO8601,
					receiptSha256: null,
				};
				this.#pendingDeletions.set(replicaKey, { fingerprint, result });
				return result;
			};
			if (found) {
				found.phase = "revoked";
				this.#clearExpiry(found);
				try {
					await this.#terminateCommands(found, "SIGTERM");
				} catch {
					return cleanupPending();
				}
				try {
					if (found.root) await rm(found.root, { recursive: true, force: true });
				} catch {
					return cleanupPending();
				}
				found.root = null;
				found.image = null;
				const evidence = new Map<string, DeletionCommandEvidence>();
				for (const [commandId, command] of found.commands) {
					const snapshot = command.snapshot;
					if (snapshot.status === "succeeded" || snapshot.status === "failed" || snapshot.status === "cancelled") {
						evidence.set(commandId, {
							requestSha256: command.requestSha256,
							status: snapshot.status,
						});
					} else if (snapshot.status === "start_unknown" || snapshot.status === "running") {
						evidence.set(commandId, {
							requestSha256: command.requestSha256,
							status: "start_unknown",
						});
					}
				}
				commandEvidence = evidence;
				found.commands.clear();
				found.checkpoints.clear();
				found.mutations.clear();
				this.#reservations.delete(replicaKey);
			}
			const status = found ? ("deleted" as const) : ("absent" as const);
			const result: TerminalDeletionResult = {
				status,
				request: providerRequest(request),
				replica: request.replica,
				authorization: request.authorization,
				observedAt: now(),
				retryAfter: null,
				receiptSha256: shaRef([status, request.requestId]),
			};
			this.#pendingDeletions.delete(replicaKey);
			this.#deletions.set(replicaKey, {
				leaseId: found?.lease.leaseId ?? null,
				fingerprint,
				result,
				tombstone: request.authorization.domain === "persistent" ? request.authorization.tombstone : null,
				commands: commandEvidence,
			});
			this.#completeCacheEvictionsForDeletion(replicaKey);
			return result;
		});
	}

	async inspectReplicaDeletion(
		...[request]: Parameters<RuntimeProvider["inspectReplicaDeletion"]>
	): ReturnType<RuntimeProvider["inspectReplicaDeletion"]> {
		await this.#deleteDigest(request);
		const fingerprint = exactDigest(request);
		const replicaKey = key(request.replica);
		return this.#exclusive(replicaKey, async () => {
			const terminal = this.#deletions.get(replicaKey);
			if (terminal) {
				if (terminal.fingerprint !== fingerprint) throw new Error("request_conflict");
				return terminal.result;
			}
			const pending = this.#pendingDeletions.get(replicaKey);
			if (pending) {
				if (pending.fingerprint !== fingerprint) throw new Error("request_conflict");
				return pending.result;
			}
			const found = this.#reservations.get(replicaKey);
			if (found && found.domain !== request.authorization.domain) throw new Error("request_conflict");
			return {
				status: "not_started",
				request: providerRequest(request),
				replica: request.replica,
				authorization: request.authorization,
				observedAt: now(),
				retryAfter: null,
				receiptSha256: null,
			};
		});
	}

	#bridge(found: Reservation): RuntimeExecutionBridge {
		const authorize = (request: {
			workspaceId: string;
			replicaId: string;
			leaseId: string;
			expectedGeneration: number;
			fence: { fenceId: string; token: string };
		}): void => {
			if (
				this.#reservations.get(found.replicaKey) !== found ||
				request.workspaceId !== found.lease.replica.workspaceId ||
				request.replicaId !== found.lease.replica.replicaId ||
				request.leaseId !== found.lease.leaseId ||
				request.expectedGeneration !== found.lease.baseGeneration
			)
				throw new Error("request_conflict");
			this.#fence(found, request.fence);
			if (found.phase !== "ready" || found.root === null) throw new Error("runtime_admission_closed");
		};
		const mutate = async <T>(
			request: { requestId: string; requestSha256: Sha256Hex },
			kind: MutationRecord["kind"],
			action: () => Promise<T>,
			omitted: readonly string[] = ["fence", "signal"],
		): Promise<T> => {
			const fingerprint = exactDigest(request, omitted);
			const old = found.mutations.get(request.requestId);
			if (old) {
				if (old.requestSha256 !== request.requestSha256 || old.fingerprint !== fingerprint)
					throw new Error("request_conflict");
				return old.result as T;
			}
			const result = await action();
			found.mutations.set(request.requestId, { fingerprint, requestSha256: request.requestSha256, kind, result });
			return result;
		};
		const helperLimit = (byteLimit: number): number =>
			Math.min(MAX_BRIDGE_OUTPUT_BYTES, 4_096 + Math.ceil((byteLimit * 4) / 3));
		return {
			readTextFile: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					modelSegments(request.path);
					boundedInteger(request.byteLimit, MAX_BRIDGE_FILE_BYTES);
					if (request.line !== null) boundedInteger(request.line, MAX_BRIDGE_FILE_BYTES);
					if (request.limit !== null) boundedInteger(request.limit, MAX_BRIDGE_FILE_BYTES);
					const response = await sandboxedHelper<{ contentBase64: string }>(
						found.root!,
						{
							op: "read_text",
							path: request.path,
							line: request.line,
							limit: request.limit,
							byteLimit: request.byteLimit,
							scanByteLimit: MAX_BRIDGE_FILE_BYTES,
						},
						helperLimit(request.byteLimit),
					);
					const bytes = Buffer.from(response.contentBase64, "base64");
					return {
						path: request.path,
						content: bytes.toString("utf8"),
						sha256: rawSha256(bytes),
						byteLength: bytes.length,
					};
				}),
			readBinaryFile: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					modelSegments(request.path);
					boundedInteger(request.offset, Number.MAX_SAFE_INTEGER);
					boundedInteger(request.byteLimit, MAX_BRIDGE_FILE_BYTES);
					const response = await sandboxedHelper<{ contentBase64: string; truncated: boolean }>(
						found.root!,
						{ op: "read_binary", path: request.path, offset: request.offset, byteLimit: request.byteLimit },
						helperLimit(request.byteLimit),
					);
					const bytes = Buffer.from(response.contentBase64, "base64");
					return {
						path: request.path,
						contentBase64: bytes.toString("base64"),
						sha256: rawSha256(bytes),
						byteLength: bytes.length,
						truncated: response.truncated,
					};
				}),
			writeTextFile: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					modelSegments(request.path);
					const content = Buffer.from(request.content, "utf8");
					if (content.length > MAX_BRIDGE_FILE_BYTES) throw new Error("runtime_limit_rejected");
					if (rawSha256(content) !== request.contentSha256) throw new Error("request_conflict");
					return mutate(request, "write", async () => {
						const result = await sandboxedHelper<{ status: "written"; sha256: Sha256Hex; byteLength: number }>(
							found.root!,
							{
								op: "write",
								path: request.path,
								contentBase64: content.toString("base64"),
								contentSha256: request.contentSha256,
							},
						);
						return { ...result, path: request.path };
					});
				}),
			exists: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					modelSegments(request.path);
					return (await sandboxedHelper<{ exists: boolean }>(found.root!, { op: "exists", path: request.path }))
						.exists;
				}),
			stat: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					modelSegments(request.path);
					const result = await sandboxedHelper<{
						kind: "file" | "directory" | "symlink" | "other";
						byteLength: number | null;
						sha256: Sha256Hex | null;
					}>(found.root!, { op: "stat", path: request.path });
					return { path: request.path, ...result };
				}),
			mkdir: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					modelSegments(request.path);
					return mutate(request, "mkdir", () =>
						sandboxedHelper<{ status: "created" | "already_exists" }>(found.root!, {
							op: "mkdir",
							path: request.path,
							recursive: request.recursive,
						}),
					);
				}),
			remove: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					modelSegments(request.path);
					return mutate(request, "remove", () =>
						sandboxedHelper<{ status: "removed" | "already_absent" }>(found.root!, {
							op: "remove",
							path: request.path,
							recursive: request.recursive,
						}),
					);
				}),
			rename: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					modelSegments(request.from);
					modelSegments(request.to);
					return mutate(request, "rename", () =>
						sandboxedHelper<{ status: "renamed" | "already_renamed" }>(found.root!, {
							op: "rename",
							from: request.from,
							to: request.to,
						}),
					);
				}),
			listFiles: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					modelSegments(request.directory);
					boundedInteger(request.limit, 10_000, false);
					if (request.pattern.length > 4_096) throw new Error("runtime_request_rejected");
					const query = digest(["list", request.directory, request.pattern]);
					const offset = decodeCursor(request.cursor, "list", query);
					const result = await sandboxedHelper<{
						entries: Awaited<ReturnType<RuntimeExecutionBridge["listFiles"]>>["entries"];
						nextOffset: number | null;
					}>(found.root!, {
						op: "list",
						directory: request.directory,
						pattern: request.pattern,
						limit: request.limit,
						offset,
					});
					return {
						entries: result.entries,
						nextCursor: result.nextOffset === null ? null : encodeCursor("list", query, result.nextOffset),
					};
				}),
			searchText: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					modelSegments(request.path);
					boundedInteger(request.limit, 10_000, false);
					if (request.pattern.length > 4_096 || !/^[gims]*$/.test(request.flags))
						throw new Error("runtime_request_rejected");
					new RegExp(request.pattern, request.flags);
					const query = digest(["search", request.path, request.pattern, request.flags]);
					const offset = decodeCursor(request.cursor, "search", query);
					const result = await sandboxedHelper<{
						matches: Awaited<ReturnType<RuntimeExecutionBridge["searchText"]>>["matches"];
						nextOffset: number | null;
					}>(found.root!, {
						op: "search",
						path: request.path,
						pattern: request.pattern,
						flags: request.flags,
						limit: request.limit,
						offset,
						scanByteLimit: MAX_BRIDGE_FILE_BYTES,
					});
					return {
						matches: result.matches,
						nextCursor: result.nextOffset === null ? null : encodeCursor("search", query, result.nextOffset),
					};
				}),
			submitCommand: async request => {
				const started = await this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					modelSegments(request.command.cwd);
					if (
						request.command.shell !== "/bin/bash" ||
						request.command.environment !== "omp-runtime-scrubbed-v1" ||
						request.command.pty !== false
					)
						throw new Error("runtime_command_rejected");
					boundedInteger(request.command.timeoutMs, MAX_COMMAND_TIMEOUT_MS, false);
					boundedInteger(request.command.outputByteLimit, MAX_COMMAND_OUTPUT_BYTES);
					if (Buffer.byteLength(request.command.source, "utf8") > MAX_COMMAND_SOURCE_BYTES)
						throw new Error("runtime_limit_rejected");
					const fingerprint = exactDigest(request, ["fence", "signal"]);
					const old = found.commands.get(request.commandId);
					if (old) {
						if (old.requestSha256 !== request.requestSha256 || old.fingerprint !== fingerprint)
							throw new Error("request_conflict");
						return { record: old, replay: true as const };
					}
					const uncertain: RuntimeCommandSnapshot = {
						commandId: request.commandId,
						requestSha256: request.requestSha256,
						status: "start_unknown",
						sync: "pending",
						output: "",
						truncated: false,
						exitCode: null,
						signal: null,
						updatedAt: now(),
						execution: { certainty: "unknown" },
					};
					const record: CommandRecord = {
						fingerprint,
						requestSha256: request.requestSha256,
						outputByteLimit: request.command.outputByteLimit,
						snapshot: uncertain,
						liveResult: null,
						execution: sandboxedCommand(
							found.root!,
							request.command.cwd,
							request.command.source,
							request.command.timeoutMs,
							request.command.outputByteLimit,
						),
						cancelRequested: false,
						disposed: false,
					};
					found.commands.set(request.commandId, record);
					return { record, replay: false as const };
				});
				if (started.replay) return started.record.snapshot;
				let outcome: IsolatedOutcome | null = null;
				let failed = false;
				try {
					outcome = await started.record.execution!.outcome;
				} catch {
					failed = true;
				}
				return this.#exclusive(found.replicaKey, async () => {
					const snapshot =
						started.record.liveResult ??
						(this.#terminalCommand(started.record.snapshot) || started.record.snapshot.status === "reserved"
							? started.record.snapshot
							: failed || !outcome
								? await this.#settleCommand(started.record)
								: this.#finishCommand(started.record, outcome));
					this.#scheduleReplicaCacheEvictions(found.replicaKey);
					return snapshot;
				});
			},
			inspectCommand: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					const result = found.commands.get(request.commandId);
					return result
						? { status: "present", snapshot: result.snapshot }
						: {
								status: "absent",
								commandId: request.commandId,
								execution: { certainty: "not_started", proof: "provider_reservation_absent" },
							};
				}),
			cancelCommand: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					return mutate(
						request,
						"control",
						async () => {
							const record = found.commands.get(request.commandId);
							if (!record) throw new Error("command_absent");
							if (this.#terminalCommand(record.snapshot) || record.snapshot.status === "reserved")
								return record.snapshot;
							record.cancelRequested = true;
							const execution = record.execution;
							if (execution && !(await execution.terminateAndReap(request.signal))) {
								const snapshot = this.#commandUnknown(record);
								this.#scheduleReplicaCacheEvictions(found.replicaKey);
								return snapshot;
							}
							const snapshot = await this.#settleCommand(record);
							if (execution && record.execution === execution) record.execution = null;
							this.#scheduleReplicaCacheEvictions(found.replicaKey);
							return snapshot;
						},
						["fence"],
					);
				}),
			disposeCommand: request =>
				this.#exclusive(found.replicaKey, async () => {
					authorize(request);
					return mutate(request, "control", async () => {
						const record = found.commands.get(request.commandId);
						if (!record || record.disposed)
							return { status: "already_disposed" as const, commandId: request.commandId };
						record.disposed = true;
						return { status: "disposed" as const, commandId: request.commandId };
					});
				}),
		};
	}

	#reservation(replica: RuntimeReplicaRef, leaseId: RuntimeLeaseId): Reservation {
		const found = this.#reservations.get(key(replica));
		if (!found || found.lease.leaseId !== leaseId) throw new Error("request_conflict");
		return found;
	}

	#fencedReservation(
		replica: RuntimeReplicaRef,
		leaseId: RuntimeLeaseId,
		fence: { fenceId: string; token: string },
	): Reservation {
		const found = this.#reservation(replica, leaseId);
		this.#fence(found, fence);
		return found;
	}

	#lease(found: Reservation, lease: Reservation["lease"]): void {
		if (!sameExact(found.lease, lease)) throw new Error("request_conflict");
	}

	#fence(found: Reservation, fence: { fenceId: string; token: string }): void {
		if (Date.now() >= Date.parse(found.lease.expiresAt) && found.phase !== "released" && found.phase !== "revoked")
			found.phase = "expired";
		if (
			found.phase === "expired" ||
			found.phase === "revoked" ||
			found.phase === "released" ||
			found.lease.fenceId !== fence.fenceId ||
			found.fenceDigest !== tokenDigest(fence.token)
		)
			throw new Error("runtime_fence_rejected");
	}

	async #available(): Promise<void> {
		if (
			this.#availability.availability !== "available" ||
			!validPolicy(this.#availability.policy) ||
			!(await this.#probe())
		)
			throw new Error("local_sandbox_probe_failed");
	}

	async #probe(): Promise<boolean> {
		if (process.platform !== "darwin" && process.platform !== "linux") return false;
		if (!sharedIsolationProbe)
			sharedIsolationProbe = (async () => {
				const parentVariable = "OMP_LOCAL_PROVIDER_PARENT_ENV_CANARY";
				const originalParentValue = process.env[parentVariable];
				const server = createServer();
				let root: string | undefined;
				let homeCanaryRoot: string | undefined;
				try {
					const home = process.env.HOME;
					if (
						!home ||
						(process.arch !== "arm64" && process.arch !== "x64") ||
						(process.platform === "darwin" && !DARWIN_HELPER_PYTHON)
					)
						return false;
					await Promise.all([
						access(process.platform === "darwin" ? "/usr/bin/sandbox-exec" : "/usr/bin/bwrap"),
						access(LOCAL_HELPER_PYTHON),
						access("/bin/bash"),
					]);
					root = await realpath(await mkdtemp(join(tmpdir(), "omp-local-probe-")));
					homeCanaryRoot = await realpath(await mkdtemp(join(home, ".omp-local-probe-")));
					const homeCanary = join(homeCanaryRoot, "nested", "secret");
					await mkdir(join(homeCanaryRoot, "nested"), { recursive: true, mode: 0o700 });
					await writeFile(homeCanary, ":\n", { mode: 0o600 });
					const controlCanary = await nestedFile(process.cwd());
					if (!controlCanary) return false;
					await new Promise<void>((resolve, reject) => {
						server.once("error", reject);
						server.listen(0, "127.0.0.1", () => {
							server.off("error", reject);
							resolve();
						});
					});
					const address = server.address();
					if (!address || typeof address === "string") return false;
					process.env[parentVariable] = "present";
					const checks = await sandboxedHelper<{ ok: boolean }>(
						root,
						{
							op: "probe",
							parentVariable,
							homeCanary,
							controlCanary,
							outsideCanary: "/etc/hosts",
							connectPort: address.port,
						},
						1_024,
						[homeCanary, controlCanary, "/etc/hosts"],
					);
					const descendant = await sandboxedCommand(
						root,
						"/workspace",
						process.platform === "darwin"
							? "sleep 30"
							: `/usr/bin/python3 -I -S -c 'import os,time\nif os.fork() == 0:\n os.setsid(); time.sleep(.25); open("/workspace/probe-escaped", "w").write("escape"); os._exit(0)\ntime.sleep(30)'`,
						100,
						64,
					).outcome;
					await new Promise(resolve => setTimeout(resolve, 400));
					const escaped = await sandboxedHelper<{ exists: boolean }>(root, {
						op: "exists",
						path: "/workspace/probe-escaped",
					});
					return checks.ok && descendant.timedOut && !escaped.exists;
				} catch {
					return false;
				} finally {
					if (originalParentValue === undefined) delete process.env[parentVariable];
					else process.env[parentVariable] = originalParentValue;
					if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
					if (root) await rm(root, { recursive: true, force: true });
					if (homeCanaryRoot) await rm(homeCanaryRoot, { recursive: true, force: true });
				}
			})();
		return sharedIsolationProbe;
	}

	#acquireDigest(
		request: Parameters<RuntimeProvider["acquire"]>[0] | Parameters<RuntimeProvider["inspectAcquire"]>[0],
	): void {
		const plan = request.plan;
		if (
			request.candidate.providerId !== this.id ||
			request.candidate.profileId !== plan.replica.profileId ||
			plan.replica.providerId !== this.id ||
			request.candidate.network !== "none" ||
			request.requestSha256 !==
				digest([
					"omp-runtime-provider-v1",
					"acquire",
					request.transitionId,
					request.candidate.providerId,
					request.candidate.profileId,
					plan.replica.workspaceId,
					plan.replica.replicaId,
					plan.leaseId,
					plan.fenceId,
					plan.baseCheckpoint.generation,
					plan.baseCheckpoint.rootSha256,
					plan.baseCheckpoint.fileCount,
					plan.baseCheckpoint.byteCount,
					plan.deletionAuthorityDomain,
					plan.leaseTtlMs,
					plan.initialRenewalSequence,
				]) ||
			("fence" in request && (request.fence.fenceId !== plan.fenceId || request.fence.token.length === 0))
		)
			throw new Error("request_conflict");
	}

	#pushDigest(request: Parameters<RuntimeProvider["push"]>[0] | Parameters<RuntimeProvider["inspectPush"]>[0]): void {
		const snapshot = request.snapshot;
		const snapshotImage = "checkpoint" in snapshot ? image(snapshot) : snapshot;
		if (
			("checkpoint" in snapshot && snapshot.checkpoint.generation !== request.lease.baseGeneration) ||
			Object.hasOwn(snapshot, "generation") ||
			request.requestSha256 !==
				digest([
					"omp-runtime-provider-v1",
					"push",
					request.transitionId,
					request.lease.replica.providerId,
					request.lease.replica.profileId,
					request.lease.replica.workspaceId,
					request.lease.replica.replicaId,
					request.lease.leaseId,
					request.lease.fenceId,
					request.lease.baseGeneration,
					snapshotImage.rootSha256,
					snapshotImage.fileCount,
					snapshotImage.byteCount,
				])
		)
			throw new Error("request_conflict");
	}

	#pushFingerprint(
		request: Parameters<RuntimeProvider["push"]>[0] | Parameters<RuntimeProvider["inspectPush"]>[0],
	): Sha256Hex {
		return exactDigest(
			{
				requestId: request.requestId,
				requestSha256: request.requestSha256,
				transitionId: request.transitionId,
				lease: request.lease,
				snapshot: "checkpoint" in request.snapshot ? image(request.snapshot) : request.snapshot,
			},
			[],
		);
	}

	async #deleteDigest(request: Parameters<RuntimeProvider["deleteReplica"]>[0]): Promise<void> {
		const auth = request.authorization;
		if (auth.domain === "transient_task") {
			if (
				auth.workspaceId !== request.replica.workspaceId ||
				auth.replicaDeleteRequestId !== request.requestId ||
				request.requestSha256 !==
					digest([
						"omp-runtime-provider-v1",
						"replica_delete",
						"transient_task",
						request.replica.providerId,
						request.replica.profileId,
						request.replica.workspaceId,
						request.replica.replicaId,
						auth.taskId,
						auth.runId,
						auth.workspaceId,
						auth.cleanupId,
						auth.cleanupAuthorityId,
						auth.cleanupPlanSha256,
						checkpointTuple(auth.finalCheckpoint),
						auth.replicaDeleteRequestId,
						auth.replicaDeletionQuarantineId,
						auth.replicaDeletionPlannedAt,
						auth.replicaDeletionPurgeAfter,
					])
			)
				throw new Error("request_conflict");
			return;
		}
		const expectedDeletion = await validatePersistentReplicaDeletionAuthorizationV1(auth).catch(() => null);
		if (!expectedDeletion) throw new Error("request_conflict");
		const matching = expectedDeletion.deletion.replicaRequests.find(
			entry => entry.request.requestId === request.requestId && sameReplica(entry.replica, request.replica),
		);
		if (!matching || matching.request.requestSha256 !== request.requestSha256) throw new Error("request_conflict");
		const tombstone = auth.tombstone;
		if (
			request.requestSha256 !==
			digest([
				"omp-runtime-provider-v1",
				"replica_delete",
				"persistent",
				request.requestId,
				request.replica.providerId,
				request.replica.profileId,
				request.replica.workspaceId,
				request.replica.replicaId,
				auth.deletionPlanCoreSha256,
				[
					tombstone.workspaceId,
					tombstone.deleteId,
					tombstone.deletionAuthorityId,
					tombstone.quarantineId,
					tombstone.deletedAt,
					checkpointTuple(tombstone.lastCheckpoint),
					tombstone.purgeAfter,
				],
			])
		)
			throw new Error("request_conflict");
	}

	#acquired(
		found: Reservation,
		request: Parameters<RuntimeProvider["acquire"]>[0],
		status: "acquired" | "already_acquired",
	): Awaited<ReturnType<RuntimeProvider["acquire"]>> {
		return {
			status,
			request: transitionRequest(request),
			lease: found.lease,
			binding: {
				lease: found.lease,
				fence: request.fence,
				modelRoot: "/workspace" as never,
				bridge: this.#bridge(found),
			},
			providerPhase: "reserved",
			deletionAuthorityDomain: found.domain,
		};
	}

	async #exclusive<T>(replicaKey: string, action: () => Promise<T>): Promise<T> {
		const prior = this.#serials.get(replicaKey) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>(resolve => {
			release = resolve;
		});
		this.#serials.set(replicaKey, next);
		await prior;
		try {
			return await action();
		} finally {
			release();
			if (this.#serials.get(replicaKey) === next) this.#serials.delete(replicaKey);
		}
	}

	#effectKey(operation: string, replica: RuntimeReplicaRef, requestId: string): string {
		return `${operation}\0${key(replica)}\0${requestId}`;
	}

	#effect<T>(effectKey: string, fingerprint: Sha256Hex): T | null {
		const ledger = this.#effects.get(effectKey);
		if (!ledger) return null;
		if (ledger.fingerprint !== fingerprint) throw new Error("request_conflict");
		return ledger.result as T;
	}

	#storeEffect(effectKey: string, fingerprint: Sha256Hex, result: unknown): void {
		const old = this.#effects.get(effectKey);
		if (old && old.fingerprint !== fingerprint) throw new Error("request_conflict");
		if (!old) this.#effects.set(effectKey, { fingerprint, result });
	}

	#observedPhase(found: Reservation): RuntimeProviderPhase {
		return Date.now() >= Date.parse(found.lease.expiresAt) && found.phase !== "released" && found.phase !== "revoked"
			? "expired"
			: found.phase;
	}

	#activeCommands(found: Reservation): number {
		let active = 0;
		for (const command of found.commands.values()) {
			if (command.snapshot.status === "running" || command.snapshot.status === "start_unknown") active++;
		}
		return active;
	}

	#scheduleExpiry(found: Reservation): void {
		this.#clearExpiry(found);
		const delay = Math.max(0, Math.min(2_147_483_647, Date.parse(found.lease.expiresAt) - Date.now()));
		found.expiryTimer = setTimeout(() => {
			void this.#exclusive(found.replicaKey, async () => {
				if (this.#reservations.get(found.replicaKey) !== found) return;
				if (Date.now() < Date.parse(found.lease.expiresAt)) {
					this.#scheduleExpiry(found);
					return;
				}
				if (found.phase !== "released" && found.phase !== "revoked") {
					found.phase = "expired";
					await this.#terminateCommands(found, "SIGTERM");
				}
			});
		}, delay);
		found.expiryTimer.unref();
	}

	#clearExpiry(found: Reservation): void {
		if (found.expiryTimer) clearTimeout(found.expiryTimer);
		found.expiryTimer = null;
	}

	async #snapshotLive(found: Reservation, committedAt: ISO8601): Promise<WorkspaceSnapshot> {
		if (!found.root) throw new Error("replica_image_missing");
		const response = await sandboxedHelper<{ files: readonly { path: string; contentUtf8: string }[] }>(found.root, {
			op: "snapshot",
		});
		const snapshot = materializeWorkspaceSnapshotV1({
			workspaceId: found.lease.replica.workspaceId,
			generation: found.lease.baseGeneration + 1,
			committedAt,
			files: response.files,
		});
		if (!validateWorkspaceSnapshotV1(snapshot)) throw new Error("runtime_snapshot_invalid");
		return snapshot;
	}

	#checkpointReference(
		found: Reservation,
		checkpointId: FrozenReplicaCheckpointRef["checkpointId"],
		snapshot: WorkspaceSnapshot,
		frozenAt: ISO8601,
	): FrozenReplicaCheckpointRef {
		return Object.freeze({
			providerId: found.lease.replica.providerId,
			profileId: found.lease.replica.profileId,
			workspaceId: found.lease.replica.workspaceId,
			replicaId: found.lease.replica.replicaId,
			leaseId: found.lease.leaseId,
			checkpointId,
			format: "omp-text-v1" as const,
			baseGeneration: found.lease.baseGeneration,
			frozenAt,
			rootSha256: snapshot.checkpoint.rootSha256,
			fileCount: snapshot.checkpoint.fileCount,
			byteCount: snapshot.checkpoint.byteCount,
		});
	}

	#referenceKey(reference: FrozenReplicaCheckpointRef): string {
		return `${key(reference)}\0${reference.leaseId}\0${reference.checkpointId}`;
	}

	#mutationDigest(found: Reservation): Sha256Hex {
		const mutations = [...found.mutations.entries()]
			.filter(([, record]) => record.kind !== "control")
			.sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
			.map(([requestId, record]) => [requestId, record.requestSha256]);
		return digest(mutations);
	}

	#recoveryImpossible(
		locator: Parameters<RuntimeProvider["recoveryFreeze"]>[0]["locator"],
		code:
			| "replica_absent"
			| "replica_image_missing"
			| "replica_image_invalid"
			| "acknowledged_mutation_ledger_incomplete",
	): Awaited<ReturnType<RuntimeProvider["recoveryFreeze"]>> {
		return {
			status: "preservation_impossible",
			proof: {
				locator,
				code,
				proofSha256: digest([
					"local-recovery-impossibility-v1",
					locator.recoveryFreezeId,
					key(locator.replica),
					locator.leaseId,
					locator.fenceId,
					locator.baseGeneration,
					locator.checkpointId,
					code,
				]),
				observedAt: now(),
			},
		};
	}

	#scheduleCacheEviction(cacheKey: string, state: CacheState, retryDelayMs?: number): void {
		if (state.completion || this.#cache.get(cacheKey) !== state) return;
		if (state.attempting) {
			state.rearmRequested = true;
			return;
		}
		this.#clearCacheEvictionTimer(state);
		const delay = Math.max(
			0,
			Math.min(2_147_483_647, retryDelayMs ?? Date.parse(state.acceptance.retentionDeadline) - Date.now()),
		);
		const timer = setTimeout(() => {
			state.timer = undefined;
			if (state.completion || this.#cache.get(cacheKey) !== state) return;
			state.attempting = true;
			let retry: number | undefined;
			void this.#exclusive(key(state.acceptance.replica), async () => {
				if (state.completion || this.#cache.get(cacheKey) !== state) return;
				if (Date.now() < Date.parse(state.acceptance.retentionDeadline)) {
					state.rearmRequested = true;
					return;
				}
				const found = this.#reservations.get(key(state.acceptance.replica));
				if (found && this.#cacheDeferral(found)) {
					retry = 1_000;
					state.rearmRequested = true;
					return;
				}
				await this.#completeCacheEviction(state, found);
			})
				.catch(() => {
					retry = 1_000;
					state.rearmRequested = true;
				})
				.finally(() => {
					state.attempting = false;
					if (state.rearmRequested && !state.completion && this.#cache.get(cacheKey) === state) {
						state.rearmRequested = false;
						this.#scheduleCacheEviction(cacheKey, state, retry);
					}
				});
		}, delay);
		state.timer = timer;
		timer.unref();
	}

	#scheduleReplicaCacheEvictions(replicaKey: string): void {
		for (const [cacheKey, state] of this.#cache) {
			if (key(state.acceptance.replica) === replicaKey) this.#scheduleCacheEviction(cacheKey, state);
		}
	}

	#clearCacheEvictionTimer(state: CacheState): void {
		clearTimeout(state.timer);
		state.timer = undefined;
	}

	async #completeCacheEviction(
		state: CacheState,
		found: Reservation | undefined,
	): Promise<NonNullable<CacheState["completion"]>> {
		if (state.completion) return state.completion;
		let outcome: NonNullable<CacheState["completion"]>["outcome"];
		if (!found) outcome = "absent";
		else if (found.root === null) outcome = "already_evicted";
		else {
			await rm(found.root, { recursive: true, force: true });
			found.root = null;
			found.image = null;
			found.checkpoints.clear();
			outcome = "evicted";
		}
		return this.#recordCacheEvictionCompletion(state, outcome);
	}

	#recordCacheEvictionCompletion(
		state: CacheState,
		outcome: NonNullable<CacheState["completion"]>["outcome"],
	): NonNullable<CacheState["completion"]> {
		if (state.completion) return state.completion;
		this.#clearCacheEvictionTimer(state);
		state.rearmRequested = false;
		state.completion = {
			acceptance: state.acceptance,
			outcome,
			completedAt: now(),
			receiptSha256: shaRef(["local-cache", state.acceptance.requestId, outcome]),
		};
		return state.completion;
	}

	#completeCacheEvictionsForDeletion(replicaKey: string): void {
		for (const state of this.#cache.values()) {
			if (key(state.acceptance.replica) === replicaKey) this.#recordCacheEvictionCompletion(state, "absent");
		}
	}

	#cacheDeferral(found: Reservation) {
		if (found.phase !== "released" && !(found.phase === "expired" && found.releaseTerminal))
			return "not_released" as const;
		if (this.#activeCommands(found) > 0) return "command_or_sync_ambiguous" as const;
		for (const checkpoint of found.checkpoints.values()) {
			if (!this.#acknowledgements.has(this.#referenceKey(checkpoint.reference)))
				return "checkpoint_unacknowledged" as const;
		}
		return null;
	}

	#terminalCommand(snapshot: RuntimeCommandSnapshot): boolean {
		return snapshot.status === "succeeded" || snapshot.status === "failed" || snapshot.status === "cancelled";
	}

	#commandNotStarted(record: CommandRecord): RuntimeCommandSnapshot {
		record.execution = null;
		record.snapshot = {
			commandId: record.snapshot.commandId,
			requestSha256: record.requestSha256,
			status: "reserved",
			sync: "pending",
			output: "",
			truncated: false,
			exitCode: null,
			signal: null,
			updatedAt: now(),
			execution: { certainty: "not_started", proof: "backend_absent" },
		};
		return record.snapshot;
	}

	#finishCommand(record: CommandRecord, outcome: IsolatedOutcome): RuntimeCommandSnapshot {
		if (this.#terminalCommand(record.snapshot) || record.snapshot.status === "reserved")
			return record.liveResult ?? record.snapshot;
		const output = outcome.output.subarray(0, record.outputByteLimit);
		const signal = this.#terminalSignal(outcome.signal);
		record.execution = null;
		record.snapshot = {
			commandId: record.snapshot.commandId,
			requestSha256: record.requestSha256,
			status:
				record.cancelRequested || outcome.cancelled || outcome.timedOut || outcome.signal
					? "cancelled"
					: outcome.code === 0
						? "succeeded"
						: "failed",
			sync: "complete",
			output: output.toString("utf8"),
			truncated: outcome.output.length > record.outputByteLimit,
			exitCode: outcome.code,
			signal,
			updatedAt: now(),
			execution: { certainty: "completed" },
		};
		record.liveResult = record.snapshot;
		return record.snapshot;
	}
	#commandUnknown(record: CommandRecord): RuntimeCommandSnapshot {
		if (record.liveResult) return record.liveResult;
		record.snapshot = {
			...record.snapshot,
			status: "start_unknown",
			sync: "pending",
			updatedAt: now(),
			execution: { certainty: "unknown" },
		};
		record.liveResult = record.snapshot;
		return record.snapshot;
	}

	async #settleCommand(record: CommandRecord): Promise<RuntimeCommandSnapshot> {
		if (record.liveResult) return record.liveResult;
		if (this.#terminalCommand(record.snapshot) || record.snapshot.status === "reserved") return record.snapshot;
		const execution = record.execution;
		if (!execution) return this.#commandNotStarted(record);
		try {
			return this.#finishCommand(record, await execution.outcome);
		} catch {
			if (await execution.terminateAndReap("SIGKILL")) record.execution = null;
			return this.#commandUnknown(record);
		}
	}

	async #terminateCommands(found: Reservation, signal: NodeJS.Signals): Promise<void> {
		const active = [...found.commands.values()].filter(
			record => record.snapshot.status === "running" || record.snapshot.status === "start_unknown",
		);
		const reaped = await Promise.all(
			active.map(async record => {
				record.cancelRequested = true;
				const execution = record.execution;
				if (execution && !(await execution.terminateAndReap(signal))) {
					this.#commandUnknown(record);
					return false;
				}
				await this.#settleCommand(record);
				if (execution && record.execution === execution) record.execution = null;
				return true;
			}),
		);
		if (reaped.includes(false)) throw new Error("local_process_reap_timeout");
	}

	#terminalSignal(signal: string | null): RuntimeCommandSnapshot["signal"] {
		switch (signal) {
			case null:
			case "SIGABRT":
			case "SIGBUS":
			case "SIGFPE":
			case "SIGHUP":
			case "SIGILL":
			case "SIGINT":
			case "SIGKILL":
			case "SIGPIPE":
			case "SIGQUIT":
			case "SIGSEGV":
			case "SIGTERM":
			case "SIGTRAP":
				return signal;
			default:
				return "other";
		}
	}
}
