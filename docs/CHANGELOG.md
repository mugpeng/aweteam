# Changelog

## v0.1.0

`v0.1.0` is the first publishable release of aweteam. The project installs as a Node.js ESM CLI with zero external dependencies.

### What it does

aweteam is a thin tmux handoff interface for local AI coding teams. It starts a leader CLI in `leader/main`, lets that leader create worker panes from configured profiles, and records run artifacts under `.aweteam/runs/<run-id>/`.

### Highlights

- Zero-dependency ESM Node.js CLI (`node >= 20`)
- tmux-based leader/worker pane management
- Filesystem handoff protocol (outbox/inbox JSON)
- Claude and Codex provider support
- Config-driven worker pool with `max_instances`
- `-v` / `--version` flag
- Clean `--help` output matching aweswitch conventions
- Hidden debug commands (`spawn`, `dispatch`, `summarize`, `collect-summary`)
- English and Chinese READMEs with centered hero block and badges
- Test suite with 32 tests using `node:test`
