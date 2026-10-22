#!/usr/bin/env node

// Coordinate independent, evidence-bound REA findings through an existing
// Coordo installation. This script never opens or executes the target itself.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const handoffScript = fileURLToPath(
  new URL("./coordo-handoff.mjs", import.meta.url),
);
const namePattern = /^[a-z][a-z0-9_-]*$/u;
const evidencePattern = /^[A-Za-z0-9._:-]+$/u;
const digestPattern = /^[a-fA-F0-9]{64}$/u;
const taskPattern = /^TASK-\d+$/u;
const maxOutput = 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

class Cancelled extends Error {}

function parseArgs(argv) {
  const args = { apply: false, resume: false };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--apply" || key === "--resume") {
      if (args[key.slice(2)]) fail(`${key} supplied twice`);
      args[key.slice(2)] = true;
    } else if (key === "--project" || key === "--manifest") {
      if (args[key.slice(2)]) fail(`${key} supplied twice`);
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail(`${key} needs a path`);
      args[key.slice(2)] = value;
    } else fail(`Unknown argument: ${key}`);
  }
  if (!args.project || !args.manifest)
    fail(
      "Usage: coordo-investigate.mjs --project DIR --manifest FILE [--apply|--resume]",
    );
  if (args.apply && args.resume) fail("Use either --apply or --resume");
  return args;
}

function exact(value, keys, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  )
    fail(`${label} must contain exactly: ${[...keys].sort().join(", ")}`);
}

function singleLine(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > 1000 ||
    // JSON escapes can produce lone surrogates after UTF-8 decoding; argv
    // encoding would silently replace them with U+FFFD.
    !value.isWellFormed() ||
    /[\x00-\x1f\x7f]/u.test(value)
  )
    fail(
      `${label} must be a nonempty single line of well-formed Unicode of at most 1000 characters`,
    );
  return value;
}

function digest(value, label) {
  if (typeof value !== "string" || !digestPattern.test(value))
    fail(`${label} must be a SHA-256 hex digest`);
  return value.toLowerCase();
}

function name(value, label) {
  if (typeof value !== "string" || !namePattern.test(value))
    fail(`${label} must be a lowercase Coordo agent name`);
  return value;
}

function reportPath(value, label) {
  const path = singleLine(value, label);
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    !path.startsWith(".coordo/runs/rea-findings/")
  )
    fail(`${label} must be a normalized path under .coordo/runs/rea-findings/`);
  if (!path.endsWith(".json")) fail(`${label} must end in .json`);
  return path;
}

function validate(raw) {
  exact(
    raw,
    [
      "schema",
      "from",
      "target_sha256",
      "bundle",
      "tasks",
      "reviewer",
      "max_parallel",
    ],
    "manifest",
  );
  if (raw.schema !== "rea-coordo-investigation/v2")
    fail("Unsupported manifest schema");
  exact(raw.bundle, ["path", "sha256"], "bundle");
  const from = name(raw.from, "from");
  const target = digest(raw.target_sha256, "target_sha256");
  const bundle = {
    path: singleLine(raw.bundle.path, "bundle.path"),
    sha256: digest(raw.bundle.sha256, "bundle.sha256"),
  };
  if (!Array.isArray(raw.tasks) || raw.tasks.length < 2 || raw.tasks.length > 8)
    fail("tasks must contain 2 to 8 independent investigations");
  if (
    !Number.isInteger(raw.max_parallel) ||
    raw.max_parallel < 1 ||
    raw.max_parallel > 4
  )
    fail("max_parallel must be an integer from 1 to 4");
  const tasks = raw.tasks.map((item, index) => {
    const label = `tasks[${index}]`;
    exact(
      item,
      ["to", "question", "scope", "evidence_ids", "report_path"],
      label,
    );
    if (
      !Array.isArray(item.evidence_ids) ||
      item.evidence_ids.length === 0 ||
      item.evidence_ids.some(
        (id) => typeof id !== "string" || !evidencePattern.test(id),
      ) ||
      new Set(item.evidence_ids).size !== item.evidence_ids.length
    )
      fail(`${label}.evidence_ids must contain unique Evidence IDs`);
    return {
      to: name(item.to, `${label}.to`),
      question: singleLine(item.question, `${label}.question`),
      scope: singleLine(item.scope, `${label}.scope`),
      evidence_ids: item.evidence_ids,
      report_path: reportPath(item.report_path, `${label}.report_path`),
    };
  });
  exact(raw.reviewer, ["to", "report_path"], "reviewer");
  const reviewer = {
    to: name(raw.reviewer.to, "reviewer.to"),
    report_path: reportPath(raw.reviewer.report_path, "reviewer.report_path"),
  };
  if (tasks.some((task) => task.to === reviewer.to))
    fail("reviewer.to must be independent of every worker agent");
  const paths = [
    ...tasks.map((task) => task.report_path),
    reviewer.report_path,
  ];
  if (new Set(paths).size !== paths.length)
    fail("report_path values must be unique");
  if (new Set(tasks.flatMap((task) => task.evidence_ids)).size > 256)
    fail(
      "The combined Evidence ID set must contain at most 256 IDs for independent review",
    );
  return {
    from,
    target,
    bundle,
    tasks,
    reviewer,
    maxParallel: raw.max_parallel,
  };
}

