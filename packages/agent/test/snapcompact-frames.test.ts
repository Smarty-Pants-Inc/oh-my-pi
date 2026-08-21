import { describe, expect, it } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";
import {
	collectCompactionContextInstructions,
	createCompactionSummaryMessage,
	defaultConvertToLlm,
} from "../src/compaction/messages";
import { Tokenizer } from "../src/tokenizer";

const tokenizer = new Tokenizer();

describe("compaction summary message with snapcompact frames", () => {
	const images: ImageContent[] = [
		{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
		{ type: "image", data: "ZmFrZTI=", mimeType: "image/png" },
	];

	it("countMessage charges per attached frame", () => {
		const bare = createCompactionSummaryMessage("summary text", 1000, new Date().toISOString());
		const withFrames = createCompactionSummaryMessage("summary text", 1000, new Date().toISOString(), { images });
		expect(tokenizer.countMessage(withFrames) - tokenizer.countMessage(bare)).toBe(
			2 * snapcompact.FRAME_TOKEN_ESTIMATE,
		);
	});

	it("keeps summary text in internal_context and frames in a data-only carrier", () => {
		const message = createCompactionSummaryMessage("the snapcompact archive", 1000, new Date().toISOString(), {
			images,
		});
		const [converted] = defaultConvertToLlm([message]);
		expect(converted.role).toBe("developer");
		const content = converted.content as Array<{ type: string; text?: string; data?: string }>;
		expect(content).toEqual(images);
		expect(content.some(block => block.type === "text")).toBe(false);

		const [instruction] = collectCompactionContextInstructions([message], "main");
		expect(instruction.role).toBe("internal_context");
		expect(instruction.renderedText).toContain("the snapcompact archive");
	});
});
