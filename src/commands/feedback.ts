import { loadEffectiveConfig } from "../config/load.js";
import { SqliteStateStore } from "../state/sqlite.js";

export async function addProjectFeedback(configPath: string, itemId: string, type: "reviewed" | "used" | "ignored" | "knowledge-worthy", note?: string) {
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try { return store.addFeedback(itemId, type, note); } finally { store.close(); }
}

export async function projectFeedbackSummary(configPath: string) {
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try { return store.feedbackSummary(); } finally { store.close(); }
}
