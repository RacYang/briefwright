export type ReceiptResult = "observed" | "updated" | "unchanged" | "failed" | "skipped";

export interface Receipt {
  sourceId: string;
  result: ReceiptResult;
  detail?: string;
}

export interface BriefingItem {
  id: string;
  sourceId: string;
  title: string;
  summary: string;
  whyItMatters: string;
  url: string;
  evidence: "primary" | "secondary" | "unverified";
  score: number;
}

export interface RunResult {
  runId: string;
  generatedAt: string;
  mode: "fixture" | "live";
  configDigest: string;
  receipts: Receipt[];
  daily: BriefingItem[];
  review: BriefingItem[];
}
