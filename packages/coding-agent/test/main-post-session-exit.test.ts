import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

function disableStartupFeatures(parsed: Args, sessionDir: string): void {
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = sessionDir;
}

function sessionResult(options: CreateAgentSessionOptions, session: AgentSession): CreateAgentSessionResult {
	if (!options.eventBus || !options.preloadedExtensions) {
		throw new Error("Expected main to provide the session event bus and preloaded extensions");
	}
	return {
		session,
		extensionsResult: options.preloadedExtensions,
		setToolUIContext: () => {},
		eventBus: options.eventBus,
	};
}

async function expectPostCreationExit(options: { args: string[]; timing?: string; code: number }): Promise<void> {
	using tempDir = TempDir.createSync("@omp-post-session-exit-");
	const authStorage = await AuthStorage.create(`${tempDir.path()}/auth.db`);
	const settings = Settings.isolated({ "marketplace.autoUpdate": "off", "startup.changelogMode": "off" });
	const parsed = parseArgs(options.args);
	disableStartupFeatures(parsed, tempDir.path());
	const events: string[] = [];
	const session = {
		model: undefined,
		getAllToolNames: () => [],
		dispose: async () => {
			// AgentSession.dispose() emits session_shutdown; the companion turns that
			// event into its final stopped snapshot before postmortem may exit.
			events.push("session_shutdown:companion_stopped");
		},
	} as unknown as AgentSession;
	const previousTiming = process.env.PI_TIMING;
	if (options.timing) process.env.PI_TIMING = options.timing;
	else delete process.env.PI_TIMING;
	vi.spyOn(postmortem, "quit").mockImplementation(async code => {
		events.push(`postmortem:${code}`);
	});

	try {
		await runRootCommand(parsed, options.args, {
			discoverAuthStorage: async () => authStorage,
			settings,
			createAgentSession: async createOptions => sessionResult(createOptions ?? {}, session),
		});
		// Disposal must finish its shutdown/companion work before the final exit.
		expect(events).toEqual(["session_shutdown:companion_stopped", `postmortem:${options.code}`]);
	} finally {
		if (previousTiming === undefined) delete process.env.PI_TIMING;
		else process.env.PI_TIMING = previousTiming;
		authStorage.close();
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("runRootCommand post-session early exits", () => {
	it("disposes the no-model print session before preserving its exit code", async () => {
		await expectPostCreationExit({ args: ["--print"], code: 1 });
	}, 15_000);
});
