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
import { loadExternalCaptureBundle, type ValidatedExternalCapture } from "../connectors/external-bundle.js";
import { renderFormalDaily, renderFormalReview, validateFormalArtifact } from "../outputs/formal-markdown.js";
import { writeArtifactSetAtomic } from "../outputs/write.js";
import { updateBriefingIndex, validateBriefingIndex } from "../outputs/index.js";
import { providerFor } from "../providers/registry.js";
import type { ModelProvider } from "../providers/types.js";
import { validateModelAnalysis } from "../providers/validate.js";
import { SqliteStateStore } from "../state/sqlite.js";
import { countReceipts, runOutcome } from "./accounting.js";
import { buildCandidate, canonicalItemIdentity, selectCandidates } from "./selection.js";
import { evaluateCadence } from "./cadence.js";
import { verifyAnalysisEvidence } from "./evidence.js";
import type { Receipt, RunResult } from "./types.js";
import { hydrateControlPlaneContext, syncToControlPlane } from "../control-plane/registry.js";
import type { LarkRunner } from "../control-plane/lark-cli.js";
import type { SyncResult } from "../control-plane/types.js";

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
  captures = captures.filter((capture) => capture.fetchStatus !== "failed" && capture.extractStatus !== "failed");
  const previous = cursor.items && typeof cursor.items === "object" ? cursor.items as Record<string, string> : {};
  const nextItems = Object.fromEntries(captures.map((capture) => [capture.externalKey, capture.contentHash]));
  return {
    changed: captures.filter((capture) => previous[capture.externalKey] !== capture.contentHash),
    next: { ...cursor, items: nextItems },
  };
}

function captureMemoryKey(capture: CaptureEnvelope): string {
  return `${capture.sourceId}\n${capture.externalKey}\n${capture.contentHash}`;
}

function sourceDiscoveryUrl(source: EffectiveConfig["preset"]["sources"][number]): string {
  if (source.connector.type === "github-releases") return `https://api.github.com/repos/${source.connector.config.repository}/releases`;
  if (source.connector.type === "x-api") return `https://x.com/${source.connector.config.username}`;
  if (source.connector.type === "codex-browser") return `https://x.com/${source.connector.config.username}`;
  if (source.connector.type === "rss" || source.connector.type === "webpage") return source.connector.config.url;
  const configured = source.connector.config.options.url;
  return typeof configured === "string" ? configured : `https://invalid.local/source/${encodeURIComponent(source.id)}`;
}

