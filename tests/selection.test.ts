import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { loadEffectiveConfig } from "../src/config/load.js";
import type { EffectiveConfig } from "../src/config/types.js";
import type { CaptureEnvelope } from "../src/connectors/types.js";
import { buildCandidate, selectCandidates } from "../src/core/selection.js";
import type { ModelAnalysis } from "../src/providers/types.js";

let config: EffectiveConfig;
beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "briefwright-selection-"));
  config = await loadEffectiveConfig(await initializeProject({ directory: root, yes: true }));
});

function capture(index: number): CaptureEnvelope {
  return { sourceId: "SRC", externalKey: String(index), canonicalUrl: `https://example.com/${index}`, title: `Agent mechanism ${index}`, summary: `Agent mechanism ${index} adds evidence checkpoint`, capturedAt: "2026-08-11T00:00:00Z", contentHash: String(index), evidenceClass: "primary" };
}

function analysis(value: number, knowledge = true): ModelAnalysis {
  const dimension = { value, reason: "Bounded fixture reason" };
  return { summary: "Agent mechanism adds evidence checkpoint", whyItMatters: "Affects an agent decision", domain: "agents", claims: ["Agent mechanism"], knowledgePotential: { reusableQuestion: knowledge, mechanismIncrement: knowledge, durableWithoutVersion: knowledge, reason: "Reusable mechanism" }, scores: { authority: dimension, evidence: dimension, relevance: dimension, impact: dimension, novelty: dimension, recency: dimension, actionability: dimension }, exclusions: [] };
}

describe("deterministic selection policy", () => {
  it("enforces Daily and Review thresholds plus the knowledge gate", () => {
    expect(buildCandidate(config, capture(1), analysis(3.5))).toMatchObject({ score: 70, disposition: "daily" });
    expect(buildCandidate(config, capture(2), analysis(3))).toMatchObject({ score: 60, disposition: "review" });
    expect(buildCandidate(config, capture(3), analysis(3, false))).toMatchObject({ score: 60, disposition: "machine-only" });
    expect(buildCandidate(config, capture(4), analysis(2.9))).toMatchObject({ score: 58, disposition: "machine-only" });
  });

  it("applies the per-domain cap without padding or silently dropping audit state", () => {
    const candidates = [1, 2, 3, 4].map((index) => buildCandidate(config, capture(index), analysis(4)));
    const selected = selectCandidates(config, candidates);
    expect(selected.daily).toHaveLength(3);
    expect(selected.machineOnly).toHaveLength(1);
    expect(selected.machineOnly[0]?.exclusionReasons).toContain("selection-cap");
  });

  it("excludes unsupported claims even when the model gives a high score", () => {
    const unsupported = analysis(5);
    unsupported.claims = ["Version 99 removes all safety checks"];
    expect(buildCandidate(config, capture(5), unsupported)).toMatchObject({ disposition: "machine-only", evidenceStatus: "unverified" });
  });
});
