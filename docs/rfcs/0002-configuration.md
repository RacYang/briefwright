# RFC 0002: Configuration, secrets, snapshots, and migration

- Status: Accepted
- Date: 2026-08-10

## Decision

Briefwright uses two configuration surfaces:

1. a small user intent document;
2. a compiled effective configuration used by the runtime.

The effective configuration is generated, validated, redacted, canonically hashed, and frozen at run start.

## Intent configuration

The ordinary user file is `briefing.yaml`:

```yaml
version: 1
name: My AI briefing
preset: ai-daily
interests:
  - AI agents
  - model releases
  - AI safety
schedule: manual
output: markdown
```

It deliberately does not expose database tables, connector internals, rule IDs, concurrency, or evidence weights.

## Advanced resources

Expert configuration resources use an envelope:

```yaml
apiVersion: briefwright.dev/v1alpha1
kind: Source
metadata:
  id: SRC-EXAMPLE
spec: {}
```

Resource kinds include `Project`, `Profile`, `Source`, `PolicyBundle`, `Output`, and `PromptPack`.

## Configuration domains

- Protocol: packaged invariants and state transitions; not user-overridable.
- Policy: versioned evidence, selection, review, retention, and cadence rules.
- Deployment: paths, stores, runtime limits, scheduling, and outputs.
- Sources: connector instances and source-specific settings.
- Prompts: versioned model instructions and structured output contracts.
- Secrets: typed references only; values are never ordinary configuration.
- State: runs, receipts, captures, items, events, cursors, and feedback; never configuration.

## Precedence

Operational configuration uses one documented order, from lowest to highest:

1. schema defaults;
2. connector defaults;
3. project configuration;
4. selected profile;
5. local ignored override;
6. allowlisted process environment variables;
7. explicit CLI overrides.

Environment variables and CLI flags may override operational settings such as logging, paths, timeout, concurrency, dry-run, and profile selection. They may not override policy thresholds, rule identity, evidence gates, permissions, retention, or knowledge-write boundaries.

Every effective value retains its origin for `config explain`.

## Secret references

Secret fields accept a tagged reference, never an untyped string:

```yaml
secretRef:
  provider: env
  key: PROVIDER_API_KEY
```

Initial providers are `env` and `file`; keychain and vault providers may be added later. Resolution happens after parsing and validation. Secret values never appear in rendered effective configuration, hashes, logs, errors, fixtures, or run summaries.

## Loading lifecycle

1. Parse documents without interpolation.
2. Identify document versions.
3. Apply in-memory, stepwise migrations.
4. Validate each document against its schema.
5. Validate cross-document references and topology.
6. Apply allowed overrides.
7. Resolve secret references by typed field.
8. Render a redacted effective configuration.
9. Canonicalize and compute digests.
10. Freeze the snapshot for the run.

## Run provenance

Every run records:

- core version;
- active profile;
- configuration digest;
- policy digest;
- source-manifest digest;
- prompt digest;
- connector versions;
- explicit overrides;
- secret reference identities without values.

## Validation commands

- `config validate`: offline syntax, schema, reference, topology, and policy validation.
- `config render`: redacted effective configuration.
- `config explain`: effective value and origin.
- `config diff`: semantic difference between two resolved configurations.
- `config migrate --dry-run --diff`: migration preview; no write by default.
- `doctor`: environment, secret existence, permissions, store, connector, and output checks.

## Migration rules

- Unknown fields are errors.
- Migrations are pure, sequential functions.
- A migration that can lose information fails.
- Downgrades fail unless explicitly supported.
- Scheduled runs never rewrite configuration.
- Configuration and database migrations are separate operations.
- Writes require an explicit flag and produce a backup and migration log.
- Deprecations are warned before removal.

## Hot reload

The first release does not support production hot reload. A validated snapshot applies to the next run. A failed new configuration leaves the last-known-good configuration available without changing an active run.

