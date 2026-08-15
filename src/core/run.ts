import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { EffectiveConfig } from "../config/types.js";
import { canonicalJson, configDigest, EXECUTION_CONFIG_DIGEST_VERSION, loadEffectiveConfig } from "../config/load.js";
import { sanitizeError } from "../config/secrets.js";
import { prepareSafeFilePath } from "../config/paths.js";
import { allowedHostsForSource, createHttpClient } from "../connectors/http.js";
import { connectorFor } from "../connectors/registry.js";
import type { CaptureEnvelope, ConnectorContext } from "../connectors/types.js";
import { isExternalCaptureSource, loadExternalCaptureBundle, type ValidatedExternalCapture } from "../connectors/external-bundle.js";
import { canonicalRecoveryHost, recoverCanonicalEvidence } from "../connectors/recovery.js";
import { formalDocumentManifest, renderFormalDaily, renderFormalReview, validateFormalArtifact } from "../outputs/formal-markdown.js";
import { writeArtifactSetAtomic } from "../outputs/write.js";
import { updateBriefingIndex, validateBriefingIndex } from "../outputs/index.js";
import { providerFor } from "../providers/registry.js";
import type { ModelAnalysis, ModelProvider } from "../providers/types.js";
import { validateModelAnalysis } from "../providers/validate.js";
import { SqliteStateStore } from "../state/sqlite.js";
import { countReceipts, formalRunOutcome, runOutcome, type FormalRunOutcome } from "./accounting.js";
import { buildCandidate, canonicalEventIdentity, canonicalItemIdentity, selectCandidates } from "./selection.js";
import { evaluateCadence } from "./cadence.js";
import { durableAnalysis, persistVerifiedAnalysis, reuseVerifiedAnalysis, verifyAnalysisEvidence } from "./evidence.js";
import type { Receipt, RunResult } from "./types.js";
import { hydrateControlPlaneContext, reconciliationRecords, syncToControlPlane } from "../control-plane/registry.js";
import type { LarkRunner } from "../control-plane/lark-cli.js";
import type { CanonicalControlRecord, SyncResult } from "../control-plane/types.js";

export const FORMAL_STAGES = [
  "initialize", "freeze_due_manifest", "discover", "capture", "write_receipts", "normalize",
  "verify_evidence", "deduplicate", "score", "select", "publish", "persist", "validate_integrity", "complete",
] as const;

type FormalStage = typeof FORMAL_STAGES[number];

export function controlPlaneCommitRecords(records: CanonicalControlRecord[], runId: string): CanonicalControlRecord[] {
  const run = [...records].reverse().find((record) => record.kind === "runs" && record.id === runId);
  if (!run) throw new Error(`Control-plane commit is missing run ${runId}`);
  // Phase A can append control-plane audit events before phase B. Include those direct
  // dependencies so the published Run never points at an event that has not been synced.
  const eventIds = new Set(run.links?.events ?? []);
  const selected = records.filter((record) => (record.kind === "runs" && record.id === runId)
    || (record.kind === "events" && eventIds.has(record.id)));
  return [...new Map(selected.map((record) => [`${record.kind}\n${record.id}`, record])).values()];
}

