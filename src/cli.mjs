import { createRequire } from "node:module";
import {
  createRun,
  collectLeaderSummary,
  defaultConfigPath,
  dispatchOnce,
  dispatchRun,
  displayRunStatus,
  focusRunPane,
  spawnWorker,
  statusRun,
  summarizeRun,
} from "./core.mjs";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

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
    if (command === "-v" || command === "--version") {
      stdout(`aweteam ${version}`);
      return 0;
    }
    if (!command || command === "-h" || command === "--help") {
      stdout(helpText());
      return 0;
    }
    if (command.startsWith("--")) {
      const parsed = parseRunArgs(argv, cwd, { allowGeneratedTask: true });
      applyAttachPolicy(parsed, isTTY);
      const run = await createRun({ ...parsed, cwd, tmux, dispatcher: true });
      stdout(`run_id: ${run.runId}`);
      stdout(`session: ${run.sessionName}`);
      stdout(`leader: ${run.leaderPane}`);
      if (!parsed.attach) stdout(`attach: tmux attach -t ${run.sessionName}`);
      return 0;
    }
    if (command === "run") {
      const parsed = parseRunArgs(argv.slice(1), cwd);
      applyAttachPolicy(parsed, isTTY);
      const run = await createRun({ ...parsed, cwd, tmux, dispatcher: true });
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
    if (command === "dispatch") {
      const runId = argv[1];
      if (!runId) throw new Error("dispatch requires <run-id>");
      if (argv.includes("--once")) {
        const handled = await dispatchOnce({ runId, cwd, tmux });
        for (const item of handled) {
          stdout(item.error
            ? `error: ${item.request}\t${item.error}`
            : `spawned: ${item.request}\t${item.worker}\t${item.profile}\t${item.pane}`);
        }
      } else {
        await dispatchRun({ runId, cwd, tmux });
      }
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
    if (command === "collect-summary") {
      const runId = argv[1];
      if (!runId) throw new Error("collect-summary requires <run-id>");
      const summary = await collectLeaderSummary({ runId, cwd, tmux });
      stdout(`summary: .aweteam/runs/${runId}/leader/summary.md`);
      if (summary) stdout(summary);
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
  return `Usage: aweteam [OPTIONS] COMMAND [ARGS]...

  Thin tmux handoff interface for local AI coding teams.

Options:
  -v, --version  Show the version and exit.
  -h, --help     Show this message and exit.

Commands:
  run     Start a leader session with an explicit task.
  status  Show run status (tmux session, leader, workers).
  focus   Select a tmux pane inside the run session.
`;
}

async function watchStatus({ runId, cwd, stdout, tmux }) {
  while (true) {
    const run = await statusRun({ runId, cwd, tmux });
    stdout("\x1Bc" + displayRunStatus(run));
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
