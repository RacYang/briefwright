export type ReceiptResult = "observed" | "updated" | "unchanged" | "failed" | "skipped";

export interface Receipt {
  sourceId: string;
  result: ReceiptResult;
  detail?: string;
}

export interface BriefingItem {
  id: string;
  sourceId: string;
  captureHash?: string;
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
  daily: BriefingItem[];
  review: BriefingItem[];
  machineOnly?: BriefingItem[];
  runKind?: "preview" | "formal" | "formal-retry";
  ruleIds?: string[];
  modelFailures?: Array<{ captureId: string; sourceId: string; detail: string }>;
  stageTimings?: Record<string, number>;
  artifactStageTimings?: Record<string, number>;
  integrityValidated?: boolean;
  cadenceGovernance?: { evaluated: boolean; reason: string; proposals: string[] };
  outcome?: "success" | "partial" | "failed";
}
