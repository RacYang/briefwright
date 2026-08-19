import { readFile } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, loadEffectiveConfig } from "../config/load.js";
import type { EffectiveConfig, SourceDefinition } from "../config/types.js";
import { connectorFor } from "../connectors/registry.js";
import { controlPlaneFor } from "../control-plane/registry.js";
import type { CanonicalControlRecord, ControlPlaneSnapshot, ControlPlaneStore, SyncPlan } from "../control-plane/types.js";

type SourceConnector = SourceDefinition["connector"];

export interface SourceMigrationDocument {
  apiVersion: "briefwright.dev/source-migration/v1";
  sources: Array<{ id: string; connector?: SourceConnector; enabled?: boolean }>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !(key in value));
  if (extras.length || missing.length) throw new Error(`${label} must contain exactly ${expected.join(", ")}${extras.length ? `; unexpected: ${extras.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
}

function connector(value: unknown, label: string): SourceConnector {
  const candidate = object(value, label); exactKeys(candidate, ["type", "config"], label);
  const config = object(candidate.config, `${label}.config`);
  switch (candidate.type) {
    case "rss":
    case "webpage": {
      exactKeys(config, ["url"], `${label}.config`);
      if (typeof config.url !== "string") throw new Error(`${label}.config.url must be an HTTPS URL`);
      const url = new URL(config.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${label}.config.url must be a clean HTTPS URL`);
      return { type: candidate.type, config: { url: config.url } };
    }
    case "computer-use":
    case "in-app-browser": {
      const allowed = ["url", "allowedHosts"]; const extras = Object.keys(config).filter((key) => !allowed.includes(key));
      if (extras.length || !("url" in config)) throw new Error(`${label}.config may contain only url and allowedHosts`);
      if (typeof config.url !== "string") throw new Error(`${label}.config.url must be an HTTPS URL`);
      const url = new URL(config.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${label}.config.url must be a clean HTTPS URL`);
      if (config.allowedHosts !== undefined && (!Array.isArray(config.allowedHosts) || config.allowedHosts.some((host) => typeof host !== "string" || !host))) throw new Error(`${label}.config.allowedHosts must be a non-empty string array`);
      if (Array.isArray(config.allowedHosts) && !config.allowedHosts.map((host) => String(host).toLowerCase()).includes(url.hostname.toLowerCase())) throw new Error(`${label}.config.allowedHosts must include the entry URL host`);
      return { type: candidate.type, config: { url: config.url, ...(config.allowedHosts ? { allowedHosts: [...new Set(config.allowedHosts as string[])] } : {}) } } as SourceConnector;
    }
    case "github-releases": {
      exactKeys(config, ["repository"], `${label}.config`);
      if (typeof config.repository !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(config.repository)) throw new Error(`${label}.config.repository must be owner/repository`);
      return { type: "github-releases", config: { repository: config.repository } };
    }
    default: throw new Error(`${label}.type is not supported by governed source migration: ${String(candidate.type)}`);
  }
}

export function parseSourceMigration(value: unknown): SourceMigrationDocument {
  const document = object(value, "source migration"); exactKeys(document, ["apiVersion", "sources"], "source migration");
  if (document.apiVersion !== "briefwright.dev/source-migration/v1") throw new Error("Unsupported source migration apiVersion");
  if (!Array.isArray(document.sources) || document.sources.length === 0) throw new Error("source migration sources must be a non-empty array");
  const sources = document.sources.map((value, index) => {
    const entry = object(value, `sources[${index}]`);
    const extras = Object.keys(entry).filter((key) => !["id", "connector", "enabled"].includes(key));
    if (extras.length) throw new Error(`sources[${index}] contains unexpected keys: ${extras.join(", ")}`);
    if (typeof entry.id !== "string" || !entry.id.trim()) throw new Error(`sources[${index}].id must be a non-empty string`);
    if (entry.connector === undefined && entry.enabled === undefined) throw new Error(`sources[${index}] must change connector or enabled`);
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") throw new Error(`sources[${index}].enabled must be a boolean`);
    return { id: entry.id,
      ...(entry.connector === undefined ? {} : { connector: connector(entry.connector, `sources[${index}].connector`) }),
      ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }) };
  });
  const duplicate = sources.find((entry, index) => sources.findIndex((candidate) => candidate.id === entry.id) !== index);
  if (duplicate) throw new Error(`Duplicate source migration ID: ${duplicate.id}`);
  return { apiVersion: "briefwright.dev/source-migration/v1", sources };
}

