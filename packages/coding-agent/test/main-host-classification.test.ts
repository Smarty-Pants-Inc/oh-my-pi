import { expect, it, vi } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { verifyApprovedStartup } from "@oh-my-pi/pi-coding-agent/context/approved-policy";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { getDbBusyTimeoutMs, setInteractiveHost } from "@oh-my-pi/pi-utils";

it("classifies an interactive host before opening auth storage", async () => {
	const previous = setInteractiveHost(false);
	const stop = new Error("stop after auth classification");
	let observedTimeout: number | undefined;
	let observedInteractive: boolean | undefined;
	const parsed = parseArgs([]);
	parsed.noExtensions = true;

	try {
		await expect(
			runRootCommand(parsed, [], {
				verifyApprovedStartup: async isInteractive => {
					observedInteractive = isInteractive;
				},
				discoverAuthStorage: async () => {
					observedTimeout = getDbBusyTimeoutMs();
					throw stop;
				},
			}),
		).rejects.toBe(stop);
	} finally {
		setInteractiveHost(previous);
	}

	expect(observedTimeout).toBe(5000);
	expect(observedInteractive).toBe(true);
});

it("classifies noninteractive launches before enforcing approved startup", async () => {
	const stop = new Error("strict noninteractive policy check");
	let observedInteractive: boolean | undefined;
	const parsed = parseArgs(["--mode", "json"]);

	await expect(
		runRootCommand(parsed, ["--mode", "json"], {
			verifyApprovedStartup: async isInteractive => {
				observedInteractive = isInteractive;
				throw stop;
			},
		}),
	).rejects.toBe(stop);

	expect(observedInteractive).toBe(false);
});

it("warns for interactive prompt-policy drift and remains strict otherwise", async () => {
	const policyError = new Error("PROMPT_POLICY_REVIEW_REQUIRED: drift");
	const unexpected = new Error("unexpected startup failure");
	const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	try {
		await verifyApprovedStartup(true, async () => {
			throw policyError;
		});
		expect(stderr).toHaveBeenCalledWith("Warning: PROMPT_POLICY_REVIEW_REQUIRED: drift\n");

		await expect(
			verifyApprovedStartup(false, async () => {
				throw policyError;
			}),
		).rejects.toBe(policyError);
		await expect(
			verifyApprovedStartup(true, async () => {
				throw unexpected;
			}),
		).rejects.toBe(unexpected);
	} finally {
		stderr.mockRestore();
	}
});
