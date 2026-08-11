import path from "node:path";

import { loadEffectiveConfig } from "../config/load.js";
import { scheduleDefinition, type SchedulerPlatform } from "../scheduler/definition.js";
import { installSchedule, uninstallSchedule } from "../scheduler/install.js";
import { SqliteStateStore } from "../state/sqlite.js";

export async function describeSchedule(configPath: string, platform = process.platform as SchedulerPlatform) {
  const absoluteConfig = path.resolve(configPath);
  const config = await loadEffectiveConfig(absoluteConfig);
  if (!["darwin", "linux", "win32"].includes(platform)) throw new Error(`Unsupported scheduler platform: ${platform}`);
  return { config, definition: scheduleDefinition({ schedule: config.schedule, platform, projectRoot: config.projectRoot, configPath: absoluteConfig, executable: process.execPath, cliPath: path.resolve(process.argv[1]!) }) };
}

export async function enableSchedule(configPath: string) {
  const { config, definition } = await describeSchedule(configPath);
  const installed = await installSchedule(definition);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    try {
      return { scheduleId: store.recordSchedule(definition.platform, definition.expression, config.projectRoot, definition.native), ...installed, definition };
    } catch (error) {
      await uninstallSchedule(definition);
      throw error;
    }
  } finally { store.close(); }
}

export async function disableProjectSchedule(configPath: string) {
  const { config, definition } = await describeSchedule(configPath);
  await uninstallSchedule(definition);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    const active = store.activeSchedule();
    try {
      if (active) store.disableSchedule(active.id);
    } catch (error) {
      await installSchedule(definition);
      throw error;
    }
    return { scheduleId: active?.id ?? definition.id, disabled: true };
  } finally { store.close(); }
}

export async function scheduleStatus(configPath: string) {
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try { return { configured: config.schedule, active: store.activeSchedule() }; } finally { store.close(); }
}
