import { loadEffectiveConfig } from "../config/load.js";
import { SqliteStateStore } from "../state/sqlite.js";

export async function diagnoseProject(configPath: string, windowDays = 30) {
  if (!Number.isInteger(windowDays) || windowDays < 7 || windowDays > 365) throw new Error("Improvement window must be an integer from 7 to 365 days");
  const config = await loadEffectiveConfig(configPath); const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try { return store.diagnoseImprovements(new Date(), windowDays, config.policy.domains); } finally { store.close(); }
}
export async function listImprovementProposals(configPath: string) {
  const config = await loadEffectiveConfig(configPath); const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try { return store.improvementProposals(); } finally { store.close(); }
}
