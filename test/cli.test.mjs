import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { runCli } from "../src/cli.mjs";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "aweteam-cli-"));
}

async function writeConfig(dir) {
  const configPath = join(dir, "aweteam.json");
  await writeFile(configPath, JSON.stringify({
    leader: "main",
    workers: ["codex"],
    profiles: {
      main: {
        provider: "claude",
        command: "claude",
        model: "sonnet",
      },
      codex: {
        provider: "codex",
        command: "codex",
        model: "gpt-5.4-mini",
        max_instances: 1,
      },
    },
  }, null, 2), "utf8");
  return configPath;
}

test("version flag prints aweteam and version", async () => {
  const output = [];
  const exitCode = await runCli({
    argv: ["-v"],
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    tmux: async () => ({ stdout: "", stderr: "", status: 0 }),
  });

  assert.equal(exitCode, 0);
  assert.equal(output.join("\n"), "aweteam 0.1.1");
});

test("run command creates a run without attaching when requested", async () => {
  const dir = await tempDir();
  const configPath = await writeConfig(dir);
  const tmuxCalls = [];
  const output = [];

  const exitCode = await runCli({
    argv: ["run", "ship it", "--config", configPath, "--run-id", "cli-run", "--no-attach"],
    cwd: dir,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    tmux: async (args) => {
      tmuxCalls.push(args);
      return { stdout: "%1\n", stderr: "", status: 0 };
    },
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /run_id: cli-run/);
  assert.equal(tmuxCalls.some((args) => args[0] === "pipe-pane"), true);
  assert.equal(tmuxCalls.some((args) => args[0] === "select-layout"), true);

  const runJson = JSON.parse(await readFile(join(dir, ".aweteam", "runs", "cli-run", "run.json"), "utf8"));
  assert.equal(runJson.task, "ship it");
});

test("help output shows usage, options, and commands", async () => {
  const output = [];
  const exitCode = await runCli({
    argv: ["--help"],
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    tmux: async () => ({ stdout: "", stderr: "", status: 0 }),
  });

  const text = output.join("\n");
  assert.equal(exitCode, 0);
  assert.match(text, /Usage: aweteam \[OPTIONS\] COMMAND \[ARGS\]\.\.\./);
  assert.match(text, /-v, --version/);
  assert.match(text, /-h, --help/);
  assert.match(text, /Commands:/);
  assert.match(text, /\brun\b/);
  assert.match(text, /\bstatus\b/);
  assert.match(text, /\bfocus\b/);
});

test("default command starts a run with generated topic", async () => {
  const dir = await tempDir();
  const configPath = await writeConfig(dir);
  const output = [];

  const exitCode = await runCli({
    argv: ["--config", configPath, "--run-id", "default-run", "--no-attach"],
    cwd: dir,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    tmux: async () => ({ stdout: "%1\n", stderr: "", status: 0 }),
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /run_id: default-run/);

  const runJson = JSON.parse(await readFile(join(dir, ".aweteam", "runs", "default-run", "run.json"), "utf8"));
  assert.match(runJson.task, /aweteam leader session/);

  const instructions = await readFile(join(dir, ".aweteam", "runs", "default-run", "leader", "instructions.md"), "utf8");
  assert.match(instructions, /Initial topic:/);
  assert.match(instructions, /aweteam leader session/);
});

test("default command does not attach when stdout is not a terminal", async () => {
  const dir = await tempDir();
  const configPath = await writeConfig(dir);
  const tmuxCalls = [];
  const output = [];

  const exitCode = await runCli({
    argv: ["--config", configPath, "--run-id", "non-tty-run"],
    cwd: dir,
    isTTY: false,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    tmux: async (args) => {
      tmuxCalls.push(args);
      return { stdout: "%1\n", stderr: "", status: 0 };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(tmuxCalls.some((args) => args[0] === "attach-session"), false);
  assert.match(output.join("\n"), /attach: tmux attach -t aweteam-non-tty-run/);
});

test("status command prints run and worker pane metadata", async () => {
  const dir = await tempDir();
  const configPath = await writeConfig(dir);
  const taskFile = join(dir, "task.md");
  await writeFile(taskFile, "worker task", "utf8");
  const output = [];

  await runCli({
    argv: ["run", "ship it", "--config", configPath, "--run-id", "cli-status", "--no-attach"],
    cwd: dir,
    stdout: () => {},
    stderr: () => {},
    tmux: async () => ({ stdout: "%1\n", stderr: "", status: 0 }),
  });
  await runCli({
    argv: ["spawn", "--run-id", "cli-status", "--profile", "codex", "--task-file", taskFile],
    cwd: dir,
    stdout: () => {},
    stderr: () => {},
    tmux: async () => ({ stdout: "%2\n", stderr: "", status: 0 }),
  });

  const exitCode = await runCli({
    argv: ["status", "cli-status"],
    cwd: dir,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    tmux: async () => ({ stdout: "", stderr: "", status: 0 }),
  });

  assert.equal(exitCode, 0);
  assert.match(output.join("\n"), /leader: main\s+%1/);
  assert.match(output.join("\n"), /worker-1\s+codex\s+running\s+%2/);
});

test("focus command selects leader or worker panes", async () => {
  const dir = await tempDir();
  const configPath = await writeConfig(dir);
  const taskFile = join(dir, "task.md");
  await writeFile(taskFile, "worker task", "utf8");
  const calls = [];

  await runCli({
    argv: ["run", "ship it", "--config", configPath, "--run-id", "cli-focus", "--no-attach"],
    cwd: dir,
    stdout: () => {},
    stderr: () => {},
    tmux: async () => ({ stdout: "%1\n", stderr: "", status: 0 }),
  });
  await runCli({
    argv: ["spawn", "--run-id", "cli-focus", "--profile", "codex", "--task-file", taskFile],
    cwd: dir,
    stdout: () => {},
    stderr: () => {},
    tmux: async () => ({ stdout: "%2\n", stderr: "", status: 0 }),
  });

  const exitCode = await runCli({
    argv: ["focus", "cli-focus", "worker-1"],
    cwd: dir,
    stdout: () => {},
    stderr: () => {},
    tmux: async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", status: 0 };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(calls.some((args) => JSON.stringify(args) === JSON.stringify(["select-pane", "-t", "%2"])), true);
});
