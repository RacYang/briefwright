import { createHash } from "node:crypto";

import { canonicalJson } from "../config/load.js";
import type { ControlPlaneCheck, ControlPlaneSnapshot, ControlPlaneStore, CanonicalControlRecord, SyncPlan, SyncResult } from "./types.js";

export class LocalSqliteControlPlane implements ControlPlaneStore {
  readonly driver = "sqlite" as const;
  async doctor(): Promise<ControlPlaneCheck[]> { return [{ name: "control-plane:sqlite", ok: true, detail: "Local SQLite fallback is active" }]; }
  async pull(_mode: "context" | "full" = "context"): Promise<ControlPlaneSnapshot> { return { revision: "local", sources: [], rules: [], feedback: [], records: [] }; }
  async plan(records: CanonicalControlRecord[]): Promise<SyncPlan> {
    return { driver: this.driver, creates: [], updates: [], unchanged: records, conflicts: [], digest: createHash("sha256").update(canonicalJson(records)).digest("hex") };
  }
  async apply(plan: SyncPlan): Promise<SyncResult> { return { driver: this.driver, created: 0, updated: 0, unchanged: plan.unchanged.length, failed: [], digest: plan.digest }; }
  async close(): Promise<void> {}
}