function command(bin, args, root) {
  const result = spawnSync(bin, args, {
    cwd: root,
    shell: false,
    encoding: "utf8",
    maxBuffer: maxOutput,
  });
  if (result.error || result.status !== 0)
    fail(
      `${basename(bin)} ${args.slice(0, 2).join(" ")} failed (${result.error?.code ?? result.status ?? "unknown"})`,
    );
  return result.stdout;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function taskDescription(manifest, index, runId) {
  const task = manifest.tasks[index];
  return {
    to: task.to,
    question: `REA run ${runId} worker ${index + 1}. ${task.question}`,
    scope: `${task.scope}. Use only the authorized target operations in the original request; this handoff grants none. Write only your distinct report and Coordo task state.`,
    evidence_ids: task.evidence_ids,
    deliverable: `Write ${task.report_path} as JSON: schema rea-finding/v1; target_sha256, bundle_sha256, task_id, status (answered|partial|unresolved), observations [{claim,evidence_ids}], inferences [{claim,evidence_ids}], unknowns [strings], coverage (string). Use actual Evidence IDs, distinguish observations from inference, then close this task with the report path and limitations.`,
  };
}

function reviewDescription(manifest, runId, taskIds) {
  return {
    to: manifest.reviewer.to,
    question: `REA run ${runId} independent review of ${taskIds.join(", ")}.`,
    scope: `Read the private Evidence bundle and worker reports. Check target identity, supporting Evidence, coverage and conflicting claims. Do not expand target execution authority. Write only your distinct report and Coordo task state.`,
    evidence_ids: [
      ...new Set(manifest.tasks.flatMap((task) => task.evidence_ids)),
    ],
    deliverable: `Write ${manifest.reviewer.report_path} as JSON: schema rea-review/v1; target_sha256, bundle_sha256, task_ids (array), status (accepted|partial|rejected), summary (string), contradictions [strings], unknowns [strings]. Inspect each report and actual Evidence before closing this review task; explain unsupported claims and gaps in your note.`,
  };
}

async function withHandoffManifest(project, manifest, tasks, action) {
  const dir = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "rea-coordo-")),
  );
  const path = join(dir, "manifest.json");
  try {
    const handoff = {
      schema: "rea-coordo-handoff/v1",
      from: manifest.from,
      target_sha256: manifest.target,
      bundle: manifest.bundle,
      tasks,
    };
    await writeFile(path, JSON.stringify(handoff), { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        handoffScript,
        "--project",
        project,
        "--manifest",
        path,
        ...(action === "apply" ? ["--apply"] : []),
      ],
      { cwd: project, shell: false, encoding: "utf8", maxBuffer: maxOutput },
    );
    // The helper is REA's own validator and already withholds Coordo's
    // diagnostics, so its first error line is safe and actionable to relay.
    if (result.error || result.status !== 0)
      fail(
        `Coordo handoff ${action} failed: ${
          result.stderr
            ?.split("\n")[0]
            ?.replace(/^Coordo handoff: /u, "")
            .trim() ||
          (result.error?.code ?? result.status ?? "unknown")
        }`,
      );
    return JSON.parse(result.stdout);
  } finally {
    await unlink(path).catch(() => {});
    await import("node:fs/promises")
      .then(({ rmdir }) => rmdir(dir))
      .catch(() => {});
  }
}

