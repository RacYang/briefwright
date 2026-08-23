import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { migrateConfiguration } from "../src/commands/migrate.js";
import { migrateProjectDatabase } from "../src/commands/migrate.js";
import { initializeProject } from "../src/commands/init.js";
import { SqliteStateStore } from "../src/state/sqlite.js";
import { DATABASE_MIGRATIONS, migrateDatabase } from "../src/state/migrations.js";

const GOVERNED_KNOWLEDGE_INTAKE_V13_CHECKSUM =
  "815838951a24f3a5344458f5dd61762507df8a723933615aaea1bc6cc21664ad";

describe("versioned migrations", () => {
  it("keeps the historical v13 knowledge-intake migration immutable", () => {
    const migration = DATABASE_MIGRATIONS.find((entry) => entry.version === 13);
    expect(migration).toBeDefined();
    expect(createHash("sha256")
      .update(`${migration!.version}\n${migration!.name}\n${migration!.sql}`)
      .digest("hex"))
      .toBe(GOVERNED_KNOWLEDGE_INTAKE_V13_CHECKSUM);
  });

  it("previews intent migration without writing and writes only with a backup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-intent-migrate-"));
    const configPath = path.join(root, "briefing.yaml");
    const v1 = "version: 1\nname: Old\ninterests: [AI agents]\n";
    await writeFile(configPath, v1, "utf8");
    const preview = await migrateConfiguration(configPath, false);
    expect(preview).toMatchObject({ changed: true, fromVersion: 1, toVersion: 3, written: false });
    expect(await readFile(configPath, "utf8")).toBe(v1);
    const written = await migrateConfiguration(configPath, true);
    expect(written.written).toBe(true);
    expect(await readFile(configPath, "utf8")).toContain("version: 3");
    await expect(access(written.backupPath!)).resolves.toBeUndefined();
  });

  it("detects a legacy database and requires an explicit upgrade with backup", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-db-migrate-"));
    const databasePath = path.join(root, "state.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(DATABASE_MIGRATIONS[0]!.sql);
    legacy.close();
    expect(() => new SqliteStateStore(databasePath, root)).toThrow("requires migration");
    const database = new DatabaseSync(databasePath);
    const result = migrateDatabase(database, { databasePath, write: true });
    database.close();
    expect(result.current).toBe(result.latest);
    expect(result.applied).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    await expect(access(result.backupPath!)).resolves.toBeUndefined();
    const store = new SqliteStateStore(databasePath, root);
    store.close();
  });

  it("upgrades a real v12-shaped database and keeps unfinished legacy proposals fail-closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-db-v12-migrate-"));
    const databasePath = path.join(root, "state.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    for (const migration of DATABASE_MIGRATIONS.filter((entry) => entry.version <= 12)) {
      database.exec(migration.sql);
      const checksum = createHash("sha256")
        .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
        .digest("hex");
      database.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)")
        .run(migration.version, migration.name, checksum, "2026-08-20T00:00:00.000Z");
    }
    database.prepare("INSERT INTO config_snapshots(digest,config_json,created_at) VALUES (?,?,?)")
      .run("CONFIG-V12", "{}", "2026-08-20T00:00:00.000Z");
    database.prepare(`INSERT INTO runs(run_id,generated_at,mode,config_digest,status,result_json)
      VALUES (?,?,?,?,?,?)`).run(
      "RUN-V12",
      "2026-08-20T00:00:00.000Z",
      "live",
      "CONFIG-V12",
      "success",
      "{}",
    );
    database.prepare(`INSERT INTO captures(
      capture_id,run_id,source_id,external_key,canonical_url,title,summary,published_at,
      captured_at,content_hash,evidence_class,raw_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "CAPTURE-V12",
      "RUN-V12",
      "SOURCE-V12",
      "EXTERNAL-V12",
      "https://example.com/v12",
      "Legacy article",
      "Legacy summary",
      "2026-08-20T00:00:00.000Z",
      "2026-08-20T00:00:00.000Z",
      "sha256:legacy",
      "primary",
      "{}",
    );
    database.prepare(`INSERT INTO items(
      item_id,run_id,capture_id,canonical_identity,title,summary,why_it_matters,domain,
      evidence_status,evidence_json,analysis_json,score,disposition,exclusion_reason
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "ITEM-LEGACY",
      "RUN-V12",
      "CAPTURE-V12",
      "legacy-identity",
      "Legacy article",
      "Legacy summary",
      "Legacy reason",
      "AI",
      "confirmed-primary",
      "{}",
      "{}",
      1,
      "daily",
      null,
    );
    database.prepare("INSERT INTO run_items(run_id,item_id,capture_id,item_json) VALUES (?,?,?,?)")
      .run("RUN-V12", "ITEM-LEGACY", "CAPTURE-V12", "{}");
    database.prepare(`INSERT INTO knowledge_proposals(
      proposal_id,item_id,status,target_path,target_heading,expected_target_hash,content,created_at
    ) VALUES (?,?,?,?,?,?,?,?)`).run(
      "KNP-LEGACY-V12",
      "ITEM-LEGACY",
      "proposed",
      path.join(root, "legacy.md"),
      null,
      null,
      "legacy candidate",
      "2026-08-20T00:00:00.000Z",
    );
    const result = migrateDatabase(database, { databasePath, write: true });
    database.close();
    expect(result).toMatchObject({ current: 14, applied: [13, 14] });
    await expect(access(result.backupPath!)).resolves.toBeUndefined();
    const store = new SqliteStateStore(databasePath, root);
    expect(() => store.knowledgeProposal("KNP-LEGACY-V12")).toThrow("predates the governed intake contract");
    store.close();
    const migrated = new DatabaseSync(databasePath);
    expect(migrated.prepare("SELECT request_id value FROM knowledge_proposals WHERE proposal_id='KNP-LEGACY-V12'").get())
      .toEqual({ value: null });
    migrated.close();
  });

  it("separates only selection-linked signals while preserving generic feedback in v14", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-db-v13-migrate-"));
    const databasePath = path.join(root, "state.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);
    for (const migration of DATABASE_MIGRATIONS.filter((entry) => entry.version <= 13)) {
      database.exec(migration.sql);
      const checksum = createHash("sha256")
        .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
        .digest("hex");
      database.prepare("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)")
        .run(migration.version, migration.name, checksum, "2026-08-20T00:00:00.000Z");
    }
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare("INSERT INTO feedback(feedback_id,item_id,run_id,feedback_type,note,created_at) VALUES (?,?,?,?,?,?)")
      .run("FDB-SELECTION", "ITEM-1", "RUN-1", "knowledge-worthy", null, "2026-08-20T00:00:00.000Z");
    database.prepare("INSERT INTO feedback(feedback_id,item_id,run_id,feedback_type,note,created_at) VALUES (?,?,?,?,?,?)")
      .run("FDB-GENERIC", "ITEM-1", "RUN-1", "knowledge-worthy", "generic", "2026-08-20T00:00:01.000Z");
    database.prepare(`INSERT INTO knowledge_selections(
      selection_id,feedback_id,item_id,run_id,capture_id,selection_digest,source_snapshot_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?)`).run(
      "KNS-1",
      "FDB-SELECTION",
      "ITEM-1",
      "RUN-1",
      "CAP-1",
      `sha256:${"1".repeat(64)}`,
      "{}",
      "2026-08-20T00:00:00.000Z",
    );

    const result = migrateDatabase(database, { databasePath, write: true });
    expect(result).toMatchObject({ current: 14, applied: [14] });
    expect(database.prepare("SELECT feedback_type value FROM feedback WHERE feedback_id='FDB-SELECTION'").get())
      .toEqual({ value: "knowledge-selection-receipt" });
    expect(database.prepare("SELECT feedback_type value FROM feedback WHERE feedback_id='FDB-GENERIC'").get())
      .toEqual({ value: "knowledge-worthy" });
    expect(database.prepare("SELECT 1 present FROM sqlite_master WHERE type='index' AND name='knowledge_proposals_request_id'").get())
      .toEqual({ present: 1 });
    const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    database.prepare(`INSERT INTO knowledge_proposals(
      proposal_id,item_id,status,target_path,content,created_at,request_id
    ) VALUES (?,?,?,?,?,?,?)`).run(
      "KNP-LOWER",
      "ITEM-1",
      "proposed",
      path.join(root, "lower.md"),
      "candidate",
      "2026-08-20T00:00:02.000Z",
      requestId,
    );
    expect(() => database.prepare(`INSERT INTO knowledge_proposals(
      proposal_id,item_id,status,target_path,content,created_at,request_id
    ) VALUES (?,?,?,?,?,?,?)`).run(
      "KNP-UPPER",
      "ITEM-1",
      "proposed",
      path.join(root, "upper.md"),
      "candidate",
      "2026-08-20T00:00:03.000Z",
      requestId.toUpperCase(),
    )).toThrow("UNIQUE constraint failed");
    database.close();
    await expect(access(result.backupPath!)).resolves.toBeUndefined();
  });

  it("previews a fresh database migration without creating state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-db-preview-"));
    const configPath = await initializeProject({ directory: root, yes: true });
    await expect(migrateProjectDatabase(configPath, false)).resolves.toMatchObject({ current: 0, latest: 14, applied: [] });
    await expect(access(path.join(root, ".briefwright"))).rejects.toThrow();
  });
});
