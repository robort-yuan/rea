// A minimal Coordo stand-in for coordinator tests. Each task is one file and
// each closure one marker, so concurrent dispatches never share a write.
// FAKE_COORDO_BEHAVIOR maps an agent to: ok, no-evidence, no-close, hang.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const home = dirname(fileURLToPath(import.meta.url));
const tasks = join(home, "tasks");
const done = join(home, "done");
mkdirSync(tasks, { recursive: true });
mkdirSync(done, { recursive: true });
const record = (line) =>
  appendFileSync(join(home, "calls.log"), `${line} ${Date.now()}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = process.argv.slice(2);

if (args[0] === "task" && args[1] === "add") {
  const id = `TASK-${String(readdirSync(tasks).length + 1).padStart(3, "0")}`;
  writeFileSync(
    join(tasks, `${id}.json`),
    JSON.stringify({ id, to: args[args.indexOf("--to") + 1], body: args[2] }),
  );
  record(`add ${id}`);
  process.stdout.write(`Allocated ${id} for new task.\n`);
} else if (args[0] === "mongo" && args[1] === "export") {
  const all = readdirSync(tasks).map((name) => {
    const task = JSON.parse(readFileSync(join(tasks, name), "utf8"));
    return {
      ...task,
      status: existsSync(join(done, task.id)) ? "done" : "open",
    };
  });
  process.stdout.write(JSON.stringify({ tasks: all, resolvedLog: [] }));
} else if (args[0] === "dispatch" && args.includes("--dry-run")) {
  process.stdout.write(`dispatch ${args[1]} (headless)\n`);
} else if (args[0] === "dispatch") {
  const [, agent, id] = args;
  const behavior =
    JSON.parse(process.env.FAKE_COORDO_BEHAVIOR ?? "{}")[agent] ?? "ok";
  record(`start ${id}`);
  await sleep(
    behavior === "hang"
      ? 30_000
      : Number(process.env.FAKE_COORDO_DELAY_MS ?? 20),
  );
  if (behavior !== "no-close") {
    const { body } = JSON.parse(
      readFileSync(join(tasks, `${id}.json`), "utf8"),
    );
    const [, path, schema] =
      /Write (\S+) as JSON: schema (rea-[a-z]+\/v1)/u.exec(body);
    const identity = {
      schema,
      target_sha256: /REA target SHA-256: ([0-9a-f]{64})/u.exec(body)[1],
      bundle_sha256: /\(SHA-256 ([0-9a-f]{64})\)/u.exec(body)[1],
    };
    const report =
      schema === "rea-review/v1"
        ? {
            ...identity,
            task_ids: /independent review of (.+?)\./u
              .exec(body)[1]
              .split(", "),
            status: "accepted",
            summary: "Claims match the cited Evidence.",
            contradictions: [],
            unknowns: [],
          }
        : {
            ...identity,
            task_id: id,
            status: "answered",
            observations: [
              {
                claim: "The entry point reaches the native call.",
                evidence_ids: behavior === "no-evidence" ? [] : ["evidence-1"],
              },
            ],
            inferences: [],
            unknowns: [],
            coverage: "Static Evidence only.",
          };
    writeFileSync(path, JSON.stringify(report));
    writeFileSync(join(done, id), "");
  }
  record(`end ${id}`);
} else {
  process.stderr.write(`fake coordo: unsupported ${args.join(" ")}\n`);
  process.exitCode = 2;
}
