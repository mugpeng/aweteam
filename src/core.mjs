import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export async function loadConfig(configPath) {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw);
  validateConfig(parsed);

  const leaderName = selectedLeaderProfileName(parsed.leader);
  const profiles = {};
  for (const [name, profile] of Object.entries(parsed.profiles)) {
    const role = name === leaderName ? "leader" : "worker";
    profiles[name] = normalizeProfile(name, profile, role);
  }
  for (const name of parsed.workers) {
    profiles[name] = normalizeProfile(name, parsed.profiles[name], "worker");
  }

  return {
    leader: profiles[leaderName],
    leader_policy: normalizeLeaderPolicy(parsed.leader_policy),
    workers: [...parsed.workers],
    profiles,
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
  await mkdir(join(leaderDir, "outbox"), { recursive: true });
  await mkdir(join(leaderDir, "inbox"), { recursive: true });
  await mkdir(join(leaderDir, "tasks"), { recursive: true });
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
    "-P",
    "-F",
    "#{pane_id}",
    leaderCommand,
  ]);
  const leaderPane = pane.stdout.trim() || "leader-main";
  await pipePane(options.tmux, leaderPane, join(leaderDir, "stdout.log"));
  await configureTmuxTeamConsole(options.tmux, {
    sessionName,
    leaderPane,
    workers: [],
  });

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

  if (options.dispatcher === true) {
    const dispatcherPane = await startDispatcherPane(options.tmux, { cwd, runId, sessionName, runDir });
    runJson.dispatcher = { pane: dispatcherPane };
    await writeJson(join(runDir, "run.json"), runJson);
    await appendEvent(runDir, {
      type: "dispatcher.started",
      run_id: runId,
      pane: dispatcherPane,
    });
  }

  if (options.attach !== false) {
    await tmuxOrThrow(options.tmux, ["attach-session", "-t", sessionName]);
  }

  return { runId, sessionName, runDir, leaderPane };
}

