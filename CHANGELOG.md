# Changelog

## 1.0.0 - 2026-08-11

- declare the complete local-first briefing runtime, governance lifecycle, Codex Skill, connector
  SDK, cross-platform scheduling, audit/replay, and human-confirmed knowledge integration stable;
- make the BYOK responsibility explicit: provider contract, security, schema and failure behavior are
  release gates, while a maintainer-owned live Qwen account is an optional integration smoke;
- require every installation to validate its own key, region, workspace, model and quota with
  `doctor --online` before formal runs or native schedule enablement.

## 0.2.0 - 2026-08-11

- complete staged formal-run state machine with frozen due manifests, incremental cursors,
  conditional requests, crash resume, exactly-one receipts, append-only events, and integrity gates;
- versioned seven-rule policy, prompt, Qwen provider, expert resources, origins, semantic diff, intent
  migration, and checksummed SQLite migrations with backups;
- Qwen structured extraction with secret references, endpoint allowlist, bounded retry/response,
  evidence support verification, seven-dimension scoring, Daily/Review/MachineOnly gates and caps;
- durable validated-analysis caching, cross-run retry of unchanged failed captures, versioned item
  identity, explainable duplicate clusters, and immutable linked recovery runs;
- separate Daily and Review artifacts, managed indexes, multi-file/state transactions, complete replay
  and current-disk tamper checks;
- durable feedback, guarded policy experiments and rollback, cadence proposals with cold-start,
  hysteresis and human locks, and proposal-first knowledge integration;
- confirmed launchd, cron, and Windows Task Scheduler definitions with explicit enable/disable;
- live-preview/config/hash/online-preflight binding before schedule enablement, native-state drift
  inspection, and exact scheduler rollback after partial installation failure;
- frozen baseline and candidate policy experiments evaluated through the complete selection pipeline,
  strict deep resource schemas, offline side-effect-free doctor and migration diagnostics;
- public connector SDK boundary, eight-domain starter preset, Codex Skill, complete documentation,
  community files, cross-platform CI, release provenance workflow, and clean-package smoke test.

The supplied Beijing Qwen test key could list the model catalog but returned provider 403 on
chat-completion calls. This is recorded as an account-specific BYOK diagnostic, not a product defect
or stable-release gate.

## 0.1.0-alpha.1 - 2026-08-10

First public alpha:

- five-minute offline demo and guided one-file initialization;
- fixture and live preview modes with immutable Markdown artifacts;
- packaged GitHub Releases and RSS/Atom connectors;
- strict intent and preset validation with explainable effective configuration;
- immutable SQLite run snapshots, per-source receipts, partial-failure reporting, and offline replay verification;
- bounded JSON interface and a thin Codex Skill;
- filesystem and network boundaries for symlink escape, redirects, response size, non-public addresses, and undeclared hosts.

Scheduling, external destinations, user-defined connectors, credentials, and knowledge-base writes remain disabled in this alpha.
