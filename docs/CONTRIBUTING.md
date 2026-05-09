# Contributing to aweteam

`aweteam` is built around a small idea: local multi-agent work should stay
visible, explicit, and easy to debug.

This guide describes how to evolve the project without turning it into a larger
framework than it needs to be.

For stable runtime semantics, see [DESIGN.md](./DESIGN.md).

## Project Direction

`aweteam` is not trying to become a full agent platform.

The project is intentionally centered on a small set of responsibilities:

- start a real leader CLI in tmux
- let that leader create worker panes from configured profiles
- keep leader and worker conversations inspectable
- persist run artifacts that prove what happened

New features should preserve that focus. Prefer improving the existing tmux
handoff over adding new layers, hidden schedulers, or parallel command surfaces.

## Development Setup

Requires Node.js 20 or later and tmux.

```bash
cd /Users/peng/Desktop/Project/Multiagent/aweteam
npm install
npm link
aweteam --help
npm test
```

The package is currently a small ESM Node CLI. Tests use the built-in
`node:test` runner.

## Code Style

Keep the codebase plain and readable:

- prefer small focused functions over large command handlers
- preserve the boundary between CLI parsing and runtime behavior
- keep provider-specific command builders explicit
- avoid adding new top-level commands unless they remove real friction
- keep filesystem artifacts inspectable and stable

When in doubt, choose the behavior that makes a failed run easier to inspect
from tmux and `.aweteam/runs/<run-id>/`.

## Runtime Rules

Changes should preserve these invariants:

- the leader is coordinator-only
- normal worker creation happens through the leader pane
- workers come only from the configured `workers` pool
- `max_instances` is enforced
- a run freezes `config.resolved.json`
- worker assignments are written to `task.md`
- worker final answers are written to `result.md`
- `events.jsonl` remains a useful debugging record

Provider-specific behavior is part of the contract. If you change how Claude,
Codex, or custom profiles are launched, update tests and documentation in the
same change.

## Documentation

If you change any of these areas, update the matching docs:

- command names or command semantics
- config shape or provider profile behavior
- leader or worker instructions
- tmux pane behavior
- handoff artifact paths
- status or summary behavior

Use:

- `README.md` for user-facing setup and common usage
- `README_CN.md` for the Chinese user-facing entrypoint
- `docs/DESIGN.md` for stable runtime and protocol semantics
- `docs/CONTRIBUTING.md` for development and contribution rules

## Testing

Before handing off a change, run:

```bash
npm test
```

If you changed CLI behavior, add or update tests in `test/cli.test.mjs`.

If you changed runtime behavior, add or update focused tests in
`test/core.test.mjs`.

For live verification of the leader-to-worker chain, prefer the existing real
config workspace:

```bash
cd /Users/peng/Desktop/Project/Multiagent/test_0506
aweteam --config aweteam.json
aweteam status <run-id>
```

Use real run artifacts such as `run.json`, `events.jsonl`, worker `task.md`, and
worker `result.md` as evidence. Do not treat a provider/model API failure as an
aweteam dispatch failure unless the spawn chain itself failed.

## Release Notes

This package is currently private and versioned as `0.0.0`. If release process
or distribution changes are added later, document them here and keep
`package.json`, README installation guidance, and tests aligned.

## Questions

If a proposal makes `aweteam` more magical, ask whether the same outcome can be
achieved by making the existing handoff clearer instead.
