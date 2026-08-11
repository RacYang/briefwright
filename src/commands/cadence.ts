import { loadEffectiveConfig } from "../config/load.js";
import { evaluateCadence } from "../core/cadence.js";
import { SqliteStateStore } from "../state/sqlite.js";

export async function evaluateProjectCadence(configPath: string, now = new Date()) {
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try { return evaluateCadence(config, store, now); } finally { store.close(); }
}

export async function listCadenceProposals(configPath: string) {
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try { return store.cadenceProposals(); } finally { store.close(); }
}

export async function decideProjectCadence(configPath: string, id: string, decision: "approve" | "reject") {
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try { store.decideCadenceProposal(id, decision); return { id, status: decision === "approve" ? "approved" : "rejected" }; } finally { store.close(); }
}

export async function lockSourceCadence(configPath: string, sourceId: string, locked: boolean) {
  const config = await loadEffectiveConfig(configPath);
  const source = config.preset.sources.find((item) => item.id === sourceId);
  if (!source) throw new Error(`Unknown source: ${sourceId}`);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try { store.setSourceCadenceLock(sourceId, locked, source.cadence?.defaultHours ?? 24); return { sourceId, locked }; } finally { store.close(); }
}
