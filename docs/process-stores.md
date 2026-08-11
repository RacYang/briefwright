# Process-data stores

The process store owns sources, runs, captures, receipts, items, events, feedback, experiments, and rules. The local SQLite journal remains the crash-recovery boundary for a run; with a remote store selected, the remote revision is frozen before collection and finalized records are synchronized afterward.

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

`processStore: auto` and an omitted value mean SQLite fallback; Briefwright does not guess a team database or Base. Moving data is explicit: import, `sync plan`, then `sync apply --yes`. Unknown conflicts or partial failures remain visible and retryable.
