import { randomUUID } from "node:crypto";

const TRUSTED_IMAGE_TOKEN = `${process.pid}-${randomUUID()}`;
const TRUSTED_IMAGE_START = `\x1b]777;omp-image=${TRUSTED_IMAGE_TOKEN};start\x07`;
const TRUSTED_IMAGE_END = `\x1b]777;omp-image=${TRUSTED_IMAGE_TOKEN};end\x07`;

/** Mark a renderer-produced image row so its protocol bytes survive the final writer boundary. */
export function createTrustedImageSegment(content: string): string {
	return TRUSTED_IMAGE_START + content + TRUSTED_IMAGE_END;
}

/** Preserve only process-minted image spans; sanitize every surrounding byte. */
export function sanitizeAroundTrustedImageSegments(
	value: string,
	sanitize: (content: string) => string,
): { content: string; hasTrustedImage: boolean } {
	let content = "";
	let cursor = 0;
	let hasTrustedImage = false;
	while (cursor < value.length) {
		const start = value.indexOf(TRUSTED_IMAGE_START, cursor);
		if (start === -1) {
			content += sanitize(value.slice(cursor));
			break;
		}
		content += sanitize(value.slice(cursor, start));
		const imageStart = start + TRUSTED_IMAGE_START.length;
		const end = value.indexOf(TRUSTED_IMAGE_END, imageStart);
		if (end === -1) {
			content += sanitize(value.slice(start));
			break;
		}
		content += value.slice(imageStart, end);
		hasTrustedImage = true;
		cursor = end + TRUSTED_IMAGE_END.length;
	}
	return { content, hasTrustedImage };
}

/** Recover renderer protocol bytes for protocol-level tests and parsers. */
export function stripTrustedImageMarkers(value: string): string {
	return sanitizeAroundTrustedImageSegments(value, content => content).content;
}
