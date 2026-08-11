import { createHash } from "node:crypto";
import path from "node:path";

import type { BriefingIntent } from "../config/types.js";

export type SchedulerPlatform = "darwin" | "linux" | "win32";

export interface ScheduleDefinition {
  id: string;
  platform: SchedulerPlatform;
  expression: string;
  command: string;
  args: string[];
  native: string;
  windowsArgs?: string[];
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function cronExpression(schedule: BriefingIntent["schedule"]): string {
  if (schedule === "daily-at-10") return "0 10 * * *";
  if (schedule === "weekdays-at-09") return "0 9 * * 1-5";
  throw new Error("Schedule is manual. Set schedule to daily-at-10 or weekdays-at-09 before enabling.");
}

export function scheduleDefinition(options: {
  schedule: BriefingIntent["schedule"];
  platform: SchedulerPlatform;
  projectRoot: string;
  configPath: string;
  executable: string;
  cliPath: string;
}): ScheduleDefinition {
  const expression = cronExpression(options.schedule);
  const hash = createHash("sha256").update(options.projectRoot).digest("hex").slice(0, 12);
  const id = `dev.briefwright.${hash}`;
  const args = [options.cliPath, "run", "--config", options.configPath];
  const quoted = [options.executable, ...args].map((value) => `'${value.replace(/'/g, `'\\''`)}'`).join(" ");
  if (options.platform === "linux") {
    return { id, platform: options.platform, expression, command: options.executable, args, native: `${expression} cd '${options.projectRoot.replace(/'/g, `'\\''`)}' && ${quoted} # ${id}` };
  }
  if (options.platform === "win32") {
    const [minute, hour, , , weekdays] = expression.split(" ");
    const schedule = weekdays === "1-5" ? "WEEKLY /D MON,TUE,WED,THU,FRI" : "DAILY";
    const scheduleArgs = weekdays === "1-5" ? ["/SC", "WEEKLY", "/D", "MON,TUE,WED,THU,FRI"] : ["/SC", "DAILY"];
    const taskCommand = [options.executable, ...args].map((value) => `"${value.replace(/"/g, '\\"')}"`).join(" ");
    const windowsArgs = ["/Create", "/F", "/TN", id, ...scheduleArgs, "/ST", `${hour!.padStart(2, "0")}:${minute!.padStart(2, "0")}`, "/TR", taskCommand];
    return { id, platform: options.platform, expression, command: options.executable, args, native: windowsArgs.join(" "), windowsArgs };
  }
  const [minute, hour, , , weekdays] = expression.split(" ");
  const calendar = weekdays === "1-5"
    ? [1, 2, 3, 4, 5].map((weekday) => `<dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer><key>Weekday</key><integer>${weekday + 1}</integer></dict>`).join("")
    : `<dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`;
  const native = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${id}</string><key>ProgramArguments</key><array>${[options.executable, ...args].map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>WorkingDirectory</key><string>${xml(options.projectRoot)}</string><key>StartCalendarInterval</key>${weekdays === "1-5" ? `<array>${calendar}</array>` : calendar}<key>StandardOutPath</key><string>${xml(path.join(options.projectRoot, ".briefwright/schedule.log"))}</string><key>StandardErrorPath</key><string>${xml(path.join(options.projectRoot, ".briefwright/schedule-error.log"))}</string></dict></plist>\n`;
  return { id, platform: options.platform, expression, command: options.executable, args, native };
}
