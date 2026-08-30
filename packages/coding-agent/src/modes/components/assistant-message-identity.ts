import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { isSafeResponseAnchorId } from "../../session/response-anchor";
import { sameMessageContent, sessionMessagePersistenceKey } from "../../session/turn-persistence";

/** Whether two assistant messages represent the same durable response occurrence. */
export function matchesAssistantReplayMessage(current: AssistantMessage, message: AssistantMessage): boolean {
	const currentKey = sessionMessagePersistenceKey(current);
	if (currentKey !== undefined && currentKey === sessionMessagePersistenceKey(message)) {
		return sameMessageContent(current, message);
	}
	if (
		current.timestamp !== message.timestamp ||
		current.provider !== message.provider ||
		current.model !== message.model ||
		current.responseId !== message.responseId ||
		current.stopReason !== message.stopReason
	) {
		return false;
	}
	if (isSafeResponseAnchorId(current.responseAnchorId) && isSafeResponseAnchorId(message.responseAnchorId)) {
		return false;
	}
	return sameMessageContent(current, message);
}
