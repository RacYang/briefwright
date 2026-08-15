import { createHash, randomUUID } from "node:crypto";

import type { EffectiveConfig } from "../config/types.js";
import { configDigest } from "../config/load.js";
import { allowedHostsForSource, createHttpClient } from "../connectors/http.js";
import { connectorFor } from "../connectors/registry.js";
import { isExternalCaptureSource, type ValidatedExternalCapture } from "../connectors/external-bundle.js";
import type { CaptureEnvelope, ConnectorContext } from "../connectors/types.js";
import { sanitizeError } from "../config/secrets.js";
import { providerFor } from "../providers/registry.js";
import type { ModelProvider } from "../providers/types.js";
import { validateModelAnalysis } from "../providers/validate.js";
import { formalRunOutcome, runOutcome, countReceipts } from "./accounting.js";
import { durableAnalysis, verifyAnalysisEvidence } from "./evidence.js";
import { buildCandidate, selectCandidates } from "./selection.js";
import type { BriefingItem, Receipt, RunResult } from "./types.js";

function itemId(url: string): string {
  return `ITEM-${createHash("sha256").update(url).digest("hex").slice(0, 12).toUpperCase()}`;
}

function isWithinCoverage(capture: CaptureEnvelope, now: Date): boolean {
  const cutoff = now.getTime() - 48 * 60 * 60 * 1_000;
  if (!capture.publishedAt) return false;
  const timestamp = new Date(capture.publishedAt).getTime();
  return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now.getTime();
}

function interestTokens(config: EffectiveConfig): string[] {
  return [...new Set(
    config.interests
      .flatMap((interest) => interest.toLowerCase().split(/[^a-z0-9\p{L}]+/u))
      .filter((token) => token.length >= 3),
  )];
}

function relevance(capture: CaptureEnvelope, tokens: string[]): number {
  const title = capture.title.toLowerCase();
  const summary = capture.summary.toLowerCase();
  return tokens.reduce(
    (score, token) => score + (title.includes(token) ? 2 : 0) + (summary.includes(token) ? 1 : 0),
    0,
  );
}

function allowedHosts(config: EffectiveConfig): string[] {
  return config.preset.sources.flatMap(allowedHostsForSource);
}

function errorDetail(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && messages.length < 3) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(": ").slice(0, 500) || String(error).slice(0, 500);
}

function selectItems(captures: CaptureEnvelope[], config: EffectiveConfig, now: Date): BriefingItem[] {
  const tokens = interestTokens(config);
  const perSource = new Map<string, number>();
  return captures
    .filter((capture) => isWithinCoverage(capture, now))
    .map((capture) => ({ capture, relevance: relevance(capture, tokens) }))
    .filter(({ relevance: score }) => score > 0)
    .sort((left, right) =>
      right.relevance - left.relevance ||
      (right.capture.publishedAt ?? "").localeCompare(left.capture.publishedAt ?? "") ||
      left.capture.canonicalUrl.localeCompare(right.capture.canonicalUrl),
    )
    .filter(({ capture }) => {
      const count = perSource.get(capture.sourceId) ?? 0;
      if (count >= 3) return false;
      perSource.set(capture.sourceId, count + 1);
      return true;
    })
    .slice(0, 8)
    .map(({ capture, relevance: score }) => ({
      id: itemId(capture.canonicalUrl),
      sourceId: capture.sourceId,
      title: capture.title,
      summary: capture.summary || "The primary source did not provide a summary.",
      whyItMatters: "Live preview candidate. Human review and policy-based synthesis are still required before knowledge integration.",
      url: capture.canonicalUrl,
      evidence: capture.evidenceClass,
      score: Math.min(85, 70 + score),
    }));
}

export interface LiveRunOptions {
  editorial?: boolean;
  provider?: ModelProvider;
  analysisLimit?: number;
}

function captureTimestamp(capture: CaptureEnvelope): number {
  return capture.publishedAt ? new Date(capture.publishedAt).getTime() : Number.NaN;
}

function captureDomain(capture: CaptureEnvelope): string {
  try { return new URL(capture.canonicalUrl).hostname.replace(/^www\./i, ""); }
  catch { return capture.sourceId; }
}

