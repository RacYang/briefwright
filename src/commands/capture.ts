import path from "node:path";

import { hydrateFromControlPlane } from "../control-plane/registry.js";
import { loadEffectiveConfig } from "../config/load.js";
import { loadExternalCaptureBundle } from "../connectors/external-bundle.js";
import { isExternalCaptureSource } from "../connectors/external-bundle.js";
import { computerUseAllowedHosts } from "../connectors/computer-use.js";
import { isComputerUseSource } from "../connectors/computer-use.js";
import { isCodexBrowserSource } from "../connectors/codex-browser.js";
import { inAppBrowserAllowedHosts, isInAppBrowserSource } from "../connectors/in-app-browser.js";
import { SqliteStateStore } from "../state/sqlite.js";

function day(now: Date): string { return now.toISOString().slice(0, 10); }

export async function externalCaptureManifest(configPath: string, now = new Date()) {
  const config = await hydrateFromControlPlane(await loadEffectiveConfig(configPath));
  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  let due;
  try { due = state.dueSources(config.preset.sources, now, config.policy.domains); } finally { state.close(); }
  const sources: Array<{
    sourceId: string;
    captureMode: "codex-browser" | "in-app-browser" | "computer-use";
    entryUrl: string;
    allowedHosts: string[];
    interactionPolicy: "public-read-only";
    reason: string;
    lastScanAt: string | null;
  }> = [];
  for (const entry of due) {
    const source = entry.source;
    if (!isExternalCaptureSource(source)) continue;
    if (isCodexBrowserSource(source)) sources.push({
      sourceId: source.id,
      captureMode: "codex-browser" as const,
      entryUrl: `https://x.com/${source.connector.config.username}`,
      allowedHosts: ["x.com", "twitter.com"],
      interactionPolicy: "public-read-only" as const,
      reason: entry.reason,
      lastScanAt: source.scheduleState?.lastScanAt ?? null,
    });
    else if (isInAppBrowserSource(source)) sources.push({
        sourceId: source.id,
        captureMode: "in-app-browser" as const,
        entryUrl: source.connector.config.url,
        allowedHosts: inAppBrowserAllowedHosts(source),
        interactionPolicy: "public-read-only" as const,
        reason: entry.reason,
        lastScanAt: source.scheduleState?.lastScanAt ?? null,
      });
    else if (isComputerUseSource(source)) sources.push({
        sourceId: source.id,
        captureMode: "computer-use" as const,
        entryUrl: source.connector.config.url,
        allowedHosts: computerUseAllowedHosts(source),
        interactionPolicy: "public-read-only" as const,
        reason: entry.reason,
        lastScanAt: source.scheduleState?.lastScanAt ?? null,
      });
  }
  return {
    apiVersion: "briefwright.dev/external-capture-manifest/v1",
    generatedAt: now.toISOString(),
    bundlePath: path.join(config.projectRoot, ".briefwright", "inbox", `external-${day(now)}.json`),
    policy: { credentials: "forbidden", interactions: "forbidden", navigation: "https-allowlisted-hosts-only" },
    sources,
  };
}

export async function validateExternalCaptureFile(configPath: string, bundlePath: string, now = new Date()) {
  const config = await hydrateFromControlPlane(await loadEffectiveConfig(configPath));
  const bundle = await loadExternalCaptureBundle(config, bundlePath, now);
  return { valid: true, sourceCount: bundle.size, captured: [...bundle.values()].reduce((sum, entry) => sum + entry.captures.length, 0),
    unchanged: [...bundle.values()].filter((entry) => entry.status === "unchanged").length, failed: [...bundle.values()].filter((entry) => entry.status === "failed").map((entry) => entry.sourceId) };
}
