/**
 * Strip ANSI escape sequences, remove control characters / lone surrogates,
 * and normalize line endings.
 *
 * Bun-native implementation of the former native `sanitizeText` (see
 * `crates/pi-natives/src/text.rs::sanitize_text`). JavaScript strings are
 * already UTF-16 code-unit arrays. `toWellFormed()` handles the uncommon
 * malformed path; when it changes the input, replacement characters are
 * dropped and the normalized result goes through the well-formed sanitizer.
 *
 * Fast path: well-formed input with no controls or ANSI returns the original
 * string after the control probe.
 */

const ESC_CHAR = "\x1b";

const C1_OSC_CHAR = "\x9d";
const C1_ST_CHAR = "\x9c";

function isOscIgnoredControl(code: number): boolean {
	return (
		(code >= 0x00 && code <= 0x06) ||
		(code >= 0x08 && code <= 0x17) ||
		code === 0x19 ||
		(code >= 0x1c && code <= 0x1f) ||
		code === 0x7f
	);
}

function isEscapeIgnoredControl(code: number): boolean {
	return (code >= 0x00 && code <= 0x17) || code === 0x19 || (code >= 0x1c && code <= 0x1f) || code === 0x7f;
}
function osc133CandidateAt(text: string, start: number): { prefix: string; payloadStart?: number } | undefined {
	let index = start;
	let prefix = "";
	if (text.charCodeAt(index) === 0x1b) {
		prefix = ESC_CHAR;
		index++;
		while (index < text.length && isEscapeIgnoredControl(text.charCodeAt(index))) index++;
		if (index === text.length) return { prefix };
		if (text[index] !== "]") return undefined;
		prefix += "]";
		index++;
	} else if (text.charCodeAt(index) === 0x9d) {
		prefix = C1_OSC_CHAR;
		index++;
	} else {
		return undefined;
	}

	for (const digit of "133") {
		while (index < text.length && isOscIgnoredControl(text.charCodeAt(index))) index++;
		if (index === text.length) return { prefix };
		if (text[index] !== digit) return undefined;
		prefix += digit;
		index++;
	}
	while (index < text.length && isOscIgnoredControl(text.charCodeAt(index))) index++;
	const next = text.charCodeAt(index);
	if (!Number.isNaN(next) && next >= 0x30 && next <= 0x39) return undefined;
	return { prefix, payloadStart: index };
}

function trailingOsc133Prefix(text: string): { start: number; prefix: string } | undefined {
	let partial: { start: number; prefix: string } | undefined;
	for (let start = 0; start < text.length; start++) {
		const first = text.charCodeAt(start);
		if (first !== 0x1b && first !== 0x9d) continue;
		const candidate = osc133CandidateAt(text, start);
		if (candidate && candidate.payloadStart === undefined) partial = { start, prefix: candidate.prefix };
	}
	return partial;
}

function findOsc133Start(
	text: string,
	from: number,
): { start: number; payloadStart: number; prefix: string } | undefined {
	for (let start = from; start < text.length; start++) {
		const first = text.charCodeAt(start);
		if (first !== 0x1b && first !== 0x9d) continue;
		const candidate = osc133CandidateAt(text, start);
		if (candidate?.payloadStart !== undefined)
			return { start, payloadStart: candidate.payloadStart, prefix: candidate.prefix };
	}
	return undefined;
}

function osc133End(text: string, from: number): { index: number; complete: boolean } {
	for (let index = from; index < text.length; index++) {
		const char = text[index]!;
		if (char === "\x07" || char === C1_ST_CHAR) return { index: index + 1, complete: true };
		if (char === "\x18" || char === "\x1a") return { index: index + 1, complete: true };
		if (char !== ESC_CHAR) continue;
		if (index + 1 === text.length) return { index: text.length, complete: false };
		if (text[index + 1] === "\\") return { index: index + 2, complete: true };
		// ESC followed by anything other than ST cancels the OSC and begins a
		// fresh escape sequence. Resume scanning at that ESC so its suffix remains.
		return { index, complete: true };
	}
	return { index: text.length, complete: false };
}

function appendBeforeStrippedSequence(output: string[], segment: string): void {
	const partial = trailingOsc133Prefix(segment);
	output.push(partial ? segment.slice(0, partial.start) : segment);
}

