import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { ScheduleDefinition } from "./definition.js";

function launchAgentPath(definition: ScheduleDefinition): string {
  return path.join(homedir(), "Library", "LaunchAgents", `${definition.id}.plist`);
}

export async function installSchedule(definition: ScheduleDefinition): Promise<{ location: string }> {
  if (definition.platform === "darwin") {
    const target = launchAgentPath(definition);
    await mkdir(path.dirname(target), { recursive: true });
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error(`Refusing symlinked LaunchAgent target: ${target}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${target}.tmp-${randomUUID()}`;
    await writeFile(temporary, definition.native, { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
    try { execFileSync("launchctl", ["bootout", `gui/${process.getuid?.()}`, target], { stdio: "ignore" }); } catch {}
    execFileSync("launchctl", ["bootstrap", `gui/${process.getuid?.()}`, target], { stdio: "ignore" });
    return { location: target };
  }
  if (definition.platform === "linux") {
    let existing = "";
    try { existing = execFileSync("crontab", ["-l"], { encoding: "utf8" }); } catch {}
    const next = `${existing.split(/\r?\n/).filter((line) => !line.includes(`# ${definition.id}`) && line.trim()).join("\n")}\n${definition.native}\n`;
    const result = spawnSync("crontab", ["-"], { input: next, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`crontab install failed: ${result.stderr || `exit ${result.status}`}`);
    return { location: "user crontab" };
  }
  if (!definition.windowsArgs) throw new Error("Windows schedule definition is missing native arguments");
  execFileSync("schtasks.exe", definition.windowsArgs, { stdio: "ignore" });
  return { location: `Task Scheduler:${definition.id}` };
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
