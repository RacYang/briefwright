# Briefwright

[English](#english) · [简体中文](#简体中文)

[![CI](https://github.com/RacYang/briefwright/actions/workflows/ci.yml/badge.svg)](https://github.com/RacYang/briefwright/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/RacYang/briefwright)](https://github.com/RacYang/briefwright/releases/latest)
[![License](https://img.shields.io/github/license/RacYang/briefwright)](LICENSE)

## English

Briefwright is an open-source system for producing source-linked AI intelligence briefings. It monitors configured sources, preserves evidence and failures, publishes Daily and Review documents, and learns from human feedback without changing active rules on its own.

```text
Sources → captures and receipts → evidence, deduplication, and scoring
        → Daily / Review → feedback → reviewed improvement proposals
```

### Highlights

- **Evidence first.** Every due source receives a success or failure receipt. Selected items retain canonical source links and verification status.
- **Model independent.** Use Codex, OpenAI, Anthropic, Gemini, Qwen, Ollama, or a compatible provider.
- **Flexible storage.** Feishu Base is recommended for shared process data; PostgreSQL, MySQL, and SQLite are also supported. Documents can be written to Obsidian or a regular local folder.
- **Safe automation.** Preview, health checks, immutable run snapshots, replay, and explicit approval protect scheduled and remote writes.
- **Governed improvement.** Feedback can produce source, policy, prompt, provider, deduplication, and selection proposals. Evaluation, activation, and rollback remain human-controlled.

### Install

Briefwright requires Node.js 22.13 or later. Download `briefwright-2.1.1.tgz` from the [latest release](https://github.com/RacYang/briefwright/releases/latest), then install it:

```bash
npm install -g ./briefwright-2.1.1.tgz
briefwright --version
```

The release artifact includes a GitHub build-provenance attestation. Package-registry and Homebrew distribution are not available yet.

### Get started

#### Conversational setup with Codex

Install the bundled Skill once:

```bash
briefwright skill install --yes
```

Restart Codex, then ask:

> Create a daily briefing about AI agents. Recommend a model and storage setup, preview it, and explain each choice.

The Skill guides setup in ordinary language and asks before enabling schedules or writing to external services. The model used by the briefing is still your choice; installing the Codex Skill does not require Codex to be the inference provider.

#### Terminal setup

```bash
mkdir my-briefing
cd my-briefing
briefwright setup
briefwright preview --live
briefwright doctor --online
briefwright run
```

`setup` is an interactive wizard. It creates the project configuration but does not enable a schedule. To verify the installation without an account, API key, or network source, run `briefwright demo`; the demo uses bundled fixture data and does not perform a real AI briefing.

### Choose your stack

| Layer | Supported options | Default or recommended behavior |
|---|---|---|
| AI provider | Codex, OpenAI, Anthropic, Gemini, Qwen, Ollama, compatible providers | Selected during setup; required for formal runs |
| Process data | Feishu Base through `lark-cli`, PostgreSQL, MySQL, SQLite | Feishu recommended for teams; SQLite fallback |
| Documents | Obsidian, local folder | Obsidian recommended; local-folder fallback |
| Sources | RSS, GitHub Releases, webpages, X API, Codex browser capture, custom connectors | Enabled by the selected preset and project config |
| Scheduling | Codex automation, launchd, cron, Windows Task Scheduler | Manual until explicitly enabled |

Secrets are stored as environment or file references. They are not written into `briefing.yaml`, run snapshots, logs, or generated documents.

### How a run works

1. Freeze the due-source manifest, configuration, and active rules.
2. Capture each source with bounded concurrency and record one receipt per due source.
3. Normalize items, verify primary evidence, deduplicate globally, and score candidates.
4. Publish qualified items to Daily and borderline items to Review. Empty results are valid.
5. Persist runs, items, events, receipts, feedback, experiments, and rule versions to the selected process store.
6. Validate completion counts and retain an immutable snapshot for offline replay.

Formal runs never turn source failures into facts or write directly to evergreen knowledge notes. Knowledge changes use a separate preview-and-approve workflow.

### Documentation

- [Configuration](docs/configuration.md)
- [Model providers](docs/providers.md)
- [Connectors](docs/connectors.md)
- [Process-data stores](docs/process-stores.md)
- [Feishu Base setup](docs/lark.md)
- [Document stores and Obsidian](docs/document-stores.md)
- [Scheduling and operations](docs/operations.md)
- [Governed self-improvement](docs/self-improvement.md)
- [Migrating an existing Codex automation](docs/migration-from-codex-automation.md)
- [Threat model](docs/threat-model.md) and [security policy](SECURITY.md)

Use `briefwright --help` for the command reference and `briefwright capabilities` for the machine-readable feature surface.

### Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [CHANGELOG.md](CHANGELOG.md).

Briefwright is licensed under the [Apache License 2.0](LICENSE).

---

## 简体中文

Briefwright 是一个开源的 AI 情报简报系统。它持续监控已配置的数据源，保留证据与失败记录，生成 Daily 和 Review 文档，并利用人工反馈提出改进建议，但不会自行修改正在生效的规则。

```text
数据源 → 采集与回执 → 证据核验、去重与评分
      → Daily / Review → 人工反馈 → 待审核的改进提案
```

### 核心特点

- **证据优先。** 每个到期来源都会产生成功或失败回执；入选条目保留 canonical 来源和核验状态。
- **模型通用。** 支持 Codex、OpenAI、Anthropic、Gemini、千问、Ollama 以及兼容 Provider。
- **存储可选。** 团队过程数据推荐使用飞书 Base，也支持 PostgreSQL、MySQL 和 SQLite；文档可写入 Obsidian 或普通本地文件夹。
- **安全自动化。** 通过预览、健康检查、不可变运行快照、重放和明确确认保护定时任务与外部写入。
- **受治理的自我迭代。** 反馈可以生成来源、策略、提示词、模型、去重和筛选提案；评估、激活与回滚始终由人控制。

### 安装

Briefwright 需要 Node.js 22.13 或更高版本。从[最新版本](https://github.com/RacYang/briefwright/releases/latest)下载 `briefwright-2.1.1.tgz`，然后安装：

```bash
npm install -g ./briefwright-2.1.1.tgz
briefwright --version
```

正式发布包附带 GitHub 构建来源证明。目前尚未提供 npm registry 短名和 Homebrew 分发。

### 开始使用

#### 使用 Codex 对话配置

只需安装一次随包提供的 Skill：

```bash
briefwright skill install --yes
```

重启 Codex，然后直接说：

> 帮我创建一个每天运行的 AI Agent 简报。推荐合适的模型和存储方式，先生成预览，并解释每个选择。

Skill 会用自然语言引导配置，并在启用定时任务或写入外部服务前征求确认。简报使用哪个模型仍由用户决定；安装 Codex Skill 不代表必须使用 Codex 作为推理模型。

#### 使用终端引导

```bash
mkdir my-briefing
cd my-briefing
briefwright setup
briefwright preview --live
briefwright doctor --online
briefwright run
```

`setup` 是交互式引导，只创建项目配置，不会启用定时任务。如果只想在不使用账户、API Key 或网络来源的情况下验证安装，可以运行 `briefwright demo`；该命令使用内置固定样例，不会执行真实 AI 简报。

### 选择你的技术栈

| 层 | 支持方式 | 默认或推荐行为 |
|---|---|---|
| AI Provider | Codex、OpenAI、Anthropic、Gemini、千问、Ollama、兼容 Provider | setup 时选择；正式运行必须配置 |
| 过程数据 | 通过 `lark-cli` 接入飞书 Base、PostgreSQL、MySQL、SQLite | 团队推荐飞书；默认降级 SQLite |
| 文档 | Obsidian、普通本地文件夹 | 推荐 Obsidian；默认降级本地文件夹 |
| 数据源 | RSS、GitHub Releases、网页、X API、Codex 浏览器采集、自定义连接器 | 由预设与项目配置启用 |
| 调度 | Codex 自动任务、launchd、cron、Windows 任务计划 | 默认手动，明确启用后才运行 |

凭证只以环境变量或本地文件引用保存，不会写入 `briefing.yaml`、运行快照、日志或生成文档。

### 一次正式运行如何工作

1. 冻结本次到期来源、配置和生效规则。
2. 以有界并发采集来源，并为每个到期来源记录一条回执。
3. 标准化条目、核验一手证据、全局去重并评分。
4. 将合格条目写入 Daily，边界条目写入 Review；零条结果同样有效。
5. 将运行、条目、事件、回执、反馈、实验和规则版本写入所选过程存储。
6. 校验完成数量，并保存可离线重放的不可变快照。

正式运行不会把来源失败变成事实，也不会直接修改常青知识笔记。知识写入使用独立的“预览—确认”流程。

### 文档

- [配置系统](docs/configuration.md)
- [模型接入](docs/providers.md)
- [数据源与连接器](docs/connectors.md)
- [过程数据存储](docs/process-stores.md)
- [飞书 Base 接入](docs/lark.md)
- [Obsidian 与文档存储](docs/document-stores.md)
- [调度与运维](docs/operations.md)
- [受治理的自我迭代](docs/self-improvement.md)
- [迁移现有 Codex 定时任务](docs/migration-from-codex-automation.md)
- [威胁模型](docs/threat-model.md)与[安全策略](SECURITY.md)

运行 `briefwright --help` 查看命令说明，运行 `briefwright capabilities` 查看机器可读的完整能力列表。

### 参与贡献

欢迎提交 Issue 和 Pull Request。请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) 和 [CHANGELOG.md](CHANGELOG.md)。

Briefwright 使用 [Apache License 2.0](LICENSE)。
