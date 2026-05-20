import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  buildLeaderCommand,
  buildWorkerCommand,
  buildDispatcherCommand,
  createRun,
  createRealTmuxRunner,
  dispatchOnce,
  loadConfig,
  notifyRunProgress,
  refreshRunStatus,
  collectLeaderSummary,
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
    leader: "main",
    workers: ["cc-glm", "codex"],
    profiles: {
      main: {
        provider: "claude",
        command: "claude",
        env: {
          ANTHROPIC_MODEL: "sonnet",
        },
      },
      "cc-glm": {
        provider: "claude",
        command: "claude",
        max_instances: 2,
        env: {
          ANTHROPIC_MODEL: "glm-4.6",
        },
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
  assert.equal(config.profiles["cc-glm"].role, "worker");
  assert.deepEqual(config.workers, ["cc-glm", "codex"]);
  assert.equal(config.profiles.hidden.role, "worker");
});

test("loadConfig resolves env references explicitly", async () => {
  const dir = await tempDir();
  const value = sampleConfig();
  value.profiles.main.env.ANTHROPIC_AUTH_TOKEN = "${AWETEAM_TEST_TOKEN}";
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
  value.profiles.main.env.ANTHROPIC_AUTH_TOKEN = "${AWETEAM_MISSING_TOKEN}";
  const configPath = await writeJsonConfig(dir, value);
  delete process.env.AWETEAM_MISSING_TOKEN;

  await assert.rejects(loadConfig(configPath), /missing environment variable/);
});

test("loadConfig rejects legacy worker_profiles config shape", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, {
    leader: {
      name: "main",
      provider: "claude",
      command: "claude",
    },
    default_workers: ["codex"],
    worker_profiles: {
      codex: {
        provider: "codex",
        command: "codex",
      },
    },
  });

  await assert.rejects(loadConfig(configPath), /config.profiles is required/);
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
  assert.deepEqual(tmuxCalls[0].slice(6, 9), ["-P", "-F", "#{pane_id}"]);
  assert.match(tmuxCalls[0][9], /^claude --settings \S+ --disallowedTools Task,Edit,MultiEdit,NotebookEdit,Write --append-system-prompt /);
  assert.match(tmuxCalls[0][9], /Default worker pool:/);
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
  assert.match(instructions, /leader\/outbox/);
  assert.match(instructions, /"profile": "<profile-name>"/);
  assert.match(instructions, /Normal user prompts are short/);
  assert.match(instructions, /Final worker\s+answers are in each worker's result\.md/);
  assert.match(instructions, /Do not use Claude Code native Task/);
  assert.match(instructions, /coordinator-only leader/);
  assert.match(instructions, /Do not execute delegated work yourself/);

  const resolved = JSON.parse(await readFile(join(run.runDir, "config.resolved.json"), "utf8"));
  assert.equal(resolved.leader.role, "leader");
  assert.equal(resolved.leader_policy.mode, "delegate_only");
  assert.equal(resolved.leader_policy.plan_approval_required, true);
  assert.equal(resolved.leader_policy.native_subagents, "disallow");
  assert.equal(resolved.profiles.codex.role, "worker");
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

test("buildWorkerCommand uses provider-specific interactive commands", () => {
  assert.equal(
    buildWorkerCommand({
      provider: "claude",
      command: "claude",
      model: "glm-4.6",
      env: {},
    }, "/tmp/task.md"),
    "claude --disallowedTools Edit,MultiEdit,NotebookEdit",
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
    "HTTPS_PROXY=http://127.0.0.1:7890 codex --model gpt-5.4-mini",
  );
});

test("spawnWorker starts an interactive agent pane with an assignment prompt", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const calls = [];
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "persist-pane",
    attach: false,
    tmux: async (args) => {
      calls.push(args);
      return { stdout: "%1\n", stderr: "", status: 0 };
    },
  });
  const taskFile = join(dir, "task.md");
  await writeFile(taskFile, "do work", "utf8");

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

  const split = calls.find((args) => args[0] === "split-window");
  assert.match(split.at(-1), /^claude --settings \S+ --disallowedTools Edit,MultiEdit,NotebookEdit$/);
  const assignmentSend = calls.find((args) => args[0] === "send-keys" && args[3] === "-l");
  assert.deepEqual(assignmentSend.slice(0, 5), ["send-keys", "-t", "%2", "-l", "--"]);
  assert.doesNotMatch(assignmentSend.at(-1), /\n/);
  assert.match(assignmentSend.at(-1), /Read your task from .*task\.md\./);
  assert.match(assignmentSend.at(-1), /Do not modify project or source files\./);
  assert.match(assignmentSend.at(-1), /Write your final answer to .*result\.md\./);
  assert.match(assignmentSend.at(-1), /Keep the session open after finishing\./);
  assert.deepEqual(calls.find((args) => args[0] === "send-keys" && args[3] === "Enter"), ["send-keys", "-t", "%2", "Enter"]);
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

  assert.equal(calls.some((args) => JSON.stringify(args) === JSON.stringify(["select-pane", "-t", "%1", "-T", "leader main"])), true);
  assert.equal(calls.some((args) => JSON.stringify(args) === JSON.stringify(["set-option", "-t", "aweteam-tmux-console", "mouse", "on"])), true);
  assert.equal(calls.some((args) => JSON.stringify(args) === JSON.stringify(["set-option", "-t", "aweteam-tmux-console", "pane-border-status", "top"])), true);
  assert.equal(calls.some((args) => JSON.stringify(args) === JSON.stringify(["set-option", "-t", "aweteam-tmux-console", "pane-border-format", "#{pane_title}"])), true);
  assert.equal(calls.some((args) => JSON.stringify(args) === JSON.stringify(["bind-key", "-T", "prefix", "1", "select-pane", "-t", "%1"])), true);
  assert.deepEqual(calls.at(-1), ["select-layout", "-t", "aweteam-tmux-console", "main-vertical"]);
});

