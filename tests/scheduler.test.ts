import { describe, expect, it } from "vitest";

import { scheduleDefinition } from "../src/scheduler/definition.js";

const base = { schedule: "weekdays-at-09" as const, projectRoot: "/tmp/brief project", configPath: "/tmp/brief project/briefing.yaml", executable: "/usr/bin/node", cliPath: "/opt/briefwright/cli.js" };

describe("scheduler definitions", () => {
  it("renders platform-native definitions without installing them", () => {
    const mac = scheduleDefinition({ ...base, platform: "darwin" });
    const linux = scheduleDefinition({ ...base, platform: "linux" });
    const windows = scheduleDefinition({ ...base, platform: "win32" });
    expect(mac.native).toContain("StartCalendarInterval");
    expect(mac.native).toContain("<key>Weekday</key>");
    expect(linux.native).toMatch(/^0 9 \* \* 1-5 /);
    expect(linux.native).toContain("# dev.briefwright.");
    expect(windows.native).toContain("WEEKLY /D MON,TUE,WED,THU,FRI");
    expect(windows.windowsArgs?.at(-1)).toContain('"/tmp/brief project/briefing.yaml"');
  });

  it("rejects a no-op manual schedule", () => {
    expect(() => scheduleDefinition({ ...base, schedule: "manual", platform: "linux" })).toThrow("Schedule is manual");
  });
});
