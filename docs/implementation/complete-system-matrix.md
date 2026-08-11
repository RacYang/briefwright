# Briefwright complete-system delivery matrix

- Status: Normative implementation contract
- Baseline: AI Intelligence Daily workflow 1.3
- Target release: 1.0.0
- Last reviewed: 2026-08-11

This matrix defines what “complete” means for Briefwright. A row is complete only when the
implementation, automated evidence, user-facing path, and failure behavior all exist. Design text,
an Alpha capability flag, or a fixture-only path does not satisfy a row.

## Product boundary

The default experience remains one small `briefing.yaml`. Briefwright may compile that intent into
versioned policies, prompts, provider configuration, a frozen execution plan, and durable state, but
ordinary users do not need to edit those resources. Expert resources are exposed only through
`config eject` and remain schema-validated.

Secrets are references, never configuration values. Knowledge-base changes are proposals until a
person explicitly approves a bounded commit.

## Completion gates

| Area | Required behavior | Evidence required | Current status |
|---|---|---|---|
| First run | Offline demo, guided init, credential-aware setup, preview, actionable errors | CLI E2E on macOS/Linux/Windows; fixture golden output | Complete |
| Versioned config | Intent migration, typed advanced resources, one precedence model, origins, redaction, semantic diff, dry-run/write migration | Schema, migration, redaction, unknown-field and downgrade tests | Complete |
| Rules and provenance | Seven canonical policy rules; every run snapshots all active rule IDs and policy/source/prompt/provider/core versions and digests | DB assertions and artifact frontmatter tests | Complete |
| State migrations | Explicit append-only SQLite migrations; no constructor-time implicit schema repair; migration status and backup | Fresh, upgrade, failure, and idempotency tests | Complete |
| Run lifecycle | Frozen due manifest; initialization through completion stages; barriers; append-only events; idempotency keys; terminal success/partial/failed | State-machine and crash/retry tests | Complete |
| Source accounting | Exactly one receipt per due source; integrity equation; accurate last scan/success/effective update | Property and integration tests | Complete |
| Incremental capture | Durable source cursors and conditional fetch metadata; stable capture IDs; unchanged detection based on content/cursor, not time | Two-run connector tests and replay fixtures | Complete |
| Connector contract | Typed descriptor/schema/capabilities/auth/risk/owner/examples; offline validate, online check, capture; bounded network and payload | Contract suite for every bundled connector | Complete |
| Evidence | Canonical URL, evidence class, access/verification state, source metadata, bounded quotation and explicit unsupported claims | Validator and adversarial fixture tests | Complete |
| AI provider | Provider-neutral interface; Qwen/DashScope adapter; typed secret ref; structured extraction; timeout/retry/rate/failure accounting; deterministic fixture provider | Provider contract, schema, redaction and failure-path tests; user-owned key validation through `doctor --online` | Complete |
| Normalize and dedupe | Stable item identity by canonical URL plus event/version; global duplicate clusters with explainable winner | Unit, property, and multi-source integration tests | Complete |
| Scoring | Seven weighted 0–5 dimensions; deterministic total; reasons and evidence; hard exclusions | Golden score and boundary tests | Complete |
| Selection | Daily >=70 plus gates; Review 60–69 plus stable-knowledge potential or explicit ambiguity; otherwise MachineOnly; Daily max 12/domain max 3; empty allowed | Threshold, cap, diversity, zero-item tests | Complete |
| Daily/Review output | Two independently valid artifacts, required sections and fields, domain coverage, exclusions, failures, receipts, timing and rule snapshots | Markdown schema/golden tests and filesystem boundary tests | Complete |
| Formal run | Same-day scheduled identity and safe rerun/resume semantics distinct from unique previews; immutable finalized snapshots | CLI E2E and interrupted-run recovery tests | Complete |
| Replay and audit | Offline deterministic replay from frozen inputs; verifies regenerated content and current disk artifact; explains mismatches | Tamper, version drift, missing input tests | Complete |
| Feedback | Reviewed/used/ignored/knowledge-worth signals linked to items and runs; minimum sample gates | CLI/API persistence and invalid-reference tests | Complete |
| Experiments | Candidate policy changes, frozen baseline/treatment, replay evaluation, approval, activation and rollback | Experiment lifecycle tests | Complete |
| Cadence governance | Cold start, hard floors, weekly evaluation, hysteresis, human locks, explainable proposed cadence changes | Clock-controlled tests | Complete |
| Scheduling | Dry-run describe plus confirmed install/disable/status for launchd, cron and Windows Task Scheduler; no-op schedules rejected | Adapter golden tests; platform CI smoke | Complete |
| Knowledge integration | Propose placement/enrichment with evidence/problem/mechanism/boundaries/failures/validation; explicit preview and confirm gateway; bounded Markdown/Obsidian writes | Approval, stale-proposal, path and heading tests | Complete |
| Doctor | Offline validation separated from online provider/connector/output checks; stable JSON and exit codes; no secrets in diagnostics | CLI E2E and redaction tests | Complete |
| Skill | Conversational golden path invokes CLI JSON; can configure Qwen, preview, diagnose, run, recover failures, schedule, collect feedback and approve knowledge; owns no durable state | Packaged Skill inspection and scripted scenarios | Complete |
| Security | SSRF/rebinding, redirects, payload bounds, path/symlink races, secret redaction, prompt injection boundaries, safe subprocesses and dependency audit | Threat model, adversarial tests, independent review | Complete |
| Open-source release | Installable package includes schemas/presets/policies/prompts/skill; Node support matrix; contribution/security/community files; tags, changelog, provenance | `npm pack` install smoke, clean-clone E2E, CI matrix, GitHub release | Complete |

## Canonical workflow semantics

Every formal run executes these observable stages in order:

1. `initialize`
2. `freeze_due_manifest`
3. `discover`
4. `capture`
5. `write_receipts`
6. `normalize`
7. `verify_evidence`
8. `deduplicate`
9. `score`
10. `select`
11. `publish`
12. `persist`
13. `validate_integrity`
14. `complete`

Stage-local concurrency is bounded. Stage boundaries are barriers. A formal run freezes its active
rules, provider/prompt/policy/source versions, due sources, and configuration digests before network
or model work. The same frozen snapshot is used for resume and replay.

## Canonical policy identities

- `RULE-WORKFLOW-V1.3`
- `RULE-SCORE-V1.0`
- `RULE-SELECTION-V1.1`
- `RULE-SOURCE-V1.1`
- `RULE-IMPROVEMENT-V1.0`
- `RULE-RETENTION-V1.0`
- `RULE-REVIEW-OUTPUT-V1.1`

The bundled policy is not complete unless all seven identities are validated and included in each
formal run snapshot.

## Release decision

The 1.0 release gate is conjunctive: every matrix row must be `Complete`, the supported-platform CI
matrix must pass, the package must install and execute from a clean directory, and independent
security and product-experience reviews must have no open release blocker. Because Briefwright is
BYOK, a maintainer-owned Qwen credential is an optional integration smoke test rather than a release
gate. Each installation validates its own region, workspace, model, quota, and key with
`doctor --online` before formal runs or schedule enablement.
