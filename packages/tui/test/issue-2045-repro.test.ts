import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";

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

const RESPONSE_ZONE_START = "\x1b]133;A;aid=omp-response-123-01234567-89ab-cdef-0123-456789abcdef:anchor\x07";
const RESPONSE_ZONE_CLOSE = "\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07";

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

	it("keeps a response zone balanced around the first and last glyph rows after fitting", async () => {
		const term = new CaptureTerminal(8, 4);
		const tui = new TUI(term);
		const zeroWidthNoise = "\x1b[31m".repeat(1_000);
		tui.addChild(
			new RawLinesComponent([
				`${RESPONSE_ZONE_START}${zeroWidthNoise}first`,
				`${zeroWidthNoise}last${RESPONSE_ZONE_CLOSE}`,
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
		tui.addChild(new RawLinesComponent([`${RESPONSE_ZONE_START}${zeroWidthNoise}${visible}${RESPONSE_ZONE_CLOSE}`]));
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
});
