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
  refreshRunStatus,
  spawnWorker,
  summarizeRun,
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
        model: "gpt-5.4-mini",
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
  assert.equal(tmuxCalls.some((args) => args[0] === "select-layout"), true);

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

test("buildLeaderCommand supports codex leaders without claude settings", () => {
  const command = buildLeaderCommand({
    provider: "codex",
    command: "codex",
    model: "gpt-5.4-mini",
    env: {
      HTTPS_PROXY: "http://127.0.0.1:7890",
    },
  }, "leader rules");

  assert.equal(command, "HTTPS_PROXY=http://127.0.0.1:7890 codex --model gpt-5.4-mini 'leader rules'");
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
      model: "gpt-5.4-mini",
      env: {
        HTTPS_PROXY: "http://127.0.0.1:7890",
      },
    }, "/tmp/task.md"),
    "HTTPS_PROXY=http://127.0.0.1:7890 codex exec --skip-git-repo-check --model gpt-5.4-mini --json - < /tmp/task.md",
  );
});

test("createRun configures a tmux team console", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const calls = [];

  await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "tmux-console",
    attach: false,
    tmux: async (args) => {
      calls.push(args);
      return { stdout: "%1\n", stderr: "", status: 0 };
    },
  });

  assert.deepEqual(calls.at(-4), ["select-pane", "-t", "%1", "-T", "leader main"]);
  assert.deepEqual(calls.at(-3), ["set-option", "-t", "aweteam-tmux-console", "mouse", "on"]);
  assert.deepEqual(calls.at(-2), ["bind-key", "-T", "prefix", "1", "select-pane", "-t", "%1"]);
  assert.deepEqual(calls.at(-1), ["select-layout", "-t", "aweteam-tmux-console", "main-vertical"]);
});

test("spawnWorker serializes concurrent spawns with a run lock", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  let paneNumber = 1;
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "concurrent-spawn",
    attach: false,
    tmux: async () => ({ stdout: `%${paneNumber++}\n`, stderr: "", status: 0 }),
  });
  const taskFile = join(dir, "task.md");
  await writeFile(taskFile, "do work", "utf8");

  const [first, second] = await Promise.all([
    spawnWorker({
      runId: run.runId,
      profileName: "cc-glm",
      taskFile,
      cwd: dir,
      tmux: async () => ({ stdout: `%${paneNumber++}\n`, stderr: "", status: 0 }),
    }),
    spawnWorker({
      runId: run.runId,
      profileName: "cc-glm",
      taskFile,
      cwd: dir,
      tmux: async () => ({ stdout: `%${paneNumber++}\n`, stderr: "", status: 0 }),
    }),
  ]);

  assert.deepEqual([first.name, second.name].sort(), ["worker-1", "worker-2"]);
  const runJson = JSON.parse(await readFile(join(run.runDir, "run.json"), "utf8"));
  assert.deepEqual(runJson.workers.map((worker) => worker.name), ["worker-1", "worker-2"]);
});

test("refreshRunStatus extracts completed codex result from worker stdout", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "refresh-codex",
    attach: false,
    tmux: async () => ({ stdout: "%1\n", stderr: "", status: 0 }),
  });
  const taskFile = join(dir, "task.md");
  await writeFile(taskFile, "do work", "utf8");
  const worker = await spawnWorker({
    runId: run.runId,
    profileName: "codex",
    taskFile,
    cwd: dir,
    tmux: async () => ({ stdout: "%2\n", stderr: "", status: 0 }),
  });
  await writeFile(join(worker.dir, "stdout.log"), [
    JSON.stringify({ type: "thread.started", thread_id: "t1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "codex result text" } }),
    JSON.stringify({ type: "turn.completed" }),
    "",
  ].join("\n"), "utf8");

  await refreshRunStatus({
    runId: run.runId,
    cwd: dir,
    tmux: async (args) => {
      if (args[0] === "display-message") {
        return { stdout: "1\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    },
  });

  const status = JSON.parse(await readFile(join(worker.dir, "status.json"), "utf8"));
  assert.equal(status.state, "done");
  assert.equal(await readFile(join(worker.dir, "result.md"), "utf8"), "codex result text\n");
});

test("refreshRunStatus extracts completed claude text and strips terminal controls", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "refresh-claude",
    attach: false,
    tmux: async () => ({ stdout: "%1\n", stderr: "", status: 0 }),
  });
  const taskFile = join(dir, "task.md");
  await writeFile(taskFile, "do work", "utf8");
  const worker = await spawnWorker({
    runId: run.runId,
    profileName: "cc-glm",
    taskFile,
    cwd: dir,
    tmux: async () => ({ stdout: "%2\n", stderr: "", status: 0 }),
  });
  await writeFile(join(worker.dir, "stdout.log"), "claude result text\n\u001b[?25h\u001b7\u001b8", "utf8");

  await refreshRunStatus({
    runId: run.runId,
    cwd: dir,
    tmux: async () => ({ stdout: "1\n", stderr: "", status: 0 }),
  });

  assert.equal(await readFile(join(worker.dir, "result.md"), "utf8"), "claude result text\n");
});

test("summarizeRun sends collected worker results to the leader pane", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const calls = [];
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "summarize",
    attach: false,
    tmux: async () => ({ stdout: "%1\n", stderr: "", status: 0 }),
  });
  const taskFile = join(dir, "task.md");
  await writeFile(taskFile, "do work", "utf8");
  const worker = await spawnWorker({
    runId: run.runId,
    profileName: "codex",
    taskFile,
    cwd: dir,
    tmux: async () => ({ stdout: "%2\n", stderr: "", status: 0 }),
  });
  await writeFile(join(worker.dir, "result.md"), "worker result\n", "utf8");
  await writeFile(join(worker.dir, "status.json"), JSON.stringify({
    role: "worker",
    state: "done",
    name: "worker-1",
    profile: "codex",
    pane: "%2",
    updated_at: new Date().toISOString(),
  }, null, 2), "utf8");

  const summary = await summarizeRun({
    runId: run.runId,
    cwd: dir,
    tmux: async (args) => {
      calls.push(args);
      return { stdout: "", stderr: "", status: 0 };
    },
  });

  assert.match(summary, /worker-1 \(codex\)/);
  assert.match(summary, /worker result/);
  assert.deepEqual(calls.at(-2).slice(0, 5), ["send-keys", "-t", "%1", "-l", "--"]);
  assert.deepEqual(calls.at(-1), ["send-keys", "-t", "%1", "Enter"]);
  assert.equal(await readFile(join(run.runDir, "leader", "summary-input.md"), "utf8"), summary);
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
  assert.deepEqual(calls.find((args) => args[0] === "pipe-pane" && args[3] === "%2"), [
    "pipe-pane",
    "-o",
    "-t",
    "%2",
    "cat >> " + shellQuote(join(worker.dir, "stdout.log")),
  ]);
  assert.deepEqual(calls.find((args) => args[0] === "split-window"), [
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
