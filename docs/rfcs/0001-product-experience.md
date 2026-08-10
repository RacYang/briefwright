# RFC 0001: Product experience and progressive disclosure

- Status: Accepted
- Date: 2026-08-10

## Decision

Briefwright will expose a small intent-oriented interface while compiling that intent into a complete, typed, auditable execution configuration.

Internal complexity is permitted only when it does not leak into the first-run experience.

## User-visible concepts

The default experience exposes at most five concepts:

1. briefing name;
2. interests;
3. source scope;
4. schedule;
5. destination.

Scoring dimensions, evidence thresholds, concurrency, retry policy, receipt invariants, state transitions, rule identities, and connector schemas are hidden behind safe presets until a user explicitly enters expert mode.

## Golden path

### Demo

`briefwright demo` must produce a local briefing without an account, API key, external database, or network dependency.

### Guided initialization

`briefwright init` asks only for missing intent, writes a minimal `briefing.yaml`, initializes local state, validates the result, and offers a preview. It must never overwrite an existing file without explicit confirmation.

### Preview before scheduling

`briefwright preview` shows the intended source scope, output location, policy preset, and a sample result. Scheduling is a separate action and is unavailable until preview and environment checks pass.

### Enable

`briefwright enable` displays a bounded human-readable summary and requires confirmation before creating or changing a schedule.

## Progressive disclosure

| Level | Audience | Interface |
|---|---|---|
| 0 | Evaluator | `demo` |
| 1 | Ordinary user | guided `init`, one intent file |
| 2 | Power user | documented intent options and presets |
| 3 | Operator | profiles, effective config, doctor, replay |
| 4 | Plugin author | connector SDK, schemas, migrations, fixtures |

Advanced files are generated only by an explicit `config eject` operation. Documentation landing pages must not require users to understand the advanced model.

## Defaults

- State: local SQLite.
- Output: local Markdown.
- Schedule: manual until explicitly enabled.
- Knowledge-base writes: disabled.
- External notifications: disabled.
- Evidence behavior: primary evidence preferred; failures remain visible.
- Configuration changes: affect the next run, never a run already in progress.

## Acceptance criteria

- A new user can produce a demo briefing in under five minutes.
- The default path needs no credential.
- The ordinary user maintains at most one file.
- Every error includes the failed field or component and a concrete next action.
- Effective configuration can be rendered with origins and secrets redacted.
- Destructive, scheduled, external, or knowledge-writing actions require an explicit confirmation boundary.
- Empty and partially successful runs still produce understandable output.

## Non-goals for the first release

- A visual workflow builder.
- Production hot reload.
- A hosted multi-tenant service.
- Automatic knowledge-base mutation.

