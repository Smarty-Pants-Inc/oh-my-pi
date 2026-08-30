import { createResponseZoneLine, Markdown, visibleWidth } from "@oh-my-pi/pi-tui";

// Reply markers are carried as structured TUI rows. The final writer strips
// every textual OSC 133 sequence, then restores only these process-branded edges.
export class ResponseAnchorMarkdown extends Markdown {
	#responseAnchorId: string;
	#enabled = false;
	#zoneSource: readonly string[] | undefined;
	#zoneLines: string[] | undefined;

	constructor(responseAnchorId: string, ...args: ConstructorParameters<typeof Markdown>) {
		super(...args);
		this.#responseAnchorId = responseAnchorId;
	}

	setEnabled(enabled: boolean): void {
		if (this.#enabled === enabled) return;
		this.#enabled = enabled;
		this.#zoneSource = undefined;
		this.#zoneLines = undefined;
	}

	setResponseAnchorId(responseAnchorId: string): void {
		if (this.#responseAnchorId === responseAnchorId) return;
		this.#responseAnchorId = responseAnchorId;
		this.#zoneSource = undefined;
		this.#zoneLines = undefined;
	}

	hasVisibleGlyphCells(width: number): boolean {
		return this.#visibleGlyphLineIndex(super.render(width)) !== undefined;
	}

	#visibleGlyphLineIndex(lines: readonly string[]): number | undefined {
		for (let index = 0; index < lines.length; index++) {
			if (visibleWidth(lines[index]!.trim()) > 0) return index;
		}
		return undefined;
	}

	override invalidate(): void {
		super.invalidate();
		this.#zoneSource = undefined;
		this.#zoneLines = undefined;
	}

	override render(width: number): readonly string[] {
		const lines = super.render(width);
		if (!this.#enabled || lines.length === 0) return lines;
		if (this.#zoneSource === lines && this.#zoneLines !== undefined) return this.#zoneLines;
		const firstVisible = this.#visibleGlyphLineIndex(lines);
		if (firstVisible === undefined) return lines;
		const wrapped = lines.slice();
		// Differential paints can rewrite one row without its neighbors. Keep the
		// authorized prompt marker self-contained on the anchor row so every write
		// leaves terminal OSC 133 state balanced.
		wrapped[firstVisible] = createResponseZoneLine(String(wrapped[firstVisible]), {
			responseAnchorId: this.#responseAnchorId,
			close: true,
		});
		this.#zoneSource = lines;
		this.#zoneLines = wrapped;
		return wrapped;
	}
}