function dateInTimeZone(now: Date, timeZone = "Asia/Shanghai"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function frozenDueManifestDigest(runId: string, dueSourceIds: string[]): string {
  return sha256(canonicalJson({ runId, dueSourceIds: [...dueSourceIds].sort() }));
}

function formalArtifactPaths(config: EffectiveConfig, runId: string): {
  dailyPath: string;
  reviewPath: string;
  dailyIndexPath: string;
  reviewIndexPath: string;
} {
  const day = `${runId.slice(4, 8)}-${runId.slice(8, 10)}-${runId.slice(10, 12)}`;
  const retrySuffix = /(-R\d+)$/.exec(runId)?.[1] ?? "";
  return {
    dailyPath: path.join(config.output.directory, "Daily", `${day}-AI情报简报${retrySuffix}.md`),
    reviewPath: path.join(config.output.directory, "Review", `${day}-AI情报待复核${retrySuffix}.md`),
    dailyIndexPath: path.join(config.output.directory, "Note-AI情报候选池.md"),
    reviewIndexPath: path.join(config.output.directory, "Note-AI情报待复核.md"),
  };
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
  if (source.connector.type === "in-app-browser") return source.connector.config.url;
  if (source.connector.type === "computer-use") return source.connector.config.url;
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
  if (source.connector.type === "x-api" || source.connector.type === "codex-browser") return "x";
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
  outcome: FormalRunOutcome;
  publicationState: "withheld" | "published";
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
  reverifyEvidence?: boolean;
  baseRunId?: string;
  larkRunner?: LarkRunner;
  captureBundlePath?: string;
} = {}): Promise<FormalRunOutput> {
  if (options.retryFailed && options.reverifyEvidence) throw new Error("--retry-failed and --reverify-evidence are mutually exclusive recovery modes");
  if (options.baseRunId && !options.retryFailed && !options.reverifyEvidence) throw new Error("An explicit base run is only valid with a recovery mode");
  if (options.baseRunId && !/^RUN-\d{8}-DAILY$/.test(options.baseRunId)) throw new Error(`Invalid recovery base run ID: ${options.baseRunId}`);
  const loadedConfig = await loadEffectiveConfig(configPath);
  let controlContext = await hydrateControlPlaneContext(loadedConfig, { ...(options.larkRunner ? { larkRunner: options.larkRunner } : {}), mode: "context" });
  const config = controlContext.config;
  const now = options.now ?? new Date();
  const runtimeStartedAt = Date.now();
  const occurredAt = () => new Date(now.getTime() + Math.max(0, Date.now() - runtimeStartedAt)).toISOString();
  const externalCaptures = options.captureBundlePath ? await loadExternalCaptureBundle(config, options.captureBundlePath, now) : new Map<string, ValidatedExternalCapture>();
  const startedAt = now.toISOString();
  const baseRunId = options.baseRunId ?? `RUN-${dateInTimeZone(now)}-DAILY`;
  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  let ownedFetchClient: ReturnType<typeof createHttpClient> | undefined;
  state.importControlFeedback(controlContext.snapshot.feedback);
  let remoteRun = !options.retryFailed && !options.reverifyEvidence && !state.runRecord(baseRunId)
    ? controlContext.snapshot.records.find((record) => record.kind === "runs" && record.id === baseRunId)
    : undefined;
  if (remoteRun) {
    controlContext = await hydrateControlPlaneContext(config, { ...(options.larkRunner ? { larkRunner: options.larkRunner } : {}), mode: "full" });
    remoteRun = controlContext.snapshot.records.find((record) => record.kind === "runs" && record.id === baseRunId);
    if (!remoteRun) { state.close(); throw new Error(`Remote run ${baseRunId} disappeared between context and adoption readback`); }
    const status = String(remoteRun.payload.status);
    if (!(["success", "partial", "empty", "failed"] as const).includes(status as FormalRunOutcome)) {
      state.close();
      throw new Error(`Remote run ${baseRunId} exists in non-terminal state '${status}'; refusing a concurrent local run`);
    }
    if (status === "failed" || remoteRun.payload.publication_state !== "published") {
      state.close();
      throw new Error(`Remote run ${baseRunId} is not a published terminal run; use an explicit recovery mode`);
    }
    const remoteDueSourceIds = [...new Set(remoteRun.links?.sources ?? [])].sort();
    const dueManifestDigest = frozenDueManifestDigest(baseRunId, remoteDueSourceIds);
    if (!remoteDueSourceIds.length || remoteRun.payload.due_source_count !== remoteDueSourceIds.length || remoteRun.payload.due_manifest_digest !== dueManifestDigest) {
      state.close();
      throw new Error(`Remote run ${baseRunId} does not contain an independently verifiable frozen due manifest`);
    }
    const day = `${baseRunId.slice(4, 8)}-${baseRunId.slice(8, 10)}-${baseRunId.slice(10, 12)}`;
    const dailyPath = path.join(config.output.directory, "Daily", `${day}-AI情报简报.md`);
    const reviewPath = path.join(config.output.directory, "Review", `${day}-AI情报待复核.md`);
    const [dailyText, reviewText] = await Promise.all([readFile(dailyPath, "utf8"), readFile(reviewPath, "utf8")]);
    if (!dailyText.includes(`run_id: ${baseRunId}`) || !reviewText.includes(`run_id: ${baseRunId}`)) {
      state.close();
      throw new Error(`Remote run ${baseRunId} exists but its Daily/Review artifacts are missing or bound to another run`);
    }
    const dailyArtifactDigest = sha256(dailyText); const reviewArtifactDigest = sha256(reviewText);
    const dailyReaderFormatV2 = /^reader_format_version:\s*2\s*$/m.test(dailyText);
    const reviewReaderFormatV2 = /^reader_format_version:\s*2\s*$/m.test(reviewText);
    if (dailyReaderFormatV2 !== reviewReaderFormatV2) {
      state.close();
      throw new Error(`Remote run ${baseRunId} Daily/Review reader format versions do not match`);
    }
    if (remoteRun.payload.daily_artifact_digest !== dailyArtifactDigest || remoteRun.payload.review_artifact_digest !== reviewArtifactDigest) {
      state.close();
      throw new Error(`Remote run ${baseRunId} artifact bytes do not match the committed remote digests`);
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
    const receiptSourceIds = receipts.map((receipt) => receipt.sourceId).sort();
    if (canonicalJson(receiptSourceIds) !== canonicalJson(remoteDueSourceIds)) {
      state.close();
      throw new Error(`Remote run ${baseRunId} receipts do not exactly cover its frozen due manifest`);
    }
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
      dueSourceIds: remoteDueSourceIds, daily, review, machineOnly, outcome: status as FormalRunOutput["outcome"], publicationState: "published",
      ...(dailyReaderFormatV2 ? { readerFormatVersion: 2 as const } : {}),
      integrityManifest: { dueSourceIds: remoteDueSourceIds, dueManifestDigest, dailyArtifactDigest, reviewArtifactDigest },
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
    return { runId: baseRunId, outcome: status as FormalRunOutput["outcome"], publicationState: "published", resumed: false, alreadyComplete: true, remoteExisting: true, dailyPath, reviewPath, result };
  }
  const retry = options.retryFailed ? state.retryContext(baseRunId, config) : null;
  const reverification = options.reverifyEvidence ? state.evidenceReverificationContext(baseRunId, config) : null;
  const recovery = retry ?? reverification;
  const runId = recovery?.runId ?? baseRunId;
  const isRecovery = Boolean(recovery && runId !== baseRunId);
  const retryControlRecords = isRecovery ? state.retryControlRecords(config, baseRunId) : [];
  const executionPlan = {
    runId,
    configDigestVersion: EXECUTION_CONFIG_DIGEST_VERSION,
    stages: FORMAL_STAGES,
    rules: config.policy.rules,
    provider: { id: config.provider.id, version: config.provider.version, model: config.provider.model, secretRef: config.provider.apiKey },
    provenance: config.provenance,
    sourceIds: config.preset.sources.map((source) => source.id),
    ...(retryControlRecords.length ? { controlPlaneRepairRecordCount: retryControlRecords.length } : {}),
    ...(isRecovery ? { parentRunId: recovery!.parentRunId } : {}),
    ...(reverification ? { evidenceReverification: true, evidenceReverificationTargetCount: state.evidenceReverificationTargets(baseRunId).length } : {}),
  };
  const resumableWithheld = options.retryFailed && retry?.resumed === true && state.runRecord(runId)?.status === "failed";
  const begin = resumableWithheld
    ? state.resumeWithheldControlPlaneRun(runId, startedAt)
    : state.beginFormalRun(config, runId, startedAt, executionPlan, isRecovery ? recovery!.parentRunId : undefined);
  const recorded = state.runRecord(runId);
  if (begin === "complete" && recorded?.result) {
    const artifacts = state.runArtifacts(runId);
    const dailyPath = artifacts.find((artifact) => artifact.kind === "daily-markdown")?.path;
    const reviewPath = artifacts.find((artifact) => artifact.kind === "review-markdown")?.path;
    const intendedPaths = formalArtifactPaths(config, runId);
    if (recorded.result.publicationState === "withheld" && recorded.status === "failed") {
      state.close();
      return { runId, outcome: "failed", publicationState: "withheld", resumed: false, alreadyComplete: true,
        dailyPath: intendedPaths.dailyPath, reviewPath: intendedPaths.reviewPath, result: recorded.result };
    }
    if (recorded.result.publicationState !== "published") {
      state.close();
      throw new Error(`Completed legacy run ${runId} has no verified publication state; use explicit repair or recovery`);
    }
    if (!dailyPath || !reviewPath || artifacts.length !== 2) { state.close(); throw new Error(`Published run ${runId} is missing required artifacts`); }
    const [dailyText, reviewText] = await Promise.all([readFile(dailyPath, "utf8"), readFile(reviewPath, "utf8")]);
    const dailyHash = artifacts.find((artifact) => artifact.kind === "daily-markdown")?.contentHash;
    const reviewHash = artifacts.find((artifact) => artifact.kind === "review-markdown")?.contentHash;
    state.close();
    if (sha256(dailyText) !== dailyHash || sha256(reviewText) !== reviewHash) throw new Error(`Published run ${runId} failed local artifact readback`);
    return { runId, outcome: recorded.status as FormalRunOutput["outcome"], publicationState: "published", resumed: false, alreadyComplete: true, dailyPath, reviewPath, result: recorded.result };
  }
  const timings: Record<string, number> = {};
  const stage = async <T>(name: FormalStage, operation: () => Promise<T> | T, terminalOnFailure = true): Promise<T> => {
    const started = Date.now();
    const ordinal = FORMAL_STAGES.indexOf(name);
    state.recordStage(runId, name, ordinal, "running", occurredAt());
    try {
      const value = await operation();
      timings[name] = Date.now() - started;
      state.recordStage(runId, name, ordinal, "complete", occurredAt(), { durationMs: timings[name] });
      return value;
    } catch (error) {
      timings[name] = Date.now() - started;
      const detail = sanitizeError(error);
      state.recordStage(runId, name, ordinal, "failed", occurredAt(), { durationMs: timings[name], detail });
      if (terminalOnFailure) state.failFormalRun(runId, occurredAt(), name, detail);
      throw error;
    }
  };

  const finalizeStagedRun = async (result: RunResult, resumed: boolean): Promise<FormalRunOutput> => {
    const { dailyPath, reviewPath, dailyIndexPath, reviewIndexPath } = formalArtifactPaths(config, runId);
    const finalCounts = countReceipts(state.dueSourceIds(runId), result.receipts);
    const selectedItems = [...result.daily, ...result.review];
    const receiptOutcome = runOutcome(finalCounts);
    const backlogCount = result.analysisBacklog?.reduce((sum, entry) => sum + entry.count, 0) ?? 0;
    const intendedOutcome = formalRunOutcome({
      receiptOutcome,
      modelFailureCount: (result.modelFailures?.length ?? 0) + backlogCount,
      selectedItemCount: selectedItems.length,
      processStoreValid: true,
    });
    result.outcome = intendedOutcome;
    result.publicationState = "withheld";
    result.artifactPaths = { daily: dailyPath, review: reviewPath };
    result.documentManifest ??= formalDocumentManifest(config, result);
    const dueSourceIds = state.dueSourceIds(runId);
    result.dueSourceIds = dueSourceIds;
    const stagedDaily = renderFormalDaily(config, result);
    const stagedReview = renderFormalReview(config, result);
    validateFormalArtifact(config, result, "daily", stagedDaily);
    validateFormalArtifact(config, result, "review", stagedReview);
    const integrityManifest: NonNullable<RunResult["integrityManifest"]> = {
      dueSourceIds,
      dueManifestDigest: frozenDueManifestDigest(runId, dueSourceIds),
      dailyArtifactDigest: sha256(stagedDaily),
      reviewArtifactDigest: sha256(stagedReview),
    };
    result.integrityManifest = integrityManifest;

    if (!result.cadenceGovernance) {
      const cadence = evaluateCadence(config, state, now);
      result.cadenceGovernance = cadence;
      state.appendEvent(runId, occurredAt(), "complete", "cadence.evaluated", "run", runId, `${runId}:cadence`, cadence);
    }
    if (!result.improvementGovernance) {
      const improvement = state.diagnoseImprovementsIfDue(now, 30, 7, config.policy.domains);
      result.improvementGovernance = improvement;
      state.appendEvent(runId, occurredAt(), "complete", improvement.evaluated ? "improvement.diagnosed" : "improvement.not-due", "run", runId,
        `${runId}:improvement`, improvement);
    }
    state.updateRunResult(result);

    const recordsForSync = (status: FormalRunOutcome) => [...state.controlRecords(config, runId).map((record) => record.kind === "runs" && record.id === runId
      ? { ...record, payload: { ...record.payload, status, current_stage: "complete", completed_at: occurredAt(), result_json: JSON.stringify(result) } }
      : record), ...retryControlRecords];
    const initialSyncRecords = recordsForSync(intendedOutcome);
    const performSync = async (records: CanonicalControlRecord[]): Promise<SyncResult> => {
      try { return await syncToControlPlane(config, records, options.larkRunner ? { larkRunner: options.larkRunner } : {}); }
      catch (error) { return { driver: config.controlPlane.driver, created: 0, updated: 0, unchanged: 0,
        failed: [{ kind: "runs", id: runId, detail: sanitizeError(error) }], digest: createHash("sha256").update(`${runId}\n${config.provenance.controlPlaneRevision ?? "local"}`).digest("hex"), acknowledged: false }; }
    };

    const { processStoreValid, sync, reconciliation } = await stage("validate_integrity", async () => {
      const sync = await performSync(initialSyncRecords);
      result.controlPlaneSync = sync;
      let reconciliation: RunResult["controlPlaneReconciliation"];
      if (sync.failed.length) {
        result.publicationState = "withheld";
        state.appendEvent(runId, occurredAt(), "persist", "control-plane.partial", "run", runId, `${runId}:control-plane:${sync.digest}`, { failed: sync.failed });
        const retryRecords = reconciliationRecords(recordsForSync("failed"), initialSyncRecords, sync.failed);
        reconciliation = await performSync(retryRecords);
        result.controlPlaneReconciliation = reconciliation;
        state.appendEvent(runId, occurredAt(), "persist", reconciliation.failed.length ? "control-plane.reconcile-failed" : "control-plane.reconciled", "run", runId,
          `${runId}:control-plane-reconcile:${reconciliation.digest}`, { failed: reconciliation.failed });
      }
      return { sync, reconciliation, processStoreValid: sync.acknowledged || Boolean(reconciliation?.acknowledged) };
    }, false);

    const finalOutcome = formalRunOutcome({
      receiptOutcome,
      modelFailureCount: (result.modelFailures?.length ?? 0) + backlogCount,
      selectedItemCount: selectedItems.length,
      processStoreValid,
    });
    result.outcome = finalOutcome;
    const existingReport = result.completionReport;
    result.completionReport = existingReport
      ? { ...existingReport, errors: finalCounts.failed + (result.modelFailures?.length ?? 0) + backlogCount + sync.failed.length + (reconciliation?.failed.length ?? 0), processStoreValid, documentStoreValid: false }
      : {
        due: finalCounts.due, receipts: result.receipts.length, updated: finalCounts.updated, unchanged: finalCounts.unchanged, failed: finalCounts.failed,
        skipped: finalCounts.skipped, missing: finalCounts.missing, missingSourceIds: state.dueSourceIds(runId).filter((id) => !result.receipts.some((receipt) => receipt.sourceId === id)),
        discovered: state.runCaptures(runId).filter((capture) => capture.fetchStatus !== "failed").length, captured: state.runCaptures(runId).length,
        verified: selectedItems.length + (result.machineOnly?.length ?? 0), deduplicated: selectedItems.length + (result.machineOnly?.length ?? 0),
        scored: selectedItems.length + (result.machineOnly?.length ?? 0), daily: result.daily.length, review: result.review.length,
        eliminated: result.machineOnly?.length ?? 0, errors: finalCounts.failed + (result.modelFailures?.length ?? 0) + backlogCount + sync.failed.length + (reconciliation?.failed.length ?? 0),
        domainCounts: Object.fromEntries(config.policy.domains.map((domain) => [domain, selectedItems.filter((entry) => entry.domain === domain).length])),
        topItemIds: [...selectedItems].sort((a, b) => b.score - a.score).slice(0, 3).map((entry) => entry.id),
        ruleContractValid: config.policy.rules.length === 7, processStoreValid, documentStoreValid: false,
      };

    if (!processStoreValid || finalOutcome === "failed") {
      result.publicationState = "withheld";
      result.completionReport.documentStoreValid = false;
      state.updateRunResult(result);
      await stage("complete", () => undefined);
      state.finalizeWithheldRun(result, "failed", occurredAt());
      return { runId, outcome: "failed", publicationState: "withheld", resumed, alreadyComplete: false, dailyPath, reviewPath, result };
    }

    result.publicationState = "published";
    result.completionReport.documentStoreValid = false;
    state.updateRunResult(result);
    const commitSync = await performSync(controlPlaneCommitRecords(recordsForSync(finalOutcome), runId));
    result.controlPlaneCommit = commitSync;
    if (!commitSync.acknowledged) {
      result.outcome = "failed";
      result.publicationState = "withheld";
      result.completionReport.processStoreValid = false;
      result.completionReport.documentStoreValid = false;
      result.completionReport.errors += Math.max(commitSync.failed.length, 1);
      result.controlPlaneRollback = await performSync(controlPlaneCommitRecords(recordsForSync("failed"), runId));
      state.updateRunResult(result);
      await stage("complete", () => undefined);
      state.finalizeWithheldRun(result, "failed", occurredAt());
      return { runId, outcome: "failed", publicationState: "withheld", resumed, alreadyComplete: false, dailyPath, reviewPath, result };
    }
    result.completionReport.documentStoreValid = true;
    result.stageTimings = { ...(result.stageTimings ?? {}), ...timings };
    result.artifactStageTimings = { ...timings };
    const finalDaily = stagedDaily;
    const finalReview = stagedReview;
    if (sha256(finalDaily) !== integrityManifest.dailyArtifactDigest || sha256(finalReview) !== integrityManifest.reviewArtifactDigest) {
      throw new Error("Final artifact bytes changed after the control-plane commit");
    }
    const dailyIndex = updateBriefingIndex(await optionalText(config.documents.root, dailyIndexPath), `${config.name} · 候选池`, path.relative(config.output.directory, dailyPath), "ai-intelligence-digest");
    const reviewIndex = updateBriefingIndex(await optionalText(config.documents.root, reviewIndexPath), `${config.name} · 待复核`, path.relative(config.output.directory, reviewPath), "ai-intelligence-review");
    validateBriefingIndex(dailyIndex, path.relative(config.output.directory, dailyPath), "ai-intelligence-digest");
    validateBriefingIndex(reviewIndex, path.relative(config.output.directory, reviewPath), "ai-intelligence-review");
    await writeArtifactSetAtomic(config.documents.root, [
      { path: dailyPath, content: finalDaily }, { path: reviewPath, content: finalReview },
      { path: dailyIndexPath, content: dailyIndex }, { path: reviewIndexPath, content: reviewIndex },
    ], () => state.commitFinalArtifacts(result, [
      { kind: "daily-markdown", path: dailyPath, contentHash: integrityManifest.dailyArtifactDigest },
      { kind: "review-markdown", path: reviewPath, contentHash: integrityManifest.reviewArtifactDigest },
    ], finalOutcome, occurredAt()));
    const [writtenDaily, writtenReview, writtenDailyIndex, writtenReviewIndex] = await Promise.all([
      readFile(dailyPath, "utf8"), readFile(reviewPath, "utf8"), readFile(dailyIndexPath, "utf8"), readFile(reviewIndexPath, "utf8"),
    ]);
    if (writtenDaily !== finalDaily || writtenReview !== finalReview) throw new Error("Document-store readback did not match the finalized artifact bytes");
    if (writtenDailyIndex !== dailyIndex || writtenReviewIndex !== reviewIndex) throw new Error("Document-store index readback did not match the validated Wiki-link bytes");
    await stage("complete", () => undefined);
    return { runId, outcome: finalOutcome, publicationState: "published", resumed, alreadyComplete: false, dailyPath, reviewPath, result };
  };

  try {
    if (begin === "resumed" && recorded?.result && ["finalizing", "abandoned"].includes(recorded.status)) {
      if (!recorded.result.publicationState || !recorded.result.integrityManifest) {
        const legacyArtifacts = state.runArtifacts(runId);
        if (legacyArtifacts.length) throw new Error(`Legacy finalizing run ${runId} has pre-commit artifacts and cannot be auto-published; quarantine it and use an explicit recovery run`);
      }
      recorded.result.integrityValidated = true;
      recorded.result.stageTimings = { ...(recorded.result.stageTimings ?? {}), ...timings };
      return await finalizeStagedRun(recorded.result, true);
    }
    await stage("initialize", () => {
      if (config.policy.rules.length !== 7) throw new Error("Formal runs require all seven canonical rules");
      if (config.protocol.stages.join("\n") !== FORMAL_STAGES.join("\n")) throw new Error("Packaged execution contract does not match the runtime stage machine");
      if (!new RegExp(config.protocol.runIdPattern).test(runId)) throw new Error(`Run ID ${runId} violates the execution contract`);
      return { configDigest: configDigest(config), sourceCount: config.preset.sources.length };
    });
    const dueSelection = recovery
      ? config.preset.sources.filter((source) => recovery.forcedSourceIds.includes(source.id)).map((source) => ({ source, reason: reverification ? `evidence-reverification-of-${baseRunId}` : `recovery-of-${recovery.parentRunId}` }))
      : state.dueSources(config.preset.sources, now, config.policy.domains);
    await stage("freeze_due_manifest", () => {
      for (const entry of dueSelection) state.freezeDueSources(runId, [entry.source], entry.reason);
    });
    const existing = new Set(state.existingReceipts(runId).map((receipt) => receipt.sourceId));
    const dueIds = new Set(state.dueSourceIds(runId));
    const due = config.preset.sources.filter((source) => dueIds.has(source.id) && !existing.has(source.id));
    const discovered = await stage("discover", () => due.map((source) => ({ source, connector: connectorFor(source) })));
    const reverificationCaptures = reverification ? state.evidenceReverificationCaptures(baseRunId) : [];
    const recoveryCapturesBySource = new Map<string, CaptureEnvelope[]>();
    for (const capture of reverificationCaptures) recoveryCapturesBySource.set(capture.sourceId, [...(recoveryCapturesBySource.get(capture.sourceId) ?? []), capture]);
    const sourcesById = new Map(config.preset.sources.map((source) => [source.id, source]));
    const recoveryHosts = reverificationCaptures.flatMap((capture) => {
      const source = sourcesById.get(capture.sourceId);
      if (!source) return [];
      try { return [canonicalRecoveryHost(source, capture)]; } catch { return []; }
    });
    const fetchClient = options.fetch ?? (ownedFetchClient = createHttpClient({
      timeoutSeconds: config.runtime.timeoutSeconds,
      retries: config.runtime.retries,
      allowedHosts: [...new Set([...allowedHosts(config), ...recoveryHosts])],
    }));
    const canonicalRecoveryFailures = new Map<string, string>();
    const canonicalRecoveredByTarget = new Map<string, CaptureEnvelope>();
    const sourceResults = await stage("capture", () => mapSourceLanes(discovered, config.runtime.httpConcurrency, async ({ source, connector }) => {
      const sourceStarted = Date.now();
      const previousCursor = state.sourceCursor(source.id);
      let connectorCursor: Record<string, unknown> = {};
      const context: ConnectorContext = {
        fetch: fetchClient,
        now: () => now,
        cursor: reverification ? {} : previousCursor,
        setCursor: (value) => { connectorCursor = value; },
        projectRoot: config.projectRoot,
      };
      try {
        if (isExternalCaptureSource(source)) {
          const supplied = externalCaptures.get(source.id);
          if (!supplied) throw new Error(`Validated external capture bundle has no entry for ${source.id}`);
          if (supplied.status === "failed") throw new Error(supplied.detail ?? `External capture failed for ${source.id}`);
          const change = changedCaptures(supplied.captures, previousCursor);
          return { source, captures: supplied.captures, changed: change.changed, cursor: change.next, receipt: { sourceId: source.id,
            result: change.changed.length ? "updated" as const : "unchanged" as const,
            detail: supplied.detail ?? `${supplied.captures.length} external captures; ${change.changed.length} new or changed`, durationMs: Date.now() - sourceStarted } };
        }
        const captures = await connector.capture(source, context);
        const notModified = connectorCursor.notModified === true;
        const change = notModified ? { changed: [] as CaptureEnvelope[], next: previousCursor } : changedCaptures(captures, previousCursor);
        const currentKeys = new Set(captures.map((capture) => `${capture.sourceId}\n${capture.contentHash}`));
        const missingRecoveryTargets = (recoveryCapturesBySource.get(source.id) ?? []).filter((capture) => !currentKeys.has(`${capture.sourceId}\n${capture.contentHash}`));
        const recovered = reverification ? await mapBounded(missingRecoveryTargets, Math.min(4, config.runtime.httpConcurrency), async (capture) => {
          const key = `${capture.sourceId}\n${capture.contentHash}`;
          try {
            const recovered = await recoverCanonicalEvidence(source, capture, fetchClient, () => now);
            canonicalRecoveredByTarget.set(key, recovered);
            return recovered;
          }
          catch (error) { canonicalRecoveryFailures.set(key, sanitizeError(error)); return null; }
        }) : [];
        const recoveredCaptures = recovered.filter((capture): capture is CaptureEnvelope => capture !== null);
        const allCaptures = [...captures, ...recoveredCaptures];
        const { notModified: _notModified, ...durableConnectorCursor } = connectorCursor;
        const receipt: Receipt = {
          sourceId: source.id,
          result: change.changed.length || recoveredCaptures.length ? "updated" : "unchanged",
          detail: `${captures.length} captured; ${change.changed.length} new or changed; ${recoveredCaptures.length} canonical recovery observations`,
          durationMs: Date.now() - sourceStarted,
        };
        return { source, captures: allCaptures, changed: change.changed, cursor: { ...change.next, ...durableConnectorCursor }, receipt };
      } catch (error) {
        return { source, captures: [failedCapture(source, connector.descriptor.version, error, runId, now, config.runtime.retries + 1)], changed: [] as CaptureEnvelope[], cursor: previousCursor, receipt: { sourceId: source.id, result: "failed" as const, detail: sanitizeError(error), durationMs: Date.now() - sourceStarted } };
      }
    }));
    await stage("write_receipts", () => {
      for (const result of sourceResults.sort((a, b) => a.source.id.localeCompare(b.source.id))) {
        state.recordSourceResult(runId, result.receipt, result.captures, result.cursor, occurredAt());
      }
    });
    await stage("normalize", () => ({ currentRunCaptures: state.runCaptures(runId).length }));
    const transientEvidence = new Map(sourceResults.flatMap((result) => result.captures.flatMap((capture) => capture.analysisText ? [[captureMemoryKey(capture), capture.analysisText] as const] : [])));
    const reverificationTargetRows = reverification ? state.evidenceReverificationTargets(baseRunId) : [];
    const reverificationTargets = reverification ? new Set(reverificationTargetRows.map((target) => `${target.sourceId}\n${target.contentHash}`)) : null;
    const reverificationCapturesByKey = new Map<string, CaptureEnvelope>(reverificationCaptures.map((capture) => [`${capture.sourceId}\n${capture.contentHash}`, capture]));
    const observedReverificationCaptures = new Map<string, CaptureEnvelope>(sourceResults.flatMap((result) => result.captures
      .filter((capture) => reverificationTargets?.has(`${capture.sourceId}\n${capture.contentHash}`))
      .map((capture) => [`${capture.sourceId}\n${capture.contentHash}`, capture] as const)));
    const allReverificationAnalysisTargets = reverificationTargets ? [...reverificationTargets].map((key) => ({
      key,
      capture: observedReverificationCaptures.get(key) ?? canonicalRecoveredByTarget.get(key) ?? reverificationCapturesByKey.get(key)!,
    })).filter((target) => target.capture) : [];
    const analysisTargets: Array<{ capture: CaptureEnvelope; analysis?: Record<string, unknown> }> = reverificationTargets
      ? allReverificationAnalysisTargets.slice(0, config.runtime.maximumCapturesPerRun).map(({ capture }) => ({ capture }))
      : state.pendingAnalysisWork(config.runtime.maximumCapturesPerRun).map((target) => {
        const analysisText = transientEvidence.get(captureMemoryKey(target.capture));
        return analysisText ? { ...target, capture: { ...target.capture, analysisText } } : target;
      });
    const deferredAnalysis: Array<{ sourceId: string; count: number; targetContentHash?: string }> = reverificationTargets
      ? allReverificationAnalysisTargets.slice(config.runtime.maximumCapturesPerRun).map(({ key }) => {
        const [sourceId, targetContentHash] = key.split("\n");
        return { sourceId: sourceId!, count: 1, targetContentHash: targetContentHash! };
      })
      : state.pendingAnalysisBacklog(analysisTargets.map((target) => target.capture));
    if (reverificationTargets) {
      const itemByKey = new Map(reverificationTargetRows.map((target) => [`${target.sourceId}\n${target.contentHash}`, target.itemId]));
      for (const { key, capture } of allReverificationAnalysisTargets) {
        if (capture.analysisText) continue;
        const detail = canonicalRecoveryFailures.get(key) ?? "The current source window did not return the frozen content hash; reverification is bounded to retained primary-source metadata";
        state.appendEvent(runId, occurredAt(), "verify_evidence", "evidence.recovery-bounded-metadata", "item", itemByKey.get(key) ?? null,
          `${runId}:${key}:bounded-metadata`, { sourceId: capture.sourceId, contentHash: capture.contentHash, detail });
      }
    }
    const provider = options.provider ?? providerFor(config.provider);
    const providerContext = { interests: config.interests, domains: config.policy.domains, prompt: config.prompts, provider: config.provider, projectRoot: config.projectRoot };
    const modelFailures: NonNullable<RunResult["modelFailures"]> = [];
    type Usage = { inputTokens?: number | undefined; outputTokens?: number | undefined; totalTokens?: number | undefined; costUsd?: number | undefined };
    type Verified = { capture: CaptureEnvelope; analysis: ReturnType<typeof durableAnalysis>; verification: ReturnType<typeof verifyAnalysisEvidence> } | null;
    const failure = (capture: CaptureEnvelope, error: unknown, durationMs: number, usage: Usage = {}): null => {
      const detail = sanitizeError(error);
      state.recordAnalysisAttempt(runId, capture, "failed", detail, undefined, occurredAt(), { durationMs,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd });
      modelFailures.push({ captureId: createHash("sha256").update(capture.contentHash).digest("hex").slice(0, 16), sourceId: capture.sourceId, detail });
      return null;
    };
    const acceptGenerated = (capture: CaptureEnvelope, generated: ModelAnalysis, durationMs: number, usage: Usage = {}): Verified => {
      try {
        const validated = validateModelAnalysis(generated, config.prompts, config.policy.domains);
        const verification = verifyAnalysisEvidence(capture, validated);
        const analysis = durableAnalysis(validated);
        state.recordAnalysisAttempt(runId, capture, "success", undefined, persistVerifiedAnalysis(capture, validated, verification), occurredAt(),
          { durationMs, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd });
        return { capture, analysis, verification };
      } catch (error) { return failure(capture, error, durationMs, usage); }
    };
    const verified = await stage("verify_evidence", async (): Promise<Verified[]> => {
      if (!provider.analyzeBatch) return await mapBounded(analysisTargets, config.runtime.modelConcurrency, async ({ capture, analysis: cached }) => {
        const modelStarted = Date.now(); let usage: Usage = {};
        try {
          const reusable = cached ? reuseVerifiedAnalysis(capture, cached) : null;
          if (reusable) {
            state.recordAnalysisAttempt(runId, capture, "success", "Reused frozen anchored evidence verification", cached, occurredAt(), { durationMs: Date.now() - modelStarted });
            return { capture, analysis: reusable.analysis, verification: reusable.verification };
          }
          const generated = await provider.analyze(capture, { ...providerContext, observeUsage: (value) => { usage = value; } });
          return acceptGenerated(capture, generated, Date.now() - modelStarted, usage);
        } catch (error) { return failure(capture, error, Date.now() - modelStarted, usage); }
      });

      const output: Verified[] = Array.from({ length: analysisTargets.length }, () => null);
      const pending: Array<{ index: number; capture: CaptureEnvelope }> = [];
      for (const [index, target] of analysisTargets.entries()) {
        let reusable: ReturnType<typeof reuseVerifiedAnalysis> = null;
        try { reusable = target.analysis ? reuseVerifiedAnalysis(target.capture, target.analysis) : null; }
        catch { reusable = null; }
        if (!reusable) { pending.push({ index, capture: target.capture }); continue; }
        state.recordAnalysisAttempt(runId, target.capture, "success", "Reused frozen anchored evidence verification", target.analysis, occurredAt(), { durationMs: 0 });
        output[index] = { capture: target.capture, analysis: reusable.analysis, verification: reusable.verification };
      }
      const batches: Array<typeof pending> = [];
      for (let index = 0; index < pending.length; index += 8) batches.push(pending.slice(index, index + 8));
      const distributeTokens = (value: number | undefined, count: number): number | undefined => value === undefined ? undefined : Math.round(value / count);
      const analyzeBatch = async (entries: typeof pending): Promise<void> => {
        const modelStarted = Date.now(); let usage: Usage = {};
        try {
          const analyses = await provider.analyzeBatch!(entries.map((entry) => entry.capture), { ...providerContext, observeUsage: (value) => { usage = value; } });
          if (analyses.length !== entries.length) throw new Error(`Model batch returned ${analyses.length}/${entries.length} analyses`);
          const durationMs = (Date.now() - modelStarted) / entries.length;
          const perItemUsage = { inputTokens: distributeTokens(usage.inputTokens, entries.length), outputTokens: distributeTokens(usage.outputTokens, entries.length),
            totalTokens: distributeTokens(usage.totalTokens, entries.length), costUsd: usage.costUsd === undefined ? undefined : usage.costUsd / entries.length };
          entries.forEach((entry, index) => { output[entry.index] = acceptGenerated(entry.capture, analyses[index]!, durationMs, perItemUsage); });
        } catch (error) {
          if (entries.length > 1) {
            const midpoint = Math.ceil(entries.length / 2);
            await analyzeBatch(entries.slice(0, midpoint));
            await analyzeBatch(entries.slice(midpoint));
          } else if (entries[0]) output[entries[0].index] = failure(entries[0].capture, error, Date.now() - modelStarted, usage);
        }
      };
      await mapBounded(batches, config.runtime.modelConcurrency, analyzeBatch);
      return output;
    });
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
        if (existingWinner && !reverification) {
          state.recordDuplicateCluster(runId, [existingWinner, ...sorted.map((item) => item.capture)], existingWinner, occurredAt());
          return [];
        }
        if (sorted.length > 1) state.recordDuplicateCluster(runId, sorted.map((item) => item.capture), winner.capture, occurredAt());
        return [winner];
      });
    });
    const historicalEvents = state.publishedEventIdentities(runId);
    const candidates = await stage("score", () => unique.map(({ capture, analysis, verification }) => {
      const candidate = buildCandidate(config, capture, analysis, verification, { now, recovery: Boolean(reverification) });
      if (!historicalEvents.has(canonicalEventIdentity(capture.canonicalUrl, capture.title))) return candidate;
      return { ...candidate, disposition: "machine-only" as const,
        exclusionReasons: [...new Set([...(candidate.exclusionReasons ?? []), "historical-event-duplicate"])] };
    }));
    const selected = await stage("select", () => selectCandidates(config, candidates));
    const receipts = state.existingReceipts(runId);
    const counts = countReceipts(state.dueSourceIds(runId), receipts);
    const selectedItems = [...selected.daily, ...selected.review];
    const outcome = formalRunOutcome({
      receiptOutcome: runOutcome(counts),
      modelFailureCount: modelFailures.length + deferredAnalysis.reduce((sum, entry) => sum + entry.count, 0),
      selectedItemCount: selectedItems.length,
      processStoreValid: true,
    });
    const result: RunResult = {
      runId, generatedAt: startedAt, mode: "live", runKind: isRecovery ? "formal-retry" : "formal", configDigest: configDigest(config), receipts,
      dueSourceIds: state.dueSourceIds(runId),
      daily: selected.daily, review: selected.review, machineOnly: selected.machineOnly, ruleIds: config.policy.rules.map((rule) => rule.id), modelFailures,
      analysisBacklog: deferredAnalysis,
      stageTimings: timings, outcome, publicationState: "withheld", readerFormatVersion: 2,
    };
    const { dailyPath, reviewPath, dailyIndexPath, reviewIndexPath } = formalArtifactPaths(config, runId);
    result.artifactPaths = { daily: dailyPath, review: reviewPath };
    result.artifactStageTimings = { ...timings };
    const sourceLatencies = result.receipts.map((receipt) => receipt.durationMs ?? 0).sort((a, b) => a - b);
    const percentile = (value: number) => sourceLatencies.length ? sourceLatencies[Math.min(sourceLatencies.length - 1, Math.ceil(sourceLatencies.length * value) - 1)]! : 0;
    const captureSeconds = Math.max((timings.capture ?? 0) / 1000, 0.001);
    result.completionReport = {
      due: counts.due, receipts: result.receipts.length, updated: counts.updated, unchanged: counts.unchanged, failed: counts.failed,
      skipped: counts.skipped, missing: counts.missing, missingSourceIds: state.dueSourceIds(runId).filter((id) => !result.receipts.some((receipt) => receipt.sourceId === id)),
      discovered: sourceResults.reduce((sum, entry) => sum + entry.captures.filter((capture) => capture.fetchStatus !== "failed").length, 0), captured: state.runCaptures(runId).length,
      verified: verified.filter(Boolean).length, deduplicated: unique.length, scored: candidates.length, daily: result.daily.length, review: result.review.length,
      eliminated: result.machineOnly?.length ?? 0, errors: counts.failed + modelFailures.length + deferredAnalysis.reduce((sum, entry) => sum + entry.count, 0),
      domainCounts: Object.fromEntries(config.policy.domains.map((domain) => [domain, selectedItems.filter((entry) => entry.domain === domain).length])),
      topItemIds: [...selectedItems].sort((a, b) => b.score - a.score).slice(0, 3).map((entry) => entry.id),
      ruleContractValid: config.policy.rules.length === 7, processStoreValid: false, documentStoreValid: false,
      performance: { sourceLatencyP50Ms: percentile(0.5), sourceLatencyP95Ms: percentile(0.95), captureThroughputPerSecond: Number((state.runCaptures(runId).length / captureSeconds).toFixed(2)) },
    };
    await stage("publish", async () => {
      const daily = renderFormalDaily(config, result);
      const review = renderFormalReview(config, result);
      validateFormalArtifact(config, result, "daily", daily);
      validateFormalArtifact(config, result, "review", review);
      const dailyIndex = updateBriefingIndex(await optionalText(config.documents.root, dailyIndexPath), `${config.name} · 候选池`, path.relative(config.output.directory, dailyPath), "ai-intelligence-digest");
      const reviewIndex = updateBriefingIndex(await optionalText(config.documents.root, reviewIndexPath), `${config.name} · 待复核`, path.relative(config.output.directory, reviewPath), "ai-intelligence-review");
      validateBriefingIndex(dailyIndex, path.relative(config.output.directory, dailyPath), "ai-intelligence-digest");
      validateBriefingIndex(reviewIndex, path.relative(config.output.directory, reviewPath), "ai-intelligence-review");
    });
    await stage("persist", () => state.stageFormalRun(result, [...selected.daily, ...selected.review, ...selected.machineOnly]));
    result.integrityValidated = true;
    return await finalizeStagedRun(result, begin === "resumed");
  } catch (error) {
    state.abandonFormalRun(runId, occurredAt(), sanitizeError(error));
    throw error;
  } finally {
    await ownedFetchClient?.close();
    state.close();
  }
}
