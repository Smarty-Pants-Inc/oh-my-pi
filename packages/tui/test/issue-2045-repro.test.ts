import { describe, expect, it } from "bun:test";
import {
	type Component,
	CURSOR_MARKER,
	createResponseZoneLine,
	Markdown,
	type TerminalFrameProvider,
	TUI,
} from "@oh-my-pi/pi-tui";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";
import { ImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
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
	resize(columns: number, rows: number): void {
		this.#columns = columns;
		this.#rows = rows;
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

	it("strips terminal controls decoded from Markdown numeric HTML entities", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		const encoded =
			"<span>&#27;[2A&#27;[H&#27;[2J&#27;]52;c;Y2xpcGJvYXJk&#7;&#27;Pqpayload&#27;&#92;&#155;2A</span>reply";
		tui.addChild(new Markdown(encoded, 0, 0, defaultMarkdownTheme));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).not.toContain("\x1b[2A");
		expect(rendered).not.toContain("\x1b[H");
		expect(rendered).not.toContain("\x1b[2J");
		expect(rendered).not.toContain("\x1b]52;");
		expect(rendered).not.toContain("\x1bPq");
		expect(rendered).not.toContain("\u009b");
		expect(Bun.stripANSI(rendered)).toContain("reply");
	});

	it("sanitizes image-like Markdown controls even when that protocol is active", async () => {
		const terminalInfo = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
		const originalProtocol = terminalInfo.imageProtocol;
		const cases = [
			[ImageProtocol.Kitty, "<span>&#27;_Ga=d,d=A,q=2&#27;&#92;</span>after", "\x1b_Ga=d"],
			[ImageProtocol.Sixel, "<span>&#27;Pqpayload&#27;&#92;</span>after", "\x1bPq"],
			[ImageProtocol.Iterm2, "<span>&#27;]1337;File=inline=1:AAAA&#7;</span>after", "\x1b]1337;File="],
		] as const;
		try {
			for (const [protocol, encoded, forbidden] of cases) {
				terminalInfo.imageProtocol = protocol;
				const term = new CaptureTerminal(80, 4);
				const tui = new TUI(term);
				tui.addChild(new Markdown(encoded, 0, 0, defaultMarkdownTheme));
				try {
					tui.start();
					await settle();
				} finally {
					tui.stop();
				}
				const rendered = term.writes.join("");
				expect(rendered).not.toContain(forbidden);
				expect(Bun.stripANSI(rendered)).toContain("after");
			}
		} finally {
			terminalInfo.imageProtocol = originalProtocol;
		}
	});

	it("strips terminal-equivalent OSC 133 with ignored command controls", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		tui.addChild(new RawLinesComponent(["before\x1b]\x0013\r3;A;aid=omp-response-evil:reply\x07after"]));
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).not.toContain("aid=omp-response-evil");
		expect(Bun.stripANSI(rendered)).toContain("beforeafter");
	});

	it("preserves response-zone authority while stripping cursor-like content", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		tui.addChild(
			new RawLinesComponent([
				createResponseZoneLine(`before${CURSOR_MARKER}after`, { responseAnchorId: "anchor", close: true }),
			]),
		);
		try {
			tui.start();
			await settle();
		} finally {
			tui.stop();
		}

		const rendered = term.writes.join("");
		expect(rendered).toContain(RESPONSE_ZONE_START);
		expect(rendered).toContain(RESPONSE_ZONE_CLOSE);
		expect(rendered).not.toContain(CURSOR_MARKER);
		expect(Bun.stripANSI(rendered)).toContain("beforeafter");
	});

	it("keeps a trusted reply anchor while dropping untrusted terminal side effects", async () => {
		const term = new CaptureTerminal(80, 4);
		const tui = new TUI(term);
		const styled = "\x1b[31mstyled\x1b[0m";
		const hyperlink = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		const hostile = "\x1b[2A\x1b[H\x1b[2J\x1b]52;c;Y2xpcGJvYXJk\x07\x1bPqpayload\x1b\\\u009b2A";
		tui.addChild(
			new RawLinesComponent([
				createResponseZoneLine(`before${styled}${hyperlink}${hostile}reply`, {
					responseAnchorId: "anchor",
					close: true,
				}),
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
		expect(rendered).toContain("\x1b[31mstyled\x1b[0m");
		expect(rendered).toContain(hyperlink);
		expect(rendered).not.toContain("\x1b[2A");
		expect(rendered).not.toContain("\x1b[H");
		expect(rendered).not.toContain("\x1b[2J");
		expect(rendered).not.toContain("\x1b]52;");
		expect(rendered).not.toContain("\x1bPq");
		expect(rendered).not.toContain("\u009b");
		expect(Bun.stripANSI(rendered)).toContain("beforestyledlinkreply");
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
	it("marks intentional history resets but leaves startup replay preservable", async () => {
		const term = new CaptureTerminal(20, 4);
		const tui = new TUI(term);
		tui.addChild(new RawLinesComponent(["reply"]));
		try {
			tui.start({ clearScrollback: true });
			await settle();
			const startup = term.writes.join("");
			expect(startup).toContain("\x1b[H\x1b[3J\x1b[2J");
			expect(startup).not.toContain("omp-response-history-reset");

			term.writes.length = 0;
			tui.requestRender(true, { clearScrollback: true });
			await settle();
			const reset = term.writes.join("");
			expect(reset).toContain("\x1b]133;P;omp-response-history-reset\x07\x1b[H\x1b[3J\x1b[2J");
		} finally {
			tui.stop();
		}
	});

	it("keeps resize rebuild clears preservable by Herdr", async () => {
		const term = new CaptureTerminal(20, 4);
		const provider: TerminalFrameProvider = {
			renderFrame: ({ columns }) => ({ viewport: [`reply@${columns}`] }),
			resetHistory: () => {},
			acknowledgeHistory: () => {},
		};
		const tui = new TUI(term);
		tui.setResizeScrollback("rebuild");
		tui.setFrameProvider(provider);
		try {
			tui.start();
			await settle();
			term.writes.length = 0;
			term.resize(30, 4);
			tui.renderNow();

			const resized = term.writes.join("");
			expect(resized).toContain("\x1b[H\x1b[3J\x1b[2J");
			expect(resized).not.toContain("omp-response-history-reset");
		} finally {
			tui.stop();
		}
	});
});
