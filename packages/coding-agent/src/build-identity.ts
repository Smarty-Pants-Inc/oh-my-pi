declare const __OMP_BUILD_ID__: string | undefined;

const embeddedBuildId =
	(import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN")) &&
	typeof __OMP_BUILD_ID__ === "string"
		? __OMP_BUILD_ID__.trim()
		: undefined;

function takeManagedSourceBuildId(): string {
	const [selector, value] = process.argv.slice(2, 4);
	if (selector !== "__managed-source-build-id") return "";
	process.argv.splice(2, 2);
	const buildId = value?.trim() ?? "";
	return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(buildId) && !buildId.includes("REPLACE_WITH_") ? buildId : "";
}

delete process.env.OMP_MANAGED_BUILD_ID;

/** Immutable identity embedded in standalone binaries or supplied by the managed immutable source launcher. */
export const OMP_BUILD_ID = embeddedBuildId ?? takeManagedSourceBuildId();
