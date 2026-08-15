import { describe, expect, it } from "vitest";

import type { CaptureEnvelope } from "../src/connectors/types.js";
import { persistVerifiedAnalysis, verifyAnalysisEvidence } from "../src/core/evidence.js";
import type { ModelAnalysis } from "../src/providers/types.js";

const capture: CaptureEnvelope = {
  sourceId: "SRC", externalKey: "1", canonicalUrl: "https://example.com/1", title: "Runtime update", summary: "Bounded retained excerpt.",
  capturedAt: "2026-08-12T00:00:00Z", contentHash: "hash", evidenceClass: "primary",
  analysisText: "The runtime now enforces a tool budget of 64 calls and records an evidence checkpoint before commit.",
};
const dimension = { value: 4, reason: "Primary source" };
function analysis(claim: string, excerpt: string): ModelAnalysis {
  return {
    title: "Agent 运行时新增证据检查", summary: "运行时新增工具预算与提交前证据检查。", whyItMatters: "提升可审计性。", domain: "Agent", claims: [claim],
    claimEvidence: [{ claimIndex: 0, excerpt }],
    knowledgePotential: { reusableQuestion: true, mechanismIncrement: true, durableWithoutVersion: true, reason: "可复用机制" },
    scores: { authority: dimension, evidence: dimension, relevance: dimension, impact: dimension, novelty: dimension, recency: dimension, actionability: dimension }, exclusions: [],
  };
}

describe("anchored multilingual evidence verification", () => {
  it("confirms a Chinese claim through an exact English source-language anchor", () => {
    const value = analysis("运行时将工具调用预算设为 64 次，并在提交前记录证据检查点。", "tool budget of 64 calls and records an evidence checkpoint before commit");
    const verification = verifyAnalysisEvidence(capture, value);
    expect(verification).toMatchObject({ confirmed: true, claimSupport: [{ supported: true, overlap: 1 }] });
    const persisted = JSON.stringify(persistVerifiedAnalysis(capture, value, verification));
    expect(persisted).not.toContain("tool budget of 64 calls");
    expect(persisted).not.toContain("claimEvidence");
  });

  it("rejects an absent anchor and a number not present in the source", () => {
    expect(verifyAnalysisEvidence(capture, analysis("预算提高到 128 次。", "a sentence absent from the source")).confirmed).toBe(false);
  });
});
