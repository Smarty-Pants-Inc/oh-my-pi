import { describe, expect, test } from "bun:test";
import { alignMachOStringTable } from "./bazel-natives";

describe("alignMachOStringTable", () => {
	test("pads an unaligned Mach-O string table and updates __LINKEDIT", () => {
		const input = Buffer.alloc(252, 0x5a);
		input.writeUInt32LE(0xfeedfacf, 0);
		input.writeUInt32LE(2, 16);
		input.writeUInt32LE(96, 20);
		input.writeUInt32LE(0x19, 32);
		input.writeUInt32LE(72, 36);
		input.fill(0, 40, 56);
		input.write("__LINKEDIT", 40, "ascii");
		input.writeBigUInt64LE(4096n, 64);
		input.writeBigUInt64LE(200n, 72);
		input.writeBigUInt64LE(52n, 80);
		input.writeUInt32LE(0x2, 104);
		input.writeUInt32LE(24, 108);
		input.writeUInt32LE(220, 120);
		input.writeUInt32LE(32, 124);

		const aligned = alignMachOStringTable(input);

		expect(aligned.length).toBe(256);
		expect(aligned.readUInt32LE(120)).toBe(224);
		expect(aligned.readBigUInt64LE(80)).toBe(56n);
		expect(aligned.subarray(220, 224)).toEqual(Buffer.alloc(4));
		expect(aligned.subarray(224)).toEqual(input.subarray(220));
		expect(alignMachOStringTable(aligned)).toBe(aligned);
	});
});
