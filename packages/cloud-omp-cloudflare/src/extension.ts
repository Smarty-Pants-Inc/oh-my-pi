import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type CloudflareEnvironmentConfig, createCloudflareEnvironmentProvider } from "./client/environment";
import { validateCloudOmpEndpoint } from "./client/http";

export interface CloudflareExtensionEnvironment {
	CLOUD_OMP_CLOUDFLARE_ENDPOINT?: string;
	CLOUD_OMP_CLOUDFLARE_BEARER?: string;
	CLOUD_OMP_AUDIT_PATH?: string;
	CLOUD_OMP_TEST_REMOTE_SENTINEL?: string;
}

export function loadCloudflareEnvironmentConfig(
	environment: CloudflareExtensionEnvironment = process.env as unknown as CloudflareExtensionEnvironment,
): CloudflareEnvironmentConfig {
	const endpointValue = requireEnvironmentValue(
		environment.CLOUD_OMP_CLOUDFLARE_ENDPOINT,
		"CLOUD_OMP_CLOUDFLARE_ENDPOINT",
	);
	const bearer = requireEnvironmentValue(environment.CLOUD_OMP_CLOUDFLARE_BEARER, "CLOUD_OMP_CLOUDFLARE_BEARER");
	const endpoint = validateCloudOmpEndpoint(endpointValue).href;
	const auditPath = environment.CLOUD_OMP_AUDIT_PATH;
	if (auditPath !== undefined && (auditPath.length === 0 || auditPath.includes("\0"))) {
		throw new Error("CLOUD_OMP_AUDIT_PATH must be a non-empty filesystem path when set");
	}
	const sentinel = environment.CLOUD_OMP_TEST_REMOTE_SENTINEL;
	if (sentinel !== undefined && sentinel !== "1") {
		throw new Error("CLOUD_OMP_TEST_REMOTE_SENTINEL accepts only the explicit value 1");
	}
	return Object.freeze({
		endpoint,
		bearer,
		...(auditPath === undefined ? {} : { auditPath }),
		testRemoteSentinel: sentinel === "1",
	});
}

export default function cloudOmpCloudflareExtension(pi: ExtensionAPI): void {
	const config = loadCloudflareEnvironmentConfig();
	pi.setLabel("Cloud OMP — Cloudflare Computer");
	pi.registerExecutionEnvironmentProvider(createCloudflareEnvironmentProvider(config));
}

function requireEnvironmentValue(value: string | undefined, name: string): string {
	if (value === undefined || value.length === 0 || /[\r\n]/.test(value)) {
		throw new Error(`${name} is required and must be a non-empty single-line value`);
	}
	return value;
}
