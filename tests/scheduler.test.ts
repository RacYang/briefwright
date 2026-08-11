import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scheduleDefinition } from "../src/scheduler/definition.js";
import { initializeProject } from "../src/commands/init.js";
import { previewProject } from "../src/commands/preview.js";
import { scheduleReadiness } from "../src/commands/schedule.js";

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

  it("binds enablement to an untampered live preview of the current config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-ready-"));
    const configPath = await initializeProject({ directory: root, yes: true });
    await expect(scheduleReadiness(configPath, { preflight: async () => [] })).rejects.toThrow("preview --live");
    const sourceResponse = (url: string) => url.includes("github")
      ? new Response(JSON.stringify([]), { status: 200 })
      : new Response("<rss><channel></channel></rss>", { status: 200 });
    const preview = await previewProject(configPath, { live: true, fetch: async (url) => sourceResponse(String(url)) });
    await expect(scheduleReadiness(configPath, { preflight: async () => [{ name: "test", ok: true, detail: "ok" }] })).resolves.toMatchObject({ preview: { runId: expect.stringContaining("PREVIEW-LIVE") } });
    await writeFile(preview.outputPath, "tampered", "utf8");
    await expect(scheduleReadiness(configPath, { preflight: async () => [] })).rejects.toThrow("changed on disk");
    const original = await readFile(configPath, "utf8");
    await writeFile(configPath, original.replace("AI agents", "coding agents"), "utf8");
    await expect(scheduleReadiness(configPath, { preflight: async () => [] })).rejects.toThrow("matches the current configuration");
  }, 20_000);
});
