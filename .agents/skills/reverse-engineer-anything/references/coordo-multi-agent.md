# Coordo handoffs for multi-agent investigations

Use this workflow only when the user wants several agents to work on one
reverse-engineering investigation and the selected project already uses Coordo.
Coordo owns task assignment and completion; REA owns analysis and Evidence.
The optional helper in `../scripts/coordo-handoff.mjs` creates tasks in the
project's configured Coordo backend. It never launches an agent, opens a target,
or runs a REA tool.

## Prepare a handoff

1. Identify the exact target bytes and question. Record the target SHA-256; do
   not substitute a filename, application title, or current process name for
   byte identity.
2. Finish the relevant REA analysis and export the complete Evidence bundle
   before closing its session. Put the bundle in a project-local path ignored by
   Git. A Coordo ledger may be committed or published, so do not paste raw
   Evidence, credentials, private target content, or sensitive paths into it.
3. Split work by independent question and give each agent one bounded scope,
   supporting Evidence IDs, and a deliverable. Name the authority for any
   runtime operation separately; a handoff task does not grant new target
   execution or mutation authority. Assign a separate review task when the
   conclusion needs independent checking.
4. Write a small manifest outside the bundle. All fields are caller-authored;
   the helper checks its shape and the bundle bytes, but it does not verify that
   the listed Evidence IDs belong to that bundle. Recipients must inspect the
   bundle and its coverage before using those IDs.

Example manifest (replace every illustrative value before use):

```json
{
  "schema": "rea-coordo-handoff/v1",
  "from": "codex",
  "target_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "bundle": {
    "path": ".private/rea-evidence.json",
    "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "tasks": [
    {
      "to": "claude",
      "question": "Trace the selected feature from its entry point to the native call",
      "scope": "Static inspection of the supplied Evidence only",
      "evidence_ids": ["replace-with-real-evidence-id"],
      "deliverable": "A finding with source locations, coverage, and unknowns"
    },
    {
      "to": "antigravity",
      "question": "Review the feature trace against the packaged resources",
      "scope": "Static inspection of the supplied Evidence only",
      "evidence_ids": ["replace-with-real-evidence-id"],
      "deliverable": "Independent corroboration or a named evidence gap"
    }
  ]
}
```

## Review and create tasks

Run the dry view first. It validates that the bundle is a regular file inside
the selected project, that Git ignores it, and that its SHA-256 matches the
manifest. Task text names the bundle by the path the manifest selected, even
when that path is a symlink. Each task may list at most 256 Evidence IDs and
must render to at most 32 KiB of text; split larger handoffs. The output shows
the exact task text that would enter Coordo:

```bash
node /absolute/path/to/reverse-engineer-anything/scripts/coordo-handoff.mjs \
  --project /absolute/path/to/project \
  --manifest /absolute/path/to/handoff.json
```

The example uses the workspace-installed skill. If it is not present in the
project, use the helper inside the installed skill directory instead.

Manifests must be valid UTF-8. Coordo agent names are limited to 64 bytes.
Bundles inside nested Git repositories are rejected, even if the outer project
ignores their paths; the bundle must be ignored and untracked in the repository
that owns the selected bytes.

After reviewing the task text and destination agents, add `--apply` to create
the tasks. The helper calls `coordo task add` sequentially using argument arrays
and the selected project directory. It uses Coordo's configured backend; it
does not edit `.coordo/ledger.md` directly. A partially completed run is
reported with the created task IDs. Inspect `coordo task list` before retrying
so a second run does not create duplicates.
`--apply` currently requires a directly executable `coordo` command on a
Unix-like host; Windows command shims are not supported by this helper.

Recipients use the project and bundle path from their task, validate the
bundle's content and target identity, then work only within their assigned
scope. Each records Evidence IDs, observed versus inferred claims, coverage,
and unresolved unknowns in the deliverable. Close a Coordo task only after
that deliverable is present; an agent process exit or chat message is not proof
of completion. The lead reconciles results and any contradictions against the
original investigation question.

The helper's `--apply` changes coordination state and may contact a configured
remote Coordo backend. It does not transmit Evidence through Coordo; the bundle
stays at the caller-selected ignored local path. Agents on another machine need
an independently arranged, authorized way to access those same bytes.
