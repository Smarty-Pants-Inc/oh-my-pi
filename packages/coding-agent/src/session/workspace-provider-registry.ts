import type { ProviderId, RuntimePlacement } from "../registry/persistent-agent-contracts.js";
import type {
	RuntimeCandidate,
	RuntimeCapability,
	RuntimeLocation,
	RuntimeProvider,
	RuntimeProviderDiscoveryObservation,
	RuntimeProviderDiscoveryProbeResult,
	RuntimeProviderRegistry,
	RuntimeProviderReportedUnavailableCodeV1,
	RuntimeRequirements,
	RuntimeScheduleRequest,
	RuntimeScheduleResult,
	RuntimeScheduler,
	RuntimeSchedulerCandidateObservation,
	RuntimeSchedulerHardFilterCode,
	RuntimeSchedulerProviderObservation,
} from "./workspace-runtime-contracts.js";
import { SAFE_DIAGNOSTIC_MESSAGE_CATALOG_V1 } from "./workspace-runtime-contracts.js";

const PROVIDER_FAILURE_ORDER: readonly RuntimeSchedulerHardFilterCode[] = [
	"configured_provider_missing",
	"configured_provider_disabled",
	"configured_provider_unavailable",
	"configured_provider_location_conflict",
	"provider_disabled",
	"provider_unavailable",
	"provider_no_candidates",
	"candidate_unavailable",
	"placement_mismatch",
	"provider_id_mismatch",
	"workspace_format_mismatch",
	"capability_missing",
	"os_mismatch",
	"arch_mismatch",
	"cpu_insufficient",
	"memory_insufficient",
	"network_mismatch",
	"ready_latency_exceeded",
];

export interface RuntimeProviderConfigurationV1 {
	readonly providerId: ProviderId;
	readonly enabled: boolean;
}

export class WorkspaceRuntimeProviderRegistry implements RuntimeProviderRegistry {
	readonly #providers = new Map<ProviderId, RuntimeProvider>();

