<div align="center">
  <img src="logo/hero.png" alt="aweteam" width="600">
  <h1>aweteam</h1>
  <p><strong>本地 AI coding agent 团队的轻量 tmux 交接接口。</strong></p>
  <p>启动一个 leader，把任务分给配置好的 worker，对话保留在 tmux pane 里。</p>
  <p>
    <a href="./README.md">English</a> ·
    <strong>简体中文</strong>
  </p>
  <p>
    <img src="https://img.shields.io/badge/version-0.1.0-7C3AED?style=flat-square" alt="Version">
    <img src="https://img.shields.io/badge/node-%E2%89%A520-0EA5E9?style=flat-square" alt="Node">
  </p>
  <p>
    <img src="https://img.shields.io/badge/status-alpha-c96a3d?style=flat-square" alt="Status">
    <img src="https://img.shields.io/badge/provider-Claude%20%7C%20Codex-7C3AED?style=flat-square" alt="Providers">
    <img src="https://img.shields.io/badge/platform-tmux-334155?style=flat-square" alt="Platform">
  </p>
</div>

> 启动一个 leader，把任务分给配置好的 worker，对话保留在 tmux pane 里。

`aweteam` 会启动一个真实的 leader CLI 到 `leader/main`，让这个 leader 从配置好的 profile 里创建 worker pane，并把每次运行的显式记录写到 `.aweteam/runs/<run-id>/`。

它刻意保持小。它不是调度器、托管 agent 平台，也不是新的 UI。正常工作流仍然发生在 tmux 里：你用自然语言和 leader 对话，leader 把任务分给配置好的 worker，每个 worker 的对话都保留在自己的 pane 里。

## 展示

![aweteam tmux leader and worker panes](./example.png)

## 安装

需要 Node.js 20 或更高版本，以及 tmux。

从当前仓库安装：

```bash
cd /Users/peng/Desktop/Project/Multiagent/aweteam
npm install
npm link
aweteam --help
```

## 快速开始

创建本地配置：

```bash
cp aweteam.example.json aweteam.json
```

如果配置里使用了环境变量驱动的 profile，请先导出需要的变量。例如：

```bash
export GLM_ANTHROPIC_AUTH_TOKEN="your-token"
```

启动一个团队会话：

```bash
aweteam --config aweteam.json
```

这会创建一次 run，把记录写到 `.aweteam/runs/<run-id>/`，启动 dispatcher，
并把你 attach 到聚焦在 `leader/main` 的 tmux session。

如果想在启动时给一个明确主题：

```bash
aweteam run "Create three agents to review the login module" --config aweteam.json
```

在 leader pane 里，用自然语言描述任务：

```text
Use the frontend profile to review the login UI, the backend profile to inspect
session handling, and the review profile to check security risks. Choose only
from the configured aweteam worker pool.
```

leader 应该能创建 worker，而不需要你提 JSON、outbox、dispatcher 或命令行细节。

## 配置

`aweteam` 只读取 JSON 配置。每次 run 都会把解析后的配置冻结到
`.aweteam/runs/<run-id>/config.resolved.json`，所以后续修改 `aweteam.json`
不会影响已经存在的 run。

最小结构：

```json
{
  "leader": "claudecode-official",
  "workers": ["codex"],
  "profiles": {
    "codex": {
      "provider": "codex",
      "command": "codex",
      "model": "gpt-5.4-mini",
      "max_instances": 1
    },
    "claudecode-official": {
      "provider": "claude",
      "command": "claude",
      "env": {
        "ANTHROPIC_MODEL": "sonnet"
      }
    }
  }
}
```

对 `claude` provider，模型通过 `env.ANTHROPIC_MODEL` 控制（通过 `--settings`
传给 Claude Code）。`model` 字段仅用于 `codex` provider（作为 `--model`
参数）。

`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_DEFAULT_SONNET_MODEL`、
`ANTHROPIC_DEFAULT_OPUS_MODEL` 这类可选 Claude 默认模型变量，默认都不配置。

如果你希望 Claude Code 对轻量任务或后台功能使用更轻的模型，可以手动把
`ANTHROPIC_DEFAULT_HAIKU_MODEL` 加到 profile 的 `env` 中。例如：

```json
{
  "provider": "claude",
  "command": "claude",
  "env": {
    "ANTHROPIC_BASE_URL": "https://token-plan-sgp.xiaomimimo.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "${XIAOMI_ANTHROPIC_AUTH_TOKEN}",
    "ANTHROPIC_MODEL": "mimo-v2.5-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "mimo-v2.5"
  }
}
```

这样主模型仍然使用 `mimo-v2.5-pro`，同时让 Claude Code 在轻量/后台任务上
可以使用 `mimo-v2.5`。

只有列在 `workers` 里的 profile 能被创建成 worker。`max_instances` 限制同
一个 profile 在一次 run 里最多能创建多少个 worker。

### 环境变量

Profile 可以用 `${VAR_NAME}` 语法引用 shell 环境变量。值在启动时解析，缺失
的变量会报错。

对于第三方 API 代理，通过环境变量设置端点和 token：

```bash
export GLM_ANTHROPIC_AUTH_TOKEN="your-token"
```

然后在 profile 配置里引用：

```json
{
  "provider": "claude",
  "command": "claude",
  "max_instances": 2,
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-glm-compatible-endpoint",
    "ANTHROPIC_AUTH_TOKEN": "${GLM_ANTHROPIC_AUTH_TOKEN}",
    "ANTHROPIC_MODEL": "glm-4.6"
  }
}
```

Claude Code 的关键环境变量：

| 变量 | 用途 |
|---|---|
| `ANTHROPIC_MODEL` | 主模型选择 |
| `ANTHROPIC_AUTH_TOKEN` | API 认证 token（用 `${VAR}` 引用敏感值） |
| `ANTHROPIC_BASE_URL` | API 端点（用于代理，可直接硬编码） |

## 工作流

每次 run 都是一个 tmux team console：

- `prefix+1` 选择 leader pane
- `prefix+2` 到 `prefix+9` 选择已创建的 worker pane
- worker pane 运行交互式 agent UI，完成后也保持打开
- worker 的最终回答既能在 tmux 里看到，也会写入 `result.md`
- dispatcher 会把 created、completed 和 all-done 通知发回 leader pane

关键运行记录：

```text
.aweteam/runs/<run-id>/
  config.resolved.json
  run.json
  events.jsonl
  leader/
    instructions.md
    outbox/
    inbox/
    summary.md
  workers/
    worker-1/
      task.md
      result.md
      status.json
```

对 Claude Code leader，`aweteam` 会禁用原生 `Task` delegation，并注入规则：
这里的 "agent" 只表示 aweteam tmux worker pane。这样可以避免 Claude Code
内部 agent 替代 aweteam worker。

## 命令

```bash
aweteam --config aweteam.json
aweteam run "task" --config aweteam.json
aweteam status <run-id>
aweteam focus <run-id> <leader|worker-name|profile>
```

主要入口是 `aweteam --config aweteam.json` 和 `aweteam run "task" --config aweteam.json`。

从另一个终端调试：

```bash
aweteam status <run-id>
aweteam focus <run-id> leader
aweteam focus <run-id> worker-1
```

状态输出示例：

```text
run_id: <run-id>
session: aweteam-<run-id>
leader: claudecode-official    %0
workers:
worker-1    codex    done    %1    result=/path/to/result.md
```

## 文档

- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) 说明架构、本地开发、测试和贡献约束。
- [docs/CHANGELOG.md](docs/CHANGELOG.md) 说明发布历史。

## 开发

```bash
npm test
```
