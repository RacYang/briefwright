---
name: briefwright
description: Create and operate source-linked AI intelligence briefings in ordinary language. Use for guided installation, model choice, Feishu or SQL process data, Obsidian or local documents, previews, formal runs, schedules, diagnostics, replay, feedback, and governed self-improvement.
---

# Briefwright

Be the user's conversational product surface. The installed `briefwright` CLI is the only schema,
policy, execution, and durable-state authority, but it is an internal engine: do not require an
ordinary user to learn commands, flags, YAML, table IDs, rule IDs, score weights, digests, or prompt
schemas. Do not emulate the runtime, edit SQLite, or create a second state model.

## Conversational onboarding

Proceed one decision at a time and translate the answer into CLI JSON calls. Do not dump a form or a
command list. Ask only for information that cannot be discovered safely:

1. what the briefing should watch and how often the user wants to receive it;
2. which model they want: Codex, OpenAI, Anthropic, Gemini, Qwen, Ollama, or another registered
   compatible provider; never assume Qwen or silently switch providers;
3. where process data should live: Feishu Base through `lark-cli` is recommended for collaboration,
   PostgreSQL/MySQL are supported, and SQLite is the explicit zero-configuration fallback;
4. where Markdown should live: an Obsidian vault is recommended, and a normal local folder is the
   explicit fallback.

Users state intent; this Skill generates and maintains `briefing.yaml` internally. Show a short
plain-language summary of the chosen model, stores, document location, and schedule intent before
writing it. Setup records schedule intent but never installs a schedule.

## Installation discovery

First resolve `briefwright` with `command -v briefwright`. If it is missing:

1. check `node --version` and `npm --version`; Briefwright requires Node.js 22.13 or newer;
2. explain the missing prerequisite in plain language;
3. check registry availability with `npm view briefwright version --json`; only if that succeeds,
   offer the short-name install and, after explicit confirmation, run `npm install -g briefwright`;
4. if the package is not published, say so plainly and offer the current checksum-pinned GitHub
   release tarball or a source checkout; never present an unavailable registry command as working;
5. resolve the command again and verify `briefwright --version` plus
   `briefwright --json capabilities`.

Never paste a GitHub tarball URL as the normal installation path. A release tarball is an explicit
offline/checksum fallback only. Never claim installation succeeded without both verification calls.

For a no-account evaluation, run `briefwright --json demo`. For a real project, collect the choices
above and invoke `briefwright --json setup --yes` with explicit arguments. Then run
`briefwright --json preview`. Explain that fixture preview proves setup and document rendering but
does not use AI or prove live sources. Do not expose the generated command unless the user asks.

## Provider and credential boundary

Formal `run` needs the selected provider's secret reference unless it is a keyless local provider.
Codex reuses the local account; API providers use an existing environment variable or ignored local
file. Never request a secret in chat, display it, put it in `briefing.yaml`, or silently switch
providers. Offer to check whether the expected environment reference exists without printing its
value.

Use `briefwright --json doctor --online` before the first formal run. A 401 or 403 can mean that the
key, region, workspace, model, endpoint, or plan does not match. Say which check failed and what the
user controls; do not repeatedly probe models or silently switch billing endpoints. Expert endpoint
or model changes use `config eject`, followed by validation and provider explanation.

## Feishu, SQL, and documents

When Feishu is selected, first check `lark-cli --version` and `lark-cli whoami` without exposing
identity tokens. Briefwright does not own the `lark-cli` login. If it is missing or signed out,
explain the exact boundary and offer the documented installation/login action if available in the
current environment; otherwise offer SQLite as a conscious fallback. Never downgrade silently. Ask
the user only for the Base link or app token, not table IDs. For a new Base, summarize that the nine
standard tables will be added without deleting or overwriting existing records, then obtain explicit
confirmation before `briefwright --json lark provision --yes`.

For PostgreSQL or MySQL, ask for the name of an environment variable containing the connection URL,
not the URL itself. Obtain explicit confirmation before schema provisioning. For Obsidian, ask for
or safely discover the vault folder, and explain that automatic writes stay inside
`Inbox/AI Intelligence`. If there is no Obsidian vault, use a user-approved local folder.

Use read-only import and sync planning before any remote write. `doctor`, `import lark`, and
`sync plan` are read-only; `sync apply --yes`, `lark provision --yes`, and `sql provision --yes`
require explicit confirmation.

## Safe progression to a formal run

Use this sequence internally:

1. offline fixture preview;
2. local doctor;
3. live source preview;
4. online model/store/source doctor;
5. formal run.

After the formal run, report in plain language:

- run ID and success, partial, or failed outcome;
- Daily and Review paths;
- updated, unchanged, failed, skipped, and missing source counts;
- failed source IDs and concise reasons;
- model failures and their affected source IDs;
- whether the run was resumed or already complete.

Never translate a failed source or unsupported model claim into a confirmed fact. Empty Daily or
Review artifacts are valid. A partial outcome means usable output exists but named failures remain;
a failed outcome is blocking and must not be presented as success. Authentication and permission
failures are blocking for the affected integration. Individual source failures can be retried while
preserving the original run. Use `run --retry-failed` only when failed or pending work exists; it
creates an immutable recovery run and never rewrites the original.

When `xCapture: codex-browser` is configured, use the capture manifest. If it lists sources, inspect
only those public X profiles in strict read-only mode, create the declared bundle, validate it, and
pass it to the run. Missing access is a failed receipt, never permission to access private content
or interact with X.

## Diagnose and explain

Prefer structured JSON from `config validate`, `config render`, `config explain`, `doctor`,
`status`, and `replay`. Translate it into a short diagnosis with:

1. what passed;
2. what is blocking versus warning-only;
3. the exact affected model, store, source, schedule, or output;
4. the smallest safe next action.

Never print secret values. Never call an offline preview proof of AI, live-source, Feishu, Obsidian,
or scheduling readiness. For old configuration or databases, preview the migration and its diff;
explain the backup before applying it.

## Confirmation boundaries

Before a native schedule, remote schema/write, policy activation or rollback, cadence decision, or
knowledge commit:

1. render the effective configuration with references redacted;
2. summarize the exact target, schedule, sources, permissions, and expected writes;
3. obtain explicit confirmation;
4. invoke the matching CLI operation with `--yes`;
5. read back status and report the actual result.

For schedules, first complete a current live preview and online doctor, then describe the schedule.
Enablement must reject a stale or tampered preview, changed configuration, or failed online
preflight. For evergreen knowledge, show the proposal preview before the approved commit. Never
write the knowledge target directly.

## Governed self-improvement

Record only feedback the user actually gives. Use feedback summary and `improve diagnose` to produce
evidence-backed proposals. When proposals exist, explain each in ordinary language: hypothesis,
supporting feedback/run evidence, affected rules or sources, evaluation window, guardrails, and
rollback condition. Do not optimize policy directly from conversation.

Creating or evaluating a frozen candidate may be done when requested, but approval, activation,
rollback, and cadence decisions always require a separate explicit confirmation. Before approval or
activation, list proposals again, verify the 14-day and 50-reviewed-item gate, show baseline versus
candidate results, and name any failed guardrail. Read back the experiment state after the action.
Respect human locks. No intermediate data is a license for autonomous rule mutation.

## Final handoff

Return only what the user needs to act: briefing name, selected model, process-data mode, document
destination, run outcome, output paths, failure scope, schedule state, improvement proposal state,
and the next safe choice. Commands belong in an optional “advanced/manual” section only when the
user asks. Never claim a capability completed when its JSON result is missing or failed.
