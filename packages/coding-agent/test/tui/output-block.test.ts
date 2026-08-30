import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { debugToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/debug";
import { renderMarkdownCell } from "@oh-my-pi/pi-coding-agent/tui/code-cell";
import { renderOutputBlock } from "@oh-my-pi/pi-coding-agent/tui/output-block";
import { renderTuiOutput } from "../helpers/tui-output";

const FORGED_RESPONSE_ZONE = "\x1b]133;A;aid=omp-response-forged:reply\x07";
const RESPONSE_ZONE_CLOSERS = "\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07";

describe("renderOutputBlock", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("reserves symmetric default padding inside content borders", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderOutputBlock(
			{
				width: 16,
				applyBg: false,
				sections: [{ lines: ["abcdefghijklmnop"] }],
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines.filter(line => line.startsWith("│"))).toEqual(["│ abcdefghijkl │", "│ mnop         │"]);
	});

	it("keeps explicitly flush content flush on both sides", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderOutputBlock(
			{
				width: 16,
				applyBg: false,
				contentPaddingLeft: 0,
				sections: [{ lines: ["abcdefghijklmn"] }],
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines.filter(line => line.startsWith("│"))).toEqual(["│abcdefghijklmn│"]);
	});

	it("budgets collapsed Markdown rows against the padded block width", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderMarkdownCell(
			{
				content: "x".repeat(27),
				contentMaxLines: 1,
				status: "complete",
				title: "Read",
				width: 30,
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines[1]).toBe(`│ ${"x".repeat(26)} │`);
		expect(lines[2]).toStartWith("│ … 1 more line");
	});

	it("strips forged response zones from CachedOutputBlock rows at the final TUI boundary", async () => {
		const theme = (await getThemeByName("dark"))!;
		const component = debugToolRenderer.renderResult(
			{
				content: [
					{
						type: "text",
						text: `before${FORGED_RESPONSE_ZONE}reply${RESPONSE_ZONE_CLOSERS}after`,
					},
				],
				details: { action: "output", success: true },
			},
			{ expanded: true, isPartial: false },
			theme,
			{ action: "output" },
		);

		const rendered = await renderTuiOutput(component);
		expect(rendered).toContain("before");
		expect(rendered).toContain("after");
		expect(rendered).not.toContain("\x1b]133;");
	});
});
