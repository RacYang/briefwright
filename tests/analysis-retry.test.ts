import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { loadEffectiveConfig } from "../src/config/load.js";
import { runFormalProject } from "../src/core/run.js";
import { FixtureModelProvider } from "../src/providers/fixture.js";
import { SqliteStateStore } from "../src/state/sqlite.js";

function sourceResponse(url: string, body: string): Response {
  if (url.includes("api.github.com")) {
    return new Response(JSON.stringify([{
      id: 10,
      html_url: "https://github.com/example/agent/releases/tag/v1",
      name: "AI agents runtime",
      tag_name: "v1",
      body,
      published_at: "2026-08-11T00:00:00Z",
      draft: false,
      prerelease: false,
    }]), { status: 200, headers: { etag: '"release"' } });
  }
  return new Response("<rss><channel></channel></rss>", { status: 200, headers: { etag: '"rss"' } });
}

describe("durable model retry and versioned identity", () => {
  it("retries failed analyses on a later unchanged scan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-retry-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const first = await runFormalProject(configPath, {
      now: new Date("2026-08-11T02:00:00Z"),
      provider: { id: "fail", version: "1.0.0", async check() { return { ok: false, detail: "fixture" }; }, async analyze() { throw new Error("temporary model failure"); } },
      fetch: async (url) => sourceResponse(String(url), "AI agents add an evidence checkpoint."),
    });
    expect(first.outcome).toBe("partial");
    expect(first.result.daily).toHaveLength(0);

    let analyses = 0;
    const fixture = new FixtureModelProvider();
    const second = await runFormalProject(configPath, {
      now: new Date("2026-08-12T02:00:00Z"),
      provider: { id: fixture.id, version: fixture.version, check: () => fixture.check(), analyze: async (...args) => { analyses += 1; return fixture.analyze(...args); } },
      fetch: async (url) => sourceResponse(String(url), "AI agents add an evidence checkpoint."),
    });
    expect(analyses).toBeGreaterThan(0);
    expect(second.result.daily).toHaveLength(1);
    expect(second.result.modelFailures).toHaveLength(0);
    const config = await loadEffectiveConfig(configPath);
    const store = new SqliteStateStore(config.storage.path, config.projectRoot);
    try {
      expect((store.database.prepare("SELECT COUNT(*) count FROM duplicate_clusters").get() as { count: number }).count).toBeGreaterThan(0);
      expect((store.database.prepare("SELECT COUNT(*) count FROM analysis_attempts WHERE status='duplicate'").get() as { count: number }).count).toBeGreaterThan(0);
    } finally { store.close(); }
  }, 20_000);

  it("keeps historical items and feedback when the same external event changes content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-versioned-item-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const first = await runFormalProject(configPath, {
      now: new Date("2026-08-15T02:00:00Z"), provider: new FixtureModelProvider(),
      fetch: async (url) => sourceResponse(String(url), "AI agents add evidence checkpoint version one."),
    });
    const firstId = first.result.daily[0]!.id;
    const config = await loadEffectiveConfig(configPath);
    let store = new SqliteStateStore(config.storage.path, config.projectRoot);
    store.addFeedback(firstId, "used", "kept for history", "2026-08-15T03:00:00Z");
    store.close();

    const second = await runFormalProject(configPath, {
      now: new Date("2026-08-16T02:00:00Z"), provider: new FixtureModelProvider(),
      fetch: async (url) => sourceResponse(String(url), "AI agents add evidence checkpoint version two with tool budgets."),
    });
    const secondId = second.result.daily[0]!.id;
    expect(secondId).not.toBe(firstId);
    store = new SqliteStateStore(config.storage.path, config.projectRoot);
    try {
      expect((store.database.prepare("SELECT COUNT(*) count FROM items WHERE item_id IN (?,?)").get(firstId, secondId) as { count: number }).count).toBe(2);
      expect((store.database.prepare("SELECT COUNT(*) count FROM feedback WHERE item_id=?").get(firstId) as { count: number }).count).toBe(1);
    } finally { store.close(); }
  }, 20_000);
});
