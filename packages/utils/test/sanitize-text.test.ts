import { describe, expect, it } from "bun:test";
import { sanitizeText, stripOsc133Append, stripOsc133Sequences } from "@oh-my-pi/pi-utils/sanitize-text";

describe("sanitizeText", () => {
	it("strips ANSI CSI and removes C0/C1 control chars while keeping tab + LF", () => {
		const input = "\x1b[31mred\x1b[0m\ra\u0000b\tline\ncarriage\r\u0001\u0085";
		expect(sanitizeText(input)).toBe("redab\tline\ncarriage");
	});

	it("drops lone surrogates and preserves valid surrogate pairs", () => {
		expect(sanitizeText(`a\ud800b\udc00c`)).toBe("abc");
		const validPair = "a\u{1f600}b";
		expect(sanitizeText(validPair)).toBe(validPair);
	});

	it("drops replacement characters on malformed input", () => {
		expect(sanitizeText("a\ud800�b")).toBe("ab");
	});

	it("preserves replacement characters on well-formed input", () => {
		expect(sanitizeText("a�b")).toBe("a�b");
	});

	it("preserves valid surrogate pairs while stripping controls", () => {
		const validPair = "\u{1f600}";
		expect(sanitizeText(`a${validPair}\u0000b`)).toBe(`a${validPair}b`);
	});

	it("strips OSC sequences terminated by BEL", () => {
		expect(sanitizeText("\x1b]0;title\x07hello")).toBe("hello");
	});

	it("strips OSC sequences terminated by ST (ESC \\)", () => {
		expect(sanitizeText("\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\!")).toBe("link!");
	});

	it("removes OSC 133 while preserving SGR and OSC 8 controls", () => {
		const styled = "\x1b[31mred\x1b[0m";
		const hyperlink = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		expect(stripOsc133Sequences(`before${styled}\x1b]133;A;aid=forged\x07${hyperlink}after`)).toBe(
			`before${styled}${hyperlink}after`,
		);
		expect(stripOsc133Sequences("before\x1b]133;A;aid=unterminated")).toBe("before");
		expect(stripOsc133Sequences("before\x9d133;D;0\x9cafter")).toBe("beforeafter");
	});

	it("removes OSC 133 when terminals ignore controls inside its command", () => {
		expect(stripOsc133Sequences("before\x1b\x00]\x0113\r3;A;aid=forged\x07after")).toBe("beforeafter");
		expect(stripOsc133Sequences("before\x9d1\x003\x7f\x013;A;aid=forged\x9cafter")).toBe("beforeafter");
	});

	it("removes OSC 133 when ESC-state controls precede its introducer", () => {
		expect(stripOsc133Sequences("before\x1b\x07]\x00133;A;aid=forged\x07after")).toBe("beforeafter");
		expect(stripOsc133Sequences("before\x1b\x7f]133;A;aid=forged\x07after")).toBe("beforeafter");
	});

	it("resumes after CAN, SUB, and non-ST ESC cancel OSC 133", () => {
		const styled = "\x1b[31mred\x1b[0m";
		expect(stripOsc133Sequences("before\x1b]133;A;aid=forged\x18after")).toBe("beforeafter");
		expect(stripOsc133Sequences("before\x1b]133;A;aid=forged\x1aafter")).toBe("beforeafter");
		expect(stripOsc133Sequences(`before\x1b]133;A;aid=forged${styled}after`)).toBe(`before${styled}after`);
		expect(stripOsc133Sequences("before\x1b]133;A;old\x1b]133;A;new\x07after")).toBe("beforeafter");
	});

	it("resumes after a split non-ST ESC cancellation", () => {
		const first = stripOsc133Append("before\x1b]133;A;aid=forged\x1b");
		expect(first).toEqual({ text: "before", pending: "\x1b]133;\x1b" });
		expect(stripOsc133Append("[31mred\x1b[0m", first.pending)).toEqual({
			text: "\x1b[31mred\x1b[0m",
			pending: "",
		});
	});

	it("does not synthesize an OSC 133 marker across a removed sequence", () => {
		const crafted = "\x1b\x1b]133;X\x07]133;A;aid=omp-response-forged:reply\x07";
		expect(stripOsc133Sequences(crafted)).toBe("]133;A;aid=omp-response-forged:reply\x07");
	});

	it("withholds trailing strict OSC 133 prefixes while preserving SGR and OSC 8", () => {
		const styled = "\x1b[31mred\x1b[0m";
		const hyperlink = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		for (const partial of ["\x1b", "\x1b]", "\x1b]1", "\x1b]13", "\x9d", "\x9d1", "\x9d13"]) {
			expect(stripOsc133Sequences(`before${styled}${hyperlink}after${partial}`)).toBe(
				`before${styled}${hyperlink}after`,
			);
		}
	});

	it("strips a split OSC 133 incrementally while preserving SGR and OSC 8", () => {
		const styled = "\x1b[31mred\x1b[0m";
		const hyperlink = "\x1b]8;;https://example.com\x07link\x1b]8;;\x07";
		let pending = "";
		let output = "";
		for (const chunk of [`before${styled}\x1b]13`, "3;A;aid=forged\x1b", `\\${hyperlink}after`]) {
			const stripped = stripOsc133Append(chunk, pending);
			output += stripped.text;
			pending = stripped.pending;
		}

		expect(output).toBe(`before${styled}${hyperlink}after`);
		expect(pending).toBe("");
	});

	it("strips a split OSC 133 with ignored controls in its command", () => {
		let pending = "";
		let output = "";
		for (const chunk of ["before\x1b\x00]1", "\x013", "\r3;A;aid=forged\x07after"]) {
			const stripped = stripOsc133Append(chunk, pending);
			output += stripped.text;
			pending = stripped.pending;
		}

		expect(output).toBe("beforeafter");
		expect(pending).toBe("");
	});

	it("retains the first terminal-significant discriminator across split OSC 133 updates", () => {
		for (const { prefix, discriminator, terminator } of [
			{ prefix: "\x1b]133", discriminator: ";", terminator: "\x07" },
			{ prefix: "\x9d133", discriminator: "\x80", terminator: "\x9c" },
		]) {
			const first = stripOsc133Append(`before${prefix}${discriminator}`);
			expect(first).toEqual({ text: "before", pending: prefix + discriminator });

			const second = stripOsc133Append(`7;payload${terminator}after`, first.pending);
			expect(second).toEqual({ text: "after", pending: "" });
		}
	});

	it("does not turn an ignored control into the OSC command discriminator", () => {
		const first = stripOsc133Append("before\x1b]133\x01");
		expect(first).toEqual({ text: "before", pending: "\x1b]133" });
		expect(stripOsc133Append("7;payload\x07after", first.pending)).toEqual({
			text: "\x1b]1337;payload\x07after",
			pending: "",
		});
	});

	it("retains only bounded OSC 133 framing for an incomplete large payload", () => {
		const stripped = stripOsc133Append(`before\x1b]133;A;aid=${"x".repeat(10_000)}`);
		expect(stripped).toEqual({ text: "before", pending: "\x1b]133;" });
		expect(stripped.pending.length).toBeLessThanOrEqual(7);
	});

	it("returns the original string instance when no changes are needed", () => {
		const clean = "plain ascii\twith\ttabs\nand newlines";
		expect(sanitizeText(clean)).toBe(clean);
	});

	it("strips DCS sequences terminated by ST", () => {
		expect(sanitizeText("before\x1bPpayload\x1b\\after")).toBe("beforeafter");
	});

	it("handles single-byte ESC finals (e.g. ESC c reset)", () => {
		expect(sanitizeText("a\x1bcb")).toBe("ab");
	});

	it("strips DEL and normalizes lone CR", () => {
		expect(sanitizeText("a\x7fb\rc")).toBe("abc");
	});
});
