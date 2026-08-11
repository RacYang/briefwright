import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { stringify } from "yaml";

import { loadEffectiveConfig, parseIntentWithMigration } from "../config/load.js";
import { prepareSafeFilePathSync } from "../config/paths.js";
import { databaseMigrationStatus, migrateDatabase } from "../state/migrations.js";

export async function migrateConfiguration(configPath: string, write: boolean) {
  const absolute = path.resolve(configPath);
  const result = await parseIntentWithMigration(absolute);
  const rendered = stringify(result.intent);
  const previous = await readFile(absolute, "utf8");
  if (!result.changed || !write) {
    return { changed: result.changed, fromVersion: result.fromVersion, toVersion: 2, written: false, preview: rendered };
  }
  const backupPath = `${absolute}.v${result.fromVersion}.backup`;
  await copyFile(absolute, backupPath);
  const temporary = `${absolute}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, rendered, { encoding: "utf8", flag: "wx" });
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { changed: previous !== rendered, fromVersion: result.fromVersion, toVersion: 2, written: true, backupPath, preview: rendered };
}

export async function migrateProjectDatabase(configPath: string, write: boolean) {
  const config = await loadEffectiveConfig(configPath);
  prepareSafeFilePathSync(config.projectRoot, config.storage.path);
  const database = new DatabaseSync(config.storage.path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    return write
      ? migrateDatabase(database, { databasePath: config.storage.path, write: true })
      : { ...databaseMigrationStatus(database), applied: [] as number[] };
  } finally {
    database.close();
  }
}
