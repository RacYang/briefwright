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

export function runOutcome(counts: ReceiptCounts): RunOutcome {
  if (counts.failed === counts.due || counts.missing === counts.due) return "failed";
  if (counts.failed > 0 || counts.missing > 0) return "partial";
  return "success";
}
