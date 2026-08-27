import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseAddress } from "./local-transport";

export interface HerdrBridgeDiscovery {
	socketPath: string;
	paneId: string;
}

export interface HerdrHostBridgeCredentials {
	address: string;
	token: string;
	paneId: string;
}

export interface HerdrHostBridgeBootstrap {
	current?: HerdrHostBridgeCredentials;
	discovery: HerdrBridgeDiscovery;
}

export interface HerdrOmpBridgeEnvironment {
	[name: string]: string | undefined;
	HERDR_OMP_BRIDGE?: string;
	HERDR_OMP_BRIDGE_TOKEN?: string;
	HERDR_OMP_GUEST_BRIDGE_TOKEN?: string;
	HERDR_PANE_ID?: string;
	HERDR_SOCKET_PATH?: string;
}

let pendingHostBridge: HerdrHostBridgeBootstrap | undefined;
let pendingGuestBridgeToken: string | undefined;

export interface HerdrBridgeBootstrap {
	hostBridge?: HerdrHostBridgeBootstrap;
	guestBridgeToken?: string;
}

/** Capture bridge values and retain discovery only when Herdr advertised a managed bridge. */
export function captureHerdrBridgeBootstrap(
	env: HerdrOmpBridgeEnvironment = process.env,
	platform: NodeJS.Platform = process.platform,
): HerdrBridgeBootstrap {
	const address = env.HERDR_OMP_BRIDGE;
	const hostToken = env.HERDR_OMP_BRIDGE_TOKEN;
	const guestToken = env.HERDR_OMP_GUEST_BRIDGE_TOKEN;
	const paneId = env.HERDR_PANE_ID;
	const socketPath = env.HERDR_SOCKET_PATH;
	delete env.HERDR_OMP_BRIDGE_TOKEN;
	delete env.HERDR_OMP_GUEST_BRIDGE_TOKEN;

	const bridgeCapable = Boolean(address?.trim());
	const hostBridgeDiscovery =
		platform !== "win32" && bridgeCapable && socketPath?.trim() && paneId?.trim()
			? { socketPath, paneId }
			: undefined;
	let currentHostBridge: HerdrHostBridgeCredentials | undefined;
	if (hostToken?.trim() && address?.trim() && paneId?.trim()) {
		currentHostBridge = { address, token: hostToken, paneId };
	}
	const guestBridgeToken = guestToken?.trim() ? guestToken : undefined;
	const hostBridge = hostBridgeDiscovery ? { current: currentHostBridge, discovery: hostBridgeDiscovery } : undefined;
	return { hostBridge, guestBridgeToken };
}

const DISCOVERY_TIMEOUT_MS = 1_000;
const MAX_DISCOVERY_RESPONSE_BYTES = 64 * 1024;

function discoveryFailure(reason: string): Error {
	return new Error(`Herdr OMP bridge discovery failed: ${reason}`);
}

/** Resolve and validate the exact Unix socket path before any local API connection. */
export async function validateHerdrSocketPath(socketPath: string, effectiveUid = process.geteuid?.()): Promise<string> {
	if (
		effectiveUid === undefined ||
		!Number.isSafeInteger(effectiveUid) ||
		effectiveUid < 0 ||
		!socketPath ||
		socketPath.trim() !== socketPath ||
		!path.isAbsolute(socketPath)
	) {
		throw discoveryFailure("unsafe local API socket path");
	}

	const canonicalParent = await fs.realpath(path.dirname(socketPath)).catch(() => undefined);
	if (!canonicalParent) throw discoveryFailure("unsafe local API socket path");
	const canonicalPath = path.join(canonicalParent, path.basename(socketPath));
	const socketStat = await fs.lstat(canonicalPath).catch(() => undefined);
	if (!socketStat?.isSocket() || socketStat.uid !== effectiveUid) {
		throw discoveryFailure("local API path is not an effective-user-owned Unix socket");
	}

	let parent = path.dirname(canonicalPath);
	for (;;) {
		const parentStat = await fs.lstat(parent).catch(() => undefined);
		if (!parentStat?.isDirectory() || (parentStat.uid !== effectiveUid && parentStat.uid !== 0)) {
			throw discoveryFailure("local API socket has an unsafe parent directory");
		}
		const crossUserWritable = (parentStat.mode & 0o022) !== 0;
		const rootOwnedSticky = parentStat.uid === 0 && (parentStat.mode & 0o1000) !== 0;
		if (crossUserWritable && (!rootOwnedSticky || parent === canonicalParent)) {
			// A private descendant pins the pathname below a shared sticky directory;
			// the socket itself cannot safely be pinned when it lives directly there.
			throw discoveryFailure("local API socket has an unsafe parent directory mode");
		}
		const next = path.dirname(parent);
		if (next === parent) break;
		parent = next;
	}
	return canonicalPath;
}

