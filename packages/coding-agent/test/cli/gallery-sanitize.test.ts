import { afterEach, describe, expect, it, vi } from "bun:test";
import { runGalleryCommand } from "@oh-my-pi/pi-coding-agent/cli/gallery-cli";
import { galleryFixtures } from "@oh-my-pi/pi-coding-agent/cli/gallery-fixtures";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const originalWebSearchFixture = galleryFixtures.web_search;

describe("runGalleryCommand terminal output sanitization", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		(galleryFixtures as Record<string, unknown>).web_search = originalWebSearchFixture;
		resetSettingsForTest();
	});

	it("strips OSC 133 sequences forged via Markdown numeric entities in a tool answer", async () => {
		// The web_search renderer pipes the provider answer through Markdown, which
		// decodes `&#27;` into a live ESC after render; the gallery's stdout boundary
		// must strip the resulting shell-integration sequence in both output modes.
		(galleryFixtures as Record<string, unknown>).web_search = {
			...originalWebSearchFixture,
			result: {
				content: [{ type: "text", text: "&#27;]133;A;aid=forged&#7; forged marker" }],
				details: {
					response: {
						provider: "perplexity",
						answer: "&#27;]133;A;aid=forged&#7; forged marker",
						sources: [],
					},
				},
			},
		};
		resetSettingsForTest();
		await Settings.init({ inMemory: true });

		let stdout = "";
		vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});

		await runGalleryCommand({ tool: "web_search", states: ["success"], width: 100 });
		expect(stdout).not.toContain("\x1b]133;");
		expect(stdout).toContain("forged marker");

		stdout = "";
		await runGalleryCommand({ tool: "web_search", states: ["success"], width: 100, plain: true });
		expect(stdout).not.toContain("\x1b]133;");
		expect(stdout).toContain("forged marker");
	});
});