function failedCapture(
  source: EffectiveConfig["preset"]["sources"][number],
  parserVersion: string,
  error: unknown,
  runId: string,
  now: Date,
  attempts: number,
): CaptureEnvelope {
  const failureReason = sanitizeError(error);
  const status = /HTTP\s+(\d{3})/i.exec(failureReason)?.[1];
  const discoveryUrl = sourceDiscoveryUrl(source);
  return {
    sourceId: source.id,
    externalKey: `failure:${runId}`,
    canonicalUrl: discoveryUrl,
    title: source.title,
    summary: "",
    capturedAt: now.toISOString(),
    contentHash: createHash("sha256").update(`${runId}\n${source.id}\n${failureReason}`).digest("hex"),
    evidenceClass: "secondary",
    discoveryUrl,
    discoveryChannel: source.connector.type,
    fetchStatus: "failed",
    extractStatus: "not-attempted",
    ...(status ? { httpStatus: Number(status) } : {}),
    attempts,
    parserVersion,
    failureReason,
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

function sourceLane(source: EffectiveConfig["preset"]["sources"][number]): "github" | "x" | "papers-regulation" | "china" | "web-docs" {
  if (source.connector.type === "github-releases") return "github";
  if (source.connector.type === "x-api") return "x";
  if (source.sourceType === "paper" || source.sourceType === "regulation") return "papers-regulation";
  const url = "url" in source.connector.config ? source.connector.config.url : "";
  if (/\.(cn|com\.cn)(?:\/|$)/i.test(new URL(url || "https://invalid.local").hostname) || /qwen|alibaba|baidu|tencent|bytedance|paddle/i.test(`${source.id} ${source.title}`)) return "china";
  return "web-docs";
}

async function mapSourceLanes<T extends { source: EffectiveConfig["preset"]["sources"][number] }, R>(
  values: T[], globalLimit: number, worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const laneLimits = { github: 8, x: 1, "papers-regulation": 6, china: 6, "web-docs": 12 } as const;
  let active = 0; const waiting: Array<() => void> = [];
  const withGlobalPermit = async (operation: () => Promise<R>): Promise<R> => {
    if (active >= globalLimit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try { return await operation(); } finally { active -= 1; waiting.shift()?.(); }
  };
  const groups = new Map<keyof typeof laneLimits, T[]>();
  for (const value of values) { const lane = sourceLane(value.source); groups.set(lane, [...(groups.get(lane) ?? []), value]); }
  const completed = await Promise.all([...groups].map(async ([lane, entries]) => mapBounded(entries, laneLimits[lane], (entry) => withGlobalPermit(() => worker(entry)))));
  return completed.flat();
}

export interface FormalRunOutput {
  runId: string;
  outcome: "success" | "partial" | "failed";
  resumed: boolean;
  alreadyComplete: boolean;
  remoteExisting?: boolean;
  dailyPath: string;
  reviewPath: string;
  result: RunResult;
}

export async function runFormalProject(configPath: string, options: {
  now?: Date;
  provider?: ModelProvider;
  fetch?: ConnectorContext["fetch"];
  retryFailed?: boolean;
  larkRunner?: LarkRunner;
  captureBundlePath?: string;
} = {}): Promise<FormalRunOutput> {
  const loadedConfig = await loadEffectiveConfig(configPath);
  const controlContext = await hydrateControlPlaneContext(loadedConfig, { ...(options.larkRunner ? { larkRunner: options.larkRunner } : {}), mode: "full" });
  const config = controlContext.config;
  const now = options.now ?? new Date();
  const externalCaptures = options.captureBundlePath ? await loadExternalCaptureBundle(config, options.captureBundlePath, now) : new Map<string, ValidatedExternalCapture>();
  const startedAt = now.toISOString();
  const baseRunId = `RUN-${dateInTimeZone(now)}-DAILY`;
  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  let ownedFetchClient: ReturnType<typeof createHttpClient> | undefined;
  state.importControlFeedback(controlContext.snapshot.feedback);
  const remoteRun = !options.retryFailed && !state.runRecord(baseRunId)
    ? controlContext.snapshot.records.find((record) => record.kind === "runs" && record.id === baseRunId)
    : undefined;
  if (remoteRun) {
    const status = String(remoteRun.payload.status);
    if (!(["success", "partial", "failed"] as const).includes(status as "success" | "partial" | "failed")) {
      state.close();
      throw new Error(`Remote run ${baseRunId} exists in non-terminal state '${status}'; refusing a concurrent local run`);
    }
    const day = `${baseRunId.slice(4, 8)}-${baseRunId.slice(8, 10)}-${baseRunId.slice(10, 12)}`;
    const dailyPath = path.join(config.output.directory, "Daily", `${day}-AI情报简报.md`);
    const reviewPath = path.join(config.output.directory, "Review", `${day}-AI情报待复核.md`);
    const [dailyText, reviewText] = await Promise.all([readFile(dailyPath, "utf8"), readFile(reviewPath, "utf8")]);
    if (!dailyText.includes(`run_id: ${baseRunId}`) || !reviewText.includes(`run_id: ${baseRunId}`)) {
      state.close();
      throw new Error(`Remote run ${baseRunId} exists but its Daily/Review artifacts are missing or bound to another run`);
    }
    const recordsForRun = (kind: "receipts" | "items" | "captures") => controlContext.snapshot.records.filter((record) =>
      record.kind === kind && (record.payload.run_id === baseRunId || record.links?.runs?.includes(baseRunId)));
    const receipts: Receipt[] = recordsForRun("receipts").map((record) => {
      const raw = String(record.payload.result);
      const result = (["observed", "updated", "unchanged", "failed", "skipped"] as const).includes(raw as Receipt["result"])
        ? raw as Receipt["result"] : "failed";
      return { sourceId: String(record.payload.source_id ?? record.links?.sources?.[0] ?? record.id), result,
        ...(typeof record.payload.detail === "string" ? { detail: record.payload.detail } : {}) };
    });
    const items = recordsForRun("items").map((record) => {
      let analysis: Record<string, unknown> = {};
      try { analysis = JSON.parse(String(record.payload.analysis_json ?? "{}")) as Record<string, unknown>; } catch { /* bounded remote fallback */ }
      const evidenceStatus = String(record.payload.evidence_status ?? "unverified") as NonNullable<RunResult["daily"][number]["evidenceStatus"]>;
      return {
        id: String(record.payload.item_id ?? record.id), sourceId: String(record.links?.sources?.[0] ?? "remote"),
        title: String(record.payload.title ?? record.id), summary: String(record.payload.summary ?? ""),
        whyItMatters: String(record.payload.why_it_matters ?? ""), url: String(analysis.url ?? "https://invalid.local/imported"),
        evidence: evidenceStatus === "confirmed-primary" ? "primary" as const : "secondary" as const,
        evidenceStatus, score: Number(record.payload.score ?? 0), domain: String(record.payload.domain ?? ""),
        disposition: String(record.payload.disposition ?? "machine-only") as "daily" | "review" | "machine-only",
      };
    });
    const daily = items.filter((item) => item.disposition === "daily");
    const review = items.filter((item) => item.disposition === "review");
    const machineOnly = items.filter((item) => item.disposition === "machine-only");
    const counts = countReceipts(receipts.map((receipt) => receipt.sourceId), receipts);
    const result: RunResult = {
      runId: baseRunId, generatedAt: String(remoteRun.payload.generated_at ?? remoteRun.payload.started_at ?? now.toISOString()),
      mode: "live", runKind: "formal", configDigest: String(remoteRun.payload.config_digest ?? "remote"), receipts,
      dueSourceIds: receipts.map((receipt) => receipt.sourceId), daily, review, machineOnly, outcome: status as FormalRunOutput["outcome"],
      ruleIds: config.policy.rules.map((rule) => rule.id), integrityValidated: true, artifactPaths: { daily: dailyPath, review: reviewPath },
      completionReport: {
        due: counts.due, receipts: receipts.length, updated: counts.updated, unchanged: counts.unchanged, failed: counts.failed,
        skipped: counts.skipped, missing: counts.missing, missingSourceIds: [], discovered: recordsForRun("captures").length,
        captured: recordsForRun("captures").length, verified: items.length, deduplicated: items.length, scored: items.length,
        daily: daily.length, review: review.length, eliminated: machineOnly.length, errors: counts.failed,
        domainCounts: Object.fromEntries(config.policy.domains.map((domain) => [domain, items.filter((item) => item.domain === domain).length])),
        topItemIds: [...daily, ...review].sort((a, b) => b.score - a.score).slice(0, 3).map((item) => item.id),
        ruleContractValid: true, processStoreValid: true, documentStoreValid: true,
      },
    };
    state.close();
    return { runId: baseRunId, outcome: status as FormalRunOutput["outcome"], resumed: false, alreadyComplete: true, remoteExisting: true, dailyPath, reviewPath, result };
  }
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
      if (config.protocol.stages.join("\n") !== FORMAL_STAGES.join("\n")) throw new Error("Packaged execution contract does not match the runtime stage machine");
      if (!new RegExp(config.protocol.runIdPattern).test(runId)) throw new Error(`Run ID ${runId} violates the execution contract`);
      return { configDigest: configDigest(config), sourceCount: config.preset.sources.length };
    });
    const dueSelection = retry
      ? config.preset.sources.filter((source) => retry.forcedSourceIds.includes(source.id)).map((source) => ({ source, reason: `recovery-of-${retry.parentRunId}` }))
      : state.dueSources(config.preset.sources, now, config.policy.domains);
    await stage("freeze_due_manifest", () => {
      for (const entry of dueSelection) state.freezeDueSources(runId, [entry.source], entry.reason);
    });
    const existing = new Set(state.existingReceipts(runId).map((receipt) => receipt.sourceId));
    const dueIds = new Set(state.dueSourceIds(runId));
    const due = config.preset.sources.filter((source) => dueIds.has(source.id) && !existing.has(source.id));
    const discovered = await stage("discover", () => due.map((source) => ({ source, connector: connectorFor(source) })));
    const fetchClient = options.fetch ?? (ownedFetchClient = createHttpClient({
      timeoutSeconds: config.runtime.timeoutSeconds,
      retries: config.runtime.retries,
      allowedHosts: allowedHosts(config),
    }));
    const sourceResults = await stage("capture", () => mapSourceLanes(discovered, config.runtime.httpConcurrency, async ({ source, connector }) => {
      const sourceStarted = Date.now();
      const previousCursor = state.sourceCursor(source.id);
      let connectorCursor: Record<string, unknown> = {};
      const context: ConnectorContext = {
        fetch: fetchClient,
        now: () => now,
        cursor: previousCursor,
        setCursor: (value) => { connectorCursor = value; },
        projectRoot: config.projectRoot,
      };
      try {
        if (source.connector.type === "codex-browser") {
          const supplied = externalCaptures.get(source.id);
          if (!supplied) throw new Error(`Validated browser capture bundle has no entry for ${source.id}`);
          if (supplied.status === "failed") throw new Error(supplied.detail ?? `Browser capture failed for ${source.id}`);
          const change = changedCaptures(supplied.captures, previousCursor);
          return { source, captures: supplied.captures, changed: change.changed, cursor: change.next, receipt: { sourceId: source.id,
            result: change.changed.length ? "updated" as const : "unchanged" as const,
            detail: supplied.detail ?? `${supplied.captures.length} browser captures; ${change.changed.length} new or changed`, durationMs: Date.now() - sourceStarted } };
        }
        const captures = await connector.capture(source, context);
        const notModified = connectorCursor.notModified === true;
        const change = notModified ? { changed: [] as CaptureEnvelope[], next: previousCursor } : changedCaptures(captures, previousCursor);
        const { notModified: _notModified, ...durableConnectorCursor } = connectorCursor;
        const receipt: Receipt = {
          sourceId: source.id,
          result: change.changed.length ? "updated" : "unchanged",
          detail: `${captures.length} captured; ${change.changed.length} new or changed`,
          durationMs: Date.now() - sourceStarted,
        };
        return { source, captures, changed: change.changed, cursor: { ...change.next, ...durableConnectorCursor }, receipt };
      } catch (error) {
        return { source, captures: [failedCapture(source, connector.descriptor.version, error, runId, now, config.runtime.retries + 1)], changed: [] as CaptureEnvelope[], cursor: previousCursor, receipt: { sourceId: source.id, result: "failed" as const, detail: sanitizeError(error), durationMs: Date.now() - sourceStarted } };
      }
    }));
    await stage("write_receipts", () => {
      for (const result of sourceResults.sort((a, b) => a.source.id.localeCompare(b.source.id))) {
        state.recordSourceResult(runId, result.receipt, result.captures, result.cursor, startedAt);
      }
    });
    await stage("normalize", () => ({ currentRunCaptures: state.runCaptures(runId).length }));
    const transientEvidence = new Map(sourceResults.flatMap((result) => result.captures.flatMap((capture) => capture.analysisText ? [[captureMemoryKey(capture), capture.analysisText] as const] : [])));
    const analysisTargets = state.pendingAnalysisWork(config.runtime.maximumCapturesPerRun).map((target) => {
      const analysisText = transientEvidence.get(captureMemoryKey(target.capture));
      return analysisText ? { ...target, capture: { ...target.capture, analysisText } } : target;
    });
    const deferredAnalysis = state.pendingAnalysisBacklog(analysisTargets.map((target) => target.capture));
    const provider = options.provider ?? providerFor(config.provider);
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
      const modelStarted = Date.now(); let usage: { inputTokens?: number | undefined; outputTokens?: number | undefined; totalTokens?: number | undefined; costUsd?: number | undefined } = {};
      try {
        const analysis = validateModelAnalysis(cached ?? await provider.analyze(capture, { ...providerContext, observeUsage: (value) => { usage = value; } }), config.prompts, config.policy.domains);
        verifyAnalysisEvidence(capture, analysis);
        state.recordAnalysisAttempt(runId, capture, "success", cached ? "Reused frozen validated analysis" : undefined, analysis, startedAt,
          { durationMs: Date.now() - modelStarted, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd });
        return { capture, analysis };
      } catch (error) {
        const detail = sanitizeError(error);
        state.recordAnalysisAttempt(runId, capture, "failed", detail, undefined, startedAt, { durationMs: Date.now() - modelStarted,
          inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd });
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
      dueSourceIds: state.dueSourceIds(runId),
      daily: selected.daily, review: selected.review, machineOnly: selected.machineOnly, ruleIds: config.policy.rules.map((rule) => rule.id), modelFailures, stageTimings: timings, outcome,
    };
    const day = `${runId.slice(4, 8)}-${runId.slice(8, 10)}-${runId.slice(10, 12)}`;
    const retrySuffix = /(-R\d+)$/.exec(runId)?.[1] ?? "";
    const dailyPath = path.join(config.output.directory, "Daily", `${day}-AI情报简报${retrySuffix}.md`);
    const reviewPath = path.join(config.output.directory, "Review", `${day}-AI情报待复核${retrySuffix}.md`);
    const dailyIndexPath = path.join(config.output.directory, "Note-AI情报候选池.md");
    const reviewIndexPath = path.join(config.output.directory, "Note-AI情报待复核.md");
    result.artifactPaths = { daily: dailyPath, review: reviewPath };
    result.artifactStageTimings = { ...timings };
    const published = await stage("publish", async () => ({
      daily: renderFormalDaily(config, result),
      review: renderFormalReview(config, result),
      dailyIndex: updateBriefingIndex(await optionalText(config.documents.root, dailyIndexPath), `${config.name} · 候选池`, path.relative(config.output.directory, dailyPath), "ai-intelligence-digest"),
      reviewIndex: updateBriefingIndex(await optionalText(config.documents.root, reviewIndexPath), `${config.name} · 待复核`, path.relative(config.output.directory, reviewPath), "ai-intelligence-review"),
    }));
    validateBriefingIndex(published.dailyIndex, path.relative(config.output.directory, dailyPath), "ai-intelligence-digest");
    validateBriefingIndex(published.reviewIndex, path.relative(config.output.directory, reviewPath), "ai-intelligence-review");
    await stage("persist", () => writeArtifactSetAtomic(config.documents.root, [
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
    const improvement = state.diagnoseImprovementsIfDue(now, 30, 7, config.policy.domains);
    result.improvementGovernance = improvement;
    state.appendEvent(runId, startedAt, "complete", improvement.evaluated ? "improvement.diagnosed" : "improvement.not-due", "run", runId, `${runId}:improvement`, improvement);
    const recordsForSync = (status: FormalRunOutput["outcome"]) => state.controlRecords(config, runId).map((record) => record.kind === "runs" && record.id === runId
      ? { ...record, payload: { ...record.payload, status, current_stage: "complete", completed_at: startedAt, result_json: JSON.stringify(result) } }
      : record);
    const performSync = async (status: FormalRunOutput["outcome"]): Promise<SyncResult> => {
      try { return await syncToControlPlane(config, recordsForSync(status), options.larkRunner ? { larkRunner: options.larkRunner } : {}); }
      catch (error) { return { driver: config.controlPlane.driver, created: 0, updated: 0, unchanged: 0,
        failed: [{ kind: "runs", id: runId, detail: sanitizeError(error) }], digest: createHash("sha256").update(`${runId}\n${config.provenance.controlPlaneRevision ?? "local"}`).digest("hex") }; }
    };
    const sync = await performSync(outcome);
    result.controlPlaneSync = sync;
    let reconciliation: RunResult["controlPlaneReconciliation"];
    if (sync.failed.length) {
      result.outcome = "partial";
      state.appendEvent(runId, startedAt, "persist", "control-plane.partial", "run", runId, `${runId}:control-plane:${sync.digest}`, { failed: sync.failed });
      reconciliation = await performSync("partial");
      result.controlPlaneReconciliation = reconciliation;
      state.appendEvent(runId, startedAt, "persist", reconciliation.failed.length ? "control-plane.reconcile-failed" : "control-plane.reconciled", "run", runId,
        `${runId}:control-plane-reconcile:${reconciliation.digest}`, { failed: reconciliation.failed });
    }
    const finalCounts = countReceipts(state.dueSourceIds(runId), state.existingReceipts(runId));
    const selectedItems = [...result.daily, ...result.review];
    const processStoreValid = sync.failed.length === 0 || Boolean(reconciliation && reconciliation.failed.length === 0);
    const sourceLatencies = result.receipts.map((receipt) => receipt.durationMs ?? 0).sort((a, b) => a - b);
    const percentile = (value: number) => sourceLatencies.length ? sourceLatencies[Math.min(sourceLatencies.length - 1, Math.ceil(sourceLatencies.length * value) - 1)]! : 0;
    const captureSeconds = Math.max((timings.capture ?? 0) / 1000, 0.001);
    result.completionReport = {
      due: finalCounts.due, receipts: result.receipts.length, updated: finalCounts.updated, unchanged: finalCounts.unchanged, failed: finalCounts.failed,
      skipped: finalCounts.skipped, missing: finalCounts.missing, missingSourceIds: state.dueSourceIds(runId).filter((id) => !result.receipts.some((receipt) => receipt.sourceId === id)),
      discovered: sourceResults.reduce((sum, entry) => sum + entry.captures.filter((capture) => capture.fetchStatus !== "failed").length, 0), captured: state.runCaptures(runId).length,
      verified: verified.filter(Boolean).length, deduplicated: unique.length, scored: candidates.length, daily: result.daily.length, review: result.review.length,
      eliminated: result.machineOnly?.length ?? 0, errors: finalCounts.failed + modelFailures.length + sync.failed.length + (reconciliation?.failed.length ?? 0),
      domainCounts: Object.fromEntries(config.policy.domains.map((domain) => [domain, selectedItems.filter((entry) => entry.domain === domain).length])),
      topItemIds: [...selectedItems].sort((a, b) => b.score - a.score).slice(0, 3).map((entry) => entry.id),
      ruleContractValid: config.policy.rules.length === 7, processStoreValid, documentStoreValid: true,
      performance: { sourceLatencyP50Ms: percentile(0.5), sourceLatencyP95Ms: percentile(0.95), captureThroughputPerSecond: Number((state.runCaptures(runId).length / captureSeconds).toFixed(2)) },
    };
    const finalOutcome = result.outcome ?? outcome;
    result.stageTimings = { ...timings };
    result.artifactStageTimings = { ...timings };
    const finalDaily = renderFormalDaily(config, result);
    const finalReview = renderFormalReview(config, result);
    validateFormalArtifact(config, result, "daily", finalDaily);
    validateFormalArtifact(config, result, "review", finalReview);
    await writeArtifactSetAtomic(config.documents.root, [
      { path: dailyPath, content: finalDaily }, { path: reviewPath, content: finalReview },
    ], () => state.commitFinalArtifacts(result, [
      { kind: "daily-markdown", contentHash: createHash("sha256").update(finalDaily).digest("hex") },
      { kind: "review-markdown", contentHash: createHash("sha256").update(finalReview).digest("hex") },
    ], finalOutcome, startedAt));
    const [writtenDaily, writtenReview, writtenDailyIndex, writtenReviewIndex] = await Promise.all([
      readFile(dailyPath, "utf8"), readFile(reviewPath, "utf8"), readFile(dailyIndexPath, "utf8"), readFile(reviewIndexPath, "utf8"),
    ]);
    if (writtenDaily !== finalDaily || writtenReview !== finalReview) throw new Error("Document-store readback did not match the finalized artifact bytes");
    if (writtenDailyIndex !== published.dailyIndex || writtenReviewIndex !== published.reviewIndex) throw new Error("Document-store index readback did not match the validated Wiki-link bytes");
    return { runId, outcome: finalOutcome, resumed: begin === "resumed", alreadyComplete: false, dailyPath, reviewPath, result };
  } finally {
    await ownedFetchClient?.close();
    state.close();
  }
}
