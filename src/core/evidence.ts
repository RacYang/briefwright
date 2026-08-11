import type { CaptureEnvelope } from "../connectors/types.js";
import type { ModelAnalysis } from "../providers/types.js";

function tokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._+-]*/gu) ?? [];
}

export interface EvidenceVerification {
  confirmed: boolean;
  reasons: string[];
  claimSupport: Array<{ claim: string; supported: boolean; overlap: number }>;
}

export function verifyAnalysisEvidence(capture: CaptureEnvelope, analysis: ModelAnalysis): EvidenceVerification {
  const evidence = `${capture.title}\n${capture.summary}`;
  const evidenceTokens = new Set(tokens(evidence));
  const evidenceNumbers = new Set(tokens(evidence).filter((token) => /\d/.test(token)));
  const claimSupport = analysis.claims.map((claim) => {
    const claimTokens = tokens(claim).filter((token) => token.length >= 2);
    const meaningful = claimTokens.filter((token) => !/^(the|and|for|with|from|that|this|了|的|和|在|是|为)$/.test(token));
    const matched = meaningful.filter((token) => evidenceTokens.has(token));
    const newNumbers = meaningful.filter((token) => /\d/.test(token) && !evidenceNumbers.has(token));
    const overlap = meaningful.length ? matched.length / meaningful.length : 0;
    return { claim, supported: meaningful.length > 0 && overlap >= 0.5 && newNumbers.length === 0, overlap };
  });
  const reasons: string[] = [];
  if (capture.evidenceClass !== "primary") reasons.push("capture is not declared primary evidence");
  if (!analysis.claims.length) reasons.push("analysis contains no bounded claim");
  if (claimSupport.some((claim) => !claim.supported)) reasons.push("one or more model-extracted claims are not lexically supported by the captured evidence");
  return { confirmed: reasons.length === 0, reasons, claimSupport };
}
