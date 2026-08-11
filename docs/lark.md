# Feishu Base through Lark CLI

Briefwright uses `lark-cli` as its only Feishu transport. Install and authenticate it first, then verify `lark-cli whoami`. Conversational setup accepts either the Base app token or a direct official `feishu.cn`/`larksuite.com` `/base/...` link. Wiki links are rejected because a Wiki node ID is not a Base app token; open the underlying Base and copy its direct link.

```yaml
processStore:
  driver: lark
  baseToken: YOUR_BASE_APP_TOKEN
  identity: user
```

By default Briefwright resolves the portable standard table names `数据源`, `运行批次`, `情报条目`, `状态事件`, `人工反馈`, `优化实验`, `原始采集`, `规则版本`, and `扫描回执`. It never falls back to table IDs from another user's Base. Existing deployments may override any mapping with their own table name or ID.

For a new or partially prepared Base, run `briefwright lark provision --yes`. Provisioning is idempotent: it creates only missing standard tables, scalar fields, and relationship fields. It never deletes or renames a table or field and never overwrites a record. Duplicate standard table names or a configured missing `tbl...` ID fail closed.

`briefwright doctor --online` checks the CLI version, identity, access to all nine tables, required fields, and a record-upsert dry-run. `briefwright import lark` paginates all nine tables, resolves links to stable business IDs, validates every canonical record, creates a content-addressed local snapshot, and imports the history into the local evaluator; it makes no Base changes. `sync plan` lists creates, updates, unchanged records, conflicts, and a digest. Only `sync apply --yes` writes.

Reads are projected and paginated. Writes use stable business IDs to find record IDs, upsert scalar fields, then resolve relationship fields in a second pass. Existing source and rule records are treated as control-plane owned and are not overwritten by normal run synchronization. No normal command deletes a record or changes table structure.

The current source importer maps GitHub release pages to the GitHub API, arXiv list pages to RSS, and remaining public URLs to the bounded webpage connector. X profiles map either to the official X API or to the `codex-browser` bridge selected by `processStore.xCapture`. The bridge never treats browser output as trusted state: `capture manifest` freezes only currently due accounts and an expected bundle path, while `capture validate` enforces freshness, size, source/account binding, public `x.com/<account>/status/<id>` URLs, and one explicit captured/unchanged/failed outcome per requested source. Unsupported or unavailable sources fail visibly in their receipts.

Every explicit URL produces a capture record. Successful records include the available HTTP status, content type, language, author or organization, original publication value, ETag, Last-Modified, content hash, and parser version. Failed fetches also create a capture record with attempt count and failure reason, in addition to the source receipt. Protected source text is limited to a 25-word persisted excerpt; a bounded full body can be used transiently by the current model call but is stripped before the capture enters SQLite, Base, snapshots, or logs.
