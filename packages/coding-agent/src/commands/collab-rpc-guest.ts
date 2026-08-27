import { Command } from "@oh-my-pi/pi-utils/cli";
import { takeHerdrGuestBridgeToken } from "../collab/herdr-bridge-bootstrap";
import { runCollabRpcGuest } from "../collab/rpc-guest";

/** Hidden gateway-only Collab guest that exposes the regular OMP RPC protocol. */
export default class CollabRpcGuestCommand extends Command {
	static hidden = true;
	static strict = false;

	async run(): Promise<void> {
		const [address, roomId, tokenArg] = this.argv;
		if (!address || !roomId || tokenArg !== "--token-env") {
			throw new Error("__collab-rpc-guest requires <address> <room-id> --token-env");
		}
		const token = takeHerdrGuestBridgeToken();
		if (!token) {
			throw new Error("__collab-rpc-guest requires HERDR_OMP_GUEST_BRIDGE_TOKEN");
		}
		await runCollabRpcGuest({ address, roomId, token });
	}
}
