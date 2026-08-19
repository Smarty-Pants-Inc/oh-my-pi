import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildChildEnv, describeChunkFailure } from "./ci-test-ts.ts";

const repoRoot = path.join(import.meta.dir, "..");

async function spawnCaptured(argv: string[], env: Record<string, string | undefined>) {
	const proc = Bun.spawn(argv, {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function runRustTaskWithFakeTools(extraArgs: string[]) {
	const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rs-task-"));
	try {
		const gitPath = path.join(binDir, "git");
		const rustupPath = path.join(binDir, "rustup");
		const cargoPath = path.join(binDir, "cargo");
		const gitLogPath = path.join(binDir, "git.log");
		const cargoLogPath = path.join(binDir, "cargo.log");
		await Bun.write(gitPath, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_GIT_LOG"\n');
		await Bun.write(rustupPath, "#!/bin/sh\nprintf '%s\\n' \"$FAKE_CARGO\"\n");
		await Bun.write(cargoPath, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FAKE_CARGO_LOG"\n');
		await Promise.all([gitPath, rustupPath, cargoPath].map(file => fs.chmod(file, 0o755)));

		const inheritedPath = Bun.env.PATH;
		const result = await spawnCaptured([process.execPath, "scripts/run-rs-task.ts", "test:rs", ...extraArgs], {
			...Bun.env,
			CI: "true",
			PATH: inheritedPath ? `${binDir}${path.delimiter}${inheritedPath}` : binDir,
			FAKE_CARGO: cargoPath,
			FAKE_CARGO_LOG: cargoLogPath,
			FAKE_GIT_LOG: gitLogPath,
		});
		const gitLog = Bun.file(gitLogPath);
		const cargoLog = Bun.file(cargoLogPath);
		return {
			...result,
			gitArgs: (await gitLog.exists()) ? await gitLog.text() : null,
			cargoArgs: (await cargoLog.exists()) ? await cargoLog.text() : null,
		};
	} finally {
		await fs.rm(binDir, { recursive: true, force: true });
	}
}

// The two ways a chunk reaches SIGKILL are indistinguishable by exit code, so
// these drive real subprocesses to produce a genuine 137 rather than asserting
// against a hand-written constant.
async function spawnExitCode(script: string): Promise<number> {
	const proc = Bun.spawn(["sh", "-c", script], { stdout: "ignore", stderr: "ignore" });
	return await proc.exited;
}

// Re-hosts the sequential runner's failure tail: spawn, watchdog, attribute.
// `runTestCommand` itself is not injectable (it builds argv from the repo
// layout), so the decision under test is driven directly.
async function runWithWatchdog(script: string, timeoutMs: number): Promise<string> {
	const proc = Bun.spawn(["sh", "-c", script], { stdout: "ignore", stderr: "ignore" });
	let timedOut = false;
	const killTimer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGKILL");
	}, timeoutMs);
	const exitCode = await proc.exited;
	clearTimeout(killTimer);
	return describeChunkFailure(exitCode, timedOut);
}

describe("describeChunkFailure", () => {
	test("a real SIGKILL that the watchdog did not cause is attributed to the OOM killer", async () => {
		const exitCode = await spawnExitCode("kill -9 $$");
		expect(exitCode).toBe(137);

		const message = describeChunkFailure(exitCode, false);
		expect(message).toContain("OOM killer");
		expect(message).toContain("chunkSize");
		// The old wording carried no cause at all; it must not come back.
		expect(message).not.toBe("failed with exit code 137");
	});

	test("a watchdog kill is attributed to the watchdog, not to memory", async () => {
		const message = await runWithWatchdog("sleep 30", 150);
		expect(message).toContain("chunk watchdog");
		expect(message).toContain("OMP_TEST_CHUNK_TIMEOUT");
		expect(message).not.toContain("OOM killer");
	});

	test("the two SIGKILL causes produce different messages from the same exit code", async () => {
		const oomKilled = describeChunkFailure(137, false);
		const watchdogKilled = describeChunkFailure(137, true);
		expect(oomKilled).not.toBe(watchdogKilled);
	});

	test("an ordinary test failure keeps the plain wording", async () => {
		const exitCode = await spawnExitCode("exit 1");
		expect(exitCode).toBe(1);
		expect(describeChunkFailure(exitCode, false)).toBe("failed with exit code 1");
	});

	test("a bun crash exit keeps the plain wording so the retry log still reads naturally", () => {
		expect(describeChunkFailure(134, false)).toBe("failed with exit code 134");
		expect(describeChunkFailure(139, false)).toBe("failed with exit code 139");
	});

	test("the watchdog message reports the configured timeout", () => {
		const previous = Bun.env.OMP_TEST_CHUNK_TIMEOUT;
		Bun.env.OMP_TEST_CHUNK_TIMEOUT = "42";
		try {
			expect(describeChunkFailure(137, true)).toContain("42s");
		} finally {
			if (previous === undefined) delete Bun.env.OMP_TEST_CHUNK_TIMEOUT;
			else Bun.env.OMP_TEST_CHUNK_TIMEOUT = previous;
		}
	});
});

describe("runner environment", () => {
	test("spawned test env removes host session markers while preserving unrelated variables", () => {
		const env = buildChildEnv({
			KEEP_ME: "present",
			HERDR_ENV: "1",
			SSH_CONNECTION: "client server",
			SSH_TTY: "/dev/ttys001",
			SSH_CLIENT: "client port server",
		});

		expect(env.KEEP_ME).toBe("present");
		for (const key of ["HERDR_ENV", "SSH_CONNECTION", "SSH_TTY", "SSH_CLIENT"]) {
			expect(key in env).toBe(false);
		}
	});
});

describe("Rust runner routing", () => {
	test("local dry-run passes --changed-only to Rust even under inherited CI", async () => {
		const result = await spawnCaptured([process.execPath, "scripts/ci-test-ts.ts", "local", "--dry-run"], {
			...Bun.env,
			CI: "true",
			OMP_TEST_CONCURRENCY: "1",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("$ bun scripts/run-rs-task.ts test:rs --changed-only");
	});

	test("CI changed-only skips a clean tree without invoking cargo", async () => {
		const result = await runRustTaskWithFakeTools(["--changed-only"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.gitArgs).toBe("status\n--porcelain\n-z\n");
		expect(result.cargoArgs).toBeNull();
		expect(result.stdout).toContain("Skipping test:rs");
	});

	test("unmarked CI still invokes cargo nextest without consulting git", async () => {
		const result = await runRustTaskWithFakeTools([]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.gitArgs).toBeNull();
		expect(result.cargoArgs).toBe(
			`${[
				"nextest",
				"run",
				"--workspace",
				"--exclude",
				"brush-core",
				"--status-level=fail",
				"--final-status-level=fail",
			].join("\n")}\n`,
		);
	});
});
