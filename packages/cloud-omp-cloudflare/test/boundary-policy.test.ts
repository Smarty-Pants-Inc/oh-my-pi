import { describe, expect, test } from "bun:test";
import {
	classifySynchronizedRelativePath,
	compareUtf8,
	hasExactObjectKeys,
	MAX_COMMAND_BYTES,
	MAX_COMMAND_TIMEOUT_MS,
	MAX_EXEC_OUTPUT_BYTES,
	MAX_HTTP_BODY_BYTES,
	MAX_SYNC_FILE_BYTES,
	MAX_SYNC_FILE_COUNT,
	MAX_SYNC_TOTAL_BYTES,
} from "../src/boundary-policy";
import { assertSynchronizedPath } from "../src/client/manifest";
import {
	type CloudOmpWireErrorCode,
	isCloudOmpWireErrorCode,
	MAX_COMMAND_BYTES as protocolCommandBytes,
	MAX_COMMAND_TIMEOUT_MS as protocolCommandTimeoutMs,
	MAX_EXEC_OUTPUT_BYTES as protocolExecOutputBytes,
	MAX_HTTP_BODY_BYTES as protocolHttpBodyBytes,
	MAX_SYNC_FILE_BYTES as protocolSyncFileBytes,
	MAX_SYNC_FILE_COUNT as protocolSyncFileCount,
	MAX_SYNC_TOTAL_BYTES as protocolSyncTotalBytes,
} from "../src/protocol";
import { canonicalRelativePath } from "../src/worker/workspace-files";

describe("shared Cloud OMP boundary policy", () => {
	test("keeps client and Worker path decisions and UTF-8 ordering in lockstep", () => {
		for (const path of ["README.md", "src/é.ts", "nested/file.txt"]) {
			expect(classifySynchronizedRelativePath(path)).toEqual({ accepted: true, path });
			expect(() => assertSynchronizedPath(path)).not.toThrow();
			expect(canonicalRelativePath(path)).toBe(path);
		}

		for (const path of [
			"",
			"/absolute",
			"a/../escape",
			"a\\b",
			"e\u0301.txt",
			"bad\0name",
			"\ud800",
			".git/config",
			"private/.env.production",
			"keys/deploy.pem",
			".config/gcloud/credentials",
		]) {
			expect(classifySynchronizedRelativePath(path).accepted).toBeFalse();
			expect(() => assertSynchronizedPath(path)).toThrow();
			expect(() => canonicalRelativePath(path)).toThrow();
		}

		expect(["z.txt", "é.txt"].sort(compareUtf8)).toEqual(["z.txt", "é.txt"]);
	});

	test("uses one limit set across wire, client, and Worker consumers", () => {
		expect({
			commandBytes: protocolCommandBytes,
			commandTimeoutMs: protocolCommandTimeoutMs,
			execOutputBytes: protocolExecOutputBytes,
			httpBodyBytes: protocolHttpBodyBytes,
			syncFileBytes: protocolSyncFileBytes,
			syncFileCount: protocolSyncFileCount,
			syncTotalBytes: protocolSyncTotalBytes,
		}).toEqual({
			commandBytes: MAX_COMMAND_BYTES,
			commandTimeoutMs: MAX_COMMAND_TIMEOUT_MS,
			execOutputBytes: MAX_EXEC_OUTPUT_BYTES,
			httpBodyBytes: MAX_HTTP_BODY_BYTES,
			syncFileBytes: MAX_SYNC_FILE_BYTES,
			syncFileCount: MAX_SYNC_FILE_COUNT,
			syncTotalBytes: MAX_SYNC_TOTAL_BYTES,
		});
	});

	test("accepts only exact object key sets regardless of insertion order", () => {
		expect(hasExactObjectKeys({ second: true, first: true }, ["first", "second"])).toBeTrue();
		expect(hasExactObjectKeys({ first: true }, ["first", "second"])).toBeFalse();
		expect(hasExactObjectKeys({ first: true, second: true, extra: true }, ["first", "second"])).toBeFalse();
		expect(hasExactObjectKeys(["first", "second"], ["0", "1"])).toBeFalse();
		expect(hasExactObjectKeys(null, [])).toBeFalse();
	});

	test("keeps gateway error codes closed", () => {
		const knownCode: CloudOmpWireErrorCode = "denied_path";
		expect(isCloudOmpWireErrorCode(knownCode)).toBeTrue();
		expect(isCloudOmpWireErrorCode("deneid_path")).toBeFalse();
	});
});
