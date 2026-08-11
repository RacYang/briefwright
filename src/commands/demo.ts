import { homedir } from "node:os";
import path from "node:path";

import { buildEffectiveConfig, loadPackagedRuntime } from "../config/load.js";
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
    version: 2,
    name: "Briefwright demonstration",
    preset: "ai-daily",
    interests: ["AI agents", "model evaluation", "AI safety"],
    schedule: "manual",
    output: "markdown",
    outputDirectory: "briefs",
    ai: "qwen",
  };
  const resources = await loadPackagedRuntime(intent);
  const config = buildEffectiveConfig(path.resolve(root), intent, resources.preset, resources.policy, resources.prompts, resources.provider);
  const result = createFixtureRun(config);
  const markdown = renderMarkdown(config, result);
  const outputPath = path.join(config.output.directory, `${result.runId}.md`);

  await writeArtifactAtomic(config.projectRoot, outputPath, markdown);

  return {
    outputPath,
    itemCount: result.daily.length,
    receiptCount: result.receipts.length,
  };
}
