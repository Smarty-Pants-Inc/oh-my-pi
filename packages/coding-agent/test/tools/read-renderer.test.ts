import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { theme as activeTheme, getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool, readToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { TUI } from "@oh-my-pi/pi-tui";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";

function extractLinkUris(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/g)].map(match => match[1]!);
}

function extractLinkTexts(text: string): string[] {
	return [...text.matchAll(/\x1b\]8;[^;]*;[^\x1b]+\x1b\\([\s\S]*?)\x1b\]8;;\x1b\\/g)].map(match =>
		Bun.stripANSI(match[1]!),
	);
}

beforeAll(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	settings.clearOverride("tui.hyperlinks");
});

afterAll(() => {
	resetSettingsForTest();
});

describe("readToolRenderer hyperlinks", () => {
	it("links local-style read titles to the resolved filesystem path and selected line", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const handoffPath = path.resolve("/tmp/omp-local/handoff.md");
		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "second line" }],
				details: {
					resolvedPath: handoffPath,
					displayContent: { text: "second line", startLine: 2 },
					isDirectory: false,
					contentType: "text/plain",
				},
			},
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "local://handoff.md:2" },
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("local://handoff.md");
		expect(rendered).toContain(":2");
		const handoffUri = new URL(url.pathToFileURL(path.resolve(handoffPath)).href);
		handoffUri.searchParams.set("line", "2");
		expect(extractLinkUris(rendered)).toEqual([handoffUri.href]);
		expect(extractLinkTexts(rendered)).toContain("local://handoff.md");
		expect(extractLinkTexts(rendered)).not.toContain("local://handoff.md:2");
	});

	it("keeps literal-colon read titles fully clickable without a line query", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-renderer-literal-"));
		try {
			const literalName = "foo:100";
			const literalPath = path.join(tempDir, literalName);
			await Bun.write(literalPath, "literal content\n");
			const session: ToolSession = {
				cwd: tempDir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({ "read.summarize.enabled": false }),
			};
			const result = await new ReadTool(session).execute("read-renderer-literal", { path: literalName });

			expect(result.details).toMatchObject({
				isDirectory: false,
				literalPath: true,
				meta: { source: { type: "path", value: literalPath } },
			});
			const component = readToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme!, {
				path: literalName,
			});
			const rendered = component.render(200).join("\n");

			expect(extractLinkUris(rendered)).toEqual([url.pathToFileURL(literalPath).href]);
			expect(extractLinkUris(rendered).map(uri => new URL(uri).search)).toEqual([""]);
			expect(extractLinkTexts(rendered)).toEqual([literalName]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("links an actual skill protocol read after regular-file confirmation", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-renderer-skill-"));
		try {
			const skillDir = path.join(tempDir, "demo");
			const skillPath = path.join(skillDir, "SKILL.md");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(skillPath, "# Demo\n");
			const session: ToolSession = {
				cwd: tempDir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
				skills: [
					{
						name: "demo",
						description: "Demo skill",
						filePath: skillPath,
						baseDir: skillDir,
						source: "test",
					},
				],
			};
			const result = await new ReadTool(session).execute("read-skill-link", { path: "skill://demo" });

			expect(result.details?.isDirectory).toBe(false);
			const component = readToolRenderer.renderResult(result, { expanded: false, isPartial: false }, theme!, {
				path: "skill://demo",
			});
			expect(extractLinkUris(component.render(200).join("\n"))).toContain(url.pathToFileURL(skillPath).href);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps backing-file links while suppressing transformed source-line targets", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-renderer-backing-"));
		try {
			const plainPath = path.join(tempDir, "plain.txt");
			const archivePath = path.join(tempDir, "fixture.zip");
			const sqlitePath = path.join(tempDir, "fixture.sqlite");
			const binaryPath = path.join(tempDir, "fixture.bin");
			await fs.writeFile(plainPath, "first line\nsecond line\n");
			await writeArchive(archivePath, "zip", [["member.txt", "first member line\nsecond member line\n"]]);
			await Bun.write(binaryPath, new Uint8Array([0, 1, 2, 3]));
			const database = new Database(sqlitePath);
			try {
				database.run("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
				database.run("INSERT INTO records (value) VALUES ('first record')");
			} finally {
				database.close();
			}

			const session: ToolSession = {
				cwd: tempDir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({ "read.summarize.enabled": false }),
			};
			const readTool = new ReadTool(session);
			const plainResult = await readTool.execute("read-plain-link", { path: `${plainPath}:2` });
			const archiveResult = await readTool.execute("read-archive-link", { path: `${archivePath}:member.txt:2` });
			const sqliteResult = await readTool.execute("read-sqlite-link", { path: `${sqlitePath}:records:1` });
			const binaryResult = await readTool.execute("read-binary-link", { path: `${binaryPath}:7` });
			const archiveDirectoryResult = await readTool.execute("read-archive-directory", { path: archivePath });

			expect(plainResult.details?.isDirectory).toBe(false);
			expect(plainResult.details?.sourceLineAligned).toBeUndefined();
			expect(archiveResult.details).toMatchObject({
				resolvedPath: archivePath,
				isDirectory: false,
				sourceLineAligned: false,
			});
			expect(sqliteResult.details).toMatchObject({
				resolvedPath: sqlitePath,
				isDirectory: false,
				sourceLineAligned: false,
			});
			expect(binaryResult.details).toMatchObject({
				resolvedPath: binaryPath,
				isDirectory: false,
				sourceLineAligned: false,
			});
			expect(archiveDirectoryResult.details?.isDirectory).toBe(true);

			const plainRendered = readToolRenderer
				.renderResult(plainResult, { expanded: false, isPartial: false }, theme!, { path: `${plainPath}:2` })
				.render(200)
				.join("\n");
			const archiveRendered = readToolRenderer
				.renderResult(archiveResult, { expanded: false, isPartial: false }, theme!, {
					path: `${archivePath}:member.txt:2`,
				})
				.render(200)
				.join("\n");
			const sqliteRendered = readToolRenderer
				.renderResult(sqliteResult, { expanded: false, isPartial: false }, theme!, {
					path: `${sqlitePath}:records:1`,
				})
				.render(200)
				.join("\n");
			const binaryRendered = readToolRenderer
				.renderResult(binaryResult, { expanded: false, isPartial: false }, theme!, { path: `${binaryPath}:7` })
				.render(200)
				.join("\n");
			const archiveDirectoryRendered = readToolRenderer
				.renderResult(archiveDirectoryResult, { expanded: false, isPartial: false }, theme!, { path: archivePath })
				.render(200)
				.join("\n");

			const plainLineUri = new URL(url.pathToFileURL(plainPath).href);
			plainLineUri.searchParams.set("line", "2");
			expect(extractLinkUris(plainRendered)).toContain(plainLineUri.href);

			const archiveUri = url.pathToFileURL(archivePath).href;
			const archiveLineUri = new URL(archiveUri);
			archiveLineUri.searchParams.set("line", "2");
			expect(extractLinkUris(archiveRendered)).toContain(archiveUri);
			expect(extractLinkUris(archiveRendered)).not.toContain(archiveLineUri.href);

			const sqliteUri = url.pathToFileURL(sqlitePath).href;
			const sqliteLineUri = new URL(sqliteUri);
			sqliteLineUri.searchParams.set("line", "1");
			expect(extractLinkUris(sqliteRendered)).toContain(sqliteUri);
			expect(extractLinkUris(sqliteRendered)).not.toContain(sqliteLineUri.href);

			const binaryUri = url.pathToFileURL(binaryPath).href;
			const binaryLineUri = new URL(binaryUri);
			binaryLineUri.searchParams.set("line", "7");
			expect(extractLinkUris(binaryRendered)).toContain(binaryUri);
			expect(extractLinkUris(binaryRendered)).not.toContain(binaryLineUri.href);
			expect(extractLinkUris(archiveDirectoryRendered)).toEqual([]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("does not speculate file links for pending absolute read calls", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const examplePath = path.resolve("/tmp/omp-read/example.ts");
		const component = readToolRenderer.renderCall(
			{ path: `${examplePath}:10-12` },
			{ expanded: false, isPartial: false },
			theme!,
		);

		const rendered = component.render(200).join("\n");
		expect(Bun.stripANSI(rendered)).toContain(`${examplePath}:10-12`);
		expect(extractLinkUris(rendered)).toEqual([]);
	});

	it("does not link completed reads without confirmed file metadata", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "content" }],
				details: { resolvedPath: path.resolve("/tmp/omp-read/unconfirmed.ts") },
			},
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "unconfirmed.ts" },
		);

		expect(extractLinkUris(component.render(200).join("\n"))).toEqual([]);
	});

	it("links HTTP read result headers to the final URL", async () => {
		settings.override("tui.hyperlinks", "always");
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "---\n\nhello" }],
				details: {
					kind: "url",
					url: "http://example.com/start",
					finalUrl: "http://example.com/final",
					contentType: "text/plain",
					method: "fetch",
					truncated: false,
					notes: [],
				},
			} as never,
			{ expanded: false, isPartial: false },
			theme!,
			{ path: "http://example.com/start" },
		);

		const rendered = component.render(200).join("\n");
		expect(rendered).toContain("example.com /final");
		expect(extractLinkUris(rendered)).toContain("http://example.com/final");
	});
});