test("createRun can start a dispatcher window for leader-driven worker creation", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const calls = [];

  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "dispatcher-pane",
    attach: false,
    dispatcher: true,
    tmux: async (args) => {
      calls.push(args);
      return { stdout: calls.some((call) => call[0] === "new-window") ? "%9\n" : "%1\n", stderr: "", status: 0 };
    },
  });

  const newWindow = calls.find((args) => args[0] === "new-window");
  assert.deepEqual(newWindow.slice(0, 9), [
    "new-window",
    "-d",
    "-t",
    "aweteam-dispatcher-pane",
    "-n",
    "aweteam-dispatcher",
    "-P",
    "-F",
    "#{pane_id}",
  ]);
  assert.match(newWindow.at(-1), / dispatch dispatcher-pane$/);
  assert.deepEqual(await readdir(join(run.runDir, "leader", "outbox")), []);
  const runJson = JSON.parse(await readFile(join(run.runDir, "run.json"), "utf8"));
  assert.equal(runJson.dispatcher.pane, "%9");
});

test("dispatchOnce creates workers from leader outbox requests", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const calls = [];
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "dispatch-once",
    attach: false,
    tmux: async (args) => {
      calls.push(args);
      return { stdout: "%1\n", stderr: "", status: 0 };
    },
  });
  const requestPath = join(run.runDir, "leader", "outbox", "001.json");
  await writeFile(requestPath, JSON.stringify({
    profile: "cc-glm",
    task: "Review backend behavior.",
  }, null, 2), "utf8");

  const handled = await dispatchOnce({
    runId: run.runId,
    cwd: dir,
    tmux: async (args) => {
      calls.push(args);
      return { stdout: "%2\n", stderr: "", status: 0 };
    },
  });

  assert.deepEqual(handled, [{ request: "001", worker: "worker-1", profile: "cc-glm", pane: "%2" }]);
  assert.equal(await readFile(join(run.runDir, "leader", "tasks", "001.md"), "utf8"), "Review backend behavior.\n");
  assert.match(await readFile(join(run.runDir, "leader", "inbox", "001.result.md"), "utf8"), /spawned: worker-1/);
  await assert.rejects(readFile(requestPath, "utf8"), /ENOENT/);
  const split = calls.find((args) => args[0] === "split-window");
  assert.deepEqual(split.slice(0, 3), ["split-window", "-t", "%1"]);
});

