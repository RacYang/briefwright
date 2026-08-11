import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { EffectiveConfig } from "../config/types.js";
import { configDigest, loadEffectiveConfig } from "../config/load.js";
import { sanitizeError } from "../config/secrets.js";
import { prepareSafeFilePath } from "../config/paths.js";
import { allowedHostsForSource, createHttpClient } from "../connectors/http.js";
import { connectorFor } from "../connectors/registry.js";
import type { CaptureEnvelope, ConnectorContext } from "../connectors/types.js";
import { renderFormalDaily, renderFormalReview } from "../outputs/formal-markdown.js";
import { writeArtifactSetAtomic } from "../outputs/write.js";
import { updateBriefingIndex } from "../outputs/index.js";
import { QwenProvider } from "../providers/qwen.js";
import type { ModelProvider } from "../providers/types.js";
import { SqliteStateStore } from "../state/sqlite.js";
import { countReceipts, runOutcome } from "./accounting.js";
import { buildCandidate, selectCandidates } from "./selection.js";
import { evaluateCadence } from "./cadence.js";
import type { BriefingItem, Receipt, RunResult } from "./types.js";

export const FORMAL_STAGES = [
  "initialize", "freeze_due_manifest", "discover", "capture", "write_receipts", "normalize",
  "verify_evidence", "deduplicate", "score", "select", "publish", "persist", "validate_integrity", "complete",
] as const;

type FormalStage = typeof FORMAL_STAGES[number];

function dateInTimeZone(now: Date, timeZone = "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

function allowedHosts(config: EffectiveConfig): string[] {
  return config.preset.sources.flatMap(allowedHostsForSource);
}

function changedCaptures(captures: CaptureEnvelope[], cursor: Record<string, unknown>): { changed: CaptureEnvelope[]; next: Record<string, unknown> } {
  const previous = cursor.items && typeof cursor.items === "object" ? cursor.items as Record<string, string> : {};
  const nextItems = Object.fromEntries(captures.map((capture) => [capture.externalKey, capture.contentHash]));
  return {
    changed: captures.filter((capture) => previous[capture.externalKey] !== capture.contentHash),
    next: { ...cursor, items: nextItems },
  };
}

async function optionalText(root: string, target: string): Promise<string | undefined> {
  await prepareSafeFilePath(root, target);
  try { return await readFile(target, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function mapBounded<T, R>(values: T[], concurrency: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), values.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!);
    }
  }));
  return results;
}

export interface FormalRunOutput {
  runId: string;
  outcome: "success" | "partial" | "failed";
  resumed: boolean;
  alreadyComplete: boolean;
  dailyPath: string;
  reviewPath: string;
  result: RunResult;
}

