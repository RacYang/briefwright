import { createHash } from "node:crypto";

import type { EffectiveConfig, PolicyDefinition } from "../config/types.js";
import type { CaptureEnvelope } from "../connectors/types.js";
import type { DurableModelAnalysis, ModelAnalysis } from "../providers/types.js";
import type { BriefingItem } from "./types.js";
import { verifyAnalysisEvidence, type EvidenceVerification } from "./evidence.js";

export function canonicalItemIdentity(capture: CaptureEnvelope): string {
  return createHash("sha256").update(`${capture.canonicalUrl}\n${capture.externalKey}\n${capture.contentHash}`).digest("hex");
}

export function canonicalEventIdentity(canonicalUrl: string, title: string): string {
  const url = new URL(canonicalUrl);
  url.hash = "";
  const immutableUrl = /\/(?:releases\/tag|abs|status)\//i.test(url.pathname);
  const normalizedTitle = title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return createHash("sha256").update(`${url.toString()}\n${immutableUrl ? "immutable" : normalizedTitle}`).digest("hex");
}

export function scoreAnalysis(config: EffectiveConfig, analysis: DurableModelAnalysis) {
  const dimensions = Object.fromEntries(config.policy.score.dimensions.map((definition) => {
    const score = analysis.scores[definition.id];
    const weighted = score.value / 5 * 100 * definition.weight;
    return [definition.id, { value: score.value, weight: definition.weight, weighted, reason: score.reason }];
  }));
  const total = Math.round(Object.values(dimensions).reduce((sum, dimension) => sum + dimension.weighted, 0));
  return { total, dimensions };
}

export function buildCandidate(config: EffectiveConfig, capture: CaptureEnvelope, analysis: DurableModelAnalysis, verification?: EvidenceVerification, options: {
  now?: Date;
  recovery?: boolean;
} = {}): BriefingItem {
  const score = scoreAnalysis(config, analysis);
  const resolvedVerification = verification ?? verifyAnalysisEvidence(capture, analysis as ModelAnalysis);
  const evidenceStatus = resolvedVerification.confirmed ? "confirmed-primary" : capture.evidenceClass === "secondary" ? "secondary-clue" : "unverified";
  const exclusions: string[] = [...analysis.exclusions];
  if (evidenceStatus !== "confirmed-primary") exclusions.push("unverified");
  const dailyExclusions: string[] = [];
  const freshness = config.policy.freshness ?? { dailyMaximumAgeHours: 72, reviewMaximumAgeHours: 720, futureToleranceHours: 6 };
  const now = options.now ?? new Date(capture.capturedAt);
  if (options.recovery) exclusions.push("recovery-only");
  if (!capture.publishedAt) dailyExclusions.push("missing-published-at");
  else {
    const ageHours = (now.getTime() - new Date(capture.publishedAt).getTime()) / 3_600_000;
    if (!Number.isFinite(ageHours)) exclusions.push("invalid-published-at");
    else if (ageHours < -freshness.futureToleranceHours) exclusions.push("future-published-at");
    else {
      if (ageHours > freshness.dailyMaximumAgeHours) dailyExclusions.push("stale-for-daily");
      if (ageHours > freshness.reviewMaximumAgeHours) exclusions.push("stale-for-review");
    }
  }
  const knowledgePass = Object.entries(analysis.knowledgePotential)
    .filter(([key]) => key !== "reason")
    .every(([, value]) => value === true);
  let disposition: BriefingItem["disposition"] = "machine-only";
  if (!exclusions.length && !dailyExclusions.length && score.total >= config.policy.score.dailyThreshold) disposition = "daily";
  else if (!exclusions.length && score.total >= config.policy.score.reviewMinimum && knowledgePass) disposition = "review";
  return {
    id: `AI-${canonicalItemIdentity(capture).slice(0, 12).toUpperCase()}`,
    sourceId: capture.sourceId,
    captureHash: capture.contentHash,
    capturedAt: capture.capturedAt,
    ...(capture.publishedAt ? { publishedAt: capture.publishedAt } : {}),
    ...(capture.pageUpdatedAt ? { pageUpdatedAt: capture.pageUpdatedAt } : {}),
    sourceExcerpt: capture.summary,
    title: analysis.title.trim() || capture.title,
    summary: analysis.summary,
    whyItMatters: analysis.whyItMatters,
    url: capture.canonicalUrl,
    evidence: capture.evidenceClass,
    evidenceStatus,
    score: score.total,
    scoreDimensions: score.dimensions,
    domain: analysis.domain,
    disposition,
    claims: analysis.claims,
    knowledgePotential: analysis.knowledgePotential,
    exclusionReasons: [...new Set([...exclusions, ...resolvedVerification.reasons])],
    dailyExclusionReasons: [...new Set(dailyExclusions)],
  };
}

