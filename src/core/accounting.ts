import type { Receipt, ReceiptResult } from "./types.js";

export interface ReceiptCounts {
  due: number;
  observed: number;
  updated: number;
  unchanged: number;
  failed: number;
  skipped: number;
  missing: number;
}

export function countReceipts(dueSourceIds: string[], receipts: Receipt[]): ReceiptCounts {
  const due = new Set(dueSourceIds);
  const seen = new Set<string>();
  const counts: Record<ReceiptResult, number> = {
    observed: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    skipped: 0,
  };

  for (const receipt of receipts) {
    if (!due.has(receipt.sourceId)) {
      throw new Error(`Receipt belongs to a source that was not due: ${receipt.sourceId}`);
    }
    if (seen.has(receipt.sourceId)) {
      throw new Error(`Duplicate receipt for due source: ${receipt.sourceId}`);
    }
    seen.add(receipt.sourceId);
    counts[receipt.result] += 1;
  }

  return {
    due: due.size,
    ...counts,
    missing: due.size - seen.size,
  };
}

export type RunOutcome = "success" | "partial" | "failed";

export type FormalRunOutcome = RunOutcome | "empty";

export interface FormalOutcomeInput {
  receiptOutcome: RunOutcome;
  modelFailureCount: number;
  selectedItemCount: number;
  processStoreValid: boolean;
}

export function runOutcome(counts: ReceiptCounts): RunOutcome {
  if (counts.due === 0) return "success";
  if (counts.failed === counts.due || counts.missing === counts.due) return "failed";
  if (counts.failed > 0 || counts.missing > 0) return "partial";
  return "success";
}

/**
 * Derive the user-visible terminal result for a formal briefing.
 *
 * `partial` is reserved for a usable briefing with named failures. A run that
 * has no usable items is either an honest `empty` result (the pipeline was
 * otherwise healthy) or `failed` (failures make the empty result unreliable).
 * A process-store failure is blocking because the control plane must be
 * authoritative before a reading artifact can be published.
 */
export function formalRunOutcome(input: FormalOutcomeInput): FormalRunOutcome {
  if (!input.processStoreValid || input.receiptOutcome === "failed") return "failed";
  if (input.selectedItemCount === 0) {
    return input.receiptOutcome === "success" && input.modelFailureCount === 0 ? "empty" : "failed";
  }
  if (input.receiptOutcome === "partial" || input.modelFailureCount > 0) return "partial";
  return "success";
}
