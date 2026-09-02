declare const __OMP_BUILD_ID__: string | undefined;

const embeddedBuildId =
	(import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN")) &&
	typeof __OMP_BUILD_ID__ === "string"
		? __OMP_BUILD_ID__.trim()
		: "";

/** Immutable packaged identity, with a stable source-worktree fallback for development launches. */
export const OMP_BUILD_ID = embeddedBuildId || `source-${Bun.hash(import.meta.dir).toString(16)}`;
