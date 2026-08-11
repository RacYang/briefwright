import { access } from "node:fs/promises";

import { loadEffectiveConfig } from "../config/load.js";
import { SqliteStateStore } from "../state/sqlite.js";

export interface ProjectStatus {
  scheduleEnabled: boolean;
  schedule: ReturnType<SqliteStateStore["activeSchedule"]>;
  latestRun: ReturnType<SqliteStateStore["latestRun"]>;
  statePath: string;
}

export async function projectStatus(configPath: string): Promise<ProjectStatus> {
  const config = await loadEffectiveConfig(configPath);
  try {
    await access(config.storage.path);
  } catch {
    return { scheduleEnabled: false, schedule: null, latestRun: null, statePath: config.storage.path };
  }

  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    return {
      scheduleEnabled: state.activeSchedule() !== null,
      schedule: state.activeSchedule(),
      latestRun: state.latestRun(),
      statePath: config.storage.path,
    };
  } finally {
    state.close();
  }
}
