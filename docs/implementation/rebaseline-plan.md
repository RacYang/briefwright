# Briefwright rebaseline and complete implementation plan

- Status: In progress
- Rebaseline date: 2026-08-11
- Supersedes: the completion claim in `complete-system-matrix.md`
- Production reference: `AI-INTELLIGENCE-DAILY` contract 1.0 and workflow 1.3

## Why this rebaseline exists

Briefwright 1.0 implemented a useful local subset, but it was incorrectly declared complete after
replacing the production workflow's boundaries with a narrower delivery matrix. This plan restores
the original goal: an approachable open-source extraction of the existing scheduled intelligence
system, with portable infrastructure rather than hard-coded vendors.

Completion is measured against the production contract and the product constraints below. A typed
interface, a fixture, a documentation claim, or one adapter does not complete a capability.

## Non-negotiable product constraints

1. **Process-data storage is portable.** Feishu Base through the installed Lark CLI is the
   recommended collaborative control plane. PostgreSQL and MySQL are supported server stores.
   SQLite is the zero-configuration fallback. The same domain contract applies to every store.
2. **Document storage is portable.** Obsidian is the recommended document experience. A normal
   local folder is the zero-configuration fallback. Notion and other document systems attach through
   the same adapter boundary later.
3. **Models are user-selected.** Qwen is one provider preset, never a core type. The runtime has a
   provider registry, protocol adapters, typed secret references, endpoint security, and an
   extension contract.
4. **Intermediate data drives governed improvement.** Runs, captures, receipts, items, events, and
   feedback must support diagnosis, candidate changes, frozen replay, comparative metrics, human
   approval, activation, monitoring, and rollback. Audit storage alone is not self-improvement.
5. **Ordinary users do not start with schemas.** Guided setup asks about interests, model, process
   store, document destination, and schedule. It writes the auditable configuration on the user's
   behalf. Expert resources remain optional.

## Sources of truth and precedence

The implementation baseline is conjunctive:

1. the user's non-negotiable constraints above;
2. `ai-intelligence-contract.json` from the current scheduled workflow;
3. the nine-table Feishu Base schema read through `lark-cli`;
4. the current Daily, Review, candidate-index, and review-index output contracts;
5. security and human-approval boundaries already present in Briefwright.

When the old Briefwright RFCs or implementation disagree with this baseline, they are migrated or
superseded. The implementation matrix may record evidence; it may not redefine the target.

## Target architecture

```text
Guided setup / CLI / Codex Skill
                 |
        configuration compiler
                 |
          frozen execution plan
                 |
   +-------------+------------------+
   |             |                  |
Connectors   ModelProvider     DocumentStore
   |             |                  |
   +------ workflow engine ----------+
                 |
       local transactional journal
                 |
          ControlPlaneStore
   +-------------+-----------------------------+
   |             |              |              |
Lark Base   PostgreSQL        MySQL      SQLite fallback
```

The local transactional journal is a bounded crash-recovery mechanism, not a hidden second business
control plane. With a remote store selected, sources, active rules, feedback, approvals, and
published run state are read from or synchronized to that store under explicit ownership rules.
Every run freezes the remote revision and records its digest before collection begins.

## Workstream A: canonical domain contract

Define storage-neutral entities and stable identifiers for:

- sources;
- runs;
- captures;
- receipts;
- items;
- state events;
- feedback;
- experiments;
- rules.

The canonical schema retains the existing integrity equation, rule links, source timestamps,
selection state, failure state, approval state, idempotency keys, payload fingerprints, and
relationships. Store-specific record IDs are adapter metadata, not domain identity.

Acceptance:

- one JSON Schema and generated TypeScript type set describes the domain records;
- every store passes the same contract suite;
- unknown or lossy fields fail import instead of being silently discarded;
- migrations are versioned, dry-runnable, backed up, and independently logged.

## Workstream B: process-data stores

### Lark CLI / Feishu Base

Use `lark-cli` as the only Feishu transport. Briefwright does not embed a second Feishu SDK or ask
users to paste OAuth tokens into project configuration.

Configuration contains a Base URL or token, identity (`user` or `bot`), optional Lark CLI profile,
and table mapping. The existing nine-table IDs can be imported directly. New installations can
provision or validate a compatible Base only after an explicit user-confirmed write operation.

Required behavior:

- `doctor` checks the executable, version, identity, token status, Base access, table existence,
  fields, select options, links, and write permissions without changing records;
