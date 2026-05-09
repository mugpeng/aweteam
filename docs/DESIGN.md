# aweteam Design Notes

This document describes the stable runtime and design constraints behind
`aweteam`.

It is not a quickstart and not a contributor workflow guide. Use:

- `README.md` for installation and user-facing command usage
- `docs/CONTRIBUTING.md` for local development, testing, and contribution rules

## Project Direction

`aweteam` is intentionally centered on a small set of responsibilities:

- start one real leader CLI in tmux
- let that leader create worker panes from a configured worker pool
- preserve visible leader and worker conversations in tmux
- write explicit filesystem artifacts for handoff, status, and debugging

New features should make that handoff clearer, safer, or easier to inspect.
They should not turn `aweteam` into a hidden scheduler, standalone TUI, hosted
agent platform, planning framework, or replacement for the underlying agent
CLIs.

## Runtime Model

Each run creates a tmux session named `aweteam-<run-id>`.

The session contains:

- a `leader/main` pane running the configured leader CLI
- zero or more worker panes created from configured worker profiles
- an internal dispatcher window that watches the leader outbox

The user normally interacts with the leader pane. Workers are still real
interactive agent panes, so their conversations can be inspected and continued
directly in tmux.

## Leader Model

The leader is coordinator-only.

The leader should:

- understand the user's request
- choose workers only from the configured worker pool
- split assignments into explicit worker tasks
- monitor worker completion notices
- synthesize the final answer in the leader pane

The leader should not execute delegated work itself. For Claude Code leaders,
`aweteam` disables native `Task` delegation and injects instructions that
"agent" means an aweteam tmux worker pane.

## Command Model

Primary user entrypoints:

- `aweteam --config aweteam.json`
- `aweteam run "task" --config aweteam.json`

Inspection commands:

- `aweteam status <run-id>`
- `aweteam status <run-id> --watch`
- `aweteam focus <run-id> <leader|worker-name|profile>`

Low-level runtime or debugging commands:

- `aweteam spawn --run-id <run-id> --profile <name> --task-file <path>`
- `aweteam dispatch <run-id> [--once]`
- `aweteam summarize <run-id>`
- `aweteam collect-summary <run-id>`

Normal worker creation should happen through the leader pane. The lower-level
commands exist so the runtime can be inspected and debugged without hiding the
handoff protocol.

## Config Model

`aweteam` reads JSON config only.

Required top-level fields:

- `leader`: the selected leader profile name
- `workers`: the default worker pool
- `profiles`: named provider profiles

Only profiles listed in `workers` may be spawned as workers. `spawnWorker`
validates this at runtime and also enforces each worker profile's
`max_instances` limit.

Profile fields:

- `provider`: known values include `claude`, `codex`, or `custom`
- `command`: the local CLI command to run
- `model`: provider model name when supported
- `env`: environment values or `${ENV_NAME}` references
- `max_instances`: worker-only concurrency limit for that profile

A run freezes its resolved config into:

```text
.aweteam/runs/<run-id>/config.resolved.json
```

Later edits to `aweteam.json` do not mutate an existing run.

## Handoff Protocol

The filesystem is the local handoff protocol.

Important paths:

```text
.aweteam/runs/<run-id>/
  config.resolved.json
  run.json
  status.json
  events.jsonl
  leader/
    instructions.md
    outbox/
    inbox/
    tasks/
    summary-input.md
    summary.md
  workers/
    worker-1/
      profile.json
      task.md
      result.md
      status.json
      stdout.log
      stderr.log
```

To request a worker, the leader writes one JSON file under:

```text
.aweteam/runs/<run-id>/leader/outbox/<request-id>.json
```

Request shape:

```json
{
  "profile": "<profile-name>",
  "task": "Exact assignment for this worker."
}
```

The dispatcher validates the request, writes the worker task file, creates a
worker pane, writes a creation receipt under `leader/inbox/`, and appends an
event to `events.jsonl`.

Final worker answers belong in each worker's `result.md`. `leader/inbox/` is for
creation receipts and errors, not final worker content.

## Provider Semantics

Provider command construction is part of the runtime contract.

Claude leaders:

- receive leader instructions through `--append-system-prompt`
- start with `Task`, editing, and notebook-writing tools disallowed

Claude workers:

- receive a worker assignment prompt
- start with editing and notebook-writing tools disallowed

Codex profiles:

- pass `model` through `--model`
- inject `env` as shell environment variables

Custom providers:

- receive the assignment prompt as command arguments
- are expected to obey the same task/result artifact contract

## Status and Summary

`status` refreshes worker status from worker artifacts, pane state, and captured
output. Completed workers include their `result.md` path in status output.

When all workers finish, `aweteam` writes `leader/summary-input.md` containing
merged worker results and notifies the leader pane. The leader is responsible
for final synthesis.

## Core Principles

### Thin Handoff

`aweteam` should expose the handoff between leader and workers instead of hiding
it behind a larger orchestration layer.

### Visible Conversations

Leader and worker conversations should remain visible in real agent panes.

### Explicit Artifacts

Runs should be debuggable from `.aweteam/runs/<run-id>/` without reading hidden
state.

### Configured Worker Pool

Workers must come from the configured pool, and `max_instances` must be
respected.

### Coordinator-Only Leader

The leader coordinates, delegates, monitors, and synthesizes. It should not do
the delegated work itself.
