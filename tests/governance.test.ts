import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { runFormalProject } from "../src/core/run.js";
import { FixtureModelProvider } from "../src/providers/fixture.js";
import { addProjectFeedback, projectFeedbackSummary } from "../src/commands/feedback.js";
import { createPolicyExperiment, evaluatePolicyExperiment, transitionPolicyExperiment } from "../src/commands/experiment.js";

function response(url: string): Response {
  if (url.includes("github")) return new Response(JSON.stringify([{ id: 1, html_url: "https://github.com/QwenLM/qwen-code/releases/tag/v1", name: "AI agents runtime", tag_name: "v1", body: "AI agents runtime adds tool budgets", published_at: "2026-08-11T00:00:00Z", draft: false, prerelease: false }]), { status: 200 });
  return new Response("<rss><channel></channel></rss>", { status: 200 });
}

describe("human governance", () => {
  it("packages idempotent readback and separate phase-consumption rules", async () => {
    const skill = await readFile(path.resolve(import.meta.dirname, "../skill/briefwright/SKILL.md"), "utf8");
    const agent = await readFile(path.resolve(import.meta.dirname, "../skill/briefwright/agents/openai.yaml"), "utf8");
    expect(skill).toContain("--request-id <uuid-v4>");
    expect(skill).toContain("knowledge readback --request-id <same-uuid-v4>");
    expect(skill).toContain("After every\n   `PROPOSED` response");
    expect(skill).toContain("selection confirmation CONSUMED; commit confirmation REQUIRED");
    expect(skill).toContain("generic signal as feedback and exposes the selection-linked receipt separately");
    expect(skill).toContain("stored operation, bounded diff, expected target hash, resulting content hash, proposal digest");
    expect(skill).toContain("RECOVERY_INCOMPLETE");
    expect(agent).toMatch(/default_prompt: \"Use \$briefwright/);
    expect(agent).toContain("keep generic feedback separate from the durable selection receipt");
  });

  it("binds feedback to durable items and prevents unevidenced policy activation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-governance-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const run = await runFormalProject(configPath, { now: new Date("2026-08-11T02:00:00Z"), provider: new FixtureModelProvider(), fetch: async (url) => response(String(url)) });
    const itemId = run.result.daily[0]!.id;
    await addProjectFeedback(configPath, itemId, "used", "Changed an implementation decision");
    await expect(projectFeedbackSummary(configPath)).resolves.toMatchObject({
      total: 1,
      reviewedItems: 1,
      selectionReceipts: 0,
      effectivePositiveItems: 1,
      byType: { used: 1 },
    });

    const candidate = path.resolve(import.meta.dirname, "../policies/ai-intelligence-v1.json");
    const experiment = await createPolicyExperiment(configPath, candidate);
    await expect(evaluatePolicyExperiment(configPath, experiment.experimentId)).resolves.toMatchObject({ eligible: false, metrics: { reviewedItems: 1 } });
    await expect(transitionPolicyExperiment(configPath, experiment.experimentId, "approve")).rejects.toThrow("cannot approve");
  }, 60_000);
});
