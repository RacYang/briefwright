---
name: briefwright
description: Set up, preview, explain, diagnose, and operate Briefwright source-linked intelligence briefings. Use when a user wants a recurring research briefing, news or release monitor, source-backed digest, Briefwright project, or help with Briefwright configuration and receipts.
---

# Briefwright

Use the installed `briefwright` CLI as the only execution and configuration authority. This Skill is a conversational setup and explanation layer; it does not duplicate schemas, policies, state transitions, scoring, or durable state.

## First check

Resolve the CLI with `command -v briefwright`. If it is unavailable, explain that Briefwright must be installed before project operations. Do not invent CLI output or emulate the runtime from this file.

Read `briefwright --json capabilities` before using optional features. If `scheduling`, `externalDestinations`, or `knowledgeWrites` is false, report that boundary instead of improvising an alternative implementation.

## Default user path

Keep ordinary users on this sequence:

1. `briefwright --json demo`
2. `briefwright --json init --yes`
3. `briefwright --json preview`
4. `briefwright --json doctor`
5. `briefwright --json status`
6. Use `briefwright --json replay <run-id>` when provenance needs verification.
7. Show a bounded human-readable summary.
8. Enable scheduling only when the installed CLI exposes an enable capability and the user explicitly confirms its exact schedule and destinations.

Prefer fixture preview for a first experience. Use `briefwright --json preview --live` only when the user asks for current source reads or accepts that the command will access the network.

## Questions

Ask only for choices that cannot be safely inferred:

- what the briefing should watch;
- when it should run;
- where it should write.

Use recommended defaults for everything else. Do not ask ordinary users to select a database, connector implementation, scoring weight, Rule ID, concurrency value, table identifier, or digest algorithm.

## Confirmation boundaries

Preview and doctor are read-only except for local preview artifacts and local Briefwright state. Before any command that creates or changes a schedule, sends to an external destination, publishes, overwrites an existing artifact, installs a plugin, or writes to a knowledge base:

1. render the effective configuration with secrets redacted;
2. summarize schedule, source count, destinations, permissions, and last successful preview;
3. obtain explicit confirmation for the exact action;
4. invoke the CLI rather than performing the action directly.

Never treat a request for a briefing as implicit approval for external publishing or knowledge-base writes.

## Errors and partial runs

Parse bounded JSON output. Explain:

- what failed;
- what remained successful;
- what the failure affected;
- the next concrete CLI command;
- where detailed status can be inspected.

Do not turn a failed or inaccessible canonical source into a confirmed fact. Do not replace it silently with a secondary source. A partial run may still have a useful artifact; preserve its failure scope.

## Configuration

Ordinary users maintain only `briefing.yaml`. For explanation and diagnostics, use:

```bash
briefwright --json config validate
briefwright --json config render
briefwright --json config explain <field>
briefwright --json doctor
```

Do not edit generated effective configuration or SQLite state. Do not expose secrets. Do not recommend expert configuration unless the user's requirement cannot be expressed by the intent file and presets.

## Final handoff

Return only the information needed to act:

- project and briefing name;
- data mode: fixture or live;
- output path;
- due sources and receipt count;
- item count;
- failures or missing sources;
- schedule status;
- next safe action.
