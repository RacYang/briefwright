import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ScheduleDefinition } from "./definition.js";
import type { SchedulerPlatform } from "./definition.js";

function launchAgentPath(definition: ScheduleDefinition): string {
  return path.join(homedir(), "Library", "LaunchAgents", `${definition.id}.plist`);
}

export async function inspectNativeSchedule(id: string, platform = process.platform as SchedulerPlatform): Promise<{ installed: boolean; active: boolean; location: string; detail: string }> {
  if (platform === "darwin") {
    const target = path.join(homedir(), "Library", "LaunchAgents", `${id}.plist`);
    let installed = false;
    try { installed = (await lstat(target)).isFile(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let active = false;
    try { execFileSync("launchctl", ["print", `gui/${process.getuid?.()}/${id}`], { stdio: "ignore" }); active = true; } catch {}
    return { installed, active, location: target, detail: installed === active ? (active ? "launchd task is installed and loaded" : "launchd task is absent") : "launchd plist and loaded state disagree" };
  }
  if (platform === "linux") {
    let content = "";
    try { content = execFileSync("crontab", ["-l"], { encoding: "utf8" }); } catch {}
    const installed = content.split(/\r?\n/).some((line) => line.includes(`# ${id}`));
    return { installed, active: installed, location: "user crontab", detail: installed ? "cron entry is installed" : "cron entry is absent" };
  }
  if (platform === "win32") {
    let installed = false;
    try { execFileSync("schtasks.exe", ["/Query", "/TN", id], { stdio: "ignore" }); installed = true; } catch {}
    return { installed, active: installed, location: `Task Scheduler:${id}`, detail: installed ? "Task Scheduler entry is installed" : "Task Scheduler entry is absent" };
  }
  throw new Error(`Unsupported scheduler platform: ${platform}`);
}

export interface ScheduleInstallation {
  location: string;
  rollback: () => Promise<void>;
}

function replaceCrontab(content: string): void {
  const result = spawnSync("crontab", ["-"], { input: content, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`crontab update failed: ${result.stderr || `exit ${result.status}`}`);
}

export async function installSchedule(definition: ScheduleDefinition): Promise<ScheduleInstallation> {
  if (definition.platform === "darwin") {
    const target = launchAgentPath(definition);
    await mkdir(path.dirname(target), { recursive: true });
    let previous: string | null = null;
    try {
      if ((await lstat(target)).isSymbolicLink()) throw new Error(`Refusing symlinked LaunchAgent target: ${target}`);
      previous = await readFile(target, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${target}.tmp-${randomUUID()}`;
    const restore = async () => {
      try { execFileSync("launchctl", ["bootout", `gui/${process.getuid?.()}`, target], { stdio: "ignore" }); } catch {}
      await rm(target, { force: true });
      if (previous !== null) {
        const recovery = `${target}.restore-${randomUUID()}`;
        await writeFile(recovery, previous, { encoding: "utf8", flag: "wx" });
        await rename(recovery, target);
        execFileSync("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, target], { stdio: "ignore" });
      }
    };
    try {
      await writeFile(temporary, definition.native, { encoding: "utf8", flag: "wx" });
      try { execFileSync("launchctl", ["bootout", `gui/${process.getuid?.()}`, target], { stdio: "ignore" }); } catch {}
      await rename(temporary, target);
      execFileSync("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, target], { stdio: "ignore" });
      return { location: target, rollback: restore };
    } catch (error) {
      await rm(temporary, { force: true });
      try { await restore(); } catch (restoreError) {
        throw new Error(`launchd install failed and restoring the previous task also failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`, { cause: error });
      }
      throw error;
    }
  }
  if (definition.platform === "linux") {
    let existing = "";
    try { existing = execFileSync("crontab", ["-l"], { encoding: "utf8" }); } catch {}
    const next = `${existing.split(/\r?\n/).filter((line) => !line.includes(`# ${definition.id}`) && line.trim()).join("\n")}\n${definition.native}\n`;
    replaceCrontab(next);
    return { location: "user crontab", rollback: async () => replaceCrontab(existing) };
  }
  if (!definition.windowsArgs) throw new Error("Windows schedule definition is missing native arguments");
  let previousXml: string | null = null;
  try { previousXml = execFileSync("schtasks.exe", ["/Query", "/TN", definition.id, "/XML"], { encoding: "utf8" }); } catch {}
  execFileSync("schtasks.exe", definition.windowsArgs, { stdio: "ignore" });
  return {
    location: `Task Scheduler:${definition.id}`,
    rollback: async () => {
      try { execFileSync("schtasks.exe", ["/Delete", "/F", "/TN", definition.id], { stdio: "ignore" }); } catch {}
      if (previousXml !== null) {
        const temporary = path.join(homedir(), `.briefwright-task-${randomUUID()}.xml`);
        try {
          await writeFile(temporary, previousXml, { encoding: "utf8", flag: "wx" });
          execFileSync("schtasks.exe", ["/Create", "/F", "/TN", definition.id, "/XML", temporary], { stdio: "ignore" });
        } finally { await rm(temporary, { force: true }); }
      }
    },
  };
}

export async function uninstallSchedule(definition: ScheduleDefinition): Promise<void> {
  if (definition.platform === "darwin") {
    const target = launchAgentPath(definition);
    try { execFileSync("launchctl", ["bootout", `gui/${process.getuid?.()}`, target], { stdio: "ignore" }); } catch {}
    try { await unlink(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return;
  }
  if (definition.platform === "linux") {
    let existing = "";
    try { existing = execFileSync("crontab", ["-l"], { encoding: "utf8" }); } catch {}
    const next = `${existing.split(/\r?\n/).filter((line) => !line.includes(`# ${definition.id}`) && line.trim()).join("\n")}\n`;
    const result = spawnSync("crontab", ["-"], { input: next, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`crontab update failed: ${result.stderr || `exit ${result.status}`}`);
    return;
  }
  try { execFileSync("schtasks.exe", ["/Delete", "/F", "/TN", definition.id], { stdio: "ignore" }); } catch {}
}
