import path from "node:path";

import { hydrateFromControlPlane } from "../control-plane/registry.js";
import { loadEffectiveConfig } from "../config/load.js";
import { loadExternalCaptureBundle } from "../connectors/external-bundle.js";
import { SqliteStateStore } from "../state/sqlite.js";

function day(now: Date): string { return now.toISOString().slice(0, 10); }

export async function externalCaptureManifest(configPath: string, now = new Date()) {
  const config = await hydrateFromControlPlane(await loadEffectiveConfig(configPath));
  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  let due;
  try { due = state.dueSources(config.preset.sources, now, config.policy.domains); } finally { state.close(); }
  const sources = due.filter((entry) => entry.source.connector.type === "codex-browser").map((entry) => ({ sourceId: entry.source.id,
    username: entry.source.connector.type === "codex-browser" ? entry.source.connector.config.username : "", profileUrl: entry.source.connector.type === "codex-browser" ? `https://x.com/${entry.source.connector.config.username}` : "",
    reason: entry.reason, lastScanAt: entry.source.scheduleState?.lastScanAt ?? null }));
  return { apiVersion: "briefwright.dev/external-capture-manifest/v1", generatedAt: now.toISOString(), bundlePath: path.join(config.projectRoot, ".briefwright", "inbox", `x-${day(now)}.json`), sources };
}

export async function validateExternalCaptureFile(configPath: string, bundlePath: string, now = new Date()) {
  const config = await hydrateFromControlPlane(await loadEffectiveConfig(configPath));
  const bundle = await loadExternalCaptureBundle(config, bundlePath, now);
  return { valid: true, sourceCount: bundle.size, captured: [...bundle.values()].reduce((sum, entry) => sum + entry.captures.length, 0),
    unchanged: [...bundle.values()].filter((entry) => entry.status === "unchanged").length, failed: [...bundle.values()].filter((entry) => entry.status === "failed").map((entry) => entry.sourceId) };
}
