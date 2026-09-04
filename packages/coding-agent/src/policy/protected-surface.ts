/**
 * Stable, dependency-free classification for changes that need explicit review
 * during an upstream merge. Callers pass the paths and, when available, the
 * parsed manifests from their own diff reader.
 */
import { compareUnicodeCodePoints } from "../context/canonical";

export const PROTECTED_SURFACE_DELTA_SCHEMA = "smarty.protected_delta.v1" as const;

export type ProtectedSurface =
	| "instruction"
	| "configuration"
	| "skill"
	| "guard"
	| "prompt-entry"
	| "prompt-content"
	| "prompt-visibility"
	| "prompt-role"
	| "prompt-target"
	| "prompt-trigger"
	| "prompt-order"
	| "prompt-default"
	| "provider-mapping"
	| "provider-wrapper"
	| "tool-description"
	| "tool-schema"
	| "behavior"
	| "automatic-turn"
	| "goal"
	| "todo"
	| "task"
	| "subagent"
	| "approval"
	| "capability";

export type ProtectedChangeKind = "added" | "changed" | "removed";

export interface ProtectedSurfaceChange {
	path: string;
	surface: ProtectedSurface;
	kind: ProtectedChangeKind;
}

export interface ProtectedSurfaceInput {
	/** A repository-relative path, when this is a file-backed change. */
	path?: string;
	/** Immutable Git comparison result for the path. Defaults to changed. */
	kind?: ProtectedChangeKind;
	/** Parsed manifest before the change. */
	before?: unknown;
	/** Parsed manifest after the change. */
	after?: unknown;
}

export interface ProtectedSurfaceClassification {
	protectedDelta: boolean;
	classifications: readonly ProtectedSurfaceChange[];
}

type ManifestScope = "none" | "prompt" | "provider" | "tool";

interface PathRule {
	pattern: RegExp;
	surface: ProtectedSurface;
}

const UNPROTECTED_IMPLEMENTATION_PATHS = new Set([
	"packages/ai/src/utils/schema/CONSTRAINTS.md",
	"packages/ai/src/providers/google-types.ts",
	"packages/ai/src/dialect/types.ts",
	"packages/hashline/src/types.ts",
	"packages/omptype/src/infer.ts",
	"packages/mnemopi/src/core/beam/types.ts",
	"packages/mnemopi/src/diagnose.ts",
	"packages/coding-agent/src/capability/types.ts",
	"packages/coding-agent/src/cleanse/types.ts",
	"packages/coding-agent/src/commit/agentic/state.ts",
	"packages/coding-agent/src/config/keybindings.ts",
	"packages/coding-agent/src/dap/types.ts",
	"packages/coding-agent/src/eval/types.ts",
	"packages/coding-agent/src/extensibility/custom-tools/types.ts",
	"packages/coding-agent/src/internal-urls/types.ts",
	"packages/coding-agent/src/markit/types.ts",
	"packages/coding-agent/src/plan-mode/state.ts",
	"packages/coding-agent/src/modes/magic-keywords.ts",
	"packages/coding-agent/src/modes/components/todo-reminder.ts",
	"packages/coding-agent/src/modes/rpc/rpc-frame.ts",
	"packages/coding-agent/src/modes/rpc/rpc-messages.ts",
	"packages/coding-agent/src/modes/rpc/rpc-subagents.ts",
	"packages/coding-agent/src/session/session-title-slot.ts",
	"packages/coding-agent/src/session/snapcompact-savings-journal.ts",
	"packages/coding-agent/src/stt/asr-protocol.ts",
	"packages/coding-agent/src/eval/js/worker-protocol.ts",
	"packages/coding-agent/src/eval/js/shared/types.ts",
	"packages/coding-agent/src/mnemopi/embed-protocol.ts",
	"packages/coding-agent/src/tiny/title-protocol.ts",
	"packages/coding-agent/src/tools/browser/tab-protocol.ts",
	"packages/coding-agent/src/tts/tts-protocol.ts",
	"packages/coding-agent/src/mcp/render.ts",
	"packages/coding-agent/src/lsp/render.ts",
	"packages/coding-agent/src/task/render.ts",
	"packages/coding-agent/src/task/renderer.ts",
	"packages/coding-agent/src/web/search/render.ts",
	"packages/coding-agent/src/tools/browser/render.ts",
	"packages/coding-agent/src/tools/browser/relay/protocol.ts",
	"packages/coding-agent/src/tools/computer-renderer.ts",
	"packages/coding-agent/src/tools/default-renderer.ts",
	"packages/coding-agent/src/tools/eval-render.ts",
	"packages/coding-agent/src/tools/gh-renderer.ts",
	"packages/coding-agent/src/tools/gh-types.ts",
	"packages/coding-agent/src/tools/inspect-image-renderer.ts",
	"packages/coding-agent/src/tools/json-tree.ts",
	"packages/coding-agent/src/tools/memory-render.ts",
	"packages/coding-agent/src/tools/read-renderer.ts",
	"packages/coding-agent/src/tools/renderers.ts",
	"packages/coding-agent/src/tools/eval-format/index.ts",
	"packages/coding-agent/src/tools/eval-format/javascript.ts",
	"packages/coding-agent/src/tools/eval-format/julia.ts",
	"packages/coding-agent/src/tools/eval-format/python.ts",
	"packages/coding-agent/src/tools/eval-format/ruby.ts",
	"packages/coding-agent/src/utils/changelog.ts",
	"packages/coding-agent/src/utils/open.ts",
	"packages/utils/src/stderr-guard.ts",
	"packages/utils/src/process-name.ts",
]);

