# Briefwright completion matrix

- Target: portable implementation of AI Intelligence Daily workflow 1.3
- Re-reviewed: 2026-08-13 after two interrupted production task audits
- Release posture: unreleased development snapshot; not approved for production replacement or publication

A green fixture suite is not product closure. A row is complete only when code, the real user path,
external readback, artifact quality, and terminal recovery behavior all pass. The current local suite
does not include authenticated production writes or the skipped PostgreSQL/MySQL integrations.

| Area | Implemented behavior | Evidence | Status |
|---|---|---|---|
| Ordinary-user start | Natural-language Skill, one-question-at-a-time choices, guided five-choice terminal fallback, review-before-write, offline fixture preview, no silent schedule | Skill contract, setup, demo, CLI E2E and clean-package onboarding smoke tests | Complete |
| Configuration | One small intent file, schema validation, explain/render/diff, explicit resource and DB migrations, typed secret references | config, migration, redaction and unknown-field tests | Complete |
| Provider neutrality | OpenAI, Anthropic, Gemini, Qwen, Ollama, custom OpenAI-compatible endpoints, and runtime protocol registration | provider registry/contract tests; non-retryable 4xx test | Complete |
| Process-store fallback | Omitted/auto store resolves visibly to local SQLite; configured remote failures do not silently fall back | config and doctor tests | Complete |
| Feishu Base | Versioned field manifest, capacity checks, stable links, two-phase withheld/published commit, per-record readback | fake-CLI contract tests; production Base currently requires new fields and ledger rollover before a formal run | Blocked externally |
| PostgreSQL / MySQL | Explicit `sql provision --yes`, version gate, read-only doctor/plan, canonical JSON rows, transactional parameterized upserts | isolated local PostgreSQL 16/MySQL 8.4 contract tests plus PostgreSQL 17/MySQL 8.4 CI service containers | Complete |
| Canonical control records | One schema for sources, runs, items, events, feedback, experiments, captures, rules, and receipts | JSON Schema validation on import and every sync | Complete |
| Documents | Obsidian recommended, local-folder fallback, exact Daily/Review paths, managed indexes and Wiki-links, valid empty artifacts | external temporary-vault and local filesystem tests | Complete |
| Knowledge boundary | Automatic runs cannot write evergreen notes; proposal/commit is explicit and target-hash bound | governance, stale-target and path-boundary tests | Complete |
| Execution contract | Packaged contract, frozen digest, 14 observable stages, seven active Rule IDs, stage barriers and bounded lanes | formal-run contract/frontmatter tests | Complete |
| Source accounting | Frozen due manifest, exactly one receipt per due source, honest update/unchanged/failed/skipped and missing equation | accounting and formal failure tests | Complete |
| Capture ledger | Incremental cursor/hash checks, conditional HTTP metadata, success and failure capture rows, parser metadata, 25-word protected-text limit | connector, retention and failed-capture tests | Complete |
| Security boundary | HTTPS/host allowlist, DNS-result and private-address rejection, redirect/body bounds, secret redaction, symlink/path escape prevention | adversarial connector/path tests and dependency audit | Complete |
| Analysis/evidence | Provider-independent structured contract, validation before use, primary/secondary evidence status, source text treated as untrusted evidence | provider/evidence and formal partial-failure tests | Complete |
| Dedupe/scoring/selection | Event identity, immutable run snapshots, deterministic freshness gates, recovery-only exclusion, Daily/Review/MachineOnly caps | retry/version, freshness, selection and experiment replay tests | Implemented; live editorial acceptance pending |
| Finalization/replay | Remote readback is the commit point; store failure is failed/withheld; artifacts bind due manifest and byte hashes; stale runs are recoverable and fenced | formal Lark-outage, legacy-finalizing, interrupted-run-copy, write-transaction and replay tests | Implemented; authenticated write proof pending |
| Completion report | Due/receipt/stage counts, failures, domains, top items, p50/p95 source latency, capture throughput, rule/process/document validation | formal artifact and CLI JSON tests | Complete |
| Feedback | Twelve outcome/correction types linked to stable items and runs; remote feedback imports into evaluation | feedback/governance tests and live Base import | Complete |
| Diagnosis | At-most-weekly 30-day evaluator consumes local/imported runs, receipts and feedback plus local source/model latency, token and known/unknown-cost observations; creates non-active evidence-backed proposals | live imported-history diagnosis and unit tests | Complete |
| Policy experiment | Frozen 14-day/50-item sample, baseline/candidate replay, positive/negative/evidence guardrails, strict improvement, human approve/activate/rollback | harmful/unchanged rejection and full lifecycle test | Complete |
| Cadence governance | Production weights including coverage gap, cold start, weekly hysteresis, adjacent steps, priority floors, human locks and explicit decision | clock-controlled cadence test | Complete |
| Scheduling | Codex independent-task definition freezes config and contract digests; native schedule requires an untampered real-model editorial shadow with usable content and no model failures, online doctor and confirmation | scheduler golden/guard tests | Complete |
| Skill | Conversational entry point hides CLI/YAML, checks install/provider/Lark readiness, explains blocking versus partial failures, and preserves remote-write, schedule, knowledge and self-improvement approval boundaries | managed-install integrity tests, package inspection and clean-package smoke | Complete |
| Open-source package | EN/ZH README, Apache-2.0/community/security files, schemas/protocol/presets/providers/docs/Skill in installable tarball | build, `npm pack` install/capabilities smoke, production audit with zero known vulnerabilities | Complete |

