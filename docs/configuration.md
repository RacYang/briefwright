# Configuration

## Ordinary users

`briefing.yaml` expresses intent: name, interests, preset, schedule, model provider, process store, and document store.
Missing optional values receive documented defaults. Unknown values are errors.

Most users should run `briefwright setup` and let the guided flow write this file. `init` is the minimal non-guided path; `config eject` is for experts.

The precedence order is:

1. packaged schema and connector defaults;
2. packaged preset, policy, prompt, and provider resources;
3. `briefing.yaml` intent;
4. explicitly ejected resources in `briefwright.d/`;
5. an approved experiment policy in local state;
6. explicit command flags for the current operation.

Secrets do not participate in merging. A provider stores only a typed `env` or `file` reference; the
value is resolved after validation and never enters configuration hashes, snapshots, JSON output, or
errors.

## Explain and compare

```bash
briefwright config validate
briefwright config render
briefwright config explain provider
briefwright config diff --against ../other/briefing.yaml
```

`render` contains secret references, not values. `explain` reports the winning origin.

## Migration

Intent and database migrations are separate:

```bash
briefwright config migrate                 # preview only
briefwright config migrate --write         # backup and atomic write
briefwright db migrate                      # status only
briefwright db migrate --write              # backup and transactional migrations
```

Unknown future versions and lossy downgrades fail. Scheduled runs never rewrite configuration.

## Expert resources

`config eject --yes` creates typed resources with the envelope:

```yaml
apiVersion: briefwright.dev/v1alpha1
kind: Profile
metadata:
  id: local
spec: {}
```

The generated profile is the right place to override any selected provider endpoint or model.
Policy changes should normally use the experiment lifecycle rather than direct editing.

## Storage intent

`processStore: auto` falls back to SQLite. A configured Lark, PostgreSQL, or MySQL store becomes the collaborative control plane; credentials remain references. `documentStore: auto` falls back to the project folder. An explicit Obsidian object can point to a vault outside the project, and that root becomes the bounded document-write capability.

See [providers](providers.md), [process stores](process-stores.md), [Lark](lark.md), and [document stores](document-stores.md).

## Binding an existing execution contract

An imported production workflow may keep its complete source contract as a fail-closed deployment input:

```yaml
sourceContract:
  path: /absolute/path/to/ai-intelligence-contract.json
  sha256: 64-lowercase-hex-digest
```

Load verifies the digest and compatibility of the contract ID, seven active Rule IDs, process-store table mapping, document root and Daily/Review paths, plus run, due, capture, feedback, and completion sections. A changed or incompatible contract stops `doctor`, preview, run, and automation export. Scheduled runs never migrate or rewrite it.
