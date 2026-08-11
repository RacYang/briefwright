import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { commitKnowledge, proposeKnowledge } from "../src/commands/knowledge.js";
import { runFormalProject } from "../src/core/run.js";
import { FixtureModelProvider } from "../src/providers/fixture.js";
import { addProjectFeedback, projectFeedbackSummary } from "../src/commands/feedback.js";
import { createPolicyExperiment, evaluatePolicyExperiment, transitionPolicyExperiment } from "../src/commands/experiment.js";

function response(url: string): Response {
  if (url.includes("github")) return new Response(JSON.stringify([{ id: 1, html_url: "https://github.com/QwenLM/qwen-code/releases/tag/v1", name: "AI agents runtime", tag_name: "v1", body: "AI agents runtime adds tool budgets", published_at: "2026-08-11T00:00:00Z", draft: false, prerelease: false }]), { status: 200 });
  return new Response("<rss><channel></channel></rss>", { status: 200 });
}

describe("human governance", () => {
  it("binds feedback and knowledge commits to durable items and rejects stale targets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-governance-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const run = await runFormalProject(configPath, { now: new Date("2026-08-11T02:00:00Z"), provider: new FixtureModelProvider(), fetch: async (url) => response(String(url)) });
    const itemId = run.result.daily[0]!.id;
    await addProjectFeedback(configPath, itemId, "used", "Changed an implementation decision");
    await expect(projectFeedbackSummary(configPath)).resolves.toMatchObject({ total: 1, reviewedItems: 1, byType: { used: 1 } });

    const target = "knowledge/agents.md";
    await expect(proposeKnowledge(configPath, itemId, "briefing.yaml")).rejects.toThrow("Markdown files");
    await expect(proposeKnowledge(configPath, itemId, ".briefwright/notes.md")).rejects.toThrow("internal state");
    const proposal = await proposeKnowledge(configPath, itemId, target);
    expect(await readFile(proposal.previewPath, "utf8")).toContain("### Failure paths");
    const committed = await commitKnowledge(configPath, proposal.proposalId);
    expect(await readFile(committed.targetPath, "utf8")).toContain("### Validation and next step");

    const stale = await proposeKnowledge(configPath, itemId, target);
    await writeFile(stale.targetPath, "human edit", "utf8");
    await expect(commitKnowledge(configPath, stale.proposalId)).rejects.toThrow("changed after preview");

    const candidate = path.resolve(import.meta.dirname, "../policies/ai-intelligence-v1.json");
    const experiment = await createPolicyExperiment(configPath, candidate);
    await expect(evaluatePolicyExperiment(configPath, experiment.experimentId)).resolves.toMatchObject({ eligible: false, metrics: { reviewedItems: 1 } });
    await expect(transitionPolicyExperiment(configPath, experiment.experimentId, "approve")).rejects.toThrow("cannot approve");
  }, 20_000);
});
