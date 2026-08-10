import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEffectiveConfig, loadPreset } from "../src/config/load.js";
import type { BriefingIntent } from "../src/config/types.js";
import { countReceipts, runOutcome } from "../src/core/accounting.js";
import { createLiveRun } from "../src/core/live.js";

async function config() {
  const root = await mkdtemp(path.join(tmpdir(), "briefwright-live-"));
  const intent: BriefingIntent = {
    version: 1,
    name: "Live test",
    preset: "ai-daily",
    interests: ["AI agents"],
    schedule: "manual",
    output: "markdown",
    outputDirectory: "briefs",
  };
  return buildEffectiveConfig(root, intent, await loadPreset("ai-daily"));
}

describe("live preview outcomes", () => {
  it("marks successful snapshots as observed, not changed", async () => {
    const effective = await config();
    const result = await createLiveRun(
      effective,
      new Date("2026-08-10T10:00:00Z"),
      async (url) => String(url).includes("api.github.com")
        ? new Response("[]", { status: 200 })
        : new Response("<rss><channel></channel></rss>", { status: 200 }),
    );
    expect(result.receipts.every((receipt) => receipt.result === "observed")).toBe(true);
  });

  it("classifies a total source outage as failed with bounded details", async () => {
    const effective = await config();
    const result = await createLiveRun(
      effective,
      new Date("2026-08-10T10:00:00Z"),
      async () => { throw new Error("offline"); },
    );
    const counts = countReceipts(effective.preset.sources.map((source) => source.id), result.receipts);
    expect(runOutcome(counts)).toBe("failed");
    expect(result.receipts).toHaveLength(effective.preset.sources.length);
    expect(result.receipts.every((receipt) => receipt.detail === "offline")).toBe(true);
  });
});
