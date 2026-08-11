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

describe("versioned migrations", () => {
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
    expect(result.applied).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    await expect(access(result.backupPath!)).resolves.toBeUndefined();
    const store = new SqliteStateStore(databasePath, root);
    store.close();
  });

  it("previews a fresh database migration without creating state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-db-preview-"));
    const configPath = await initializeProject({ directory: root, yes: true });
    await expect(migrateProjectDatabase(configPath, false)).resolves.toMatchObject({ current: 0, latest: 11, applied: [] });
    await expect(access(path.join(root, ".briefwright"))).rejects.toThrow();
  });
});
