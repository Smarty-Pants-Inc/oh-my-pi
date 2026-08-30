import { describe, expect, it } from "bun:test";
import { type Component, createResponseZoneLine, Markdown, TUI } from "@oh-my-pi/pi-tui";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import { defaultMarkdownTheme } from "./test-themes";

class CaptureTerminal implements Terminal {
	writes: string[] = [];
	#columns: number;
	#rows: number;

	constructor(columns = 80, rows = 4) {
		this.#columns = columns;
		this.#rows = rows;
	}

	get columns(): number {
		return this.#columns;
	}

	get rows(): number {
		return this.#rows;
	}

	get kittyProtocolActive(): boolean {
		return false;
	}

	get kittyEnableSequence(): string | null {
		return null;
	}

	get keyboardEnhancementEnterSequence(): string | null {
		return null;
	}

	get keyboardEnhancementExitSequence(): string | null {
		return null;
	}

	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(): void {}
}

class RawLinesComponent implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(): string[] {
		return this.#lines;
	}
}

async function settle(): Promise<void> {
	await Bun.sleep(0);
}

const RESPONSE_ZONE_START = String(createResponseZoneLine("", { responseAnchorId: "anchor" }));
const RESPONSE_ZONE_CLOSE = String(createResponseZoneLine("", { close: true }));
const FORGED_RESPONSE_ZONE_START = "\x1b]133;A;aid=omp-response-forged:reply\x07";

