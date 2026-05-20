# Contributing to aweteam

`aweteam` is built around a small idea: local multi-agent work should stay visible, explicit, and easy to debug.

This guide describes how to evolve the project without turning it into a larger framework than it needs to be.

## Development Setup

Requires Node.js 20 or later and tmux.

```bash
cd /Users/peng/Desktop/Project/Multiagent/aweteam
npm install
npm link
aweteam --help
npm test
```

The package is a small ESM Node CLI. Tests use the built-in `node:test` runner.

## Engineering Taste

Prefer solutions that are simple, clear, decoupled, honest, and durable.

- Simple: make the smallest change that solves the real problem.
- Clear: optimize for the next reader, not for cleverness.
- Decoupled: keep boundaries clean, but do not add abstractions without a real need.
- Honest: make complexity, state, side effects, assumptions, and failure modes visible; do not hide complexity or create extra complexity.
- Durable: choose behavior that is easy to maintain, test, and extend.
- Reason from first principles: identify the real problem, hard constraints, and known facts before reaching for patterns, abstractions, or prior solutions.

## Code Style

Keep the codebase plain and readable:

- prefer small focused functions over large command handlers
- preserve the boundary between CLI parsing and runtime behavior
- keep provider-specific command builders explicit
- avoid adding new top-level commands unless they remove real friction
- keep filesystem artifacts inspectable and stable

When in doubt, choose the behavior that makes a failed run easier to inspect from tmux and `.aweteam/runs/<run-id>/`.

## Architecture

### Project Direction

`aweteam` is intentionally centered on a small set of responsibilities:

- start one real leader CLI in tmux
- let that leader create worker panes from a configured worker pool
- preserve visible leader and worker conversations in tmux
- write explicit filesystem artifacts for handoff, status, and debugging

New features should make that handoff clearer, safer, or easier to inspect. They should not turn `aweteam` into a hidden scheduler, standalone TUI, hosted agent platform, planning framework, or replacement for the underlying agent CLIs.

### Runtime Model

Each run creates a tmux session named `aweteam-<run-id>`. The session contains:

- a `leader/main` pane running the configured leader CLI
- zero or more worker panes created from configured worker profiles
- an internal dispatcher window that watches the leader outbox

The user normally interacts with the leader pane. Workers are still real interactive agent panes, so their conversations can be inspected and continued directly in tmux.

### Leader Model

The leader is coordinator-only. The leader should:

- understand the user's request
- choose workers only from the configured worker pool
- split assignments into explicit worker tasks
- monitor worker completion notices
- synthesize the final answer in the leader pane

The leader should not execute delegated work itself. For Claude Code leaders, `aweteam` disables native `Task` delegation and injects instructions that "agent" means an aweteam tmux worker pane.

### Command Model

Primary user entrypoints:

- `aweteam --config aweteam.json`
- `aweteam run "task" --config aweteam.json`

Inspection commands:

- `aweteam status <run-id>`
- `aweteam status <run-id> --watch`
- `aweteam focus <run-id> <leader|worker-name|profile>`

Normal worker creation should happen through the leader pane.

### Config Model

`aweteam` reads JSON config only. Required top-level fields:

- `leader`: the selected leader profile name
- `workers`: the default worker pool
- `profiles`: named provider profiles

Only profiles listed in `workers` may be spawned as workers. `spawnWorker` validates this at runtime and also enforces each worker profile's `max_instances` limit.

Profile fields:

- `provider`: known values include `claude`, `codex`, or `custom`
- `command`: the local CLI command to run
- `model`: provider model name when supported
- `env`: environment values or `${ENV_NAME}` references
- `max_instances`: worker-only concurrency limit for that profile

A run freezes its resolved config into `.aweteam/runs/<run-id>/config.resolved.json`. Later edits to `aweteam.json` do not mutate an existing run.

### Handoff Protocol

The filesystem is the local handoff protocol.

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

To request a worker, the leader writes one JSON file under `leader/outbox/<request-id>.json`:

```json
{
  "profile": "<profile-name>",
  "task": "Exact assignment for this worker."
}
```

The dispatcher validates the request, writes the worker task file, creates a worker pane, writes a creation receipt under `leader/inbox/`, and appends an event to `events.jsonl`.

Final worker answers belong in each worker's `result.md`. `leader/inbox/` is for creation receipts and errors, not final worker content.

### Provider Semantics

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

### Status and Summary

`status` refreshes worker status from worker artifacts, pane state, and captured output. Completed workers include their `result.md` path in status output.

When all workers finish, `aweteam` writes `leader/summary-input.md` containing merged worker results and notifies the leader pane. The leader is responsible for final synthesis.

### Core Principles

- **Thin Handoff**: expose the handoff between leader and workers instead of hiding it behind a larger orchestration layer.
- **Visible Conversations**: leader and worker conversations should remain visible in real agent panes.
- **Explicit Artifacts**: runs should be debuggable from `.aweteam/runs/<run-id>/` without reading hidden state.
- **Configured Worker Pool**: workers must come from the configured pool, and `max_instances` must be respected.
- **Coordinator-Only Leader**: the leader coordinates, delegates, monitors, and synthesizes. It should not do the delegated work itself.

## Debug Commands

The following commands are hidden from `--help` but remain functional. They exist for debugging the runtime and handoff protocol.

```bash
aweteam spawn --run-id <run-id> --profile <name> --task-file <path>
```

Create one worker pane from an allowed workers profile. Low-level; normal worker creation happens through the leader pane.

```bash
aweteam dispatch <run-id> [--once]
```

Internal dispatcher. Watches `leader/outbox` and creates worker panes. Without `--once`, loops forever at 1-second intervals. With `--once`, processes one batch and exits.

```bash
aweteam summarize <run-id>
```

Merges worker results into `summary-input.md` and sends a prompt to the leader pane.

```bash
aweteam collect-summary <run-id>
```

Captures leader pane output and persists it to `leader/summary.md`.

## Runtime Changes

Before changing command semantics, config behavior, provider launch behavior, tmux pane behavior, or run artifact paths, read the Architecture section above and decide whether the change preserves the current model.

Provider-specific behavior is part of the runtime contract. If you change how Claude, Codex, or custom profiles are launched, update tests and documentation in the same change.

## Documentation

If you change any of these areas, update the matching docs:

- command names or command semantics
- config shape or provider profile behavior
- leader or worker instructions
- tmux pane behavior
- handoff artifact paths
- status or summary behavior

Use:

- `README.md` / `README_CN.md` for user-facing setup and common usage
- `docs/CONTRIBUTING.md` for architecture, development, and contribution rules
- `docs/CHANGELOG.md` for release notes

## Testing

Before handing off a change, run:

```bash
npm test
```

If you changed CLI behavior, add or update tests in `test/cli.test.mjs`. If you changed runtime behavior, add or update focused tests in `test/core.test.mjs`.

For live verification of the leader-to-worker chain, prefer the existing real config workspace:

```bash
cd /Users/peng/Desktop/Project/Multiagent/test_0506
aweteam --config aweteam.json
aweteam status <run-id>
```

Use real run artifacts such as `run.json`, `events.jsonl`, worker `task.md`, and worker `result.md` as evidence. Do not treat a provider/model API failure as an aweteam dispatch failure unless the spawn chain itself failed.

## Releasing

Versioning starts at `v0.1.0`. For now:

1. Update `docs/CHANGELOG.md`.
2. Update `version` in `package.json`.
3. Commit and push.

## Questions

If a proposal makes `aweteam` more magical, ask whether the same outcome can be achieved by making the existing handoff clearer instead.
