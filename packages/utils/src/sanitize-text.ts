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

const OSC_133_PREFIX = "\x1b]133";
const C1_OSC_133_PREFIX = "\x9d133";
const C1_ST_CHAR = "\x9c";
const OSC_133_PREFIXES = [OSC_133_PREFIX, C1_OSC_133_PREFIX] as const;

function trailingOsc133Prefix(text: string): string | undefined {
	for (const prefix of OSC_133_PREFIXES) {
		for (let length = prefix.length - 1; length > 0; length--) {
			if (text.endsWith(prefix.slice(0, length))) return prefix.slice(0, length);
		}
	}
	return undefined;
}

function findOsc133Start(
	text: string,
	from: number,
): { start: number; payloadStart: number; prefix: string } | undefined {
	for (;;) {
		const escStart = text.indexOf(ESC_CHAR, from);
		const c1Start = text.indexOf("\x9d", from);
		const start = escStart === -1 ? c1Start : c1Start === -1 ? escStart : Math.min(escStart, c1Start);
		if (start === -1) return undefined;

		const prefix = text.startsWith(OSC_133_PREFIX, start)
			? OSC_133_PREFIX
			: text.startsWith(C1_OSC_133_PREFIX, start)
				? C1_OSC_133_PREFIX
				: undefined;
		if (prefix) {
			const payloadStart = start + prefix.length;
			const next = text.charCodeAt(payloadStart);
			// OSC 1337 is a distinct sequence; every non-digit terminates the
			// numeric command, including an incomplete OSC 133 at end-of-input.
			if (Number.isNaN(next) || next < 0x30 || next > 0x39) return { start, payloadStart, prefix };
		}
		from = start + 1;
	}
}

function osc133End(text: string, from: number): { index: number; complete: boolean } {
	for (let index = from; index < text.length; index++) {
		const char = text[index]!;
		if (char === "\x07" || char === C1_ST_CHAR) return { index: index + 1, complete: true };
		if (char === ESC_CHAR && text[index + 1] === "\\") return { index: index + 2, complete: true };
	}
	return { index: text.length, complete: false };
}

/**
 * Strip one appended text delta. `pending` carries only an OSC 133 introducer
 * (and a possible ST-leading ESC), never the unbounded discarded payload.
 */
export function stripOsc133Append(text: string, pending: string = ""): { text: string; pending: string } {
	const source = pending + text;
	let sequence = findOsc133Start(source, 0);
	if (!sequence) {
		const partial = trailingOsc133Prefix(source);
		return partial ? { text: source.slice(0, -partial.length), pending: partial } : { text: source, pending: "" };
	}

	const output = [source.slice(0, sequence.start)];
	for (;;) {
		const end = osc133End(source, sequence.payloadStart);
		if (!end.complete) {
			return {
				text: output.join(""),
				pending: sequence.prefix + (source.endsWith(ESC_CHAR) ? ESC_CHAR : ""),
			};
		}
		sequence = findOsc133Start(source, end.index);
		if (!sequence) {
			const suffix = source.slice(end.index);
			const partial = trailingOsc133Prefix(suffix);
			if (partial) output.push(suffix.slice(0, -partial.length));
			else output.push(suffix);
			return { text: output.join(""), pending: partial ?? "" };
		}
		output.push(source.slice(end.index, sequence.start));
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
