# Process-data stores

The configured process store owns the published business state for sources, runs, captures, receipts, items, events, feedback, experiments, and rules. Local SQLite is an execution journal and recovery staging area. For a remote store, a run remains `withheld` until canonical records have been written and read back by stable business ID. The remote `published` readback is the commit point; only then may Daily/Review and managed indexes be promoted locally.

A remote write response is not an acknowledgement by itself. Briefwright compares scalar fields, relationships, the frozen due-manifest digest, and Daily/Review byte digests. A mismatch produces `failed + withheld`; it is never downgraded to `partial`, and no formal document is exposed.

## Selection

```yaml
processStore: sqlite
```

```yaml
processStore:
  driver: postgres
  connection: { provider: env, key: BRIEFWRIGHT_POSTGRES_URL }
```

```yaml
processStore:
  driver: mysql
  connection: { provider: file, key: .secrets/mysql-url }
```

PostgreSQL and MySQL use parameterized statements, transactional upserts, a schema-version metadata table, and the same canonical JSON record contract. For a new database, run `briefwright sql provision --yes`; online doctor and sync planning are read-only and never create tables. CI exercises both against real service containers. Connection URLs are secret references.

`processStore: auto` and an omitted value mean SQLite fallback; Briefwright does not guess a team database or Base. Moving data is explicit: import, `sync plan`, then `sync apply --yes`. Unknown conflicts or failures remain visible and retryable.

Feishu Base deployments must configure a realistic `maximumRecordsPerTable` (default 2,000). Online doctor reports usage for every table and blocks when a table is full. Sync planning also rejects a batch that would exceed the limit. Append-only ledgers need an explicit rollover/archive plan; Briefwright does not silently discard events or assume that an accepted API request survived over-capacity storage.

SQLite retains detailed execution telemetry, including every internal item transition. The Feishu business projection intentionally carries only run and failure events plus the final transition of Daily/Review items; machine-only transition traces are not copied into the interactive Base. When any table approaches its hard limit, cut over all nine configured table names to a parallel generation and provision that generation after explicit confirmation. Keep the prior generation read-only as an archive. Do not retarget individual relationship fields in place, delete history to make room, or raise `maximumRecordsPerTable` above the actual Base limit.
