import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { execFileOutput } from "../ExecFileOutput.js";

/** One PTY root held in a Windows job that dies with its descendants. */
export interface WindowsPtyJob {
  readonly pid: number;
  active(): Promise<number>;
  terminate(): Promise<void>;
  close(): Promise<void>;
}

interface JobReply {
  readonly ok: boolean;
  readonly active?: number;
  readonly alreadyExited?: boolean;
  readonly message?: string;
}

const jobs = new Map<number, WindowsPtyJob>();
const helperSource = fileURLToPath(
  new URL("../../../bridge/windows/ReaWindowsJob.cs", import.meta.url),
);
const compiler = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe",
);

let helperExecutable: Promise<string> | undefined;

const compileHelper = (): Promise<string> => {
  helperExecutable ??= (async () => {
    const directory = join(tmpdir(), "rea-windows-job");
    await mkdir(directory, { recursive: true });
    const executable = join(directory, "ReaWindowsJob.exe");
    if (!existsSync(compiler))
      throw new Error(
        `Windows descendant cleanup requires csc.exe at ${compiler}`,
      );
    await execFileOutput(
      compiler,
      [
        "/nologo",
        "/platform:x64",
        "/target:exe",
        `/out:${executable}`,
        helperSource,
      ],
      { timeout: 60_000 },
    );
    return executable;
  })();
  return helperExecutable;
};

type JobHelper = ChildProcessByStdio<Writable, Readable, null>;

class HeldJob implements WindowsPtyJob {
  readonly pid: number;
  #child: JobHelper;
  #queue: Promise<void> = Promise.resolve();
  #waiters: Array<(reply: JobReply) => void> = [];
  #closed = false;

  constructor(child: JobHelper, pid: number) {
    this.#child = child;
    this.pid = pid;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) return;
      try {
        waiter(JSON.parse(line) as JobReply);
      } catch (cause: unknown) {
        waiter({
          ok: false,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
    child.on("exit", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0))
        waiter({ ok: false, message: "Windows job helper exited" });
    });
  }

  adopt(): Promise<void> {
    return this.#request({ op: "adopt", pid: this.pid }).then(() => undefined);
  }

  active(): Promise<number> {
    return this.#request({ op: "active" }).then((reply) => reply.active ?? 0);
  }

  async terminate(): Promise<void> {
    await this.#request({ op: "terminate" });
  }

  async close(): Promise<void> {
    jobs.delete(this.pid);
    if (this.#closed) return;
    try {
      await this.#request({ op: "close" });
    } catch {
      this.#child.kill();
    }
  }

  #request(body: {
    readonly op: string;
    readonly pid?: number;
  }): Promise<JobReply> {
    const run = this.#queue.then(
      () =>
        new Promise<JobReply>((resolve, reject) => {
          if (this.#closed) {
            reject(new Error("Windows job helper is closed"));
            return;
          }
          const timer = setTimeout(() => {
            reject(new Error(`Windows job helper timed out during ${body.op}`));
          }, 5_000);
          this.#waiters.push((reply) => {
            clearTimeout(timer);
            if (!reply.ok)
              reject(
                new Error(reply.message ?? `Windows job ${body.op} failed`),
              );
            else resolve(reply);
          });
          this.#child.stdin.write(`${JSON.stringify(body)}\n`);
        }),
    );
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Place an already-running PTY root into a kill-on-close job. */
export const adoptPtyRoot = async (pid: number): Promise<WindowsPtyJob> => {
  const existing = jobs.get(pid);
  if (existing !== undefined) return existing;
  const executable = await compileHelper();
  const child = spawn(executable, [], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const job = new HeldJob(child, pid);
  try {
    await job.adopt();
  } catch (cause: unknown) {
    child.kill();
    throw cause;
  }
  jobs.set(pid, job);
  return job;
};

/** Return the job adopted for this PTY root, when capture placed it in one. */
export const lookupWindowsJob = (pid: number): WindowsPtyJob | undefined =>
  jobs.get(pid);

/**
 * Prove a descendant created after job membership dies with the root.
 * The PTY module is loaded only after this check is asked to run.
 */
export const verifyWindowsDescendantCleanup = async (
  loadPty: () => Promise<typeof import("@lydell/node-pty")> = () =>
    import("@lydell/node-pty"),
): Promise<void> => {
  const { spawn: spawnPty } = await loadPty();
  const terminal = spawnPty("cmd.exe", ["/k"], {
    cwd: tmpdir(),
    cols: 80,
    rows: 24,
    name: "xterm-256color",
  });
  let job: WindowsPtyJob | undefined;
  try {
    job = await adoptPtyRoot(terminal.pid);
    terminal.write("ping -n 30 127.0.0.1 >nul\r\n");
    let active = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      active = await job.active();
      if (active >= 2) break;
      await delay(100);
    }
    if (active < 2)
      throw new Error(
        `Windows job did not contain the PTY descendant (active=${String(active)})`,
      );
    await job.terminate();
    const deadline = Date.now() + 2_000;
    while (active > 0 && Date.now() < deadline) {
      await delay(50);
      active = await job.active();
    }
    if (active !== 0)
      throw new Error(
        `Windows job left ${String(active)} process(es) alive after termination`,
      );
  } finally {
    await job?.close().catch(() => undefined);
    try {
      terminal.kill();
    } catch {
      // The job already ended the PTY root.
    }
  }
};
