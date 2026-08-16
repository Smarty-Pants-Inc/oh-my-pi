import * as path from "node:path";
import type { ClientBridge } from "./client-bridge";

export type ExecutionEnvironmentBridge = Required<
	Pick<ClientBridge, "readTextFile" | "writeTextFile" | "createTerminal">
>;

export interface ExecutionEnvironmentRequest {
	ownerId: string;
	sessionId: string;
	sourceRoot: string;
	signal?: AbortSignal;
}

export interface ExecutionEnvironmentBinding {
	readonly id: string;
	readonly sourceRoot: string;
	readonly remoteRoot: string;
	readonly bridge: ExecutionEnvironmentBridge;
}

export interface ExecutionEnvironmentLease extends ExecutionEnvironmentBinding {
	syncBack(signal?: AbortSignal): Promise<void>;
	/** Resolves only after no provider process or later flush can mutate the workspace. */
	release(): Promise<void>;
}

export interface ExecutionEnvironmentProvider {
	acquire(request: ExecutionEnvironmentRequest): Promise<ExecutionEnvironmentLease>;
}

type PathApi = typeof path.posix;

function isPathWithin(pathApi: PathApi, root: string, candidate: string): boolean {
	const relative = pathApi.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative))
	);
}

function requireCanonicalAbsolute(pathApi: PathApi, value: string, label: string): void {
	if (!pathApi.isAbsolute(value) || pathApi.resolve(value) !== value) {
		throw new Error(`${label} must be a canonical absolute path: ${value}`);
	}
}

function toRemotePath(pathApi: PathApi, sourceRoot: string, remoteRoot: string, sourcePath: string): string {
	const relative = pathApi.relative(sourceRoot, sourcePath);
	if (relative === "") return remoteRoot;
	return path.posix.join(remoteRoot, ...relative.split(pathApi.sep));
}

/**
 * Map a workspace path into the execution environment's POSIX namespace.
 *
 * Relative paths resolve below `sourceRoot`. Canonical absolute paths below
 * `sourceRoot` map to the corresponding path below `remoteRoot`, while
 * canonical absolute paths already below `remoteRoot` are returned unchanged.
 * Every other path is rejected.
 */
export function mapExecutionEnvironmentPath(
	environment: Pick<ExecutionEnvironmentBinding, "sourceRoot" | "remoteRoot">,
	inputPath: string,
): string {
	if (inputPath.length === 0 || inputPath.includes("\0")) {
		throw new Error("Execution environment path must be a non-empty filesystem path");
	}

	const localPath =
		path.win32.isAbsolute(environment.sourceRoot) && !path.posix.isAbsolute(environment.sourceRoot)
			? path.win32
			: path.posix;
	requireCanonicalAbsolute(localPath, environment.sourceRoot, "Execution environment sourceRoot");
	requireCanonicalAbsolute(path.posix, environment.remoteRoot, "Execution environment remoteRoot");

	if (path.posix.isAbsolute(inputPath)) {
		requireCanonicalAbsolute(path.posix, inputPath, "Execution environment path");
		if (isPathWithin(path.posix, environment.remoteRoot, inputPath)) return inputPath;
		if (localPath === path.posix && isPathWithin(localPath, environment.sourceRoot, inputPath)) {
			return toRemotePath(localPath, environment.sourceRoot, environment.remoteRoot, inputPath);
		}
		throw new Error(`Path is outside the execution environment workspace: ${inputPath}`);
	}

	if (localPath.isAbsolute(inputPath)) {
		requireCanonicalAbsolute(localPath, inputPath, "Execution environment path");
		if (!isPathWithin(localPath, environment.sourceRoot, inputPath)) {
			throw new Error(`Path is outside the execution environment workspace: ${inputPath}`);
		}
		return toRemotePath(localPath, environment.sourceRoot, environment.remoteRoot, inputPath);
	}

	if (path.win32.isAbsolute(inputPath)) {
		throw new Error(`Path is outside the execution environment workspace: ${inputPath}`);
	}

	const resolvedSourcePath = localPath.resolve(environment.sourceRoot, inputPath);
	if (!isPathWithin(localPath, environment.sourceRoot, resolvedSourcePath)) {
		throw new Error(`Path is outside the execution environment workspace: ${inputPath}`);
	}
	return toRemotePath(localPath, environment.sourceRoot, environment.remoteRoot, resolvedSourcePath);
}
