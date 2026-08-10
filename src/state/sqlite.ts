import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EffectiveConfig } from "../config/types.js";
import type { RunResult } from "../core/types.js";

export class SqliteStateStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec(`
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
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        run_id TEXT NOT NULL REFERENCES runs(run_id),
        source_id TEXT NOT NULL,
        result TEXT NOT NULL,
        detail TEXT,
        PRIMARY KEY (run_id, source_id)
      );
    `);
  }

  saveRun(config: EffectiveConfig, result: RunResult): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare("SELECT config_digest FROM runs WHERE run_id = ?")
        .get(result.runId) as { config_digest: string } | undefined;
      if (existing && existing.config_digest !== result.configDigest) {
        throw new Error(
          `Run ${result.runId} already exists with a different configuration digest; choose a new run ID`,
        );
      }

      this.database.prepare(`
        INSERT INTO config_snapshots (digest, config_json, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(digest) DO NOTHING
      `).run(result.configDigest, JSON.stringify(config), result.generatedAt);

      this.database.prepare(`
        INSERT INTO runs (run_id, generated_at, mode, config_digest, status)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          generated_at = excluded.generated_at,
          mode = excluded.mode,
          config_digest = excluded.config_digest,
          status = excluded.status
      `).run(result.runId, result.generatedAt, result.mode, result.configDigest, "completed");

      const receiptStatement = this.database.prepare(`
        INSERT INTO receipts (run_id, source_id, result, detail)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id, source_id) DO UPDATE SET
          result = excluded.result,
          detail = excluded.detail
      `);
      for (const receipt of result.receipts) {
        receiptStatement.run(result.runId, receipt.sourceId, receipt.result, receipt.detail ?? null);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}
