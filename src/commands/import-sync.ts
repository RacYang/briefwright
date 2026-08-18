import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadEffectiveConfig, canonicalJson } from "../config/load.js";
import { writeArtifactAtomic } from "../outputs/write.js";
import { controlPlaneFor, hydrateControlPlaneContext } from "../control-plane/registry.js";
import { auditLarkControlPlane, LarkControlPlaneStore, provisionLarkControlPlane } from "../control-plane/lark.js";
import type { CanonicalControlRecord, ControlEntityKind, SyncPlan } from "../control-plane/types.js";
import { validateControlRecords } from "../control-plane/contract.js";
import { SqliteStateStore } from "../state/sqlite.js";
import { projectStatus } from "./status.js";

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function historicalSourceEvidence(records: Iterable<CanonicalControlRecord>): Set<string> {
  const sourceIds = new Set<string>();
  for (const record of records) {
    if (record.kind !== "receipts" || typeof record.payload.source_snapshot_json !== "string") continue;
    try {
      const snapshot = JSON.parse(record.payload.source_snapshot_json) as Record<string, unknown>;
      const sourceId = typeof snapshot.id === "string" ? snapshot.id : undefined;
      if (!sourceId) continue;
      const payloadSourceId = typeof record.payload.source_id === "string" ? record.payload.source_id : undefined;
      const linkedSourceIds = record.links?.sources ?? [];
      if (payloadSourceId && payloadSourceId !== sourceId) continue;
      if (linkedSourceIds.length && !linkedSourceIds.includes(sourceId)) continue;
      sourceIds.add(sourceId);
    } catch { /* invalid historical snapshots are not deletion evidence */ }
  }
  return sourceIds;
}

export function remoteWithoutLocalEvidenceByKind(
  records: ReadonlyMap<string, CanonicalControlRecord>,
  remoteIds: Record<ControlEntityKind, string[]>,
): Record<ControlEntityKind, number> {
  const historicalSourceIds = historicalSourceEvidence(records.values());
  return Object.fromEntries((Object.keys(remoteIds) as ControlEntityKind[]).map((kind) => [kind, remoteIds[kind].filter((id) =>
    !records.has(`${kind}\n${id}`) && !(kind === "sources" && historicalSourceIds.has(id))).length])) as Record<ControlEntityKind, number>;
}

export async function importLarkSnapshot(configPath: string) {
  const config = await loadEffectiveConfig(configPath);
  if (config.controlPlane.driver !== "lark") throw new Error("import lark requires a configured Lark process store");
  const store = controlPlaneFor(config);
  try {
    const snapshot = await store.pull("full");
    validateControlRecords(snapshot.records);
    const content = `${canonicalJson({ apiVersion: "briefwright.dev/control-plane-snapshot/v1", driver: "lark", revision: snapshot.revision, records: snapshot.records })}\n`;
    const outputPath = path.join(config.projectRoot, ".briefwright", "imports", `lark-${snapshot.revision.slice(0, 12)}.json`);
    await writeArtifactAtomic(config.projectRoot, outputPath, content);
    const state = new SqliteStateStore(config.storage.path, config.projectRoot);
    let importedRecords = 0;
    try { importedRecords = state.importRemoteControlRecords(snapshot.records, snapshot.revision); } finally { state.close(); }
    return { outputPath, revision: snapshot.revision, sourceCount: snapshot.sources.length, ruleCount: snapshot.rules.length, recordCount: snapshot.records.length, importedRecords, contentDigest: digest(content) };
  } finally { await store.close(); }
}

export async function provisionLarkProject(configPath: string) {
  const config = await loadEffectiveConfig(configPath);
  if (config.controlPlane.driver !== "lark" || !config.controlPlane.lark) throw new Error("lark provision requires a configured Lark process store");
  const provisioned = provisionLarkControlPlane(config.controlPlane.lark);
  const store = controlPlaneFor(config);
  try {
    const checks = await store.doctor();
    return { ...provisioned, checks, ready: checks.every((check) => check.ok) };
  } finally { await store.close(); }
}

export async function auditLarkProject(configPath: string) {
  const config = await loadEffectiveConfig(configPath);
  if (config.controlPlane.driver !== "lark" || !config.controlPlane.lark) throw new Error("lark audit requires a configured Lark process store");
  return auditLarkControlPlane(config.controlPlane.lark);
}

export function assertBackfillAuthorization(
  actual: { digest: string; updates: number },
  expectedDigest?: string,
  expectedUpdates?: number,
): void {
  if (!expectedDigest || expectedUpdates === undefined) {
    throw new Error("lark backfill --apply requires --expect-digest and --expect-updates from the reviewed dry-run plan");
  }
  if (actual.digest !== expectedDigest) {
    throw new Error(`Lark backfill plan digest changed: expected ${expectedDigest}, got ${actual.digest}. No Base changes made.`);
  }
  if (actual.updates !== expectedUpdates) {
    throw new Error(`Lark backfill update count changed: expected ${expectedUpdates}, got ${actual.updates}. No Base changes made.`);
  }
}