describe("readToolRenderer markdown content", () => {
	it("renders text/markdown details through the markdown renderer", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "[notes.md#ABCD]\n1:# Heading\n2:\n3:This is **bold** text." }],
				details: {
					displayContent: { text: "# Heading\n\nThis is **bold** text.", startLine: 1 },
					contentType: "text/markdown",
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
			{ path: "notes.md" },
		);

		const stripped = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(stripped).toContain("Heading");
		expect(stripped).toContain("This is bold text.");
		expect(stripped).not.toContain("# Heading");
		expect(stripped).not.toContain("**bold**");
	});

	it("keeps untagged markdown source in the code renderer", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "[notes.md#ABCD]\n1:# Heading\n2:\n3:This is **bold** text." }],
				details: {
					displayContent: { text: "# Heading\n\nThis is **bold** text.", startLine: 1 },
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
			{ path: "notes.md" },
		);

		const stripped = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(stripped).toContain("# Heading");
		expect(stripped).toContain("**bold**");
	});

	it("keeps raw markdown selector reads in the code renderer", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();

		const component = readToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "# Heading\n\nThis is **bold** text." }],
				details: {
					displayContent: { text: "# Heading\n\nThis is **bold** text.", startLine: 1 },
					contentType: "text/markdown",
				},
			},
			{ expanded: true, isPartial: false },
			theme!,
			{ path: "notes.md:raw" },
		);

		const stripped = component
			.render(100)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(stripped).toContain("# Heading");
		expect(stripped).toContain("**bold**");
	});
});

describe("read ToolExecutionComponent framing", () => {
	it("renders framed read results inside the standard tool container padding", () => {
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("read", { path: "src/example.ts" }, {}, undefined, uiStub);
		component.updateResult(
			{
				content: [{ type: "text", text: "export const x = 1;" }],
				details: {
					displayContent: { text: "export const x = 1;", startLine: 1 },
					contentType: "text/plain",
				},
			},
			false,
		);

		try {
			const lines = component.render(80).map(line => Bun.stripANSI(line));
			const topBorderIndex = lines.findIndex(
				line => line.includes(activeTheme.boxRound.topLeft) && line.includes("Read"),
			);
			const bottomBorderIndex = lines.findIndex(
				(line, index) => index > topBorderIndex && line.includes(activeTheme.boxRound.bottomLeft),
			);

			expect(topBorderIndex).toBeGreaterThanOrEqual(0);
			expect(lines[topBorderIndex + 1]).toContain("export const x = 1;");
			expect(bottomBorderIndex).toBeGreaterThan(topBorderIndex);
		} finally {
			component.stopAnimation();
		}
	});
});
