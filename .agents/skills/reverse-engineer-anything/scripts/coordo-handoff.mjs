#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const schema = "rea-coordo-handoff/v1";
const digestPattern = /^[a-fA-F0-9]{64}$/u;
const agentPattern = /^[a-z][a-z0-9_-]*$/u;
const evidenceIdPattern = /^[A-Za-z0-9._:-]{1,200}$/u;
// Each task description is one argv element. Linux rejects a single argument
// over 128 KiB (MAX_ARG_STRLEN), so stay well below it on every platform.
const maxDescriptionBytes = 32 * 1024;
const maxEvidenceIdsPerTask = 256;

const fail = (message) => {
  throw new Error(message);
};

function options(arguments_) {
  const selected = { apply: false };
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === "--apply") {
      if (selected.apply) fail("--apply was supplied twice");
      selected.apply = true;
      continue;
    }
    if (argument !== "--project" && argument !== "--manifest")
      fail(`Unknown argument: ${argument}`);
    if (selected[argument] !== undefined)
      fail(`${argument} was supplied twice`);
    const value = arguments_[++index];
    if (!value || value.startsWith("--")) fail(`${argument} needs a path`);
    selected[argument] = value;
  }
  if (!selected["--project"] || !selected["--manifest"])
    fail("Usage: coordo-handoff.mjs --project DIR --manifest FILE [--apply]");
  return selected;
}

