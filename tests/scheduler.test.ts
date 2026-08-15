import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scheduleDefinition } from "../src/scheduler/definition.js";
import { initializeProject } from "../src/commands/init.js";
import { previewProject } from "../src/commands/preview.js";
import { scheduleReadiness } from "../src/commands/schedule.js";
import { CODEX_AUTOMATION_PROMPT_LIMIT, codexAutomationDefinition } from "../src/scheduler/codex.js";
import { loadEffectiveConfig } from "../src/config/load.js";
import { FixtureModelProvider } from "../src/providers/fixture.js";

const base = { schedule: "weekdays-at-09" as const, projectRoot: "/tmp/brief project", configPath: "/tmp/brief project/briefing.yaml", executable: "/usr/bin/node", cliPath: "/opt/briefwright/cli.js" };

describe("scheduler definitions", () => {
  it("exports a digest-bound Codex task with conditional browser capture", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "briefwright-codex-schedule-"));
    const configPath = await initializeProject({
      directory: project,
      yes: true,
      schedule: "daily-at-10",
      model: "codex",
      processStore: { driver: "lark", baseToken: "base-test", xCapture: "codex-browser" },
    });
    const config = await loadEffectiveConfig(configPath);
    const definition = await codexAutomationDefinition(config, configPath);
    expect(definition).toMatchObject({
      status: "ACTIVE",
      rrule: "FREQ=DAILY;BYHOUR=10;BYMINUTE=0;BYSECOND=0",
      configDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      cliDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      contractDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      configFileDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtimeDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      runtime: { immutable: false, warning: expect.stringContaining("versioned runtime directory") },
    });
    expect(definition.prompt).toContain(`cli: ${definition.cliPath}`);
    expect(definition.prompt).toContain(`execution_config_digest: ${definition.configDigest}`);
    expect(definition.prompt).toContain("config render");
    expect(definition.prompt).toContain(`runtime_digest: ${definition.runtimeDigest}`);
    expect(definition.prompt).toContain("capabilities");
    expect(definition.prompt).toContain("manifest 有来源");
    expect(definition.prompt).toContain("captureMode=computer-use");
    expect(definition.prompt).toContain("captureMode=in-app-browser");
    expect(definition.prompt).toContain("不能接管 Chrome");
    expect(definition.prompt).toContain("dateKind=event");
    expect(definition.prompt).toContain("page-updated");
    expect(definition.prompt).toContain("allowedHosts");
    expect(definition.prompt).toContain("禁止登录、输入、下载、互动");
    expect(definition.prompt).toContain("零来源不建 bundle");
    expect(definition.prompt.length).toBeLessThanOrEqual(CODEX_AUTOMATION_PROMPT_LIMIT);
    expect(definition.prompt).not.toContain("briefwright --json run");
  });

  it("stays within the Codex prompt limit with production-length paths and a source contract", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "bw-prod-"));
    const project = path.join(temporary, "ai-agent-production-runtime-root");
    await mkdir(project, { recursive: true });
    const documentRoot = "/Users/example/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes";
    const contractPath = path.join(documentRoot, "Inbox", "AI Intelligence", "Tools", "ai-intelligence-contract.json");
    const configPath = await initializeProject({ directory: project, yes: true, schedule: "daily-at-10" });
    const contractDigest = createHash("sha256").update("{}\n").digest("hex");
    const loaded = await loadEffectiveConfig(configPath);
    const config = {
      ...loaded,
      projectRoot: "/Users/example/.local/share/briefwright/ai-agent",
      documents: { ...loaded.documents, root: documentRoot },
      sourceContract: { path: contractPath, sha256: contractDigest },
    };
    const definition = await codexAutomationDefinition(config, configPath);
    expect(definition.prompt).toContain(`source_contract: ${contractPath}`);
    expect(definition.prompt.length).toBeLessThanOrEqual(CODEX_AUTOMATION_PROMPT_LIMIT);
  });

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

  it("binds enablement to an untampered real-model editorial shadow of the current config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-ready-"));
    const configPath = await initializeProject({ directory: root, yes: true });
    await expect(scheduleReadiness(configPath, { preflight: async () => [] })).rejects.toThrow("preview --live");
    const published = new Date().toUTCString();
    const sourceResponse = (url: string) => url.includes("github")
      ? new Response(JSON.stringify([]), { status: 200 })
      : new Response(`<rss><channel><item><title>AI agents gain governed tool state</title><link>${url}</link><pubDate>${published}</pubDate><description>AI agents gain governed tool state for reliable workflows.</description></item></channel></rss>`, { status: 200 });
    await previewProject(configPath, { live: true, fetch: async (url) => sourceResponse(String(url)) });
    await expect(scheduleReadiness(configPath, { preflight: async () => [] })).rejects.toThrow("editorial shadow");
    const preview = await previewProject(configPath, { live: true, editorial: true, provider: new FixtureModelProvider(), fetch: async (url) => sourceResponse(String(url)) });
    await expect(scheduleReadiness(configPath, { preflight: async () => [{ name: "test", ok: true, detail: "ok" }] })).resolves.toMatchObject({ preview: { runId: expect.stringContaining("PREVIEW-EDITORIAL") } });
    await writeFile(preview.outputPath, "tampered", "utf8");
    await expect(scheduleReadiness(configPath, { preflight: async () => [] })).rejects.toThrow("changed on disk");
    const original = await readFile(configPath, "utf8");
    await writeFile(configPath, original.replace("AI agents", "coding agents"), "utf8");
    await expect(scheduleReadiness(configPath, { preflight: async () => [] })).rejects.toThrow("matches the current configuration");
  }, 40_000);
});
