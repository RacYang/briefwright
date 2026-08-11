# Briefwright

Briefwright builds calm, source-linked AI intelligence briefings from public sources. It keeps the
first-run experience to one small file while preserving the receipts, evidence gates, policy
versions, failures, and replay data needed to trust a recurring briefing.

## Try it in two minutes

Install the signed GitHub release package:

```bash
npm install -g https://github.com/RacYang/briefwright/releases/download/v1.0.0/briefwright-1.0.0.tgz
briefwright demo
```

From a checkout:

```bash
pnpm install
pnpm build
node dist/cli.js demo

mkdir my-briefing
node dist/cli.js init --yes --directory my-briefing
node dist/cli.js preview --config my-briefing/briefing.yaml
```

`demo` and the default `preview` are offline and need no account or API key. They do not install a
schedule or write to a knowledge base.

The generated `briefing.yaml` is the ordinary user interface:

```yaml
version: 2
name: My AI briefing
preset: ai-daily
interests:
  - AI agents
  - model releases
  - AI safety
schedule: manual
output: markdown
outputDirectory: briefs
ai: qwen
```

## Run a real briefing with Qwen

Put a test or production key in an ignored local file—never in `briefing.yaml`:

```bash
cp .env.example .env.local
# edit .env.local and set DASHSCOPE_API_KEY

node dist/cli.js doctor --online --config briefing.yaml
node dist/cli.js run --config briefing.yaml
```

The formal run writes separate `Daily` and `Review` artifacts. It freezes its rules and source
manifest, incrementally collects due sources, records exactly one receipt per due source, validates
Qwen's structured output, verifies claim support, scores seven dimensions, applies deterministic
selection gates, and persists an auditable SQLite snapshot.

Alibaba Model Studio keys and endpoints are region/workspace specific. Briefwright accepts the
pay-as-you-go and trial OpenAI-compatible endpoints for Beijing, Singapore, Virginia, Tokyo, and
Frankfurt, including workspace-dedicated domains. Coding Plan and Token Plan keys are intentionally
rejected because Alibaba documents them for interactive coding tools rather than recurring backend
jobs. If `doctor --online` reports model access denied, use `config eject` and set the matching
regional model and endpoint in `briefwright.d/profile.yaml`.

## The uncomplicated path

Most people only need:

```bash
briefwright demo
briefwright init
briefwright preview
briefwright doctor --online
briefwright run
briefwright status
briefwright open
```

Set `schedule` in `briefing.yaml` to `daily-at-10` or `weekdays-at-09`. Briefwright supports launchd
on macOS, user cron on Linux, and Task Scheduler on Windows. A manual
schedule is rejected instead of installing a no-op task. Enablement also requires a successful,
untampered live preview of the current configuration from the last seven days and a passing online
preflight:

```bash
briefwright preview --live
briefwright doctor --online
briefwright schedule describe
briefwright schedule enable --yes
```

## Trust and governance

- Primary evidence is required for Daily and Review selection.
- Unsupported model claims are excluded rather than promoted.
- Daily uses a score threshold of 70; Review uses 60–69 plus the stable-knowledge-potential gate.
- Daily allows at most 12 items and three per domain. Empty artifacts are valid.
- Source failures remain visible and produce partial or failed outcomes.
- Same-day formal runs are idempotent; interrupted finalization is resumable.
- `run --retry-failed` creates a linked immutable recovery run instead of changing a finalized run.
- `replay` regenerates every recorded artifact offline and checks both the snapshot hash and current
  disk content.
- Feedback cannot change policy directly. Experiments require at least 50 reviewed items across 14
  days, explicit approval, activation, and a rollback path.
- Knowledge changes are previewed proposals. `knowledge commit --yes` rejects a target that changed
  after preview.

## Commands

| Command | Purpose |
|---|---|
| `demo` | Offline, credential-free demonstration |
| `init` | Create one intent file without enabling anything |
| `preview [--live]` | Fixture preview or read-only public-source preview |
| `run [--retry-failed]` | Formal incremental pipeline or linked immutable recovery run |
| `status`, `open`, `replay` | Inspect and verify durable runs |
| `config validate|render|explain|diff|migrate|eject` | Typed configuration lifecycle |
| `db migrate` | Preview or explicitly apply SQLite migrations |
| `doctor [--online]` | Offline correctness or online provider/source checks |
| `schedule describe|enable|disable|status` | Native scheduling with confirmation |
| `feedback add|summary` | Human outcome signals |
| `experiment create|evaluate|approve|activate|rollback` | Guarded policy improvement |
| `cadence evaluate|list|approve|reject|lock` | Guarded source-frequency governance |
| `knowledge propose|commit` | Human-confirmed Markdown/Obsidian integration |
| `capabilities` | Machine-readable installed feature surface |

Add global `--json` for stable, bounded machine-readable output. The packaged Codex Skill uses this
surface and owns no separate schema, policy, or durable state.

## Expert configuration

Ordinary users do not need to understand internal resources. When a requirement cannot be expressed
by the intent file, run:

```bash
briefwright config eject --yes
briefwright config validate
briefwright config explain provider
```

This creates versioned `Profile`, `PolicyBundle`, `PromptPack`, `Output`, and per-source resources in
`briefwright.d/`. Unknown fields, unsafe provider endpoints, invalid score weights, broken cadence
bounds, and unknown source references fail validation. See [configuration](docs/configuration.md).

## Development and design

- [Product experience RFC](docs/rfcs/0001-product-experience.md)
- [Configuration RFC](docs/rfcs/0002-configuration.md)
- [Runtime architecture RFC](docs/rfcs/0003-architecture.md)
- [Complete-system delivery matrix](docs/implementation/complete-system-matrix.md)
- [Operations](docs/operations.md)
- [Connector contract](docs/connectors.md)
- [Security policy](SECURITY.md)
- [Threat model](docs/threat-model.md)

Licensed under Apache-2.0.
