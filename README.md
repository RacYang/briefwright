# Briefwright

Briefwright turns public-source snapshots into calm, source-linked, auditable briefings. It is designed for people who want a useful briefing in minutes and for operators who need deterministic receipts, replayable runs, and explicit approval boundaries before future external writes.

> Status: pre-release. The offline demo, guided initialization, strict intent configuration, local SQLite state, Markdown preview, and initial public-source connectors are working. Scheduling and knowledge-base integration remain disabled.

## Product promise

- See the first local briefing within five minutes.
- Start without an external database, account, or API key.
- Keep the ordinary user interface to one small intent file.
- Preserve every due source as exactly one auditable receipt.
- Never silently turn a failed source into a confirmed fact.
- Require explicit human approval before writing to a knowledge base.

## Quick start from a checkout

```bash
pnpm install
pnpm run build
node dist/cli.js demo

mkdir my-briefing
node dist/cli.js init --yes --directory my-briefing
node dist/cli.js preview --config my-briefing/briefing.yaml
node dist/cli.js preview --live --config my-briefing/briefing.yaml
```

The default preview uses clearly marked bundled fixtures. `--live` performs read-only network access to the preset's public sources. Each preview writes an immutable, run-named Markdown artifact. Neither command enables a schedule or writes to a knowledge base.

The internal system may be sophisticated; the user should only need to answer:

1. What do you care about?
2. When should the briefing arrive?
3. Where should it be written?

## Architecture direction

Briefwright separates:

- a simple user intent file;
- versioned policy packs;
- typed source connectors;
- immutable run snapshots and receipts;
- state-store and output adapters;
- an optional Codex Skill as a conversational setup layer.

See the accepted design records in [`docs/rfcs`](docs/rfcs).

## Current commands

- `demo`: offline proof with bundled fixtures.
- `init`: guided or non-interactive creation of one `briefing.yaml`.
- `preview`: local fixture or live public-source preview.
- `replay`: offline re-render and hash verification of a recorded run snapshot.
- `config validate|render|explain`: strict configuration tools.
- `doctor`: local environment checks.
- `status`: schedule state and the latest local run summary.
- `open`: open or print the latest local briefing path.
- `capabilities`: describe installed features for users and Skills.

Use the global `--json` option for bounded machine-readable output. The Codex Skill in [`skill/briefwright`](skill/briefwright) uses this interface and does not duplicate runtime logic.

The package includes the Skill files. Until an installer is added, copy `skill/briefwright` into the Codex skills directory or use it directly from a checkout.

## License

Apache License 2.0.
