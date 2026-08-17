import { mkdir, mkdtemp, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

import { ejectConfiguration } from "../src/commands/config.js";
import { initializeProject } from "../src/commands/init.js";
import { controlPlaneCommitRecords, runFormalProject } from "../src/core/run.js";
import { verifyReplay } from "../src/commands/replay.js";
import { previewProject } from "../src/commands/preview.js";
import { scheduleReadiness } from "../src/commands/schedule.js";
import { FixtureModelProvider } from "../src/providers/fixture.js";
import { loadEffectiveConfig } from "../src/config/load.js";
import type { LarkRunner } from "../src/control-plane/lark-cli.js";
import { SqliteStateStore } from "../src/state/sqlite.js";
import { renderFormalDaily, validateFormalArtifact } from "../src/outputs/formal-markdown.js";

beforeAll(() => vi.stubEnv("BRIEFWRIGHT_LOCALE", "zh-CN"));
afterAll(() => vi.unstubAllEnvs());

function sourceResponse(url: string): Response {
  if (url.includes("api.github.com")) {
    const repository = /\/repos\/([^/]+\/[^/]+)\/releases/.exec(url)?.[1] ?? "QwenLM/qwen-code";
    return new Response(JSON.stringify([{
      id: 10,
      html_url: `https://github.com/${repository}/releases/tag/v1.2.3`,
      name: "Agent runtime v1.2.3",
      tag_name: "v1.2.3",
      body: "AI agents gain an explicit tool budget and evidence checkpoint.",
      published_at: "2026-08-11T00:00:00Z",
      draft: false,
      prerelease: false,
    }]), { status: 200, headers: { etag: '"github-v1"' } });
  }
  return new Response(`<rss><channel><item>
    <title>AI agent evaluation protocol</title>
    <link>https://arxiv.org/abs/2608.00001</link>
    <guid>2608.00001</guid>
    <description>AI agents are evaluated with bounded evidence.</description>
    <pubDate>Tue, 11 Aug 2026 00:00:00 GMT</pubDate>
  </item></channel></rss>`, { status: 200, headers: { etag: '"rss-v1"' } });
}

describe("formal run", () => {
  it("includes phase-A audit events in the phase-B control-plane commit", () => {
    const records = [
      { kind: "runs" as const, id: "RUN-1", payload: { status: "success" }, links: { events: ["EVT-OLD", "EVT-RECONCILED"] } },
      { kind: "events" as const, id: "EVT-OLD", payload: { event_type: "stage.complete" } },
      { kind: "events" as const, id: "EVT-RECONCILED", payload: { event_type: "control-plane.reconciled" } },
      { kind: "events" as const, id: "EVT-OTHER", payload: { event_type: "unrelated" } },
      { kind: "items" as const, id: "AI-OTHER", payload: {} },
    ];
    expect(controlPlaneCommitRecords(records, "RUN-1").map((record) => record.id)).toEqual(["RUN-1", "EVT-OLD", "EVT-RECONCILED"]);
  });

  it("publishes a validated Computer Use source without falling back to HTTP", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-formal-computer-use-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    await ejectConfiguration(configPath);
    const sourcesDirectory = path.join(root, "briefwright.d/sources");
    const files = await readdir(sourcesDirectory);
    let selectedSourceId = "";
    for (const name of files) {
      const file = path.join(sourcesDirectory, name);
      const resource = parse(await readFile(file, "utf8")) as { metadata: { id: string }; spec: Record<string, unknown> };
      if (!selectedSourceId) {
        selectedSourceId = resource.metadata.id;
        resource.spec.title = "Dynamic official agent release";
        resource.spec.evidenceTier = "primary";
        resource.spec.priority = 100;
        resource.spec.connector = { type: "computer-use", config: { url: "https://docs.example.com/releases", allowedHosts: ["docs.example.com"] } };
      } else resource.spec.enabled = false;
      await writeFile(file, stringify(resource), "utf8");
    }
    const inbox = path.join(root, ".briefwright/inbox");
    await mkdir(inbox, { recursive: true });
    const bundle = path.join(inbox, "external-2026-08-19.json");
    await writeFile(bundle, JSON.stringify({
      apiVersion: "briefwright.dev/external-captures/v1",
      generatedAt: "2026-08-19T02:00:00Z",
      sources: [{
        sourceId: selectedSourceId,
        status: "captured",
        captureMode: "computer-use",
        captures: [{
          url: "https://docs.example.com/releases/agent-v2",
          title: "AI agents gain governed Computer Use capture",
          text: "AI agents gain governed Computer Use capture with exact source and evidence boundaries.",
          publishedAt: "2026-08-19T01:00:00Z",
          dateKind: "event",
        }],
      }],
    }));
    const result = await runFormalProject(configPath, {
      now: new Date("2026-08-19T03:00:00Z"),
      captureBundlePath: bundle,
      provider: new FixtureModelProvider(),
      fetch: async () => { throw new Error("Computer Use source must not fall back to HTTP"); },
    });
    expect(result).toMatchObject({ outcome: "success", publicationState: "published" });
    expect(result.result.receipts).toEqual([expect.objectContaining({ sourceId: selectedSourceId, result: "updated", detail: expect.stringContaining("external captures") })]);
    expect(result.result.daily).toHaveLength(1);
    expect(await readFile(result.dailyPath, "utf8")).toContain("AI agents gain governed Computer Use capture");
  }, 60_000);

  it("keeps a bundle-only editorial shadow isolated from every configured source not listed in the bundle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-bundle-only-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    await ejectConfiguration(configPath);
    const sourcesDirectory = path.join(root, "briefwright.d/sources");
    const files = await readdir(sourcesDirectory);
    const selectedFile = path.join(sourcesDirectory, files[0]!);
    const resource = parse(await readFile(selectedFile, "utf8")) as { metadata: { id: string }; spec: Record<string, unknown> };
    resource.spec.title = "Dynamic official agent release";
    resource.spec.evidenceTier = "primary";
    resource.spec.priority = 100;
    resource.spec.connector = { type: "computer-use", config: { url: "https://docs.example.com/releases", allowedHosts: ["docs.example.com"] } };
    await writeFile(selectedFile, stringify(resource), "utf8");

    const inbox = path.join(root, ".briefwright/inbox");
    await mkdir(inbox, { recursive: true });
    const bundle = path.join(inbox, "bundle-only.json");
    const now = new Date().toISOString();
    await writeFile(bundle, JSON.stringify({
      apiVersion: "briefwright.dev/external-captures/v1",
      generatedAt: now,
      sources: [{
        sourceId: resource.metadata.id,
        status: "captured",
        captureMode: "computer-use",
        captures: [{
          url: "https://docs.example.com/releases/agent-v2",
          title: "AI agents gain governed Computer Use capture",
          text: "AI agents gain governed Computer Use capture with exact source and evidence boundaries.",
          publishedAt: now,
          dateKind: "event",
        }],
      }],
    }));
    const result = await previewProject(configPath, {
      live: true,
      editorial: true,
      bundleOnly: true,
      captureBundlePath: bundle,
      provider: new FixtureModelProvider(),
      fetch: async () => { throw new Error("A bundle-only shadow must not fetch unlisted sources"); },
    });
    expect(result).toMatchObject({ previewScope: "capture-bundle", receiptCount: 1, selected: { daily: 1, review: 0, machineOnly: 0 } });
    expect(await readFile(result.outputPath, "utf8")).toContain("Bundle-only scope");
    await expect(previewProject(configPath, { live: true, editorial: true, historicalBundle: true, captureBundlePath: bundle }))
      .rejects.toThrow("Historical bundles are allowed only");
    await expect(scheduleReadiness(configPath, { preflight: async () => [] })).rejects.toThrow("editorial shadow");
  }, 60_000);

  it("replays formal artifacts from a configured Obsidian document root outside the project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-replay-project-"));
    const vault = await mkdtemp(path.join(tmpdir(), "briefwright-replay-vault-"));
    const configPath = await initializeProject({
      directory: root,
      yes: true,
      interests: ["AI agents"],
      documentStore: { driver: "obsidian", root: vault, briefingDirectory: "Inbox/AI Intelligence" },
    });
    const result = await runFormalProject(configPath, {
      now: new Date("2026-08-11T02:00:00Z"),
      provider: new FixtureModelProvider(),
      fetch: async (url) => sourceResponse(String(url)),
    });

    expect(result.dailyPath.startsWith(vault)).toBe(true);
    await expect(verifyReplay(configPath, result.runId)).resolves.toMatchObject({
      matches: true,
      artifacts: [{ kind: "daily-markdown" }, { kind: "review-markdown" }],
    });
  }, 60_000);

  it("freezes, captures, analyzes, selects, publishes, and is idempotent within the day", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-formal-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const now = new Date("2026-08-11T02:00:00Z");
    let fetchCount = 0;
    const first = await runFormalProject(configPath, {
      now,
      provider: new FixtureModelProvider(),
      fetch: async (url) => { fetchCount += 1; return sourceResponse(String(url)); },
    });
    expect(first.runId).toBe("RUN-20260811-DAILY");
    expect(first.alreadyComplete).toBe(false);
    expect(first.outcome).toBe("success");
    expect(first.result.receipts).toHaveLength(8);
    expect(first.result.daily.length).toBeGreaterThan(0);
    expect(first.result.readerFormatVersion).toBe(2);
    const dailyArtifact = await readFile(first.dailyPath, "utf8");
    expect(dailyArtifact).toContain("contract_digest:");
    expect(dailyArtifact).toContain("source_manifest_digest:");
    expect(dailyArtifact).toContain("reader_format_version: 2");
    expect(dailyArtifact).not.toContain("## 发布前阶段耗时");
    expect(dailyArtifact).not.toContain("## 运行摘要");
    expect(dailyArtifact).not.toContain("## 来源失败");
    expect(dailyArtifact).not.toContain("## 模型失败");
    expect(dailyArtifact).not.toContain("## 完成与存储校验");
    expect(dailyArtifact).toContain("首要跟进");
    expect(dailyArtifact).toContain("没有足够证据形成跨领域判断");
    expect(dailyArtifact).not.toContain("仅保留条目中有直接证据支持的影响说明");
    expect(dailyArtifact).toContain("### 为什么重要");
    expect(dailyArtifact).toContain("- 来源日期：");
    expect(dailyArtifact).not.toContain("- 发布时间：");
    expect(dailyArtifact).not.toContain("- 内容哈希：");
    expect(dailyArtifact).not.toContain("- 评分维度：");
    expect(dailyArtifact.split("\n").length).toBeLessThan(100);
    expect(dailyArtifact).not.toContain("## Run summary");
    expect(dailyArtifact).not.toContain("## Source failures");
    const effective = await loadEffectiveConfig(configPath);
    const englishArtifact = renderFormalDaily(effective, first.result, "en");
    expect(englishArtifact).not.toContain("## Run summary");
    expect(englishArtifact).not.toContain("## Source failures");
    expect(englishArtifact).toContain("### Why it matters");
    expect(englishArtifact).toContain("Top priority:");
    expect(englishArtifact).toContain("not enough evidence for a cross-domain assessment");
    expect(englishArtifact).not.toContain("首要跟进");
    expect(englishArtifact).toContain("- Source date: ");
    expect(englishArtifact).not.toContain("## 运行摘要");
    expect(() => validateFormalArtifact(effective, first.result, "daily", englishArtifact)).not.toThrow();
    const firstDaily = first.result.daily[0]!;
    const multiDomainArtifact = renderFormalDaily(effective, { ...first.result, daily: [firstDaily, { ...firstDaily,
      id: `${firstDaily.id}-SYSTEM`, title: "Runtime dependency floor changes", domain: "系统与工程", score: firstDaily.score - 1 }] }, "en");
    expect(multiDomainArtifact).toContain("- Agent:");
    expect(multiDomainArtifact).toContain("- 系统与工程:");
    expect(multiDomainArtifact).toContain("strongest verified signals in each domain");
    expect(await readFile(first.reviewPath, "utf8")).toContain("队列未被填充");
    expect(await readFile(path.join(path.dirname(path.dirname(first.dailyPath)), "Note-AI情报候选池.md"), "utf8")).toContain("<!-- ai-intelligence-digest:start -->");
    await expect(verifyReplay(configPath, first.runId)).resolves.toMatchObject({
      matches: true,
      artifacts: [{ kind: "daily-markdown" }, { kind: "review-markdown" }],
    });

    const second = await runFormalProject(configPath, {
      now,
      provider: new FixtureModelProvider(),
      fetch: async () => { throw new Error("idempotent rerun must not fetch"); },
    });
    expect(second.alreadyComplete).toBe(true);
    expect(fetchCount).toBe(8);
    const config = await loadEffectiveConfig(configPath); const state = new SqliteStateStore(config.storage.path, config.projectRoot);
    const modelPerformance = (state.diagnoseImprovements(new Date("2026-08-11T03:00:00Z"), 30, config.policy.domains).metrics.modelPerformance) as { averageDurationMs: number; unknownCostObservations: number };
    const controlRecords = state.controlRecords(config, first.runId);
    const controlEvents = controlRecords.filter((record) => record.kind === "events");
    const selectedIds = new Set([...first.result.daily, ...first.result.review].map((item) => item.id));
    const itemControlEvents = controlEvents.filter((record) => record.payload.entity_type === "item");
    state.close();
    expect(modelPerformance.averageDurationMs).toBeGreaterThanOrEqual(0); expect(modelPerformance.unknownCostObservations).toBeGreaterThan(0);
    expect(itemControlEvents).toHaveLength(selectedIds.size);
    expect(itemControlEvents.every((record) => selectedIds.has(String(record.payload.entity_id))
      && ["已生成简报", "人工复核"].includes(JSON.parse(String(record.payload.payload_json)).toState))).toBe(true);
  }, 60_000);

  it("resumes an interrupted run from durable receipts without fetching sources again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-resume-"));
    const outside = await mkdtemp(path.join(tmpdir(), "briefwright-resume-outside-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    await symlink(outside, path.join(root, "briefs"));
    const now = new Date("2026-08-12T02:00:00Z");
    await expect(runFormalProject(configPath, { now, provider: new FixtureModelProvider(), fetch: async (url) => sourceResponse(String(url)) })).rejects.toThrow("symlink");
    await unlink(path.join(root, "briefs"));
    await mkdir(path.join(root, "briefs"));
    const resumed = await runFormalProject(configPath, { now, provider: new FixtureModelProvider(), fetch: async () => { throw new Error("resume unexpectedly fetched"); } });
    expect(resumed.resumed).toBe(true);
    expect(resumed.outcome).toBe("success");
    expect(resumed.result.receipts).toHaveLength(8);
  }, 60_000);

  it("fails closed on legacy finalizing runs that already exposed pre-commit artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-legacy-finalizing-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const first = await runFormalProject(configPath, { now: new Date("2026-08-11T02:00:00Z"), provider: new FixtureModelProvider(), fetch: async (url) => sourceResponse(String(url)) });
    const config = await loadEffectiveConfig(configPath); const state = new SqliteStateStore(config.storage.path, config.projectRoot);
    const legacy = structuredClone(first.result); delete legacy.publicationState; delete legacy.integrityManifest;
    state.database.prepare("UPDATE runs SET status='finalizing',completed_at=NULL,current_stage='complete',result_json=? WHERE run_id=?").run(JSON.stringify(legacy), first.runId);
    state.close();
    await expect(runFormalProject(configPath, { now: new Date("2026-08-11T03:00:00Z"), provider: new FixtureModelProvider(), fetch: async () => { throw new Error("legacy finalizing must not fetch"); } }))
      .rejects.toThrow("pre-commit artifacts");
    expect(await readFile(first.dailyPath, "utf8")).toContain(`run_id: ${first.runId}`);
  }, 60_000);

  it("withholds documents when model failures leave no usable briefing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-model-failure-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const failed = await runFormalProject(configPath, {
      now: new Date("2026-08-13T02:00:00Z"),
      provider: {
        id: "failure-fixture",
        version: "1.0.0",
        async check() { return { ok: false, detail: "fixture" }; },
        async analyze() { throw new Error("model unavailable"); },
      },
      fetch: async (url) => sourceResponse(String(url)),
    });
    expect(failed.outcome).toBe("failed");
    expect(failed.publicationState).toBe("withheld");
    expect(failed.result.outcome).toBe("failed");
    expect(failed.result.modelFailures?.length).toBeGreaterThan(0);
    await expect(readFile(failed.dailyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(failed.reviewPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const recovered = await runFormalProject(configPath, {
      now: new Date("2026-08-14T04:00:00Z"),
      retryFailed: true,
      baseRunId: failed.runId,
      provider: new FixtureModelProvider(),
      fetch: async () => { throw new Error("model-only recovery must not refetch successful sources"); },
    });
    expect(recovered.runId).toBe("RUN-20260813-DAILY-R01");
    expect(recovered.result.runKind).toBe("formal-retry");
    expect(recovered.outcome).toBe("success");
    expect(recovered.result.daily.length + recovered.result.review.length).toBeGreaterThan(0);
    await expect(runFormalProject(configPath, { now: new Date("2026-08-13T05:00:00Z"), retryFailed: true, provider: new FixtureModelProvider() })).rejects.toThrow("no failed operations");
  }, 60_000);

  it("resumes execution failures without misrouting them into process-store finalization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-stage-failure-retry-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const config = await loadEffectiveConfig(configPath);
    const runId = "RUN-20260816-DAILY";
    const state = new SqliteStateStore(config.storage.path, config.projectRoot);
    state.beginFormalRun(config, runId, "2026-08-16T02:00:00Z", { stages: ["initialize", "publish"] });
    state.freezeDueSources(runId, [config.preset.sources[0]!], "stage-failure-fixture");
    state.failFormalRun(runId, "2026-08-16T02:01:00Z", "publish", "artifact validation failed");
    state.close();

    const recovered = await runFormalProject(configPath, {
      now: new Date("2026-08-16T03:00:00Z"),
      retryFailed: true,
      provider: new FixtureModelProvider(),
      fetch: async (url) => sourceResponse(String(url)),
    });
    expect(recovered).toMatchObject({ runId, resumed: true, publicationState: "published" });
    expect(recovered.result.generatedAt).toBe("2026-08-16T02:00:00Z");
    expect(recovered.outcome).not.toBe("failed");
    await expect(verifyReplay(configPath, runId)).resolves.toMatchObject({ matches: true });
  }, 60_000);

  it("immutably refetches and promotes legacy primary items with anchored source evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-reverify-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const fixture = new FixtureModelProvider();
    const base = await runFormalProject(configPath, {
      now: new Date("2026-08-18T02:00:00Z"),
      provider: {
        id: "unanchored-fixture", version: "1.0.0", check: () => fixture.check(),
        analyze: async (capture, context) => ({ ...(await fixture.analyze(capture, context)), claimEvidence: [{ claimIndex: 0, excerpt: "PROTECTED TRANSIENT ANCHOR THAT IS ABSENT" }] }),
      },
      fetch: async (url) => sourceResponse(String(url)),
    });
    expect(base.result.daily).toHaveLength(0);
    expect(base.result.machineOnly?.every((item) => item.evidenceStatus === "unverified")).toBe(true);
    const recovered = await runFormalProject(configPath, {
      now: new Date("2026-08-18T03:00:00Z"), reverifyEvidence: true, provider: fixture,
      fetch: async (url) => {
        const value = String(url);
        if (value.includes("api.github.com")) return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        if (value.includes("export.arxiv.org")) return new Response("<rss><channel></channel></rss>", { status: 200, headers: { "content-type": "application/rss+xml" } });
        return new Response("<html><title>Recovered canonical source</title><body>AI agents gain an explicit tool budget and evidence checkpoint. AI agents are evaluated with bounded evidence.</body></html>", { status: 200, headers: { "content-type": "text/html" } });
      },
    });
    expect(recovered.runId).toBe("RUN-20260818-DAILY-R01");
    expect(recovered.result.daily).toHaveLength(0);
    expect(recovered.result.review).toHaveLength(0);
    expect(recovered.result.machineOnly?.length).toBeGreaterThan(0);
    expect(recovered.result.modelFailures).toHaveLength(0);
    expect(recovered.result.machineOnly?.every((item) => item.evidenceStatus === "confirmed-primary" && item.exclusionReasons?.includes("recovery-only"))).toBe(true);
    const config = await loadEffectiveConfig(configPath); const state = new SqliteStateStore(config.storage.path, config.projectRoot);
    const records = state.controlRecords(config, recovered.runId);
    const stored = state.database.prepare("SELECT analysis_json FROM analysis_attempts WHERE run_id=?").all(recovered.runId) as Array<{ analysis_json: string }>;
    const baseRows = state.database.prepare("SELECT item_id,run_id,evidence_status FROM items WHERE run_id=?").all(base.runId) as Array<{ item_id: string; run_id: string; evidence_status: string }>;
    const recoveryRows = state.database.prepare("SELECT item_id FROM run_items WHERE run_id=?").all(recovered.runId) as Array<{ item_id: string }>;
    const remainingTargets = state.evidenceReverificationTargets(base.runId);
    state.close();
    expect(records.filter((record) => record.kind === "items").length).toBeGreaterThan(0);
    expect(stored.every((row) => !row.analysis_json.includes('"claimEvidence"') && row.analysis_json.includes('"_evidenceVerification"'))).toBe(true);
    expect(baseRows.every((row) => row.run_id === base.runId && row.evidence_status === "unverified")).toBe(true);
    expect(recoveryRows.length).toBeGreaterThan(0);
    expect(recoveryRows.every((row) => !baseRows.some((baseRow) => baseRow.item_id === row.item_id))).toBe(true);
    expect(remainingTargets).toEqual([]);
  }, 60_000);

  it("persists one auditable failed capture per failed source without analyzing it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-capture-failure-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const result = await runFormalProject(configPath, {
      now: new Date("2026-08-16T02:00:00Z"), provider: new FixtureModelProvider(),
      fetch: async () => new Response("unavailable", { status: 503 }),
    });
    expect(result.outcome).toBe("failed");
    expect(result.result.completionReport).toMatchObject({ due: 8, failed: 8, discovered: 0, captured: 0, verified: 0 });
    const config = await loadEffectiveConfig(configPath); const state = new SqliteStateStore(config.storage.path, config.projectRoot);
    const failures = state.controlRecords(config, result.runId).filter((record) => record.kind === "captures");
    const events = state.controlRecords(config, result.runId).filter((record) => record.kind === "events");
    state.close();
    expect(failures).toHaveLength(8);
    expect(failures.every((record) => /^CAP-20260816-[A-F0-9]{16}$/.test(record.id))).toBe(true);
    expect(failures).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ raw_json: expect.stringContaining('"fetchStatus":"failed"') }) })]));
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ event_type: "capture.failed", payload_json: expect.stringContaining('"toState":"抓取失败"') }) })]));
    expect(events.every((record) => String(record.payload.idempotency_key).includes("RULE-WORKFLOW-V1.3") && JSON.parse(String(record.payload.payload_json)).ruleIdSnapshot === "RULE-WORKFLOW-V1.3")).toBe(true);
  }, 60_000);

  it("reports capture-limit backlog as partial and makes it recoverable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-backlog-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    await ejectConfiguration(configPath);
    const profilePath = path.join(root, "briefwright.d/profile.yaml");
    const profile = parse(await readFile(profilePath, "utf8")) as { spec: { runtime: { maximumCapturesPerRun: number } } };
    profile.spec.runtime.maximumCapturesPerRun = 1;
    await writeFile(profilePath, stringify(profile), "utf8");
    const first = await runFormalProject(configPath, {
      now: new Date("2026-08-14T02:00:00Z"),
      provider: new FixtureModelProvider(),
      fetch: async (url) => sourceResponse(String(url)),
    });
    expect(first.outcome).toBe("partial");
    expect(first.result.modelFailures).toEqual([]);
    expect(first.result.analysisBacklog).toContainEqual(expect.objectContaining({ count: expect.any(Number) }));
    const recovery = await runFormalProject(configPath, {
      now: new Date("2026-08-14T03:00:00Z"),
      retryFailed: true,
      provider: new FixtureModelProvider(),
      fetch: async () => { throw new Error("analysis backlog recovery must not refetch"); },
    });
    expect(recovery.runId).toBe("RUN-20260814-DAILY-R01");
    expect(recovery.outcome).toBe("partial");
  }, 60_000);

  it("fails closed and withholds Markdown when Lark synchronization fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-lark-partial-"));
    const tableIds = { sources: "tbl_sources", runs: "tbl_runs", items: "tbl_items", events: "tbl_events", feedback: "tbl_feedback", experiments: "tbl_experiments", captures: "tbl_captures", rules: "tbl_rules", receipts: "tbl_receipts" };
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"], processStore: { driver: "lark", baseToken: "base", tables: tableIds } });
    const config = await loadEffectiveConfig(configPath);
    const runner: LarkRunner = (args) => {
      if (args.includes("+record-list")) {
        const table = args[args.indexOf("--table-id") + 1];
        if (table === tableIds.sources) return { record_id_list: ["rec_source"], fields: ["Source ID", "名称", "状态", "来源类型", "入口 URL", "来源层级", "覆盖领域", "扫描频率"], data: [["SRC-QWEN-GITHUB", "Qwen", ["启用"], ["GitHub"], "https://github.com/QwenLM/qwen-code/releases", ["一手来源"], ["Agent"], ["每日"]]], has_more: false };
        if (table === tableIds.rules) return { record_id_list: config.policy.rules.map((_, index) => `rec_rule_${index}`), fields: ["Rule ID", "版本", "标题", "状态"], data: config.policy.rules.map((rule) => [rule.id, rule.version, rule.title, ["生效中"]]), has_more: false };
        return { record_id_list: [], fields: [], data: [], has_more: false };
      }
      if (args.includes("+record-upsert")) throw new Error("simulated Base write outage");
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const result = await runFormalProject(configPath, { now: new Date("2026-08-15T02:00:00Z"), provider: new FixtureModelProvider(), fetch: async (url) => sourceResponse(String(url)), larkRunner: runner });
    expect(result.outcome).toBe("failed");
    expect(result.publicationState).toBe("withheld");
    expect(result.result.completionReport).toMatchObject({ processStoreValid: false, documentStoreValid: false });
    await expect(readFile(result.dailyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(result.reviewPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const state = new SqliteStateStore(config.storage.path, config.projectRoot);
    const frozenConfig = JSON.parse((state.database.prepare(`SELECT config_snapshots.config_json FROM runs JOIN config_snapshots
      ON config_snapshots.digest=runs.config_digest WHERE runs.run_id=?`).get(result.runId) as { config_json: string }).config_json) as typeof config;
    expect(state.runArtifacts(result.runId)).toHaveLength(0);
    expect(state.retryContext(result.runId, frozenConfig)).toMatchObject({ runId: result.runId, parentRunId: result.runId, forcedSourceIds: [], resumed: true });
    expect(state.resumeWithheldControlPlaneRun(result.runId, "2026-08-15T03:00:00Z")).toBe("resumed");
    expect(state.runRecord(result.runId)).toMatchObject({ status: "finalizing", result: expect.objectContaining({ publicationState: "withheld" }) });
    expect(state.runArtifacts(result.runId)).toHaveLength(0);
    state.close();
  }, 60_000);
});
