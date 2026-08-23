---
name: briefwright
description: Create and operate source-linked AI intelligence briefings and governed knowledge intake in ordinary language. Use for guided installation, model choice, Feishu or SQL process data, Obsidian or local documents, previews, formal runs, schedules, diagnostics, replay, selected-article proposals or commits, feedback, and governed self-improvement.
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

Always inspect the capture manifest before a live preview or formal run. For `codex-browser`, inspect
only the listed public X profiles in strict read-only mode. For `in-app-browser`, use the isolated Codex
in-app Browser without taking over Chrome, the user's foreground tab, or another desktop app. Reserve
`computer-use` for a source that explicitly requires local App/UI operation. For either URL-bound mode,
open only the declared entry URL, remain on its exact allowed hosts, and read only public visible content.
Never log in, type, download, interact, change settings, or access private content. Create the declared
bundle, validate it, and pass it to the run. Missing access, a mode mismatch, or an out-of-bound URL is a
failed receipt, never permission to broaden access or silently fall back to HTTP.
If an in-app Browser or Computer Use capture includes `publishedAt`, require `dateKind: event` or
`dateKind: page-updated`. Only an explicit event date may drive Daily freshness; a page-update date is
document metadata and must not be restated as an event date. For a bounded incident replay, use
`preview --live --editorial --capture-bundle BUNDLE --bundle-only`; do not use that partial scope as
schedule-readiness proof.

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

For schedules, first complete a current source preview, then `preview --live --editorial` with the
configured real model, and an online doctor. A source-only preview is not evidence that the briefing is
useful. The editorial shadow must contain at least one Daily or Review item, have no model failures, and
remain a local preview. Then describe the schedule.
Enablement must reject a stale or tampered preview, changed configuration, or failed online
preflight. For evergreen knowledge, show the proposal preview before the approved commit. Never
write the knowledge target directly.

## Source-bound knowledge intake

When the user says an article is useful or should enter their knowledge base, treat that as intent
to begin intake, not as selection or commit authorization. A generic feedback label or feedback ID
is not a knowledge selection and must never be passed to the proposal path. Never synthesize
selection or proposal IDs, or calculate binding digests outside the CLI. Process one published item
and at most one knowledge-target write at a time. One user confirmation authorizes at most one CLI
state transition; consume it for that transition and never carry it forward.

Keep the commands internal unless the user asks for them, and use this sequence:

1. Resolve exactly one published Daily or Review item with `briefwright --json knowledge resolve`,
   using one item ID, canonical URL, or exact title and an exact run ID when needed. Resolution is
   read-only: require `writes: 0`, show the user the title, canonical source, and run, and retain the
   exact item, run, capture, and selection-digest binding internally. Stop on an unpublished or
   ambiguous reference instead of choosing a likely match.
2. Ask the user to confirm that exact article selection. Only then call
   `briefwright --json knowledge select` with the same one-of item, URL, or title reference,
   `--yes`, and the exact `--expect-selection <selection-digest>`. Use only the returned selection
   ID. If the identity or digest changed, re-resolve and ask again. Explain that selection creates a
   durable local receipt but does not write a knowledge target; a generic feedback record such as
   `knowledge-worthy`, any feedback ID, or earlier general approval does not substitute for this
   confirmation. Do not first add generic feedback when the user's intent is knowledge intake. If a
   matching feedback row already exists, do not claim feedback deduplication: the current runtime
   retains the generic signal as feedback and exposes the selection-linked receipt separately; one
   item carrying both still counts as one effective positive item.
3. Resolve one Markdown target inside the configured document root. Generate one fresh UUID v4 as
   the client request ID before the first proposal call, preserve it across retries, handoffs, and
   context compression, then call
   `briefwright --json knowledge propose <selection-id>` with the exact
   `--request-id <uuid-v4>`, `--target <relative-markdown-path>`, and optional heading. Let the CLI infer `create` or `merge`;
   do not force an operation or bypass its full eligible-vault scan. A duplicate, conflicting
   capture, multiple match, incomplete scan, or missing heading returns `HOLD`; an unsafe target is
   also blocking. In either case, report the reason, create no committable proposal, and keep
   knowledge-target writes at zero rather than trying another target silently. After every
   `PROPOSED` response, call `briefwright --json knowledge readback --request-id <same-uuid-v4>`
   before showing the proposal or asking for commit confirmation; do the same if the response is
   missing or uncertain.
   A retry of `knowledge propose` is allowed only with that exact same request ID, selection, target,
   and heading; `READBACK` means the existing proposal was reused with zero writes. Never generate a
   replacement request ID merely because a response was lost. Require that this readback returns the
   stored operation, bounded diff, expected target hash, resulting content hash, proposal digest,
   vault-scan digest, and expected post-scan digest; missing proposal-review fields are blocking.
4. Only for the matching `READBACK`, require preview and target readback `MATCH`, then show the
   inferred operation, exact target and optional heading, bounded diff, and
   expected write count. Retain the expected target hash, resulting content hash, proposal digest,
   request ID, vault-scan digest, and expected post-scan digest from that same JSON result; never recompute,
   edit, or reuse them for another proposal. State that only proposal metadata and its preview were
   created and the knowledge target is unchanged. Do not request commit confirmation until the user
   has reviewed this exact proposal.
5. Obtain a separate confirmation bound to that proposal. Do not reuse selection confirmation or a
   general request such as "save it". Only then call
   `briefwright --json knowledge commit <proposal-id>` with `--yes`, the exact
   `--expect-digest <proposal-digest>`, and `--expect-writes 1`. The CLI must recheck the selection,
   proposal content, target preimage, and vault scan; install without clobbering; reread the exact
   bytes; verify the expected unique post-scan match; and durably record the receipt.

Treat conversation state as a cache and CLI readback as the recovery authority. Before handing this
flow to another task or whenever context may be compressed, preserve only the exact run/item,
selection ID and digest, request ID, proposal ID and digest, target, expected write count, and phase:
`selection confirmation CONSUMED; commit confirmation REQUIRED` or `commit confirmation CONSUMED`.
After a handoff or compression, call `knowledge readback` with the preserved request ID before taking
the next action. Never infer an unconsumed confirmation from a summary, generic feedback, or the fact
that the user previously said the article was valuable.

Call the knowledge change committed only when the JSON result says `COMMITTED`, readback is `MATCH`,
the receipt ID, observed hash, and byte count are present, and a subsequent `knowledge readback`
reports the commit receipt and target readback as `MATCH`. A cleanup warning after that durable
receipt is warning-only: report it and any retained backup path, and do not retry the commit. Any
missing confirmation, wrong digest or count, stale target, scan drift, duplicate, conflict, write
failure, or readback mismatch is blocking and must not be converted into success. If the runtime
reports `RECOVERY_INCOMPLETE`, require `retryable: false`, `receiptStatus`, and the structured target,
backup, displaced, and temporary path observations; assume every path marked `PRESERVE` requires
preservation. Report exact paths only when the runtime returned them. If structured output omits the
paths, say that recovery-path readback is unavailable and remain `HOLD`; never infer paths, search
for candidates, delete files, or retry. Never retry any failed commit automatically; resolve the
reported cause, create a fresh proposal when required, and repeat proposal review and confirmation.

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
