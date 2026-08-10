import { homedir } from "node:os";
import path from "node:path";

import { buildEffectiveConfig, loadPreset } from "../config/load.js";
import type { BriefingIntent } from "../config/types.js";
import { createFixtureRun } from "../core/fixture.js";
import { renderMarkdown } from "../outputs/markdown.js";
import { writeArtifactAtomic } from "../outputs/write.js";

export interface DemoResult {
  outputPath: string;
  itemCount: number;
  receiptCount: number;
}

export async function runDemo(root = path.join(homedir(), ".briefwright", "demo")): Promise<DemoResult> {
  const intent: BriefingIntent = {
    version: 1,
    name: "Briefwright demonstration",
    preset: "ai-daily",
    interests: ["AI agents", "model evaluation", "AI safety"],
    schedule: "manual",
    output: "markdown",
    outputDirectory: "briefs",
  };
  const preset = await loadPreset(intent.preset);
  const config = buildEffectiveConfig(root, intent, preset);
  const result = createFixtureRun(config);
  const markdown = renderMarkdown(config, result);
  const outputPath = path.join(config.output.directory, "briefwright-demo.md");

  await writeArtifactAtomic(outputPath, markdown);

  return {
    outputPath,
    itemCount: result.daily.length,
    receiptCount: result.receipts.length,
  };
}