async function requestHerdrBridge(socketPath: string, request: Record<string, unknown>): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const decoder = new TextDecoder();
	let socket: Bun.Socket<undefined> | undefined;
	let pending = "";
	let pendingBytes = 0;
	let settled = false;
	const rejectOnce = (reason: string): void => {
		if (settled) return;
		settled = true;
		reject(discoveryFailure(reason));
		try {
			socket?.end();
		} catch {}
	};
	const resolveOnce = (line: string): void => {
		if (settled) return;
		settled = true;
		resolve(line);
	};
	const timer = setTimeout(() => rejectOnce("local API request timed out"), DISCOVERY_TIMEOUT_MS);

	void Bun.connect({
		unix: socketPath,
		socket: {
			open(next) {
				if (settled) {
					next.end();
					return;
				}
				socket = next;
				next.write(`${JSON.stringify(request)}\n`);
			},
			data(_socket, data) {
				if (settled) return;
				pendingBytes += data.byteLength;
				if (pendingBytes > MAX_DISCOVERY_RESPONSE_BYTES) {
					rejectOnce("local API response was too large");
					return;
				}
				pending += decoder.decode(data, { stream: true });
				const newline = pending.indexOf("\n");
				if (newline >= 0) resolveOnce(pending.slice(0, newline));
			},
			close() {
				rejectOnce("local API closed before responding");
			},
			error() {
				rejectOnce("local API request failed");
			},
		},
	}).catch(() => rejectOnce("local API request failed"));

	let line: string;
	try {
		line = await promise;
	} finally {
		clearTimeout(timer);
		try {
			socket?.end();
		} catch {}
	}
	try {
		return JSON.parse(line) as unknown;
	} catch {
		throw discoveryFailure("malformed local API response");
	}
}

/** Discover a pane-bound host bridge from Herdr's owner-only local API. */
export async function discoverHerdrHostBridge(discovery: HerdrBridgeDiscovery): Promise<HerdrHostBridgeCredentials> {
	if (!discovery.paneId || discovery.paneId.trim() !== discovery.paneId) {
		throw discoveryFailure("invalid pane identity");
	}
	const socketPath = await validateHerdrSocketPath(discovery.socketPath);
	const id = crypto.randomUUID();
	const response = await requestHerdrBridge(socketPath, {
		id,
		method: "pane.omp_bridge",
		params: { pane_id: discovery.paneId },
	});
	if (!response || typeof response !== "object") throw discoveryFailure("malformed local API response");
	const record = response as Record<string, unknown>;
	if (record.id !== id) throw discoveryFailure("malformed local API response");
	if ("error" in record) throw discoveryFailure("local API denied bridge discovery");
	if (!record.result || typeof record.result !== "object") {
		throw discoveryFailure("malformed local API response");
	}
	const result = record.result as Record<string, unknown>;
	if (
		result.type !== "pane_omp_bridge" ||
		typeof result.pane_id !== "string" ||
		!result.pane_id.trim() ||
		result.pane_id.trim() !== result.pane_id ||
		typeof result.address !== "string" ||
		!result.address.trim() ||
		typeof result.token !== "string" ||
		!result.token.trim()
	) {
		throw discoveryFailure("malformed local API response");
	}
	try {
		parseAddress(result.address);
	} catch {
		throw discoveryFailure("malformed local API response");
	}
	return {
		address: result.address,
		token: result.token,
		paneId: result.pane_id,
	};
}

/** Authenticated discovery is mandatory; inherited credentials are never authoritative. */
export async function resolveHerdrHostBridge(
	bootstrap: HerdrHostBridgeBootstrap | undefined,
): Promise<HerdrHostBridgeCredentials | undefined> {
	if (!bootstrap?.discovery) return undefined;
	return discoverHerdrHostBridge(bootstrap.discovery);
}

export function handoffHerdrHostBridge(bootstrap: HerdrHostBridgeBootstrap | undefined): void {
	pendingHostBridge = bootstrap;
}

export function handoffHerdrGuestBridgeToken(token: string | undefined): void {
	pendingGuestBridgeToken = token;
}

export function takeHerdrHostBridge(): HerdrHostBridgeBootstrap | undefined {
	const bootstrap = pendingHostBridge;
	pendingHostBridge = undefined;
	return bootstrap;
}

export function takeHerdrGuestBridgeToken(): string | undefined {
	const token = pendingGuestBridgeToken;
	pendingGuestBridgeToken = undefined;
	return token;
}

export function clearHerdrHostBridgeHandoff(): void {
	pendingHostBridge = undefined;
}

export function clearHerdrGuestBridgeTokenHandoff(): void {
	pendingGuestBridgeToken = undefined;
}
