import * as path from "node:path";
import { sha256 } from "./canonical";

/** Model-visible transforms whose bytes must be present in the protected content root. */
export const IMPLEMENTATION_SOURCE_GLOBS = [
	"packages/agent/src/agent-loop.ts",
	"packages/agent/src/agent.ts",
	"packages/agent/src/append-only-context.ts",
	"packages/agent/src/compaction/**/*.ts",
	"packages/agent/src/replay-policy.ts",
	"packages/ai/src/context-instructions.ts",
	"packages/ai/src/dialect/**/*.ts",
	"packages/ai/src/providers/**/*.ts",
	"packages/ai/src/stream.ts",
	"packages/ai/src/types.ts",
	"packages/ai/src/utils.ts",
	"packages/ai/src/utils/schema/**/*.ts",
	"packages/ai/src/utils/validation.ts",
	"packages/catalog/src/build.ts",
	"packages/catalog/src/compat/**/*.ts",
	"packages/catalog/src/hosts.ts",
	"packages/catalog/src/identity/**/*.ts",
	"packages/catalog/src/models.json",
	"packages/catalog/src/models.ts",
	"packages/coding-agent/src/config/inline-tool-descriptors-mode.ts",
	"packages/coding-agent/src/context/implementation-sources.ts",
	"packages/coding-agent/src/context/registry.ts",
	"packages/coding-agent/src/context/smarty-skills.ts",
	"packages/coding-agent/src/context/tool-contracts.ts",
	"packages/coding-agent/src/edit/index.ts",
	"packages/coding-agent/src/extensibility/tool-proxy.ts",
	"packages/coding-agent/src/goals/tools/**/*.ts",
	"packages/coding-agent/src/lsp/tool.ts",
	"packages/coding-agent/src/mcp/manager.ts",
	"packages/coding-agent/src/mcp/tool-bridge.ts",
	"packages/coding-agent/src/sdk.ts",
	"packages/coding-agent/src/secrets/message-transform.ts",
	"packages/coding-agent/src/session/agent-session.ts",
	"packages/coding-agent/src/session/messages.ts",
	"packages/coding-agent/src/session/session-advisors.ts",
	"packages/coding-agent/src/session/session-handoff.ts",
	"packages/coding-agent/src/session/session-provider-boundary.ts",
	"packages/coding-agent/src/session/snapcompact-inline.ts",
	"packages/coding-agent/src/session/session-tools.ts",
	"packages/coding-agent/src/system-prompt.ts",
	"packages/coding-agent/src/task/**/*.ts",
	"packages/coding-agent/src/tools/**/*.ts",
] as const;

export async function computeImplementationSources(
	repositoryRoot: string,
): Promise<Array<{ path: string; sha256: string }>> {
	const paths = new Set<string>();
	for (const pattern of IMPLEMENTATION_SOURCE_GLOBS) {
		for await (const absolutePath of new Bun.Glob(pattern).scan({
			cwd: repositoryRoot,
			absolute: true,
			onlyFiles: true,
		})) {
			paths.add(path.relative(repositoryRoot, absolutePath).replaceAll(path.sep, "/"));
		}
	}
	return await Promise.all(
		[...paths]
			.sort((left, right) => left.localeCompare(right))
			.map(async sourcePath => ({
				path: sourcePath,
				sha256: sha256(await Bun.file(path.join(repositoryRoot, sourcePath)).text()),
			})),
	);
}