export function sourceMigrationRecords(_config: EffectiveConfig, snapshot: ControlPlaneSnapshot, migration: SourceMigrationDocument): CanonicalControlRecord[] {
  const byId = new Map(snapshot.records.filter((record) => record.kind === "sources").map((record) => [record.id, record]));
  const missing = migration.sources.filter((entry) => !byId.has(entry.id)).map((entry) => entry.id);
  if (missing.length) throw new Error(`Source migration targets were not found by stable business ID: ${missing.join(", ")}`);
  return migration.sources.map((entry) => {
    const current = byId.get(entry.id)!;
    const payload = { ...current.payload,
      ...(entry.connector ? { connector: entry.connector } : {}),
      ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }) };
    return { ...current, payload: { ...payload,
      ...(entry.connector ? { connector_version: connectorFor(payload as unknown as SourceDefinition).descriptor.version } : {}) } };
  });
}

function summarize(plan: SyncPlan, migration: SourceMigrationDocument) {
  const targets = new Map(migration.sources.map((entry) => [entry.id, entry]));
  const summary = (records: CanonicalControlRecord[]) => records.map((record) => ({ id: record.id, ...targets.get(record.id) }));
  return { driver: plan.driver, creates: summary(plan.creates), updates: summary(plan.updates), unchanged: summary(plan.unchanged), conflicts: plan.conflicts, digest: plan.digest };
}

export function assertSourceMigrationAuthorization(
  actual: { digest: string; updates: number },
  expectedDigest?: string,
  expectedUpdates?: number,
): void {
  if (!expectedDigest || expectedUpdates === undefined) {
    throw new Error("sync sources apply requires --expect-digest and --expect-updates from the reviewed dry-run plan");
  }
  if (actual.digest !== expectedDigest) {
    throw new Error(`Source migration plan digest changed: expected ${expectedDigest}, got ${actual.digest}. No Base changes made.`);
  }
  if (actual.updates !== expectedUpdates) {
    throw new Error(`Source migration update count changed: expected ${expectedUpdates}, got ${actual.updates}. No Base changes made.`);
  }
}

export function assertSourceMigrationPostApplyClean(plan: SyncPlan): void {
  if (plan.creates.length || plan.updates.length || plan.conflicts.length) {
    throw new Error(`Source migration post-apply plan is not clean: creates=${plan.creates.length}, updates=${plan.updates.length}, conflicts=${plan.conflicts.length}`);
  }
}

export async function migrateSources(configPath: string, migrationPath: string, apply: boolean, yes: boolean,
  options: { store?: ControlPlaneStore; expectedDigest?: string; expectedUpdates?: number } = {}) {
  if (apply && !yes) throw new Error("sync sources apply requires --yes");
  const config = await loadEffectiveConfig(configPath);
  if (config.controlPlane.driver !== "lark") throw new Error("governed source migration currently requires a configured Lark process store");
  const source = path.resolve(migrationPath);
  const migration = parseSourceMigration(JSON.parse(await readFile(source, "utf8")));
  const store = options.store ?? controlPlaneFor(config);
  try {
    const snapshot = await store.pull("context");
    const records = sourceMigrationRecords(config, snapshot, migration);
    const plan = await store.plan(records);
    if (plan.creates.length || plan.conflicts.length) throw new Error(`Source migration plan is unsafe: creates=${plan.creates.length}, conflicts=${plan.conflicts.length}`);
    if (!apply) return { applied: false, source, revision: snapshot.revision, plan: summarize(plan, migration) };
    assertSourceMigrationAuthorization({ digest: plan.digest, updates: plan.updates.length }, options.expectedDigest, options.expectedUpdates);
    const result = await store.apply(plan);
    if (!result.acknowledged || result.failed.length) throw new Error(`Source migration write was not acknowledged: ${result.failed.map((failure) => `${failure.id}: ${failure.detail}`).join("; ") || "readback acknowledgement missing"}`);
    const readback = await store.pull("context");
    const actual = new Map(readback.records.filter((record) => record.kind === "sources").map((record) => [record.id, record]));
    const mismatches = migration.sources.filter((entry) => {
      const payload = actual.get(entry.id)?.payload;
      return (entry.connector !== undefined && canonicalJson(payload?.connector) !== canonicalJson(entry.connector))
        || (entry.enabled !== undefined && payload?.enabled !== entry.enabled);
    }).map((entry) => entry.id);
    if (mismatches.length) throw new Error(`Source migration post-apply readback mismatch: ${mismatches.join(", ")}`);
    const postApply = await store.plan(sourceMigrationRecords(config, readback, migration));
    assertSourceMigrationPostApplyClean(postApply);
    return { applied: true, source, beforeRevision: snapshot.revision, readbackRevision: readback.revision,
      targets: migration.sources.map((entry) => ({ id: entry.id, connector: entry.connector })), result,
      postApply: { creates: 0, updates: 0, conflicts: 0, digest: postApply.digest } };
  } finally { if (!options.store) await store.close(); }
}
