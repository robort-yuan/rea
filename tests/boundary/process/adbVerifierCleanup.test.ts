import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const runVerifier = async (
  settings: {
    closeFails?: boolean;
    probeCleanupFails?: boolean;
    probeCleanupFailures?: number;
    pushFails?: boolean;
    pushPartialFails?: boolean;
    pullFails?: boolean;
    thrown?: "undefined" | "null";
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "rea-adb-verifier-test-"));
  roots.push(root);
  await mkdir(join(root, "scripts", "lib"), { recursive: true });
  await mkdir(join(root, "dist", "application", "adb"), { recursive: true });
  await mkdir(join(root, "dist", "adb"), { recursive: true });
  await mkdir(join(root, "dist", "composition"), { recursive: true });
  await mkdir(join(root, "dist", "process"), { recursive: true });
  await writeFile(
    join(root, "scripts", "verify-adb.mjs"),
    await readFile(new URL("../../../scripts/verify-adb.mjs", import.meta.url)),
  );
  await writeFile(
    join(root, "scripts", "lib", "adb-verifier-cleanup.mjs"),
    await readFile(
      new URL("../../../scripts/lib/adb-verifier-cleanup.mjs", import.meta.url),
    ),
  );
  await writeFile(
    join(root, "scripts", "lib", "verifier-cleanup.mjs"),
    await readFile(
      new URL("../../../scripts/lib/verifier-cleanup.mjs", import.meta.url),
    ),
  );
  await writeFile(
    join(root, "dist", "composition", "adb.js"),
    `import { writeFile } from "node:fs/promises";
export const createAdbDeviceAnalysisProvider = () => ({
  async close() {
    await writeFile(process.env.REA_ADB_CLOSE_MARKER, "closed");
    if (process.env.REA_ADB_CLOSE_FAIL === "1") {
      const error = new Error("provider cleanup refused");
      error.cleanupResources = ["fixture/private-root"];
      error.diagnostics = { reason: "retry remains possible" };
      throw error;
    }
  },
});\n`,
  );
  await writeFile(
    join(root, "dist", "application", "adb", "AdbDeviceAnalysisService.js"),
    `export class AdbDeviceAnalysisService {
  async execute(operation, input) {
    if (process.env.REA_ADB_THROW === "undefined") throw undefined;
    if (process.env.REA_ADB_THROW === "null") throw null;
    if (operation === "push_adb_file" && process.env.REA_ADB_PUSH_FAIL === "1")
      return { ok: false, error: { message: "device push refused" } };
    if (operation === "push_adb_file" && process.env.REA_ADB_PUSH_PARTIAL_FAIL === "1")
      return { ok: false, error: {
        message: "device digest mismatch after push",
        partialObservation: {
          operation,
          parameters: { serial: input.serial, device_path: input.device_path },
        },
      } };
    if (operation === "pull_adb_file" && process.env.REA_ADB_PULL_FAIL === "1")
      return { ok: false, error: { message: "device pull refused" } };
    const result = {
      inspect_adb_client: { client: { version: "1", binary_path: "/tmp/adb" } },
      list_adb_devices: { devices: [{ serial: "test", state: "device", kind: "emulator", kind_basis: "stub" }] },
      inspect_adb_device: { properties: [{ name: "ro.build.version.sdk", value: "35" }], emulator_observed: true },
      list_adb_processes: { processes: [{ name: "probe" }], columns: "pid name" },
      inspect_adb_window: { focused_window: null },
      inspect_adb_display: { physical_size: { width: 2, height: 2 }, physical_density: 1 },
      read_adb_setting: { value: "1" },
      read_adb_logcat: { lines: [], coverage: "complete" },
      list_adb_features: { features: ["feature"], coverage: "complete" },
      list_adb_services: { services: ["service"], coverage: "complete" },
      list_adb_directory: { entries: [], coverage: "complete" },
      list_adb_packages: { packages: input.scope === "all" ? [{ package_name: "com.test" }] : [], coverage: "complete" },
      push_adb_file: { bytes: 3, sha256: "${"a".repeat(64)}", device_sha256: "${"a".repeat(64)}", device_digest_source: "device_sha256sum" },
      pull_adb_file: { bytes: 3, sha256: "${"a".repeat(64)}" },
      capture_adb_screen: { width: 2, height: 2, bytes: 3 },
    }[operation];
    return { ok: true, value: { normalized_result: result } };
  }
}\n`,
  );
  await writeFile(
    join(root, "dist", "adb", "AdbConfiguration.js"),
    `export const resolveAdbBinary = (environment) => ({ binary: environment.REA_ADB_PATH, pathSource: "environment" });\n`,
  );
  await writeFile(
    join(root, "dist", "adb", "AdbCommand.js"),
    `export const adbArguments = (serial, arguments_) => ["-s", serial, ...arguments_];\n`,
  );
  const probeRemovals = join(root, "probe-removals.jsonl");
  await writeFile(
    join(root, "dist", "process", "ExecFileOutput.js"),
    `import { appendFile } from "node:fs/promises";
let cleanupAttempts = 0;
export const execFileOutput = async (binary, arguments_, options) => {
  await appendFile(process.env.REA_ADB_REMOVE_MARKER, JSON.stringify({ binary, arguments_, options }) + "\\n");
  if (cleanupAttempts++ < Number(process.env.REA_ADB_REMOVE_FAIL_COUNT)) throw new Error("device cleanup refused");
  return { stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0 };
};\n`,
  );
  const marker = join(root, "provider-closed");
  const run = spawnSync(
    process.execPath,
    [join(root, "scripts", "verify-adb.mjs")],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        REA_ADB_PATH: "fixture-adb",
        REA_ADB_REMOVE_MARKER: probeRemovals,
        REA_ADB_REMOVE_FAIL_COUNT: String(
          settings.probeCleanupFails ? 3 : (settings.probeCleanupFailures ?? 0),
        ),
        REA_ADB_PUSH_FAIL: settings.pushFails ? "1" : "0",
        REA_ADB_PUSH_PARTIAL_FAIL: settings.pushPartialFails ? "1" : "0",
        REA_ADB_PULL_FAIL: settings.pullFails ? "1" : "0",
        REA_ADB_CLOSE_MARKER: marker,
        REA_ADB_CLOSE_FAIL: settings.closeFails ? "1" : "0",
        ...(settings.thrown === undefined
          ? {}
          : { REA_ADB_THROW: settings.thrown }),
      },
    },
  );
  const closed = await readFile(marker, "utf8").catch(() => null);
  const removals = await readFile(probeRemovals, "utf8").catch(() => "");
  return { ...run, closed, removals };
};

