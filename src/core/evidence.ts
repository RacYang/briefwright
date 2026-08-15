import type { CaptureEnvelope } from "../connectors/types.js";
import type { DurableModelAnalysis, ModelAnalysis } from "../providers/types.js";
import { createHash } from "node:crypto";

function normalizedEvidence(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
}

function boundedWords(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function numbers(value: string): string[] {
  return value.normalize("NFKC").match(/\d+(?:[.,]\d+)*/gu) ?? [];
}

export interface EvidenceVerification {
  confirmed: boolean;
  reasons: string[];
  claimSupport: Array<{ claim: string; supported: boolean; overlap: number }>;
}

export interface PersistedEvidenceVerification {
  version: "anchored-v1";
  confirmed: boolean;
  reasons: string[];
  sourceContentHash: string;
  claimSupport: Array<{ claimHash: string; anchorHash?: string; supported: boolean; overlap: number }>;
}

export type PersistedVerifiedAnalysis = DurableModelAnalysis & { _evidenceVerification: PersistedEvidenceVerification };

export function durableAnalysis(analysis: ModelAnalysis): DurableModelAnalysis {
  const { claimEvidence: _claimEvidence, ...durable } = analysis;
  return durable;
}

export function persistVerifiedAnalysis(capture: CaptureEnvelope, analysis: ModelAnalysis, verification: EvidenceVerification): PersistedVerifiedAnalysis {
  const anchors = new Map(analysis.claimEvidence.map((anchor) => [anchor.claimIndex, anchor.excerpt]));
  return {
    ...durableAnalysis(analysis),
    _evidenceVerification: {
      version: "anchored-v1",
      confirmed: verification.confirmed,
      reasons: verification.reasons,
      sourceContentHash: capture.contentHash,
      claimSupport: verification.claimSupport.map((support, index) => ({
        claimHash: createHash("sha256").update(support.claim).digest("hex"),
        ...(anchors.has(index) ? { anchorHash: createHash("sha256").update(anchors.get(index)!).digest("hex") } : {}),
        supported: support.supported,
        overlap: support.overlap,
      })),
    },
  };
}

export function reuseVerifiedAnalysis(capture: CaptureEnvelope, value: Record<string, unknown>): { analysis: DurableModelAnalysis; verification: EvidenceVerification } | null {
  const receipt = value._evidenceVerification as PersistedEvidenceVerification | undefined;
  if (!receipt || receipt.version !== "anchored-v1" || receipt.sourceContentHash !== capture.contentHash || !Array.isArray(receipt.claimSupport)) return null;
  const { _evidenceVerification: _receipt, ...analysis } = value as unknown as PersistedVerifiedAnalysis;
  if (!Array.isArray(analysis.claims) || receipt.claimSupport.length !== analysis.claims.length) return null;
  if (receipt.claimSupport.some((support, index) => support.claimHash !== createHash("sha256").update(analysis.claims[index]!).digest("hex"))) return null;
  return {
    analysis,
    verification: {
      confirmed: receipt.confirmed,
      reasons: receipt.reasons,
      claimSupport: receipt.claimSupport.map((support, index) => ({ claim: analysis.claims[index]!, supported: support.supported, overlap: support.overlap })),
    },
  };
}

export function verifyAnalysisEvidence(capture: CaptureEnvelope, analysis: ModelAnalysis): EvidenceVerification {
  const evidence = `${capture.title}\n${capture.summary}\n${capture.analysisText ?? ""}`;
  const normalizedSource = normalizedEvidence(evidence);
  const evidenceNumbers = new Set(numbers(evidence));
  const anchors = new Map<number, string[]>();
  for (const anchor of analysis.claimEvidence) anchors.set(anchor.claimIndex, [...(anchors.get(anchor.claimIndex) ?? []), anchor.excerpt]);
  const claimSupport = analysis.claims.map((claim, index) => {
    const claimAnchors = anchors.get(index) ?? [];
    const excerpt = claimAnchors[0] ?? "";
    const exactAnchor = claimAnchors.length === 1 && excerpt.length > 0 && boundedWords(excerpt) <= 25 && normalizedSource.includes(normalizedEvidence(excerpt));
    const inventedNumbers = numbers(claim).filter((number) => !evidenceNumbers.has(number));
    return { claim, supported: exactAnchor && inventedNumbers.length === 0, overlap: exactAnchor ? 1 : 0 };
  });
  const reasons: string[] = [];
  if (capture.evidenceClass !== "primary") reasons.push("capture is not declared primary evidence");
  if (!analysis.claims.length) reasons.push("analysis contains no bounded claim");
  if (analysis.claimEvidence.length !== analysis.claims.length) reasons.push("each model-extracted claim must have exactly one bounded source-language evidence anchor");
  if (analysis.claimEvidence.some((anchor) => !Number.isInteger(anchor.claimIndex) || anchor.claimIndex < 0 || anchor.claimIndex >= analysis.claims.length)) reasons.push("one or more evidence anchors reference an invalid claim index");
  if (claimSupport.some((claim) => !claim.supported)) reasons.push("one or more model-extracted claims lack an exact bounded anchor in the transient source evidence");
  return { confirmed: reasons.length === 0, reasons, claimSupport };
}
