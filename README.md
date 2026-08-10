# Briefwright

Briefwright turns source changes into calm, source-linked, auditable briefings. It is designed for people who want a useful briefing in minutes and for operators who need deterministic receipts, evidence gates, replayable runs, and human approval before knowledge-base writes.

> Status: early bootstrap. The public interface and configuration contracts are being defined before the first runnable release.

## Product promise

- See the first local briefing within five minutes.
- Start without an external database, account, or API key.
- Keep the ordinary user interface to one small intent file.
- Preserve every due source as exactly one auditable receipt.
- Never silently turn a failed source into a confirmed fact.
- Require explicit human approval before writing to a knowledge base.

## Intended quick start

```bash
npx briefwright demo
npx briefwright init
npx briefwright preview
npx briefwright enable
```

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

## License

Apache License 2.0.

