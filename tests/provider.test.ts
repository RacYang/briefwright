import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { loadEffectiveConfig } from "../src/config/load.js";
import type { CaptureEnvelope } from "../src/connectors/types.js";
import { QwenProvider } from "../src/providers/qwen.js";

async function context() {
  const root = await mkdtemp(path.join(tmpdir(), "briefwright-provider-"));
  const configPath = await initializeProject({ directory: root, yes: true, model: "qwen" });
  await writeFile(path.join(root, ".env.local"), "DASHSCOPE_API_KEY=test-only-secret\n", { mode: 0o600 });
  const config = await loadEffectiveConfig(configPath);
  return { interests: config.interests, domains: config.policy.domains, prompt: config.prompts, provider: config.provider, projectRoot: root };
}

const capture: CaptureEnvelope = {
  sourceId: "SRC-TEST", externalKey: "1", canonicalUrl: "https://example.com/1", title: "Agent runtime adds tool budgets",
  summary: "The agent runtime adds explicit tool budgets and evidence checkpoints.", capturedAt: "2026-08-11T00:00:00Z",
  publishedAt: "2026-08-11T00:00:00Z", contentHash: "abc", evidenceClass: "primary",
};

function validAnalysis() {
  const dimension = { value: 4, reason: "Supported by the primary source." };
  return {
    title: "Agent runtime adds governed tool budgets", summary: capture.summary, whyItMatters: "This changes agent runtime governance.", domain: "Agent",
    claims: ["Agent runtime adds tool budgets"],
    claimEvidence: [{ claimIndex: 0, excerpt: "Agent runtime adds tool budgets" }],
    knowledgePotential: { reusableQuestion: true, mechanismIncrement: true, durableWithoutVersion: true, reason: "Reusable runtime boundary." },
    scores: { authority: dimension, evidence: dimension, relevance: dimension, impact: dimension, novelty: dimension, recency: dimension, actionability: dimension }, exclusions: [],
  };
}

describe("Qwen provider contract", () => {
  it("validates structured analysis and keeps the secret out of the request body", async () => {
    let body = "";
    const provider = new QwenProvider(async (_url, init) => {
      body = String(init?.body);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-only-secret");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validAnalysis()) } }] }), { status: 200 });
    });
    const result = await provider.analyze(capture, await context());
    expect(result.domain).toBe("Agent");
    expect(body).not.toContain("test-only-secret");
    expect(body).toContain("untrusted data");
  });

  it("rejects output outside the prompt schema without leaking credentials", async () => {
    const provider = new QwenProvider(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }));
    await expect(provider.analyze(capture, await context())).rejects.toThrow("output contract");
  });
});
