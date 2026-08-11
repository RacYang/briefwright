import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { createPolicyExperiment, evaluatePolicyExperiment, transitionPolicyExperiment } from "../src/commands/experiment.js";
import { loadEffectiveConfig } from "../src/config/load.js";
import { runFormalProject } from "../src/core/run.js";
import { FixtureModelProvider } from "../src/providers/fixture.js";
import { SqliteStateStore } from "../src/state/sqlite.js";

function response(url: string): Response {
  if (url.includes("github")) return new Response(JSON.stringify([{ id: 1, html_url: "https://github.com/QwenLM/qwen-code/releases/tag/v1", name: "AI agents runtime", tag_name: "v1", body: "AI agents runtime adds tool budgets", published_at: "2026-08-11T00:00:00Z", draft: false, prerelease: false }]), { status: 200 });
  return new Response("<rss><channel></channel></rss>", { status: 200 });
}

describe("frozen policy experiments", () => {
  it("replays a frozen reviewed sample through complete selection and supports guarded rollback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-experiment-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const run = await runFormalProject(configPath, { now: new Date("2026-08-11T02:00:00Z"), provider: new FixtureModelProvider(), fetch: async (url) => response(String(url)) });
    const config = await loadEffectiveConfig(configPath);
    const store = new SqliteStateStore(config.storage.path, config.projectRoot);
    try {
      const source = run.result.daily[0]!;
      const row = store.database.prepare("SELECT capture_id,analysis_json FROM items WHERE item_id=?").get(source.id) as { capture_id: string; analysis_json: string };
      for (let index = 0; index < 50; index += 1) {
        const id = `EXP-ITEM-${String(index).padStart(2, "0")}`;
        const analysis = { ...JSON.parse(row.analysis_json), id, url: `https://example.com/experiment/${index}` };
        store.database.prepare(`INSERT INTO items(item_id,run_id,capture_id,canonical_identity,title,summary,why_it_matters,domain,evidence_status,evidence_json,analysis_json,score,disposition,exclusion_reason)
          SELECT ?,run_id,capture_id,?,title,summary,why_it_matters,domain,evidence_status,evidence_json,?,score,disposition,exclusion_reason FROM items WHERE item_id=?`)
          .run(id, id, JSON.stringify(analysis), source.id);
        store.database.prepare(`INSERT INTO item_scores(item_id,dimension,raw_score,weight,weighted_score,reason)
          SELECT ?,dimension,raw_score,weight,weighted_score,reason FROM item_scores WHERE item_id=?`).run(id, source.id);
        store.addFeedback(id, "reviewed", undefined, index === 0 ? "2026-07-27T00:00:00Z" : "2026-08-11T00:00:00Z");
      }
    } finally { store.close(); }

    const candidate = structuredClone(config.policy);
    candidate.version = "1.1.0";
    candidate.score.dailyThreshold = 95;
    const candidatePath = path.join(root, "candidate-policy.json");
    await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    const created = await createPolicyExperiment(configPath, candidatePath);
    const first = await evaluatePolicyExperiment(configPath, created.experimentId);
    expect(first).toMatchObject({
      eligible: true,
      metrics: {
        reviewedItems: 50,
        spanDays: 15,
        baseline: { daily: 3, review: 0, machineOnly: 47 },
        candidate: { daily: 0, review: 50, machineOnly: 0 },
      },
    });
    const second = await evaluatePolicyExperiment(configPath, created.experimentId);
    expect(second.metrics).toMatchObject({ reviewedItems: 50, sampleDigest: (first.metrics as { sampleDigest: string }).sampleDigest });
    await expect(transitionPolicyExperiment(configPath, created.experimentId, "approve")).resolves.toMatchObject({ status: "approved" });
    await expect(transitionPolicyExperiment(configPath, created.experimentId, "activate")).resolves.toMatchObject({ status: "active" });
    expect((await loadEffectiveConfig(configPath)).policy.score.dailyThreshold).toBe(95);
    await expect(transitionPolicyExperiment(configPath, created.experimentId, "rollback")).resolves.toMatchObject({ status: "rolled-back" });
    expect((await loadEffectiveConfig(configPath)).policy.score.dailyThreshold).toBe(70);
  }, 30_000);
});