function ledgerSnapshot(project) {
  const parsed = JSON.parse(
    command("coordo", ["mongo", "export", "--as", "codex"], project),
  );
  if (!Array.isArray(parsed.tasks) || !Array.isArray(parsed.resolvedLog))
    fail("Coordo ledger export did not contain tasks and resolvedLog");
  return [...parsed.tasks, ...parsed.resolvedLog];
}

function taskByMarker(project, marker) {
  const matches = ledgerSnapshot(project).filter((item) =>
    item.body?.includes(marker),
  );
  if (matches.length > 1)
    fail(`Multiple Coordo tasks match ${marker}; inspect the ledger`);
  return matches[0] ?? null;
}

function ensureHeadless(project, agents) {
  for (const agent of agents) {
    const output = command(
      "coordo",
      ["dispatch", agent, "REA preflight only", "--dry-run"],
      project,
    );
    if (/handoff \(no headless CLI available\)/u.test(output))
      fail(
        `${agent} has no headless Coordo adapter here; run from a supported agent host or configure a command adapter`,
      );
  }
}

function inside(root, path) {
  const rel = relative(root, resolve(root, path));
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Reports, run state, locks and raw agent logs are private. Check each
// destination itself; an existing ignore file may cover only some of them.
function requireIgnored(project, path) {
  const rel = relative(project, resolve(project, path));
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", rel], {
    cwd: project,
    stdio: "ignore",
    shell: false,
  });
  if (ignored.status !== 0)
    fail(
      `${rel} is not Git ignored; ignore all of .coordo/runs/ before running`,
    );
}

// Report paths are normalized by validation, so the path string identifies
// the destination. A claim stays with its run so no other manifest can write
// the same report, including concurrently.
async function claimReports(claims, runId) {
  const created = [];
  try {
    for (const { claim, path } of claims) {
      try {
        await writeFile(
          claim,
          `${JSON.stringify({ run_id: runId, report_path: path })}\n`,
          { flag: "wx", mode: 0o600 },
        );
        created.push(claim);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = await readFile(claim, "utf8")
          .then((text) => JSON.parse(text).run_id)
          .catch(() => null);
        if (owner !== runId)
          fail(
            `Report path ${path} is reserved by ${owner ? `run ${owner}` : "another run"}; use a distinct report path, or remove ${claim} after confirming that run is finished`,
          );
      }
    }
  } catch (error) {
    await Promise.all(created.map((claim) => unlink(claim).catch(() => {})));
    throw error;
  }
}

async function readReport(project, path, expected, kind) {
  const full = resolve(project, path);
  if (!inside(project, path)) fail(`Report escapes the project: ${path}`);
  const actual = await realpath(full).catch(() =>
    fail(`Missing report: ${path}`),
  );
  if (actual !== full || !(await stat(actual)).isFile())
    fail(`Report is not a regular project file: ${path}`);
  const bytes = await readFile(actual);
  if (bytes.length > maxOutput) fail(`Report exceeds 1 MiB: ${path}`);
  const report = JSON.parse(bytes.toString("utf8"));
  if (
    report.schema !== kind ||
    report.target_sha256 !== expected.target ||
    report.bundle_sha256 !== expected.bundle.sha256
  )
    fail(`Report identity or schema mismatch: ${path}`);
  return report;
}

