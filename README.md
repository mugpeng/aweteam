# aweteam

`aweteam` is a minimal tmux handoff interface for local coding agents.

The MVP starts a real leader CLI in `leader/main`, lets that leader create
worker panes from configured profiles, and writes explicit run artifacts under
`.aweteam/runs/<run-id>/`.

## Commands

```bash
aweteam --config aweteam.json
aweteam run "task" --config aweteam.json
aweteam spawn --run-id <run-id> --profile <name> --task-file <path>
aweteam status <run-id>
```

`spawn` is the small local protocol used by the leader after the user confirms a
plan. It only accepts profiles listed in `default_workers` and enforces each
profile's `max_instances`.

## Config

The MVP config format is JSON:

```json
{
  "leader": {
    "name": "main",
    "provider": "claude",
    "command": "claude",
    "model": "sonnet"
  },
  "default_workers": ["codex"],
  "worker_profiles": {
    "codex": {
      "provider": "codex",
      "command": "codex",
      "model": "gpt-5.3-codex",
      "max_instances": 1
    }
  }
}
```

See `docs/mvp-design.md` for the design constraints.

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

In the leader CLI, ask it to choose workers only from the configured default
worker pool. After you confirm the plan, the leader should create task files and
call:

```bash
aweteam spawn \
  --run-id <run-id> \
  --profile <profile-name> \
  --task-file <task-file>
```

Check a run from another terminal:

```bash
aweteam status <run-id>
```

## Operation Example

This example assumes `aweteam.json` contains:

- leader: `cc-xiaomi`
- default workers: `cc-glm`, `cc-gemini`, `codex`
- `codex` has `max_instances: 2`

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
3. codex: review edge cases and security issues
```

After you confirm, the leader writes task files such as:

```text
.aweteam/runs/<run-id>/tasks/login-backend.md
.aweteam/runs/<run-id>/tasks/login-frontend.md
.aweteam/runs/<run-id>/tasks/login-review.md
```

Then the leader calls:

```bash
aweteam spawn --run-id <run-id> --profile cc-glm --task-file .aweteam/runs/<run-id>/tasks/login-backend.md
aweteam spawn --run-id <run-id> --profile cc-gemini --task-file .aweteam/runs/<run-id>/tasks/login-frontend.md
aweteam spawn --run-id <run-id> --profile codex --task-file .aweteam/runs/<run-id>/tasks/login-review.md
```

aweteam validates each profile against `default_workers`, checks
`max_instances`, and creates `worker-1`, `worker-2`, and `worker-3` tmux panes.

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
worker-1    cc-glm       %1
worker-2    cc-gemini    %2
worker-3    codex        %3
```
