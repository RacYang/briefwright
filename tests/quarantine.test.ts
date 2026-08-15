import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { quarantineLegacyRun } from "../src/commands/quarantine.js";
import { initializeProject } from "../src/commands/init.js";
import { loadEffectiveConfig } from "../src/config/load.js";
import type { RunResult } from "../src/core/types.js";
import { SqliteStateStore } from "../src/state/sqlite.js";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "briefwright-quarantine-"));
  const configPath = await initializeProject({ directory: root, yes: true });
  const config = await loadEffectiveConfig(configPath);
  return { root, configPath, config };
}

function legacyResult(runId: string, configDigest: string, publicationState?: "published"): RunResult {
  return { runId, generatedAt: "2026-08-12T00:00:00Z", mode: "live", runKind: "formal", configDigest,
    receipts: [], daily: [], review: [], outcome: "partial", ...(publicationState ? { publicationState } : {}) };
}

describe("legacy run quarantine", () => {
  it("previews without writes, then copies verified files and withholds exact legacy artifacts", async () => {
    const { root, configPath, config } = await fixture();
    const runId = "RUN-20260812-DAILY-R02";
    const dailyPath = path.join(config.output.directory, "Daily", "legacy.md");
    const reviewPath = path.join(config.output.directory, "Review", "legacy.md");
    await mkdir(path.dirname(dailyPath), { recursive: true });
    await mkdir(path.dirname(reviewPath), { recursive: true });
    await writeFile(dailyPath, "daily\n"); await writeFile(reviewPath, "review\n");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const state = new SqliteStateStore(config.storage.path, config.projectRoot);
    state.beginFormalRun(config, runId, "2026-08-12T00:00:00Z", { rules: config.policy.rules });
    state.database.prepare("UPDATE runs SET status='partial',result_json=?,current_stage='complete' WHERE run_id=?")
      .run(JSON.stringify(legacyResult(runId, state.runRecord(runId)!.configDigest)), runId);
    state.database.prepare("INSERT INTO output_artifacts(run_id,kind,path,content_hash) VALUES (?,?,?,?),(?,?,?,?)")
      .run(runId, "daily-markdown", dailyPath, hash("daily\n"), runId, "review-markdown", reviewPath, hash("review\n"));
    state.close();

    const preview = await quarantineLegacyRun(configPath, runId);
    expect(preview).toMatchObject({ written: false, action: "quarantine-artifacts", artifacts: [{ existed: true }, { existed: true }] });
    await expect(access(path.join(root, ".briefwright", "quarantine"))).rejects.toThrow();
    await expect(readFile(dailyPath, "utf8")).resolves.toBe("daily\n");

    const written = await quarantineLegacyRun(configPath, runId, { write: true, yes: true, now: new Date("2026-08-15T00:00:00Z") });
    expect(written).toMatchObject({ written: true, stateAction: "quarantined", backupPath: expect.any(String), manifestPath: expect.any(String) });
    await expect(access(dailyPath)).rejects.toThrow(); await expect(access(reviewPath)).rejects.toThrow();
    await expect(access(written.backupPath!)).resolves.toBeUndefined();
    const manifest = JSON.parse(await readFile(written.manifestPath!, "utf8")) as { status: string; artifacts: Array<{ quarantinePath: string }> };
    expect(manifest.status).toBe("complete");
    await expect(readFile(manifest.artifacts[0]!.quarantinePath, "utf8")).resolves.toMatch(/daily|review/);
    const after = new SqliteStateStore(config.storage.path, config.projectRoot);
    expect(after.runArtifacts(runId)).toEqual([]);
    expect(after.runRecord(runId)).toMatchObject({ status: "failed", result: { outcome: "failed", publicationState: "withheld", integrityValidated: false, legacyQuarantine: { artifactCount: 2 } } });
    expect(after.runRecoveryStatus(runId)).toMatchObject({ recoveryAction: "none" });
    expect(() => after.retryContext(runId, config)).toThrow("explicitly quarantined");
    after.close();
    await expect(quarantineLegacyRun(configPath, runId)).resolves.toMatchObject({ action: "none", written: false, manifestPath: written.manifestPath });
  });

  it("records missing finalizing artifacts without inventing files", async () => {
    const { configPath, config } = await fixture(); const runId = "RUN-20260813-DAILY";
    const state = new SqliteStateStore(config.storage.path, config.projectRoot);
    state.beginFormalRun(config, runId, "2026-08-13T00:00:00Z", { rules: config.policy.rules });
    state.database.prepare("UPDATE runs SET status='finalizing',result_json=? WHERE run_id=?")
      .run(JSON.stringify(legacyResult(runId, state.runRecord(runId)!.configDigest)), runId);
    state.database.prepare("INSERT INTO output_artifacts(run_id,kind,path,content_hash) VALUES (?,?,?,?),(?,?,?,?)")
      .run(runId, "daily-markdown", path.join(config.output.directory, "Daily", "missing.md"), "a".repeat(64),
        runId, "review-markdown", path.join(config.output.directory, "Review", "missing.md"), "b".repeat(64));
    state.close();
    const written = await quarantineLegacyRun(configPath, runId, { write: true, yes: true });
    expect(written.artifacts).toEqual([expect.objectContaining({ existed: false, quarantinePath: null }), expect.objectContaining({ existed: false, quarantinePath: null })]);
    expect(written.stateAction).toBe("quarantined");
  });

  it("abandons an exact zombie with no result or artifacts and is idempotent", async () => {
    const { configPath, config } = await fixture(); const runId = "RUN-20260812-DAILY-R06";
    const state = new SqliteStateStore(config.storage.path, config.projectRoot);
    state.beginFormalRun(config, runId, "2026-08-12T00:00:00Z", { rules: config.policy.rules }); state.close();
    expect(await quarantineLegacyRun(configPath, runId)).toMatchObject({ action: "abandon-zombie", written: false });
    expect(await quarantineLegacyRun(configPath, runId, { write: true, yes: true })).toMatchObject({ stateAction: "abandoned", written: true });
    const isolated = new SqliteStateStore(config.storage.path, config.projectRoot);
    expect(isolated.runRecoveryStatus(runId)).toMatchObject({ storedStatus: "abandoned", recoveryAction: "none" });
    expect(isolated.recoverableRuns()).toEqual([]);
    expect(() => isolated.beginFormalRun(config, runId, new Date().toISOString(), { rules: config.policy.rules })).toThrow("explicitly quarantined");
    expect(() => isolated.retryContext("RUN-20260812-DAILY", config)).toThrow("explicitly quarantined");
    isolated.close();
    expect(await quarantineLegacyRun(configPath, runId)).toMatchObject({ action: "none", written: false });
  });

  it("fails closed for published runs, hash mismatches, and paths outside the document output", async () => {
    const { root, configPath, config } = await fixture(); const runId = "RUN-20260812-DAILY";
    const outside = path.join(root, "outside.md"); await writeFile(outside, "outside\n");
    const state = new SqliteStateStore(config.storage.path, config.projectRoot);
    state.beginFormalRun(config, runId, "2026-08-12T00:00:00Z", { rules: config.policy.rules });
    state.database.prepare("UPDATE runs SET status='partial',result_json=? WHERE run_id=?")
      .run(JSON.stringify(legacyResult(runId, state.runRecord(runId)!.configDigest, "published")), runId);
    state.database.prepare("INSERT INTO output_artifacts(run_id,kind,path,content_hash) VALUES (?,?,?,?)")
      .run(runId, "daily-markdown", outside, createHash("sha256").update("different").digest("hex")); state.close();
    await expect(quarantineLegacyRun(configPath, runId)).rejects.toThrow("Published run");
    const editable = new SqliteStateStore(config.storage.path, config.projectRoot);
    const result = editable.runRecord(runId)!.result!; delete result.publicationState;
    editable.database.prepare("UPDATE runs SET result_json=? WHERE run_id=?").run(JSON.stringify(result), runId); editable.close();
    await expect(quarantineLegacyRun(configPath, runId)).rejects.toThrow("Path escapes the configured document output");
  });
});
