import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEffectiveConfig, canonicalJson, configDigest, loadPackagedRuntime } from "../src/config/load.js";
import type { BriefingIntent } from "../src/config/types.js";
import { createFixtureRun } from "../src/core/fixture.js";
import { SqliteStateStore } from "../src/state/sqlite.js";

describe("SQLite state", () => {
  it("selects formal and retry evidence while excluding preview runs from backfill", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-formal-evidence-"));
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root);
    try {
      store.database.prepare("INSERT INTO config_snapshots(digest,config_json,created_at) VALUES (?,?,?)").run("fixture", "{}", "2026-08-12T00:00:00Z");
      const insert = store.database.prepare("INSERT INTO runs(run_id,generated_at,mode,config_digest,status,result_json,run_kind) VALUES (?,?,?,?,?,?,?)");
      insert.run("PREVIEW-EDITORIAL-1", "2026-08-12T00:00:00Z", "live", "fixture", "success", "{}", "preview");
      insert.run("RUN-20260812-DAILY", "2026-08-12T01:00:00Z", "live", "fixture", "failed", "{}", "formal");
      insert.run("RUN-20260812-DAILY-R01", "2026-08-12T02:00:00Z", "live", "fixture", "partial", "{}", "formal-retry");
      expect(store.formalRunIds()).toEqual(["RUN-20260812-DAILY", "RUN-20260812-DAILY-R01"]);
    } finally { store.close(); }
  });

  it("never exports a reused capture link to an unpublished zombie origin run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-capture-origin-"));
    const intent: BriefingIntent = { version: 2, name: "Capture origin", preset: "ai-daily", interests: ["AI"], schedule: "manual", output: "markdown", outputDirectory: "briefs", ai: "qwen" };
    const resources = await loadPackagedRuntime(intent); const config = buildEffectiveConfig(root, intent, resources.preset, resources.policy, resources.prompts, resources.provider);
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root);
    const origin = "RUN-20260812-DAILY-R06"; const current = "RUN-20260814-DAILY-R01"; const now = "2026-08-14T00:00:00Z";
    try {
      store.beginFormalRun(config, origin, "2026-08-12T00:00:00Z", { rules: config.policy.rules });
      store.beginFormalRun(config, current, now, { rules: config.policy.rules });
      store.database.prepare(`INSERT INTO captures(capture_id,run_id,source_id,external_key,canonical_url,title,summary,captured_at,content_hash,evidence_class,raw_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("CAP-ORIGIN", origin, config.preset.sources[0]!.id, "origin", "https://example.com/origin", "Origin", "Summary", now, "hash", "primary", JSON.stringify({ sourceId: config.preset.sources[0]!.id, canonicalUrl: "https://example.com/origin", title: "Origin", summary: "Summary", capturedAt: now, contentHash: "hash", evidenceClass: "primary" }));
      store.database.prepare(`INSERT INTO items(item_id,run_id,capture_id,canonical_identity,title,summary,why_it_matters,domain,evidence_status,evidence_json,analysis_json,score,disposition)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("AI-ORIGIN", current, "CAP-ORIGIN", "AI-ORIGIN", "Origin", "Summary", "Why", "Agent", "confirmed-primary", "{}", "{}", 90, "daily");
      const links = () => store.controlRecords(config, current).find((record) => record.kind === "captures" && record.id === "CAP-ORIGIN")!.links!.runs;
      expect(links()).toEqual([current]);
      store.database.prepare("UPDATE runs SET status='partial' WHERE run_id=?").run(origin);
      store.database.prepare("INSERT INTO output_artifacts(run_id,kind,path,content_hash) VALUES (?,?,?,?),(?,?,?,?)")
        .run(origin, "daily-markdown", "/tmp/daily", "daily", origin, "review-markdown", "/tmp/review", "review");
      expect(links()).toEqual([current, origin]);
    } finally { store.close(); }
  });

  it("keeps historical capture and receipt connectors frozen after current source migration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-frozen-source-"));
    const intent: BriefingIntent = { version: 2, name: "Frozen source", preset: "ai-daily", interests: ["AI"], schedule: "manual", output: "markdown", outputDirectory: "briefs", ai: "qwen" };
    const resources = await loadPackagedRuntime(intent);
    const historical = buildEffectiveConfig(root, intent, resources.preset, resources.policy, resources.prompts, resources.provider);
    const source = historical.preset.sources[0]!;
    source.connector = { type: "webpage", config: { url: "https://example.com/news" } };
    const current = structuredClone(historical);
    current.preset.sources[0]!.connector = { type: "computer-use", config: { url: "https://example.com/news", allowedHosts: ["example.com"] } };
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root);
    const runId = "RUN-20260814-DAILY"; const now = "2026-08-14T00:00:00Z";
    try {
      store.beginFormalRun(historical, runId, now, { rules: historical.policy.rules });
      store.freezeDueSources(runId, [source], "fixture");
      store.recordSourceResult(runId, { sourceId: source.id, result: "updated" }, [{
        sourceId: source.id, externalKey: "event", canonicalUrl: "https://example.com/news", title: "Event", summary: "Summary",
        capturedAt: now, contentHash: "hash", evidenceClass: "primary", discoveryUrl: "https://example.com/news",
        discoveryChannel: "webpage", fetchStatus: "success", extractStatus: "success", parserVersion: "1.0.1",
      }], {}, now);

      const records = store.controlRecords(current, runId);
      expect(records.find((record) => record.kind === "sources" && record.id === source.id)?.payload.connector).toEqual(current.preset.sources[0]!.connector);
      expect(records.find((record) => record.kind === "captures")?.payload).toMatchObject({ connector_type: "webpage", connector_version: "1.0.1" });
      expect(records.find((record) => record.kind === "receipts")?.payload).toMatchObject({ connector_type: "webpage", connector_version: "1.0.1" });
    } finally { store.close(); }
  });

  it("does not project current connector metadata when historical source evidence is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-missing-source-snapshot-"));
    const intent: BriefingIntent = { version: 2, name: "Missing source snapshot", preset: "ai-daily", interests: ["AI"], schedule: "manual", output: "markdown", outputDirectory: "briefs", ai: "qwen" };
    const resources = await loadPackagedRuntime(intent);
    const config = buildEffectiveConfig(root, intent, resources.preset, resources.policy, resources.prompts, resources.provider);
    const source = config.preset.sources[0]!;
    source.connector = { type: "computer-use", config: { url: "https://example.com/news", allowedHosts: ["example.com"] } };
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root);
    const runId = "RUN-20260814-DAILY"; const now = "2026-08-14T00:00:00Z";
    try {
      store.beginFormalRun(config, runId, now, { rules: config.policy.rules });
      store.recordSourceResult(runId, { sourceId: source.id, result: "updated" }, [{
        sourceId: source.id, externalKey: "event", canonicalUrl: "https://example.com/news", title: "Event", summary: "Summary",
        capturedAt: now, contentHash: "hash", evidenceClass: "primary", discoveryUrl: "https://example.com/news",
        discoveryChannel: "webpage", fetchStatus: "success", extractStatus: "success", parserVersion: "1.0.1",
      }], {}, now);

      const records = store.controlRecords(config, runId);
      expect(records.find((record) => record.kind === "captures")?.payload.connector_type).toBeUndefined();
      expect(records.find((record) => record.kind === "receipts")?.payload.connector_type).toBeUndefined();
    } finally { store.close(); }
  });

  it("collects unresolved control-plane records across the full retry lineage", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-lineage-repair-"));
    const intent: BriefingIntent = { version: 2, name: "Lineage repair", preset: "ai-daily", interests: ["AI"], schedule: "manual", output: "markdown", outputDirectory: "briefs", ai: "qwen" };
    const resources = await loadPackagedRuntime(intent);
    const config = buildEffectiveConfig(root, intent, resources.preset, resources.policy, resources.prompts, resources.provider);
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root);
    const digest = configDigest(config);
    const runIds = ["RUN-20260812-DAILY", "RUN-20260812-DAILY-R01"];
    try {
      store.database.prepare("INSERT INTO config_snapshots(digest,config_json,created_at) VALUES (?,?,?)").run(digest, JSON.stringify(config), "2026-08-12T00:00:00Z");
      const insert = store.database.prepare(`INSERT INTO runs(run_id,generated_at,mode,config_digest,status,result_json,started_at,run_kind,current_stage,execution_plan_json,parent_run_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const [index, runId] of runIds.entries()) {
        const result = { runId, generatedAt: `2026-08-12T0${index}:00:00Z`, mode: "live", runKind: index ? "formal-retry" : "formal", configDigest: digest,
          receipts: [], daily: [], review: [], outcome: "partial", controlPlaneReconciliation: { driver: "lark", created: 0, updated: 0, unchanged: 0,
            failed: [{ kind: "runs", id: runId, detail: "fixture" }], digest: "fixture" } };
        insert.run(runId, result.generatedAt, "live", digest, "partial", JSON.stringify(result), result.generatedAt, result.runKind, "complete", "{}", index ? runIds[0] : null);
      }
      expect(store.retryControlRecords(config, runIds[0]!)).toEqual(expect.arrayContaining(runIds.map((runId) => expect.objectContaining({ kind: "runs", id: runId }))));
      expect(store.retryControlRecords(config, runIds[0]!)).toHaveLength(2);
    } finally { store.close(); }
  });

  it("retries a legacy snapshot when only derived schedule timestamps drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-legacy-retry-"));
    const intent: BriefingIntent = { version: 2, name: "Legacy retry", preset: "ai-daily", interests: ["AI"], schedule: "manual", output: "markdown", outputDirectory: "briefs", ai: "qwen" };
    const resources = await loadPackagedRuntime(intent);
    const frozen = buildEffectiveConfig(root, intent, resources.preset, resources.policy, resources.prompts, resources.provider);
    frozen.preset.sources[0]!.scheduleState = { frequency: "daily", humanLocked: true, lastScanAt: "2026-08-12T00:00:00Z", nextScanAt: "2026-08-13T00:00:00Z" };
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root);
    const runId = "RUN-20260812-DAILY";
    const legacyDigest = createHash("sha256").update(canonicalJson(frozen)).digest("hex");
    const result = { runId, generatedAt: "2026-08-12T00:00:00Z", mode: "live", runKind: "formal", configDigest: legacyDigest,
      receipts: [{ sourceId: frozen.preset.sources[0]!.id, result: "failed" }], daily: [], review: [], outcome: "failed" };
    try {
      store.database.prepare("INSERT INTO config_snapshots(digest,config_json,created_at) VALUES (?,?,?)").run(legacyDigest, JSON.stringify(frozen), result.generatedAt);
      store.database.prepare(`INSERT INTO runs(run_id,generated_at,mode,config_digest,status,result_json,started_at,run_kind,current_stage,execution_plan_json)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(runId, result.generatedAt, "live", legacyDigest, "failed", JSON.stringify(result), result.generatedAt, "formal", "complete", "{}");
      const current = structuredClone(frozen);
      current.preset.sources[0]!.scheduleState = { ...current.preset.sources[0]!.scheduleState, lastScanAt: "2026-08-13T00:00:00Z", lastSuccessAt: "2026-08-13T00:00:01Z", nextScanAt: "2026-08-14T00:00:00Z" };
      current.provenance.controlPlaneRevision = "changed-only-because-runtime-progressed";
      expect(configDigest(current)).not.toBe(legacyDigest);
      expect(store.retryContext(runId, current)).toMatchObject({ runId: `${runId}-R01`, parentRunId: runId, forcedSourceIds: [frozen.preset.sources[0]!.id] });

      for (const mutate of [
        (candidate: typeof current) => { candidate.preset.sources[0]!.connector = { type: "rss", config: { url: "https://example.com/changed.xml" } }; },
        (candidate: typeof current) => { candidate.policy.rules[0]!.version = "changed"; },
        (candidate: typeof current) => { candidate.provider.model = "changed-model"; },
        (candidate: typeof current) => { candidate.runtime.httpConcurrency += 1; },
      ]) {
        const changed = structuredClone(current); mutate(changed);
        expect(() => store.retryContext(runId, changed)).toThrow("used a different configuration");
      }
    } finally { store.close(); }
  });

  it("keeps finalized runs immutable and rejects reuse with a different config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-state-"));
    const baseIntent: BriefingIntent = {
      version: 2,
      name: "Test",
      preset: "ai-daily",
      interests: ["AI agents"],
      schedule: "manual",
      output: "markdown",
      outputDirectory: "briefs",
      ai: "qwen",
    };
    const resources = await loadPackagedRuntime(baseIntent);
    const firstConfig = buildEffectiveConfig(root, baseIntent, resources.preset, resources.policy, resources.prompts, resources.provider);
    const firstRun = createFixtureRun(firstConfig, new Date("2026-08-10T00:00:00Z"));
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root);

    try {
      expect(() => store.saveRun(firstConfig, firstRun)).not.toThrow();
      expect(() => store.saveRun(firstConfig, firstRun)).toThrow("already finalized");

      const changedConfig = buildEffectiveConfig(
        root,
        { ...baseIntent, interests: ["AI safety"] },
        resources.preset,
        resources.policy,
        resources.prompts,
        resources.provider,
      );
      const changedRun = createFixtureRun(changedConfig, new Date("2026-08-10T01:00:00Z"));
      expect(changedRun.runId).not.toBe(firstRun.runId);
      expect(() =>
        store.saveRun(changedConfig, { ...changedRun, runId: firstRun.runId }),
      ).toThrow("different configuration digest");
    } finally {
      store.close();
    }
  });

  it("never persists the transient full-text analysis payload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-transient-"));
    const intent: BriefingIntent = { version: 2, name: "Retention", preset: "ai-daily", interests: ["AI"], schedule: "manual", output: "markdown", outputDirectory: "briefs", ai: "qwen" };
    const resources = await loadPackagedRuntime(intent); const config = buildEffectiveConfig(root, intent, resources.preset, resources.policy, resources.prompts, resources.provider);
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root); const runId = "RUN-20260811-DAILY"; const now = "2026-08-11T00:00:00Z";
    try {
      store.beginFormalRun(config, runId, now, { rules: config.policy.rules });
      store.recordSourceResult(runId, { sourceId: "SRC", result: "updated" }, [{ sourceId: "SRC", externalKey: "1", canonicalUrl: "https://example.com/1", title: "Title", summary: "bounded excerpt", capturedAt: now, contentHash: "hash", evidenceClass: "primary", analysisText: "FULL TEXT MUST REMAIN TRANSIENT" }], {}, now);
      const row = store.database.prepare("SELECT raw_json FROM captures").get() as { raw_json: string };
      expect(row.raw_json).not.toContain("FULL TEXT MUST REMAIN TRANSIENT");
      expect(row.raw_json).not.toContain("analysisText");
    } finally { store.close(); }
  });

  it("normalizes an unbindable external key before SQLite recordSourceResult", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-state-scalar-"));
    const intent: BriefingIntent = { version: 2, name: "Scalar", preset: "ai-daily", interests: ["AI"], schedule: "manual", output: "markdown", outputDirectory: "briefs", ai: "qwen" };
    const resources = await loadPackagedRuntime(intent); const config = buildEffectiveConfig(root, intent, resources.preset, resources.policy, resources.prompts, resources.provider);
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root); const runId = "RUN-20260812-DAILY"; const now = "2026-08-12T00:00:00Z";
    try {
      store.beginFormalRun(config, runId, now, { rules: config.policy.rules });
      expect(() => store.recordSourceResult(runId, { sourceId: "SRC-ARXIV-CS-AI", result: "updated" }, [{ sourceId: "SRC-ARXIV-CS-AI", externalKey: { unsupported: true } as unknown as string, canonicalUrl: "https://arxiv.org/abs/2608.01234", title: "Paper", summary: "Summary", capturedAt: now, contentHash: "hash", evidenceClass: "primary" }], {}, now)).not.toThrow();
      const row = store.database.prepare("SELECT external_key,raw_json FROM captures").get() as { external_key: string; raw_json: string };
      expect(row.external_key).toBe("https://arxiv.org/abs/2608.01234");
      expect((JSON.parse(row.raw_json) as { externalKey: string }).externalKey).toBe("https://arxiv.org/abs/2608.01234");
    } finally { store.close(); }
  });

  it("records an invalid non-key capture scalar as a source failure instead of crashing the run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-state-invalid-scalar-"));
    const intent: BriefingIntent = { version: 2, name: "Scalar guard", preset: "ai-daily", interests: ["AI"], schedule: "manual", output: "markdown", outputDirectory: "briefs", ai: "qwen" };
    const resources = await loadPackagedRuntime(intent); const config = buildEffectiveConfig(root, intent, resources.preset, resources.policy, resources.prompts, resources.provider);
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root); const runId = "RUN-20260812-DAILY"; const now = "2026-08-12T00:00:00Z";
    try {
      store.beginFormalRun(config, runId, now, { rules: config.policy.rules });
      expect(() => store.recordSourceResult(runId, { sourceId: "SRC", result: "updated" }, [{ sourceId: "SRC", externalKey: "1", canonicalUrl: "https://example.com/1", title: { unsupported: true } as unknown as string, summary: "Summary", capturedAt: now, contentHash: "hash", evidenceClass: "primary" }], {}, now)).not.toThrow();
      expect(store.existingReceipts(runId)).toMatchObject([{ sourceId: "SRC", result: "failed", detail: expect.stringContaining("title must be a SQLite-bindable scalar") }]);
      expect(store.runCaptures(runId)).toHaveLength(0);
    } finally { store.close(); }
  });

  it("classifies a stale non-terminal run as abandoned, resumes it once, and fences a concurrent writer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-abandoned-"));
    const intent: BriefingIntent = { version: 2, name: "Recovery", preset: "ai-daily", interests: ["AI"], schedule: "manual", output: "markdown", outputDirectory: "briefs", ai: "qwen" };
    const resources = await loadPackagedRuntime(intent); const config = buildEffectiveConfig(root, intent, resources.preset, resources.policy, resources.prompts, resources.provider);
    const store = new SqliteStateStore(path.join(root, ".briefwright/state.db"), root); const runId = "RUN-20260812-DAILY";
    try {
      store.beginFormalRun(config, runId, "2026-08-12T00:00:00Z", { rules: config.policy.rules });
      store.freezeDueSources(runId, [config.preset.sources[0]!], "fixture");
      const stale = store.runRecoveryStatus(runId, new Date("2026-08-12T01:00:00Z"));
      expect(stale).toMatchObject({ effectiveStatus: "abandoned", recoveryAction: "resume-execution", counts: { artifacts: 0 } });
      expect(store.beginFormalRun(config, runId, "2026-08-12T01:00:00Z", { rules: config.policy.rules })).toBe("resumed");
      expect(store.runRecoveryStatus(runId, new Date("2026-08-12T01:00:01Z"))).toMatchObject({ effectiveStatus: "running", recoveryAction: "wait-active" });
      expect(() => store.beginFormalRun(config, runId, "2026-08-12T01:00:02Z", { rules: config.policy.rules })).toThrow("refusing a concurrent writer");
    } finally { store.close(); }
  });
});
