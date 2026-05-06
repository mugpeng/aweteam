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
node bin/aweteam.mjs --config aweteam.json
```

This generates a default topic, records it in the run artifacts, and attaches
you to a tmux session focused on `leader/main`.

If you want to provide an explicit topic at startup, use:

```bash
node bin/aweteam.mjs run "创建三个 agent 实现 xx" --config aweteam.json
```

In the leader CLI, ask it to choose workers only from the configured default
worker pool. After you confirm the plan, the leader should create task files and
call:

```bash
node /Users/peng/Desktop/Project/Multiagent/aweteam/bin/aweteam.mjs spawn \
  --run-id <run-id> \
  --profile <profile-name> \
  --task-file <task-file>
```

Check a run from another terminal:

```bash
node /Users/peng/Desktop/Project/Multiagent/aweteam/bin/aweteam.mjs status <run-id>
```