- reads are projected and paginated through `+record-list` or `+record-search`;
- writes use business-ID lookup followed by record-ID update or create, with bounded batches;
- links are resolved from stable business IDs and never guessed;
- the adapter maps canonical fields to the existing Chinese Feishu schema;
- sources, rules, feedback, and approvals can be pulled before a run;
- runs, captures, receipts, items, events, metrics, and proposals are pushed idempotently;
- partial synchronization produces a visible partial run and a retryable outbox;
- no table deletion, field deletion, or schema mutation occurs during normal operation.

### PostgreSQL and MySQL

Both adapters use the same canonical migrations and repository contract. Connection strings are
secret references. Online doctor checks connectivity, permissions, schema version, transaction
support, and clock/time-zone behavior. Integration tests exercise a real temporary database in CI.

### SQLite fallback

When no process store is configured, setup selects SQLite and says that the project is in local-only
mode. SQLite remains fully functional and uses the same canonical entities. Switching stores uses an
explicit export/import/sync command with counts, hashes, dry-run, and conflict reporting.

## Workstream C: model providers

Replace the `ai: qwen` enum and direct `new QwenProvider()` calls with a registry resolved from a
provider resource. Ship protocol adapters for OpenAI-compatible chat/responses-style structured
generation and Anthropic Messages, plus reviewed presets for common hosted and local providers.
Providers declare:

- ID, version, protocol, model, endpoint, capabilities, and structured-output strategy;
- typed secret references and redaction behavior;
- endpoint/host policy, timeout, retry, rate-limit, and cost metadata;
- online check and analysis methods;
- fixture and contract tests.

Unknown providers can be registered through the public SDK. Ordinary setup offers detected or
documented choices; expert users may configure a compatible endpoint only after its exact host is
explicitly trusted. No provider can weaken evidence validation or selection policy.

## Workstream D: document stores

### Local folder

The default fallback writes validated Markdown to a project-relative folder. Daily, Review, and
their indexes use the production sections, frontmatter, markers, stable IDs, and empty-run behavior.

### Obsidian

The Obsidian adapter adds explicit vault root, briefing root, index paths, Wiki-link and heading
validation, `obsidian://` open support, and human-approved knowledge proposals. A vault outside the
project root is a separately approved filesystem capability. Automatic runs may write only the
configured briefing paths; evergreen notes remain behind the proposal/commit gateway.

Document adapters expose render, validate, publish, replay, open, and proposal operations. Notion
and future systems implement this contract without changing the workflow engine.

## Workstream E: production workflow parity

The engine must preserve the observable production stages:

1. initialize;
2. freeze due manifest;
3. discover;
4. capture;
5. write one receipt per due source;
6. normalize;
7. verify canonical evidence;
8. globally deduplicate;
9. score seven dimensions;
10. select Daily, Review, or MachineOnly;
11. publish;
12. persist;
13. validate cross-store integrity;
14. complete.

It also preserves independent run context, same-day identity, source lanes and bounded concurrency,
all seven canonical Rule IDs, first-baseline and cadence semantics, failures and rejections, Daily
and Review zero-item output, the bounded completion report, and post-write validation.

The existing system is imported rather than recreated from memory:

- `briefwright import lark` reads the current Base schema and data into a versioned snapshot;
- `briefwright import contract` imports the execution contract and verifies its digest;
- `briefwright sync plan` shows ownership, creates/updates/conflicts, and record-link resolution;
- `briefwright sync apply --yes` performs an explicitly confirmed, resumable migration or sync;
- no existing Base record or Obsidian file is deleted by import or normal sync.

## Workstream F: governed self-improvement

### Observe

Persist complete run quality, source, evidence, duplicate, selection, user-feedback, latency, cost,
and failure measurements. Support the production feedback vocabulary: include, skip, review,
compare, classification correction, score correction, source correction, and process feedback.

### Diagnose

A scheduled evaluator identifies repeated, explainable problems only after minimum sample and time
windows. Diagnoses cite the affected records and metric definitions. It never changes active
configuration.

### Propose

Generate non-active candidates for policy, prompt, source cadence, source set, normalization,
deduplication, provider choice, or output template. Every proposal records a hypothesis, triggering
feedback, baseline identities, candidate identities, rollback conditions, and expected guardrails.

### Evaluate

Policy candidates freeze the sample and replay baseline and candidate. They report positive
retention, negative selection, evidence compliance, coverage, and selection deltas. Eligibility and
improvement are separate: a sufficiently large but worse or unchanged experiment cannot be
approved by the normal command. Provider, prompt, source, output, and deduplication diagnoses remain
non-active proposals until a human supplies a candidate whose effects can be observed without
silently spending model budget or mutating production state.

