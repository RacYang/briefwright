import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadEffectiveConfig, canonicalJson } from "../config/load.js";
import { writeArtifactAtomic } from "../outputs/write.js";
import { controlPlaneFor, hydrateControlPlaneContext } from "../control-plane/registry.js";
import { auditLarkControlPlane, LarkControlPlaneStore, provisionLarkControlPlane } from "../control-plane/lark.js";
import type { CanonicalControlRecord, ControlEntityKind, SyncPlan, SyncResult } from "../control-plane/types.js";
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

export function mergeCanonicalControlRecords(existing: CanonicalControlRecord, incoming: CanonicalControlRecord): CanonicalControlRecord {
  if (existing.kind !== incoming.kind || existing.id !== incoming.id) throw new Error("Cannot merge different canonical control records");
  const linkKinds = new Set([...Object.keys(existing.links ?? {}), ...Object.keys(incoming.links ?? {})] as ControlEntityKind[]);
  const links = Object.fromEntries([...linkKinds].flatMap((kind) => {
    const ids = [...new Set([...(existing.links?.[kind] ?? []), ...(incoming.links?.[kind] ?? [])])];
    return ids.length ? [[kind, ids]] : [];
  })) as CanonicalControlRecord["links"];
  return { ...existing, ...incoming, payload: incoming.payload, ...(links && Object.keys(links).length ? { links } : {}) };
}

export function filterCanonicalLinksToRemote(
  record: CanonicalControlRecord,
  remoteSets: Record<ControlEntityKind, Set<string>>,
): { record: CanonicalControlRecord; skipped: Array<{ relation: ControlEntityKind; id: string }> } {
  const skipped: Array<{ relation: ControlEntityKind; id: string }> = [];
  const links = Object.fromEntries(Object.entries(record.links ?? {}).flatMap(([kind, ids]) => {
    const relation = kind as ControlEntityKind;
    const retained = (ids ?? []).filter((id) => {
      const exists = remoteSets[relation].has(id);
      if (!exists) skipped.push({ relation, id });
      return exists;
    });
    return retained.length ? [[relation, retained]] : [];
  })) as CanonicalControlRecord["links"];
  const { links: _originalLinks, ...withoutLinks } = record;
  return { record: { ...withoutLinks, ...(links && Object.keys(links).length ? { links } : {}) }, skipped };
}