test("notifyRunProgress sends worker lifecycle messages into the leader pane", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const calls = [];
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "notify-progress",
    attach: false,
    tmux: async (args) => {
      calls.push(args);
      return { stdout: "%1\n", stderr: "", status: 0 };
    },
  });
  const taskFile = join(dir, "task.md");
  await writeFile(taskFile, "do work", "utf8");
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

  const notified = await notifyRunProgress({
    runId: run.runId,
    cwd: dir,
    tmux: async (args) => {
      calls.push(args);
      if (args[0] === "display-message") return { stdout: "0\n", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 0 };
    },
  });
  assert.equal(notified.has("spawned:worker-1"), true);
  assert.equal(calls.some((args) => args[0] === "send-keys" && args.includes("[aweteam] created worker-1 (cc-glm) in pane %2.\nSwitch with Ctrl-b 2.")), true);

  await writeFile(join(worker.dir, "result.md"), "worker result\n", "utf8");
  await notifyRunProgress({
    runId: run.runId,
    cwd: dir,
    tmux: async (args) => {
      calls.push(args);
      if (args[0] === "display-message") return { stdout: "0\n", stderr: "", status: 0 };
      return { stdout: "", stderr: "", status: 0 };
    },
    notified,
  });

  assert.equal(notified.has("done:worker-1"), true);
  assert.equal(notified.has("all-done"), true);
  const summaryInput = await readFile(join(run.runDir, "leader", "summary-input.md"), "utf8");
  assert.match(summaryInput, /## worker-1 \(cc-glm\)/);
  assert.match(summaryInput, /worker result/);
  assert.equal(calls.some((args) => args[0] === "send-keys" && String(args.at(-1)).includes("all workers have finished")), true);
  assert.equal(calls.some((args) => args[0] === "send-keys" && String(args.at(-1)).includes("Merged worker results are ready")), true);
  assert.equal(calls.some((args) => args[0] === "send-keys" && String(args.at(-1)).includes("Do not wait on leader/inbox")), true);
});

