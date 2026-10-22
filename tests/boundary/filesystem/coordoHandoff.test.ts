import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const helper = fileURLToPath(
  new URL(
    "../../../.agents/skills/reverse-engineer-anything/scripts/coordo-handoff.mjs",
    import.meta.url,
  ),
);
const targetSha256 = "a".repeat(64);
const bundleBytes = '{"evidence":[]}\n';
const bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");

interface Task {
  to: string;
  question: string;
  scope: string;
  evidence_ids: string[];
  deliverable: string;
}

const task = (overrides: Partial<Task> = {}): Task => ({
  to: "claude",
  question: "Which entry point reaches the native call?",
  scope: "Static inspection of the supplied Evidence only",
  evidence_ids: ["evidence-1"],
  deliverable: "A finding with coverage and unknowns",
  ...overrides,
});

const project = async () => {
  const root = await createTestTempDirectory("rea-coordo-handoff-");
  await mkdir(join(root, ".coordo"));
  await mkdir(join(root, ".private"));
  await writeFile(join(root, ".gitignore"), ".private/\n");
  await writeFile(join(root, ".private/evidence.json"), bundleBytes);
  await execute("git", ["init", "-q"], { cwd: root });
  return root;
};

const run = async (
  root: string,
  manifest: unknown,
  options: { apply?: boolean; env?: NodeJS.ProcessEnv } = {},
) => {
  const manifestPath = join(
    await createTestTempDirectory("rea-coordo-manifest-"),
    "handoff.json",
  );
  await writeFile(manifestPath, JSON.stringify(manifest));
  try {
    const { stdout, stderr } = await execute(
      process.execPath,
      [
        helper,
        "--project",
        root,
        "--manifest",
        manifestPath,
        ...(options.apply ? ["--apply"] : []),
      ],
      { env: { ...process.env, ...options.env } },
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

const manifest = (path: string, tasks: Task[] = [task()]) => ({
  schema: "rea-coordo-handoff/v1",
  from: "codex",
  target_sha256: targetSha256,
  bundle: { path, sha256: bundleSha256 },
  tasks,
});

const dryRunTasks = (stdout: string) =>
  (JSON.parse(stdout) as { tasks: { to: string; description: string }[] })
    .tasks;

describe("coordo handoff helper", () => {
  it("previews task text with the caller-selected bundle path, not a symlink target", async () => {
    const root = await project();
    await mkdir(join(root, ".private/opaque-target-name"));
    await writeFile(
      join(root, ".private/opaque-target-name/bundle.json"),
      bundleBytes,
    );
    await symlink(
      "opaque-target-name/bundle.json",
      join(root, ".private/hand-off.json"),
    );

    const result = await run(root, manifest(".private/hand-off.json"));

    expect(result.code).toBe(0);
    const [description] = dryRunTasks(result.stdout).map(
      ({ description }) => description,
    );
    expect(description).toContain(
      `Evidence bundle: .private/hand-off.json (SHA-256 ${bundleSha256}).`,
    );
    expect(description).not.toContain("opaque-target-name");
  });

  it("does not double the caller's closing punctuation", async () => {
    const root = await project();
    const result = await run(root, manifest(".private/evidence.json"));

    const [description] = dryRunTasks(result.stdout).map(
      ({ description }) => description,
    );
    expect(description).toContain(
      "Question: Which entry point reaches the native call? Scope: Static inspection of the supplied Evidence only. Deliverable: A finding with coverage and unknowns.",
    );
  });

  it.each([
    [
      "a path outside the project",
      "../outside.json",
      "inside the selected project",
    ],
    [
      "a symlink that leaves the project",
      ".private/escape.json",
      "inside the selected project",
    ],
    ["a bundle Git does not ignore", "visible.json", "ignored by Git"],
    ["a bundle tracked by Git", "tracked.json", "tracked by Git"],
  ])("rejects %s", async (_name, path, message) => {
    const root = await project();
    const outside = await createTestTempDirectory("rea-coordo-outside-");
    await writeFile(join(outside, "bundle.json"), bundleBytes);
    await symlink(
      join(outside, "bundle.json"),
      join(root, ".private/escape.json"),
    );
    await writeFile(join(root, "visible.json"), bundleBytes);
    await writeFile(join(root, "tracked.json"), bundleBytes);
    await execute("git", ["add", "-f", "tracked.json"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".private/\ntracked.json\n");

    const result = await run(root, manifest(path));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("rejects a lone surrogate that argv encoding would replace, but keeps valid pairs", async () => {
    const root = await project();

    // JSON.stringify escapes the lone surrogate, so the file is valid UTF-8.
    const lone = await run(
      root,
      manifest(".private/evidence.json", [
        task({ question: "before\ud800after" }),
      ]),
    );
    const pair = await run(
      root,
      manifest(".private/evidence.json", [
        task({ question: "Which call logs \u{1F600}?" }),
      ]),
    );

    expect(lone.code).toBe(1);
    expect(lone.stdout).toBe("");
    expect(lone.stderr).toContain(
      "tasks[0].question must be a nonempty single line of well-formed Unicode",
    );
    expect(pair.code).toBe(0);
    expect(dryRunTasks(pair.stdout)[0]?.description).toContain(
      "Question: Which call logs \u{1F600}?",
    );
  });

  it("rejects a bundle whose bytes do not match the manifest digest", async () => {
    const root = await project();
    await writeFile(join(root, ".private/evidence.json"), "changed\n");

    const result = await run(root, manifest(".private/evidence.json"));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("SHA-256 does not match");
  });

  it("bounds task text before any Coordo command could exceed argv limits", async () => {
    const root = await project();
    const tooMany = Array.from({ length: 257 }, (_, index) => `e-${index}`);
    const maximal = Array.from(
      { length: 256 },
      (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(197)}`,
    );

    const count = await run(
      root,
      manifest(".private/evidence.json", [task({ evidence_ids: tooMany })]),
    );
    const size = await run(
      root,
      manifest(".private/evidence.json", [task({ evidence_ids: maximal })]),
    );

    expect(count.code).toBe(1);
    expect(count.stderr).toContain("at most 256 IDs");
    expect(size.code).toBe(1);
    expect(size.stderr).toContain("more than 32768 bytes of task text");
  });
});

// Records each invocation, then runs the supplied shell body.
const fakeCoordo = async (script: string) => {
  const bin = await createTestTempDirectory("rea-coordo-bin-");
  const log = join(bin, "calls.log");
  await writeFile(
    join(bin, "coordo"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n${script}\n`,
  );
  await chmod(join(bin, "coordo"), 0o755);
  return {
    log,
    env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
  };
};

describe.skipIf(process.platform === "win32")("coordo handoff --apply", () => {
  it("creates tasks sequentially and reports their IDs", async () => {
    const root = await project();
    const coordo = await fakeCoordo(
      `n=$(wc -l < "$(dirname "$0")/calls.log" | tr -d ' ')\necho "Allocated TASK-00$n for new task."`,
    );

    const result = await run(
      root,
      manifest(".private/evidence.json", [task(), task({ to: "antigravity" })]),
      { apply: true, env: coordo.env },
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      mode: "applied",
      created: [
        { to: "claude", task_id: "TASK-001" },
        { to: "antigravity", task_id: "TASK-002" },
      ],
    });
    const calls = (await readFile(coordo.log, "utf8")).trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(
      /^task add .* --from codex --to antigravity --as codex$/u,
    );
  });

  it("reports Coordo's exit status without its diagnostics, with the tasks created so far", async () => {
    const root = await project();
    const coordo = await fakeCoordo(
      [
        `n=$(wc -l < "$(dirname "$0")/calls.log" | tr -d ' ')`,
        `if [ "$n" -ge 2 ]; then echo "connect failed for mongodb+srv://agent:hunter2@cluster.example.net/coordo" >&2; exit 3; fi`,
        `echo "Allocated TASK-00$n for new task."`,
      ].join("\n"),
    );

    const result = await run(
      root,
      manifest(".private/evidence.json", [task(), task({ to: "antigravity" })]),
      { apply: true, env: coordo.env },
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      'Coordo handoff: coordo failed (3); created before failure: [{"to":"claude","task_id":"TASK-001"}]\n',
    );
    // Child stderr is untrusted and may carry credentials or backend hosts.
    expect(result.stderr).not.toContain("connect failed");
    expect(result.stderr).not.toContain("mongodb+srv://");
    expect(result.stderr).not.toContain("cluster.example.net");
    expect(result.stderr).not.toContain("hunter2");
  });
});