function exactKeys(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${name} must contain exactly: ${expected.join(", ")}`);
}

function line(value, name) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 2000 ||
    // JSON escapes can produce lone surrogates after UTF-8 decoding; argv
    // encoding would silently replace them with U+FFFD.
    !value.isWellFormed() ||
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return code < 32 || code === 127;
    })
  )
    fail(
      `${name} must be a nonempty single line of well-formed Unicode of at most 2000 characters`,
    );
  return value;
}

function digest(value, name) {
  if (typeof value !== "string" || !digestPattern.test(value))
    fail(`${name} must be a 64-character SHA-256 hex digest`);
  return value.toLowerCase();
}

function agent(value, name) {
  if (
    typeof value !== "string" ||
    !agentPattern.test(value) ||
    Buffer.byteLength(value, "utf8") > 64
  )
    fail(`${name} must be a lowercase Coordo agent name of at most 64 bytes`);
  return value;
}

function validate(manifest) {
  exactKeys(
    manifest,
    ["schema", "from", "target_sha256", "bundle", "tasks"],
    "manifest",
  );
  if (manifest.schema !== schema)
    fail(`Unsupported manifest schema: ${String(manifest.schema)}`);
  exactKeys(manifest.bundle, ["path", "sha256"], "bundle");
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0)
    fail("tasks must be a nonempty array");
  const from = agent(manifest.from, "from");
  const targetSha256 = digest(manifest.target_sha256, "target_sha256");
  const bundlePath = line(manifest.bundle.path, "bundle.path");
  if (isAbsolute(bundlePath))
    fail("bundle.path must be relative to the Coordo project");
  const bundleSha256 = digest(manifest.bundle.sha256, "bundle.sha256");
  const tasks = manifest.tasks.map((task, index) => {
    const name = `tasks[${index}]`;
    exactKeys(
      task,
      ["to", "question", "scope", "evidence_ids", "deliverable"],
      name,
    );
    if (!Array.isArray(task.evidence_ids) || task.evidence_ids.length === 0)
      fail(`${name}.evidence_ids must be a nonempty array`);
    if (task.evidence_ids.length > maxEvidenceIdsPerTask)
      fail(
        `${name}.evidence_ids may contain at most ${maxEvidenceIdsPerTask} IDs; split the task`,
      );
    const evidenceIds = task.evidence_ids.map((id) => {
      if (typeof id !== "string" || !evidenceIdPattern.test(id))
        fail(`${name}.evidence_ids contains an invalid ID`);
      return id;
    });
    if (new Set(evidenceIds).size !== evidenceIds.length)
      fail(`${name}.evidence_ids contains a duplicate ID`);
    return {
      to: agent(task.to, `${name}.to`),
      question: line(task.question, `${name}.question`),
      scope: line(task.scope, `${name}.scope`),
      evidenceIds,
      deliverable: line(task.deliverable, `${name}.deliverable`),
    };
  });
  return { from, targetSha256, bundlePath, bundleSha256, tasks };
}

async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, arguments_, root) {
  const result = spawnSync(command, arguments_, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Child diagnostics are untrusted: remote backends may include transport
    // headers or credentials. Report the exit state without echoing them.
    fail(
      `${command} failed (${result.error?.code ?? result.status ?? "unknown"})`,
    );
  }
  return result.stdout;
}

function insideProject(path) {
  return !(
    path === "" ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  );
}

function git(arguments_, root) {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    stdio: "ignore",
    shell: false,
  });
  if (result.error) fail(`git is unavailable (${result.error.code})`);
  return result.status;
}

// Returns the caller-selected project-relative path. The canonical target is
// used only for containment, Git checks, and hashing; it never enters task text.
async function validateBundle(root, manifest) {
  const selected = relative(root, resolve(root, manifest.bundlePath));
  if (!insideProject(selected))
    fail("The Evidence bundle must be inside the selected project");
  const path = await realpath(resolve(root, selected));
  const canonical = relative(root, path);
  if (!insideProject(canonical))
    fail("The Evidence bundle must be inside the selected project");
  if (!(await stat(path)).isFile())
    fail("The Evidence bundle must be a regular file");
  const owner = spawnSync(
    "git",
    ["-C", resolve(path, ".."), "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
      shell: false,
      maxBuffer: 4096,
    },
  );
  if (owner.error || owner.status !== 0)
    fail("Could not determine which Git repository owns the Evidence bundle");
  const project = spawnSync(
    "git",
    ["-C", root, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
      shell: false,
      maxBuffer: 4096,
    },
  );
  if (project.error || project.status !== 0)
    fail("Could not determine which Git repository owns the selected project");
  const ownerRoot = await realpath(owner.stdout.trim());
  const projectRoot = await realpath(project.stdout.trim());
  if (ownerRoot !== projectRoot)
    fail(
      "The Evidence bundle is inside a nested Git repository; select a bundle owned by the Coordo project",
    );
  // Git checks apply to where the bytes live; Git rejects paths that pass
  // through a symlinked directory, so the selected path cannot be used here.
  const tracked = git(["ls-files", "--error-unmatch", "--", canonical], root);
  if (tracked !== 0 && tracked !== 1)
    fail("Could not determine whether the Evidence bundle is tracked by Git");
  if (tracked === 0) fail("The Evidence bundle is tracked by Git");
  if (git(["check-ignore", "-q", "--", canonical], root) !== 0)
    fail(
      "The Evidence bundle must be ignored by Git in a valid project repository",
    );
  if ((await fileSha256(path)) !== manifest.bundleSha256)
    fail("The Evidence bundle SHA-256 does not match the manifest");
  return selected.split(sep).join("/");
}

// End each field as one sentence without doubling the caller's punctuation.
const sentence = (value) => (/[.!?]$/u.test(value) ? value : `${value}.`);

async function main() {
  const args = options(process.argv.slice(2));
  const root = await realpath(resolve(args["--project"]));
  const coordination = await stat(resolve(root, ".coordo")).catch(() => null);
  if (!coordination?.isDirectory())
    fail("The selected project has no .coordo directory");
  const manifestPath = resolve(args["--manifest"]);
  const manifestStats = await stat(manifestPath);
  if (!manifestStats.isFile() || manifestStats.size > 256 * 1024)
    fail("The manifest must be a regular JSON file of at most 256 KiB");
  const manifestBytes = await readFile(manifestPath);
  let manifestText;
  try {
    manifestText = new TextDecoder("utf-8", { fatal: true }).decode(
      manifestBytes,
    );
  } catch {
    fail("The manifest must contain valid UTF-8");
  }
  const manifest = validate(JSON.parse(manifestText));
  const bundleRelative = await validateBundle(root, manifest);
  const planned = manifest.tasks.map((task, index) => {
    const description = [
      `REA target SHA-256: ${manifest.targetSha256}.`,
      `Evidence bundle: ${bundleRelative} (SHA-256 ${manifest.bundleSha256}).`,
      `Supporting Evidence IDs: ${task.evidenceIds.join(", ")}.`,
      `Question: ${sentence(task.question)}`,
      `Scope: ${sentence(task.scope)}`,
      `Deliverable: ${sentence(task.deliverable)}`,
      "Report observations, inferences, coverage, and unresolved unknowns; the task does not grant additional target execution authority.",
    ].join(" ");
    if (Buffer.byteLength(description, "utf8") > maxDescriptionBytes)
      fail(
        `tasks[${index}] renders to more than ${maxDescriptionBytes} bytes of task text; shorten it or split the task`,
      );
    return { to: task.to, description };
  });
  if (!args.apply) {
    process.stdout.write(
      `${JSON.stringify({ mode: "dry-run", tasks: planned }, null, 2)}\n`,
    );
    return;
  }
  if (process.platform === "win32")
    fail(
      "--apply requires a directly executable Coordo CLI; Windows command shims are not supported",
    );
  const created = [];
  for (const task of planned) {
    try {
      const output = run(
        "coordo",
        [
          "task",
          "add",
          task.description,
          "--from",
          manifest.from,
          "--to",
          task.to,
          "--as",
          manifest.from,
        ],
        root,
      );
      created.push({
        to: task.to,
        task_id: output.match(/TASK-\d+/u)?.[0] ?? null,
      });
    } catch (error) {
      fail(
        `${error.message}; created before failure: ${JSON.stringify(created)}`,
      );
    }
  }
  process.stdout.write(
    `${JSON.stringify({ mode: "applied", created }, null, 2)}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Coordo handoff: ${error.message}\n`);
  process.exitCode = 1;
});
