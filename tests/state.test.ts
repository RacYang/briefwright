import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEffectiveConfig, loadPackagedRuntime } from "../src/config/load.js";
import type { BriefingIntent } from "../src/config/types.js";
import { createFixtureRun } from "../src/core/fixture.js";
import { SqliteStateStore } from "../src/state/sqlite.js";

describe("SQLite state", () => {
  it("keeps finalized runs immutable and rejects reuse with a different config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-state-"));
    const baseIntent: BriefingIntent = {
      version: 2,
      name: "Test",
      preset: "ai-daily",
      interests: ["AI agents"],
      schedule: "manual",
      output: "markdown",
      outputDirectory: "briefs",
      ai: "qwen",
    };
    const resources = await loadPackagedRuntime(baseIntent);
    const firstConfig = buildEffectiveConfig(root, baseIntent, resources.preset, resources.policy, resources.prompts, resources.provider);
    const firstRun = createFixtureRun(firstConfig, new Date("2026-08-10T00:00:00Z"));
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root);

    try {
      expect(() => store.saveRun(firstConfig, firstRun)).not.toThrow();
      expect(() => store.saveRun(firstConfig, firstRun)).toThrow("already finalized");

      const changedConfig = buildEffectiveConfig(
        root,
        { ...baseIntent, interests: ["AI safety"] },
        resources.preset,
        resources.policy,
        resources.prompts,
        resources.provider,
      );
      const changedRun = createFixtureRun(changedConfig, new Date("2026-08-10T01:00:00Z"));
      expect(changedRun.runId).not.toBe(firstRun.runId);
      expect(() =>
        store.saveRun(changedConfig, { ...changedRun, runId: firstRun.runId }),
      ).toThrow("different configuration digest");
    } finally {
      store.close();
    }
  });

  it("never persists the transient full-text analysis payload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-transient-"));
    const intent: BriefingIntent = { version: 2, name: "Retention", preset: "ai-daily", interests: ["AI"], schedule: "manual", output: "markdown", outputDirectory: "briefs", ai: "qwen" };
    const resources = await loadPackagedRuntime(intent); const config = buildEffectiveConfig(root, intent, resources.preset, resources.policy, resources.prompts, resources.provider);
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root); const runId = "RUN-20260811-DAILY"; const now = "2026-08-11T00:00:00Z";
    try {
      store.beginFormalRun(config, runId, now, { rules: config.policy.rules });
      store.recordSourceResult(runId, { sourceId: "SRC", result: "updated" }, [{ sourceId: "SRC", externalKey: "1", canonicalUrl: "https://example.com/1", title: "Title", summary: "bounded excerpt", capturedAt: now, contentHash: "hash", evidenceClass: "primary", analysisText: "FULL TEXT MUST REMAIN TRANSIENT" }], {}, now);
      const row = store.database.prepare("SELECT raw_json FROM captures").get() as { raw_json: string };
      expect(row.raw_json).not.toContain("FULL TEXT MUST REMAIN TRANSIENT");
      expect(row.raw_json).not.toContain("analysisText");
    } finally { store.close(); }
  });
});
