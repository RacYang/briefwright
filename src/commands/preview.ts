import { createHash } from "node:crypto";
import path from "node:path";

import { loadEffectiveConfig } from "../config/load.js";
import { createFixtureRun } from "../core/fixture.js";
import { createLiveRun } from "../core/live.js";
import { countReceipts, runOutcome, type ReceiptCounts, type RunOutcome } from "../core/accounting.js";
import type { Receipt } from "../core/types.js";
import { renderMarkdown } from "../outputs/markdown.js";
import { writeArtifactSetAtomic } from "../outputs/write.js";
import { SqliteStateStore } from "../state/sqlite.js";
import type { ConnectorContext } from "../connectors/types.js";
import { hydrateFromControlPlane } from "../control-plane/registry.js";

export interface PreviewResult {
  outputPath: string;
  itemCount: number;
  receiptCount: number;
  mode: "fixture" | "live";
  outcome: RunOutcome;
  counts: ReceiptCounts;
  failedReceipts: Receipt[];
}

export async function previewProject(
  configPath: string,
  options: { live?: boolean; fetch?: ConnectorContext["fetch"] } = {},
): Promise<PreviewResult & { mode: "fixture" | "live" }> {
  const loaded = await loadEffectiveConfig(configPath);
  const config = options.live ? await hydrateFromControlPlane(loaded) : loaded;
  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  const dueSources = options.live ? state.dueSources(config.preset.sources, new Date(), config.policy.domains).map((entry) => entry.source) : config.preset.sources;
  const result = options.live ? await createLiveRun(config, new Date(), options.fetch, dueSources) : createFixtureRun(config);
  const markdown = renderMarkdown(config, result);
  const outputPath = path.join(config.projectRoot, ".briefwright", "previews", `${result.runId}.md`);
  const counts = countReceipts(dueSources.map((source) => source.id), result.receipts);

  try {
    state.assertRunWritable(result);
    await writeArtifactSetAtomic(config.projectRoot, [{ path: outputPath, content: markdown }], () => state.saveRun(config, result, {
        kind: "preview-markdown",
        path: outputPath,
        contentHash: createHash("sha256").update(markdown).digest("hex"),
      }));
  } finally {
    state.close();
  }

  return {
    outputPath,
    itemCount: result.daily.length,
    receiptCount: result.receipts.length,
    mode: result.mode,
    outcome: runOutcome(counts),
    counts,
    failedReceipts: result.receipts
      .filter((receipt) => receipt.result === "failed")
      .map((receipt) => receipt.detail
        ? { ...receipt, detail: receipt.detail.slice(0, 500) }
        : receipt),
  };
}
