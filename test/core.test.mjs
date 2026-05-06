import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  buildLeaderCommand,
  buildWorkerCommand,
  createRun,
  createRealTmuxRunner,
  loadConfig,
  spawnWorker,
} from "../src/core.mjs";

async function tempDir() {
  return mkdtemp(join(tmpdir(), "aweteam-"));
}

async function writeJsonConfig(dir, value) {
  const configPath = join(dir, "aweteam.json");
  await writeFile(configPath, JSON.stringify(value, null, 2), "utf8");
  return configPath;
}

function sampleConfig() {
  return {
    leader: {
      name: "main",
      provider: "claude",
      command: "claude",
      model: "sonnet",
      env: {
        ANTHROPIC_MODEL: "sonnet",
      },
    },
    default_workers: ["cc-glm", "codex"],
    worker_profiles: {
      "cc-glm": {
        provider: "claude",
        command: "claude",
        model: "glm-4.6",
        max_instances: 2,
      },
      codex: {
        provider: "codex",
        command: "codex",
        model: "gpt-5.3-codex",
        max_instances: 1,
      },
      hidden: {
        provider: "claude",
        command: "claude",
        max_instances: 1,
      },
    },
  };
}

test("loadConfig preserves leader role and allowed worker profiles", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());

  const config = await loadConfig(configPath);

  assert.equal(config.leader.role, "leader");
  assert.equal(config.worker_profiles["cc-glm"].role, "worker");
  assert.deepEqual(config.default_workers, ["cc-glm", "codex"]);
  assert.equal(config.worker_profiles.hidden.role, "worker");
});

test("loadConfig resolves env references explicitly", async () => {
  const dir = await tempDir();
  const value = sampleConfig();
  value.leader.env.ANTHROPIC_AUTH_TOKEN = "${AWETEAM_TEST_TOKEN}";
  const configPath = await writeJsonConfig(dir, value);

  const previous = process.env.AWETEAM_TEST_TOKEN;
  process.env.AWETEAM_TEST_TOKEN = "secret-token";
  try {
    const config = await loadConfig(configPath);
    assert.equal(config.leader.env.ANTHROPIC_AUTH_TOKEN, "secret-token");
  } finally {
    if (previous === undefined) {
      delete process.env.AWETEAM_TEST_TOKEN;
    } else {
      process.env.AWETEAM_TEST_TOKEN = previous;
    }
  }
});

test("loadConfig rejects missing env references", async () => {
  const dir = await tempDir();
  const value = sampleConfig();
  value.leader.env.ANTHROPIC_AUTH_TOKEN = "${AWETEAM_MISSING_TOKEN}";
  const configPath = await writeJsonConfig(dir, value);
  delete process.env.AWETEAM_MISSING_TOKEN;

  await assert.rejects(loadConfig(configPath), /missing environment variable/);
});

test("createRun writes explicit run artifacts and leader instructions", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const tmuxCalls = [];

  const run = await createRun({
    task: "build a tiny demo",
    configPath,
    cwd: dir,
    runId: "run-test",
    attach: false,
    tmux: async (args) => {
      tmuxCalls.push(args);
      return { stdout: "%1\n", stderr: "", status: 0 };
    },
  });

  assert.equal(run.runId, "run-test");
  assert.equal(run.sessionName, "aweteam-run-test");
  assert.deepEqual(tmuxCalls[0].slice(0, 6), [
    "new-session",
    "-d",
    "-s",
    "aweteam-run-test",
    "-n",
    "leader-main",
  ]);
  assert.match(tmuxCalls[0][6], /^claude --settings '\{"env":\{"ANTHROPIC_MODEL":"sonnet"\}\}' --disallowedTools Task,Edit,MultiEdit,NotebookEdit,Write --append-system-prompt /);
  assert.match(tmuxCalls[0][6], /Default worker pool:/);
  assert.deepEqual(tmuxCalls[1], [
    "pipe-pane",
    "-o",
    "-t",
    "%1",
    "cat >> " + shellQuote(join(run.runDir, "leader", "stdout.log")),
  ]);
  assert.equal(tmuxCalls.length, 2);

  const runJson = JSON.parse(await readFile(join(run.runDir, "run.json"), "utf8"));
  assert.equal(runJson.leader.pane, "%1");
  assert.equal(runJson.task, "build a tiny demo");

  const instructions = await readFile(join(run.runDir, "leader", "instructions.md"), "utf8");
  assert.match(instructions, /default worker pool/i);
  assert.match(instructions, /aweteam spawn/);
  assert.match(instructions, /Do not use Claude Code native Task/);
  assert.match(instructions, /coordinator-only leader/);
  assert.match(instructions, /Do not execute the user task yourself/);

  const resolved = JSON.parse(await readFile(join(run.runDir, "config.resolved.json"), "utf8"));
  assert.equal(resolved.leader.role, "leader");
  assert.equal(resolved.leader_policy.mode, "delegate_only");
  assert.equal(resolved.leader_policy.plan_approval_required, true);
  assert.equal(resolved.leader_policy.native_subagents, "disallow");
  assert.equal(resolved.worker_profiles.codex.role, "worker");
});

