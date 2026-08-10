import { DatabaseSync } from "node:sqlite";

import { prepareSafeFilePathSync } from "../config/paths.js";
import type { EffectiveConfig } from "../config/types.js";
import type { RunResult } from "../core/types.js";
import { countReceipts, runOutcome } from "../core/accounting.js";

export class SqliteStateStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string, projectRoot: string) {
    prepareSafeFilePathSync(projectRoot, databasePath);
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
    `);
    const runColumns = this.database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    if (!runColumns.some((column) => column.name === "result_json")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN result_json TEXT");
    }
  }

  assertRunWritable(result: RunResult): void {
    const existing = this.database
      .prepare("SELECT config_digest FROM runs WHERE run_id = ?")
      .get(result.runId) as { config_digest: string } | undefined;
    if (existing && existing.config_digest !== result.configDigest) {
      throw new Error(
        `Run ${result.runId} already exists with a different configuration digest; choose a new run ID`,
      );
    }
    if (existing) throw new Error(`Run ${result.runId} is already finalized and cannot be changed`);
  }

  saveRun(
    config: EffectiveConfig,
    result: RunResult,
    artifact?: { kind: string; path: string; contentHash: string },
  ): void {
    const outcome = runOutcome(countReceipts(config.preset.sources.map((source) => source.id), result.receipts));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertRunWritable(result);

      this.database.prepare(`
        INSERT INTO config_snapshots (digest, config_json, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(digest) DO NOTHING
      `).run(result.configDigest, JSON.stringify(config), result.generatedAt);

      this.database.prepare(`
        INSERT INTO runs (run_id, generated_at, mode, config_digest, status, result_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(result.runId, result.generatedAt, result.mode, result.configDigest, outcome, JSON.stringify(result));

      const receiptStatement = this.database.prepare(`
        INSERT INTO receipts (run_id, source_id, result, detail)
        VALUES (?, ?, ?, ?)
      `);
      for (const receipt of result.receipts) {
        receiptStatement.run(result.runId, receipt.sourceId, receipt.result, receipt.detail ?? null);
      }
      if (artifact) {
        this.database.prepare(`
          INSERT INTO output_artifacts (run_id, kind, path, content_hash)
          VALUES (?, ?, ?, ?)
        `).run(result.runId, artifact.kind, artifact.path, artifact.contentHash);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  latestRun(): {
    runId: string;
    generatedAt: string;
    mode: string;
    status: string;
    artifactPath: string | null;
    updated: number;
    observed: number;
    unchanged: number;
    failed: number;
    skipped: number;
  } | null {
    const row = this.database.prepare(`
      SELECT
        runs.run_id,
        runs.generated_at,
        runs.mode,
        runs.status,
        output_artifacts.path AS artifact_path,
        SUM(CASE WHEN receipts.result = 'updated' THEN 1 ELSE 0 END) AS updated,
        SUM(CASE WHEN receipts.result = 'observed' THEN 1 ELSE 0 END) AS observed,
        SUM(CASE WHEN receipts.result = 'unchanged' THEN 1 ELSE 0 END) AS unchanged,
        SUM(CASE WHEN receipts.result = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN receipts.result = 'skipped' THEN 1 ELSE 0 END) AS skipped
      FROM runs
      LEFT JOIN receipts ON receipts.run_id = runs.run_id
      LEFT JOIN output_artifacts
        ON output_artifacts.run_id = runs.run_id AND output_artifacts.kind = 'preview-markdown'
      GROUP BY runs.run_id
      ORDER BY runs.generated_at DESC
      LIMIT 1
    `).get() as {
      run_id: string;
      generated_at: string;
      mode: string;
      status: string;
      artifact_path: string | null;
      updated: number;
      observed: number;
      unchanged: number;
      failed: number;
      skipped: number;
    } | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      generatedAt: row.generated_at,
      mode: row.mode,
      status: row.status,
      artifactPath: row.artifact_path,
      updated: row.updated,
      observed: row.observed,
      unchanged: row.unchanged,
      failed: row.failed,
      skipped: row.skipped,
    };
  }

  replayBundle(runId: string): {
    config: EffectiveConfig;
    result: RunResult;
    artifactPath: string;
    contentHash: string;
  } {
    const row = this.database.prepare(`
      SELECT config_snapshots.config_json, runs.result_json,
             output_artifacts.path, output_artifacts.content_hash
      FROM runs
      JOIN config_snapshots ON config_snapshots.digest = runs.config_digest
      JOIN output_artifacts
        ON output_artifacts.run_id = runs.run_id AND output_artifacts.kind = 'preview-markdown'
      WHERE runs.run_id = ?
    `).get(runId) as {
      config_json: string;
      result_json: string | null;
      path: string;
      content_hash: string;
    } | undefined;
    if (!row) throw new Error(`Run not found or has no recorded artifact: ${runId}`);
    if (!row.result_json) throw new Error(`Run predates replay snapshots and cannot be reproduced: ${runId}`);
    return {
      config: JSON.parse(row.config_json) as EffectiveConfig,
      result: JSON.parse(row.result_json) as RunResult,
      artifactPath: row.path,
      contentHash: row.content_hash,
    };
  }

  close(): void {
    this.database.close();
  }
}
