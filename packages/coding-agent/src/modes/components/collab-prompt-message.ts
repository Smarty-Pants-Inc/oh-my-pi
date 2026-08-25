import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import {
	applyBackgroundToLine,
	type Component,
	Markdown,
	sliceWithWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { CollabPromptDetails } from "../../collab/protocol";
import type { CustomMessage } from "../../session/messages";
import { renderPlaceholders } from "../image-references";
import { getMarkdownTheme, theme } from "../theme/theme";

function displaySenderName(value: string | undefined): string {
	const sanitized = sanitizeText(value ?? "")
		.replace(/[\r\n\t\u2028\u2029]+/g, " ")
		.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, " ")
		.trim();
	return sanitized || "guest";
}

function appendMissingImageMarkers(text: string, images: readonly ImageContent[]): string {
	if (images.length === 0) return text;
	const markerCount = [...text.matchAll(/\[Image #[1-9]\d*(?:,[^\]\n]*)?\]/g)].length;
	const missingCount = images.length - markerCount;
	if (missingCount <= 0) return text;
	const markers = Array.from({ length: missingCount }, (_, index) => `[Image #${markerCount + index + 1}]`).join(" ");
	return text ? `${text}\n\n${markers}` : markers;
}

/**
 * Renders a collab guest prompt inline with its sender attribution. The
 * transport keeps the body plain for model delivery; this is presentation only.
 */
export class CollabPromptMessageComponent implements Component {
	readonly #body: Markdown;
	readonly #sender: string;

	constructor(message: CustomMessage<CollabPromptDetails>) {
		const from = displaySenderName(message.details?.from);
		const blocks = typeof message.content === "string" ? undefined : message.content;
		let rawText: string;
		if (typeof message.content === "string") {
			rawText = message.content;
		} else {
			rawText = message.content
				.filter((content): content is TextContent => content.type === "text")
				.map(content => content.text)
				.join("");
		}
		const images = blocks?.filter((content): content is ImageContent => content.type === "image") ?? [];
		const legacyPrefix = `[${from}] says:`;
		const textWithoutLegacyPrefix = rawText.startsWith(legacyPrefix)
			? rawText.slice(legacyPrefix.length).replace(/^\s+/, "")
			: rawText;
		const text = appendMissingImageMarkers(textWithoutLegacyPrefix, images);
		const imageLabel = (value: string) => theme.fg("accent", `\x1b[1m\x1b[4m${value}\x1b[24m\x1b[22m`);
		this.#sender = `${theme.fg("accent", theme.bold(from))}${theme.fg("dim", " · sent")} `;
		this.#body = new Markdown(text, 1, 1, getMarkdownTheme(), {
			bgColor: (value: string) => theme.bg("userMessageBg", value),
			color: (value: string) =>
				renderPlaceholders(value, {
					renderText: textValue => theme.fg("userMessageText", textValue),
					renderReference: (label, kind) =>
						kind === "image" ? imageLabel(label) : theme.fg("accent", theme.bold(label)),
				}),
		});
		this.#body.setIgnoreTight(true);
	}

	render(width: number): readonly string[] {
		const lines = this.#body.render(width);
		const firstContentIndex = lines.findIndex(line => Bun.stripANSI(line).trim().length > 0);
		if (firstContentIndex < 0) {
			const sender = sliceWithWidth(` ${this.#sender}`, 0, Math.max(1, width), true).text;
			return [applyBackgroundToLine(sender, width, value => theme.bg("userMessageBg", value))];
		}
		const line = lines[firstContentIndex]!;
		const plain = Bun.stripANSI(line);
		const leadingWidth = visibleWidth(plain.slice(0, plain.length - plain.trimStart().length));
		const contentWidth = Math.max(0, visibleWidth(plain.trimEnd()) - leadingWidth);
		const availableWidth = Math.max(1, width);
		const prefixWidth = Math.min(leadingWidth, availableWidth - 1);
		const prefix = sliceWithWidth(line, 0, prefixWidth, true).text;
		const sender = sliceWithWidth(this.#sender, 0, availableWidth - visibleWidth(prefix) - 1, true).text;
		const bodyWidth = Math.max(1, availableWidth - visibleWidth(prefix) - visibleWidth(sender));
		const body = sliceWithWidth(line, leadingWidth, contentWidth, true).text;
		const bodyLines = wrapTextWithAnsi(body, bodyWidth);
		const composed = [...lines];
		composed[firstContentIndex] = `${prefix}${sender}${bodyLines[0] ?? ""}`;
		if (bodyLines.length > 1) {
			const continuationLines = bodyLines
				.slice(1)
				.map(bodyLine =>
					applyBackgroundToLine(`${prefix}${bodyLine}`, width, value => theme.bg("userMessageBg", value)),
				);
			composed.splice(firstContentIndex + 1, 0, ...continuationLines);
		}
		return composed;
	}

	invalidate(): void {
		this.#body.invalidate();
	}
}
