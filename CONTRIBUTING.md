# Contributing to Briefwright

Briefwright welcomes focused issues and pull requests. The project is early, so discuss large changes before investing in an implementation.

## Development

Requirements:

- Node.js 22.13 or newer;
- pnpm 11.16.

```bash
pnpm install
pnpm run check
pnpm run build
node dist/cli.js demo --directory /tmp/briefwright-demo
```

## Design boundaries

- Ordinary users maintain one intent file.
- The config compiler is the only path from intent to an execution configuration.
- The runtime receives a frozen configuration snapshot.
- Connectors collect; they do not score, persist state, or render output.
- Renderers are deterministic and do not access the network.
- The Skill calls the CLI and owns no business truth.
- Source failures remain explicit and never become confirmed facts.
- Knowledge-base writes require an explicit human approval boundary.

## Pull requests

- Add or update tests for behavior changes.
- Keep fixtures deterministic and free of credentials or personal data.
- Run `pnpm run check` and `pnpm run build`.
- Explain user-visible configuration or migration effects.
- Do not add a new dependency when a small standard-library implementation is sufficient.

## Connector contributions

Connector changes must satisfy the documented descriptor and runtime contract, include configuration
validation, offline fixtures, network-boundary tests, explicit timeouts, conditional-fetch behavior,
and bounded response handling.
