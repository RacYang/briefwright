import { createHash } from "node:crypto";

import type { EffectiveConfig } from "../config/types.js";
import type { CaptureEnvelope } from "../connectors/types.js";
import type { ModelAnalysis } from "../providers/types.js";
import type { BriefingItem } from "./types.js";
import { verifyAnalysisEvidence } from "./evidence.js";

export function canonicalItemIdentity(capture: CaptureEnvelope): string {
  return createHash("sha256").update(`${capture.canonicalUrl}\n${capture.externalKey}`).digest("hex");
}

export function scoreAnalysis(config: EffectiveConfig, analysis: ModelAnalysis) {
  const dimensions = Object.fromEntries(config.policy.score.dimensions.map((definition) => {
    const score = analysis.scores[definition.id];
    const weighted = score.value / 5 * 100 * definition.weight;
    return [definition.id, { value: score.value, weight: definition.weight, weighted, reason: score.reason }];
  }));
  const total = Math.round(Object.values(dimensions).reduce((sum, dimension) => sum + dimension.weighted, 0));
  return { total, dimensions };
}

export function buildCandidate(config: EffectiveConfig, capture: CaptureEnvelope, analysis: ModelAnalysis): BriefingItem {
  const score = scoreAnalysis(config, analysis);
  const verification = verifyAnalysisEvidence(capture, analysis);
  const evidenceStatus = verification.confirmed ? "confirmed-primary" : capture.evidenceClass === "secondary" ? "secondary-clue" : "unverified";
  const exclusions = [...analysis.exclusions];
  if (evidenceStatus !== "confirmed-primary") exclusions.push("unverified");
  const knowledgePass = Object.entries(analysis.knowledgePotential)
    .filter(([key]) => key !== "reason")
    .every(([, value]) => value === true);
  let disposition: BriefingItem["disposition"] = "machine-only";
  if (!exclusions.length && score.total >= config.policy.score.dailyThreshold) disposition = "daily";
  else if (!exclusions.length && score.total >= config.policy.score.reviewMinimum && knowledgePass) disposition = "review";
  return {
    id: `AI-${canonicalItemIdentity(capture).slice(0, 12).toUpperCase()}`,
    sourceId: capture.sourceId,
    title: capture.title,
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
    exclusionReasons: [...new Set([...exclusions, ...verification.reasons])],
  };
}

export function selectCandidates(config: EffectiveConfig, candidates: BriefingItem[]): {
  daily: BriefingItem[];
  review: BriefingItem[];
  machineOnly: BriefingItem[];
} {
  const unique = new Map<string, BriefingItem>();
  for (const item of [...candidates].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
    if (!unique.has(item.url)) unique.set(item.url, item);
  }
  const domainCounts = new Map<string, number>();
  const daily: BriefingItem[] = [];
  const review: BriefingItem[] = [];
  const machineOnly: BriefingItem[] = [];
  for (const item of unique.values()) {
    if (item.disposition === "daily") {
      const domain = item.domain ?? "unknown";
      const count = domainCounts.get(domain) ?? 0;
      if (daily.length < config.policy.score.dailyMaximum && count < config.policy.score.perDomainMaximum) {
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
