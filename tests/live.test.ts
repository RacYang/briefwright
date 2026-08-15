import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEffectiveConfig, loadPackagedRuntime } from "../src/config/load.js";
import type { BriefingIntent } from "../src/config/types.js";
import { countReceipts, runOutcome } from "../src/core/accounting.js";
import { createLiveRun } from "../src/core/live.js";
import { renderMarkdown } from "../src/outputs/markdown.js";
import { SqliteStateStore } from "../src/state/sqlite.js";
import type { ValidatedExternalCapture } from "../src/connectors/external-bundle.js";
import { FixtureModelProvider } from "../src/providers/fixture.js";
import type { ModelProvider } from "../src/providers/types.js";

async function config() {
  const root = await mkdtemp(path.join(tmpdir(), "briefwright-live-"));
  const intent: BriefingIntent = {
    version: 2,
    name: "Live test",
    preset: "ai-daily",
    interests: ["AI agents"],
    schedule: "manual",
    output: "markdown",
    outputDirectory: "briefs",
    ai: "qwen",
  };
  const resources = await loadPackagedRuntime(intent);
  return buildEffectiveConfig(root, intent, resources.preset, resources.policy, resources.prompts, resources.provider);
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
    const markdown = renderMarkdown(effective, result);
    expect(markdown).toContain("Source-connectivity preview only");
    expect(markdown.indexOf("## Briefing candidates")).toBeLessThan(markdown.indexOf("## Run quality"));
    expect(markdown).toContain(`<details><summary>Source failures (${effective.preset.sources.length})</summary>`);
  });

  it("records a zero-due live preview as successful against its frozen due set", async () => {
    const effective = await config(); const result = await createLiveRun(effective, new Date("2026-08-10T10:00:00Z"), async () => { throw new Error("must not fetch"); }, []);
    const state = new SqliteStateStore(effective.storage.path, effective.projectRoot);
    try { state.saveRun(effective, result); expect(state.latestRun()?.status).toBe("success"); } finally { state.close(); }
    const markdown = renderMarkdown(effective, result);
    expect(markdown).toContain("Due sources: 0");
    expect(markdown).toContain("Missing: 0");
  });

  it("uses validated external captures for browser sources during live preview", async () => {
    const effective = await config();
    const source = { id: "SRC-X-TEST", title: "X test", connector: { type: "codex-browser" as const, config: { username: "OpenAI" } } };
    const captures = new Map<string, ValidatedExternalCapture>([[source.id, { sourceId: source.id, status: "captured", captures: [{
      sourceId: source.id, externalKey: "123", canonicalUrl: "https://x.com/OpenAI/status/123", title: "Agent update", summary: "AI agents update",
      capturedAt: "2026-08-10T09:00:00Z", publishedAt: "2026-08-10T09:00:00Z", contentHash: "abc", evidenceClass: "secondary",
    }] }]]);
    const result = await createLiveRun(effective, new Date("2026-08-10T10:00:00Z"), async () => { throw new Error("browser source must not use HTTP fetch"); }, [source], captures);

    expect(result.receipts).toEqual([{ sourceId: source.id, result: "observed", detail: "1 captured; 1 within the 48-hour coverage window; change detection is not enabled in preview" }]);
    expect(result.daily).toHaveLength(1);
    const markdown = renderMarkdown(effective, result);
    expect(markdown.indexOf("### Agent update")).toBeLessThan(markdown.indexOf("## Run quality"));
  });

  it("uses the configured model and formal evidence gates for an editorial shadow", async () => {
    const effective = await config();
    const source = { id: "SRC-EDITORIAL", title: "Editorial test", priority: 100, connector: { type: "codex-browser" as const, config: { username: "OpenAI" } } };
    const captures = new Map<string, ValidatedExternalCapture>([[source.id, { sourceId: source.id, status: "captured", captures: [{
      sourceId: source.id, externalKey: "editorial-1", canonicalUrl: "https://example.com/agent-release", title: "AI agents gain durable tool state",
      summary: "AI agents can now preserve durable tool state across governed runs.", analysisText: "AI agents gain durable tool state across governed runs.",
      capturedAt: "2026-08-10T09:00:00Z", publishedAt: "2026-08-10T09:00:00Z", contentHash: "editorial-hash", evidenceClass: "primary",
    }] }]]);
    const result = await createLiveRun(effective, new Date("2026-08-10T10:00:00Z"), async () => { throw new Error("unused"); }, [source], captures, {
      editorial: true,
      provider: new FixtureModelProvider(),
    });

    expect(result).toMatchObject({ previewKind: "editorial", outcome: "success", publicationState: "withheld" });
    expect(result.previewAnalysis).toMatchObject({ analyzed: 1, succeeded: 1, failed: 0 });
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0]!.whyItMatters).toBe("The source directly overlaps the configured interests.");
    const markdown = renderMarkdown(effective, result);
    expect(markdown).toContain("configured real model");
    expect(markdown).toContain("- Source date: 2026-08-10");
    expect(markdown).not.toContain("- Event date:");
  });

  it("fails an editorial shadow when model analysis leaves no usable item", async () => {
    const effective = await config();
    const source = { id: "SRC-EDITORIAL-FAIL", title: "Editorial failure", connector: { type: "codex-browser" as const, config: { username: "OpenAI" } } };
    const captures = new Map<string, ValidatedExternalCapture>([[source.id, { sourceId: source.id, status: "captured", captures: [{
      sourceId: source.id, externalKey: "editorial-fail", canonicalUrl: "https://example.com/agent-failure", title: "AI agents update",
      summary: "AI agents update", capturedAt: "2026-08-10T09:00:00Z", publishedAt: "2026-08-10T09:00:00Z", contentHash: "failure-hash", evidenceClass: "primary",
    }] }]]);
    const failingProvider: ModelProvider = {
      id: "failing", version: "1", check: async () => ({ ok: false, detail: "offline" }),
      analyze: async () => { throw new Error("model unavailable"); },
    };
    const result = await createLiveRun(effective, new Date("2026-08-10T10:00:00Z"), async () => { throw new Error("unused"); }, [source], captures, {
      editorial: true,
      provider: failingProvider,
    });

    expect(result.outcome).toBe("failed");
    expect(result.daily).toHaveLength(0);
    expect(result.modelFailures).toEqual([expect.objectContaining({ sourceId: source.id, detail: "model unavailable" })]);
  });
});
