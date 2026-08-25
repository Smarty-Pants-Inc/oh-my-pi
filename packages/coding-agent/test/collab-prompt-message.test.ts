import { beforeAll, describe, expect, it } from "bun:test";
import type { CollabPromptDetails } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabPromptMessageComponent } from "@oh-my-pi/pi-coding-agent/modes/components/collab-prompt-message";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

beforeAll(async () => {
	await initTheme(false);
});

describe("collab prompt message", () => {
	it("embeds the styled sender in the message row", () => {
		const message: CustomMessage<CollabPromptDetails> = {
			role: "custom",
			customType: "collab-prompt",
			content: "Hi there.",
			display: true,
			details: { from: "Paul", displayNameRevision: 1 },
			timestamp: Date.now(),
		};
		const raw = new CollabPromptMessageComponent(message).render(80).join("\n");
		const lines = Bun.stripANSI(raw).split("\n");
		const messageLines = lines.filter(line => line.includes("Paul · sent") || line.includes("Hi there."));

		expect(raw).toContain(theme.fg("accent", theme.bold("Paul")));
		expect(messageLines).toEqual([expect.stringContaining("Paul · sent Hi there.")]);
		expect(messageLines[0]?.match(/Paul · sent/g)).toHaveLength(1);
	});

	it("does not expose a legacy sender prefix in the body", () => {
		const message: CustomMessage<CollabPromptDetails> = {
			role: "custom",
			customType: "collab-prompt",
			content: "[Paul] says: Hi there.",
			display: true,
			details: { from: "Paul", displayNameRevision: 1 },
			timestamp: Date.now(),
		};
		const rendered = Bun.stripANSI(new CollabPromptMessageComponent(message).render(80).join("\n"));

		expect(rendered).toContain("Paul · sent Hi there.");
		expect(rendered).not.toContain("[Paul] says:");
	});

	it("keeps the body intact when the sender consumes first-row width", () => {
		const body = "x".repeat(100);
		const message: CustomMessage<CollabPromptDetails> = {
			role: "custom",
			customType: "collab-prompt",
			content: body,
			display: true,
			details: { from: "Paul", displayNameRevision: 1 },
			timestamp: Date.now(),
		};
		const rendered = Bun.stripANSI(new CollabPromptMessageComponent(message).render(20).join(""));

		expect(rendered.match(/x/g)?.length).toBe(body.length);
	});

	it("clips long sender attribution to the message width", () => {
		const message: CustomMessage<CollabPromptDetails> = {
			role: "custom",
			customType: "collab-prompt",
			content: "hello",
			display: true,
			details: { from: "sender".repeat(20), displayNameRevision: 1 },
			timestamp: Date.now(),
		};
		const rendered = Bun.stripANSI(new CollabPromptMessageComponent(message).render(20).join("\n"));

		expect(rendered.split("\n").every(line => line.length <= 20)).toBe(true);
	});

	it("keeps sender attribution and an image marker for an image-only prompt", () => {
		const message: CustomMessage<CollabPromptDetails> = {
			role: "custom",
			customType: "collab-prompt",
			content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
			display: true,
			details: { from: "Paul", displayNameRevision: 1 },
			timestamp: Date.now(),
		};
		const rendered = Bun.stripANSI(new CollabPromptMessageComponent(message).render(80).join("\n"));

		expect(rendered).toContain("Paul · sent [Image #1]");
		expect(rendered.match(/Paul · sent/g)).toHaveLength(1);
	});

	it("does not duplicate image markers already present in the text", () => {
		const message: CustomMessage<CollabPromptDetails> = {
			role: "custom",
			customType: "collab-prompt",
			content: [
				{ type: "text", text: "See this [Image #1]" },
				{ type: "image", data: "AA==", mimeType: "image/png" },
			],
			display: true,
			details: { from: "Paul", displayNameRevision: 1 },
			timestamp: Date.now(),
		};
		const rendered = Bun.stripANSI(new CollabPromptMessageComponent(message).render(80).join("\n"));

		expect(rendered.match(/\[Image #1\]/g)).toHaveLength(1);
	});

	it("keeps public sender names literal and on the message row", () => {
		const message: CustomMessage<CollabPromptDetails> = {
			role: "custom",
			customType: "collab-prompt",
			content: "# Heading",
			display: true,
			details: { from: "\u202e[Eve](https://bad.example)\nInjected", displayNameRevision: 1 },
			timestamp: Date.now(),
		};
		const rendered = Bun.stripANSI(new CollabPromptMessageComponent(message).render(80).join("\n"));
		const messageLines = rendered.split("\n").filter(line => line.includes("Eve") || line.includes("Heading"));

		expect(rendered).toContain("[Eve](https://bad.example) Injected · sent Heading");
		expect(rendered).not.toContain("\u202e");
		expect(messageLines).toHaveLength(1);
	});
});