export async function backfillLarkProject(
  configPath: string,
  apply: boolean,
  yes: boolean,
  expectedDigest?: string,
  expectedUpdates?: number,
) {
  if (apply && !yes) throw new Error("lark backfill --apply requires --yes");
  const loadedConfig = await loadEffectiveConfig(configPath);
  const config = (await hydrateControlPlaneContext(loadedConfig, { mode: "full" })).config;
  if (config.controlPlane.driver !== "lark" || !config.controlPlane.lark) throw new Error("lark backfill requires a configured Lark process store");
  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  const store = new LarkControlPlaneStore(config.controlPlane.lark);
  try {
    const records = new Map<string, CanonicalControlRecord>();
    for (const runId of state.runIds()) for (const record of state.controlRecords(config, runId)) records.set(`${record.kind}\n${record.id}`, record);
    const remoteIds = store.businessIds();
    const remoteSets = Object.fromEntries(Object.entries(remoteIds).map(([kind, ids]) => [kind, new Set(ids)])) as Record<ControlEntityKind, Set<string>>;
    const eligible = [...records.values()].filter((record) => remoteSets[record.kind].has(record.id));
    const plan = await store.plan(eligible, { includeCompatibility: true });
    if (plan.creates.length) throw new Error(`Lark backfill invariant failed: ${plan.creates.length} supposedly existing rows were planned as creates`);
    const countByKind = (values: CanonicalControlRecord[]) => Object.fromEntries((Object.keys(config.controlPlane.lark!.tables) as ControlEntityKind[]).map((kind) => [kind, values.filter((record) => record.kind === kind).length]));
    const migrationPlan: SyncPlan = { ...plan, creates: [], unchanged: [], conflicts: [] };
    const localOnly = [...records.values()].filter((record) => !remoteSets[record.kind].has(record.id));
    const historicalSourceIds = historicalSourceEvidence(records.values());
    const remoteSourcesWithHistoricalEvidence = remoteIds.sources
      .filter((id) => !records.has(`sources\n${id}`) && historicalSourceIds.has(id))
      .sort();
    const remoteWithoutLocalByKind = remoteWithoutLocalEvidenceByKind(records, remoteIds);
    const summary = {
      localEvidenceRecords: records.size,
      existingRemoteRecords: eligible.length,
      updates: plan.updates.length,
      updatesByKind: countByKind(plan.updates),
      localOnlySkipped: localOnly.length,
      localOnlySkippedByKind: countByKind(localOnly),
      remoteWithoutLocalByKind,
      remoteSourcesWithHistoricalEvidence,
      updateIds: plan.updates.map((record) => `${record.kind}:${record.id}`),
      digest: plan.digest,
    };
    if (!apply) return { applied: false as const, ...summary };
    assertBackfillAuthorization(summary, expectedDigest, expectedUpdates);
    return { applied: true as const, ...summary, result: await store.apply(migrationPlan) };
  } finally { state.close(); await store.close(); }
}

export async function importContract(configPath: string, contractPath: string) {
  const config = await loadEffectiveConfig(configPath); const source = path.resolve(contractPath);
  const content = await readFile(source, "utf8"); const parsed = JSON.parse(content) as Record<string, unknown>;
  if (!parsed.identity_contract || !parsed.run_contract || !parsed.obsidian_outputs) throw new Error("Contract is missing identity_contract, run_contract, or obsidian_outputs sections");
  const contentDigest = digest(content); const outputPath = path.join(config.projectRoot, ".briefwright", "imports", `contract-${contentDigest.slice(0, 12)}.json`);
  await writeArtifactAtomic(config.projectRoot, outputPath, `${canonicalJson({ apiVersion: "briefwright.dev/imported-contract/v1", sourceDigest: contentDigest, contract: parsed })}\n`);
  return { outputPath, source, contentDigest };
}

export async function syncProject(configPath: string, apply: boolean, yes: boolean, runId?: string) {
  if (apply && !yes) throw new Error("sync apply requires --yes");
  const loadedConfig = await loadEffectiveConfig(configPath);
  const config = (await hydrateControlPlaneContext(loadedConfig, { mode: "full" })).config;
  const status = await projectStatus(configPath);
  const selectedRunId = runId ?? status.latestRun?.runId;
  if (!selectedRunId) throw new Error("No local run exists to sync. Run a preview or formal run first.");
  const state = new SqliteStateStore(config.storage.path, config.projectRoot); const store = controlPlaneFor(config);
  try {
    const records = state.controlRecords(config, selectedRunId); const plan = await store.plan(records);
    if (!apply) return { applied: false, runId: selectedRunId, plan: { driver: plan.driver, creates: plan.creates.map((record) => `${record.kind}:${record.id}`), updates: plan.updates.map((record) => `${record.kind}:${record.id}`), unchanged: plan.unchanged.map((record) => `${record.kind}:${record.id}`), conflicts: plan.conflicts, digest: plan.digest } };
    return { applied: true, runId: selectedRunId, result: await store.apply(plan) };
  } finally { state.close(); await store.close(); }
}
