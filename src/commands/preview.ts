import path from "node:path";

import { loadEffectiveConfig } from "../config/load.js";
import { createFixtureRun } from "../core/fixture.js";
import { renderMarkdown } from "../outputs/markdown.js";
import { writeArtifactAtomic } from "../outputs/write.js";
import { SqliteStateStore } from "../state/sqlite.js";

export interface PreviewResult {
  outputPath: string;
  itemCount: number;
  receiptCount: number;
  mode: "fixture";
}

export async function previewProject(configPath: string): Promise<PreviewResult> {
  const config = await loadEffectiveConfig(configPath);
  const result = createFixtureRun(config);
  const markdown = renderMarkdown(config, result);
  const outputPath = path.join(config.output.directory, "preview.md");

  await writeArtifactAtomic(outputPath, markdown);

  const state = new SqliteStateStore(config.storage.path);
  try {
    state.saveRun(config, result);
  } finally {
    state.close();
  }

  return {
    outputPath,
    itemCount: result.daily.length,
    receiptCount: result.receipts.length,
    mode: "fixture",
  };
}
