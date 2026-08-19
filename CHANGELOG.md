# Changelog

## 2.1.3 - 2026-08-19

- add a complete nine-table Feishu schema and row-completeness audit, with required-versus-optional
  blank classification, governed backfill planning, exact digest and update-count authorization,
  acknowledged readback, and a zero-diff post-apply gate;
- preserve the frozen source and connector evidence attached to historical Capture and Receipt rows,
  including connector-version changes, so later source migrations cannot rewrite run history;
- distinguish intentionally pruned links to remotely deleted historical runs from genuinely missing
  relations, allowing production data slimming without hiding incomplete current records;
- normalize Feishu numeric precision, authority ratings, cadence values, and select-field compatibility,
  envelope oversized JSON values, and bound write batches by serialized payload size;
- harden control-plane and local run-state contracts, source-migration readback, and recovery of
  pre-versioned formal artifacts during deterministic replay.

## 2.1.2 - 2026-08-15

- add a governed Computer Use source bridge for public dynamic pages, with frozen entry URLs, exact
  host allowlists, read-only interaction policy, capture-mode binding, validated external bundles,
  formal-run integration, and an explicit Feishu `采集方式` control field;
- separate source-connectivity previews from bounded real-model editorial shadows, require a usable
  failure-free model sample before schedule enablement, and generate specific reader-facing titles
  instead of exposing bare version numbers or unexplained source titles;
- bind Codex automations to the rendered effective-configuration digest so changing packaged prompts,
  policies, providers or presets cannot bypass the automation's immutable CLI and config-file pins;
- verify a content digest of the complete installed runtime tree and resolved dependencies instead of
  treating the unchanged `dist/cli.js` entrypoint hash as proof that the rest of the code is immutable;
- recover historical evidence from the original canonical URL when bounded feeds or release windows
  no longer return the frozen content hash, while enforcing source-domain and repository boundaries;
  keep operational failures, timings, and storage diagnostics out of Daily and Review reading copies;
- replace cross-language lexical-overlap rejection with exact, bounded source-language evidence
  anchors checked against transient full source text; persist only verification fingerprints, and
  add an immutable evidence-reverification recovery mode for previously unverified primary items;
- detect the process or macOS user locale for formal Daily and Review rendering, support an explicit
  `BRIEFWRIGHT_LOCALE` override, and keep machine-readable frontmatter IDs language-neutral;
- bound HTTP dispatcher cleanup, retain per-origin pools for forced teardown, and bypass graceful
  close after request failures such as rejected 308 redirects so online doctor can always emit its
  structured blocking and warning verdict;
- normalize RSS guid/id values from text, numbers, and attributed XML objects, fall back to the
  canonical URL, and guard SQLite state writes from non-bindable capture envelope values;
- write Lark linked-record fields in validated batches after stable record IDs exist, use the current
  `link_table` field contract, and reconcile only failed or newly audited records.
- version the execution-configuration digest, exclude only control-plane-derived scan timestamps and
  revisions, and compare legacy frozen snapshots so retries tolerate runtime progress but reject
  connector, cadence, policy, provider, runtime, output, storage, protocol, and contract drift;
- map recovery receipts to the existing manual-force due-reason option and include unresolved
  control-plane records from the retry lineage in the next governed reconciliation.
- hydrate the full configured control plane before explicit sync plan/apply so historical repair
  preserves the frozen run's complete source and rule link surface.

## 2.1.1 - 2026-08-11

- replace the process-heavy project introduction with a concise product-first README covering the
  value proposition, installation, first successful run, supported stack, workflow, and stable
  documentation entry points;
- keep English and Simplified Chinese in one README with same-page language navigation, while
  retaining the former Chinese filename as a compatibility pointer.

## 2.1.0 - 2026-08-11

- make the conversational Skill the ordinary-user product surface, with one-question-at-a-time
  onboarding, provider-neutral choices, Feishu/SQL and Obsidian/local fallbacks, failure explanation,
  and explicit governance approvals;
- add a confirmed, content-hash-managed Codex Skill installer that refuses symlink, unmanaged, or
  locally modified destinations;
- accept direct official Feishu Base links during setup, choose a detected Codex installation ahead
  of an unavailable Ollama default, and warn when a Codex automation is exported from a mutable Git
  checkout instead of a versioned runtime;
- extend clean-package smoke testing through setup, offline preview, local doctor, status, and Skill
  integrity, while keeping npm short-name and Homebrew distribution deferred to a later release.

## 2.0.1 - 2026-08-11

- normalize managed Obsidian Wiki-link targets to forward slashes on Windows;
- keep the complete cross-platform suite bounded with an explicit 20-second test timeout.

## 2.0.0 - 2026-08-11

- rebaseline completion against the production nine-entity AI-intelligence contract instead of the narrower historical local matrix;
- add guided provider/store/document setup, generic OpenAI-compatible and Anthropic protocols, a bounded local Codex provider, and reviewed OpenAI, Gemini, Qwen, Anthropic, and Ollama presets;
- add Lark CLI Feishu import, validation, Chinese-field mapping, stable-ID link resolution, plan/apply sync, PostgreSQL and MySQL stores, and SQLite fallback;
- add Obsidian/local document boundaries with production Daily/Review paths, managed indexes, valid empty artifacts, and human-confirmed knowledge writes;
- add bounded webpages, official X API v2 and a validated Codex read-only browser capture bridge, remote due-source hydration, complete run reports, control-plane synchronization, and digest-bound Codex independent-task export;
- import and bind an existing full execution contract, and adopt an already-terminal remote same-day run without overwriting its Daily/Review artifacts or duplicating process-store writes;
- preserve bounded full evidence only in memory while persisting 25-word excerpts, record failed captures and canonical rule-bound events, enforce X as clue-only, and add coverage-gap scheduling plus source/model latency, token, and known-cost observations;
- make PostgreSQL/MySQL provisioning explicit so doctor and sync planning stay read-only, and validate schema versions before use;
- expand feedback, durable improvement diagnoses and proposals, and an approval gate that rejects harmful or non-improving experiments;
- replace Qwen-only onboarding with bilingual, vendor-neutral user paths and focused provider, Lark, database, document, and improvement guides.

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
