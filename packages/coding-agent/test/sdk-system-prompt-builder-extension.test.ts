import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { compareUnicodeCodePoints, sha256 } from "@oh-my-pi/pi-coding-agent/context/canonical";
import { type ContextReleaseManifest, stackPackageContentSha256 } from "@oh-my-pi/pi-coding-agent/context/manifest";
import type { ExtensionFactory, ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	testSetApprovedStartupManifest,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { markOmpInternalSession } from "../src/context/internal-session";

registerMockApi();
afterEach(() => testSetApprovedStartupManifest(undefined));

async function createTestSession(tempDir: TempDir, extensions: ExtensionFactory[]) {
	const auth = await AuthStorage.create(tempDir.join("auth.db"));
	auth.setRuntimeApiKey("mock", "test-key");
	const model = createMockModel({ id: "text", handler: () => ({ content: ["ok"] }) });
	const sessionManager = SessionManager.inMemory(tempDir.path());
	try {
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: auth,
			modelRegistry: new ModelRegistry(auth, tempDir.join("models.yml")),
			model,
			settings: Settings.isolated({
				"async.enabled": false,
				"marketplace.autoUpdate": "off",
			}),
			sessionManager,
			disableExtensionDiscovery: true,
			extensions,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
		});
		return { ...result, auth, model, sessionManager };
	} catch (error) {
		auth.close();
		throw error;
	}
}
function writeMaterializedPromptBuilderPackage(
	root: string,
	markerPath: string,
	registersBuilder = true,
	mismatchTriggerPath?: string,
): {
	sourcePath: string;
	release: ContextReleaseManifest;
} {
	const repository = "Smarty-Pants-Inc/smarty-stack";
	const commit = "a".repeat(40);
	const tree = "b".repeat(40);
	const version = "0.20.11";
	const createdAt = "2026-08-22";
	const stackRoot = path.join(root, ".smarty-stack");
	const packageRoot = path.join(stackRoot, "versions", version);
	const currentRoot = path.join(stackRoot, "current");
	const sourcePath = "extensions/smarty-prompt-guard/src/index.ts";
	const mismatchSource = mismatchTriggerPath
		? `\t\tif (await Bun.file(${JSON.stringify(mismatchTriggerPath)}).exists()) return { systemPrompt: ["mismatch"] };\n`
		: "";
	const sources = new Map<string, string>([
		[
			"PROVENANCE.json",
			`${JSON.stringify(
				{
					schema: "smarty.stack.provenance.v1",
					version,
					repository,
					commit,
					tree,
					createdAt,
					purpose: "test materialized prompt guard",
					sources: [],
					authority: [],
					recovery: {},
					nonclaims: [],
				},
				null,
				2,
			)}\n`,
		],
		["VERSION", `${version}\n`],
		[
			"extensions/smarty-prompt-guard/package.json",
			`${JSON.stringify({ name: "test-prompt-guard", version, type: "module" })}\n`,
		],
		[
			sourcePath,
			registersBuilder
				? `export default function register(pi) {
	pi.registerSystemPromptBuilder(async context => {
		await Bun.write(${JSON.stringify(markerPath)}, "verified\\n");
${mismatchSource}		return context.build(context.templates);
	});
}
`
				: "export default function register() {}\n",
		],
	]);
	for (const [relative, source] of sources) {
		const absolute = path.join(packageRoot, relative);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, source);
	}
	const encoder = new TextEncoder();
	const manifestSource = `${JSON.stringify(
		{
			schema: "smarty.stack.release_manifest.v1",
			version,
			createdAt,
			status: "protected_candidate_requires_external_approval",
			files: [...sources]
				.sort(([left], [right]) => compareUnicodeCodePoints(left, right))
				.map(([relative, source]) => ({
					path: relative,
					bytes: encoder.encode(source).byteLength,
					sha256: sha256(source),
				})),
		},
		null,
		2,
	)}\n`;
	fs.writeFileSync(path.join(packageRoot, "MANIFEST.json"), manifestSource);
	const checksumSources = new Map(sources);
	checksumSources.set("MANIFEST.json", manifestSource);
	fs.writeFileSync(
		path.join(packageRoot, "SHA256SUMS.txt"),
		[...checksumSources]
			.sort(([left], [right]) => compareUnicodeCodePoints(left, right))
			.map(([relative, source]) => `${sha256(source)}  ${relative}\n`)
			.join(""),
	);
	fs.symlinkSync(path.join("versions", version), currentRoot);
	const chmodTree = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) chmodTree(target);
			else if (entry.isFile()) fs.chmodSync(target, 0o444);
		}
		fs.chmodSync(directory, 0o555);
	};
	chmodTree(packageRoot);
	const contentSha256 = stackPackageContentSha256(
		[...sources]
			.sort(([left], [right]) => compareUnicodeCodePoints(left, right))
			.map(([path, source]) => ({ path, sha256: sha256(source) })),
	);
	return {
		sourcePath: path.join(currentRoot, sourcePath),
		release: {
			candidates: [{ repository, commit, tree }],
			stackPackageContentSha256: contentSha256,
		} as unknown as ContextReleaseManifest,
	};
}

