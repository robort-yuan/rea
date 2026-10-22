# Coordinated multi-agent investigations

Use this workflow when the user asks Coordo to run several independent REA
investigations and have a separate agent review their findings. It creates
evidence-linked tasks, dispatches workers concurrently up to a caller-selected
limit, validates their report identity and shape, then dispatches the reviewer.
It returns a machine-readable run summary so the lead can report completion,
partial work, or unresolved findings without relaying each prompt by hand.

REA remains responsible for analysis and Evidence. Coordo owns task assignment,
dispatch and recorded completion. The script does not open a target, invoke an
REA analysis tool, or grant runtime authority. Worker and reviewer CLIs run in
the selected project with the permissions and limits configured in
`.coordo/lead.json`; their task scope must match the user's original
authorization. Coordo adapters do not sandbox the agents as a group, so the
project and its agent configuration must be trusted.

## Prepare the investigation

1. Identify the exact target bytes and finish the required REA analysis. Export
   the complete Evidence bundle to a project-local path ignored by Git. Record
   its target and bundle SHA-256 values and supporting Evidence IDs.
2. Split the question into two to eight independent scopes. Give every worker
   a unique JSON report path under `.coordo/runs/rea-findings/`; paths, reports,
   dispatch logs and run state stay local and ignored.
3. Select a reviewer agent that is different from every worker. The reviewer
   reads the same bundle and all worker reports, checks claims against Evidence,
   and records contradictions and unknowns.
4. Confirm `.coordo/lead.json` configures headless adapters for each worker and
   reviewer. The runner checks this with Coordo dry runs and stops before task
   creation when an adapter would fall back to a manual handoff. In particular,
   Antigravity's headless adapter is only available from a supported
   Antigravity terminal.

Use a manifest with this shape, replacing every example value:

```json
{
  "schema": "rea-coordo-investigation/v2",
  "from": "codex",
  "target_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "bundle": {
    "path": ".private/rea-evidence.json",
    "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "max_parallel": 2,
  "tasks": [
    {
      "to": "claude",
      "question": "Trace the selected feature from its entry point to the native call",
      "scope": "Static inspection of the supplied Evidence only",
      "evidence_ids": ["ev_example_one"],
      "report_path": ".coordo/runs/rea-findings/entry-trace.json"
    },
    {
      "to": "antigravity",
      "question": "Independently inspect the packaged resources related to the feature",
      "scope": "Static inspection of the supplied Evidence only",
      "evidence_ids": ["ev_example_two"],
      "report_path": ".coordo/runs/rea-findings/resource-check.json"
    }
  ],
  "reviewer": {
    "to": "codex",
    "report_path": ".coordo/runs/rea-findings/review.json"
  }
}
```

## Preview and run

Preview validates the manifest, bundle digest, Git ignore state, report paths,
and headless adapter availability. It also renders the reviewer handoff, so a
review whose combined Evidence IDs exceed the task text limit fails here rather
than after the workers run. It creates no Coordo tasks and starts no agents:

```bash
node .agents/skills/reverse-engineer-anything/scripts/coordo-investigate.mjs \
  --project /absolute/path/to/project \
  --manifest /absolute/path/to/investigation.json
```

Use the installed skill directory in place of `.agents/skills/...` when the
skill is not present in the project. Review the task text, agent identities,
scope and distinct report destinations. `--apply` is the explicit step that
creates Coordo tasks and starts headless agent processes:

```bash
node .agents/skills/reverse-engineer-anything/scripts/coordo-investigate.mjs \
  --project /absolute/path/to/project \
  --manifest /absolute/path/to/investigation.json \
  --apply
```

Before writing anything, `--apply` and `--resume` check that every output is
ignored by Git: reports, run state, the run lock, report reservations and raw
agent logs under `.coordo/runs/`. The runner creates `.coordo/runs/.gitignore`
with `*` when it is absent, but never rewrites an existing one; if that file or
the project's rules cover only part of the directory, the run stops before
creating tasks. Each report path is reserved for its run in
`.coordo/runs/reservations/`, so another manifest cannot write the same report,
even concurrently. Reservations stay with their run; to reuse a path with a
different manifest, confirm the earlier run is finished and remove its
reservation, or choose a new report path.

Workers run concurrently up to `max_parallel` (one to four). They share the
selected project and local Evidence bundle, so assign read-only analysis scopes
and unique report paths. The reviewer starts only after every worker task is
closed and its report passes structural and identity checks. Each report binds
the target digest, bundle digest and Coordo task ID. Findings use separate
observation and inference lists, and include coverage and unknowns. Every
observation must cite at least one Evidence ID.

The script checks report structure and identity, not whether the analysis is
true or whether every cited Evidence ID belongs to the bundle. The independent
reviewer is responsible for checking claims against the actual Evidence and
recording gaps; the lead reconciles its report before presenting conclusions.
An `accepted` reviewer report yields `complete`. `partial` and `rejected`
reviews, missing reports, open tasks, or failed dispatches yield a nonzero
partial result with the task IDs, log paths and ignored run-state file.

Resume a partial run with the same unchanged manifest:

```bash
node .agents/skills/reverse-engineer-anything/scripts/coordo-investigate.mjs \
  --project /absolute/path/to/project \
  --manifest /absolute/path/to/investigation.json \
  --resume
```

The run state prevents duplicate tasks and allows one dispatch retry for an
open task. Resume does not trust saved results: it rechecks every task against
the current ledger and every report file, so a report removed or changed since
the last run turns a previous `complete` into `partial`.

`SIGINT` or `SIGTERM` stops the running agents, starts no further task or
dispatch, saves the run state and prints a `cancelled` summary with exit code
130; resume it with the same manifest. If a process is killed forcefully, its
run lock remains; check
that no agent process is still active before removing the stale lock and
resuming. If an agent closes a task without producing a valid report, preserve
that task and report the gap rather than treating the investigation as
complete.

Coordo task text may be stored in a remote backend. Do not put private Evidence,
credentials, sensitive paths or proprietary target content into the manifest:
the bundle itself is never transmitted by this workflow. Agents on another
machine need a separate authorized way to access the same Evidence bytes. This
runner requires a Unix-like host and a directly executable Coordo CLI; Windows
command shims are not supported.
