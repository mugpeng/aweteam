import {
  createRun,
  defaultConfigPath,
  displayRunStatus,
  focusRunPane,
  spawnWorker,
  statusRun,
  summarizeRun,
} from "./core.mjs";

export async function runCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = console.log,
  stderr = console.error,
  tmux,
  isTTY = process.stdout.isTTY === true,
} = {}) {
  try {
    const command = argv[0];
    if (!command || command === "-h" || command === "--help") {
      stdout(helpText());
      return 0;
    }
    if (command.startsWith("--")) {
      const parsed = parseRunArgs(argv, cwd, { allowGeneratedTask: true });
      applyAttachPolicy(parsed, isTTY);
      const run = await createRun({ ...parsed, cwd, tmux });
      stdout(`run_id: ${run.runId}`);
      stdout(`session: ${run.sessionName}`);
      stdout(`leader: ${run.leaderPane}`);
      if (!parsed.attach) stdout(`attach: tmux attach -t ${run.sessionName}`);
      return 0;
    }
    if (command === "run") {
      const parsed = parseRunArgs(argv.slice(1), cwd);
      applyAttachPolicy(parsed, isTTY);
      const run = await createRun({ ...parsed, cwd, tmux });
      stdout(`run_id: ${run.runId}`);
      stdout(`session: ${run.sessionName}`);
      stdout(`leader: ${run.leaderPane}`);
      if (!parsed.attach) stdout(`attach: tmux attach -t ${run.sessionName}`);
      return 0;
    }
    if (command === "spawn") {
      const parsed = parseSpawnArgs(argv.slice(1));
      const worker = await spawnWorker({ ...parsed, cwd, tmux });
      stdout(`worker: ${worker.name}`);
      stdout(`profile: ${worker.profile}`);
      stdout(`pane: ${worker.pane}`);
      return 0;
    }
    if (command === "status") {
      const runId = argv[1];
      if (!runId) throw new Error("status requires <run-id>");
      const watch = argv.includes("--watch");
      if (watch) {
        await watchStatus({ runId, cwd, stdout, tmux });
      } else {
        const run = await statusRun({ runId, cwd, tmux });
        stdout(displayRunStatus(run));
      }
      return 0;
    }
    if (command === "focus") {
      const runId = argv[1];
      const target = argv[2];
      if (!runId || !target) throw new Error("focus requires <run-id> <leader|worker-name|profile>");
      const pane = await focusRunPane({ runId, target, cwd, tmux });
      stdout(`focused: ${target}\t${pane}`);
      return 0;
    }
    if (command === "summarize") {
      const runId = argv[1];
      if (!runId) throw new Error("summarize requires <run-id>");
      await summarizeRun({ runId, cwd, tmux });
      stdout(`summary requested: ${runId}`);
      return 0;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function applyAttachPolicy(parsed, isTTY) {
  if (!isTTY) {
    parsed.attach = false;
  }
}

function parseRunArgs(args, cwd, options = {}) {
  const values = {
    task: "",
    configPath: defaultConfigPath(cwd),
    runId: undefined,
    attach: true,
  };
  const taskParts = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config") {
      values.configPath = args[++index];
    } else if (arg === "--run-id") {
      values.runId = args[++index];
    } else if (arg === "--no-attach") {
      values.attach = false;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown run option: ${arg}`);
    } else {
      taskParts.push(arg);
    }
  }
  values.task = taskParts.join(" ").trim();
  if (!values.task) {
    if (options.allowGeneratedTask) {
      values.task = generateTopic();
    } else {
      throw new Error("run requires <task>");
    }
  }
  return values;
}

function generateTopic() {
  return `aweteam leader session ${new Date().toISOString()}`;
}

function parseSpawnArgs(args) {
  const values = {
    runId: "",
    profileName: "",
    taskFile: "",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run-id") {
      values.runId = args[++index];
    } else if (arg === "--profile") {
      values.profileName = args[++index];
    } else if (arg === "--task-file") {
      values.taskFile = args[++index];
    } else {
      throw new Error(`unknown spawn option: ${arg}`);
    }
  }
  if (!values.runId) throw new Error("spawn requires --run-id");
  if (!values.profileName) throw new Error("spawn requires --profile");
  if (!values.taskFile) throw new Error("spawn requires --task-file");
  return values;
}

function helpText() {
  return `aweteam - minimal tmux handoff interface for local coding agents

Usage:
  aweteam --config aweteam.json
  aweteam run <task> [--config aweteam.json] [--run-id id] [--no-attach]
  aweteam spawn --run-id id --profile name --task-file path
  aweteam status <run-id>
  aweteam focus <run-id> <leader|worker-name|profile>
  aweteam summarize <run-id>

Workflow:
  1. Configure one leader and a default worker pool in aweteam.json.
  2. Start aweteam; it opens a tmux session focused on leader/main.
  3. Discuss the plan with the leader in its real CLI.
  4. After you confirm, the leader writes task files and calls aweteam spawn.
  5. Switch between leader/main and worker-N panes directly in tmux.

Commands:
  aweteam --config aweteam.json
      Start a leader session with an auto-generated topic.

  aweteam run <task> --config aweteam.json
      Start a leader session with an explicit topic.

  aweteam spawn --run-id <id> --profile <name> --task-file <path>
      Create one worker pane from an allowed default_workers profile.

  aweteam status <run-id>
      Refresh and print the run id, tmux session, leader pane, worker states, and worker panes.

  aweteam status <run-id> --watch
      Continuously refresh status for use in a tmux status pane.

  aweteam focus <run-id> <leader|worker-name|profile>
      Select the leader or worker pane inside the aweteam tmux session.

  aweteam summarize <run-id>
      Send collected worker results back to the leader pane for final synthesis.

Examples:
  aweteam --config aweteam.json
  aweteam run "创建三个 agent 实现登录模块" --config aweteam.json
  aweteam status 20260506180000

Config:
  aweteam reads JSON only. A run freezes config into
  .aweteam/runs/<run-id>/config.resolved.json, so later edits to aweteam.json do
  not change an existing run.
`;
}

async function watchStatus({ runId, cwd, stdout, tmux }) {
  while (true) {
    const run = await statusRun({ runId, cwd, tmux });
    stdout("\x1Bc" + displayRunStatus(run));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
