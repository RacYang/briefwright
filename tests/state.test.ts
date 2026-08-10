import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEffectiveConfig, loadPreset } from "../src/config/load.js";
import type { BriefingIntent } from "../src/config/types.js";
import { createFixtureRun } from "../src/core/fixture.js";
import { SqliteStateStore } from "../src/state/sqlite.js";

describe("SQLite state", () => {
  it("allows idempotent saves but rejects the same run ID with a different config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-state-"));
    const preset = await loadPreset("ai-daily");
    const baseIntent: BriefingIntent = {
      version: 1,
      name: "Test",
      preset: "ai-daily",
      interests: ["AI agents"],
      schedule: "manual",
      output: "markdown",
      outputDirectory: "briefs",
    };
    const firstConfig = buildEffectiveConfig(root, baseIntent, preset);
    const firstRun = createFixtureRun(firstConfig, new Date("2026-08-10T00:00:00Z"));
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"));

    try {
      expect(() => store.saveRun(firstConfig, firstRun)).not.toThrow();
      expect(() => store.saveRun(firstConfig, firstRun)).not.toThrow();

      const changedConfig = buildEffectiveConfig(
        root,
        { ...baseIntent, interests: ["AI safety"] },
        preset,
      );
      const changedRun = createFixtureRun(changedConfig, new Date("2026-08-10T01:00:00Z"));
      expect(changedRun.runId).toBe(firstRun.runId);
      expect(() => store.saveRun(changedConfig, changedRun)).toThrow("different configuration digest");
    } finally {
      store.close();
    }
  });
});