it("runs the production verifier successfully and closes its provider", async () => {
  const result = await runVerifier();

  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout).toContain("all adb device checks passed");
  expect(result.stdout).toContain("[ok] device transfer probe removed");
  expect(result.closed).toBe("closed");
  const [removal] = result.removals
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(removal.binary).toBe("fixture-adb");
  expect(removal.arguments_).toHaveLength(7);
  expect(removal.arguments_.slice(0, 6)).toEqual([
    "-s",
    "test",
    "shell",
    "rm",
    "-f",
    "--",
  ]);
  expect(removal.arguments_[6]).toMatch(
    /^\/data\/local\/tmp\/rea-verify-[0-9a-f-]{36}\.txt$/u,
  );
  expect(removal.options).toMatchObject({
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    stopSignal: "SIGTERM",
  });
});

it("uses a distinct UUID probe path for each verifier run", async () => {
  const first = await runVerifier();
  const second = await runVerifier();
  const extractPath = (result: Awaited<ReturnType<typeof runVerifier>>) => {
    const [removal] = result.removals
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return removal.arguments_[6];
  };

  expect(extractPath(first)).not.toBe(extractPath(second));
});

it("removes the device probe after the pull fails", async () => {
  const result = await runVerifier({ pullFails: true });

  expect(result.status).toBe(1);
  expect(result.stdout).toContain("device pull refused");
  expect(result.stdout).toContain("[ok] device transfer probe removed");
  expect(result.removals).not.toBe("");
});

it("does not remove a device path when the push fails", async () => {
  const result = await runVerifier({ pushFails: true });

  expect(result.status).toBe(1);
  expect(result.stdout).toContain("device push refused");
  expect(result.removals).toBe("");
});

it("removes the probe when the push failed after confirmed device write", async () => {
  const result = await runVerifier({ pushPartialFails: true });

  expect(result.status).toBe(1);
  expect(result.stdout).toContain("device digest mismatch after push");
  expect(result.stdout).toContain("[ok] device transfer probe removed");
  const [removal] = result.removals
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(removal.arguments_[6]).toMatch(
    /^\/data\/local\/tmp\/rea-verify-[0-9a-f-]{36}\.txt$/u,
  );
});

it("retries transient device probe cleanup failures", async () => {
  const result = await runVerifier({ probeCleanupFailures: 1 });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain("[ok] device transfer probe removed");
  expect(result.removals.trim().split("\n")).toHaveLength(2);
});

it("fails the verifier when removing its device probe fails", async () => {
  const result = await runVerifier({ probeCleanupFails: true });

  expect(result.status).toBe(1);
  expect(result.stdout).toContain(
    "[FAIL] device transfer probe removed — Unable to remove verifier probe after 3 attempts",
  );
  expect(result.removals.trim().split("\n")).toHaveLength(3);
  expect(result.stdout).not.toContain("all adb device checks passed");
  expect(result.closed).toBe("closed");
});

it("makes provider cleanup failure fail the production verifier with resource details", async () => {
  const result = await runVerifier({ closeFails: true });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("provider cleanup refused");
  expect(result.stderr).toContain("fixture/private-root");
  expect(result.stderr).toContain("retry remains possible");
  expect(result.closed).toBe("closed");
});

it.each(["undefined", "null"] as const)(
  "closes after the verifier throws %s and exits unsuccessfully",
  async (thrown) => {
    const result = await runVerifier({ thrown });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`verifier aborted — ${thrown}`);
    expect(result.closed).toBe("closed");
  },
);

it("reports both an unexpected verifier throw and provider cleanup failure", async () => {
  const result = await runVerifier({ closeFails: true, thrown: "null" });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("verifier aborted — null");
  expect(result.stderr).toContain("provider cleanup refused");
  expect(result.stderr).toContain("fixture/private-root");
  expect(result.closed).toBe("closed");
});