/**
 * Strip one appended text delta. `pending` carries only an OSC 133 introducer,
 * its first non-digit discriminator, and a possible ST-leading ESC — never the
 * unbounded discarded payload.
 */
export function stripOsc133Append(text: string, pending: string = ""): { text: string; pending: string } {
	const source = pending + text;
	let sequence = findOsc133Start(source, 0);
	if (!sequence) {
		const partial = trailingOsc133Prefix(source);
		return partial
			? { text: source.slice(0, partial.start), pending: partial.prefix }
			: { text: source, pending: "" };
	}

	const output: string[] = [];
	appendBeforeStrippedSequence(output, source.slice(0, sequence.start));
	for (;;) {
		const end = osc133End(source, sequence.payloadStart);
		if (!end.complete) {
			const discriminator = source[sequence.payloadStart] ?? "";
			const trailingEsc = source.endsWith(ESC_CHAR) && discriminator !== ESC_CHAR ? ESC_CHAR : "";
			return {
				text: output.join(""),
				pending: sequence.prefix + discriminator + trailingEsc,
			};
		}
		sequence = findOsc133Start(source, end.index);
		if (!sequence) {
			const suffix = source.slice(end.index);
			const partial = trailingOsc133Prefix(suffix);
			if (partial) output.push(suffix.slice(0, partial.start));
			else output.push(suffix);
			return { text: output.join(""), pending: partial?.prefix ?? "" };
		}
		appendBeforeStrippedSequence(output, source.slice(end.index, sequence.start));
	}
}

/**
 * Remove OSC 133 shell-integration controls from untrusted terminal text while
 * preserving ordinary SGR styling and OSC 8 hyperlinks. Incomplete controls
 * consume the trailing input so a streamed prefix cannot alter terminal state.
 */
export function stripOsc133Sequences(text: string): string {
	return stripOsc133Append(text).text;
}

// Well-formed strings only need control/ANSI detection: C0 (excl. \t \n),
// CR, DEL, and C1. ESC (0x1B) is in \x0B-\x1F.
const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

const REPLACEMENT_CHAR = "\ufffd";

export function sanitizeText(text: string): string {
	const wellFormed = text.toWellFormed();
	if (wellFormed !== text) {
		return sanitizeWellFormedText(wellFormed.replaceAll(REPLACEMENT_CHAR, ""));
	}
	return sanitizeWellFormedText(text);
}

function sanitizeWellFormedText(text: string): string {
	CONTROL_RE.lastIndex = 0;
	if (CONTROL_RE.exec(text) === null) return text;

	const stripped = text.indexOf(ESC_CHAR) === -1 ? text : Bun.stripANSI(text);
	CONTROL_RE.lastIndex = 0;
	return stripped.replace(CONTROL_RE, "");
}

/**
 * Escape the three XML-significant characters (`&`, `<`, `>`) in text destined
 * for an XML/markup element body. Allocation-conscious: returns the input
 * unchanged (same reference) when nothing needs escaping. Quotes are left as-is
 * — use it for element text, not attribute values.
 */
export function escapeXmlText(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else output += char;
	}
	return output;
}

/**
 * Escape XML-significant characters for an attribute VALUE: the three body
 * characters (`&`, `<`, `>`) plus the double quote (`"` → `&quot;`) that would
 * otherwise close the attribute. Allocation-conscious: returns the input
 * unchanged (same reference) when nothing needs escaping. Use it for attribute
 * values; {@link escapeXmlText} is for element bodies and leaves `"` intact.
 */
export function escapeXmlAttribute(input: string): string {
	let firstEscapable = -1;
	for (let index = 0; index < input.length; index++) {
		const char = input.charCodeAt(index);
		if (char === 38 || char === 60 || char === 62 || char === 34) {
			firstEscapable = index;
			break;
		}
	}
	if (firstEscapable === -1) return input;

	let output = input.slice(0, firstEscapable);
	for (let index = firstEscapable; index < input.length; index++) {
		const char = input[index];
		if (char === "&") output += "&amp;";
		else if (char === "<") output += "&lt;";
		else if (char === ">") output += "&gt;";
		else if (char === '"') output += "&quot;";
		else output += char;
	}
	return output;
}
