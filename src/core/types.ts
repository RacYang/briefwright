export type ReceiptResult = "observed" | "updated" | "unchanged" | "failed" | "skipped";

export interface Receipt {
  sourceId: string;
  result: ReceiptResult;
  detail?: string;
  durationMs?: number;
}

export interface BriefingItem {
  id: string;
  sourceId: string;
  captureHash?: string;
  capturedAt?: string;
  publishedAt?: string;
  sourceExcerpt?: string;
  title: string;
  summary: string;
  whyItMatters: string;
  url: string;
  evidence: "primary" | "secondary" | "unverified";
  score: number;
  domain?: string;
  disposition?: "daily" | "review" | "machine-only";
  scoreDimensions?: Record<string, { value: number; weight: number; weighted: number; reason: string }>;
  claims?: string[];
  evidenceStatus?: "confirmed-primary" | "secondary-clue" | "unverified" | "inaccessible";
  knowledgePotential?: {
    reusableQuestion: boolean;
    mechanismIncrement: boolean;
    durableWithoutVersion: boolean;
    reason: string;
  };
  exclusionReasons?: string[];
}

export interface RunResult {
  runId: string;
  generatedAt: string;
  mode: "fixture" | "live";
  configDigest: string;
  receipts: Receipt[];
  dueSourceIds?: string[];
  daily: BriefingItem[];
  review: BriefingItem[];
  machineOnly?: BriefingItem[];
  runKind?: "preview" | "formal" | "formal-retry";
  ruleIds?: string[];
  modelFailures?: Array<{ captureId: string; sourceId: string; detail: string }>;
  stageTimings?: Record<string, number>;
  artifactStageTimings?: Record<string, number>;
  integrityValidated?: boolean;
  cadenceGovernance?: { evaluated: boolean; reason: string; proposals: string[]; activeOverrides?: Array<{ sourceId: string; hours: number; humanLocked: boolean; updatedAt: string }> };
  improvementGovernance?: { evaluated: boolean; reason: string; diagnosisId?: string; proposalCount: number };
  outcome?: "success" | "partial" | "failed";
  controlPlaneSync?: { driver: string; created: number; updated: number; unchanged: number; failed: Array<{ kind: string; id: string; detail: string }>; digest: string };
  controlPlaneReconciliation?: { driver: string; created: number; updated: number; unchanged: number; failed: Array<{ kind: string; id: string; detail: string }>; digest: string };
  completionReport?: {
    due: number; receipts: number; updated: number; unchanged: number; failed: number; skipped: number; missing: number; missingSourceIds: string[];
    discovered: number; captured: number; verified: number; deduplicated: number; scored: number; daily: number; review: number; eliminated: number; errors: number;
    domainCounts: Record<string, number>; topItemIds: string[]; ruleContractValid: boolean; processStoreValid: boolean; documentStoreValid: boolean;
    performance?: { sourceLatencyP50Ms: number; sourceLatencyP95Ms: number; captureThroughputPerSecond: number };
  };
  artifactPaths?: { daily: string; review: string };
}
