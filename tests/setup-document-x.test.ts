import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { normalizeLarkBaseReference, setupProject } from "../src/commands/setup.js";
import { initializeProject } from "../src/commands/init.js";
import { loadEffectiveConfig, STANDARD_LARK_TABLES } from "../src/config/load.js";
import { runFormalProject } from "../src/core/run.js";
import { FixtureModelProvider } from "../src/providers/fixture.js";
import { XApiConnector } from "../src/connectors/x-api.js";
import type { SourceDefinition } from "../src/config/types.js";

function sourceResponse(url: string): Response {
  if (url.includes("github")) return new Response(JSON.stringify([{ id: 1, html_url: "https://github.com/QwenLM/qwen-code/releases/tag/v1", name: "Runtime", tag_name: "v1", body: "Evidence checkpoint", published_at: "2026-08-11T00:00:00Z", draft: false, prerelease: false }]), { status: 200 });
  return new Response("<rss><channel></channel></rss>", { status: 200 });
}

describe("guided setup, documents, and X", () => {
  it("accepts a direct official Base link and rejects lookalike or Wiki links", () => {
    expect(normalizeLarkBaseReference("https://team.feishu.cn/base/bascnExample123?table=tbl1")).toBe("bascnExample123");
    expect(normalizeLarkBaseReference("https://example.larksuite.com/base/AppToken_123")).toBe("AppToken_123");
    expect(normalizeLarkBaseReference("bascnDirect123")).toBe("bascnDirect123");
    expect(() => normalizeLarkBaseReference("https://feishu.cn.evil.example/base/bascnExample123")).toThrow("official");
    expect(() => normalizeLarkBaseReference("http://team.feishu.cn/base/bascnExample123")).toThrow("HTTPS");
    expect(() => normalizeLarkBaseReference("https://team.feishu.cn/wiki/wikcnExample123")).toThrow("Wiki link");
  });

  it("writes an ordinary vendor-neutral setup without enabling anything", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-setup-"));
    const result = await setupProject({ directory: root, yes: true, name: "Signals", interests: ["agents"], model: "anthropic", processStore: "sqlite", documentStore: "local", schedule: "manual" });
    const intent = parse(await readFile(result.configPath, "utf8"));
    expect(intent).toMatchObject({ version: 3, model: "anthropic", processStore: "sqlite", documentStore: "local", schedule: "manual" });
    expect(result.next.join("\n")).not.toContain("schedule enable");
    expect(result.next.join("\n")).toContain("preview --live");
  });

  it("uses portable standard Lark table names instead of another user's table IDs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-lark-config-"));
    const configPath = await initializeProject({ directory: root, yes: true, processStore: { driver: "lark", baseToken: "base-test" } });
    const config = await loadEffectiveConfig(configPath);
    expect(config.controlPlane.lark?.tables).toEqual(STANDARD_LARK_TABLES);
    expect(Object.values(config.controlPlane.lark!.tables).every((value) => !value.startsWith("tbl"))).toBe(true);
  });

  it("publishes production paths and managed indexes inside an external Obsidian vault", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-project-")); const vault = await mkdtemp(path.join(tmpdir(), "briefwright-vault-"));
    const configPath = await initializeProject({ directory: root, yes: true, model: "ollama", documentStore: { driver: "obsidian", root: vault, briefingDirectory: "Inbox/AI Intelligence" } });
    const run = await runFormalProject(configPath, { now: new Date("2026-08-11T02:00:00Z"), provider: new FixtureModelProvider(), fetch: async (url) => sourceResponse(String(url)) });
    expect(run.dailyPath.startsWith(vault)).toBe(true); expect(path.basename(run.dailyPath)).toBe("2026-08-11-AI情报简报.md");
    expect(await readFile(path.join(vault, "Inbox/AI Intelligence/Note-AI情报候选池.md"), "utf8")).toContain("ai-intelligence-digest:start");
  }, 40_000);

  it("captures an incremental official X timeline with a local secret reference", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-x-")); process.env.X_BEARER_TOKEN = "x-test";
    const source: SourceDefinition = { id: "SRC-X-TEST", title: "X test", sourceType: "x", evidenceTier: "primary", connector: { type: "x-api", config: { username: "OpenAI", bearerToken: { provider: "env", key: "X_BEARER_TOKEN" } } } };
    const requests: string[] = []; let cursor: Record<string, unknown> = {};
    const captures = await new XApiConnector().capture(source as never, { projectRoot: root, now: () => new Date("2026-08-11T02:00:00Z"), setCursor: (value) => { cursor = value; }, fetch: async (url, init) => {
      requests.push(url); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer x-test");
      return url.includes("by/username") ? new Response(JSON.stringify({ data: { id: "123" } }), { status: 200 })
        : new Response(JSON.stringify({ data: [{ id: "999", text: "Official release evidence", created_at: "2026-08-11T01:00:00Z" }] }), { status: 200 });
    } });
    expect(captures).toMatchObject([{ canonicalUrl: "https://x.com/OpenAI/status/999", evidenceClass: "secondary" }]); expect(cursor).toEqual({ sinceId: "999" }); expect(requests).toHaveLength(2);
  });
});
