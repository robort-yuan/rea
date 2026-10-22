import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const runner = fileURLToPath(
  new URL(
    "../../../.agents/skills/reverse-engineer-anything/scripts/coordo-investigate.mjs",
    import.meta.url,
  ),
);
const fakeSource = fileURLToPath(
  new URL("../../fixtures/fakeCoordo.mjs", import.meta.url),
);
const bundleBytes = '{"evidence":[]}\n';
const bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");

interface Worker {
  to: string;
  evidence_ids?: string[];
}

const manifest = (
  workers: Worker[],
  options: { maxParallel?: number; prefix?: string } = {},
) => ({
  schema: "rea-coordo-investigation/v2",
  from: "codex",
  target_sha256: "a".repeat(64),
  bundle: { path: ".private/evidence.json", sha256: bundleSha256 },
  max_parallel: options.maxParallel ?? 2,
  tasks: workers.map((worker, index) => ({
    to: worker.to,
    question: `Which path does scope ${index + 1} take`,
    scope: "Static inspection of the supplied Evidence only",
    evidence_ids: worker.evidence_ids ?? ["evidence-1"],
    report_path: `.coordo/runs/rea-findings/${options.prefix ?? ""}worker-${index + 1}.json`,
  })),
  reviewer: {
    to: "reviewer",
    report_path: `.coordo/runs/rea-findings/${options.prefix ?? ""}review.json`,
  },
});

const workers = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ to: `worker-${index + 1}` }));

