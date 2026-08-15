import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadEffectiveConfig, canonicalJson } from "../config/load.js";
import { writeArtifactAtomic } from "../outputs/write.js";
import { controlPlaneFor, hydrateControlPlaneContext } from "../control-plane/registry.js";
import { provisionLarkControlPlane } from "../control-plane/lark.js";
import { validateControlRecords } from "../control-plane/contract.js";
import { SqliteStateStore } from "../state/sqlite.js";
import { projectStatus } from "./status.js";

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

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
