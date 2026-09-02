import { VERSION } from "@oh-my-pi/pi-utils";
import { OMP_BUILD_ID } from "../../build-identity";
import { RPC_CAPABILITIES, type RpcEndpointIdentity } from "./rpc-types";

/** Build the complete immutable identity emitted in the first RPC frame. */
export function buildRpcEndpointIdentity(capabilities: readonly string[] = RPC_CAPABILITIES): RpcEndpointIdentity {
	return {
		buildId: OMP_BUILD_ID,
		version: VERSION,
		protocolVersion: 1,
		supportedProtocolVersions: [1, 2],
		capabilities,
	};
}
