import type { CollabFrame } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { CollabTransport, CollabTransportControl } from "@oh-my-pi/pi-coding-agent/collab/relay-client";

/** In-process directed CollabFrame router for transport-injection tests. */
export class InMemoryCollabRouter {
	#host: InMemoryCollabTransport | null = null;
	#guests = new Map<number, InMemoryCollabTransport>();
	#nextPeer = 1;
	readonly sent: { fromPeer: number; targetPeer: number; frame: CollabFrame }[] = [];

	host(): InMemoryCollabTransport {
		if (this.#host) throw new Error("in-memory collab host already exists");
		const transport = new InMemoryCollabTransport(this, 0, true);
		this.#host = transport;
		return transport;
	}

	guest(): InMemoryCollabTransport {
		const peer = this.#nextPeer++;
		const transport = new InMemoryCollabTransport(this, peer, false);
		this.#guests.set(peer, transport);
		return transport;
	}

	connect(transport: InMemoryCollabTransport): void {
		queueMicrotask(() => transport.onOpen?.());
	}

	send(from: InMemoryCollabTransport, frame: CollabFrame, targetPeer: number): void {
		this.sent.push({ fromPeer: from.peerId, targetPeer, frame });
		if (from.isHost) {
			if (targetPeer === 0) {
				for (const guest of this.#guests.values()) guest.deliver(frame, 0);
			} else {
				this.#guests.get(targetPeer)?.deliver(frame, 0);
			}
			return;
		}
		this.#host?.deliver(frame, from.peerId);
	}

	setAuthority(peer: number, canWrite: boolean): void {
		this.#host?.onControl?.({ t: "peer-authority", peer, canWrite });
	}

	close(transport: InMemoryCollabTransport): void {
		if (!transport.isHost) {
			this.#guests.delete(transport.peerId);
			this.#host?.onControl?.({ t: "peer-left", peer: transport.peerId });
		}
		queueMicrotask(() => transport.onClose?.("closed", false));
	}
}

export class InMemoryCollabTransport implements CollabTransport {
	onOpen?: () => void;
	onFrame?: (
		frame: CollabFrame,
		fromPeer: number,
		metadata?: { displayName?: string; displayNameRevision?: number },
	) => void;
	onControl?: (msg: CollabTransportControl) => void;
	onClose?: (reason: string, willReconnect: boolean) => void;
	#open = false;

	constructor(
		readonly router: InMemoryCollabRouter,
		readonly peerId: number,
		readonly isHost: boolean,
	) {}

	get isOpen(): boolean {
		return this.#open;
	}

	connect(): void {
		if (this.#open) return;
		this.#open = true;
		this.router.connect(this);
	}

	send(frame: CollabFrame, targetPeer = 0): boolean {
		if (!this.#open) return false;
		this.router.send(this, frame, targetPeer);
		return true;
	}

	close(): void {
		if (!this.#open) return;
		this.#open = false;
		this.router.close(this);
	}

	deliver(
		frame: CollabFrame,
		fromPeer: number,
		metadata?: { displayName?: string; displayNameRevision?: number },
	): void {
		if (this.#open) queueMicrotask(() => this.onFrame?.(frame, fromPeer, metadata));
	}
}