### Approve, activate, monitor, rollback

Only a human can approve and activate. Policy activation is digest-bound and atomic and has an
explicit rollback command. Source cadence likewise requires an explicit approve/reject decision and
honors human locks. No experiment currently authorizes automatic rollback or autonomous prompt,
provider, source, output, or knowledge mutation.

## Workstream G: ordinary-user experience

The recommended entry point is a guided `briefwright setup`, also used conversationally by the
Codex Skill. It asks only:

1. what the briefing is about;
2. which model/provider to use and where its local secret reference lives;
3. whether to use detected Lark Base (recommended), PostgreSQL, MySQL, or local SQLite;
4. whether to use a detected Obsidian vault (recommended) or a local folder;
5. whether and when to schedule, after a real preview.

Setup never silently writes to Feishu, a vault, or the native scheduler. It first shows a plan.
`doctor` separates offline configuration checks from online provider, store, connector, and output
checks. Errors identify the failed component and the next command.

The README first teaches this path, clearly distinguishes fixture demonstration from a real AI run,
and links focused provider, Lark, database, Obsidian, local-folder, migration, operations, and
self-improvement guides. YAML and internal resources appear only in advanced documentation.

## Verification and release gates

Required evidence before a new stable release:

- domain and adapter contract suites for SQLite, Lark CLI, PostgreSQL, and MySQL;
- real temporary PostgreSQL and MySQL integration tests;
- Lark CLI dry-run/request-shape tests plus authenticated read-only validation against the existing
  Base; writes only against a user-approved disposable test Base or deterministic fake CLI;
- provider contract tests for every bundled adapter and an optional user-owned live smoke;
- local-folder and temporary-vault Obsidian end-to-end tests;
- import/sync dry-run against the existing Base and vault with zero unexplained loss;
- formal run, crash/resume, retry, idempotency, replay, tamper, and cross-store integrity tests;
- improvement tests proving a harmful candidate cannot pass the approval gate;
- cross-platform CLI and package smoke tests;
- dependency, secret, SSRF, subprocess, SQL-injection, path, symlink, and prompt-injection review;
- a clean checkout, clean package install, and honest capability output;
- manual ordinary-user walkthrough from setup to first real briefing.

No row is marked complete until implementation, automated evidence, a usable path, and failure
behavior all exist. Existing `v1.0.0` remains historical evidence of the local subset and is not the
completion baseline for this plan.

## Plan self-review

The first review of this plan found and resolved these design risks:

- **Two sources of truth:** separated the local crash journal from the selected business control
  plane and required explicit ownership plus frozen remote revisions.
- **Lark record links:** required stable-business-ID resolution before writes instead of pretending
  linked fields are plain foreign keys.
- **False fallback:** made SQLite an explicit, visible local-only selection rather than silently
  swallowing a broken remote configuration. A configured but unavailable remote store is an error,
  not a fallback.
- **Vendor-neutral in name only:** required registry resolution and removed provider IDs from core
  types and commands.
- **Obsidian as generic Markdown:** added vault capability, indexes, Wiki-links, external-root
  approval, and knowledge-write boundaries.
- **Activity mistaken for learning:** separated sample eligibility from improvement gates and
  expanded experiments beyond count deltas.
- **Automatic optimization risk:** kept proposal, approval, activation, and rollback auditable and
  human-controlled.
- **Documentation ahead of code:** release and README claims are gated on installed capability
  readback and adapter tests.

Residual release limitations retained after implementation self-review:

- Feishu Base has no multi-table transaction. Briefwright uses stable-ID two-pass upserts, records
  partial failures, performs one bounded reconciliation, finalizes the run as partial when needed,
  and lets `sync plan`/`sync apply --yes` reconstruct and retry the immutable record set. It does not
  claim atomic Base commits.
- PostgreSQL and MySQL portability is verified by isolated local server tests and by the CI
  service-container job. A workstation without those servers reports the integration tests as
  skipped rather than claiming a local live pass.
- OpenAI-compatible endpoints still have to satisfy Briefwright's runtime JSON contract. A provider
  name or successful HTTP response alone is never treated as semantic compatibility.
- Normal run synchronization treats hydrated sources and active rules as control-plane input and
  never deletes records. Concurrent human edits between a displayed sync plan and a later apply are
  replanned; there is intentionally no blind delete or schema rewrite.
- Prompt/provider/output/dedup findings are actionable proposals, not autonomously executable
  experiments. Only the deterministic policy replay and cadence paths have approve/activate or
  approve/reject transitions in this release.