test("buildDispatcherCommand re-enters aweteam from the run cwd", () => {
  const command = buildDispatcherCommand({ cwd: "/tmp/project path", runId: "run-1" });
  assert.match(command, /^cd '\/tmp\/project path' && /);
  assert.match(command, / dispatch run-1$/);
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
  await writeFile(join(worker.dir, "exit-code.txt"), "0\n", "utf8");
  const calls = [];

  await refreshRunStatus({
    runId: run.runId,
    cwd: dir,
    tmux: async (args) => {
      calls.push(args);
      if (args[0] === "display-message") {
        return { stdout: "0\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    },
  });

  const status = JSON.parse(await readFile(join(worker.dir, "status.json"), "utf8"));
  assert.equal(status.state, "done");
  assert.equal(await readFile(join(worker.dir, "result.md"), "utf8"), "codex result text\n");
  assert.deepEqual(calls.find((args) => args[0] === "select-pane" && args.at(-1).endsWith("done")), [
    "select-pane",
    "-t",
    "%2",
    "-T",
    "worker-1 codex done",
  ]);
});

test("refreshRunStatus marks worker done from a result artifact while pane remains alive", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "refresh-artifact",
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
  await writeFile(join(worker.dir, "result.md"), "artifact result\n", "utf8");

  await refreshRunStatus({
    runId: run.runId,
    cwd: dir,
    tmux: async (args) => {
      if (args[0] === "display-message") {
        return { stdout: "0\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    },
  });

  const status = JSON.parse(await readFile(join(worker.dir, "status.json"), "utf8"));
  assert.equal(status.state, "done");
  assert.equal(await readFile(join(worker.dir, "result.md"), "utf8"), "artifact result\n");
});

test("refreshRunStatus does not mark an interactive live pane done from stdout alone", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "refresh-live-pane",
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
  await writeFile(join(worker.dir, "stdout.log"), "# aweteam worker assignment\nClaude UI text\n", "utf8");

  await refreshRunStatus({
    runId: run.runId,
    cwd: dir,
    tmux: async (args) => {
      if (args[0] === "display-message") {
        return { stdout: "0\n", stderr: "", status: 0 };
      }
      return { stdout: "", stderr: "", status: 0 };
    },
  });

  const status = JSON.parse(await readFile(join(worker.dir, "status.json"), "utf8"));
  assert.equal(status.state, "running");
  assert.equal(await readFile(join(worker.dir, "result.md"), "utf8"), "");
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
  await writeFile(join(worker.dir, "stdout.log"), "claude result text\n\n[aweteam] worker finished with exit 0\n% peng@host %\n\u001b[?25h\u001b7\u001b8", "utf8");
  await writeFile(join(worker.dir, "exit-code.txt"), "0\n", "utf8");

  await refreshRunStatus({
    runId: run.runId,
    cwd: dir,
    tmux: async () => ({ stdout: "1\n", stderr: "", status: 0 }),
  });

  assert.equal(await readFile(join(worker.dir, "result.md"), "utf8"), "claude result text\n");
});

test("summarizeRun sends a summary-input path to the leader pane instead of the full payload", async () => {
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
  assert.match(calls.at(-2).at(-1), /summary-input\.md/);
  assert.doesNotMatch(calls.at(-2).at(-1), /worker result\n/);
  assert.deepEqual(calls.at(-1), ["send-keys", "-t", "%1", "Enter"]);
  assert.equal(await readFile(join(run.runDir, "leader", "summary-input.md"), "utf8"), summary);
});

test("collectLeaderSummary captures leader pane output into a durable summary file", async () => {
  const dir = await tempDir();
  const configPath = await writeJsonConfig(dir, sampleConfig());
  const run = await createRun({
    task: "task",
    configPath,
    cwd: dir,
    runId: "collect-summary",
    attach: false,
    tmux: async () => ({ stdout: "%1\n", stderr: "", status: 0 }),
  });

  const summary = await collectLeaderSummary({
    runId: run.runId,
    cwd: dir,
    tmux: async (args) => {
      assert.deepEqual(args, ["capture-pane", "-t", "%1", "-p", "-S", "-500"]);
      return { stdout: [
        "❯ Please synthesize the aweteam worker results",
        "  Read the merged worker results from: /tmp/summary-input.md",
        "",
        "  Read 1 file (ctrl+o to expand)",
        "",
        "\u001b[?25h⏺ Final summary",
        "",
        "  Overall verdict: pass",
        "",
        "⏺ Bash(aweteam collect-summary collect-summary)",
        "  ⎿  Running…",
        "────────────────────────────────",
        "❯ ",
      ].join("\n"), stderr: "", status: 0 };
    },
  });

  assert.equal(summary, "Final summary\n\nOverall verdict: pass\n");
  assert.equal(await readFile(join(run.runDir, "leader", "summary.md"), "utf8"), summary);
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

test("spawnWorker rejects profiles outside workers", async () => {
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
    /not in workers/,
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
  const split = calls.find((args) => args[0] === "split-window");
  assert.deepEqual(split.slice(0, 6), [
    "split-window",
    "-t",
    "%1",
    "-P",
    "-F",
    "#{pane_id}",
  ]);
  assert.match(split.at(-1), /^claude --settings \S+ --disallowedTools Edit,MultiEdit,NotebookEdit$/);
  const assignmentSend = calls.find((args) => args[0] === "send-keys" && args[3] === "-l");
  assert.doesNotMatch(assignmentSend.at(-1), /\n/);
  assert.match(assignmentSend.at(-1), /Read your task from .*task\.md\./);

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