function checkFinding(report, id) {
  exact(
    report,
    [
      "schema",
      "target_sha256",
      "bundle_sha256",
      "task_id",
      "status",
      "observations",
      "inferences",
      "unknowns",
      "coverage",
    ],
    id,
  );
  if (
    report.task_id !== id ||
    !["answered", "partial", "unresolved"].includes(report.status) ||
    !Array.isArray(report.observations) ||
    !Array.isArray(report.inferences) ||
    !Array.isArray(report.unknowns) ||
    !report.unknowns.every((x) => typeof x === "string") ||
    typeof report.coverage !== "string"
  )
    fail(`Invalid finding fields for ${id}`);
  for (const claim of [...report.observations, ...report.inferences]) {
    exact(claim, ["claim", "evidence_ids"], `${id} claim`);
    if (
      typeof claim.claim !== "string" ||
      !Array.isArray(claim.evidence_ids) ||
      claim.evidence_ids.some(
        (evidenceId) =>
          typeof evidenceId !== "string" || !evidencePattern.test(evidenceId),
      )
    )
      fail(`Invalid evidence reference in ${id}`);
  }
  // An observation is a direct reading of Evidence; it must cite at least one
  // Evidence ID. Whether the cited Evidence proves the claim is the reviewer's.
  if (report.observations.some((claim) => claim.evidence_ids.length === 0))
    fail(`Observation in ${id} cites no Evidence ID`);
  if (report.status === "answered" && report.observations.length === 0)
    fail(`Answered finding ${id} has no observations`);
}

function checkReview(report, ids) {
  exact(
    report,
    [
      "schema",
      "target_sha256",
      "bundle_sha256",
      "task_ids",
      "status",
      "summary",
      "contradictions",
      "unknowns",
    ],
    "review",
  );
  if (
    !Array.isArray(report.task_ids) ||
    new Set(report.task_ids).size !== ids.length ||
    ids.some((id) => !report.task_ids.includes(id)) ||
    !["accepted", "partial", "rejected"].includes(report.status) ||
    typeof report.summary !== "string" ||
    !Array.isArray(report.contradictions) ||
    !report.contradictions.every((v) => typeof v === "string") ||
    !Array.isArray(report.unknowns) ||
    !report.unknowns.every((v) => typeof v === "string")
  )
    fail("Invalid review report fields");
}