// Keep file rules narrow. Semantic manifests cover broad configuration while
// ordinary implementation changes outside these seams remain unblocked.
const PATH_RULES: readonly PathRule[] = [
	{ pattern: /(?:^|\/)AGENTS\.md$/i, surface: "instruction" },
	{ pattern: /(?:^|\/)SMARTY_PANTS\.md$/i, surface: "instruction" },
	{ pattern: /(?:^|\/)skills?(?:\/|$)/i, surface: "skill" },
	{ pattern: /(?:^|\/)(?:agent-behavior|prompt-registry)\.ya?ml$/i, surface: "configuration" },
	{ pattern: /(?:^|\/)(?:config|settings)\.(?:ya?ml|json|toml)$/i, surface: "configuration" },
	{ pattern: /(?:^|\/)agent-behavior\.ya?ml$/i, surface: "behavior" },
	{ pattern: /(?:^|\/)prompt-registry\.ya?ml$/i, surface: "prompt-entry" },
	{ pattern: /(?:^|\/)src\/config\/(?:settings|settings-schema)\.[cm]?[jt]s$/i, surface: "configuration" },
	{
		pattern:
			/(?:^|\/)src\/(?:commands\/context|context\/(?:approved-policy|canonical|diff|explain|implementation-sources|internal-session|manifest)|policy\/protected-surface|utils\/git)\.[cm]?[jt]s$/i,
		surface: "guard",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/(?:package\.json|scripts\/generate-prompt-manifest\.ts)$/i,
		surface: "guard",
	},
	{ pattern: /(?:^|\/)generated\/prompt-manifest\.json$/i, surface: "prompt-entry" },
	{ pattern: /(?:^|\/)generated\/tool-contracts\.json$/i, surface: "tool-schema" },
	{ pattern: /(?:^|\/)crates\/pi-edit\/prompts\/.*\.md$/i, surface: "prompt-content" },
	{
		pattern: /(?:^|\/)crates\/pi-edit\/(?:grammars\/.*\.lark|src\/.*\.rs)$/i,
		surface: "tool-schema",
	},
	{ pattern: /(?:^|\/)crates\/pi-natives\/src\/edit\.rs$/i, surface: "tool-schema" },
	{ pattern: /(?:^|\/)packages\/(?:omptype|wire)\/src\//i, surface: "tool-schema" },
	{
		pattern:
			/(?:^|\/)crates\/(?:pi-natives\/src\/(?:ast|block|crash_handler|diff|glob|glob_util|grep|html|iofs|lib|pdf|ps|pty|shell|snapcompact|summary|task|tokens|utils|vectors)|pi-ast\/src\/(?:block|lib|ops|summary)|pi-shell\/(?:build|src\/.*)|pi-walker\/src\/(?:cache|lib))\.rs$/i,
		surface: "tool-schema",
	},
	{
		pattern: /(?:^|\/)crates\/pi-natives\/src\/(?:crash_handler|utils)\.rs$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)crates\/pi-shell\/src\/minimizer\/defs\/[^/]+\.toml$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)crates\/(?:pi-natives\/src\/(?:audio|clipboard|devicecheck|iso|live|workspace)|pi-natives\/src\/desktop\/.*|pi-iso\/src\/.*|pi-voice\/src\/.*)\.rs$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)crates\/(?:pi-natives\/src\/(?:ps|pty|shell)|pi-shell\/(?:build|src\/.*))\.rs$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)crates\/(?:pi-natives\/src\/(?:audio|clipboard|devicecheck|iso|live)|pi-natives\/src\/desktop\/.*|pi-iso\/src\/.*|pi-voice\/src\/.*)\.rs$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)crates\/(?:pi-natives\/src\/iso|pi-iso\/src\/.*)\.rs$/i,
		surface: "task",
	},
	{
		pattern: /(?:^|\/)crates\/pi-natives\/src\/fonts\/(?:5x8\.bdf|6x12\.bdf|8x13\.bdf|Silver\.ttf|unscii-8\.hex)$/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)packages\/natives\/native\/(?:index|clipboard|desktop)\.js$/i, surface: "tool-schema" },
	{ pattern: /(?:^|\/)packages\/natives\/native\/(?:clipboard|desktop)\.js$/i, surface: "capability" },
	{ pattern: /(?:^|\/)packages\/natives\/native\/(?:clipboard|desktop)\.js$/i, surface: "provider-wrapper" },
	{ pattern: /(?:^|\/)packages\/snapcompact\/src\/.*\.md$/i, surface: "prompt-content" },
	{ pattern: /(?:^|\/)packages\/snapcompact\/src\/.*\.[cm]?[jt]s$/i, surface: "provider-wrapper" },
	{ pattern: /(?:^|\/)docs\/.*\.md$/i, surface: "provider-wrapper" },
	{ pattern: /(?:^|\/)packages\/agent\/src\/index\.[cm]?[jt]s$/i, surface: "provider-wrapper" },
	{
		pattern: /(?:^|\/)packages\/utils\/src\/(?:frontmatter|index|prompt|template)\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{
		pattern: /(?:^|\/)packages\/utils\/(?:package\.json|src\/dirs\.[cm]?[jt]s)$/i,
		surface: "configuration",
	},
	{
		pattern:
			/(?:^|\/)packages\/utils\/src\/(?:abortable|binary|dirs|fetch-retry|format|index|json|json-parse|mime|path-tree|peek-file|runtime-install|sanitize-text|stream|tls-fetch|type-guards)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/utils\/src\/runtime-install\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/utils\/src\/tls-fetch\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern:
			/(?:^|\/)packages\/utils\/src\/(?:acp|async|browsers|docx|dom|env|file-lock|fs-error|headers|lru|path|postmortem|procmgr|readability|snowflake|turndown|vterm|which|worker-host|xml|acp\/.*|docx\/.*|dom\/.*|readability\/(?:readability|readerable)|turndown\/(?:gfm|html|service)|vterm\/.*)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/utils\/src\/(?:acp|browsers|docx|dom|procmgr|readability|snowflake|turndown|vterm|which|worker-host|xml|acp\/.*|docx\/.*|dom\/.*|readability\/(?:readability|readerable)|turndown\/(?:gfm|html|service)|vterm\/.*)\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/utils\/src\/(?:acp|async|browsers|env|path|procmgr|which|worker-host|acp\/.*)\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/utils\/src\/(?:env|file-lock)\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern: /(?:^|\/)packages\/utils\/src\/headers\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)packages\/utils\/src\/cli\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{
		pattern: /(?:^|\/)packages\/utils\/src\/cli\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/utils\/src\/(?:binary|mime)\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{ pattern: /(?:^|\/)packages\/ai\/src\/(?:dialect|providers)\/.*\.md$/i, surface: "prompt-content" },
	{ pattern: /(?:^|\/)packages\/ai\/src\/(?:dialect|providers)\/.*\.md$/i, surface: "provider-wrapper" },
	{ pattern: /(?:^|\/)packages\/ai\/src\/(?:utils\/schema|dialect)(?:\/|$)/i, surface: "tool-schema" },
	{ pattern: /(?:^|\/)packages\/agent\/src\/compaction\/prompts\//i, surface: "prompt-content" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/discovery\/builtin-rules\/[^/]+\.md$/i,
		surface: "prompt-content",
	},
	{
		pattern: /(?:^|\/)packages\/agent\/src\/(?:agent-loop|compaction|compaction\/.*)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/agent\/src\/(?:agent|append-only-context|proxy|replay-policy|telemetry|thinking|tokenizer|types)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)packages\/agent\/src\/types\.[cm]?[jt]s$/i, surface: "capability" },
	{
		pattern:
			/(?:^|\/)packages\/catalog\/src\/(?:build|cline-pass-model-id|effort|fireworks-model-id|hosts|model-cache|model-manager|model-thinking|model-tokenizer|models|openai-pricing|utils|variant-collapse)\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{ pattern: /(?:^|\/)packages\/catalog\/src\/index\.[cm]?[jt]s$/i, surface: "provider-mapping" },
	{
		pattern: /(?:^|\/)packages\/catalog\/src\/(?:compat|discovery|identity|provider-models|wire)\//i,
		surface: "provider-mapping",
	},
	{
		pattern:
			/(?:^|\/)packages\/catalog\/src\/(?:discovery\/(?:(?:cursor-gen|devin-gen)\/|(?:cursor-proto|devin-proto|protobuf)\.[cm]?[jt]s$)|wire\/)/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)packages\/catalog\/src\/models\.json$/i, surface: "provider-mapping" },
	{
		pattern: /(?:^|\/)packages\/mnemopi\/(?:package\.json|src\/config\.[cm]?[jt]s)$/i,
		surface: "configuration",
	},
	{
		pattern:
			/(?:^|\/)packages\/mnemopi\/(?:package\.json|src\/(?:config|db|index)\.[cm]?[jt]s|src\/(?:core|util)\/.*\.[cm]?[jt]s)$/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)src\/context\/(?:registry|prompt-sources\.generated)\.[cm]?[jt]s$/i, surface: "prompt-entry" },
	{ pattern: /(?:^|\/)src\/context\/tool-contracts\.[cm]?[jt]s$/i, surface: "tool-schema" },
	{ pattern: /(?:^|\/)src\/context\/smarty-skills\.[cm]?[jt]s$/i, surface: "provider-wrapper" },
	{
		pattern: /(?:^|\/)packages\/ai\/src\/(?:context-instructions|types|index)\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{ pattern: /(?:^|\/)packages\/ai\/src\/utils\.[cm]?[jt]s$/i, surface: "provider-wrapper" },
	{ pattern: /(?:^|\/)packages\/ai\/src\/oneshot-retry\.[cm]?[jt]s$/i, surface: "provider-wrapper" },
	{ pattern: /(?:^|\/)packages\/ai\/src\/oneshot-retry\.[cm]?[jt]s$/i, surface: "automatic-turn" },
	{ pattern: /(?:^|\/)packages\/ai\/src\/(?:auth-gateway\/.*|auth-retry)\.[cm]?[jt]s$/i, surface: "provider-wrapper" },
	{
		pattern:
			/(?:^|\/)packages\/ai\/src\/(?:auth-broker\/.*|auth-storage|auth\/sqlite-credential-store|usage(?:\/.*)?)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/ai\/src\/(?:auth-broker\/.*|auth-storage|auth\/sqlite-credential-store|usage(?:\/.*)?)\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)packages\/ai\/src\/usage\/openai-codex-reset\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern: /(?:^|\/)packages\/ai\/src\/usage\/openai-codex-reset\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{ pattern: /(?:^|\/)packages\/ai\/src\/error\//i, surface: "provider-wrapper" },
	{
		pattern:
			/(?:^|\/)packages\/ai\/src\/utils\/(?:block-symbols|deterministic-id|empty-completion-retry|event-stream|glyph-codec|google-validation|harmony-leak|http-inspector|leaked-thinking-stream|openai-http|provider-response|retry|retry-after|stream-markup-healing|thinking-loop|tool-call-loop-guard|tool-choice)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)packages\/ai\/src\/utils\/glyph-notice\.md$/i, surface: "prompt-content" },
	{ pattern: /(?:^|\/)packages\/ai\/src\/utils\/glyph-notice\.md$/i, surface: "provider-wrapper" },
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/blob-broker\/.*\.[cm]?[jt]s$/i, surface: "provider-wrapper" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/composer(?:-.*)?\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/macos-spelling\.[cm]?[jt]s$/i, surface: "capability" },
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/startup-composer\.[cm]?[jt]s$/i, surface: "prompt-entry" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/session\/(?:session-pins|title-index)\.[cm]?[jt]s$/i,
		surface: "behavior",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/utils\/command-usage\.[cm]?[jt]s$/i, surface: "behavior" },
	{ pattern: /(?:^|\/)packages\/natives\/native\/desktop-adapter\.js$/i, surface: "capability" },
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/render-cli\.[cm]?[jt]s$/i, surface: "provider-wrapper" },
	{
		pattern:
			/(?:^|\/)packages\/ai\/src\/(?:api-registry|registry\/(?:amazon-bedrock|bedrock-mantle|registry|types))\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)packages\/ai\/src\/registry\/.*\.(?:html|[cm]?[jt]s)$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)packages\/ai\/src\/registry\/.*\.(?:html|[cm]?[jt]s)$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/ai\/src\/(?:api-registry|auth-gateway\/server|registry\/(?:amazon-bedrock|bedrock-mantle|registry|types))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/ai\/src\/(?:dialect\/.*|stream|utils\/(?:schema\/.*|validation))\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/ai\/src\/utils\/(?:anthropic-auth|aws-profile|foundry|openrouter-headers|parse-bind)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:config\/inline-tool-descriptors-mode|extensibility\/(?:custom-tools\/loader|extensions\/wrapper|tool-proxy)|lsp\/tool|mcp\/(?:client|config|loader|manager|tool-bridge|tool-cache|transports\/.*|types)|session\/session-tools|system-prompt)\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/mcp\/.*\.[cm]?[jt]s$/i, surface: "tool-schema" },
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/extensibility\/(?:custom-commands\/index|custom-tools\/index|extensions\/(?:get-commands-handler|index|managed-timers|types)|plugins\/(?:index|marketplace\/index)|utils)\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:capability\/.*|cleanse\/agent|commit\/(?:agentic\/tools\/.*|analysis\/.*|changelog\/.*|map-reduce\/.*)|compress\/protocol|eval\/completion-bridge|extensibility\/(?:custom-tools\/wrapper|hooks\/tool-wrapper|legacy-pi-ai-shim|legacy-pi-coding-agent-shim|legacy-typebox|plugins\/legacy-pi-compat|tool-event-input)|edit\/.*|lsp\/.*|security\/(?:coordinator|publication)|web\/search\/.*)(?:\.(?:json|lark)|\.[cm]?[jt]s)$/i,
		surface: "tool-schema",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:cleanse\/.*|commit\/.*)\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:cleanse\/.*|commit\/.*)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/cleanse\/.*\.[cm]?[jt]s$/i, surface: "task" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/rpc\/host-tools\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:eval\/.*|exa\/mcp-client|exec\/(?:bash-executor|direnv|non-interactive-env)|markit\/.*|mcp\/(?:json-rpc|request-id|timeout)|utils\/turndown|web\/(?:parallel|scrapers\/.*))(?:\.(?:jl|py|rb|txt)|\.[cm]?[jt]s)$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cursor|cursor-bridge-tools|dap\/(?:client|config|index|session)|security\/(?:cloud|comparison|contracts\/(?:ids|index|schemas|validation)|importers\/(?:codex-security|index|sarif)|resource-output|sarif))\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:lib\/xai-http|subprocess\/worker-runtime|tiny\/(?:device|dtype)|tts\/(?:models|tts-client|tts-protocol|tts-worker|wav)|utils\/(?:block-context|cpuprofile|edit-mode|file-display-mode|inspect-image-mode|ipc|markit|markit-cache|profile-tree|sample-profile|zip))\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/dap\/defaults\.json$/i, surface: "tool-schema" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/session\/code-mode\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/tools\/browser\/relay\/extension-assets\/(?:LICENSE|THIRD-PARTY-NOTICES)\.txt$/i,
		surface: "tool-schema",
	},
	{ pattern: /(?:^|\/)packages\/utils\/src\/ar\//i, surface: "tool-schema" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/session\/(?:compaction-methods|speculation-lead)\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/session\/skill-title-input\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/tiny\/completion-prompt\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/tiny\/.*\.(?:py|[cm]?[jt]s)$/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/utils\/video\.[cm]?[jt]s$/i, surface: "capability" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/web\/firecrawl\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)packages\/utils\/src\/json-lexer\.[cm]?[jt]s$/i, surface: "tool-schema" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/utils\/resume-command\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:advisor\/(?:advise-tool|config|delta-split|emission-guard|runtime|watchdog)|async\/job-manager|autolearn\/(?:controller|managed-skills)|autoresearch\/(?:git|helpers|index|state|storage|tools\/.*)|capability\/.*|cleanse\/agent|cli\/(?:auth-gateway-cli|bench-cli|dry-balance-cli)|collab\/host|commit\/(?:agentic\/(?:agent|tools\/.*)|analysis\/.*|changelog\/.*|map-reduce\/.*|pipeline)|compress\/(?:index|protocol|session)|config\/(?:append-only-context-mode|prompt-templates|provider-globals|settings-schema|settings)|discovery\/.*|eval\/completion-bridge|extensibility\/(?:custom-commands\/(?:bundled\/.*|loader)|custom-tools\/wrapper|extensions\/(?:compact-handler|runner)|hooks\/(?:loader|runner|tool-wrapper)|legacy-pi-ai-shim|legacy-pi-coding-agent-shim|legacy-typebox|plugins\/(?:legacy-pi-compat|loader|runtime-config)|skills|slash-commands|tool-event-input)|internal-urls\/.*|live\/(?:controller|protocol|transport)|mcp\/(?:client|config|loader|manager|tool-bridge|tool-cache|transports\/.*|types)|modes\/(?:acp\/acp-agent|components\/agents-hub|controllers\/(?:btw-controller|event-controller|input-controller|omfg-controller|tan-command-controller)|interactive-mode|orchestrate|rpc\/rpc-mode|skill-command|ultrathink|workflow)|secrets\/.*|security\/(?:coordinator|publication)|session\/(?:async-job-delivery|bash-runner|blob-store|claude-session-store|codex-session-store|compact-modes|eval-runner|execution-environment|foreign-session-import|foreign-session-jsonl|irc-bridge|launch-completion|messages|prewalk|provider-image-budget|queued-messages|session-advisors|session-context|session-handoff|session-history-format|session-loader|session-maintenance|session-manager|session-migrations|session-persistence|session-provider-boundary|settings-stream-fn|snapcompact-inline|stream-guards|streaming-output|ttsr-coordinator|turn-persistence|turn-recovery|unexpected-stop-classifier|yield-queue)|slash-commands\/helpers\/security|tiny\/(?:models|title-client|title-protocol|worker)|tts\/speech-enhancer|utils\/(?:active-repo-context|command-args|commit-message-generator|image-loading|image-resize|image-vision-fallback|local-date|prompt-path|title-generator)|vibe\/runtime|web\/search\/.*|workspace-tree)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:advisor\/message-fingerprint|cli\/git-tui\/ai-stage|session\/tool-call-loop-redirect|sharpshooter\/.*|utils\/(?:atomic-file|github|repo-lock)|vibe\/lifecycle)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/commit\/conventional\/resources\/(?:commit_types|validation_data)\.json$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/session\/date-cwd-reminder\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:advisor\/index|async\/index|cli\/(?:args|extension-flags|file-processor|initial-message)|collab\/.*|config|exec\/exec|extensibility\/(?:custom-commands\/index|custom-tools\/index|extensions\/(?:get-commands-handler|index|managed-timers|types)|plugins\/(?:index|marketplace\/index)|utils)|index|jsonrpc\/message-framing|live\/(?:attestation|voices)|main|memories\/storage|memory-backend\/index|modes\/(?:image-references|loop-limit|magic-keyword-boundary|markdown-prose|print-mode|queue-input|runtime-init|session-teardown|turn-budget)|registry\/.*|stt\/.*|tiny\/(?:message-preproc|text)|utils\/(?:clipboard|enhanced-paste|event-bus|external-editor|file-mentions|jj|lang-from-path|shell-snapshot|tool-choice|tools-manager)|web\/kagi)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli|cli-commands|cli\/(?:flag-tables|profile-bootstrap|startup-cwd)|commands\/(?:acp|launch)|export\/ttsr|modes\/(?:components\/(?:agent-hub|agent-transcript-viewer)|utils\/ui-helpers))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli|cli-commands|cli\/(?:flag-tables|profile-bootstrap)|commands\/(?:acp|launch))\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/export\/ttsr\.[cm]?[jt]s$/i,
		surface: "behavior",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:export\/ttsr|modes\/utils\/ui-helpers)\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:export\/ttsr|modes\/components\/(?:agent-hub|agent-transcript-viewer))\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/utils\/ui-helpers\.[cm]?[jt]s$/i,
		surface: "prompt-order",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/utils\/ui-helpers\.[cm]?[jt]s$/i,
		surface: "skill",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:activity\/index|modes\/components\/(?:agent-hub|agent-transcript-viewer))\.[cm]?[jt]s$/i,
		surface: "subagent",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/rpc\/(?:rpc-history|rpc-identity|rpc-mutation|rpc-session-data|rpc-state|rpc-types)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/session\/inline-edit-recovery\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/(?:flag-tables|profile-bootstrap|startup-cwd)\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/(?:flag-tables|startup-cwd)\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/flag-tables\.[cm]?[jt]s$/i,
		surface: "approval",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/commands\/(?:acp|launch)\.[cm]?[jt]s$/i,
		surface: "approval",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/flag-tables\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:components\/(?:advisor-config|mcp-add-wizard|plan-review-overlay|plugin-settings|settings-selector|extensions\/(?:extension-dashboard|extension-list|state-manager))|controllers\/(?:command-controller-shared|live-command-controller|session-focus-controller|ssh-command-controller))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:advisor-config|model-browser|model-hub|model-picker|settings-selector)\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:components\/(?:advisor-config|mcp-add-wizard|model-browser|model-hub|model-picker|plugin-settings|settings-selector|extensions\/(?:extension-dashboard|extension-list|state-manager))|controllers\/(?:command-controller-shared|ssh-command-controller))\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:components\/(?:advisor-config|mcp-add-wizard|plugin-settings|settings-selector|extensions\/(?:extension-dashboard|extension-list|state-manager))|controllers\/(?:command-controller-shared|live-command-controller|session-focus-controller|ssh-command-controller))\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:advisor-config|mcp-add-wizard|plugin-settings|extensions\/extension-dashboard)\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/advisor-config\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:advisor-config|plan-review-overlay|plan-toc)\.[cm]?[jt]s$/i,
		surface: "prompt-content",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/plan-review-overlay\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:plan-review-overlay|plan-toc)\.[cm]?[jt]s$/i,
		surface: "behavior",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/controllers\/(?:live-command-controller|session-focus-controller)\.[cm]?[jt]s$/i,
		surface: "subagent",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/controllers\/session-focus-controller\.[cm]?[jt]s$/i,
		surface: "prompt-target",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli\/(?:agents-cli|config-cli|plugin-cli|ssh-cli|classify-install-target)|commands\/(?:agents|commit|compress|config|install|plugin|setup|ssh)|modes\/setup-wizard\/scenes\/(?:model|web-search))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli\/(?:config-cli|plugin-cli|ssh-cli|classify-install-target)|commands\/(?:config|install|plugin|setup|ssh)|modes\/setup-wizard\/scenes\/(?:model|web-search))\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli\/(?:config-cli|plugin-cli|ssh-cli|classify-install-target)|commands\/(?:config|install|plugin|setup|ssh)|modes\/setup-wizard\/scenes\/(?:model|web-search))\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli\/(?:config-cli|plugin-cli)|commands\/(?:config|plugin|setup)|modes\/setup-wizard\/scenes\/(?:model|web-search))\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli\/(?:plugin-cli|classify-install-target)|commands\/(?:install|plugin))\.[cm]?[jt]s$/i,
		surface: "skill",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli\/(?:config-cli|plugin-cli|ssh-cli)|commands\/(?:config|install|plugin|ssh))\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:cli\/agents-cli|commands\/agents)\.[cm]?[jt]s$/i,
		surface: "subagent",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:cli\/agents-cli|commands\/agents)\.[cm]?[jt]s$/i,
		surface: "prompt-content",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/commands\/(?:commit|compress)\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/commands\/(?:commit|compress)\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:countdown-timer|hook-editor|hook-input|hook-selector)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:countdown-timer|hook-editor|hook-input|hook-selector)\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:countdown-timer|hook-editor|hook-input|hook-selector)\.[cm]?[jt]s$/i,
		surface: "prompt-trigger",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:countdown-timer|hook-editor|hook-input|hook-selector)\.[cm]?[jt]s$/i,
		surface: "goal",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:countdown-timer|hook-editor|hook-input|hook-selector)\.[cm]?[jt]s$/i,
		surface: "approval",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:countdown-timer|hook-editor|hook-input|hook-selector)\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/plugin-selector\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/plugin-selector\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/plugin-selector\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/plugin-selector\.[cm]?[jt]s$/i,
		surface: "skill",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/slash-commands\/helpers\/(?:marketplace-manager|mcp|ssh)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/slash-commands\/helpers\/(?:marketplace-manager|mcp|ssh)\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/slash-commands\/helpers\/(?:marketplace-manager|mcp|ssh)\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/slash-commands\/helpers\/(?:marketplace-manager|mcp|ssh)\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:slash-commands\/helpers\/(?:active-oauth-account|logout|reset-usage|session-pin)|modes\/components\/(?:logout-account-selector|reset-usage-selector|session-account-selector))\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:slash-commands\/helpers\/(?:active-oauth-account|logout|reset-usage|session-pin)|modes\/components\/(?:logout-account-selector|reset-usage-selector|session-account-selector))\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:slash-commands\/helpers\/(?:active-oauth-account|logout|reset-usage|session-pin)|modes\/components\/(?:logout-account-selector|reset-usage-selector|session-account-selector))\.[cm]?[jt]s$/i,
		surface: "approval",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/agent-hub-projection\.[cm]?[jt]s$/i,
		surface: "subagent",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:agent-hub-projection|session-selector|tree-selector|user-message-selector)\.[cm]?[jt]s$/i,
		surface: "prompt-target",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:session-selector|tree-selector|user-message-selector)\.[cm]?[jt]s$/i,
		surface: "behavior",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:session-selector|tree-selector|user-message-selector)\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/components\/(?:history-search|session-selector|tree-selector|user-message-selector)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/history-search\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/extensibility\/plugins\/(?:bun-git-cache|git-url|manager|parser|marketplace\/(?:registry|types))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/extensibility\/plugins\/(?:bun-git-cache|git-url|manager|parser|marketplace\/(?:registry|types))\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/extensibility\/plugins\/(?:bun-git-cache|git-url|manager|parser|marketplace\/(?:registry|types))\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/extensibility\/plugins\/(?:manager|parser|marketplace\/(?:registry|types))\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/live\/visualizer\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/mcp\/.*\.[cm]?[jt]s$/i, surface: "provider-wrapper" },
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:config\/(?:model-registry|model-resolver|provider-globals|service-tier|settings-schema|settings)|extensibility\/extensions\/model-api|session\/(?:model-controls|retry-fallback-chains|role-models)|thinking|tiny\/models)\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:config|config\/(?:api-key-resolver|claude-paths|config-file|custom-models|model-config-values|model-discovery|model-patch|model-provider-discovery|model-roles|models-config-schema-bundle|models-config|resolve-config-value))\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/config\/(?:api-key-resolver|custom-models|model-config-values|model-discovery|model-patch|model-provider-discovery|model-roles|models-config-schema-bundle|models-config|resolve-config-value)\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:config|config\/(?:claude-paths|config-file))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/session\/retry-fallback-chains\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/priority\.json$/i, surface: "provider-mapping" },
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:auto-thinking\/classifier|hindsight\/(?:backend|bank|client|config|content|mental-models|state|transcript)|memories\/index|memory-backend\/(?:local-backend|messages|off-backend|resolve|runtime|tool-names)|mnemopi\/(?:backend|config|embed-client|embed-protocol|embed-worker|state))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/hindsight\/index\.[cm]?[jt]s$/i, surface: "provider-wrapper" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:irc\/bus|launch\/.*|subprocess\/worker-client)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/launch\/.*\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:modes\/(?:acp\/acp-client-bridge|rpc\/host-tools)|slash-commands\/(?:acp-builtins|builtin-control|builtin-modes|builtin-registry|helpers\/parse))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/rpc\/(?:host-uris|rpc-input)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/rpc\/host-uris\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:components\/(?:ask-dialog|custom-editor)|controllers\/(?:command-controller|extension-ui-controller|mcp-command-controller|omfg-rule|selector-controller|todo-command-controller))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:components\/ask-dialog|controllers\/(?:extension-ui-controller|mcp-command-controller|selector-controller))\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/controllers\/todo-command-controller\.[cm]?[jt]s$/i,
		surface: "todo",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:controllers\/(?:command-controller|selector-controller)|loop-limit)\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/controllers\/omfg-rule\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/controllers\/omfg-rule\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:components\/custom-editor|controllers\/(?:extension-ui-controller|selector-controller)|turn-budget)\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:eval\/.*|exa\/mcp-client|exec\/(?:bash-executor|direnv|non-interactive-env)|markit\/.*|mcp\/(?:json-rpc|request-id|timeout)|utils\/turndown|web\/(?:parallel|scrapers\/.*))(?:\.(?:jl|py|rb|txt)|\.[cm]?[jt]s)$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cursor|cursor-bridge-tools|dap\/(?:client|config|index|session)|security\/(?:auth|cloud|comparison|contracts\/(?:ids|index|schemas|validation)|importers\/(?:codex-security|index|sarif)|preflight|provenance|resource-output|sarif|store)|session\/(?:session-lifecycle-owner|session-lifecycle-transaction))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:lib\/xai-http|subprocess\/worker-runtime|tiny\/(?:device|dtype)|tts\/(?:models|tts-client|tts-protocol|tts-worker|wav)|utils\/(?:block-context|cpuprofile|edit-mode|file-display-mode|inspect-image-mode|ipc|markit|markit-cache|profile-tree|sample-profile|zip))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/dap\/defaults\.json$/i, surface: "provider-wrapper" },
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/hindsight\/seeds\.json$/i, surface: "provider-wrapper" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/auto-thinking\/classifier\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:acp\/acp-agent|rpc\/rpc-mode|skill-command)\.[cm]?[jt]s$/i,
		surface: "skill",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:sdk|commands\/(?:launch|acp)|extensibility\/extensions\/(?:types|runner|loader))\.[cm]?[jt]s$/i,
		surface: "guard",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:modes\/acp\/acp-client-bridge|session\/acp-permission-gate)\.[cm]?[jt]s$/i,
		surface: "approval",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:modes\/acp\/acp-client-bridge|session\/(?:session-lifecycle-owner|session-lifecycle-transaction|tool-choice-queue)|slash-commands\/builtin-control)\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/memory-backend\/tool-names\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:plan-mode\/(?:approved-plan|model-transition|plan-files|plan-handoff|plan-protection)|utils\/(?:edit-mode|file-display-mode|inspect-image-mode))\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/plan-mode\/(?:approved-plan|model-transition|plan-files|plan-handoff|plan-protection)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/session\/tool-choice-queue\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/session\/(?:checkpoint-entries|session-entries|session-memory|session-workspace|session-worktree)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/session\/(?:agent-storage|artifact-durability|artifacts|auth-broker-config|auth-storage|codex-auto-reset|credential-pin|exit-diagnostics|history-storage|session-dump-format|session-listing|session-metadata|session-paths|session-storage|shake-types)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/session\/(?:auth-broker-config|auth-storage|codex-auto-reset|credential-pin)\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/session\/session-memory\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/registry\/.*\.[cm]?[jt]s$/i, surface: "task" },
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/registry\/.*\.[cm]?[jt]s$/i, surface: "subagent" },
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/collab\/.*\.[cm]?[jt]s$/i, surface: "automatic-turn" },
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/slash-commands\/(?:acp-builtins|available-commands|builtin-collaboration|builtin-completions|builtin-control|builtin-lifecycle|builtin-marketplace|builtin-modes|builtin-registry|builtin-session|marketplace-install-parser|helpers\/(?:parse|security|todo))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/slash-commands\/builtin-(?:lifecycle|modes)\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/slash-commands\/helpers\/todo\.[cm]?[jt]s$/i,
		surface: "todo",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/slash-commands\/helpers\/todo\.[cm]?[jt]s$/i,
		surface: "task",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:exec\/exec|ssh\/.*|stt\/.*|utils\/(?:enhanced-paste|file-mentions|shell-snapshot|tool-choice|tools-manager))\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:exec\/exec|ssh\/.*|web\/kagi)\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/tools\/(?:browser\/aria\/aria-snapshot\.bundle|puppeteer\/\d+_[^/]+)\.txt$/i,
		surface: "tool-schema",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/utils\/(?:mac-file-urls\.applescript|shell-snapshot-fn-env\.sh)$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/agent\/src\/pause\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{ pattern: /(?:^|\/)packages\/agent\/src\/pause\.[cm]?[jt]s$/i, surface: "capability" },
	{
		pattern: /(?:^|\/)packages\/agent\/src\/run-collector\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{ pattern: /(?:^|\/)packages\/agent\/src\/run-collector\.[cm]?[jt]s$/i, surface: "approval" },
	{
		pattern: /(?:^|\/)packages\/ai\/(?:package\.json|src\/registry\/(?:api-key-(?:login|validation)|oauth\/.*))$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/ai\/(?:package\.json|src\/registry\/(?:api-key-(?:login|validation)|oauth\/.*))$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)packages\/ai\/src\/utils\/(?:abort|idle-iterator|proxy|sdk-stream-timeout)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/ai\/src\/utils\/proxy\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{ pattern: /(?:^|\/)packages\/ai\/src\/utils\/proxy\.[cm]?[jt]s$/i, surface: "guard" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/utils\/context-usage\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/utils\/context-usage\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/session\/session-stats\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/session\/session-stats\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/stats\/.*\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/(?:emoji-autocomplete\.[cm]?[jt]s|data\/emojis\.json)$/i,
		surface: "prompt-entry",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/(?:emoji-autocomplete\.[cm]?[jt]s|data\/emojis\.json)$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/session-picker\.[cm]?[jt]s$/i,
		surface: "prompt-target",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/session-picker\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/cleanse-picker\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/cleanse-picker\.[cm]?[jt]s$/i, surface: "task" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/cleanse-picker\.[cm]?[jt]s$/i,
		surface: "subagent",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/settings-defs\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/settings-defs\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/settings-defs\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/extensions\/types\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/extensions\/types\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/extensions\/types\.[cm]?[jt]s$/i,
		surface: "skill",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/components\/extensions\/types\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/collab\/local-transport\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/collab\/local-transport\.[cm]?[jt]s$/i,
		surface: "prompt-target",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/collab\/local-transport\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/collab\/local-transport\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/collab\/local-transport\.[cm]?[jt]s$/i,
		surface: "subagent",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/collab\/local-transport\.[cm]?[jt]s$/i,
		surface: "approval",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:mcp\/oauth-discovery|utils\/fetch-timeout)\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:mcp\/oauth-discovery|utils\/fetch-timeout)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:mcp\/oauth-discovery|utils\/fetch-timeout)\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/ssh\/config-writer\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/ssh\/config-writer\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/ssh\/config-writer\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:fresh-omp-companion|fresh-omp-companion-wire)\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:fresh-omp-companion|fresh-omp-companion-wire)\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:fresh-omp-companion|fresh-omp-companion-wire)\.[cm]?[jt]s$/i,
		surface: "approval",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:fresh-omp-companion|fresh-omp-companion-wire)\.[cm]?[jt]s$/i,
		surface: "goal",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:fresh-omp-companion|fresh-omp-companion-wire)\.[cm]?[jt]s$/i,
		surface: "todo",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/modes\/(?:fresh-omp-companion|fresh-omp-companion-wire)\.[cm]?[jt]s$/i,
		surface: "task",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/acp\/acp-mode\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/modes\/acp\/(?:acp-mode|terminal-auth)\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli\/(?:auth-broker-cli|models-cli|usage-cli)|commands\/(?:auth-broker|auth-gateway|models|usage)|modes\/(?:setup-version|setup-wizard\/(?:index|scenes\/(?:providers|sign-in))|components\/oauth-selector))\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli\/(?:auth-broker-cli|models-cli|usage-cli)|commands\/(?:auth-gateway|usage)|modes\/setup-wizard\/scenes\/sign-in)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli\/(?:auth-broker-cli|models-cli|setup-cli)|commands\/(?:auth-broker|auth-gateway|models)|modes\/(?:setup-version|setup-wizard\/(?:index|scenes\/(?:providers|sign-in))|components\/oauth-selector))\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli\/(?:auth-broker-cli|models-cli|setup-cli)|commands\/(?:auth-broker|auth-gateway|models)|modes\/(?:setup-version|setup-wizard\/(?:index|scenes\/(?:providers|sign-in))|components\/oauth-selector))\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:cli\/auth-broker-cli|commands\/(?:auth-broker|auth-gateway)|modes\/setup-wizard\/scenes\/sign-in)\.[cm]?[jt]s$/i,
		surface: "approval",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/setup-cli\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/tts\/index\.[cm]?[jt]s$/i, surface: "tool-schema" },
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/tts\/index\.[cm]?[jt]s$/i, surface: "capability" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:commands\/bench|cli\/bench-cli)\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:commands\/(?:bench|dry-balance)|cli\/(?:bench-cli|dry-balance-cli))\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/src\/(?:commands\/(?:bench|dry-balance)|cli\/(?:bench-cli|dry-balance-cli))\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/(?:commands\/dry-balance|cli\/dry-balance-cli)\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/commands\/cleanse\.[cm]?[jt]s$/i,
		surface: "prompt-entry",
	},
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/commands\/cleanse\.[cm]?[jt]s$/i, surface: "task" },
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/commands\/cleanse\.[cm]?[jt]s$/i,
		surface: "subagent",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/commands\/cleanse\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/build-identity\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/commands\/(?:collab-bridge|join)\.[cm]?[jt]s$/i,
		surface: "prompt-target",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/commands\/(?:collab-bridge|join)\.[cm]?[jt]s$/i,
		surface: "subagent",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/commands\/(?:collab-bridge|join)\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/commands\/(?:collab-bridge|join)\.[cm]?[jt]s$/i,
		surface: "approval",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/auth-gateway-cli\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/auth-gateway-cli\.[cm]?[jt]s$/i,
		surface: "configuration",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/auth-gateway-cli\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/cli\/auth-gateway-cli\.[cm]?[jt]s$/i,
		surface: "approval",
	},
	{
		pattern: /(?:^|\/)packages\/natives\/(?:package\.json|native\/(?:loader-state|embedded-addon)\.js)$/i,
		surface: "tool-schema",
	},
	{
		pattern: /(?:^|\/)packages\/natives\/(?:package\.json|native\/(?:loader-state|embedded-addon)\.js)$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/natives\/(?:package\.json|native\/(?:loader-state|embedded-addon)\.js)$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)packages\/utils\/src\/(?:tab-spacing|version)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/utils\/src\/(?:tab-spacing|version)\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern:
			/(?:^|\/)packages\/coding-agent\/scripts\/(?:bundle-dist|compile-binary|generate-docs-index|legacy-pi-virtual-module)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/scripts\/legacy-pi-virtual-module\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/scripts\/legacy-pi-virtual-module\.[cm]?[jt]s$/i,
		surface: "capability",
	},
	{
		pattern: /(?:^|\/)crates\/pi-natives\/src\/file_lock\/(?:mod|linux|unix|windows)\.rs$/i,
		surface: "guard",
	},
	{
		pattern: /(?:^|\/)crates\/pi-natives\/src\/file_lock\/(?:mod|linux|unix|windows)\.rs$/i,
		surface: "configuration",
	},
	{
		pattern: /(?:^|\/)crates\/pi-natives\/src\/file_lock\/(?:mod|linux|unix|windows)\.rs$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)crates\/pi-natives\/src\/power\.rs$/i,
		surface: "automatic-turn",
	},
	{ pattern: /(?:^|\/)crates\/pi-natives\/src\/power\.rs$/i, surface: "capability" },
	{ pattern: /(?:^|\/)(?:prompts?|prompt-templates?)(?:\/|$)/i, surface: "prompt-content" },
	{ pattern: /(?:^|\/)providers?(?:\/|$)/i, surface: "provider-mapping" },
	{ pattern: /(?:^|\/)wrappers?(?:\/|$)/i, surface: "provider-wrapper" },
	{
		pattern: /(?:^|\/)(?:model-registry|provider-mapping)\.[cm]?[jt]s$/i,
		surface: "provider-mapping",
	},
	{
		pattern: /(?:^|\/)(?:provider-wrapper|providers?\/.*\/wrappers?)\.[cm]?[jt]s$/i,
		surface: "provider-wrapper",
	},
	{
		pattern: /(?:^|\/)(?:tool|tools)\/.*\.[cm]?[jt]s$/i,
		surface: "tool-schema",
	},
	{ pattern: /(?:^|\/)(?:tool|tools)\/.*description\.[cm]?[jt]s$/i, surface: "tool-description" },
	{ pattern: /(?:^|\/)(?:automatic-turn|auto-turn)[^/]*\.[cm]?[jt]s$/i, surface: "automatic-turn" },
	{
		pattern:
			/(?:^|\/)(?:session\/agent-session|modes\/interactive-mode|session\/(?:async-job-delivery|irc-bridge|launch-completion|prewalk|session-maintenance|stream-guards|ttsr-coordinator|turn-recovery|unexpected-stop-classifier|yield-queue))\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{
		pattern: /(?:^|\/)packages\/coding-agent\/src\/slash-commands\/builtin-modes\.[cm]?[jt]s$/i,
		surface: "automatic-turn",
	},
	{ pattern: /(?:^|\/)src\/edit\/index\.[cm]?[jt]s$/i, surface: "capability" },
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/edit\/.*(?:\.lark|\.[cm]?[jt]s)$/i, surface: "capability" },
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/internal-urls\/skill-protocol\.[cm]?[jt]s$/i, surface: "skill" },
	{ pattern: /(?:^|\/)src\/modes\/fresh-omp-companion-wire\.[cm]?[jt]s$/i, surface: "goal" },
	{ pattern: /(?:^|\/)(?:goal|goals)(?:\/|\.[cm]?[jt]s$)/i, surface: "goal" },
	{ pattern: /(?:^|\/)packages\/coding-agent\/src\/session\/todo-tracker\.[cm]?[jt]s$/i, surface: "task" },
	{ pattern: /(?:^|\/)(?:todo|todos)(?:\/|(?:[-_][^/]*)?\.[cm]?[jt]s$)/i, surface: "todo" },
	{ pattern: /(?:^|\/)(?:task|tasks)(?:\/|\.[cm]?[jt]s$)/i, surface: "task" },
	{ pattern: /(?:^|\/)(?:subagent|subagents|spawn-policy)(?:\/|\.[cm]?[jt]s$)/i, surface: "subagent" },
	{ pattern: /(?:^|\/)(?:approval|approvals)(?:\/|\.[cm]?[jt]s$)/i, surface: "approval" },
	{ pattern: /(?:^|\/)(?:capability|capabilities)(?:\/|\.[cm]?[jt]s$)/i, surface: "capability" },
];