export function selectCandidates(config: EffectiveConfig, candidates: BriefingItem[]): {
  daily: BriefingItem[];
  review: BriefingItem[];
  machineOnly: BriefingItem[];
} {
  return selectCandidatesUnderPolicy(config.policy, candidates);
}

export function replayCandidateUnderPolicy(policy: PolicyDefinition, item: BriefingItem): BriefingItem {
  const dimensions = Object.fromEntries(policy.score.dimensions.map((definition) => {
    const previous = item.scoreDimensions?.[definition.id];
    if (!previous) throw new Error(`Item ${item.id} is missing score dimension ${definition.id}`);
    return [definition.id, {
      value: previous.value,
      weight: definition.weight,
      weighted: previous.value / 5 * 100 * definition.weight,
      reason: previous.reason,
    }];
  }));
  const score = Math.round(Object.values(dimensions).reduce((sum, dimension) => sum + dimension.weighted, 0));
  const persistentExclusions = (item.exclusionReasons ?? []).filter((reason) => reason !== "selection-cap");
  const dailyExclusions = item.dailyExclusionReasons ?? [];
  const knowledgePass = Boolean(item.knowledgePotential) && Object.entries(item.knowledgePotential!)
    .filter(([key]) => key !== "reason")
    .every(([, value]) => value === true);
  const eligible = item.evidenceStatus === "confirmed-primary" && persistentExclusions.length === 0 &&
    Boolean(item.domain && policy.domains.includes(item.domain));
  let disposition: BriefingItem["disposition"] = "machine-only";
  if (eligible && dailyExclusions.length === 0 && score >= policy.score.dailyThreshold) disposition = "daily";
  else if (eligible && score >= policy.score.reviewMinimum && knowledgePass) disposition = "review";
  return { ...item, score, scoreDimensions: dimensions, disposition, exclusionReasons: persistentExclusions, dailyExclusionReasons: dailyExclusions };
}

export function selectCandidatesUnderPolicy(policy: PolicyDefinition, candidates: BriefingItem[], options: { eventDedupe?: boolean } = {}): {
  daily: BriefingItem[];
  review: BriefingItem[];
  machineOnly: BriefingItem[];
} {
  const unique = new Map<string, BriefingItem>();
  const semanticEvents = new Set<string>();
  const duplicates: BriefingItem[] = [];
  for (const item of [...candidates].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
    const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const semanticKey = item.publishedAt && item.captureHash
      ? createHash("sha256").update(`${normalized(item.title)}\n${normalized(item.summary)}\n${item.publishedAt.slice(0, 10)}\n${item.captureHash}`).digest("hex")
      : null;
    const duplicateEvent = options.eventDedupe !== false && Boolean(semanticKey && semanticEvents.has(semanticKey));
    if (!unique.has(item.url) && !duplicateEvent) {
      unique.set(item.url, item); if (semanticKey) semanticEvents.add(semanticKey);
    }
    else duplicates.push({ ...item, disposition: "machine-only", exclusionReasons: [...(item.exclusionReasons ?? []).filter((reason) => reason !== "selection-cap"), "duplicate-event"] });
  }
  const domainCounts = new Map<string, number>();
  const daily: BriefingItem[] = [];
  const review: BriefingItem[] = [];
  const machineOnly: BriefingItem[] = [...duplicates];
  for (const item of unique.values()) {
    if (item.disposition === "daily") {
      const domain = item.domain ?? "unknown";
      const count = domainCounts.get(domain) ?? 0;
      if (daily.length < policy.score.dailyMaximum && count < policy.score.perDomainMaximum) {
        daily.push(item);
        domainCounts.set(domain, count + 1);
      } else {
        machineOnly.push({ ...item, disposition: "machine-only", exclusionReasons: [...(item.exclusionReasons ?? []), "selection-cap"] });
      }
    } else if (item.disposition === "review") review.push(item);
    else machineOnly.push(item);
  }
  return { daily, review, machineOnly };
}
