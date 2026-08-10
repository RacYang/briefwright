import type { EffectiveConfig } from "../config/types.js";
import { configDigest } from "../config/load.js";
import type { BriefingItem, Receipt, RunResult } from "./types.js";

const fixtureItems: BriefingItem[] = [
  {
    id: "DEMO-ITEM-001",
    sourceId: "DEMO-AGENT-RUNTIME",
    title: "Example agent runtime publishes an explicit tool-budget contract",
    summary:
      "This bundled example shows how Briefwright separates a concrete source change from a reusable engineering implication.",
    whyItMatters:
      "Explicit budgets make agent cost, concurrency, and failure behavior reviewable instead of leaving them as hidden runtime behavior.",
    url: "https://example.com/briefwright/demo-agent-runtime",
    evidence: "primary",
    score: 91,
  },
  {
    id: "DEMO-ITEM-002",
    sourceId: "DEMO-MODEL-LAB",
    title: "Example model lab documents a new evaluation boundary",
    summary:
      "This fixture demonstrates a source-linked item with a bounded claim and an explicit evidence classification.",
    whyItMatters:
      "Evaluation claims are useful only when workload, comparison, and limitations remain attached to the conclusion.",
    url: "https://example.com/briefwright/demo-model-evaluation",
    evidence: "primary",
    score: 82,
  },
];

export function createFixtureRun(config: EffectiveConfig, now = new Date()): RunResult {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const receipts: Receipt[] = config.preset.sources.map((source) => ({
    sourceId: source.id,
    result: fixtureItems.some((item) => item.sourceId === source.id) ? "updated" : "unchanged",
  }));

  return {
    runId: `DEMO-${date}`,
    generatedAt: now.toISOString(),
    mode: "fixture",
    configDigest: configDigest(config),
    receipts,
    daily: fixtureItems.filter((item) => item.score >= 70),
    review: fixtureItems.filter((item) => item.score >= 60 && item.score < 70),
  };
}