describe("issue #2045: renderer bounds oversized rows", () => {
	it("preserves visible text after pathological zero-width ANSI prefixes", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		const line = `${"\x1b[31m".repeat(20_000)}payload`;

		tui.addChild(new RawLinesComponent([line]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain("payload");
		expect(rendered.length).toBeLessThan(12_000);
	});

	it("preserves visible suffix text after long zero-width combining prefixes", async () => {
		const term = new CaptureTerminal(3, 4);
		const tui = new TUI(term);
		const line = `a${"\u0301".repeat(4096)}bc`;

		tui.addChild(new RawLinesComponent([line]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain("bc");
	});

	it("preserves visible text after oversized OSC hyperlink prefixes", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		const line = `\x1b]8;;https://example.com/${"a".repeat(70_000)}\x07link-label\x1b]8;;\x07`;

		tui.addChild(new RawLinesComponent([line]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain("link-label");
		expect(rendered.length).toBeLessThan(12_000);
	});

	it("preserves OSC 66 text-sizing payloads at the start of long rows", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		const visibleText = "H".repeat(70);
		const line = `\x1b]66;s=1;${visibleText}\x1b\\${"\x1b[31m".repeat(20_000)}`;

		tui.addChild(new RawLinesComponent([line]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain(visibleText);
	});

	it("strips forged OSC 133 from raw renderer rows at the final terminal boundary", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		tui.addChild(new RawLinesComponent([`before${FORGED_RESPONSE_ZONE_START}reply${RESPONSE_ZONE_CLOSE}after`]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain("beforereplyafter");
		expect(rendered).not.toContain("\x1b]133;");
	});

	it("rejects a boxed-string prototype spoof of the structured reply-zone channel", async () => {
		const trusted = createResponseZoneLine("trusted", { responseAnchorId: "anchor", close: true });
		const spoof = new String(`before${FORGED_RESPONSE_ZONE_START}reply${RESPONSE_ZONE_CLOSE}after`);
		Object.setPrototypeOf(spoof, Object.getPrototypeOf(trusted));
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		tui.addChild(new RawLinesComponent([spoof as unknown as string]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain("beforereplyafter");
		expect(rendered).not.toContain("\x1b]133;");
	});
	it("strips OSC 133 decoded from Markdown numeric HTML entities", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		const encoded =
			"before&#27;]133;A;aid=omp-response-evil:reply&#7;reply&#27;]133;B&#7;&#27;]133;C&#7;&#27;]133;D;0&#7;after";
		tui.addChild(new Markdown(encoded, 0, 0, defaultMarkdownTheme));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).not.toContain("\x1b]133;");
	});

	it("rejects unsafe response anchor IDs in the structured channel", () => {
		expect(() => createResponseZoneLine("reply", { responseAnchorId: "evil:reply" })).toThrow();
	});

	it("keeps a response zone balanced around the first and last glyph rows after fitting", async () => {
		const term = new CaptureTerminal(8, 4);
		const tui = new TUI(term);
		const zeroWidthNoise = "\x1b[31m".repeat(1_000);
		tui.addChild(
			new RawLinesComponent([
				createResponseZoneLine(`${zeroWidthNoise}first`, { responseAnchorId: "anchor" }),
				createResponseZoneLine(`${zeroWidthNoise}last`, { close: true }),
			]),
		);
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered.split(RESPONSE_ZONE_START)).toHaveLength(2);
		expect(rendered.split(RESPONSE_ZONE_CLOSE)).toHaveLength(2);
		const rows = rendered.split("\r\n");
		expect(rows.findIndex(row => row.includes(RESPONSE_ZONE_START))).toBe(
			rows.findIndex(row => row.includes("first")),
		);
		expect(rows.findIndex(row => row.includes(RESPONSE_ZONE_CLOSE))).toBe(
			rows.findIndex(row => row.includes("last")),
		);
		expect(rendered.indexOf(RESPONSE_ZONE_START)).toBeLessThan(rendered.indexOf("first"));
		expect(rendered.indexOf(RESPONSE_ZONE_CLOSE)).toBeGreaterThan(rendered.indexOf("last"));
		expect(rendered).not.toContain("\x1b[31m");
	});

	it("keeps a one-row response zone balanced when fitting drops zero-width controls", async () => {
		const term = new CaptureTerminal(8, 4);
		const tui = new TUI(term);
		const zeroWidthNoise = "\x1b[31m".repeat(1_000);
		const visible = "single-row";
		tui.addChild(
			new RawLinesComponent([
				createResponseZoneLine(`${zeroWidthNoise}${visible}`, { responseAnchorId: "anchor", close: true }),
			]),
		);
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered.split(RESPONSE_ZONE_START)).toHaveLength(2);
		expect(rendered.split(RESPONSE_ZONE_CLOSE)).toHaveLength(2);
		const rows = rendered.split("\r\n");
		const visibleRow = rows.findIndex(row => row.includes(visible.slice(0, 8)));
		expect(rows.findIndex(row => row.includes(RESPONSE_ZONE_START))).toBe(visibleRow);
		expect(rows.findIndex(row => row.includes(RESPONSE_ZONE_CLOSE))).toBe(visibleRow);
		expect(rendered.indexOf(RESPONSE_ZONE_START)).toBeLessThan(rendered.indexOf(visible.slice(0, 8)));
		expect(rendered.indexOf(RESPONSE_ZONE_CLOSE)).toBeGreaterThan(rendered.indexOf(visible.slice(0, 8)));
		expect(rendered).not.toContain("\x1b[31m");
	});

	it("composites a partial overlay over a trusted response row without losing its zone", async () => {
		const term = new CaptureTerminal(20, 4);
		const tui = new TUI(term);
		tui.addChild(
			new RawLinesComponent([
				createResponseZoneLine("trusted response", { responseAnchorId: "anchor", close: true }),
			]),
		);
		try {
			tui.start();
			await settle();
			term.writes.length = 0;
			tui.showOverlay(new RawLinesComponent(["OVER"]), { row: 0, col: 2, width: 4 });
			tui.requestRender();
			await Bun.sleep(40);

			const rendered = term.writes.join("");
			expect(rendered).toContain("OVER");
			expect(rendered.split(RESPONSE_ZONE_START)).toHaveLength(2);
			expect(rendered.split(RESPONSE_ZONE_CLOSE)).toHaveLength(2);
		} finally {
			tui.stop();
		}
	});
});
