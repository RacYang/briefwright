import { access } from "node:fs/promises";

import { loadEffectiveConfig } from "../config/load.js";
import { SqliteStateStore } from "../state/sqlite.js";
import { inspectNativeSchedule } from "../scheduler/install.js";
import { scheduleIdentifier } from "../scheduler/definition.js";

export interface ProjectStatus {
  scheduleEnabled: boolean;
  scheduleInSync: boolean;
  nativeSchedule: Awaited<ReturnType<typeof inspectNativeSchedule>> | null;
  schedule: ReturnType<SqliteStateStore["activeSchedule"]>;
  latestRun: ReturnType<SqliteStateStore["latestRun"]>;
  statePath: string;
}

export async function projectStatus(configPath: string): Promise<ProjectStatus> {
  const config = await loadEffectiveConfig(configPath);
  try {
    await access(config.storage.path);
  } catch {
    const nativeSchedule = await inspectNativeSchedule(scheduleIdentifier(config.projectRoot));
    return { scheduleEnabled: nativeSchedule.active, scheduleInSync: !nativeSchedule.active, nativeSchedule, schedule: null, latestRun: null, statePath: config.storage.path };
  }

  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    const schedule = state.activeSchedule();
    const nativeSchedule = await inspectNativeSchedule(scheduleIdentifier(config.projectRoot));
    return {
      scheduleEnabled: nativeSchedule.active,
      scheduleInSync: Boolean(schedule) === nativeSchedule.active,
      nativeSchedule,
      schedule,
      latestRun: state.latestRun(),
      statePath: config.storage.path,
    };
  } finally {
    state.close();
  }
}
