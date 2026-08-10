import { createHash, randomUUID } from "node:crypto";

import type { EffectiveConfig } from "../config/types.js";
import { configDigest } from "../config/load.js";
import { createHttpClient } from "../connectors/http.js";
import { connectorFor } from "../connectors/registry.js";
import type { CaptureEnvelope, ConnectorContext } from "../connectors/types.js";
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
  return config.preset.sources.map((source) =>
    source.connector.type === "github-releases"
      ? "api.github.com"
      : new URL(source.connector.config.url).hostname,
  );
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

export async function createLiveRun(
  config: EffectiveConfig,
  now = new Date(),
  fetchOverride?: ConnectorContext["fetch"],
): Promise<RunResult> {
  const fetchClient = fetchOverride ?? createHttpClient({
    timeoutSeconds: config.runtime.timeoutSeconds,
    retries: config.runtime.retries,
    allowedHosts: allowedHosts(config),
  });
  const context: ConnectorContext = { fetch: fetchClient, now: () => now };
  const receipts: Receipt[] = [];
  const captures: CaptureEnvelope[] = [];

  let nextSource = 0;
  const workers = Array.from(
    { length: Math.min(config.runtime.httpConcurrency, config.preset.sources.length) },
    async () => {
      for (;;) {
        const index = nextSource;
        nextSource += 1;
        const source = config.preset.sources[index];
        if (!source) return;
      try {
        const connector = connectorFor(source);
        const sourceCaptures = await connector.capture(source, context);
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
  await Promise.all(workers);

  receipts.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  const digest = configDigest(config);
  return {
    runId: `PREVIEW-LIVE-${timestamp}-${digest.slice(0, 8).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    generatedAt: now.toISOString(),
    mode: "live",
    configDigest: digest,
    receipts,
    daily: selectItems(captures, config, now),
    review: [],
  };
}
