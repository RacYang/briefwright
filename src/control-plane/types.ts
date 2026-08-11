import type { EffectiveConfig, RuleSnapshot, SourceDefinition } from "../config/types.js";

export type ControlEntityKind = "sources" | "runs" | "items" | "events" | "feedback" | "experiments" | "captures" | "rules" | "receipts";

export interface CanonicalControlRecord {
  kind: ControlEntityKind;
  id: string;
  payload: Record<string, unknown>;
  links?: Partial<Record<ControlEntityKind, string[]>>;
  updatedAt?: string;
  storeRecordId?: string;
}

export interface ControlPlaneSnapshot {
  revision: string;
  sources: SourceDefinition[];
  rules: RuleSnapshot[];
  feedback: CanonicalControlRecord[];
  records: CanonicalControlRecord[];
}

export interface ControlPlaneCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SyncConflict {
  kind: ControlEntityKind;
  id: string;
  reason: string;
}

export interface SyncPlan {
  driver: EffectiveConfig["controlPlane"]["driver"];
  creates: CanonicalControlRecord[];
  updates: CanonicalControlRecord[];
  unchanged: CanonicalControlRecord[];
  conflicts: SyncConflict[];
  digest: string;
}

export interface SyncResult {
  driver: EffectiveConfig["controlPlane"]["driver"];
  created: number;
  updated: number;
  unchanged: number;
  failed: Array<{ kind: ControlEntityKind; id: string; detail: string }>;
  digest: string;
}

export interface ControlPlaneStore {
  readonly driver: EffectiveConfig["controlPlane"]["driver"];
  doctor(): Promise<ControlPlaneCheck[]>;
  pull(mode?: "context" | "full"): Promise<ControlPlaneSnapshot>;
  plan(records: CanonicalControlRecord[]): Promise<SyncPlan>;
  apply(plan: SyncPlan): Promise<SyncResult>;
  close(): Promise<void>;
}
