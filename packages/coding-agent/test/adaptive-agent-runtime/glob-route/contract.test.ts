import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { Settings } from "../../../src/config/settings";
import type { ToolSession } from "../../../src/tools";
import type { PersistentGlobRouteV1 } from "../../../src/tools/glob";
import { GlobTool } from "../../../src/tools/glob";
import { ToolError } from "../../../src/tools/tool-errors";

type ListRequest = { operationLeaseId: string; directory: string; pattern: string; cursor: string | null };
type ListResult = {
	entries: Array<{ path: string; kind: "file" | "directory" | "symlink"; byteLength: number }>;
	nextCursor: string | null;
};

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

function makeRoute(
	calls: { begins: number; ends: number; lists: number },
	listFiles: (request: ListRequest) => Promise<ListResult> = async request => {
		expect(request.operationLeaseId).toBe("glob-operation-lease");
		expect(request.directory).toBe("/workspace/src");
		expect(request.pattern).toBe("*");
		expect(request.cursor).toBeNull();
		return {
			entries: [{ path: "/workspace/src/example.ts", kind: "file", byteLength: 1 }],
			nextCursor: null,
		};
	},
	gitignoreContent?: string,
): PersistentGlobRouteV1 {
	const modelRoot = "/workspace";
	const parse = (input: string) => {
		const candidate = path.posix.isAbsolute(input) ? input : path.posix.resolve(modelRoot, input);
		if (candidate !== modelRoot && !candidate.startsWith(`${modelRoot}/`)) throw new Error("outside workspace");
		return {
			inputKind: path.posix.isAbsolute(input) ? "model_absolute" : "relative",
			modelPath: candidate,
			relativePath: candidate.slice(modelRoot.length).replace(/^\//, ""),
		};
	};

	return {
		paths: { modelRoot, parse, parseReturnedModelPath: parse } as PersistentGlobRouteV1["paths"],
		begin: async () => {
			calls.begins++;
			const operationLeaseId = "glob-operation-lease";
			return {
				operationLeaseId,
				binding: {
					lease: {
						leaseId: "runtime-lease",
						replica: { workspaceId: "workspace", replicaId: "replica" },
						baseGeneration: 7,
					},
					fence: { fenceId: "fence", token: "secret" },
					modelRoot,
					bridge: {
						exists: async (request: { path: string }) =>
							request.path.endsWith("/.gitignore") ? gitignoreContent !== undefined : true,
						readTextFile: async () => ({ content: gitignoreContent ?? "" }),
						stat: async () => ({ kind: "directory" }),
						listFiles: async (request: ListRequest) => {
							calls.lists++;
							return listFiles(request);
						},
					},
				},
				end: () => {
					calls.ends++;
				},
			} as never;
		},
	};
}

describe("persistent GlobTool route", () => {
	test("uses one enumeration lease and preserves glob output", async () => {
		const calls = { begins: 0, ends: 0, lists: 0 };
		const result = await new GlobTool(makeSession(), { persistentRoute: makeRoute(calls) }).execute("glob", {
			path: "src/**/*.ts",
		});

		expect(result.content).toEqual([{ type: "text", text: "# src/\nexample.ts" }]);
		expect(result.details?.files).toEqual(["src/example.ts"]);
		expect(calls).toEqual({ begins: 1, ends: 1, lists: 1 });
	});

	test("rejects an out-of-workspace path before admission", async () => {
		const calls = { begins: 0, ends: 0, lists: 0 };
		await expect(
			new GlobTool(makeSession(), { persistentRoute: makeRoute(calls) }).execute("glob", {
				path: "/outside/**/*.ts",
			}),
		).rejects.toBeInstanceOf(ToolError);
		expect(calls).toEqual({ begins: 0, ends: 0, lists: 0 });
	});

	test("admits canonical model-absolute paths", async () => {
		const calls = { begins: 0, ends: 0, lists: 0 };
		const result = await new GlobTool(makeSession(), { persistentRoute: makeRoute(calls) }).execute("glob", {
			path: "/workspace/src/**/*.ts",
			gitignore: false,
		});
		expect(result.details?.files).toEqual(["src/example.ts"]);
		expect(calls).toEqual({ begins: 1, ends: 1, lists: 1 });
	});

	test.each([" src/**/*.ts", "src/**/*.ts ", '"src/**/*.ts"', "src\\**\\*.ts"])(
		"rejects noncanonical raw path spelling %s before admission",
		async path => {
			const calls = { begins: 0, ends: 0, lists: 0 };
			await expect(
				new GlobTool(makeSession(), { persistentRoute: makeRoute(calls) }).execute("glob", { path }),
			).rejects.toBeInstanceOf(ToolError);
			expect(calls).toEqual({ begins: 0, ends: 0, lists: 0 });
		},
	);

	test("pages, orders, and preserves directory results", async () => {
		const calls = { begins: 0, ends: 0, lists: 0 };
		const result = await new GlobTool(makeSession(), {
			persistentRoute: makeRoute(calls, async request => {
				if (request.directory === "/workspace/src/z-dir") return { entries: [], nextCursor: null };
				if (request.cursor === null) {
					return {
						entries: [
							{ path: "/workspace/src/z-dir", kind: "directory", byteLength: 0 },
							{ path: "/workspace/src/b.ts", kind: "file", byteLength: 1 },
						],
						nextCursor: "second",
					};
				}
				expect(request.cursor).toBe("second");
				return { entries: [{ path: "/workspace/src/a.ts", kind: "file", byteLength: 1 }], nextCursor: null };
			}),
		}).execute("glob", { path: "src/**/*.ts", gitignore: false });

		expect(result.content).toEqual([{ type: "text", text: "# src/\na.ts\nb.ts\n## z-dir/" }]);
		expect(result.details?.files).toEqual(["src/a.ts", "src/b.ts", "src/z-dir/"]);
		expect(calls).toEqual({ begins: 1, ends: 1, lists: 3 });
	});

	test("applies hidden, gitignore, and fixed-ignore policies before projection", async () => {
		const calls = { begins: 0, ends: 0, lists: 0 };
		const result = await new GlobTool(makeSession(), {
			persistentRoute: makeRoute(
				calls,
				async () => ({
					entries: [
						{ path: "/workspace/src/.hidden.ts", kind: "file", byteLength: 1 },
						{ path: "/workspace/src/node_modules/blocked.ts", kind: "file", byteLength: 1 },
						{ path: "/workspace/src/ignored.ts", kind: "file", byteLength: 1 },
						{ path: "/workspace/src/kept.ts", kind: "file", byteLength: 1 },
					],
					nextCursor: null,
				}),
				"ignored.ts",
			),
		}).execute("glob", { path: "src/**/*.ts", hidden: false });

		expect(result.details?.files).toEqual(["src/kept.ts"]);
		expect(calls).toEqual({ begins: 1, ends: 1, lists: 1 });
	});
	test("holds the operation lease until an aborted enumeration settles", async () => {
		const calls = { begins: 0, ends: 0, lists: 0 };
		let releasePage!: (result: ListResult) => void;
		let markStarted!: () => void;
		const started = new Promise<void>(resolve => {
			markStarted = resolve;
		});
		const page = new Promise<ListResult>(resolve => {
			releasePage = resolve;
		});
		const controller = new AbortController();
		const execution = new GlobTool(makeSession(), {
			persistentRoute: makeRoute(calls, async () => {
				markStarted();
				return page;
			}),
		}).execute("glob", { path: "src/**/*.ts", gitignore: false }, controller.signal);

		await started;
		controller.abort();
		await Promise.resolve();
		expect(calls.ends).toBe(0);
		releasePage({ entries: [], nextCursor: null });
		await execution.catch(() => undefined);
		expect(calls).toEqual({ begins: 1, ends: 1, lists: 1 });
	});
});
