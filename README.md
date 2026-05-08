# aweteam

`aweteam` is a minimal tmux handoff interface for local coding agents.

The MVP starts a real leader CLI in `leader/main`, lets that leader create
worker panes from configured profiles, and writes explicit run artifacts under
`.aweteam/runs/<run-id>/`.

## Commands

```bash
aweteam --config aweteam.json
aweteam run "task" --config aweteam.json
aweteam dispatch <run-id> [--once]
aweteam spawn --run-id <run-id> --profile <name> --task-file <path>
aweteam status <run-id>
aweteam status <run-id> --watch
aweteam focus <run-id> <leader|worker-name|profile>
aweteam summarize <run-id>
aweteam collect-summary <run-id>
```

The normal workflow happens inside tmux. The user talks to the leader pane in
plain language, the leader creates worker panes, workers answer in their own
panes, and the leader writes the final summary in its pane. The file artifacts
under `.aweteam/runs` are the internal handoff protocol and debugging record.
`spawn`, `status`, `summarize`, and `collect-summary` remain available as
low-level debugging commands.

For Claude Code leaders, aweteam starts the leader with native `Task` delegation
disabled and injects instructions that "agent" means an aweteam tmux worker
pane. This keeps Claude Code's internal Explore/Task agents from substituting
for aweteam workers.

Claude profiles pass `env` through `claude --settings`. Codex profiles pass
`model` through `codex --model`; profile `env` is
injected as shell environment variables rather than `--settings`.

Each run is a tmux team console. The leader pane is selected by `prefix+1`, and
worker panes are selected by `prefix+2` through `prefix+9` as they are spawned.
`aweteam --config` and `aweteam run` also start an internal dispatcher window
inside the same tmux session.
Worker panes run the interactive agent UI and stay open after completing their
assigned `task.md`, so the worker conversation remains visible in tmux.
The dispatcher sends worker-created, worker-done, and all-done notices back to
the leader pane. Worker final answers are visible in the worker panes and also
persisted to each worker's `result.md`.

## Config

The MVP config format is JSON:

```json
{
  "leader": "claudecode-official",
  "workers": ["codex"],
  "profiles": {
    "codex": {
      "provider": "codex",
      "command": "codex",
      "model": "gpt-5.4-mini",
      "max_instances": 1
    },
    "claudecode-official": {
      "provider": "claude",
      "command": "claude",
      "model": "sonnet"
    }
  }
}
```

## Quick Start

From this repository:

```bash
cd /Users/peng/Desktop/Project/Multiagent/aweteam
cp aweteam.example.json aweteam.json
```

If you use the `cc-glm` profile, export the required environment variables
before running:

```bash
export GLM_ANTHROPIC_BASE_URL="https://your-glm-compatible-endpoint"
export GLM_ANTHROPIC_AUTH_TOKEN="your-token"
```

Start a team session:

```bash
aweteam --config aweteam.json
```

This generates a default topic, records it in the run artifacts, and attaches
you to a tmux session focused on `leader/main`.

If you want to provide an explicit topic at startup, use:

```bash
aweteam run "创建三个 agent 实现 xx" --config aweteam.json
```

In the leader CLI, describe the task naturally and ask it to choose workers only
from the configured worker pool:

```text
帮我用 cc-xiaomi 检查前端，codex 5.4mini 检查后端，cc-gemini 看有没有 bug
```

The leader should create workers without requiring you to mention JSON, outbox,
dispatcher, or command-line calls. As workers finish, aweteam sends completion
notices back to the leader pane. You can switch to a worker pane to inspect or
continue that worker conversation:

```text
Ctrl-b 1  leader
Ctrl-b 2  worker-1
Ctrl-b 3  worker-2
```

Debug commands remain available from another terminal:

```bash
aweteam status <run-id>
aweteam focus <run-id> leader
```

## Operation Example

This example assumes `aweteam.json` contains:

- leader: `cc-xiaomi`
- default workers: `cc-glm`, `cc-gemini`, `codex-gpt5.4-mini`
- `codex-gpt5.4-mini` has `max_instances: 2`

Start aweteam:

```bash
cd /Users/peng/Desktop/Project/Multiagent/test_0506
aweteam --config aweteam.json
```

aweteam creates:

```text
.aweteam/runs/<run-id>/
  config.resolved.json
  run.json
  leader/instructions.md
```

You enter the tmux session focused on `leader/main`, running the configured
leader CLI. In that leader pane, ask:

```text
请为登录模块拟定三个 agent 分工。只能从 aweteam 默认 worker pool 里选择。
先给我方案，等我确认后再创建 worker。
```

The leader should propose a plan, for example:

```text
1. cc-glm: implement backend login/session flow
2. cc-gemini: implement frontend login UI
3. codex-gpt5.4-mini: review edge cases and security issues
```

After you confirm, the leader writes request files such as:

```text
.aweteam/runs/<run-id>/leader/outbox/login-backend.json
.aweteam/runs/<run-id>/leader/outbox/login-frontend.json
.aweteam/runs/<run-id>/leader/outbox/login-review.json
```

Each request contains the target profile and assignment:

```json
{
  "profile": "codex-gpt5.4-mini",
  "task": "Review login edge cases and security issues. Write your final answer to result.md."
}
```

This profile plus task text is the assignment protocol: the leader controls
which configured worker gets which task by choosing the profile and writing the
worker's assignment. aweteam validates each profile against `workers`, checks
`max_instances`, and creates `worker-1`, `worker-2`, and `worker-3` tmux panes
automatically.

From another terminal:

```bash
aweteam status <run-id>
```

Expected shape:

```text
run_id: <run-id>
session: aweteam-<run-id>
leader: cc-xiaomi    %0
workers:
worker-1    cc-glm       done       %1
worker-2    cc-gemini    running    %2
worker-3    codex-gpt5.4-mini    done       %3
```

Completed workers also include a `result=<path>` field in status output.