## Live production-parity readback

The authenticated read-only Lark exercise paginated and validated 1,552 existing records across all
nine tables: 170 sources, 8 runs, 41 items, 337 events, 24 feedback records, 3 experiments, 238
captures, 15 rule records, and 716 receipts. A second import after capture-contract expansion produced
the deterministic revision `f74e1c175e0356ce3d862edb820616bc02f17e3bb28348630807bb0aef9524b3`.
It performed no Base write. The write-path check used `record-upsert --dry-run` only.

The imported 30-day history was not inert: the evaluator read 8 runs, 716 receipts, and 24 feedback
records and produced nine non-active repeated-source-failure proposals. No proposal, cadence,
experiment, schedule, schema change, or knowledge write was activated.

## Self-review findings and dispositions

1. **Hard-coded production table IDs:** removed. Defaults are portable Chinese table names; explicit
   IDs remain supported for existing deployments.
2. **Vendor-specific model path:** removed. Qwen is one provider preset behind the same protocol and
   validation boundary as its peers.
3. **Failed source represented only by a receipt:** fixed. A failed URL now also produces a capture
   record with attempts, parser version and failure reason, without entering model analysis counts.
4. **Copyright over-retention and analysis starvation:** fixed. Webpage, RSS, GitHub and X excerpts
   use the same Unicode-aware 25-word limiter; a bounded full body is available only to the current
   in-memory model pass and is stripped before SQLite, Base, snapshots, logs, or artifacts.
5. **Process-store failure after publication:** fixed in the development snapshot. Artifacts remain
   withheld until canonical readback and a published commit succeed; unresolved storage failures are
   `failed`, never `partial`.
6. **SQL doctor mutating schema:** fixed. Doctor and sync planning are read-only; schema creation is
   an explicit confirmed command.
7. **Cadence formula missing coverage gap:** fixed. The 0.40/0.25/0.15/0.10/0.10 production weights
   are all present and stored as explainable components.
8. **Documentation ahead of executable CLI:** fixed for experiment syntax, feedback vocabulary,
   provisioning, live preview, provider/store/document choices, and self-improvement limits.

## Honest remaining external gates (2026-08-13)

- Local tests, build, package smoke, and the two interrupted-task database-copy regressions must all
  be reported separately; none substitutes for an authenticated production write/readback.
- The production Feishu event ledger is already over its configured 2,000-record capacity. Rollover
  or archival and the new Run integrity fields require an explicit external migration before the
  next formal production run.
- No live model call was repeated during final review. Provider request contracts were tested with
  deterministic HTTP fixtures; every installation must pass its own `doctor --online` for the
  selected model, region, quota and credential.
- GitHub v2.0.1 is published and its cross-platform CI plus PostgreSQL/MySQL integration jobs passed.
  The v2.1.0 commit must pass its own cross-platform, package and SQL jobs before tagging.
- The npm short-name distribution and Homebrew packaging are deliberately deferred to a later
  version. Neither should be presented as currently available.