async function saveState(path, state) {
  const next = `${path}.${randomUUID()}.next`;
  await writeFile(next, JSON.stringify(state, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(next, path);
}

async function dispatch(project, agent, id, logPath, children) {
  requireIgnored(project, logPath);
  return new Promise((done) => {
    const log = createWriteStream(logPath, { flags: "w", mode: 0o600 });
    const child = spawn("coordo", ["dispatch", agent, id], {
      cwd: project,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let bytes = 0;
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= 5 * maxOutput) log.write(chunk);
      });
    child.on("error", () => {
      children.delete(child);
      log.end();
      done(false);
    });
    child.on("close", (code) => {
      children.delete(child);
      log.end();
      done(code === 0);
    });
  });
}

// A closed task whose report fails validation stays closed and is not
// redispatched; its error is reported instead.
async function validateWorker(project, manifest, entry, index) {
  entry.closed = true;
  try {
    const report = await readReport(
      project,
      manifest.tasks[index].report_path,
      manifest,
      "rea-finding/v1",
    );
    checkFinding(report, entry.id);
    entry.validated = true;
    entry.closed = false;
    delete entry.error;
  } catch (error) {
    entry.error = error.message;
  }
}

async function dispatchWorkers(
  project,
  manifest,
  state,
  statePath,
  children,
  checkpoint,
) {
  // Saved success flags are never trusted across invocations: recheck every
  // worker against the current ledger and its current report file.
  const before = ledgerSnapshot(project);
  for (let index = 0; index < state.workers.length; index++) {
    const entry = state.workers[index];
    entry.validated = false;
    entry.closed = false;
    delete entry.error;
    if (before.find((item) => item.id === entry.id)?.status === "done")
      await validateWorker(project, manifest, entry, index);
  }
  await saveState(statePath, state);
  const pending = state.workers
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => !entry.validated && !entry.closed);
  for (
    let offset = 0;
    offset < pending.length;
    offset += manifest.maxParallel
  ) {
    checkpoint();
    const batch = pending.slice(offset, offset + manifest.maxParallel);
    const results = await Promise.all(
      batch.map(async ({ entry, index }) => {
        if (entry.attempts >= 2)
          return { index, ok: false, reason: "dispatch retry limit reached" };
        entry.attempts++;
        entry.dispatched = true;
        await saveState(statePath, state);
        const logPath = join(
          project,
          ".coordo",
          "runs",
          `rea-${state.runId}-${entry.id}.log`,
        );
        const ok = await dispatch(
          project,
          manifest.tasks[index].to,
          entry.id,
          logPath,
          children,
        );
        return { index, ok, logPath };
      }),
    );
    const ledger = ledgerSnapshot(project);
    for (const result of results) {
      const entry = state.workers[result.index];
      const task = ledger.find((item) => item.id === entry.id);
      if (task?.status !== "done") {
        entry.error =
          result.reason ??
          `Dispatch did not close ${entry.id}; inspect ${result.logPath}`;
        continue;
      }
      await validateWorker(project, manifest, entry, result.index);
    }
    await saveState(statePath, state);
    if (state.workers.some((entry) => entry.error)) break;
  }
}

