import { type Component, TUI } from "@oh-my-pi/pi-tui";
import type { Terminal, TerminalAppearance } from "@oh-my-pi/pi-tui/terminal";

class CaptureTerminal implements Terminal {
	readonly writes: string[] = [];

	constructor(
		readonly columns: number,
		readonly rows: number,
	) {}

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

/** Render a component through the final TUI writer and return its exact terminal bytes. */
export async function renderTuiOutput(component: Component, columns = 160, rows = 40): Promise<string> {
	const terminal = new CaptureTerminal(columns, rows);
	const tui = new TUI(terminal);
	tui.addChild(component);
	try {
		tui.start();
		await Bun.sleep(0);
	} finally {
		tui.stop();
	}
	return terminal.writes.join("");
}