export async function runFormalProject(configPath: string, options: {
  now?: Date;
  provider?: ModelProvider;
  fetch?: ConnectorContext["fetch"];
} = {}): Promise<FormalRunOutput> {
  const config = await loadEffectiveConfig(configPath);
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const runId = `RUN-${dateInTimeZone(now)}-DAILY`;
  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  const executionPlan = {
    runId,
    stages: FORMAL_STAGES,
    rules: config.policy.rules,
    provider: { id: config.provider.id, version: config.provider.version, model: config.provider.model, secretRef: config.provider.apiKey },
    provenance: config.provenance,
    sourceIds: config.preset.sources.map((source) => source.id),
  };
  const begin = state.beginFormalRun(config, runId, startedAt, executionPlan);
  const recorded = state.runRecord(runId);
  if (begin === "complete" && recorded?.result) {
    const artifacts = state.runArtifacts(runId);
    const dailyPath = artifacts.find((artifact) => artifact.kind === "daily-markdown")?.path;
    const reviewPath = artifacts.find((artifact) => artifact.kind === "review-markdown")?.path;
    state.close();
    if (!dailyPath || !reviewPath) throw new Error(`Completed run ${runId} is missing required artifacts`);
    return { runId, outcome: recorded.status as FormalRunOutput["outcome"], resumed: false, alreadyComplete: true, dailyPath, reviewPath, result: recorded.result };
  }
  const timings: Record<string, number> = {};
  const stage = async <T>(name: FormalStage, operation: () => Promise<T> | T): Promise<T> => {
    const started = Date.now();
    const ordinal = FORMAL_STAGES.indexOf(name);
    state.recordStage(runId, name, ordinal, "running", new Date().toISOString());
    try {
      const value = await operation();
      timings[name] = Date.now() - started;
      state.recordStage(runId, name, ordinal, "complete", new Date().toISOString(), { durationMs: timings[name] });
      return value;
    } catch (error) {
      timings[name] = Date.now() - started;
      const detail = sanitizeError(error);
      state.recordStage(runId, name, ordinal, "failed", new Date().toISOString(), { durationMs: timings[name], detail });
      state.failFormalRun(runId, new Date().toISOString(), name, detail);
      throw error;
    }
  };

  try {
    if (begin === "resumed" && recorded?.status === "finalizing" && recorded.result) {
      const artifacts = state.runArtifacts(runId);
      const dailyPath = artifacts.find((artifact) => artifact.kind === "daily-markdown")?.path;
      const reviewPath = artifacts.find((artifact) => artifact.kind === "review-markdown")?.path;
      if (!dailyPath || !reviewPath) throw new Error(`Finalizing run ${runId} is missing required artifacts`);
      await stage("validate_integrity", () => countReceipts(state.dueSourceIds(runId), state.existingReceipts(runId)));
      recorded.result.integrityValidated = true;
      await stage("complete", () => undefined);
      recorded.result.stageTimings = { ...(recorded.result.stageTimings ?? {}), ...timings };
      const counts = countReceipts(state.dueSourceIds(runId), recorded.result.receipts);
      const base = runOutcome(counts);
      const outcome: FormalRunOutput["outcome"] = base === "failed" ? "failed" : base === "partial" || (recorded.result.modelFailures?.length ?? 0) > 0 ? "partial" : "success";
      recorded.result.cadenceGovernance = evaluateCadence(config, state, now);
      state.updateRunResult(recorded.result);
      state.finalizeFormalRun(runId, outcome);
      return { runId, outcome, resumed: true, alreadyComplete: false, dailyPath, reviewPath, result: recorded.result };
    }
    await stage("initialize", () => undefined);
    const dueSelection = state.dueSources(config.preset.sources, now);
    await stage("freeze_due_manifest", () => {
      for (const entry of dueSelection) state.freezeDueSources(runId, [entry.source], entry.reason);
    });
    await stage("discover", () => undefined);
    const existing = new Set(state.existingReceipts(runId).map((receipt) => receipt.sourceId));
    const dueIds = new Set(state.dueSourceIds(runId));
    const due = config.preset.sources.filter((source) => dueIds.has(source.id) && !existing.has(source.id));
    const fetchClient = options.fetch ?? createHttpClient({
      timeoutSeconds: config.runtime.timeoutSeconds,
      retries: config.runtime.retries,
      allowedHosts: allowedHosts(config),
    });
    const sourceResults = await stage("capture", () => mapBounded(due, config.runtime.httpConcurrency, async (source) => {
      const previousCursor = state.sourceCursor(source.id);
      let connectorCursor: Record<string, unknown> = {};
      const context: ConnectorContext = {
        fetch: fetchClient,
        now: () => now,
        cursor: previousCursor,
        setCursor: (value) => { connectorCursor = value; },
      };
      try {
        const captures = await connectorFor(source).capture(source, context);
        const notModified = connectorCursor.notModified === true;
        const change = notModified ? { changed: [] as CaptureEnvelope[], next: previousCursor } : changedCaptures(captures, previousCursor);
        const { notModified: _notModified, ...durableConnectorCursor } = connectorCursor;
        const receipt: Receipt = {
          sourceId: source.id,
          result: change.changed.length ? "updated" : "unchanged",
          detail: `${captures.length} captured; ${change.changed.length} new or changed`,
        };
        return { source, captures, changed: change.changed, cursor: { ...change.next, ...durableConnectorCursor }, receipt };
      } catch (error) {
        return { source, captures: [] as CaptureEnvelope[], changed: [] as CaptureEnvelope[], cursor: previousCursor, receipt: { sourceId: source.id, result: "failed" as const, detail: sanitizeError(error) } };
      }
    }));
    await stage("write_receipts", () => {
      for (const result of sourceResults.sort((a, b) => a.source.id.localeCompare(b.source.id))) {
        state.recordSourceResult(runId, result.receipt, result.captures, result.cursor, new Date().toISOString());
      }
    });
    const captures = await stage("normalize", () => state.runCaptures(runId));
    await stage("verify_evidence", () => undefined);
    const unique = await stage("deduplicate", () => [...new Map(captures.map((capture) => [`${capture.canonicalUrl}\n${capture.externalKey}`, capture])).values()]);
    const analysisTargets = unique.filter((capture) => sourceResults.length === 0 || sourceResults.some((result) => result.changed.some((changed) => changed.contentHash === capture.contentHash)))
      .slice(0, config.runtime.maximumCapturesPerRun);
    const provider = options.provider ?? new QwenProvider();
    const providerContext = { interests: config.interests, domains: config.policy.domains, prompt: config.prompts, provider: config.provider, projectRoot: config.projectRoot };
    const modelFailures: NonNullable<RunResult["modelFailures"]> = [];
    const analyzed = await stage("score", () => mapBounded(analysisTargets, config.runtime.modelConcurrency, async (capture) => {
      try {
        return buildCandidate(config, capture, await provider.analyze(capture, providerContext));
      } catch (error) {
        modelFailures.push({ captureId: createHash("sha256").update(capture.contentHash).digest("hex").slice(0, 16), sourceId: capture.sourceId, detail: sanitizeError(error) });
        return null;
      }
    }));
    const candidates = analyzed.filter((item): item is BriefingItem => item !== null);
    const selected = await stage("select", () => selectCandidates(config, candidates));
    const receipts = state.existingReceipts(runId);
    const counts = countReceipts(state.dueSourceIds(runId), receipts);
    const baseOutcome = runOutcome(counts);
    const outcome: FormalRunOutput["outcome"] = baseOutcome === "failed" ? "failed" : baseOutcome === "partial" || modelFailures.length ? "partial" : "success";
    const result: RunResult = {
      runId, generatedAt: new Date().toISOString(), mode: "live", runKind: "formal", configDigest: configDigest(config), receipts,
      daily: selected.daily, review: selected.review, machineOnly: selected.machineOnly, ruleIds: config.policy.rules.map((rule) => rule.id), modelFailures, stageTimings: timings,
    };
    const day = `${runId.slice(4, 8)}-${runId.slice(8, 10)}-${runId.slice(10, 12)}`;
    const dailyPath = path.join(config.output.directory, "Daily", `${day}-AI-intelligence.md`);
    const reviewPath = path.join(config.output.directory, "Review", `${day}-AI-intelligence-review.md`);
    const dailyIndexPath = path.join(config.output.directory, "Daily", "index.md");
    const reviewIndexPath = path.join(config.output.directory, "Review", "index.md");
    const daily = renderFormalDaily(config, result);
    const review = renderFormalReview(config, result);
    const dailyIndex = updateBriefingIndex(await optionalText(config.projectRoot, dailyIndexPath), `${config.name} · Daily index`, path.basename(dailyPath));
    const reviewIndex = updateBriefingIndex(await optionalText(config.projectRoot, reviewIndexPath), `${config.name} · Review index`, path.basename(reviewPath));
    await stage("publish", () => undefined);
    await stage("persist", () => writeArtifactSetAtomic(config.projectRoot, [
      { path: dailyPath, content: daily }, { path: reviewPath, content: review },
      { path: dailyIndexPath, content: dailyIndex }, { path: reviewIndexPath, content: reviewIndex },
    ], () => state.finishFormalRun(config, result, [...selected.daily, ...selected.review, ...selected.machineOnly], [
        { kind: "daily-markdown", path: dailyPath, contentHash: createHash("sha256").update(daily).digest("hex") },
        { kind: "review-markdown", path: reviewPath, contentHash: createHash("sha256").update(review).digest("hex") },
      ], outcome)));
    await stage("validate_integrity", () => countReceipts(state.dueSourceIds(runId), state.existingReceipts(runId)));
    result.integrityValidated = true;
    await stage("complete", () => undefined);
    const cadence = evaluateCadence(config, state, now);
    result.cadenceGovernance = cadence;
    state.appendEvent(runId, new Date().toISOString(), "complete", "cadence.evaluated", "run", runId, `${runId}:cadence`, cadence);
    state.updateRunResult(result);
    state.finalizeFormalRun(runId, outcome);
    return { runId, outcome, resumed: begin === "resumed", alreadyComplete: false, dailyPath, reviewPath, result };
  } finally {
    state.close();
  }
}
