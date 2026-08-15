import type { EffectiveConfig } from "../config/types.js";
import { canonicalJson, validateEffectiveConfig } from "../config/load.js";
import { LarkControlPlaneStore } from "./lark.js";
import type { LarkRunner } from "./lark-cli.js";
import { LocalSqliteControlPlane } from "./sqlite.js";
import { MysqlControlPlane, PostgresControlPlane } from "./sql.js";
import type { ControlPlaneSnapshot, ControlPlaneStore } from "./types.js";
import type { CanonicalControlRecord, SyncResult } from "./types.js";
import { validateControlRecords } from "./contract.js";

export function controlPlaneFor(config: EffectiveConfig, options: { larkRunner?: LarkRunner } = {}): ControlPlaneStore {
  if (config.controlPlane.driver === "sqlite") return new LocalSqliteControlPlane();
  if (config.controlPlane.driver === "lark" && config.controlPlane.lark) return new LarkControlPlaneStore(config.controlPlane.lark, options.larkRunner);
  if (config.controlPlane.driver === "postgres") return new PostgresControlPlane(config);
  if (config.controlPlane.driver === "mysql") return new MysqlControlPlane(config);
  throw new Error(`Control-plane adapter '${config.controlPlane.driver}' is not configured`);
}

export async function syncToControlPlane(config: EffectiveConfig, records: CanonicalControlRecord[], options: { larkRunner?: LarkRunner } = {}): Promise<SyncResult> {
  validateControlRecords(records);
  const store = controlPlaneFor(config, options);
  try { const plan = await store.plan(records); return await store.apply(plan); }
  finally { await store.close(); }
}

export function reconciliationRecords(
  current: CanonicalControlRecord[],
  attempted: CanonicalControlRecord[],
  failed: SyncResult["failed"],
): CanonicalControlRecord[] {
  const key = (record: Pick<CanonicalControlRecord, "kind" | "id">) => `${record.kind}\n${record.id}`;
  const attemptedByKey = new Map(attempted.map((record) => [key(record), record]));
  const failedKeys = new Set(failed.map(key));
  return current.filter((record) => {
    const recordKey = key(record);
    const previous = attemptedByKey.get(recordKey);
    return failedKeys.has(recordKey) || !previous || canonicalJson({ payload: previous.payload, links: previous.links ?? {} }) !== canonicalJson({ payload: record.payload, links: record.links ?? {} });
  });
}

export async function hydrateFromControlPlane(config: EffectiveConfig, options: { larkRunner?: LarkRunner } = {}): Promise<EffectiveConfig> {
  return (await hydrateControlPlaneContext(config, options)).config;
}

export async function hydrateControlPlaneContext(config: EffectiveConfig, options: { larkRunner?: LarkRunner; mode?: "context" | "full" } = {}): Promise<{ config: EffectiveConfig; snapshot: ControlPlaneSnapshot }> {
  if (config.controlPlane.driver === "sqlite") return { config, snapshot: { revision: "local", sources: [], rules: [], feedback: [], records: [] } };
  const store = controlPlaneFor(config, options);
  try {
    const snapshot = await store.pull(options.mode ?? "context");
    validateControlRecords(snapshot.records);
    const next = structuredClone(config);
    if (snapshot.sources.length) next.preset.sources = snapshot.sources;
    if (snapshot.rules.length) {
      const expected = [...config.policy.rules.map((rule) => rule.id)].sort();
      const actual = [...snapshot.rules.map((rule) => rule.id)].sort();
      if (expected.join("\n") !== actual.join("\n")) throw new Error(`Active control-plane rules do not match packaged policy: expected ${expected.join(", ")}; got ${actual.join(", ")}`);
    }
    next.provenance.controlPlaneRevision = snapshot.revision;
    next.origins.preset = `${config.controlPlane.driver} control plane`;
    validateEffectiveConfig(next);
    return { config: next, snapshot };
  } finally { await store.close(); }
}
