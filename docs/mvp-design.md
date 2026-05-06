# aweteam MVP Design

## First Principles

The MVP treats multi-agent coordination as a thin handoff interface, not a
hidden scheduler or autonomous runtime.

The first version has three responsibilities:

1. Start the configured leader in its real CLI interface.
2. Let the leader create worker panes from an allowed default worker pool.
3. Keep all run state and handoff artifacts visible on disk.

aweteam should not infer intent from natural language, split tasks itself, or
summarize worker results. The leader software does that work. aweteam only
provides a small, explicit bridge for creating configured workers and preserving
state.

Everything important is represented as tmux panes and files. There is no hidden
daemon state as the source of truth.

## Reference Influence

The design borrows architecture, not bulk implementation.

- From `Ref/mco`: config-driven provider/profile definitions, subprocess-style
  adapters, explicit stdout/stderr/result artifacts, and a clear boundary between
  provider configuration and execution.
- From `Ref/oh-my-claudecode`: the team-style tmux surface where `leader/main`
  is the primary pane and workers are dynamically created panes that run real
  agent CLIs.

Both reference projects are MIT licensed. If implementation later copies
non-trivial code, the copied portion must preserve the required license notice.

## Provider Roles

Provider instances are role-specific.

- `leader` starts as the main interactive pane.
- `worker` profiles are the only profiles that can be spawned as worker panes.
- A provider implementation may support both roles, but each configured instance
  has exactly one role in a team run.

This keeps routing explicit. A Claude Code instance configured through GLM is not
"just Claude"; it is a configured provider instance with a command, model, env,
role, and profile name.

Workers can only be selected from `default_workers`. The leader may use natural
language to reason about which workers are useful, but aweteam enforces the
configured pool and each profile's `max_instances`.

Example shape:

```json
{
  "leader": {
    "name": "main",
    "provider": "claude",
    "command": "claude",
    "model": "glm-4.6",
    "env": {
      "ANTHROPIC_BASE_URL": "https://example.invalid",
      "ANTHROPIC_AUTH_TOKEN": "${GLM_API_KEY}",
      "ANTHROPIC_MODEL": "glm-4.6"
    }
  },
  "default_workers": ["cc-glm", "codex", "claudecode-official"],
  "worker_profiles": {
    "cc-glm": {
      "provider": "claude",
      "command": "claude",
      "model": "glm-4.6",
      "max_instances": 2,
      "env": {
        "ANTHROPIC_BASE_URL": "https://example.invalid",
        "ANTHROPIC_AUTH_TOKEN": "${GLM_API_KEY}",
        "ANTHROPIC_MODEL": "glm-4.6"
      }
    },
    "codex": {
      "provider": "codex",
      "command": "codex",
      "model": "gpt-5.3-codex",
      "max_instances": 1
    },
    "claudecode-official": {
      "provider": "claude",
      "command": "claude",
      "model": "sonnet",
      "max_instances": 1
    }
  }
}
```

## Filesystem Model

State lives under a visible run directory:

```text
.aweteam/
  runs/
    <run-id>/
      config.resolved.json
      run.json
      leader/
        instructions.md
        stdout.log
        stderr.log
        status.json
      workers/
        worker-1/
          profile.json
          task.md
          stdout.log
          stderr.log
          status.json
          result.md
        worker-2/
          profile.json
          task.md
          stdout.log
          stderr.log
          status.json
          result.md
      events.jsonl
      status.json
```

Rules:

- `config.resolved.json` records the exact leader and allowed worker profiles.
- `run.json` records the run id, cwd, tmux session, and active panes.
- `status.json` files are small machine-readable state summaries.
- `stdout.log` and `stderr.log` preserve raw provider output.
- `events.jsonl` is append-only and useful for tests and debugging.
- Worker `task.md` is the initial handoff prompt passed to that worker.
- Worker `result.md` is best-effort output capture; the real interactive pane
  remains the source for live conversation.

## Terminal Surface

The MVP uses tmux as the terminal surface. aweteam does not build a separate TUI.

Panes:

- `leader/main`: the real configured leader CLI, such as Claude Code.
- `worker-N`: real worker CLIs created dynamically from allowed profiles.

Startup behavior:

- `aweteam run` creates or attaches to a tmux session.
- The focused pane is `leader/main`.
- The leader pane runs the configured leader command directly.
- aweteam injects or provides leader instructions explaining the worker creation
  protocol and the allowed worker pool.

User interaction:

- The user talks naturally with the leader in the leader pane.
- The user can switch to any worker pane and talk to that worker directly.
- Confirmation of plans happens in the leader pane.
- aweteam does not parse natural-language confirmation.

This intentionally resembles Claude Code team mode at the surface level: one
main leader pane plus dynamically created worker panes.

## Minimal Command Surface

Top-level commands should stay small:

```text
aweteam run <task> [--config aweteam.json]
aweteam spawn --run-id <run-id> --profile <profile> --task-file <path>
aweteam status <run-id>
```

`spawn` is not a user-facing workflow command. It is the minimal local protocol
the leader can call after the user confirms a plan. aweteam validates the profile
against `default_workers` and `max_instances` before creating a worker pane.

Avoid adding convenience commands unless they solve a concrete recovery or
debugging problem.

## Provider Adapter Contract

Each adapter should expose only the operations needed for the MVP:

- `detect`: check whether the provider command exists and is runnable.
- `buildLeaderCommand`: convert the leader profile into argv/env/cwd.
- `buildWorkerCommand`: convert a worker profile and task file into argv/env/cwd.
- `spawnPane`: create a tmux pane running the built command.

The provider role is not inferred from the adapter. Role comes from config.

## MVP Execution Flow

1. Load config and resolve environment references.
2. Create `.aweteam/runs/<run-id>/`.
3. Write `config.resolved.json`, `run.json`, and leader instructions.
4. Create a tmux session with a focused `leader/main` pane.
5. Start the configured leader command in the leader pane.
6. The user works naturally with the leader.
7. After user confirmation, the leader calls `aweteam spawn` for selected
   profiles from the default worker pool.
8. Each `spawn` call validates pool membership and `max_instances`.
9. aweteam creates a worker pane and writes worker artifacts.
10. The user can switch between leader and worker panes for direct conversation.

## Communication Model

The MVP communication model is deliberately small.

- User to leader: direct conversation in `leader/main`.
- Leader to worker: explicit `aweteam spawn` handoff with a task file.
- Worker to leader: filesystem artifacts such as `result.md`, `stdout.log`, and
  `status.json`; the leader can read these paths if needed.
- User to worker: direct conversation in the worker pane.
- Worker to worker: not supported in MVP.

aweteam does not run a message bus and does not automatically paste worker
results back into the leader pane. That keeps context mutation explicit.

## Testing Strategy

The core should be testable without real Claude Code or Codex calls.

- Use fake provider commands that echo deterministic output.
- Assert resolved config preserves leader and worker roles.
- Assert `spawn` rejects profiles outside `default_workers`.
- Assert `spawn` rejects profiles over `max_instances`.
- Assert `spawn` writes worker artifacts and records pane metadata.
- Assert no code path infers confirmation from natural-language text.
- Assert tmux command construction can be tested without launching real providers.

## Deferred

- Auto-merge.
- MCP/ACP transports.
- Background monitor daemon.
- Automatic plan parsing.
- Automatic result summarization.
- Automatic result paste-back into leader.
- Worktree isolation.
- Provider health dashboards.
- Cross-run memory.
