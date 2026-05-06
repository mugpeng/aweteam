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
    leader: {
      name: "main",
      provider: "claude",
      command: "claude",
      model: "sonnet",
    },
    default_workers: ["codex"],
    worker_profiles: {
      codex: {
        provider: "codex",
        command: "codex",
        model: "gpt-5.3-codex",
        max_instances: 1,
      },
    },
  }, null, 2), "utf8");
  return configPath;
}

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
  assert.equal(tmuxCalls.length, 2);

  const runJson = JSON.parse(await readFile(join(dir, ".aweteam", "runs", "cli-run", "run.json"), "utf8"));
  assert.equal(runJson.task, "ship it");
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
  assert.match(output.join("\n"), /worker-1\s+codex\s+%2/);
});
