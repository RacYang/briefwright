---
name: briefwright
description: Create and operate source-linked AI intelligence briefings with Briefwright. Use for recurring research briefings, auditable multi-provider Daily and Review reports, Lark or SQL process data, Obsidian or local documents, diagnostics, scheduling, replay, or governed improvement and knowledge integration.
---

# Briefwright

Use the installed `briefwright` CLI as the only schema, policy, execution, and durable-state
authority. This Skill supplies a conversational path; it must not emulate the runtime or edit SQLite.

## Start with the smallest path

1. Resolve `briefwright` with `command -v briefwright`.
2. Read `briefwright --json capabilities`.
3. For evaluation, run `briefwright --json demo`.
4. For a project, use `briefwright setup`. Collect name, interests, model choice, process store,
   document destination, and schedule; never invent a Base token, database reference, or vault path.
5. Run `briefwright --json preview` and summarize the artifact, receipt counts, and failures.
6. Do not enable a schedule or knowledge write during setup.

Ordinary users maintain only `briefing.yaml`. Do not ask them for rule IDs, score weights, database
tables, connector internals, concurrency, digests, or prompt schemas.

## Provider credential boundary

Formal `run` needs the selected provider's secret reference unless it is a keyless local provider.
Codex, OpenAI, Anthropic, Gemini, Qwen, and Ollama are peer choices. Codex reuses the local account;
API providers use an existing environment
variable or ignored local file. Never request a secret in chat, display it, put it in
`briefing.yaml`, or silently switch providers.

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

When Lark configuration selects `xCapture: codex-browser`, first run `briefwright --json capture
manifest`. If it lists zero sources, run without a bundle. Otherwise inspect only the listed public X
profiles in strict read-only mode, produce the declared v1 bundle without inventing posts or state,
run `capture validate <bundle>`, and pass it to `run --capture-bundle <bundle>`. Missing access is a
failed receipt, not permission to use private content or interact with X.

If a terminal run has source or model failures, preserve it and use
`briefwright --json run --retry-failed`. This creates an immutable `-R01` (or later) recovery run
linked to the original; it never rewrites the original run or artifact. Do not use retry when there
is no failed or pending work.

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

For schedules, first run `preview --live` with the current configuration, then `doctor --online`,
then call `schedule describe` before `schedule enable --yes`. Enablement is expected to reject a
preview older than seven days, a changed configuration, a tampered preview artifact, or a failed
online preflight. For knowledge, call
`knowledge propose` and show its preview path before `knowledge commit <id> --yes`. Never write the
knowledge target directly.

## Feedback and improvement

Record only feedback the user actually gives:

```bash
briefwright --json feedback add <item-id> --type reviewed|used|ignored|knowledge-worthy|include|skip|review|compare|classification-correction|score-correction|source-correction|process-feedback
briefwright --json feedback summary
briefwright --json improve diagnose --window 30
briefwright --json improve list
```

Do not optimize policy directly from conversation. The experiment CLI enforces the 14-day and
50-reviewed-item gate, evidence guardrails, demonstrated improvement, approval, activation, and
rollback. Source cadence changes remain proposals until approved; respect human locks.

For Lark, use `import lark` and `sync plan` before any `sync apply --yes`; authentication belongs to
`lark-cli`. A new Base uses `lark provision --yes`. A new PostgreSQL or MySQL store uses
`sql provision --yes`; ordinary doctor and sync planning remain read-only. For Obsidian, keep automatic writes inside the configured briefing root and use the
knowledge proposal gateway for evergreen notes.

## Final handoff

Return only what is needed to act: briefing name, data mode, run outcome, output paths, receipt and
failure scope, schedule state, and the next safe command. Never claim a capability completed when its
JSON result is missing or failed.