// Each test gets its own project and its own fake Coordo ledger.
const fixture = async (behavior: Record<string, string> = {}) => {
  const root = await createTestTempDirectory("rea-coordo-investigate-");
  await mkdir(join(root, ".coordo"));
  await mkdir(join(root, ".private"));
  await writeFile(join(root, ".gitignore"), ".private/\n");
  await writeFile(join(root, ".private/evidence.json"), bundleBytes);
  await execute("git", ["init", "-q"], { cwd: root });
  const bin = await createTestTempDirectory("rea-coordo-fake-");
  await copyFile(fakeSource, join(bin, "fake.mjs"));
  await writeFile(
    join(bin, "coordo"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "fake.mjs")}" "$@"\n`,
  );
  await chmod(join(bin, "coordo"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_COORDO_BEHAVIOR: JSON.stringify(behavior),
    FAKE_COORDO_DELAY_MS: "150",
  };
  const calls = async () =>
    (await readFile(join(bin, "calls.log"), "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ") as [string, string, string]);
  const manifestPath = async (value: unknown) => {
    const path = join(
      await createTestTempDirectory("rea-coordo-manifest-"),
      "investigation.json",
    );
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const run = async (value: unknown, ...flags: string[]) => {
    try {
      const { stdout, stderr } = await execute(
        process.execPath,
        [
          runner,
          "--project",
          root,
          "--manifest",
          await manifestPath(value),
          ...flags,
        ],
        { env },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string };
      return {
        code: failure.code,
        stdout: failure.stdout,
        stderr: failure.stderr,
      };
    }
  };
  return { root, env, calls, manifestPath, run };
};

const peakConcurrency = (events: [string, string, string][]) => {
  let running = 0;
  let peak = 0;
  for (const [kind] of events) {
    if (kind === "start") peak = Math.max(peak, ++running);
    if (kind === "end") running--;
  }
  return peak;
};

describe.skipIf(process.platform === "win32")(
  "coordo investigation runner",
  () => {
    it("dispatches workers within max_parallel, then gates the reviewer on their reports", async () => {
      const project = await fixture();

      const result = await project.run(
        manifest(workers(3), { maxParallel: 2 }),
        "--apply",
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outcome: "complete",
        reviewer: { validated: true, status: "accepted" },
      });
      const events = (await project.calls()).filter(([kind]) => kind !== "add");
      expect(peakConcurrency(events)).toBe(2);
      // The reviewer task (TASK-004) starts only after every worker has ended.
      const reviewerStart = events.findIndex(
        ([kind, id]) => kind === "start" && id === "TASK-004",
      );
      expect(reviewerStart).toBe(events.length - 2);
      expect(
        events.slice(0, reviewerStart).filter(([kind]) => kind === "end"),
      ).toHaveLength(3);
    });

    it("rechecks saved results on resume instead of reporting stale completion", async () => {
      const project = await fixture();
      const value = manifest(workers(2));
      expect((await project.run(value, "--apply")).code).toBe(0);
      const dispatched = (await project.calls()).length;

      await rm(join(project.root, ".coordo/runs/rea-findings/review.json"));
      const missingReview = await project.run(value, "--resume");
      await rm(join(project.root, ".coordo/runs/rea-findings/worker-1.json"));
      const missingWorker = await project.run(value, "--resume");

      expect(missingReview.code).toBe(4);
      expect(JSON.parse(missingReview.stdout)).toMatchObject({
        outcome: "partial",
        reviewer: { validated: false },
      });
      expect(JSON.parse(missingReview.stdout).reviewer.error).toContain(
        "Missing report",
      );
      expect(missingWorker.code).toBe(4);
      expect(JSON.parse(missingWorker.stdout).workers[0]).toMatchObject({
        validated: false,
        error: expect.stringContaining("Missing report"),
      });
      // Closed tasks are rechecked, not redispatched or recreated.
      expect(await project.calls()).toHaveLength(dispatched);
    });

    it("rejects an observation that cites no Evidence and never starts the reviewer", async () => {
      const project = await fixture({ "worker-1": "no-evidence" });

      const result = await project.run(manifest(workers(2)), "--apply");

      expect(result.code).toBe(4);
      const summary = JSON.parse(result.stdout);
      expect(summary.outcome).toBe("partial");
      expect(summary.workers[0].error).toContain("cites no Evidence ID");
      expect(summary.reviewer.task_id).toBeNull();
      expect(
        (await project.calls())
          .filter(([kind]) => kind === "add")
          .map(([, id]) => id),
      ).toEqual(["TASK-001", "TASK-002"]);
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "coordo investigation runner safeguards",
  () => {
    it("refuses to run when state or agent logs would be visible to Git", async () => {
      const project = await fixture();
      await mkdir(join(project.root, ".coordo/runs"));
      await writeFile(
        join(project.root, ".coordo/runs/.gitignore"),
        "rea-findings/\n",
      );

      const result = await project.run(manifest(workers(2)), "--apply");

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("is not Git ignored");
      expect(await project.calls()).toEqual([]);
    });

    it("checks the reviewer handoff size before creating any task", async () => {
      const project = await fixture();
      const ids = (offset: number) =>
        Array.from(
          { length: 128 },
          (_, index) =>
            `${String(offset + index).padStart(3, "0")}${"x".repeat(197)}`,
        );
      const value = manifest([
        { to: "worker-1", evidence_ids: ids(0) },
        { to: "worker-2", evidence_ids: ids(128) },
      ]);

      const preview = await project.run(value);
      const apply = await project.run(value, "--apply");

      for (const result of [preview, apply]) {
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("more than 32768 bytes of task text");
      }
      expect(await project.calls()).toEqual([]);
    });

    it("reserves report paths so another manifest cannot write them", async () => {
      const project = await fixture({
        "worker-1": "no-close",
        "worker-2": "no-close",
      });
      const first = await project.run(manifest(workers(2)), "--apply");
      const created = (await project.calls()).filter(
        ([kind]) => kind === "add",
      );

      const second = await project.run(
        manifest(workers(2), { maxParallel: 1 }),
        "--apply",
      );
      const afterSecond = (await project.calls()).filter(
        ([kind]) => kind === "add",
      );
      const elsewhere = await project.run(
        manifest(workers(2), { maxParallel: 1, prefix: "other-" }),
        "--apply",
      );

      expect(first.code).toBe(4);
      expect(second.code).toBe(1);
      expect(second.stderr).toContain(
        `is reserved by run ${JSON.parse(first.stdout).run_id}`,
      );
      // The blocked manifest created no Coordo task.
      expect(afterSecond).toEqual(created);
      // Distinct report paths are not blocked; these workers stay open too.
      expect(elsewhere.code).toBe(4);
      expect(elsewhere.stderr).not.toContain("reserved");
    });

    it("stops current agents and starts no further work when cancelled", async () => {
      const project = await fixture({ "worker-1": "hang" });
      const child = spawn(
        process.execPath,
        [
          runner,
          "--project",
          project.root,
          "--manifest",
          await project.manifestPath(manifest(workers(3), { maxParallel: 1 })),
          "--apply",
        ],
        { env: project.env },
      );
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      const exited = new Promise<number | null>((resolve) =>
        child.on("close", resolve),
      );
      const deadline = Date.now() + 15_000;
      while (!(await project.calls()).some(([kind]) => kind === "start")) {
        if (Date.now() > deadline) throw new Error("worker never started");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      child.kill("SIGTERM");
      const code = await exited;

      expect(code).toBe(130);
      expect(JSON.parse(stdout)).toMatchObject({ outcome: "cancelled" });
      const events = await project.calls();
      expect(events.filter(([kind]) => kind === "start")).toHaveLength(1);
      // The hanging worker was terminated rather than left to finish.
      expect(events.filter(([kind]) => kind === "end")).toHaveLength(0);
    }, 30_000);
  },
);