export async function spawnWorker(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const runDir = join(cwd, ".aweteam", "runs", options.runId);
  return withRunLock(runDir, async () => {
    const config = JSON.parse(await readFile(join(runDir, "config.resolved.json"), "utf8"));
    const runJson = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
    const profileName = options.profileName;

    if (!config.workers.includes(profileName)) {
      throw new Error(`worker profile "${profileName}" is not in workers`);
    }
    const profile = config.profiles[profileName];
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

    const workerCommand = buildWorkerCommand(profile, join(workerDir, "task.md"), renderWorkerAssignment({
      workerName,
      profileName,
      taskPath: join(workerDir, "task.md"),
      resultPath: join(workerDir, "result.md"),
    }));
    const pane = await tmuxOrThrow(options.tmux, [
      "split-window",
      "-t",
      runJson.leader.pane,
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
    await configureTmuxTeamConsole(options.tmux, {
      sessionName: runJson.session_name,
      leaderPane: runJson.leader.pane,
      workers: runJson.workers,
    });

    return { name: workerName, profile: profileName, pane: paneId, dir: workerDir };
  });
}

export async function dispatchOnce({ runId, cwd = process.cwd(), tmux } = {}) {
  const resolvedCwd = resolve(cwd);
  const runDir = join(resolvedCwd, ".aweteam", "runs", runId);
  const outboxDir = join(runDir, "leader", "outbox");
  const inboxDir = join(runDir, "leader", "inbox");
  const taskDir = join(runDir, "leader", "tasks");
  await mkdir(inboxDir, { recursive: true });
  await mkdir(taskDir, { recursive: true });

  let entries = [];
  try {
    entries = await readdir(outboxDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const handled = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const requestId = entry.slice(0, -".json".length);
    const requestPath = join(outboxDir, entry);
    try {
      const request = JSON.parse(await readFile(requestPath, "utf8"));
      const profileName = String(request.profile ?? "");
      const taskText = String(request.task ?? "").trim();
      if (!profileName) throw new Error("dispatch request requires profile");
      if (!taskText) throw new Error("dispatch request requires task");

      const taskFile = join(taskDir, `${requestId}.md`);
      await writeFile(taskFile, `${taskText}\n`, "utf8");
      const worker = await spawnWorker({ runId, cwd: resolvedCwd, profileName, taskFile, tmux });
      await writeFile(join(inboxDir, `${requestId}.result.md`), [
        `spawned: ${worker.name}`,
        `profile: ${worker.profile}`,
        `pane: ${worker.pane}`,
        `task: ${taskFile}`,
        "",
      ].join("\n"), "utf8");
      await rm(requestPath);
      handled.push({ request: requestId, worker: worker.name, profile: worker.profile, pane: worker.pane });
    } catch (error) {
      await writeFile(join(inboxDir, `${requestId}.error.md`), `${error instanceof Error ? error.message : String(error)}\n`, "utf8");
      await rm(requestPath, { force: true });
      handled.push({ request: requestId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return handled;
}

export async function dispatchRun({ runId, cwd = process.cwd(), tmux, intervalMs = 1000 } = {}) {
  while (true) {
    await dispatchOnce({ runId, cwd, tmux });
    await refreshRunStatus({ runId, cwd, tmux });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }
}

export async function statusRun({ runId, cwd = process.cwd(), tmux } = {}) {
  await refreshRunStatus({ runId, cwd, tmux });
  const runDir = join(resolve(cwd), ".aweteam", "runs", runId);
  const runJson = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  return hydrateRunWorkerStatuses(runJson);
}

export async function focusRunPane({ runId, target, cwd = process.cwd(), tmux }) {
  const run = await statusRun({ runId, cwd, tmux });
  const pane = target === "leader"
    ? run.leader.pane
    : run.workers.find((worker) => worker.name === target || worker.profile === target)?.pane;
  if (!pane) {
    throw new Error(`unknown focus target: ${target}`);
  }
  await tmuxOrThrow(tmux, ["select-pane", "-t", pane]);
  return pane;
}

export async function summarizeRun({ runId, cwd = process.cwd(), tmux } = {}) {
  const run = await statusRun({ runId, cwd, tmux });
  const runDir = join(resolve(cwd), ".aweteam", "runs", runId);
  const sections = [];
  for (const worker of run.workers) {
    const result = await readFile(join(worker.dir, "result.md"), "utf8");
    sections.push(`## ${worker.name} (${worker.profile})\n\n${result.trim() || "(no result)"}`);
  }
  const summaryInput = [
    "# aweteam worker results",
    "",
    `Run: ${runId}`,
    `Initial task: ${run.task}`,
    "",
    "Please synthesize the worker results into a concise final answer for the user. Call out disagreements, failures, or missing coverage if present.",
    "",
    ...sections,
    "",
  ].join("\n");
  const summaryInputPath = join(runDir, "leader", "summary-input.md");
  await writeFile(summaryInputPath, summaryInput, "utf8");
  const leaderPrompt = [
    "Please synthesize the aweteam worker results into a concise final answer for the user.",
    `Read the merged worker results from: ${summaryInputPath}`,
    "Call out disagreements, failures, or missing coverage if present.",
    "After you answer, aweteam can persist the pane output with: aweteam collect-summary " + runId,
  ].join("\n");
  await tmuxOrThrow(tmux, ["send-keys", "-t", run.leader.pane, "-l", "--", leaderPrompt]);
  await tmuxOrThrow(tmux, ["send-keys", "-t", run.leader.pane, "Enter"]);
  await appendEvent(runDir, {
    type: "leader.summary_requested",
    run_id: runId,
    pane: run.leader.pane,
  });
  return summaryInput;
}

export async function collectLeaderSummary({ runId, cwd = process.cwd(), tmux } = {}) {
  const run = await statusRun({ runId, cwd, tmux });
  const runDir = join(resolve(cwd), ".aweteam", "runs", runId);
  const capture = await tmuxOrThrow(tmux, ["capture-pane", "-t", run.leader.pane, "-p", "-S", "-500"]);
  const summary = `${cleanLeaderSummary(capture.stdout)}\n`;
  await writeFile(join(runDir, "leader", "summary.md"), summary, "utf8");
  await appendEvent(runDir, {
    type: "leader.summary_collected",
    run_id: runId,
    pane: run.leader.pane,
  });
  return summary;
}

export async function refreshRunStatus({ runId, cwd = process.cwd(), tmux } = {}) {
  const runner = tmux ?? realTmux;
  const runDir = join(resolve(cwd), ".aweteam", "runs", runId);
  const runJson = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  let changed = false;
  for (const worker of runJson.workers) {
    const statusPath = join(worker.dir, "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    if (status.state !== "running") continue;
    const stdoutText = await readFile(join(worker.dir, "stdout.log"), "utf8");
    const artifactText = await readExistingWorkerResult(worker.dir);
    if (artifactText) {
      const updated = { ...status, state: "done", updated_at: new Date().toISOString() };
      await writeJson(statusPath, updated);
      await setWorkerPaneTitle(runner, worker, "done");
      await appendEvent(runDir, {
        type: "worker.completed",
        run_id: runId,
        worker: worker.name,
        profile: worker.profile,
        pane: worker.pane,
      });
      changed = true;
      continue;
    }
    const result = extractWorkerResult(stdoutText, worker.profile);
    const exitCode = await readWorkerExitCode(worker.dir);
    const dead = await isPaneDead(runner, worker.pane);
    if (exitCode === null && !dead) continue;
    const state = exitCode === null
      ? result.text ? "done" : "failed"
      : exitCode === 0 && result.text ? "done" : "failed";
    const updated = { ...status, state, updated_at: new Date().toISOString() };
    await writeJson(statusPath, updated);
    await writeFile(join(worker.dir, "result.md"), result.text ? `${result.text.trim()}\n` : "", "utf8");
    await setWorkerPaneTitle(runner, worker, state);
    await appendEvent(runDir, {
      type: state === "done" ? "worker.completed" : "worker.failed",
      run_id: runId,
      worker: worker.name,
      profile: worker.profile,
      pane: worker.pane,
    });
    changed = true;
  }
  if (changed) {
    const statuses = await Promise.all(runJson.workers.map(async (worker) => JSON.parse(await readFile(join(worker.dir, "status.json"), "utf8"))));
    if (statuses.length > 0 && statuses.every((status) => status.state !== "running")) {
      await writeJson(join(runDir, "status.json"), {
        state: statuses.every((status) => status.state === "done") ? "done" : "failed",
        run_id: runId,
        session_name: runJson.session_name,
        updated_at: new Date().toISOString(),
      });
    }
  }
  return runJson;
}

export function buildLeaderCommand(profile, instructions) {
  const extraArgs = [];
  if (profile.provider === "claude") {
    extraArgs.push("--disallowedTools", "Task,Edit,MultiEdit,NotebookEdit,Write");
  }
  if (profile.provider === "claude" && instructions) {
    extraArgs.push("--append-system-prompt", instructions);
  }
  if (profile.provider === "codex") {
    const modelArgs = profile.model ? ["--model", profile.model] : [];
    const promptArgs = instructions ? [instructions] : [];
    return buildShellCommand(profile, [...modelArgs, ...promptArgs]);
  }
  return buildCommand(profile, extraArgs);
}

function normalizeLeaderPolicy(policy = {}) {
  return {
    mode: policy.mode ?? "delegate_only",
    plan_approval_required: policy.plan_approval_required ?? true,
    native_subagents: policy.native_subagents ?? "disallow",
  };
}

export function buildWorkerCommand(profile, taskPath, assignmentPrompt) {
  if (profile.provider === "claude") {
    return buildCommand(profile, assignmentPrompt ? [assignmentPrompt] : []);
  }
  if (profile.provider === "codex") {
    const modelArgs = profile.model ? ["--model", profile.model] : [];
    const promptArgs = assignmentPrompt ? [assignmentPrompt] : [];
    return buildShellCommand(profile, [...modelArgs, ...promptArgs]);
  }
  return buildCommand(profile, assignmentPrompt ? [assignmentPrompt] : []);
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

async function startDispatcherPane(tmux, { cwd, runId, sessionName, runDir }) {
  const command = buildDispatcherCommand({ cwd, runId });
  const pane = await tmuxOrThrow(tmux, [
    "new-window",
    "-d",
    "-t",
    sessionName,
    "-n",
    "aweteam-dispatcher",
    "-P",
    "-F",
    "#{pane_id}",
    command,
  ]);
  const paneId = pane.stdout.trim() || "dispatcher";
  await pipePane(tmux, paneId, join(runDir, "dispatcher.log"));
  return paneId;
}

export function buildDispatcherCommand({ cwd, runId }) {
  const launcher = process.argv[1]
    ? `${shellQuote(process.execPath)} ${shellQuote(process.argv[1])}`
    : "aweteam";
  return `cd ${shellQuote(cwd)} && ${launcher} dispatch ${shellQuote(runId)}`;
}

async function configureTmuxTeamConsole(tmux, { sessionName, leaderPane, workers }) {
  await tmuxOrThrow(tmux, ["select-pane", "-t", leaderPane, "-T", "leader main"]);
  for (const worker of workers) {
    await tmuxOrThrow(tmux, ["select-pane", "-t", worker.pane, "-T", `${worker.name} ${worker.profile} ${worker.state ?? "running"}`]);
  }
  await tmuxOrThrow(tmux, ["set-option", "-t", sessionName, "mouse", "on"]);
  await tmuxOrThrow(tmux, ["bind-key", "-T", "prefix", "1", "select-pane", "-t", leaderPane]);
  for (let index = 0; index < workers.length && index < 8; index += 1) {
    await tmuxOrThrow(tmux, ["bind-key", "-T", "prefix", String(index + 2), "select-pane", "-t", workers[index].pane]);
  }
  await tmuxOrThrow(tmux, ["select-layout", "-t", sessionName, "main-vertical"]);
}

function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("config must be an object");
  }
  if (!config.profiles || typeof config.profiles !== "object") {
    throw new Error("config.profiles is required");
  }
  const leaderName = selectedLeaderProfileName(config.leader);
  if (!leaderName) {
    throw new Error("config.leader must select a profile");
  }
  if (!config.profiles[leaderName]) {
    throw new Error(`leader profile "${leaderName}" has no profiles entry`);
  }
  if (!Array.isArray(config.workers)) {
    throw new Error("config.workers must be an array");
  }
  for (const name of config.workers) {
    if (!config.profiles[name]) {
      throw new Error(`worker profile "${name}" has no profiles entry`);
    }
  }
}

function selectedLeaderProfileName(leader) {
  if (typeof leader === "string") return leader;
  if (leader && typeof leader === "object") return leader.profile ?? leader.name;
  return "";
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

function buildCommand(profile, args) {
  const words = [shellQuote(profile.command)];
  if (profile.env && Object.keys(profile.env).length > 0) {
    words.push("--settings", shellQuote(JSON.stringify({ env: profile.env })));
  }
  if (Array.isArray(args)) {
    words.push(...args.map(shellQuoteShellOperatorAware));
  }
  return words.join(" ");
}

function buildShellCommand(profile, args) {
  const words = [];
  if (profile.env && Object.keys(profile.env).length > 0) {
    words.push(...Object.entries(profile.env).map(([key, value]) => `${key}=${shellQuote(String(value))}`));
  }
  words.push(shellQuote(profile.command));
  if (Array.isArray(args)) {
    words.push(...args.map(shellQuoteShellOperatorAware));
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
  const pool = config.workers
    .map((name) => {
      const profile = config.profiles[name];
      return `- ${name}: provider=${profile.provider}, model=${profile.model ?? "default"}, max_instances=${profile.max_instances ?? 1}`;
    })
    .join("\n");
  return `# aweteam leader instructions

You are running inside aweteam run ${runId}.

Initial topic:
${task || "(none)"}

aweteam is a thin handoff interface. It records handoff artifacts and can send
worker results back to you, but you own task splitting, approval, and final
synthesis as the leader/main agent.

You are a coordinator-only leader. Do not execute the user task yourself. Your job is to understand the request, propose a worker allocation plan, wait for explicit user confirmation, then create aweteam worker panes.

In aweteam, "agent" means an aweteam tmux worker pane only. Do not use Claude Code native Task, Explore, or subagent tools as substitutes for aweteam workers.

Default worker pool:
${pool}

When the user confirms a plan and asks you to create workers, write each worker
request as one JSON file under this outbox directory:

\`\`\`text
.aweteam/runs/${runId}/leader/outbox/<request-id>.json
\`\`\`

Use this JSON shape:

\`\`\`json
{
  "profile": "<profile-name>",
  "task": "Exact assignment for this worker."
}
\`\`\`

Use your shell/Bash tool from this leader page to create these JSON files. The
user should not need to run aweteam spawn from another terminal for normal
worker creation.

The aweteam dispatcher watches the outbox and creates worker panes for you.
It writes creation results back under:

\`\`\`text
.aweteam/runs/${runId}/leader/inbox/
\`\`\`

This is the assignment protocol: choose the worker profile explicitly and put
that worker's exact assignment in the JSON task. To assign different work to
different workers, create one JSON request per worker.

Only use profiles from the default worker pool. Do not create ad-hoc provider
commands. Respect max_instances.
`;
}

function renderWorkerAssignment({ workerName, profileName, taskPath, resultPath }) {
  return [
    "# aweteam worker assignment",
    "",
    `Worker: ${workerName}`,
    `Profile: ${profileName}`,
    "",
    "Read your task from this file:",
    taskPath,
    "",
    "When you are done, write your final answer as plain text to this file:",
    resultPath,
    "",
    "Keep this agent session open after completing the task so the user can inspect or continue the worker conversation in tmux.",
  ].join("\n");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function appendEvent(runDir, event) {
  const line = JSON.stringify({ ...event, at: new Date().toISOString() });
  await writeFile(join(runDir, "events.jsonl"), `${line}\n`, { flag: "a" });
}

async function withRunLock(runDir, operation) {
  const lockDir = join(runDir, ".lock");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await mkdir(lockDir);
      try {
        return await operation();
      } finally {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`timed out waiting for run lock: ${runDir}`);
}

async function readWorkerExitCode(workerDir) {
  try {
    const raw = await readFile(join(workerDir, "exit-code.txt"), "utf8");
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isNaN(value) ? null : value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readExistingWorkerResult(workerDir) {
  try {
    const text = await readFile(join(workerDir, "result.md"), "utf8");
    return text.trim();
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function setWorkerPaneTitle(tmux, worker, state) {
  await tmuxOrThrow(tmux, ["select-pane", "-t", worker.pane, "-T", `${worker.name} ${worker.profile} ${state}`]);
}

async function isPaneDead(tmux, paneId) {
  if (!tmux || !paneId) return false;
  const result = await tmux(["display-message", "-t", paneId, "-p", "#{pane_dead}"]);
  if (result.status !== 0) return true;
  return result.stdout.trim() === "1";
}

function extractWorkerResult(stdoutText, profileName = "") {
  if (stdoutText.includes('"type":"turn.completed"') || stdoutText.includes('"type": "turn.completed"')) {
    const text = extractCodexAgentText(stdoutText);
    return { completed: true, text };
  }
  const cleaned = stdoutText
    .replace(/\[aweteam\] worker finished with exit [0-9]+[\s\S]*$/m, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[78]/g, "")
    .trim();
  return { completed: cleaned.length > 0 && !profileName.includes("codex"), text: cleaned };
}

function extractCodexAgentText(stdoutText) {
  let latest = "";
  for (const line of stdoutText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "item.completed" && parsed.item?.type === "agent_message" && typeof parsed.item.text === "string") {
        latest = parsed.item.text;
      }
    } catch {
      // Ignore non-JSON lines in mixed CLI output.
    }
  }
  return latest.trim();
}

function cleanLeaderSummary(stdoutText) {
  const cleaned = stripTerminalControls(stdoutText)
    .replace(/^[⏺✻✶]\s*/gm, "")
    .trim();
  const lines = cleaned.split(/\n/);
  const readMarker = findLastIndex(lines, (line) => /^\s*Read \d+ file/.test(line));
  const start = readMarker >= 0 ? readMarker + 1 : 0;
  const body = lines.slice(start).map((line) => line.replace(/^\s{0,2}/, ""));
  const end = body.findIndex((line) => (
    /^\s*Bash\(aweteam collect-summary/.test(line)
    || /^─{5,}/.test(line)
    || /^❯/.test(line.trim())
    || /bypass permissions/.test(line)
  ));
  return body.slice(0, end >= 0 ? end : undefined).join("\n").trim();
}

function findLastIndex(values, predicate) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (predicate(values[index], index)) return index;
  }
  return -1;
}

function stripTerminalControls(text) {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[78]/g, "")
    .replace(/\x1B[=>][0-9;?]*[a-zA-Z]?/g, "")
    .replace(/\r/g, "");
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
  const workers = run.workers.map((worker) => {
    const resultPath = worker.state && worker.state !== "running" ? `\tresult=${join(worker.dir, "result.md")}` : "";
    return `${worker.name}\t${worker.profile}\t${worker.state ?? "unknown"}\t${worker.pane}${resultPath}`;
  }).join("\n");
  return [
    `run_id: ${run.run_id}`,
    `session: ${run.session_name}`,
    `leader: ${run.leader.profile}\t${run.leader.pane}`,
    workers ? `workers:\n${workers}` : "workers: none",
  ].join("\n");
}

async function hydrateRunWorkerStatuses(runJson) {
  const workers = [];
  for (const worker of runJson.workers) {
    try {
      const status = JSON.parse(await readFile(join(worker.dir, "status.json"), "utf8"));
      workers.push({ ...worker, state: status.state ?? "unknown" });
    } catch {
      workers.push({ ...worker, state: "unknown" });
    }
  }
  return { ...runJson, workers };
}
