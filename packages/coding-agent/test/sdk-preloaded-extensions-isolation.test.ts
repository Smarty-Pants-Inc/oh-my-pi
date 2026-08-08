/**
 * Regression guard for issue #2190 / PR #2193 review.
 *
 * The CLI loads extensions early to parse custom flags, then hands the result
 * back through `preloadedExtensions` so its OWN session can reuse the loaded
 * instances without redoing the FS scan. `createAgentSession()` augments the
 * result with inline extensions (autoresearch + custom-tools wrapper), so it
 * MUST clone the caller's `extensions` array before mutating it — otherwise
 * the caller's array accumulates session-local wrappers it never authored.
 *
 * Subagent forwarding is a separate path (`preloadedExtensionPaths`) which
 * reloads extensions per session so each session's `ExtensionAPI` is its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createAgentSession, loadSessionExtensions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const EXPLICIT_TOOL_NAME = "public_unique_tool";
const AMBIENT_TOOL_NAME = "sdk_ambient_extension_parity_tool";
const HOST_TOOL_NAME = "host_companion_model_tool_sentinel";

function toolExtensionSource(name: string, label: string): string {
	return `export default function (pi) {
	const { Type } = pi.typebox;
	pi.registerTool({
		name: ${JSON.stringify(name)},
		label: ${JSON.stringify(label)},
		description: ${JSON.stringify(`${label} parity fixture`)},
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: ${JSON.stringify(label)} }], details: {} }),
	});
}\n`;
}

describe("createAgentSession preloadedExtensions isolation (issue #2190)", () => {
	let sharedDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let explicitExtensionPath: string;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-preloaded-ext-"));
		authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
		explicitExtensionPath = path.join(sharedDir, "explicit-parity-extension.ts");
		const ambientExtensionsDir = path.join(sharedDir, ".omp", "extensions");
		fs.mkdirSync(ambientExtensionsDir, { recursive: true });
		fs.writeFileSync(explicitExtensionPath, toolExtensionSource(EXPLICIT_TOOL_NAME, "explicit extension"));
		fs.writeFileSync(
			path.join(ambientExtensionsDir, "ambient-parity-extension.ts"),
			toolExtensionSource(AMBIENT_TOOL_NAME, "ambient extension"),
		);
	});

	afterAll(() => {
		authStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	it("does not mutate the caller's extensions array when preloadedExtensions is provided", async () => {
		const preloaded: LoadExtensionsResult = {
			extensions: [],
			errors: [],
			runtime: {
				flagValues: new Map(),
				pendingProviderRegistrations: [],
				// Cast: only the fields we touch matter; the SDK happily accepts a
				// minimal runtime when no extension hooks fire.
			} as unknown as LoadExtensionsResult["runtime"],
		};
		const beforeLength = preloaded.extensions.length;
		const beforeArrayRef = preloaded.extensions;

		const { session } = await createAgentSession({
			cwd: sharedDir,
			agentDir: sharedDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry,
			settings: Settings.isolated(),
			preloadedExtensions: preloaded,
			// Disable everything that would touch the network / FS scans.
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
		});

		try {
			// The session's own `extensionsResult` carries inline wrappers, but the
			// caller's array (and its identity) must be untouched.
			expect(preloaded.extensions).toBe(beforeArrayRef);
			expect(preloaded.extensions.length).toBe(beforeLength);
		} finally {
			await session.dispose();
		}
	});

	it("installs host handlers before public handlers only for top-level sessions", async () => {
		const createFixture = async (label: string) => {
			const order: string[] = [];
			const runtime = new ExtensionRuntime();
			const eventBus = new EventBus();
			const host = await loadExtensionFromFactory(
				pi => {
					const { Type } = pi.typebox;
					pi.registerTool({
						name: HOST_TOOL_NAME,
						label: "host companion sentinel",
						description: "must never enter public tool surfaces",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "host" }], details: {} }),
					});
					pi.on("session_start", () => {
						order.push("host");
					});
				},
				sharedDir,
				eventBus,
				runtime,
				`<host:${label}>`,
			);
			const publicExtension = await loadExtensionFromFactory(
				pi => {
					pi.on("session_start", () => {
						order.push("public");
					});
				},
				sharedDir,
				eventBus,
				runtime,
				`<public:${label}>`,
			);
			return {
				order,
				eventBus,
				hostInternalExtension: { extension: host },
				preloadedExtensions: { extensions: [publicExtension], errors: [], runtime },
			};
		};
		const createOptions = () => ({
			cwd: sharedDir,
			agentDir: sharedDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry,
			settings: Settings.isolated(),
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
		});

		const rootFixture = await createFixture("root");
		const root = await createAgentSession({
			...createOptions(),
			eventBus: rootFixture.eventBus,
			preloadedExtensions: rootFixture.preloadedExtensions,
			hostInternalExtension: rootFixture.hostInternalExtension,
		});
		try {
			await root.session.extensionRunner?.emit({ type: "session_start" });
			expect(rootFixture.order).toEqual(["host", "public"]);
			expect(root.session.getAllToolNames()).not.toContain(HOST_TOOL_NAME);
			expect(root.session.getActiveToolNames()).not.toContain(HOST_TOOL_NAME);
			expect(root.session.getXdevToolEntries().map(entry => entry.name)).not.toContain(HOST_TOOL_NAME);
		} finally {
			await root.session.dispose();
		}

		const childFixture = await createFixture("child");
		const child = await createAgentSession({
			...createOptions(),
			eventBus: childFixture.eventBus,
			preloadedExtensions: childFixture.preloadedExtensions,
			hostInternalExtension: childFixture.hostInternalExtension,
			parentTaskPrefix: "task:",
			taskDepth: 1,
		});
		try {
			await child.session.extensionRunner?.emit({ type: "session_start" });
			expect(childFixture.order).toEqual(["public"]);
			expect(child.session.getAllToolNames()).not.toContain(HOST_TOOL_NAME);
		} finally {
			await child.session.dispose();
		}
	});

	it("preserves the complete active tool set across the no-tools/no-extensions companion matrix", async () => {
		type ToolLocation = "active" | "xdev" | "absent";
		type ToolSnapshot = { active: string[]; all: string[]; xdev: string[] };

		const snapshotStartup = async (input: {
			label: string;
			marked: boolean;
			noTools: boolean;
			noExtensions: boolean;
		}): Promise<ToolSnapshot> => {
			const settings = Settings.isolated();
			const eventBus = new EventBus();
			const discoveryOptions = {
				additionalExtensionPaths: [explicitExtensionPath],
				...(input.noExtensions ? { disableExtensionDiscovery: true } : {}),
			};
			const preloadedExtensions = await loadSessionExtensions(discoveryOptions, sharedDir, settings, eventBus);
			const hostInternalExtension = input.marked
				? {
						extension: await loadExtensionFromFactory(
							pi => {
								const { Type } = pi.typebox;
								pi.registerTool({
									name: HOST_TOOL_NAME,
									label: "host companion sentinel",
									description: "must remain host-internal",
									parameters: Type.Object({}),
									execute: async () => ({
										content: [{ type: "text", text: "host" }],
										details: {},
									}),
								});
							},
							sharedDir,
							eventBus,
							preloadedExtensions.runtime,
							`<host:${input.label}>`,
						),
					}
				: undefined;
			const { session } = await createAgentSession({
				cwd: sharedDir,
				agentDir: sharedDir,
				sessionManager: SessionManager.inMemory(),
				modelRegistry,
				settings,
				eventBus,
				additionalExtensionPaths: [explicitExtensionPath],
				...(input.noTools ? { toolNames: [] } : {}),
				...(input.noExtensions ? { disableExtensionDiscovery: true } : {}),
				preloadedExtensions,
				hostInternalExtension,
				enableLsp: false,
				enableMCP: false,
				skipPythonPreflight: true,
				skills: [],
				rules: [],
				preloadedCustomToolPaths: [],
				contextFiles: [],
				promptTemplates: [],
			});
			try {
				return {
					active: session.getActiveToolNames().toSorted(),
					all: session.getAllToolNames().toSorted(),
					xdev: session
						.getXdevToolEntries()
						.map(entry => entry.name)
						.toSorted(),
				};
			} finally {
				await session.dispose();
			}
		};

		const expectLocation = (snapshot: ToolSnapshot, name: string, location: ToolLocation, label: string) => {
			const registered = snapshot.all.includes(name);
			const active = snapshot.active.includes(name);
			const mounted = snapshot.xdev.includes(name);
			switch (location) {
				case "active":
					expect(registered, `${label}: registered`).toBe(true);
					expect(active, `${label}: active`).toBe(true);
					expect(mounted, `${label}: xdev`).toBe(false);
					break;
				case "xdev":
					expect(registered, `${label}: registered`).toBe(true);
					expect(active, `${label}: active`).toBe(false);
					expect(mounted, `${label}: xdev`).toBe(true);
					break;
				case "absent":
					expect(registered, `${label}: registered`).toBe(false);
					expect(active, `${label}: active`).toBe(false);
					expect(mounted, `${label}: xdev`).toBe(false);
					break;
			}
		};

		const cases = [
			{ label: "default", noTools: false, noExtensions: false },
			{ label: "no-tools", noTools: true, noExtensions: false },
			{ label: "no-extensions", noTools: false, noExtensions: true },
			{ label: "no-tools-no-extensions", noTools: true, noExtensions: true },
		] as const;
		for (const testCase of cases) {
			const unmarked = await snapshotStartup({ ...testCase, marked: false });
			const marked = await snapshotStartup({ ...testCase, marked: true });
			expect(marked.active, `${testCase.label}: complete active set`).toEqual(unmarked.active);
			expect(marked.all, `${testCase.label}: complete registered set`).toEqual(unmarked.all);
			expect(marked.xdev, `${testCase.label}: complete xdev set`).toEqual(unmarked.xdev);

			const explicitLocation: ToolLocation = testCase.noTools ? "active" : "xdev";
			const ambientLocation: ToolLocation = testCase.noExtensions ? "absent" : testCase.noTools ? "active" : "xdev";
			for (const [kind, snapshot] of [
				["unmarked", unmarked],
				["marked", marked],
			] as const) {
				expectLocation(snapshot, EXPLICIT_TOOL_NAME, explicitLocation, `${testCase.label}:${kind}:explicit`);
				expectLocation(snapshot, AMBIENT_TOOL_NAME, ambientLocation, `${testCase.label}:${kind}:ambient`);
				expectLocation(snapshot, HOST_TOOL_NAME, "absent", `${testCase.label}:${kind}:host`);
			}
		}
	});
});