	register(provider: RuntimeProvider): void {
		if (this.#providers.has(provider.id)) throw new Error(`Runtime provider already registered: ${provider.id}`);
		if (!isSortedUnique(provider.supportedLocations)) {
			throw new TypeError(`Runtime provider locations must be sorted and duplicate-free: ${provider.id}`);
		}
		this.#providers.set(provider.id, provider);
	}

	get(providerId: ProviderId): RuntimeProvider {
		const provider = this.#providers.get(providerId);
		if (!provider) throw new Error(`Runtime provider is not registered: ${providerId}`);
		return provider;
	}

	list(): readonly RuntimeProvider[] {
		return [...this.#providers.values()].sort((left, right) => left.id.localeCompare(right.id));
	}
}

function isSortedUnique(values: readonly string[]): boolean {
	for (let index = 1; index < values.length; index++) {
		if (values[index - 1].localeCompare(values[index]) >= 0) return false;
	}
	return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isLocation(value: unknown): value is RuntimeLocation {
	return value === "local" || value === "cloud";
}

function isCapability(value: unknown): value is RuntimeCapability {
	return (
		value === "workspace.read" ||
		value === "workspace.write" ||
		value === "workspace.list" ||
		value === "workspace.search" ||
		value === "process.exec" ||
		value === "process.pty" ||
		value === "process.env"
	);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function decodeCandidate(value: unknown, provider: RuntimeProvider): RuntimeCandidate | null {
	if (
		!isPlainRecord(value) ||
		!hasExactKeys(value, [
			"providerId",
			"profileId",
			"location",
			"capabilities",
			"workspaceFormats",
			"os",
			"arch",
			"cpu",
			"memoryMiB",
			"network",
			"available",
			"estimatedIncrementalCostMicrosPerHour",
			"estimatedReadyLatencyMs",
		])
	)
		return null;
	if (
		value.providerId !== provider.id ||
		typeof value.profileId !== "string" ||
		value.profileId.length === 0 ||
		!isLocation(value.location) ||
		!provider.supportedLocations.includes(value.location) ||
		!Array.isArray(value.capabilities) ||
		!value.capabilities.every(isCapability) ||
		new Set(value.capabilities).size !== value.capabilities.length ||
		!Array.isArray(value.workspaceFormats) ||
		value.workspaceFormats.length !== 1 ||
		value.workspaceFormats[0] !== "omp-text-v1" ||
		(value.os !== "darwin" && value.os !== "linux" && value.os !== "windows") ||
		(value.arch !== "arm64" && value.arch !== "x64") ||
		!isNonnegativeSafeInteger(value.cpu) ||
		!isNonnegativeSafeInteger(value.memoryMiB) ||
		(value.network !== "none" && value.network !== "egress") ||
		typeof value.available !== "boolean" ||
		!isNonnegativeSafeInteger(value.estimatedIncrementalCostMicrosPerHour) ||
		!isNonnegativeSafeInteger(value.estimatedReadyLatencyMs)
	)
		return null;
	return {
		providerId: value.providerId,
		profileId: value.profileId,
		location: value.location,
		capabilities: value.capabilities,
		workspaceFormats: ["omp-text-v1"],
		os: value.os,
		arch: value.arch,
		cpu: value.cpu,
		memoryMiB: value.memoryMiB,
		network: value.network,
		available: value.available,
		estimatedIncrementalCostMicrosPerHour: value.estimatedIncrementalCostMicrosPerHour,
		estimatedReadyLatencyMs: value.estimatedReadyLatencyMs,
	};
}

function isSafeDiagnosticCode(value: unknown): value is keyof typeof SAFE_DIAGNOSTIC_MESSAGE_CATALOG_V1 {
	return typeof value === "string" && Object.hasOwn(SAFE_DIAGNOSTIC_MESSAGE_CATALOG_V1, value);
}

function decodeProviderReportedUnavailableCode(value: unknown): RuntimeProviderReportedUnavailableCodeV1 | null {
	if (!isSafeDiagnosticCode(value)) return null;
	switch (value) {
		case "provider_reported_unavailable":
		case "discovery_failed":
			return null;
		default:
			return value;
	}
}

function decodeProbe(value: unknown, provider: RuntimeProvider): RuntimeProviderDiscoveryProbeResult | null {
	if (!isPlainRecord(value) || typeof value.status !== "string") return null;
	if (value.status === "unavailable") {
		const code = decodeProviderReportedUnavailableCode(value.code);
		if (
			!hasExactKeys(value, ["status", "code", "candidates"]) ||
			!Array.isArray(value.candidates) ||
			value.candidates.length !== 0 ||
			code === null
		)
			return null;
		return { status: "unavailable", code, candidates: [] };
	}
	if (
		value.status !== "available" ||
		!hasExactKeys(value, ["status", "candidates"]) ||
		!Array.isArray(value.candidates)
	)
		return null;
	const candidates: RuntimeCandidate[] = [];
	const keys = new Set<string>();
	for (const candidateValue of value.candidates) {
		const candidate = decodeCandidate(candidateValue, provider);
		if (!candidate) return null;
		const key = `${candidate.providerId}\u0000${candidate.profileId}`;
		if (keys.has(key)) return null;
		keys.add(key);
		candidates.push(candidate);
	}
	candidates.sort(
		(left, right) => left.providerId.localeCompare(right.providerId) || left.profileId.localeCompare(right.profileId),
	);
	return { status: "available", candidates };
}

export async function discoverRuntimeProviders(options: {
	readonly registry: RuntimeProviderRegistry;
	readonly configurations: readonly RuntimeProviderConfigurationV1[];
	readonly requirements: RuntimeRequirements;
}): Promise<readonly RuntimeProviderDiscoveryObservation[]> {
	const registered = new Map(options.registry.list().map(provider => [provider.id, provider]));
	const configured = new Map<ProviderId, boolean>();
	for (const configuration of options.configurations) {
		if (configured.has(configuration.providerId))
			throw new TypeError(`Duplicate provider configuration: ${configuration.providerId}`);
		configured.set(configuration.providerId, configuration.enabled);
	}
	const ids = new Set<ProviderId>([...registered.keys(), ...configured.keys()]);
	if (options.requirements.configuredProviderId !== null) ids.add(options.requirements.configuredProviderId);
	const sortedIds = [...ids].sort((left, right) => left.localeCompare(right));
	return Promise.all(
		sortedIds.map(async providerId => {
			const provider = registered.get(providerId);
			const enabled = configured.get(providerId) ?? false;
			if (!provider) {
				return {
					providerId,
					registered: false,
					enabled,
					availability: { status: "not_queried", reason: "not_registered" },
					supportedLocations: [],
					candidates: [],
				} as const;
			}
			if (!enabled) {
				return {
					providerId,
					registered: true,
					enabled: false,
					availability: { status: "not_queried", reason: "disabled" },
					supportedLocations: provider.supportedLocations,
					candidates: [],
				} as const;
			}
			let raw: unknown;
			try {
				raw = await provider.discoverCandidates(options.requirements);
			} catch {
				return {
					providerId,
					registered: true,
					enabled: true,
					availability: {
						status: "unavailable",
						code: "discovery_failed",
						details: { failureKind: "provider_call_failed" },
					},
					supportedLocations: provider.supportedLocations,
					candidates: [],
				} as const;
			}
			const decoded = decodeProbe(raw, provider);
			if (!decoded) {
				return {
					providerId,
					registered: true,
					enabled: true,
					availability: {
						status: "unavailable",
						code: "discovery_failed",
						details: { failureKind: "invalid_result" },
					},
					supportedLocations: provider.supportedLocations,
					candidates: [],
				} as const;
			}
			if (decoded.status === "unavailable") {
				return {
					providerId,
					registered: true,
					enabled: true,
					availability: {
						status: "unavailable",
						code: "provider_reported_unavailable",
						details: { reportedCode: decoded.code },
					},
					supportedLocations: provider.supportedLocations,
					candidates: [],
				} as const;
			}
			return {
				providerId,
				registered: true,
				enabled: true,
				availability: { status: "available" },
				supportedLocations: provider.supportedLocations,
				candidates: decoded.candidates,
			} as const;
		}),
	);
}

function placementMatches(placement: RuntimePlacement, location: RuntimeLocation): boolean {
	return placement === "auto" || placement === location;
}

function providerFailures(
	observation: RuntimeProviderDiscoveryObservation,
	requirements: RuntimeRequirements,
): readonly RuntimeSchedulerHardFilterCode[] {
	const pinned = requirements.configuredProviderId === observation.providerId;
	if (requirements.configuredProviderId !== null && pinned) {
		if (!observation.registered) return ["configured_provider_missing"];
		if (!observation.enabled) return ["configured_provider_disabled"];
		if (observation.availability.status === "unavailable") return ["configured_provider_unavailable"];
		if (requirements.placement !== "auto" && !observation.supportedLocations.includes(requirements.placement)) {
			return ["configured_provider_location_conflict"];
		}
		return observation.candidates.length === 0 ? ["provider_no_candidates"] : [];
	}
	if (requirements.configuredProviderId !== null) return [];
	if (!observation.enabled) return ["provider_disabled"];
	if (observation.availability.status === "unavailable") return ["provider_unavailable"];
	const failures: RuntimeSchedulerHardFilterCode[] = [];
	if (requirements.placement !== "auto" && !observation.supportedLocations.includes(requirements.placement))
		failures.push("placement_mismatch");
	if (observation.candidates.length === 0) failures.push("provider_no_candidates");
	return failures;
}

function candidateFailures(
	candidate: RuntimeCandidate,
	requirements: RuntimeRequirements,
): readonly RuntimeSchedulerHardFilterCode[] {
	const failures: RuntimeSchedulerHardFilterCode[] = [];
	if (!candidate.available) failures.push("candidate_unavailable");
	if (!placementMatches(requirements.placement, candidate.location)) failures.push("placement_mismatch");
	if (requirements.configuredProviderId !== null && candidate.providerId !== requirements.configuredProviderId)
		failures.push("provider_id_mismatch");
	if (!candidate.workspaceFormats.includes(requirements.workspaceFormat)) failures.push("workspace_format_mismatch");
	if (requirements.capabilities.some(capability => !candidate.capabilities.includes(capability)))
		failures.push("capability_missing");
	if (requirements.os !== null && candidate.os !== requirements.os) failures.push("os_mismatch");
	if (requirements.arch !== null && candidate.arch !== requirements.arch) failures.push("arch_mismatch");
	if (candidate.cpu < requirements.minCpu) failures.push("cpu_insufficient");
	if (candidate.memoryMiB < requirements.minMemoryMiB) failures.push("memory_insufficient");
	if (requirements.network === "egress" && candidate.network !== "egress") failures.push("network_mismatch");
	if (requirements.maxReadyLatencyMs !== null && candidate.estimatedReadyLatencyMs > requirements.maxReadyLatencyMs)
		failures.push("ready_latency_exceeded");
	return failures;
}

export class DeterministicRuntimeScheduler implements RuntimeScheduler {
	select(request: RuntimeScheduleRequest): RuntimeScheduleResult {
		const providerRows: RuntimeSchedulerProviderObservation[] = [];
		const candidateRows: RuntimeSchedulerCandidateObservation[] = [];
		const eligible: RuntimeCandidate[] = [];
		let currentCandidate: RuntimeCandidate | null = null;
		for (const observation of request.providers) {
			const failures = providerFailures(observation, request.requirements);
			providerRows.push({
				providerId: observation.providerId,
				registered: observation.registered,
				enabled: observation.enabled,
				availability: observation.availability,
				supportedLocations: observation.supportedLocations,
				candidateCount: observation.candidates.length,
				hardFilterFailures: failures,
			});
			for (const candidate of observation.candidates) {
				const hardFilterFailures = candidateFailures(candidate, request.requirements);
				const retainedCurrent =
					request.current !== null &&
					request.current.providerId === candidate.providerId &&
					request.current.profileId === candidate.profileId &&
					failures.length === 0 &&
					hardFilterFailures.length === 0;
				candidateRows.push({
					providerId: candidate.providerId,
					profileId: candidate.profileId,
					location: candidate.location,
					hardFilterFailures,
					retainedCurrent,
					estimatedIncrementalCostMicrosPerHour: candidate.estimatedIncrementalCostMicrosPerHour,
					estimatedReadyLatencyMs: candidate.estimatedReadyLatencyMs,
				});
				if (failures.length === 0 && hardFilterFailures.length === 0) {
					eligible.push(candidate);
					if (retainedCurrent) currentCandidate = candidate;
				}
			}
		}
		providerRows.sort((left, right) => left.providerId.localeCompare(right.providerId));
		candidateRows.sort(
			(left, right) =>
				left.providerId.localeCompare(right.providerId) || left.profileId.localeCompare(right.profileId),
		);
		if (currentCandidate) {
			return {
				status: "selected",
				candidate: currentCandidate,
				retainedCurrent: true,
				providers: providerRows,
				candidates: candidateRows,
			};
		}
		eligible.sort(
			(left, right) =>
				left.estimatedIncrementalCostMicrosPerHour - right.estimatedIncrementalCostMicrosPerHour ||
				left.estimatedReadyLatencyMs - right.estimatedReadyLatencyMs ||
				left.providerId.localeCompare(right.providerId) ||
				left.profileId.localeCompare(right.profileId),
		);
		const candidate = eligible[0];
		if (candidate)
			return {
				status: "selected",
				candidate,
				retainedCurrent: false,
				providers: providerRows,
				candidates: candidateRows,
			};
		const observed = new Set<RuntimeSchedulerHardFilterCode>();
		for (const provider of providerRows) for (const failure of provider.hardFilterFailures) observed.add(failure);
		for (const row of candidateRows) for (const failure of row.hardFilterFailures) observed.add(failure);
		if (observed.size === 0) observed.add("provider_no_candidates");
		return {
			status: "unsatisfied",
			unmet: PROVIDER_FAILURE_ORDER.filter(failure => observed.has(failure)),
			providers: providerRows,
			candidates: candidateRows,
		};
	}
}
