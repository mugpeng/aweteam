# Contributing to aweteam

`aweteam` is built around a small idea: local multi-agent work should stay
visible, explicit, and easy to debug.

This guide describes how to evolve the project without turning it into a larger
framework than it needs to be.

For stable runtime semantics, see [DESIGN.md](./DESIGN.md). This document is
about how to make and review changes.

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

When in doubt, choose the behavior that makes a failed run easier to inspect
from tmux and `.aweteam/runs/<run-id>/`.

## Runtime Changes

Runtime behavior is defined in [DESIGN.md](./DESIGN.md). Before changing command
semantics, config behavior, provider launch behavior, tmux pane behavior, or run
artifact paths, read that document and decide whether the change preserves the
current model.

Provider-specific behavior is part of the runtime contract. If you change how
Claude, Codex, or custom profiles are launched, update tests and documentation
in the same change.

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