function summary(outcome, runId, manifest, state, statePath) {
  return `${JSON.stringify(
    {
      outcome,
      run_id: runId,
      workers: state.workers.map((entry, index) => ({
        task_id: entry.id,
        agent: manifest.tasks[index].to,
        report_path: manifest.tasks[index].report_path,
        validated: entry.validated,
        ...(entry.error ? { error: entry.error } : {}),
      })),
      reviewer: {
        task_id: state.reviewer.id,
        agent: manifest.reviewer.to,
        report_path: manifest.reviewer.report_path,
        ...state.reviewer,
      },
      state_path: statePath,
    },
    null,
    2,
  )}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.platform === "win32" && (args.apply || args.resume))
    fail("Automated dispatch currently requires a Unix-like Coordo host");
  const project = await realpath(resolve(args.project));
  const coordination = await lstat(join(project, ".coordo"));
  if (coordination.isSymbolicLink() || !coordination.isDirectory())
    fail("Project needs a regular .coordo directory");
  const manifestBytes = await readFile(resolve(args.manifest));
  if (manifestBytes.length > 256 * 1024) fail("Manifest exceeds 256 KiB");
  let manifestText;
  try {
    manifestText = new TextDecoder("utf-8", { fatal: true }).decode(
      manifestBytes,
    );
  } catch {
    fail("The manifest must contain valid UTF-8");
  }
  const manifest = validate(JSON.parse(manifestText));
  const runId = sha256(manifestBytes).slice(0, 16);
  const descriptions = manifest.tasks.map((_, index) =>
    taskDescription(manifest, index, runId),
  );
  // Render the reviewer handoff before any task exists, with task IDs wider
  // than Coordo allocates, so an oversized review cannot fail after workers.
  const handoffPreview = await withHandoffManifest(
    project,
    manifest,
    [
      ...descriptions,
      reviewDescription(
        manifest,
        runId,
        descriptions.map(() => "TASK-999999999"),
      ),
    ],
    "dry-run",
  );
  ensureHeadless(project, [
    ...new Set([
      ...manifest.tasks.map((task) => task.to),
      manifest.reviewer.to,
    ]),
  ]);
  const runs = join(project, ".coordo", "runs");
  const statePath = join(runs, `rea-${runId}.json`);
  if (!args.apply && !args.resume) {
    process.stdout.write(
      JSON.stringify(
        {
          mode: "dry-run",
          run_id: runId,
          max_parallel: manifest.maxParallel,
          workers: handoffPreview.tasks.slice(0, descriptions.length),
          reviewer: reviewDescription(
            manifest,
            runId,
            descriptions.map((_, i) => `<worker-${i + 1}-id>`),
          ),
          note: "Apply creates tasks, dispatches headless workers, then dispatches the independent reviewer. Workers share this project but have separate report paths.",
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  await mkdir(runs, { recursive: true, mode: 0o700 });
  const runsStats = await lstat(runs);
  if (runsStats.isSymbolicLink() || !runsStats.isDirectory())
    fail(".coordo/runs must be a regular directory");
  await writeFile(join(runs, ".gitignore"), "*\n", {
    flag: "wx",
    mode: 0o600,
  }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const reports = [
    ...manifest.tasks.map((task) => task.report_path),
    manifest.reviewer.report_path,
  ];
  for (const path of reports) {
    if (!inside(project, path)) fail(`Report escapes project: ${path}`);
    let directory = runs;
    for (const part of relative(runs, resolve(project, path, "..")).split(
      sep,
    )) {
      if (!part || part === ".") continue;
      directory = join(directory, part);
      await mkdir(directory, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
      const directoryStats = await lstat(directory);
      if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory())
        fail(
          `Report directory must not be a symlink: ${relative(project, directory)}`,
        );
    }
  }
  const reservations = join(runs, "reservations");
  await mkdir(reservations, { mode: 0o700 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const reservationStats = await lstat(reservations);
  if (reservationStats.isSymbolicLink() || !reservationStats.isDirectory())
    fail(".coordo/runs/reservations must be a regular directory");
  const claims = reports.map((path) => ({
    path,
    claim: join(reservations, `${sha256(path)}.claim`),
  }));
  const lockPath = `${statePath}.lock`;
  // Log names use Coordo task IDs, which exist only after task creation;
  // dispatch rechecks each actual log path before writing it.
  for (const path of [
    ...reports,
    ...claims.map(({ claim }) => claim),
    statePath,
    lockPath,
    `${statePath}.0.next`,
    join(runs, `rea-${runId}-TASK-0.log`),
  ])
    requireIgnored(project, path);
  const lock = await open(lockPath, "wx", 0o600).catch(() =>
    fail(`Run ${runId} is already locked; inspect ${lockPath}`),
  );
  const children = new Set();
  let cancelled = false;
  const killChildren = () => {
    for (const child of children) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
    }
  };
  const stop = () => {
    cancelled = true;
    killChildren();
  };
  const checkpoint = () => {
    if (cancelled) throw new Cancelled("Run cancelled");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let state;
  try {
    if (args.resume) {
      const stateStats = await lstat(statePath);
      if (stateStats.isSymbolicLink() || !stateStats.isFile())
        fail("Run state must be a regular file");
      state = JSON.parse(await readFile(statePath, "utf8"));
      if (
        state.runId !== runId ||
        state.manifestSha256 !== sha256(manifestBytes)
      )
        fail("Run state does not match manifest");
      delete state.cancelled;
      await claimReports(claims, runId);
    } else {
      try {
        await stat(statePath);
        fail(`Run already exists at ${statePath}; use --resume`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const report of reports) {
        try {
          await lstat(resolve(project, report));
          fail(`Report already exists: ${report}`);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      await claimReports(claims, runId);
      state = {
        runId,
        manifestSha256: sha256(manifestBytes),
        workers: descriptions.map(() => ({
          id: null,
          dispatched: false,
          attempts: 0,
          validated: false,
        })),
        reviewer: {
          id: null,
          dispatched: false,
          attempts: 0,
          validated: false,
        },
        pending: null,
      };
      await saveState(statePath, state);
    }
    for (let index = 0; index < descriptions.length; index++) {
      const entry = state.workers[index];
      if (entry.id) continue;
      checkpoint();
      const marker = `REA run ${runId} worker ${index + 1}.`;
      const existing = taskByMarker(project, marker);
      if (existing) entry.id = existing.id;
      else {
        state.pending = marker;
        await saveState(statePath, state);
        const result = await withHandoffManifest(
          project,
          manifest,
          [descriptions[index]],
          "apply",
        );
        const id = result.created?.[0]?.task_id;
        if (!taskPattern.test(id ?? ""))
          fail(`Coordo did not return a task ID for ${marker}`);
        entry.id = id;
      }
      state.pending = null;
      await saveState(statePath, state);
    }
    await dispatchWorkers(
      project,
      manifest,
      state,
      statePath,
      children,
      checkpoint,
    );
    checkpoint();
    if (state.workers.some((entry) => !entry.validated)) {
      process.stdout.write(
        summary("partial", runId, manifest, state, statePath),
      );
      process.exitCode = 4;
      return;
    }
    const ids = state.workers.map((entry) => entry.id);
    const review = reviewDescription(manifest, runId, ids);
    if (!state.reviewer.id) {
      const existing = taskByMarker(
        project,
        `REA run ${runId} independent review`,
      );
      if (existing) state.reviewer.id = existing.id;
      else {
        state.pending = "review";
        await saveState(statePath, state);
        const result = await withHandoffManifest(
          project,
          manifest,
          [review],
          "apply",
        );
        const id = result.created?.[0]?.task_id;
        if (!taskPattern.test(id ?? ""))
          fail("Coordo did not return a review task ID");
        state.reviewer.id = id;
      }
      state.pending = null;
      await saveState(statePath, state);
    }
    // Like worker results, a saved review result is rechecked on every run.
    state.reviewer.validated = false;
    delete state.reviewer.status;
    delete state.reviewer.error;
    let reviewTaskDone =
      ledgerSnapshot(project).find((item) => item.id === state.reviewer.id)
        ?.status === "done";
    if (!reviewTaskDone) {
      if (state.reviewer.attempts >= 2)
        state.reviewer.error = "Review dispatch retry limit reached";
      else {
        checkpoint();
        state.reviewer.dispatched = true;
        state.reviewer.attempts++;
        await saveState(statePath, state);
        const logPath = join(runs, `rea-${runId}-${state.reviewer.id}.log`);
        const ok = await dispatch(
          project,
          manifest.reviewer.to,
          state.reviewer.id,
          logPath,
          children,
        );
        reviewTaskDone =
          ledgerSnapshot(project).find((item) => item.id === state.reviewer.id)
            ?.status === "done";
        if (!ok || !reviewTaskDone)
          state.reviewer.error = `Review dispatch did not close ${state.reviewer.id}; inspect ${logPath}`;
        checkpoint();
      }
    }
    if (reviewTaskDone) {
      try {
        const report = await readReport(
          project,
          manifest.reviewer.report_path,
          manifest,
          "rea-review/v1",
        );
        checkReview(report, ids);
        state.reviewer.validated = true;
        state.reviewer.status = report.status;
        delete state.reviewer.error;
      } catch (error) {
        state.reviewer.error = error.message;
      }
    }
    await saveState(statePath, state);
    const outcome =
      state.reviewer.validated && state.reviewer.status === "accepted"
        ? "complete"
        : "partial";
    process.stdout.write(summary(outcome, runId, manifest, state, statePath));
    if (outcome !== "complete") process.exitCode = 4;
  } catch (error) {
    if (!(error instanceof Cancelled) || !state) throw error;
    // Stopped by the user: record what exists and start nothing further.
    state.cancelled = true;
    await saveState(statePath, state);
    process.stdout.write(
      summary("cancelled", runId, manifest, state, statePath),
    );
    process.exitCode = 130;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    killChildren();
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

main().catch((error) => {
  process.stderr.write(`REA Coordo investigation: ${error.message}\n`);
  process.exitCode = 1;
});
