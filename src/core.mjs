import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export async function loadConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw);
  validateConfig(parsed);

  const workerProfiles = {};
  for (const [name, profile] of Object.entries(parsed.worker_profiles)) {
    workerProfiles[name] = normalizeProfile(name, profile, "worker");
  }

  return {
    leader: normalizeProfile(parsed.leader.name ?? "main", parsed.leader, "leader"),
    default_workers: [...parsed.default_workers],
    worker_profiles: workerProfiles,
  };
}

export async function createRun(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configPath = resolve(options.configPath ?? join(cwd, "aweteam.json"));
  const config = await loadConfig(configPath);
  const runId = options.runId ?? makeRunId();
  const sessionName = `aweteam-${runId}`;
  const runDir = join(cwd, ".aweteam", "runs", runId);
  const leaderDir = join(runDir, "leader");

  await mkdir(leaderDir, { recursive: true });
  await mkdir(join(runDir, "workers"), { recursive: true });

  const task = options.task ?? "";
  const instructions = renderLeaderInstructions({ runId, config, task });
  const resolvedConfig = { ...config, config_path: configPath };
  const leaderCommand = buildLeaderCommand(config.leader, instructions);
  const pane = await tmuxOrThrow(options.tmux, [
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-n",
    "leader-main",
    leaderCommand,
  ]);
  const leaderPane = pane.stdout.trim() || "leader-main";
  await pipePane(options.tmux, leaderPane, join(leaderDir, "stdout.log"));

  const runJson = {
    run_id: runId,
    task,
    cwd,
    session_name: sessionName,
    config_path: configPath,
    leader: {
      profile: config.leader.name,
      pane: leaderPane,
    },
    workers: [],
    created_at: new Date().toISOString(),
  };
  const status = {
    state: "running",
    run_id: runId,
    session_name: sessionName,
    updated_at: new Date().toISOString(),
  };

  await writeJson(join(runDir, "config.resolved.json"), resolvedConfig);
  await writeJson(join(runDir, "run.json"), runJson);
  await writeJson(join(runDir, "status.json"), status);
  await writeJson(join(leaderDir, "status.json"), {
    role: "leader",
    state: "running",
    pane: leaderPane,
    updated_at: new Date().toISOString(),
  });
  await writeFile(join(leaderDir, "instructions.md"), instructions, "utf8");
  await writeFile(join(leaderDir, "stdout.log"), "", "utf8");
  await writeFile(join(leaderDir, "stderr.log"), "", "utf8");
  await appendEvent(runDir, {
    type: "run.created",
    run_id: runId,
    session_name: sessionName,
    pane: leaderPane,
  });

  if (options.attach !== false) {
    await tmuxOrThrow(options.tmux, ["attach-session", "-t", sessionName]);
  }

  return { runId, sessionName, runDir, leaderPane };
}

export async function spawnWorker(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const runDir = join(cwd, ".aweteam", "runs", options.runId);
  const config = JSON.parse(await readFile(join(runDir, "config.resolved.json"), "utf8"));
  const runJson = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  const profileName = options.profileName;

  if (!config.default_workers.includes(profileName)) {
    throw new Error(`worker profile "${profileName}" is not in default_workers`);
  }
  const profile = config.worker_profiles[profileName];
  if (!profile) {
    throw new Error(`worker profile "${profileName}" is not defined`);
  }
  const existingCount = runJson.workers.filter((worker) => worker.profile === profileName).length;
  const maxInstances = profile.max_instances ?? 1;
  if (existingCount >= maxInstances) {
    throw new Error(`worker profile "${profileName}" exceeded max_instances=${maxInstances}`);
  }

  const workerNumber = runJson.workers.length + 1;
  const workerName = `worker-${workerNumber}`;
  const workerDir = join(runDir, "workers", workerName);
  const taskText = await readFile(options.taskFile, "utf8");

  await mkdir(workerDir, { recursive: true });
  await writeJson(join(workerDir, "profile.json"), { name: profileName, ...profile });
  await writeFile(join(workerDir, "task.md"), taskText, "utf8");
  await writeFile(join(workerDir, "stdout.log"), "", "utf8");
  await writeFile(join(workerDir, "stderr.log"), "", "utf8");
  await writeFile(join(workerDir, "result.md"), "", "utf8");

  const workerCommand = buildWorkerCommand(profile, join(workerDir, "task.md"));
  const pane = await tmuxOrThrow(options.tmux, [
    "split-window",
    "-t",
    runJson.session_name,
    "-P",
    "-F",
    "#{pane_id}",
    workerCommand,
  ]);
  const paneId = pane.stdout.trim() || workerName;
  await pipePane(options.tmux, paneId, join(workerDir, "stdout.log"));

  const workerStatus = {
    role: "worker",
    state: "running",
    name: workerName,
    profile: profileName,
    pane: paneId,
    updated_at: new Date().toISOString(),
  };
  await writeJson(join(workerDir, "status.json"), workerStatus);

  runJson.workers.push({
    name: workerName,
    profile: profileName,
    pane: paneId,
    dir: workerDir,
    created_at: new Date().toISOString(),
  });
  await writeJson(join(runDir, "run.json"), runJson);
  await appendEvent(runDir, {
    type: "worker.spawned",
    run_id: options.runId,
    worker: workerName,
    profile: profileName,
    pane: paneId,
  });

  return { name: workerName, profile: profileName, pane: paneId, dir: workerDir };
}

export async function statusRun({ runId, cwd = process.cwd() }) {
  const runDir = join(resolve(cwd), ".aweteam", "runs", runId);
  return JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
}

