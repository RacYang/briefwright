import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { configDigest, loadEffectiveConfig } from "../config/load.js";
import { prepareSafeFilePath } from "../config/paths.js";
import { runDoctor, type DoctorCheck } from "./doctor.js";
import { scheduleDefinition, scheduleIdentifier, type SchedulerPlatform } from "../scheduler/definition.js";
import { inspectNativeSchedule, installSchedule, uninstallSchedule } from "../scheduler/install.js";
import { SqliteStateStore } from "../state/sqlite.js";

export async function describeSchedule(configPath: string, platform = process.platform as SchedulerPlatform) {
  const absoluteConfig = path.resolve(configPath);
  const config = await loadEffectiveConfig(absoluteConfig);
  if (!["darwin", "linux", "win32"].includes(platform)) throw new Error(`Unsupported scheduler platform: ${platform}`);
  return { config, definition: scheduleDefinition({ schedule: config.schedule, platform, projectRoot: config.projectRoot, configPath: absoluteConfig, executable: process.execPath, cliPath: path.resolve(process.argv[1]!) }) };
}

export async function scheduleReadiness(configPath: string, options: {
  now?: Date;
  preflight?: (configPath: string) => Promise<DoctorCheck[]>;
} = {}) {
  const config = await loadEffectiveConfig(path.resolve(configPath));
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  let preview;
  try { preview = store.latestLivePreview(configDigest(config)); } finally { store.close(); }
  if (!preview) throw new Error("No successful live preview matches the current configuration. Run 'briefwright preview --live' before enabling the schedule.");
  const now = options.now ?? new Date();
  if (now.getTime() - new Date(preview.generatedAt).getTime() > 7 * 86_400_000) {
    throw new Error("The matching live preview is older than 7 days. Run 'briefwright preview --live' again before enabling the schedule.");
  }
  await prepareSafeFilePath(config.projectRoot, preview.path);
  const diskHash = createHash("sha256").update(await readFile(preview.path)).digest("hex");
  if (diskHash !== preview.contentHash) throw new Error("The matching live preview artifact changed on disk. Run 'briefwright preview --live' again before enabling the schedule.");
  const checks = await (options.preflight ?? ((target) => runDoctor(target, { online: true })))(path.resolve(configPath));
  const failures = checks.filter((check) => !check.ok);
  if (failures.length) throw new Error(`Online preflight failed: ${failures.map((check) => `${check.name}: ${check.detail}`).join("; ")}`);
  return { preview, checks };
}

export async function enableSchedule(configPath: string, options: {
  now?: Date;
  preflight?: (configPath: string) => Promise<DoctorCheck[]>;
} = {}) {
  const { config, definition } = await describeSchedule(configPath);
  const readiness = await scheduleReadiness(configPath, options);
  const installed = await installSchedule(definition);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    try {
      return { scheduleId: store.recordSchedule(definition.platform, definition.expression, config.projectRoot, definition.native), location: installed.location, definition, previewRunId: readiness.preview.runId };
    } catch (error) {
      await installed.rollback();
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
  let recorded: ReturnType<SqliteStateStore["activeSchedule"]> = null;
  try {
    await access(config.storage.path);
    const store = new SqliteStateStore(config.storage.path, config.projectRoot);
    try { recorded = store.activeSchedule(); } finally { store.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const native = await inspectNativeSchedule(scheduleIdentifier(config.projectRoot));
  return { configured: config.schedule, recorded, native, inSync: Boolean(recorded) === native.active };
}
