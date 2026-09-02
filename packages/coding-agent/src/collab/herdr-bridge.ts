import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface HerdrHostDiscovery {
	socketPath: string;
	paneId: string;
}

export interface HerdrHostBridge {
	address: string;
	token: string;
	paneId: string;
}

const DISCOVERY_TIMEOUT_MS = 1_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Discover a fresh owner-authorized bridge credential for one Herdr pane. */
export async function discoverHerdrHostBridge(discovery: HerdrHostDiscovery): Promise<HerdrHostBridge> {
	if (
		!path.isAbsolute(discovery.socketPath) ||
		!discovery.paneId.trim() ||
		discovery.paneId.trim() !== discovery.paneId
	) {
		throw new Error("Invalid Herdr bridge discovery input");
	}
	const canonicalParent = await fs.realpath(path.dirname(discovery.socketPath));
	const socketPath = path.join(canonicalParent, path.basename(discovery.socketPath));
	const stat = await fs.lstat(socketPath);
	if (!stat.isSocket() || (process.geteuid && stat.uid !== process.geteuid())) {
		throw new Error("Herdr bridge discovery socket is not owned by this user");
	}
	const id = crypto.randomUUID();
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let socket: Bun.Socket<undefined> | undefined;
	let pending = "";
	let settled = false;
	const finish = (value: unknown, error = false) => {
		if (settled) return;
		settled = true;
		if (error) reject(value);
		else resolve(value);
		try {
			socket?.end();
		} catch {}
	};
	const timeout = setTimeout(() => finish(new Error("Herdr bridge discovery timed out"), true), DISCOVERY_TIMEOUT_MS);
	try {
		await Bun.connect({
			unix: socketPath,
			socket: {
				open: next => {
					socket = next;
					next.write(
						`${JSON.stringify({ id, method: "pane.omp_bridge", params: { pane_id: discovery.paneId } })}\n`,
					);
				},
				data: (_socket, data) => {
					pending += new TextDecoder().decode(data);
					if (Buffer.byteLength(pending) > MAX_RESPONSE_BYTES) {
						finish(new Error("Herdr bridge discovery response is too large"), true);
						return;
					}
					const newline = pending.indexOf("\n");
					if (newline < 0) return;
					try {
						finish(JSON.parse(pending.slice(0, newline)) as unknown);
					} catch {
						finish(new Error("Herdr bridge discovery response is malformed"), true);
					}
				},
				close: () => finish(new Error("Herdr bridge discovery closed without a response"), true),
				error: () => finish(new Error("Herdr bridge discovery failed"), true),
			},
		});
		const response = await promise;
		if (!response || typeof response !== "object") throw new Error("Herdr bridge discovery response is malformed");
		const record = response as Record<string, unknown>;
		const result = record.result;
		if (record.id !== id || !result || typeof result !== "object")
			throw new Error("Herdr bridge discovery response is malformed");
		const bridge = result as Record<string, unknown>;
		if (
			bridge.type !== "pane_omp_bridge" ||
			typeof bridge.address !== "string" ||
			!bridge.address.trim() ||
			typeof bridge.token !== "string" ||
			!bridge.token.trim() ||
			typeof bridge.pane_id !== "string" ||
			bridge.pane_id !== discovery.paneId
		) {
			throw new Error("Herdr bridge discovery response is malformed");
		}
		return { address: bridge.address, token: bridge.token, paneId: bridge.pane_id };
	} finally {
		clearTimeout(timeout);
		try {
			socket?.end();
		} catch {}
	}
}