const behaviorSurfaces: Readonly<Record<string, ProtectedSurface>> = {
	behavior: "behavior",
	automaticturn: "automatic-turn",
	automaticturns: "automatic-turn",
	goal: "goal",
	goals: "goal",
	todo: "todo",
	todos: "todo",
	task: "task",
	tasks: "task",
	subagent: "subagent",
	subagents: "subagent",
	approval: "approval",
	approvals: "approval",
	capability: "capability",
	capabilities: "capability",
};

const promptSurfaces: Readonly<Record<string, ProtectedSurface>> = {
	content: "prompt-content",
	visibility: "prompt-visibility",
	role: "prompt-role",
	target: "prompt-target",
	trigger: "prompt-trigger",
	order: "prompt-order",
	default: "prompt-default",
};

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function keyName(key: string): string {
	return key.replaceAll(/[-_]/g, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopeFor(key: string, inherited: ManifestScope): ManifestScope {
	const normalized = keyName(key);
	if (normalized === "prompt" || normalized === "prompts" || normalized === "promptentries") return "prompt";
	if (
		normalized === "provider" ||
		normalized === "providers" ||
		normalized === "providermappings" ||
		normalized === "modelmappings" ||
		normalized === "wrappers"
	) {
		return "provider";
	}
	if (normalized === "tool" || normalized === "tools") return "tool";
	return inherited;
}

function initialScope(path: string | undefined): ManifestScope {
	if (!path) return "none";
	const normalized = normalizePath(path);
	if (/(?:^|\/)(?:prompts?|prompt-templates?)(?:\/|$)/i.test(normalized)) return "prompt";
	if (/(?:^|\/)(?:providers?|wrappers?)(?:\/|$)/i.test(normalized)) return "provider";
	if (/(?:^|\/)(?:tool|tools)(?:\/|$)/i.test(normalized)) return "tool";
	return "none";
}

function appendPath(parent: string, key: string | number): string {
	return typeof key === "number" ? `${parent}[${key}]` : parent ? `${parent}.${key}` : key;
}

function stableValue(value: unknown): string {
	if (value === null) return "null";
	if (typeof value !== "object") return JSON.stringify(value) ?? String(value);
	if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
	const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
	return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`).join(",")}}`;
}

function sameValue(left: unknown, right: unknown): boolean {
	return stableValue(left) === stableValue(right);
}

function surfacesForField(key: string, scope: ManifestScope): readonly ProtectedSurface[] {
	const normalized = keyName(key);
	const surfaces: ProtectedSurface[] = [];
	const behaviorSurface = behaviorSurfaces[normalized];
	if (behaviorSurface) surfaces.push(behaviorSurface);
	if (normalized === "implementationsources") surfaces.push("provider-wrapper", "tool-schema");
	if (normalized === "toolschemas") surfaces.push("tool-description", "tool-schema");

	if (scope === "prompt") {
		if (normalized === "entries" || normalized === "prompts" || normalized === "promptentries") {
			surfaces.push("prompt-entry");
		}
		const promptSurface = promptSurfaces[normalized];
		if (promptSurface) surfaces.push(promptSurface);
	}
	if (scope === "provider") {
		if (
			normalized === "provider" ||
			normalized === "providers" ||
			normalized === "mapping" ||
			normalized === "mappings" ||
			normalized === "providermappings" ||
			normalized === "modelmappings"
		) {
			surfaces.push("provider-mapping");
		}
		if (normalized === "wrapper" || normalized === "wrappers") surfaces.push("provider-wrapper");
	}
	if (scope === "tool") {
		if (normalized === "description") surfaces.push("tool-description");
		if (normalized === "schema" || normalized === "inputschema" || normalized === "parameters") {
			surfaces.push("tool-schema");
		}
	}
	return surfaces;
}

function collectSemanticChanges(
	before: unknown,
	after: unknown,
	path: string,
	scope: ManifestScope,
	changes: ProtectedSurfaceChange[],
): void {
	if (sameValue(before, after)) return;
	if (isRecord(before) || isRecord(after)) {
		const beforeRecord = isRecord(before) ? before : {};
		const afterRecord = isRecord(after) ? after : {};
		const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort((left, right) =>
			left.localeCompare(right),
		);
		for (const key of keys) {
			const previous = beforeRecord[key];
			const next = afterRecord[key];
			if (sameValue(previous, next)) continue;
			const childPath = appendPath(path, key);
			const childScope = scopeFor(key, scope);
			const kind: ProtectedChangeKind =
				previous === undefined ? "added" : next === undefined ? "removed" : "changed";
			for (const surface of surfacesForField(key, childScope)) {
				changes.push({ path: childPath, surface, kind });
			}
			collectSemanticChanges(previous, next, childPath, childScope, changes);
		}
		return;
	}
	if (Array.isArray(before) || Array.isArray(after)) {
		const previous = Array.isArray(before) ? before : [];
		const next = Array.isArray(after) ? after : [];
		const length = Math.max(previous.length, next.length);
		for (let index = 0; index < length; index += 1) {
			collectSemanticChanges(previous[index], next[index], appendPath(path, index), scope, changes);
		}
	}
}

function sortedUnique(changes: readonly ProtectedSurfaceChange[]): ProtectedSurfaceChange[] {
	const entries = new Map<string, ProtectedSurfaceChange>();
	for (const change of changes) {
		entries.set(`${change.path}\u0000${change.surface}\u0000${change.kind}`, change);
	}
	return [...entries.values()].sort(
		(left, right) =>
			compareUnicodeCodePoints(left.path, right.path) ||
			compareUnicodeCodePoints(left.surface, right.surface) ||
			compareUnicodeCodePoints(left.kind, right.kind),
	);
}

/** Returns every protected surface selected solely by a repository path. */
export function classifyProtectedPath(
	path: string,
	kind: ProtectedChangeKind = "changed",
): readonly ProtectedSurfaceChange[] {
	const normalized = normalizePath(path);
	if (UNPROTECTED_IMPLEMENTATION_PATHS.has(normalized)) return [];
	return sortedUnique(
		PATH_RULES.filter(rule => rule.pattern.test(normalized)).map(rule => ({
			path: normalized,
			surface: rule.surface,
			kind,
		})),
	);
}

/**
 * Classifies one context-diff entry. It is intentionally pure so both merge
 * guards and context-diff output can use the same decision without filesystem
 * access or parser-dependent behavior.
 */
export function diffProtectedSurface(input: ProtectedSurfaceInput): ProtectedSurfaceClassification {
	const path = input.path ? normalizePath(input.path) : "<manifest>";
	const changes = input.path ? [...classifyProtectedPath(path, input.kind)] : [];
	collectSemanticChanges(input.before, input.after, "", initialScope(input.path), changes);
	const sorted = sortedUnique(changes);
	return { protectedDelta: sorted.length > 0, classifications: sorted };
}

/** Aggregates context-diff entries into one deterministic upstream-merge result. */
export function diffProtectedSurfaces(inputs: readonly ProtectedSurfaceInput[]): ProtectedSurfaceClassification {
	const changes = inputs.flatMap(input => diffProtectedSurface(input).classifications);
	const sorted = sortedUnique(changes);
	return { protectedDelta: sorted.length > 0, classifications: sorted };
}
