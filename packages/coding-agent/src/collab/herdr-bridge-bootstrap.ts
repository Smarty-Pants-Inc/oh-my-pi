export interface HerdrHostBridgeCredentials {
	address: string;
	token: string;
	paneId: string;
}

export interface HerdrOmpBridgeEnvironment {
	[name: string]: string | undefined;
	HERDR_OMP_BRIDGE?: string;
	HERDR_OMP_BRIDGE_TOKEN?: string;
	HERDR_OMP_GUEST_BRIDGE_TOKEN?: string;
	HERDR_PANE_ID?: string;
}

let pendingHostBridge: HerdrHostBridgeCredentials | undefined;
let pendingGuestBridgeToken: string | undefined;

export interface HerdrBridgeBootstrap {
	hostBridge?: HerdrHostBridgeCredentials;
	guestBridgeToken?: string;
}

/** Capture both bridge capabilities, delete both live values, then validate either one. */
export function captureHerdrBridgeBootstrap(env: HerdrOmpBridgeEnvironment = process.env): HerdrBridgeBootstrap {
	const address = env.HERDR_OMP_BRIDGE;
	const hostToken = env.HERDR_OMP_BRIDGE_TOKEN;
	const guestToken = env.HERDR_OMP_GUEST_BRIDGE_TOKEN;
	const paneId = env.HERDR_PANE_ID;
	delete env.HERDR_OMP_BRIDGE_TOKEN;
	delete env.HERDR_OMP_GUEST_BRIDGE_TOKEN;

	let hostBridge: HerdrHostBridgeCredentials | undefined;
	if (hostToken !== undefined) {
		if (!hostToken.trim() || !address?.trim() || !paneId?.trim()) {
			throw new Error(
				"Incomplete Herdr OMP bridge environment: HERDR_OMP_BRIDGE, HERDR_OMP_BRIDGE_TOKEN, and HERDR_PANE_ID must all be non-empty",
			);
		}
		hostBridge = { address, token: hostToken, paneId };
	}
	if (guestToken !== undefined && !guestToken.trim()) {
		throw new Error("Incomplete Herdr OMP guest bridge environment: HERDR_OMP_GUEST_BRIDGE_TOKEN must be non-empty");
	}
	return { hostBridge, guestBridgeToken: guestToken };
}

export function handoffHerdrHostBridge(credentials: HerdrHostBridgeCredentials | undefined): void {
	pendingHostBridge = credentials;
}

export function handoffHerdrGuestBridgeToken(token: string | undefined): void {
	pendingGuestBridgeToken = token;
}

export function takeHerdrHostBridge(): HerdrHostBridgeCredentials | undefined {
	const credentials = pendingHostBridge;
	pendingHostBridge = undefined;
	return credentials;
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
