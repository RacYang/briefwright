import { createHash } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface DatabaseMigration {
  version: number;
  name: string;
  sql: string;
}

const LEGACY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS config_snapshots (
    digest TEXT PRIMARY KEY,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    generated_at TEXT NOT NULL,
    mode TEXT NOT NULL,
    config_digest TEXT NOT NULL REFERENCES config_snapshots(digest),
    status TEXT NOT NULL,
    result_json TEXT
  );
  CREATE TABLE IF NOT EXISTS receipts (
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    source_id TEXT NOT NULL,
    result TEXT NOT NULL,
    detail TEXT,
    PRIMARY KEY (run_id, source_id)
  );
  CREATE TABLE IF NOT EXISTS output_artifacts (
    run_id TEXT NOT NULL REFERENCES runs(run_id),
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (run_id, kind)
  );
`;

export const DATABASE_MIGRATIONS: DatabaseMigration[] = [
  { version: 1, name: "alpha-baseline", sql: LEGACY_SCHEMA },
  {
    version: 2,
    name: "complete-runtime-domain",
    sql: `
      ALTER TABLE runs ADD COLUMN started_at TEXT;
      ALTER TABLE runs ADD COLUMN completed_at TEXT;
      ALTER TABLE runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'preview';
      ALTER TABLE runs ADD COLUMN current_stage TEXT NOT NULL DEFAULT 'complete';
      ALTER TABLE runs ADD COLUMN policy_digest TEXT;
      ALTER TABLE runs ADD COLUMN prompt_digest TEXT;
      ALTER TABLE runs ADD COLUMN source_digest TEXT;
      ALTER TABLE runs ADD COLUMN execution_plan_json TEXT;

      ALTER TABLE receipts ADD COLUMN attempted_at TEXT;
      ALTER TABLE receipts ADD COLUMN completed_at TEXT;
      ALTER TABLE receipts ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE receipts ADD COLUMN capture_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE receipts ADD COLUMN error_code TEXT;

      CREATE TABLE IF NOT EXISTS execution_stages (
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        stage TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        detail_json TEXT,
        PRIMARY KEY (run_id, stage)
      );
      CREATE TABLE IF NOT EXISTS due_sources (
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        source_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        reason TEXT NOT NULL,
        source_snapshot_json TEXT NOT NULL,
        PRIMARY KEY (run_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS source_cursors (
        source_id TEXT PRIMARY KEY,
        cursor_json TEXT NOT NULL,
        last_scan_at TEXT,
        last_success_at TEXT,
        last_effective_update_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS captures (
        capture_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        source_id TEXT NOT NULL,
        external_key TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        published_at TEXT,
        captured_at TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        evidence_class TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        UNIQUE (run_id, source_id, external_key, content_hash)
      );
      CREATE INDEX IF NOT EXISTS captures_identity ON captures(canonical_url, external_key, content_hash);
      CREATE TABLE IF NOT EXISTS items (
        item_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        capture_id TEXT NOT NULL REFERENCES captures(capture_id),
        canonical_identity TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        why_it_matters TEXT NOT NULL,
        domain TEXT NOT NULL,
        evidence_status TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        score REAL NOT NULL,
        disposition TEXT NOT NULL,
        exclusion_reason TEXT,
        UNIQUE (run_id, canonical_identity)
      );
      CREATE TABLE IF NOT EXISTS item_scores (
        item_id TEXT NOT NULL REFERENCES items(item_id),
        dimension TEXT NOT NULL,
        raw_score REAL NOT NULL,
        weight REAL NOT NULL,
        weighted_score REAL NOT NULL,
        reason TEXT,
        PRIMARY KEY (item_id, dimension)
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        occurred_at TEXT NOT NULL,
        stage TEXT NOT NULL,
        event_type TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        payload_fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feedback (
        feedback_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(item_id),
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        feedback_type TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS experiments (
        experiment_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        baseline_policy_digest TEXT NOT NULL,
        candidate_policy_json TEXT NOT NULL,
        sample_json TEXT,
        metrics_json TEXT,
        approved_at TEXT,
        activated_at TEXT,
        rolled_back_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_proposals (
        proposal_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES items(item_id),
        status TEXT NOT NULL,
        target_path TEXT NOT NULL,
        target_heading TEXT,
        expected_target_hash TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        committed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS schedule_installations (
        schedule_id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        expression TEXT NOT NULL,
        project_root TEXT NOT NULL,
        installed_definition TEXT NOT NULL,
        installed_at TEXT NOT NULL,
        disabled_at TEXT
      );
    `,
  },
  {
    version: 3,
    name: "governance-and-observations",
    sql: `
      CREATE TABLE IF NOT EXISTS capture_observations (
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        capture_id TEXT NOT NULL REFERENCES captures(capture_id),
        observed_at TEXT NOT NULL,
        changed INTEGER NOT NULL,
        PRIMARY KEY (run_id, capture_id)
      );
      CREATE TABLE IF NOT EXISTS source_settings (
        source_id TEXT PRIMARY KEY,
        cadence_hours REAL NOT NULL,
        human_locked INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cadence_proposals (
        proposal_id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        current_hours REAL NOT NULL,
        proposed_hours REAL NOT NULL,
        reason TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
    `,
  },
];

function checksum(migration: DatabaseMigration): string {
  return createHash("sha256").update(`${migration.version}\n${migration.name}\n${migration.sql}`).digest("hex");
}

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

export function databaseMigrationStatus(database: DatabaseSync): {
  current: number;
  latest: number;
  pending: DatabaseMigration[];
  legacy: boolean;
} {
  const latest = DATABASE_MIGRATIONS.at(-1)?.version ?? 0;
  const legacy = hasTable(database, "runs") && !hasTable(database, "schema_migrations");
  if (!hasTable(database, "schema_migrations")) {
    return { current: legacy ? 1 : 0, latest, pending: DATABASE_MIGRATIONS.filter((item) => item.version > (legacy ? 1 : 0)), legacy };
  }
  const applied = database.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; checksum: string }>;
  for (const row of applied) {
    const known = DATABASE_MIGRATIONS.find((migration) => migration.version === row.version);
    if (!known) throw new Error(`Database contains unknown future migration ${row.version}`);
    if (row.checksum !== checksum(known)) throw new Error(`Database migration checksum mismatch at version ${row.version}`);
  }
  const row = { version: applied.at(-1)?.version ?? 0 };
  return { current: row.version, latest, pending: DATABASE_MIGRATIONS.filter((item) => item.version > row.version), legacy: false };
}

export function migrateDatabase(database: DatabaseSync, options: {
  databasePath: string;
  write: boolean;
  backup?: boolean;
}): ReturnType<typeof databaseMigrationStatus> & { applied: number[]; backupPath?: string } {
  let status = databaseMigrationStatus(database);
  if (!options.write) return { ...status, applied: [] };
  let backupPath: string | undefined;
  if (options.backup !== false && existsSync(options.databasePath) && status.current > 0 && status.pending.length > 0) {
    backupPath = `${options.databasePath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try { database.exec("PRAGMA wal_checkpoint(FULL)"); } catch {}
    copyFileSync(options.databasePath, backupPath);
  }
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  if (status.legacy) {
    const baseline = DATABASE_MIGRATIONS[0]!;
    database.prepare("INSERT OR IGNORE INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)")
      .run(baseline.version, baseline.name, checksum(baseline), new Date().toISOString());
    status = databaseMigrationStatus(database);
  }
  const applied: number[] = [];
  for (const migration of status.pending) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)")
        .run(migration.version, migration.name, checksum(migration), new Date().toISOString());
      database.exec("COMMIT");
      applied.push(migration.version);
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`Database migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ...databaseMigrationStatus(database), applied, ...(backupPath ? { backupPath } : {}) };
}
