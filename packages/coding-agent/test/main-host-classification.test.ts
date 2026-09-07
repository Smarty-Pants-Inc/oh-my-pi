import { expect, it, vi } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { verifyApprovedStartup } from "@oh-my-pi/pi-coding-agent/context/approved-policy";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { getDbBusyTimeoutMs, setInteractiveHost, TempDir } from "@oh-my-pi/pi-utils";

it("classifies an interactive host before opening auth storage", async () => {
	const previous = setInteractiveHost(false);
	const stop = new Error("stop after auth classification");
	let observedTimeout: number | undefined;
	let observedInteractive: boolean | undefined;
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const parsed = parseArgs([]);
	parsed.noExtensions = true;

	try {
		await expect(
			runRootCommand(parsed, [], {
				verifyApprovedStartup: async isInteractive => {
					observedInteractive = isInteractive;
					return "PROMPT_POLICY_REVIEW_REQUIRED: drift";
				},
				discoverAuthStorage: async () => {
					observedTimeout = getDbBusyTimeoutMs();
					throw stop;
				},
			}),
		).rejects.toBe(stop);
		expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
			"Warning: PROMPT_POLICY_REVIEW_REQUIRED: drift",
		);
	} finally {
		stdout.mockRestore();
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

it("returns interactive prompt-policy drift for the TUI and remains strict otherwise", async () => {
	const policyError = new Error("PROMPT_POLICY_REVIEW_REQUIRED: drift");
	const unexpected = new Error("unexpected startup failure");

	expect(
		await verifyApprovedStartup(true, async () => {
			throw policyError;
		}),
	).toBe("PROMPT_POLICY_REVIEW_REQUIRED: drift");

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
});

it("starts a noninteractive source process without approved-policy files", async () => {
	using tempDir = TempDir.createSync("@omp-policy-free-startup-");
	const probePath = tempDir.join("probe.ts");
	await Bun.write(
		probePath,
		[
			`import { parseArgs } from ${JSON.stringify(new URL("../src/cli/args.ts", import.meta.url).href)};`,
			`import { Settings } from ${JSON.stringify(new URL("../src/config/settings.ts", import.meta.url).href)};`,
			`import { runRootCommand } from ${JSON.stringify(new URL("../src/main.ts", import.meta.url).href)};`,
			'const reachedAuth = new Error("auth startup reached");',
			"try {",
			'  await runRootCommand(parseArgs(["--mode", "json", "--no-extensions"]), [], {',
			"    settings: Settings.isolated(),",
			"    discoverAuthStorage: async () => { throw reachedAuth; },",
			"  });",
			"  process.exit(1);",
			"} catch (error) {",
			"  if (error !== reachedAuth) throw error;",
			'  process.stdout.write("auth startup reached\\n");',
			"}",
		].join("\n"),
	);
	const child = Bun.spawn([process.execPath, probePath], {
		cwd: tempDir.path(),
		env: { ...process.env, HOME: tempDir.path() },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toContain("auth startup reached");
});
