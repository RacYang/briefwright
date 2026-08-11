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
import { validateModelAnalysis } from "../providers/validate.js";
import { SqliteStateStore } from "../state/sqlite.js";
import { countReceipts, runOutcome } from "./accounting.js";
import { buildCandidate, canonicalItemIdentity, selectCandidates } from "./selection.js";
import { evaluateCadence } from "./cadence.js";
import { verifyAnalysisEvidence } from "./evidence.js";
import type { Receipt, RunResult } from "./types.js";

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
  retryFailed?: boolean;
} = {}): Promise<FormalRunOutput> {
  const config = await loadEffectiveConfig(configPath);
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const baseRunId = `RUN-${dateInTimeZone(now)}-DAILY`;
  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  const retry = options.retryFailed ? state.retryContext(baseRunId, configDigest(config)) : null;
  const runId = retry?.runId ?? baseRunId;
  const isRecovery = Boolean(retry && runId !== baseRunId);
  const executionPlan = {
    runId,
    stages: FORMAL_STAGES,
    rules: config.policy.rules,
    provider: { id: config.provider.id, version: config.provider.version, model: config.provider.model, secretRef: config.provider.apiKey },
    provenance: config.provenance,
    sourceIds: config.preset.sources.map((source) => source.id),
    ...(isRecovery ? { parentRunId: retry!.parentRunId } : {}),
  };
  const begin = state.beginFormalRun(config, runId, startedAt, executionPlan, isRecovery ? retry!.parentRunId : undefined);
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
    state.recordStage(runId, name, ordinal, "running", startedAt);
    try {
      const value = await operation();
      timings[name] = Date.now() - started;
      state.recordStage(runId, name, ordinal, "complete", startedAt, { durationMs: timings[name] });
      return value;
    } catch (error) {
      timings[name] = Date.now() - started;
      const detail = sanitizeError(error);
      state.recordStage(runId, name, ordinal, "failed", startedAt, { durationMs: timings[name], detail });
      state.failFormalRun(runId, startedAt, name, detail);
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
      recorded.result.outcome = outcome;
      recorded.result.cadenceGovernance = evaluateCadence(config, state, now);
      state.updateRunResult(recorded.result);
      state.finalizeFormalRun(runId, outcome, startedAt);
      return { runId, outcome, resumed: true, alreadyComplete: false, dailyPath, reviewPath, result: recorded.result };
    }
    await stage("initialize", () => {
      if (config.policy.rules.length !== 7) throw new Error("Formal runs require all seven canonical rules");
      return { configDigest: configDigest(config), sourceCount: config.preset.sources.length };
    });
    const dueSelection = retry
      ? config.preset.sources.filter((source) => retry.forcedSourceIds.includes(source.id)).map((source) => ({ source, reason: `recovery-of-${retry.parentRunId}` }))
      : state.dueSources(config.preset.sources, now);
    await stage("freeze_due_manifest", () => {
      for (const entry of dueSelection) state.freezeDueSources(runId, [entry.source], entry.reason);
    });
    const existing = new Set(state.existingReceipts(runId).map((receipt) => receipt.sourceId));
    const dueIds = new Set(state.dueSourceIds(runId));
    const due = config.preset.sources.filter((source) => dueIds.has(source.id) && !existing.has(source.id));
    const discovered = await stage("discover", () => due.map((source) => ({ source, connector: connectorFor(source) })));
    const fetchClient = options.fetch ?? createHttpClient({
      timeoutSeconds: config.runtime.timeoutSeconds,
      retries: config.runtime.retries,
      allowedHosts: allowedHosts(config),
    });
    const sourceResults = await stage("capture", () => mapBounded(discovered, config.runtime.httpConcurrency, async ({ source, connector }) => {
      const previousCursor = state.sourceCursor(source.id);
      let connectorCursor: Record<string, unknown> = {};
      const context: ConnectorContext = {
        fetch: fetchClient,
        now: () => now,
        cursor: previousCursor,
        setCursor: (value) => { connectorCursor = value; },
      };
      try {
        const captures = await connector.capture(source, context);
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
        state.recordSourceResult(runId, result.receipt, result.captures, result.cursor, startedAt);
      }
    });
    await stage("normalize", () => ({ currentRunCaptures: state.runCaptures(runId).length }));
    const analysisTargets = state.pendingAnalysisWork(config.runtime.maximumCapturesPerRun);
    const deferredAnalysis = state.pendingAnalysisBacklog(analysisTargets.map((target) => target.capture));
    const provider = options.provider ?? new QwenProvider();
    const providerContext = { interests: config.interests, domains: config.policy.domains, prompt: config.prompts, provider: config.provider, projectRoot: config.projectRoot };
    const modelFailures: NonNullable<RunResult["modelFailures"]> = [];
    for (const deferred of deferredAnalysis) {
      modelFailures.push({
        captureId: `DEFERRED-${createHash("sha256").update(deferred.sourceId).digest("hex").slice(0, 12)}`,
        sourceId: deferred.sourceId,
        detail: `${deferred.count} pending capture${deferred.count === 1 ? "" : "s"} deferred by runtime.maximumCapturesPerRun`,
      });
    }
    const verified = await stage("verify_evidence", () => mapBounded(analysisTargets, config.runtime.modelConcurrency, async ({ capture, analysis: cached }) => {
      try {
        const analysis = cached
          ? validateModelAnalysis(cached, config.prompts, config.policy.domains)
          : await provider.analyze(capture, providerContext);
        verifyAnalysisEvidence(capture, analysis);
        state.recordAnalysisAttempt(runId, capture, "success", cached ? "Reused frozen validated analysis" : undefined, analysis, startedAt);
        return { capture, analysis };
      } catch (error) {
        const detail = sanitizeError(error);
        state.recordAnalysisAttempt(runId, capture, "failed", detail, undefined, startedAt);
        modelFailures.push({ captureId: createHash("sha256").update(capture.contentHash).digest("hex").slice(0, 16), sourceId: capture.sourceId, detail });
        return null;
      }
    }));
    const unique = await stage("deduplicate", () => {
      const groups = new Map<string, Array<NonNullable<(typeof verified)[number]>>>();
      for (const item of verified.filter((entry): entry is NonNullable<typeof entry> => entry !== null)) {
        const key = `${item.capture.canonicalUrl}\n${item.capture.externalKey}\n${item.capture.contentHash}`;
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
      return [...groups.values()].flatMap((members) => {
        const sorted = [...members].sort((left, right) => left.capture.sourceId.localeCompare(right.capture.sourceId));
        const winner = sorted[0]!;
        const existingWinner = state.existingCaptureForItem(`AI-${canonicalItemIdentity(winner.capture).slice(0, 12).toUpperCase()}`);
        if (existingWinner) {
          state.recordDuplicateCluster(runId, [existingWinner, ...sorted.map((item) => item.capture)], existingWinner, startedAt);
          return [];
        }
        if (sorted.length > 1) state.recordDuplicateCluster(runId, sorted.map((item) => item.capture), winner.capture, startedAt);
        return [winner];
      });
    });
    const candidates = await stage("score", () => unique.map(({ capture, analysis }) => buildCandidate(config, capture, analysis)));
    const selected = await stage("select", () => selectCandidates(config, candidates));
    const receipts = state.existingReceipts(runId);
    const counts = countReceipts(state.dueSourceIds(runId), receipts);
    const baseOutcome = runOutcome(counts);
    const outcome: FormalRunOutput["outcome"] = baseOutcome === "failed" ? "failed" : baseOutcome === "partial" || modelFailures.length ? "partial" : "success";
    const result: RunResult = {
      runId, generatedAt: startedAt, mode: "live", runKind: isRecovery ? "formal-retry" : "formal", configDigest: configDigest(config), receipts,
      daily: selected.daily, review: selected.review, machineOnly: selected.machineOnly, ruleIds: config.policy.rules.map((rule) => rule.id), modelFailures, stageTimings: timings, outcome,
    };
    const day = `${runId.slice(4, 8)}-${runId.slice(8, 10)}-${runId.slice(10, 12)}`;
    const retrySuffix = /(-R\d+)$/.exec(runId)?.[1] ?? "";
    const dailyPath = path.join(config.output.directory, "Daily", `${day}-AI-intelligence${retrySuffix}.md`);
    const reviewPath = path.join(config.output.directory, "Review", `${day}-AI-intelligence-review${retrySuffix}.md`);
    const dailyIndexPath = path.join(config.output.directory, "Daily", "index.md");
    const reviewIndexPath = path.join(config.output.directory, "Review", "index.md");
    result.artifactStageTimings = { ...timings };
    const published = await stage("publish", async () => ({
      daily: renderFormalDaily(config, result),
      review: renderFormalReview(config, result),
      dailyIndex: updateBriefingIndex(await optionalText(config.projectRoot, dailyIndexPath), `${config.name} · Daily index`, path.basename(dailyPath)),
      reviewIndex: updateBriefingIndex(await optionalText(config.projectRoot, reviewIndexPath), `${config.name} · Review index`, path.basename(reviewPath)),
    }));
    await stage("persist", () => writeArtifactSetAtomic(config.projectRoot, [
      { path: dailyPath, content: published.daily }, { path: reviewPath, content: published.review },
      { path: dailyIndexPath, content: published.dailyIndex }, { path: reviewIndexPath, content: published.reviewIndex },
    ], () => state.finishFormalRun(config, result, [...selected.daily, ...selected.review, ...selected.machineOnly], [
        { kind: "daily-markdown", path: dailyPath, contentHash: createHash("sha256").update(published.daily).digest("hex") },
        { kind: "review-markdown", path: reviewPath, contentHash: createHash("sha256").update(published.review).digest("hex") },
      ], outcome)));
    await stage("validate_integrity", () => countReceipts(state.dueSourceIds(runId), state.existingReceipts(runId)));
    result.integrityValidated = true;
    await stage("complete", () => undefined);
    const cadence = evaluateCadence(config, state, now);
    result.cadenceGovernance = cadence;
    state.appendEvent(runId, startedAt, "complete", "cadence.evaluated", "run", runId, `${runId}:cadence`, cadence);
    state.updateRunResult(result);
    state.finalizeFormalRun(runId, outcome, startedAt);
    return { runId, outcome, resumed: begin === "resumed", alreadyComplete: false, dailyPath, reviewPath, result };
  } finally {
    state.close();
  }
}
