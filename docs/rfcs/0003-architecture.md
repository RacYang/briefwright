# RFC 0003: Runtime architecture and extension boundaries

- Status: Accepted
- Date: 2026-08-10

## Goals

- Deterministic control flow around model-assisted classification and synthesis.
- Complete due-source accounting.
- Idempotent same-run retries.
- Storage and output portability.
- Human approval before knowledge writes.
- A thin Skill layer that does not become the runtime or database.

## Pipeline

```text
Resolve config
  -> freeze due-source manifest
  -> discover and capture
  -> write one receipt per due source
  -> normalize
  -> verify primary evidence
  -> globally deduplicate
  -> score and select
  -> render Daily and Review
  -> validate outputs
  -> commit run summary
```

Stages may use bounded concurrency internally. Stage boundaries are barriers. State-store tables, candidate identifiers, global deduplication, and output files each have one logical writer.

## Core interfaces

### Source connector

Declares identity, version, capabilities, configuration schema, authentication needs, examples, ownership, and risk labels. Implements offline validation, online connection check, and capture.

### State store

Persists projects, sources, runs, due manifests, receipts, captures, items, events, feedback, experiments, and configuration snapshots. SQLite is the default; remote stores are adapters.

### Evidence verifier

Produces an evidence envelope that distinguishes direct confirmation, unverified claims, inaccessible sources, and secondary clues.

### Selector

Applies deterministic gates and versioned policy to place an item in `Daily`, `Review`, or `MachineOnly`.

### Output adapter

Renders and validates a bounded artifact without gaining access to unrelated filesystem paths. Markdown is the default; Obsidian and external systems are adapters.

### Scheduler adapter

Creates or describes schedules only after explicit user confirmation. The runtime itself is also usable from cron, CI, or another orchestrator.

## Skill boundary

The Codex Skill provides conversational setup, intent clarification, preview, configuration explanation, diagnostics, and bounded execution. It invokes the CLI and reads its structured results. It does not duplicate schemas, own durable state, or directly mutate knowledge stores.

## Default deployment

- Node.js CLI.
- Local SQLite state.
- Local Markdown output.
- Built-in demonstration fixture.
- No background service.
- No credential or external account.

## Safety boundaries

- Source collection is read-only.
- Failure receipts cannot be promoted to confirmed facts.
- Secondary sources cannot silently replace an inaccessible canonical source.
- Model output cannot directly mutate durable state outside validated commands.
- Knowledge output requires a separate approval and commit gateway.
- Connector permissions are least-privilege and independently diagnosable.
- Output roots are resolved and bounded before writes.

## Testing

- Unit tests for identity, canonicalization, gates, migrations, and redaction.
- Contract tests for every connector.
- Golden tests for Markdown artifacts and run summaries.
- Replay fixtures for successful, empty, partial, duplicate, and retry runs.
- Property tests for accounting and idempotency invariants.
- Independent review of security and user experience before release.

