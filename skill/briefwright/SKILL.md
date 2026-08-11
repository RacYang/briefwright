---
name: briefwright
description: Create and operate source-linked AI intelligence briefings with Briefwright. Use for recurring research briefings, release monitoring, auditable digests, Qwen-backed Daily and Review reports, briefing diagnostics, feedback, scheduling, replay, or human-approved knowledge integration.
---

# Briefwright

Use the installed `briefwright` CLI as the only schema, policy, execution, and durable-state
authority. This Skill supplies a conversational path; it must not emulate the runtime or edit SQLite.

## Start with the smallest path

1. Resolve `briefwright` with `command -v briefwright`.
2. Read `briefwright --json capabilities`.
3. For evaluation, run `briefwright --json demo`.
4. For a project, collect only name and interests, then run
   `briefwright --json init --yes --name <name> --interest <topics...>`.
5. Run `briefwright --json preview` and summarize the artifact, receipt counts, and failures.
6. Do not enable a schedule or knowledge write during setup.

Ordinary users maintain only `briefing.yaml`. Do not ask them for rule IDs, score weights, database
tables, connector internals, concurrency, digests, or prompt schemas.

## Qwen credential boundary

Formal `run` needs the configured Qwen secret reference. Prefer an existing process environment
variable. Otherwise tell the user to put `DASHSCOPE_API_KEY` in the project's ignored `.env.local`
file. Never ask them to paste a secret into chat, never display the value, and never put it in
`briefing.yaml`.

Use `briefwright --json doctor --online` before the first formal run. A 401/403 model failure can mean
the key, region, workspace, model, or plan endpoint does not match. Report that precise boundary; do
not repeatedly probe models or silently switch billing endpoints. Expert endpoint/model changes use
`briefwright config eject --yes`, followed by `config validate` and `config explain provider`.

## Formal run

After online doctor passes, run `briefwright --json run` and report:

- run ID and success/partial/failed outcome;
- Daily and Review paths;
- updated, unchanged, failed, skipped, and missing source counts;
- model failures and their affected source IDs;
- whether the run was resumed or already complete.

Never translate a failed source or unsupported model claim into a confirmed fact. Empty Daily or
Review artifacts are valid.

## Explain and repair

Use the CLI before editing:

```bash
briefwright --json config validate
briefwright --json config render
briefwright --json config explain <field>
briefwright --json doctor
briefwright --json status
briefwright --json replay <run-id>
```

For a v1 intent or older database, preview migration first. Apply only after explaining the backup:

```bash
briefwright --json config migrate
briefwright --json config migrate --write
briefwright --json db migrate
briefwright --json db migrate --write
```

## Confirmation boundaries

Before a native schedule, policy activation/rollback, cadence decision, or knowledge commit:

1. render the effective configuration with references redacted;
2. summarize the exact target, schedule, sources, and permissions;
3. obtain explicit confirmation;
4. invoke the matching CLI command with `--yes`.

For schedules, call `schedule describe` before `schedule enable --yes`. For knowledge, call
`knowledge propose` and show its preview path before `knowledge commit <id> --yes`. Never write the
knowledge target directly.

## Feedback and improvement

Record only feedback the user actually gives:

```bash
briefwright --json feedback add <item-id> --type reviewed|used|ignored|knowledge-worthy
briefwright --json feedback summary
```

Do not optimize policy directly from conversation. The experiment CLI enforces the 14-day and
50-reviewed-item gate, approval, activation, and rollback. Source cadence changes likewise remain
proposals until approved; respect human locks.

## Final handoff

Return only what is needed to act: briefing name, data mode, run outcome, output paths, receipt and
failure scope, schedule state, and the next safe command. Never claim a capability completed when its
JSON result is missing or failed.