export function prepareLarkBackfillEvidence(
  recordSets: Iterable<Iterable<CanonicalControlRecord>>,
  remoteIds: Record<ControlEntityKind, string[]>,
): {
  records: Map<string, CanonicalControlRecord>;
  eligible: CanonicalControlRecord[];
  localOnly: CanonicalControlRecord[];
  remoteWithoutLocalByKind: Record<ControlEntityKind, number>;
  remoteSourcesWithHistoricalEvidence: string[];
  skippedMissingRemoteLinkTargets: string[];
} {
  const records = new Map<string, CanonicalControlRecord>();
  for (const recordSet of recordSets) for (const record of recordSet) {
    const key = `${record.kind}\n${record.id}`;
    const existing = records.get(key);
    records.set(key, existing ? mergeCanonicalControlRecords(existing, record) : record);
  }
  const remoteSets = Object.fromEntries(Object.entries(remoteIds).map(([kind, ids]) => [kind, new Set(ids)])) as Record<ControlEntityKind, Set<string>>;
  const skippedMissingRemoteLinkTargets: string[] = [];
  const eligible = [...records.values()].filter((record) => remoteSets[record.kind].has(record.id)).map((record) => {
    const filtered = filterCanonicalLinksToRemote(record, remoteSets);
    for (const skipped of filtered.skipped) skippedMissingRemoteLinkTargets.push(`${record.kind}:${record.id}->${skipped.relation}:${skipped.id}`);
    return filtered.record;
  });
  const localOnly = [...records.values()].filter((record) => !remoteSets[record.kind].has(record.id));
  const historicalSourceIds = historicalSourceEvidence(records.values());
  const remoteSourcesWithHistoricalEvidence = remoteIds.sources
    .filter((id) => !records.has(`sources\n${id}`) && historicalSourceIds.has(id))
    .sort();
  return {
    records,
    eligible,
    localOnly,
    remoteWithoutLocalByKind: remoteWithoutLocalEvidenceByKind(records, remoteIds),
    remoteSourcesWithHistoricalEvidence,
    skippedMissingRemoteLinkTargets: skippedMissingRemoteLinkTargets.sort(),
  };
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
  const loadedConfig = await loadEffectiveConfig(configPath);
  const config = (await hydrateControlPlaneContext(loadedConfig, { mode: "full" })).config;
  if (config.controlPlane.driver !== "lark" || !config.controlPlane.lark) throw new Error("lark audit requires a configured Lark process store");
  const schema = auditLarkControlPlane(config.controlPlane.lark);
  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  const store = new LarkControlPlaneStore(config.controlPlane.lark);
  try {
    const remoteIds = store.businessIds();
    const evidence = prepareLarkBackfillEvidence(state.formalRunIds().map((runId) => state.controlRecords(config, runId)), remoteIds);
    const plan = await store.plan(evidence.eligible, { includeCompatibility: true });
    const remoteWithoutLocal = Object.values(evidence.remoteWithoutLocalByKind).reduce((sum, count) => sum + count, 0);
    const dataReconciliation = {
      ready: plan.creates.length === 0 && plan.updates.length === 0 && plan.conflicts.length === 0 && remoteWithoutLocal === 0,
      expectedRecords: evidence.eligible.length,
      pendingUpdates: plan.updates.length,
      pendingUpdateIds: plan.updates.map((record) => `${record.kind}:${record.id}`),
      unexpectedCreates: plan.creates.length,
      conflicts: plan.conflicts,
      remoteWithoutLocalByKind: evidence.remoteWithoutLocalByKind,
      skippedMissingRemoteLinks: evidence.skippedMissingRemoteLinkTargets.length,
      skippedMissingRemoteLinkTargets: evidence.skippedMissingRemoteLinkTargets,
      digest: plan.digest,
    };
    return { ...schema, ready: schema.ready && dataReconciliation.ready, schemaReady: schema.ready, dataReconciliation };
  } finally { state.close(); await store.close(); }
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

export function assertBackfillAcknowledged(result: SyncResult): void {
  if (!result.acknowledged || result.failed.length) {
    throw new Error(`Lark backfill write was not acknowledged: ${result.failed.map((failure) => `${failure.kind}:${failure.id}: ${failure.detail}`).join("; ") || "canonical readback acknowledgement missing"}`);
  }
}

export function assertBackfillPostApplyClean(plan: SyncPlan): void {
  if (plan.creates.length || plan.updates.length || plan.conflicts.length) {
    throw new Error(`Lark backfill post-apply plan is not clean: creates=${plan.creates.length}, updates=${plan.updates.length}, conflicts=${plan.conflicts.length}`);
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
    const remoteIds = store.businessIds();
    const evidence = prepareLarkBackfillEvidence(state.formalRunIds().map((runId) => state.controlRecords(config, runId)), remoteIds);
    const plan = await store.plan(evidence.eligible, { includeCompatibility: true });
    if (plan.creates.length) throw new Error(`Lark backfill invariant failed: ${plan.creates.length} supposedly existing rows were planned as creates`);
    const countByKind = (values: CanonicalControlRecord[]) => Object.fromEntries((Object.keys(config.controlPlane.lark!.tables) as ControlEntityKind[]).map((kind) => [kind, values.filter((record) => record.kind === kind).length]));
    const migrationPlan: SyncPlan = { ...plan, creates: [], unchanged: [], conflicts: [] };
    const summary = {
      localEvidenceRecords: evidence.records.size,
      existingRemoteRecords: evidence.eligible.length,
      updates: plan.updates.length,
      updatesByKind: countByKind(plan.updates),
      localOnlySkipped: evidence.localOnly.length,
      localOnlySkippedByKind: countByKind(evidence.localOnly),
      remoteWithoutLocalByKind: evidence.remoteWithoutLocalByKind,
      remoteSourcesWithHistoricalEvidence: evidence.remoteSourcesWithHistoricalEvidence,
      skippedMissingRemoteLinks: evidence.skippedMissingRemoteLinkTargets.length,
      skippedMissingRemoteLinkTargets: evidence.skippedMissingRemoteLinkTargets,
      updateIds: plan.updates.map((record) => `${record.kind}:${record.id}`),
      digest: plan.digest,
    };
    if (!apply) return { applied: false as const, ...summary };
    assertBackfillAuthorization(summary, expectedDigest, expectedUpdates);
    const result = await store.apply(migrationPlan);
    assertBackfillAcknowledged(result);
    const postApply = await store.plan(evidence.eligible, { includeCompatibility: true });
    assertBackfillPostApplyClean(postApply);
    return { applied: true as const, ...summary, result, postApply: { updates: 0, creates: 0, conflicts: 0, digest: postApply.digest } };
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
