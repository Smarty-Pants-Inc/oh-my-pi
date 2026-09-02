import { logger } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../extensibility/extensions";
import { buildRpcEndpointIdentity } from "../modes/rpc/rpc-identity";
import { runRpcMode } from "../modes/rpc/rpc-mode";
import { RPC_CAPABILITIES, RPC_HERDR_AGENTD_HOST_CAPABILITY, type RpcCanonicalAuthority } from "../modes/rpc/rpc-types";
import type { AgentSession } from "../session/agent-session";
import type { EventBus } from "../utils/event-bus";
import { HerdrCollabHostLifecycle, type ManagedHerdrHostBridge } from "./herdr-host-lifecycle";
import type { CollabHostContext } from "./host";

function createHeadlessHostContext(session: AgentSession, eventBus?: EventBus): CollabHostContext {
	return {
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		eventBus,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => {
				const usage = session.getContextUsage();
				return {
					usedTokens: usage?.tokens ?? 0,
					contextWindow: usage?.contextWindow ?? session.model?.contextWindow ?? 0,
				};
			},
		},
		ui: { requestRender: () => {} },
		showStatus: message => logger.debug(message),
		updatePendingMessagesDisplay: () => {},
	};
}

/** Start the private route before the first ready frame admits a stdio prompt. */
export async function runCollabRpcHost(
	session: AgentSession,
	bridge: ManagedHerdrHostBridge,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
	input?: ReadableStream<Uint8Array>,
): Promise<never> {
	const authority = Promise.withResolvers<RpcCanonicalAuthority>();
	void authority.promise.catch(() => {});
	const lifecycle = new HerdrCollabHostLifecycle(
		createHeadlessHostContext(session, eventBus),
		session,
		bridge,
		authority.promise,
	);
	try {
		await lifecycle.start();
		return await runRpcMode(session, setToolUIContext, eventBus, input, {
			identity: buildRpcEndpointIdentity([...RPC_CAPABILITIES, RPC_HERDR_AGENTD_HOST_CAPABILITY]),
			interceptControlFrame: frame => lifecycle.handleControlFrame(frame),
			onForkRejectedOrCancelled: () => lifecycle.clearHerdrAgentdRebind(),
			onBeforeSessionDispose: reason => lifecycle.stop(reason),
			publishAuthority: authority.resolve,
		});
	} catch (error) {
		authority.reject(error);
		await lifecycle.stop("RPC startup failed");
		throw error;
	}
}