test("buildLeaderCommand disables Claude native subagents", () => {
  const command = buildLeaderCommand({
    provider: "claude",
    command: "claude",
    model: "sonnet",
    env: {},
  }, "leader rules");

  assert.equal(command, "claude --disallowedTools Task,Edit,MultiEdit,NotebookEdit,Write --append-system-prompt 'leader rules'");
});

test("buildWorkerCommand uses provider-specific non-interactive commands", () => {
  assert.equal(
    buildWorkerCommand({
      provider: "claude",
      command: "claude",
      model: "glm-4.6",
      env: {},
    }, "/tmp/task.md"),
    "claude -p --output-format text < /tmp/task.md",
  );

  assert.equal(
    buildWorkerCommand({
      provider: "codex",
      command: "codex",
      model: "gpt-5.4",
      env: {},
    }, "/tmp/task.md"),
    "codex exec --skip-git-repo-check --json - < /tmp/task.md",
  );
});

test("real tmux runner attaches with inherited terminal stdio", async () => {
  const spawnCalls = [];
  const runner = createRealTmuxRunner({
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
    execFile: async () => {
      throw new Error("attach should not use execFile");
    },
  });

  const result = await runner(["attach-session", "-t", "aweteam-test"]);

  assert.equal(result.status, 0);
  assert.deepEqual(spawnCalls, [{
    command: "tmux",
    args: ["attach-session", "-t", "aweteam-test"],
    options: { stdio: "inherit" },
  }]);
});

test("spawnWorker rejects profiles outside default_workers", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "reject-hidden",
    attach: false,
    tmux: async () => ({ stdout: "%1\n", stderr: "", status: 0 }),
  });
  const taskFile = join(dir, "task.md");
  await writeFile(taskFile, "do work", "utf8");

  await assert.rejects(
    spawnWorker({
      runId: run.runId,
      profileName: "hidden",
      taskFile,
      cwd: dir,
      tmux: async () => ({ stdout: "%2\n", stderr: "", status: 0 }),
    }),
    /not in default_workers/,
  );
});

test("spawnWorker enforces max_instances", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "max-instances",
    attach: false,
    tmux: async () => ({ stdout: "%1\n", stderr: "", status: 0 }),
  });
  const taskFile = join(dir, "task.md");
  await writeFile(taskFile, "do work", "utf8");

  await spawnWorker({
    runId: run.runId,
    profileName: "codex",
    taskFile,
    cwd: dir,
    tmux: async () => ({ stdout: "%2\n", stderr: "", status: 0 }),
  });

  await assert.rejects(
    spawnWorker({
      runId: run.runId,
      profileName: "codex",
      taskFile,
      cwd: dir,
      tmux: async () => ({ stdout: "%3\n", stderr: "", status: 0 }),
    }),
    /max_instances/,
  );
});

test("spawnWorker creates worker artifacts and tmux pane from profile", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const calls = [];
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "spawn-ok",
    attach: false,
    tmux: async (args) => {
      calls.push(args);
      return { stdout: calls.length === 1 ? "%1\n" : "%2\n", stderr: "", status: 0 };
    },
  });
  const taskFile = join(dir, "task.md");
  await writeFile(taskFile, "implement the worker task", "utf8");

  const worker = await spawnWorker({
    runId: run.runId,
    profileName: "cc-glm",
    taskFile,
    cwd: dir,
    tmux: async (args) => {
      calls.push(args);
      return { stdout: "%2\n", stderr: "", status: 0 };
    },
  });

  assert.equal(worker.name, "worker-1");
  assert.deepEqual(calls.at(-1), [
    "pipe-pane",
    "-o",
    "-t",
    "%2",
    "cat >> " + shellQuote(join(worker.dir, "stdout.log")),
  ]);
  assert.deepEqual(calls.at(-2), [
    "split-window",
    "-t",
    "aweteam-spawn-ok",
    "-P",
    "-F",
    "#{pane_id}",
    "claude -p --output-format text < " + join(worker.dir, "task.md"),
  ]);

  assert.equal(await readFile(join(worker.dir, "task.md"), "utf8"), "implement the worker task");
  const profile = JSON.parse(await readFile(join(worker.dir, "profile.json"), "utf8"));
  assert.equal(profile.name, "cc-glm");
  assert.equal(profile.role, "worker");

  const runJson = JSON.parse(await readFile(join(run.runDir, "run.json"), "utf8"));
  assert.equal(runJson.workers[0].profile, "cc-glm");
  assert.equal(runJson.workers[0].pane, "%2");
});

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
