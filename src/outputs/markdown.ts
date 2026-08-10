import type { EffectiveConfig } from "../config/types.js";
import { countReceipts, runOutcome } from "../core/accounting.js";
import type { BriefingItem, RunResult } from "../core/types.js";

function safeInline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[#>*_`\[\]()]/g, "").replace(/\s+/g, " ").trim();
}

function renderItem(item: BriefingItem): string {
  const title = safeInline(item.title);
  return [
    `## ${item.id} · ${title}`,
    "",
    `- Score: ${item.score}`,
    `- Evidence: ${item.evidence}`,
    `- Source: <${item.url}>`,
    "",
    safeInline(item.summary),
    "",
    `Why it matters: ${safeInline(item.whyItMatters)}`,
  ].join("\n");
}

export function renderMarkdown(config: EffectiveConfig, result: RunResult): string {
  const dueIds = config.preset.sources.map((source) => source.id);
  const counts = countReceipts(dueIds, result.receipts);
  const status = runOutcome(counts);
  const failedReceipts = result.receipts.filter((receipt) => receipt.result === "failed");
  const failureSection = failedReceipts.length > 0
    ? [
        "## Source failures",
        "",
        ...failedReceipts.map((receipt) =>
          `- ${receipt.sourceId}: ${(receipt.detail ?? "No detail was reported").replace(/[\r\n]+/g, " ").slice(0, 500)}`
        ),
        "",
      ]
    : [];
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
    `# ${safeInline(config.name)}`,
    "",
    result.mode === "fixture"
      ? "> Demonstration data: this briefing is generated from bundled fixtures and is not current news."
      : "",
    "",
    "## Run summary",
    "",
    `- Due sources: ${counts.due}`,
    `- Receipts: ${result.receipts.length}`,
    `- Observed: ${counts.observed}`,
    `- Updated: ${counts.updated}`,
    `- Unchanged: ${counts.unchanged}`,
    `- Failed: ${counts.failed}`,
    `- Skipped: ${counts.skipped}`,
    `- Missing: ${counts.missing}`,
    "",
    ...failureSection,
    items,
    "",
  ].filter((line, index, lines) => !(line === "" && lines[index - 1] === "")).join("\n");
}