describe("extension system prompt builders", () => {
	it("owns the initial and rebuilt provider-facing base prompt", async () => {
		using tempDir = TempDir.createSync("@omp-system-prompt-builder-");
		const laterDir = tempDir.join("later");
		fs.mkdirSync(laterDir);
		let builds = 0;
		let hasUI: boolean | undefined;
		const extension: ExtensionFactory = pi => {
			pi.registerSystemPromptBuilder(({ hasUI: builderHasUI, options }) => {
				builds += 1;
				hasUI = builderHasUI;
				return {
					systemPrompt: [`builder:${options.cwd};roots:${options.additionalWorkspaceRoots?.join(",") ?? ""}`],
				};
			});
		};
		const { session, auth, model, sessionManager } = await createTestSession(tempDir, [extension]);
		try {
			expect(session.systemPrompt).toEqual([`builder:${tempDir.path()};roots:`]);
			await sessionManager.addWorkspaceDirectory(laterDir);
			await session.refreshBaseSystemPrompt();
			expect(session.systemPrompt).toEqual([`builder:${tempDir.path()};roots:${laterDir}`]);
			expect(builds).toBe(2);
			expect(hasUI).toBe(false);

			await session.prompt("noop");
			const providerPrompt = model.calls?.at(-1)?.context?.systemPrompt;
			expect(providerPrompt).toEqual(session.systemPrompt);
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	it("can render the stock pipeline with a complete modified template set", async () => {
		using tempDir = TempDir.createSync("@omp-system-prompt-templates-");
		const extension: ExtensionFactory = pi => {
			pi.registerSystemPromptBuilder(context =>
				context.build({
					...context.templates,
					system: `${context.templates.system}\n<system-template-marker>builder-system</system-template-marker>`,
					project: `${context.templates.project}\n<builder-marker>{{cwd}}</builder-marker>`,
				}),
			);
		};
		const { session, auth } = await createTestSession(tempDir, [extension]);
		try {
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain("<system-template-marker>builder-system</system-template-marker>");
			expect(prompt).toContain(`<builder-marker>${tempDir.path()}</builder-marker>`);
		} finally {
			await session.dispose();
			auth.close();
		}
	});

	it("fails closed when multiple extensions register builders", async () => {
		using tempDir = TempDir.createSync("@omp-system-prompt-conflict-");
		const extension: ExtensionFactory = pi => {
			pi.registerSystemPromptBuilder(() => ({ systemPrompt: ["builder"] }));
		};
		await expect(createTestSession(tempDir, [extension, extension])).rejects.toThrow(
			"Multiple system prompt builders registered",
		);
	});
	it("executes the approved materialized builder and fails closed on package drift", async () => {
		using tempDir = TempDir.createSync("@omp-protected-system-prompt-builder-");
		const markerPath = tempDir.join("builder-ran.txt");
		const { sourcePath, release } = writeMaterializedPromptBuilderPackage(tempDir.join("stack"), markerPath);
		testSetApprovedStartupManifest(release);
		const auth = await AuthStorage.create(tempDir.join("auth.db"));
		auth.setRuntimeApiKey("mock", "test-key");
		const model = createMockModel({ id: "protected-text", handler: () => ({ content: ["ok"] }) });
		const modelRegistry = new ModelRegistry(auth, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"async.enabled": false,
			"marketplace.autoUpdate": "off",
		});
		const createProtectedSession = (
			hasUI: boolean,
			extensionPath: string | undefined = sourcePath,
			overrides: Partial<CreateAgentSessionOptions> = {},
			internal = false,
		) => {
			const options: CreateAgentSessionOptions = {
				cwd: tempDir.path(),
				authStorage: auth,
				modelRegistry,
				model,
				settings,
				sessionManager: SessionManager.inMemory(tempDir.path()),
				disableExtensionDiscovery: true,
				additionalExtensionPaths: extensionPath ? [extensionPath] : [],
				hasUI,
				enableMCP: false,
				enableLsp: false,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				workspaceTree: {
					rootPath: tempDir.path(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				...overrides,
			};
			return createAgentSession(internal ? markOmpInternalSession(options) : options);
		};
		try {
			const approved = await createProtectedSession(false);
			try {
				expect(fs.readFileSync(markerPath, "utf8")).toBe("verified\n");
			} finally {
				await approved.session.dispose();
			}

			const selfAttestedMarkerPath = tempDir.join("self-attested-builder-ran.txt");
			const selfAttested = writeMaterializedPromptBuilderPackage(
				tempDir.join("self-attested-stack"),
				selfAttestedMarkerPath,
			);
			await expect(createProtectedSession(false, selfAttested.sourcePath)).rejects.toThrow(
				"PROMPT_POLICY_REVIEW_REQUIRED: one or more configured system prompt builder sources are not approved",
			);
			expect(fs.existsSync(selfAttestedMarkerPath)).toBe(false);

			await expect(
				createProtectedSession(false, sourcePath, { systemPrompt: ["external override"] }),
			).rejects.toThrow(
				"PROMPT_POLICY_REVIEW_REQUIRED: provider-facing system prompt differs from the approved stock prompt",
			);

			const internal = await createProtectedSession(
				false,
				undefined,
				{
					systemPrompt: ["governed internal prompt"],
					restrictToolNames: true,
					toolNames: [],
				},
				true,
			);
			try {
				expect(internal.session.systemPrompt).toEqual(["governed internal prompt"]);
			} finally {
				await internal.session.dispose();
			}

			await expect(
				createProtectedSession(false, undefined, {
					systemPrompt: ["forged internal prompt"],
					restrictToolNames: true,
					toolNames: [],
				}),
			).rejects.toThrow("PROMPT_POLICY_REVIEW_REQUIRED: an approved system prompt builder is required");

			fs.rmSync(markerPath, { force: true });
			fs.chmodSync(sourcePath, 0o644);
			fs.appendFileSync(sourcePath, "// drift\n");
			await expect(createProtectedSession(false)).rejects.toThrow(
				"PROMPT_POLICY_REVIEW_REQUIRED: one or more configured system prompt builder sources are not approved",
			);

			const interactive = await createProtectedSession(true);
			try {
				const statuses: Array<[string, string | undefined]> = [];
				const notifications: Array<[string, string]> = [];
				interactive.setToolUIContext(
					{
						setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
						notify: (message: string, level: string) => notifications.push([message, level]),
					} as unknown as ExtensionUIContext,
					true,
				);
				expect(interactive.session.systemPrompt.length).toBeGreaterThan(0);
				expect(fs.existsSync(markerPath)).toBe(false);
				expect(statuses).toContainEqual(["omp-prompt-policy", "Prompt policy: REVIEW REQUIRED"]);
				expect(notifications).toContainEqual([
					"PROMPT_POLICY_REVIEW_REQUIRED: one or more configured system prompt builder sources are not approved",
					"warning",
				]);
			} finally {
				await interactive.session.dispose();
			}

			const withoutBuilder = writeMaterializedPromptBuilderPackage(
				tempDir.join("stack-without-builder"),
				tempDir.join("unused-marker.txt"),
				false,
			);
			testSetApprovedStartupManifest(withoutBuilder.release);
			await expect(createProtectedSession(false, withoutBuilder.sourcePath)).rejects.toThrow(
				"PROMPT_POLICY_REVIEW_REQUIRED: an approved system prompt builder is required",
			);

			const mismatchTriggerPath = tempDir.join("mismatch-trigger");
			const mismatch = writeMaterializedPromptBuilderPackage(
				tempDir.join("stack-mismatch"),
				tempDir.join("mismatch-marker.txt"),
				true,
				mismatchTriggerPath,
			);
			testSetApprovedStartupManifest(mismatch.release);
			fs.writeFileSync(mismatchTriggerPath, "on\n");
			await expect(createProtectedSession(false, mismatch.sourcePath)).rejects.toThrow(
				"PROMPT_POLICY_REVIEW_REQUIRED: provider-facing system prompt differs from the approved stock prompt",
			);

			const initialMismatch = await createProtectedSession(true, mismatch.sourcePath);
			try {
				const statuses: Array<[string, string | undefined]> = [];
				const notifications: Array<[string, string]> = [];
				initialMismatch.setToolUIContext(
					{
						setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
						notify: (message: string, level: string) => notifications.push([message, level]),
					} as unknown as ExtensionUIContext,
					true,
				);
				expect(statuses).toContainEqual(["omp-prompt-policy", "Prompt policy: REVIEW REQUIRED"]);
				expect(notifications).toContainEqual([
					"PROMPT_POLICY_REVIEW_REQUIRED: provider-facing system prompt differs from the approved stock prompt",
					"warning",
				]);
			} finally {
				await initialMismatch.session.dispose();
			}

			fs.rmSync(mismatchTriggerPath);
			const rebuildMismatch = await createProtectedSession(true, mismatch.sourcePath);
			try {
				const statuses: Array<[string, string | undefined]> = [];
				const notifications: Array<[string, string]> = [];
				rebuildMismatch.setToolUIContext(
					{
						setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
						notify: (message: string, level: string) => notifications.push([message, level]),
					} as unknown as ExtensionUIContext,
					true,
				);
				expect(statuses).toEqual([]);
				expect(notifications).toEqual([]);
				const stockPrompt = [...rebuildMismatch.session.systemPrompt];
				fs.writeFileSync(mismatchTriggerPath, "on\n");
				await rebuildMismatch.session.refreshBaseSystemPrompt();
				expect(rebuildMismatch.session.systemPrompt).toEqual(stockPrompt);
				expect(statuses).toContainEqual(["omp-prompt-policy", "Prompt policy: REVIEW REQUIRED"]);
				expect(notifications).toContainEqual([
					"PROMPT_POLICY_REVIEW_REQUIRED: provider-facing system prompt differs from the approved stock prompt",
					"warning",
				]);
			} finally {
				await rebuildMismatch.session.dispose();
			}
		} finally {
			auth.close();
		}
	});
});
