import { loadEffectiveConfig } from "../config/load.js";
import { SqliteStateStore } from "../state/sqlite.js";

export const FEEDBACK_TYPES = ["reviewed", "used", "ignored", "knowledge-worthy", "include", "skip", "review", "compare", "classification-correction", "score-correction", "source-correction", "process-feedback"] as const;
export type FeedbackType = typeof FEEDBACK_TYPES[number];

export async function addProjectFeedback(configPath: string, itemId: string, type: FeedbackType, note?: string) {
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try { return store.addFeedback(itemId, type, note); } finally { store.close(); }
}

export async function projectFeedbackSummary(configPath: string) {
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try { return store.feedbackSummary(); } finally { store.close(); }
}
