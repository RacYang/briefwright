import { createHash } from "node:crypto";
import path from "node:path";

import { loadEffectiveConfig } from "../config/load.js";
import { createFixtureRun } from "../core/fixture.js";
import { createLiveRun } from "../core/live.js";
import { countReceipts, runOutcome, type FormalRunOutcome, type ReceiptCounts } from "../core/accounting.js";
import type { Receipt } from "../core/types.js";
import type { ModelProvider } from "../providers/types.js";
import { renderMarkdown } from "../outputs/markdown.js";
import { writeArtifactSetAtomic } from "../outputs/write.js";
import { SqliteStateStore } from "../state/sqlite.js";
import type { ConnectorContext } from "../connectors/types.js";
import { hydrateFromControlPlane } from "../control-plane/registry.js";
import { loadExternalCaptureBundle } from "../connectors/external-bundle.js";

export interface PreviewResult {
  outputPath: string;
  itemCount: number;
  receiptCount: number;
  mode: "fixture" | "live";
  previewKind: "fixture" | "source" | "editorial";
  previewScope: "configured-due" | "capture-bundle";
  outcome: FormalRunOutcome;
  counts: ReceiptCounts;
  failedReceipts: Receipt[];
  modelFailures: NonNullable<import("../core/types.js").RunResult["modelFailures"]>;
  analyzedCount: number;
  selected: { daily: number; review: number; machineOnly: number };
}

export async function previewProject(
  configPath: string,
  options: { live?: boolean; editorial?: boolean; bundleOnly?: boolean; historicalBundle?: boolean; fetch?: ConnectorContext["fetch"]; captureBundlePath?: string; provider?: ModelProvider; analysisLimit?: number } = {},
): Promise<PreviewResult & { mode: "fixture" | "live" }> {
  if (options.captureBundlePath && !options.live) throw new Error("External capture bundles can only be used with --live preview");
  if (options.editorial && !options.live) throw new Error("Editorial shadow preview requires --live");
  if (options.bundleOnly && !options.captureBundlePath) throw new Error("Bundle-only preview requires --capture-bundle");
  if (options.bundleOnly && !options.editorial) throw new Error("Bundle-only preview requires --editorial");
  if (options.historicalBundle && (!options.live || !options.editorial || !options.bundleOnly || !options.captureBundlePath)) {
    throw new Error("Historical bundles are allowed only for live editorial bundle-only previews");
  }
  const loaded = await loadEffectiveConfig(configPath);
  const config = options.live ? await hydrateFromControlPlane(loaded) : loaded;
  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    const externalCaptures = options.captureBundlePath
      ? await loadExternalCaptureBundle(config, options.captureBundlePath, new Date(), { allowStale: options.historicalBundle === true })
      : undefined;
    const dueSources = options.live
      ? options.bundleOnly
        ? config.preset.sources.filter((source) => externalCaptures?.has(source.id))
        : state.dueSources(config.preset.sources, new Date(), config.policy.domains).map((entry) => entry.source)
      : config.preset.sources;
    const result = options.live ? await createLiveRun(config, new Date(), options.fetch, dueSources, externalCaptures, {
      ...(options.editorial !== undefined ? { editorial: options.editorial } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.analysisLimit !== undefined ? { analysisLimit: options.analysisLimit } : {}),
    }) : createFixtureRun(config);
    result.previewScope = options.bundleOnly ? "capture-bundle" : "configured-due";
    const markdown = renderMarkdown(config, result);
    const outputPath = path.join(config.projectRoot, ".briefwright", "previews", `${result.runId}.md`);
    const counts = countReceipts(dueSources.map((source) => source.id), result.receipts);
    state.assertRunWritable(result);
    await writeArtifactSetAtomic(config.projectRoot, [{ path: outputPath, content: markdown }], () => state.saveRun(config, result, {
        kind: "preview-markdown",
        path: outputPath,
        contentHash: createHash("sha256").update(markdown).digest("hex"),
      }));
    return {
      outputPath,
      itemCount: result.daily.length + result.review.length,
      receiptCount: result.receipts.length,
      mode: result.mode,
      previewKind: result.mode === "fixture" ? "fixture" : result.previewKind ?? "source",
      previewScope: result.previewScope,
      outcome: result.outcome ?? runOutcome(counts),
      counts,
      modelFailures: result.modelFailures ?? [],
      analyzedCount: result.previewAnalysis?.analyzed ?? 0,
      selected: { daily: result.daily.length, review: result.review.length, machineOnly: result.machineOnly?.length ?? 0 },
      failedReceipts: result.receipts
        .filter((receipt) => receipt.result === "failed")
        .map((receipt) => receipt.detail
          ? { ...receipt, detail: receipt.detail.slice(0, 500) }
          : receipt),
    };
  } finally {
    state.close();
  }
}