export function buildLeaderCommand(profile, instructions) {
  const extraArgs = [];
  if (profile.provider === "claude" && instructions) {
    extraArgs.push("--append-system-prompt", instructions);
  }
  return buildCommand(profile, extraArgs);
}

export function buildWorkerCommand(profile, taskPath) {
  return `${buildCommand(profile, taskPath ? ["<", taskPath] : null)}`;
}

async function tmuxOrThrow(tmux, args) {
  const runner = tmux ?? realTmux;
  const result = await runner(args);
  if (result.status !== 0) {
    throw new Error(`tmux failed: ${result.stderr || args.join(" ")}`);
  }
  return result;
}

async function realTmux(args) {
  const runner = createRealTmuxRunner();
  return runner(args);
}

export function createRealTmuxRunner({ execFile: execFileImpl = execFile, spawn: spawnImpl = spawn } = {}) {
  const execFileAsyncImpl = promisify(execFileImpl);
  return async function runTmux(args) {
    if (args[0] === "attach-session") {
      return runTmuxAttached(spawnImpl, args);
    }
    try {
      const { stdout, stderr } = await execFileAsyncImpl("tmux", args);
      return { stdout, stderr, status: 0 };
    } catch (error) {
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? error.message,
        status: typeof error.code === "number" ? error.code : 1,
      };
    }
  };
}

function runTmuxAttached(spawnImpl, args) {
  return new Promise((resolve) => {
    const child = spawnImpl("tmux", args, { stdio: "inherit" });
    child.on("error", (error) => {
      resolve({ stdout: "", stderr: error.message, status: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout: "", stderr: "", status: code ?? 0 });
    });
  });
}

async function pipePane(tmux, paneId, logPath) {
  await tmuxOrThrow(tmux, [
    "pipe-pane",
    "-o",
    "-t",
    paneId,
    `cat >> ${shellQuote(logPath)}`,
  ]);
}

function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("config must be an object");
  }
  if (!config.leader || typeof config.leader !== "object") {
    throw new Error("config.leader is required");
  }
  if (!Array.isArray(config.default_workers)) {
    throw new Error("config.default_workers must be an array");
  }
  if (!config.worker_profiles || typeof config.worker_profiles !== "object") {
    throw new Error("config.worker_profiles is required");
  }
  for (const name of config.default_workers) {
    if (!config.worker_profiles[name]) {
      throw new Error(`default worker "${name}" has no worker_profiles entry`);
    }
  }
}

function normalizeProfile(name, profile, role) {
  if (!profile.command || typeof profile.command !== "string") {
    throw new Error(`${role} profile "${name}" requires command`);
  }
  return {
    name,
    role,
    provider: profile.provider ?? "custom",
    command: profile.command,
    model: profile.model,
    env: resolveEnvMap(profile.env ?? {}),
    max_instances: role === "worker" ? profile.max_instances ?? 1 : undefined,
  };
}

function resolveEnvMap(env) {
  const resolved = {};
  for (const [key, value] of Object.entries(env)) {
    resolved[key] = resolveEnvValue(String(value), key);
  }
  return resolved;
}

function resolveEnvValue(value, key) {
  const exact = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (!exact) return value;
  const envName = exact[1];
  const resolved = process.env[envName];
  if (resolved === undefined) {
    throw new Error(`missing environment variable ${envName} for ${key}`);
  }
  return resolved;
}

function buildCommand(profile, suffix) {
  const words = [];
  for (const [key, value] of Object.entries(profile.env ?? {})) {
    words.push(`${key}=${shellQuote(String(value))}`);
  }
  words.push(shellQuote(profile.command));
  if (profile.model) {
    words.push("--model", shellQuote(profile.model));
  }
  if (Array.isArray(suffix)) {
    words.push(...suffix.map(shellQuoteShellOperatorAware));
  }
  return words.join(" ");
}

function shellQuoteShellOperatorAware(value) {
  if (value === "<") return value;
  return shellQuote(value);
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function renderLeaderInstructions({ runId, config, task }) {
  const pool = config.default_workers
    .map((name) => {
      const profile = config.worker_profiles[name];
      return `- ${name}: provider=${profile.provider}, model=${profile.model ?? "default"}, max_instances=${profile.max_instances ?? 1}`;
    })
    .join("\n");
  return `# aweteam leader instructions

You are running inside aweteam run ${runId}.

Initial topic:
${task || "(none)"}

aweteam is a thin handoff interface. It does not split tasks, infer approval, or
summarize worker results. You are the leader/main agent.

Default worker pool:
${pool}

When the user confirms a plan and asks you to create workers, write each worker
task to a task file under this run directory, then call:

\`\`\`bash
aweteam spawn --run-id ${runId} --profile <profile-name> --task-file <task-file>
\`\`\`

Only use profiles from the default worker pool. Do not create ad-hoc provider
commands. Respect max_instances.
`;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendEvent(runDir, event) {
  const line = JSON.stringify({ ...event, at: new Date().toISOString() });
  await writeFile(join(runDir, "events.jsonl"), `${line}\n`, { flag: "a" });
}

function makeRunId() {
  return new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
}

export async function assertReadableFile(path) {
  await access(path, fsConstants.R_OK);
}

export async function copyTaskFile(from, to) {
  await copyFile(from, to);
}

export function defaultConfigPath(cwd = process.cwd()) {
  return join(cwd, "aweteam.json");
}

export function displayRunStatus(run) {
  const workers = run.workers.map((worker) => `${worker.name}\t${worker.profile}\t${worker.pane}`).join("\n");
  return [
    `run_id: ${run.run_id}`,
    `session: ${run.session_name}`,
    `leader: ${run.leader.profile}\t${run.leader.pane}`,
    workers ? `workers:\n${workers}` : "workers: none",
  ].join("\n");
}
