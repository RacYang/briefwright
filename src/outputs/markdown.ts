import type { EffectiveConfig } from "../config/types.js";
import { countReceipts, runOutcome } from "../core/accounting.js";
import type { BriefingItem, RunResult } from "../core/types.js";

function safeInline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[#>*_`\[\]()]/g, "").replace(/\s+/g, " ").trim();
}

function renderItem(item: BriefingItem): string {
  const title = safeInline(item.title);
  return [
    `### ${title}`,
    "",
    `- Score: ${item.score}`,
    `- Evidence: ${item.evidence}`,
    ...(item.publishedAt ? [`- Source date: ${item.publishedAt.slice(0, 10)}`] : []),
    ...(item.pageUpdatedAt ? [`- Page updated: ${item.pageUpdatedAt.slice(0, 10)} (not an event date)`] : []),
    `- Source: <${item.url}>`,
    "",
    safeInline(item.summary),
    "",
    `Why it matters: ${safeInline(item.whyItMatters)}`,
  ].join("\n");
}

export function renderMarkdown(config: EffectiveConfig, result: RunResult): string {
  const dueIds = result.dueSourceIds ?? config.preset.sources.map((source) => source.id);
  const counts = countReceipts(dueIds, result.receipts);
  const status = result.outcome ?? runOutcome(counts);
  const failedReceipts = result.receipts.filter((receipt) => receipt.result === "failed");
  const failureSection = failedReceipts.length > 0
    ? [
        `<details><summary>Source failures (${failedReceipts.length})</summary>`,
        "",
        ...failedReceipts.map((receipt) =>
          `- ${receipt.sourceId}: ${(receipt.detail ?? "No detail was reported").replace(/[\r\n]+/g, " ").slice(0, 500)}`
        ),
        "",
        "</details>",
        "",
      ]
    : [];
  const renderGroup = (title: string, items: BriefingItem[]) => [
    `## ${title}`,
    "",
    items.length ? items.map(renderItem).join("\n\n") : "No items met this selection gate.",
    "",
  ];
  const itemSections = result.previewKind === "editorial"
    ? [...renderGroup("Daily candidates", result.daily), ...renderGroup("Review candidates", result.review)]
    : renderGroup("Briefing candidates", result.daily);
  const modelFailures = result.modelFailures ?? [];
  const modelFailureSection = modelFailures.length ? [
    `<details><summary>Model analysis failures (${modelFailures.length})</summary>`,
    "",
    ...modelFailures.map((failure) => `- ${failure.sourceId} / ${failure.captureId}: ${safeInline(failure.detail).slice(0, 500)}`),
    "",
    "</details>",
    "",
  ] : [];
  const analysisQuality = result.previewAnalysis ? [
    "## Editorial shadow coverage",
    "",
    `- Eligible recent captures: ${result.previewAnalysis.eligibleCaptures}`,
    `- Bounded sample: ${result.previewAnalysis.analyzed}/${result.previewAnalysis.sampleLimit}`,
    `- Model analyses accepted: ${result.previewAnalysis.succeeded}`,
    `- Model analyses failed: ${result.previewAnalysis.failed}`,
    `- Selected: ${result.daily.length} Daily; ${result.review.length} Review; ${result.machineOnly?.length ?? 0} machine-only`,
    "",
    ...modelFailureSection,
  ] : [];
  const itemCount = result.daily.length + result.review.length;

  return [
    "---",
    `title: ${JSON.stringify(config.name)}`,
    `run_id: ${result.runId}`,
    `status: ${status}`,
    `data_mode: ${result.mode}`,
    `generated_at: ${result.generatedAt}`,
    `preview_kind: ${result.mode === "fixture" ? "fixture" : result.previewKind ?? "source"}`,
    `preview_scope: ${result.previewScope ?? "configured-due"}`,
    `item_count: ${itemCount}`,
    `config_digest: ${result.configDigest}`,
    "---",
    "",
    `# ${safeInline(config.name)}`,
    "",
    result.mode === "fixture"
      ? "> Demonstration data: this briefing is generated from bundled fixtures and is not current news."
      : result.previewKind === "editorial"
        ? "> Editorial shadow only: a bounded sample was analyzed by the configured real model. Nothing was written to Feishu or the formal Daily/Review paths."
        : "> Source-connectivity preview only: candidates below use deterministic lexical ranking and do not prove editorial quality.",
    ...(result.previewScope === "capture-bundle"
      ? ["", "> Bundle-only scope: only sources listed in the supplied capture bundle were eligible; no other configured sources were fetched."]
      : []),
    "",
    ...itemSections,
    ...analysisQuality,
    "## Run quality",
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
  ].filter((line, index, lines) => !(line === "" && lines[index - 1] === "")).join("\n");
}