function editorialSample(
  captures: CaptureEnvelope[],
  config: EffectiveConfig,
  now: Date,
  limit: number,
): { eligible: CaptureEnvelope[]; sample: CaptureEnvelope[] } {
  const tokens = interestTokens(config);
  const sourceById = new Map(config.preset.sources.map((source) => [source.id, source]));
  const maximumAgeHours = config.policy.freshness?.reviewMaximumAgeHours ?? 720;
  const futureToleranceHours = config.policy.freshness?.futureToleranceHours ?? 6;
  const unique = new Map<string, CaptureEnvelope>();
  for (const capture of captures) {
    if (capture.fetchStatus === "failed" || capture.extractStatus === "failed") continue;
    const timestamp = captureTimestamp(capture);
    const ageHours = (now.getTime() - timestamp) / 3_600_000;
    if (!Number.isFinite(timestamp) || ageHours > maximumAgeHours || ageHours < -futureToleranceHours) continue;
    const key = `${capture.canonicalUrl}\n${capture.contentHash}`;
    if (!unique.has(key)) unique.set(key, capture);
  }
  const eligible = [...unique.values()].sort((left, right) => {
    const leftSource = sourceById.get(left.sourceId);
    const rightSource = sourceById.get(right.sourceId);
    return relevance(right, tokens) - relevance(left, tokens) ||
      (rightSource?.priority ?? 0) - (leftSource?.priority ?? 0) ||
      Number(right.evidenceClass === "primary") - Number(left.evidenceClass === "primary") ||
      captureTimestamp(right) - captureTimestamp(left) ||
      left.canonicalUrl.localeCompare(right.canonicalUrl);
  });
  const perSource = new Map<string, number>();
  const perDomain = new Map<string, number>();
  const sample = eligible.filter((capture) => {
    const domain = captureDomain(capture);
    const sourceCount = perSource.get(capture.sourceId) ?? 0;
    const domainCount = perDomain.get(domain) ?? 0;
    if (sourceCount >= 2 || domainCount >= 3) return false;
    perSource.set(capture.sourceId, sourceCount + 1);
    perDomain.set(domain, domainCount + 1);
    return true;
  }).slice(0, limit);
  return { eligible, sample };
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

export async function createLiveRun(
  config: EffectiveConfig,
  now = new Date(),
  fetchOverride?: ConnectorContext["fetch"],
  sources = config.preset.sources,
  externalCaptures = new Map<string, ValidatedExternalCapture>(),
  options: LiveRunOptions = {},
): Promise<RunResult> {
  const ownedFetchClient = fetchOverride ? undefined : createHttpClient({
    timeoutSeconds: config.runtime.timeoutSeconds,
    retries: config.runtime.retries,
    allowedHosts: allowedHosts(config),
  });
  const fetchClient = fetchOverride ?? ownedFetchClient!;
  const context: ConnectorContext = { fetch: fetchClient, now: () => now, projectRoot: config.projectRoot };
  const receipts: Receipt[] = [];
  const captures: CaptureEnvelope[] = [];

  let nextSource = 0;
  const workers = Array.from(
    { length: Math.min(config.runtime.httpConcurrency, sources.length) },
    async () => {
      for (;;) {
        const index = nextSource;
        nextSource += 1;
        const source = sources[index];
        if (!source) return;
      try {
        const connector = connectorFor(source);
        const supplied = isExternalCaptureSource(source) ? externalCaptures.get(source.id) : undefined;
        if (isExternalCaptureSource(source) && !supplied) throw new Error(`Validated external capture bundle has no entry for ${source.id}`);
        if (supplied?.status === "failed") throw new Error(supplied.detail ?? `External capture failed for ${source.id}`);
        const sourceCaptures = supplied ? supplied.captures : await connector.capture(source, context);
        captures.push(...sourceCaptures);
        const recentCount = sourceCaptures.filter((capture) => isWithinCoverage(capture, now)).length;
        receipts.push({
          sourceId: source.id,
          result: "observed",
          detail: `${sourceCaptures.length} captured; ${recentCount} within the 48-hour coverage window; change detection is not enabled in preview`,
        });
      } catch (error) {
        receipts.push({
          sourceId: source.id,
          result: "failed",
          detail: errorDetail(error),
        });
      }
      }
    },
  );
  try { await Promise.all(workers); } finally { await ownedFetchClient?.close(); }

  receipts.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  const digest = configDigest(config);
  const dueSourceIds = sources.map((source) => source.id);
  const counts = countReceipts(dueSourceIds, receipts);
  if (!options.editorial) {
    return {
      runId: `PREVIEW-LIVE-${timestamp}-${digest.slice(0, 8).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
      generatedAt: now.toISOString(),
      mode: "live",
      runKind: "preview",
      previewKind: "source",
      configDigest: digest,
      dueSourceIds,
      receipts,
      daily: selectItems(captures, config, now),
      review: [],
      outcome: runOutcome(counts),
      publicationState: "withheld",
    };
  }

  const sampleLimit = Math.min(Math.max(options.analysisLimit ?? 24, 1), 24, config.runtime.maximumCapturesPerRun);
  const { eligible, sample } = editorialSample(captures, config, now, sampleLimit);
  const provider = options.provider ?? providerFor(config.provider);
  const providerContext = {
    interests: config.interests,
    domains: config.policy.domains,
    prompt: config.prompts,
    provider: config.provider,
    projectRoot: config.projectRoot,
  };
  const modelFailures: NonNullable<RunResult["modelFailures"]> = [];
  const analyzed = await mapBounded(sample, config.runtime.modelConcurrency, async (capture) => {
    try {
      const analysis = validateModelAnalysis(await provider.analyze(capture, providerContext), config.prompts, config.policy.domains);
      const verification = verifyAnalysisEvidence(capture, analysis);
      return buildCandidate(config, capture, durableAnalysis(analysis), verification, { now });
    } catch (error) {
      modelFailures.push({
        captureId: createHash("sha256").update(capture.contentHash).digest("hex").slice(0, 16),
        sourceId: capture.sourceId,
        detail: sanitizeError(error).slice(0, 500),
      });
      return null;
    }
  });
  const candidates = analyzed.filter((candidate): candidate is BriefingItem => candidate !== null);
  modelFailures.sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.captureId.localeCompare(right.captureId));
  const selected = selectCandidates(config, candidates);
  const selectedItemCount = selected.daily.length + selected.review.length;
  const outcome = formalRunOutcome({
    receiptOutcome: runOutcome(counts),
    modelFailureCount: modelFailures.length,
    selectedItemCount,
    processStoreValid: true,
  });
  return {
    runId: `PREVIEW-EDITORIAL-${timestamp}-${digest.slice(0, 8).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    generatedAt: now.toISOString(),
    mode: "live",
    runKind: "preview",
    previewKind: "editorial",
    previewAnalysis: { sampleLimit, eligibleCaptures: eligible.length, analyzed: sample.length, succeeded: candidates.length, failed: modelFailures.length },
    configDigest: digest,
    dueSourceIds,
    receipts,
    daily: selected.daily,
    review: selected.review,
    machineOnly: selected.machineOnly,
    modelFailures,
    outcome,
    publicationState: "withheld",
  };
}
