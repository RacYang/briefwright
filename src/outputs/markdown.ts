import type { EffectiveConfig } from "../config/types.js";
import { countReceipts } from "../core/accounting.js";
import type { BriefingItem, RunResult } from "../core/types.js";

function renderItem(item: BriefingItem): string {
  return [
    `## ${item.id} · ${item.title}`,
    "",
    `- Score: ${item.score}`,
    `- Evidence: ${item.evidence}`,
    `- Source: [open original](${item.url})`,
    "",
    item.summary,
    "",
    `Why it matters: ${item.whyItMatters}`,
  ].join("\n");
}

export function renderMarkdown(config: EffectiveConfig, result: RunResult): string {
  const dueIds = config.preset.sources.map((source) => source.id);
  const counts = countReceipts(dueIds, result.receipts);
  const status = counts.failed > 0 || counts.missing > 0 ? "partial" : "success";
  const items = result.daily.length > 0
    ? result.daily.map(renderItem).join("\n\n")
    : "No high-signal items met the configured evidence and selection gates.";

  return [
    "---",
    `title: ${JSON.stringify(config.name)}`,
    `run_id: ${result.runId}`,
    `status: ${status}`,
    `data_mode: ${result.mode}`,
    `generated_at: ${result.generatedAt}`,
    `item_count: ${result.daily.length}`,
    `config_digest: ${result.configDigest}`,
    "---",
    "",
    `# ${config.name}`,
    "",
    result.mode === "fixture"
      ? "> Demonstration data: this briefing is generated from bundled fixtures and is not current news."
      : "",
    "",
    "## Run summary",
    "",
    `- Due sources: ${counts.due}`,
    `- Receipts: ${result.receipts.length}`,
    `- Updated: ${counts.updated}`,
    `- Unchanged: ${counts.unchanged}`,
    `- Failed: ${counts.failed}`,
    `- Skipped: ${counts.skipped}`,
    `- Missing: ${counts.missing}`,
    "",
    items,
    "",
  ].filter((line, index, lines) => !(line === "" && lines[index - 1] === "")).join("\n");
}

