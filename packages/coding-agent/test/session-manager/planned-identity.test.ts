import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { TempDir } from "@oh-my-pi/pi-utils";

const CREATED_AT = "2026-08-06T12:34:56.789Z";
const PLANNED_SESSION_ID = "planned-session-id";
const PLANNED_INIT_ID = "planned-init-id";

const sessionInit = {
	systemPrompt: "planned system prompt",
	task: "planned task",
	tools: ["read"],
};

describe("SessionManager planned identity persistence", () => {
	it("synchronously writes the supplied path and exact planned header", async () => {
		using tempDir = TempDir.createSync("@pi-planned-session-header-");
		const cwd = tempDir.join("caller-cwd");
		const sessionFile = tempDir.join("planned", "exact-name.jsonl");
		const parentSession = "parent-session-id";
		const providerPromptCacheKey = "provider-cache-key";

		const session = SessionManager.createPlanned({
			sessionId: PLANNED_SESSION_ID,
			sessionFile,
			createdAt: CREATED_AT,
			cwd,
			parentSession,
			providerPromptCacheKey,
		});

		const header = {
			type: "session" as const,
			version: CURRENT_SESSION_VERSION,
			id: PLANNED_SESSION_ID,
			timestamp: CREATED_AT,
			cwd,
			parentSession,
			providerPromptCacheKey,
		};
		const persisted = await Bun.file(sessionFile).text();
		expect(session.getSessionFile()).toBe(sessionFile);
		expect(session.getSessionId()).toBe(PLANNED_SESSION_ID);
		expect(session.getHeader()).toEqual(header);
		expect(persisted).toBe(`${serializeTitleSlot({ updatedAt: CREATED_AT })}${JSON.stringify(header)}\n`);
	});

	it("persists the planned init ID and rejects empty or duplicate IDs without appending", async () => {
		using tempDir = TempDir.createSync("@pi-planned-session-init-");
		const sessionFile = path.join(tempDir.path(), "planned.jsonl");
		const session = SessionManager.createPlanned({
			sessionId: PLANNED_SESSION_ID,
			sessionFile,
			createdAt: CREATED_AT,
			cwd: tempDir.path(),
		});

		const untypedInit = {
			...sessionInit,
			type: "forged",
			id: "forged-init-id",
			parentId: "forged-parent-id",
			timestamp: "2000-01-01T00:00:00.000Z",
		} as unknown as typeof sessionInit;
		expect(session.appendPlannedSessionInit(PLANNED_INIT_ID, untypedInit)).toBe(PLANNED_INIT_ID);
		const persisted = await Bun.file(sessionFile).text();
		const plannedInit = session.getEntries().find(entry => entry.type === "session_init");
		expect(plannedInit).toMatchObject({ type: "session_init", id: PLANNED_INIT_ID, parentId: null, ...sessionInit });
		expect(plannedInit?.timestamp).not.toBe("2000-01-01T00:00:00.000Z");
		expect(JSON.parse(persisted.trimEnd().split("\n").at(-1)!)).toMatchObject({
			type: "session_init",
			id: PLANNED_INIT_ID,
			parentId: null,
			...sessionInit,
		});

		expect(() => session.appendPlannedSessionInit("", sessionInit)).toThrow();
		expect(() => session.appendPlannedSessionInit(PLANNED_INIT_ID, sessionInit)).toThrow();
		expect(session.getEntries()).toHaveLength(1);
		expect(await Bun.file(sessionFile).text()).toBe(persisted);
	});

	it("keeps ordinary session and init identity allocation independent from planned values", async () => {
		using tempDir = TempDir.createSync("@pi-ordinary-session-identity-");
		const session = SessionManager.create(tempDir.path(), tempDir.path());
		const ordinarySessionId = session.getSessionId();
		const ordinaryInitId = session.appendSessionInit(sessionInit);

		expect(ordinarySessionId).toBeTruthy();
		expect(ordinarySessionId).not.toBe(PLANNED_SESSION_ID);
		expect(ordinaryInitId).toBeTruthy();
		expect(ordinaryInitId).not.toBe(PLANNED_INIT_ID);
		expect(session.getHeader()?.id).toBe(ordinarySessionId);
	});
});
