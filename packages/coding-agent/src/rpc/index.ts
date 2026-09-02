import type { Participant as WireParticipant } from "@oh-my-pi/pi-wire";

export type Participant = WireParticipant;

export * from "../modes/rpc/rpc-client";
export * from "../modes/rpc/rpc-identity";
export * from "../modes/rpc/rpc-types";
