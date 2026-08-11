import type { EffectiveConfig } from "../config/types.js";
import { countReceipts, runOutcome } from "../core/accounting.js";
import type { BriefingItem, RunResult } from "../core/types.js";

function inline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[#>*_`\[\]()]/g, "").replace(/\s+/g, " ").trim();
}

function yamlList(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function item(item: BriefingItem): string {
  const scores = Object.entries(item.scoreDimensions ?? {}).map(([id, score]) =>
    `  - ${id}: ${score.value}/5 × ${score.weight} = ${score.weighted.toFixed(2)} — ${inline(score.reason)}`,
  );
  return [
    `## ${item.id} · ${inline(item.title)}`,
    "",
    `- Domain: ${item.domain ?? "unknown"}`,
    `- Score: ${item.score}`,
    `- Evidence status: ${item.evidenceStatus ?? item.evidence}`,
    `- Source: <${item.url}>`,
    `- Source ID: ${item.sourceId}`,
    "- Score dimensions:",
    ...(scores.length ? scores : ["  - Not recorded"]),
    "",
    `Summary: ${inline(item.summary)}`,
    "",
    `Why it matters: ${inline(item.whyItMatters)}`,
    "",
    "Claims:",
    ...((item.claims?.length ? item.claims : ["No bounded claims recorded."]).map((claim) => `- ${inline(claim)}`)),
    "",
    `Knowledge potential: ${item.knowledgePotential ? inline(item.knowledgePotential.reason) : "Not evaluated"}`,
  ].join("\n");
}

function common(config: EffectiveConfig, result: RunResult, kind: "daily" | "review", selected: BriefingItem[]): string[] {
  const counts = countReceipts(config.preset.sources.map((source) => source.id), result.receipts);
  const failures = result.receipts.filter((receipt) => receipt.result === "failed");
  const domains = new Set(selected.map((entry) => entry.domain).filter(Boolean));
  return [
    "---",
    `title: ${JSON.stringify(`${config.name} · ${kind === "daily" ? "Daily" : "Review"}`)}`,
    `run_id: ${result.runId}`,
    `artifact_kind: ${kind}`,
    `status: ${runOutcome(counts)}`,
    `generated_at: ${result.generatedAt}`,
    `config_digest: ${result.configDigest}`,
    `policy_version: ${config.policy.version}`,
    `prompt_version: ${config.prompts.version}`,
    `provider_version: ${config.provider.version}`,
    `rule_ids: ${yamlList(config.policy.rules.map((rule) => rule.id))}`,
    "---",
    "",
    `# ${inline(config.name)} · ${kind === "daily" ? "Daily" : "Review"}`,
    "",
    "## Run summary",
    "",
    `- Outcome: ${runOutcome(counts)}`,
    `- Due sources: ${counts.due}`,
    `- Receipts: ${result.receipts.length}`,
    `- Updated / unchanged / failed / skipped / missing: ${counts.updated} / ${counts.unchanged} / ${counts.failed} / ${counts.skipped} / ${counts.missing}`,
    `- Model failures: ${result.modelFailures?.length ?? 0}`,
    `- Selected items: ${selected.length}`,
    `- Covered domains: ${domains.size ? [...domains].join(", ") : "none"}`,
    `- Active rules: ${config.policy.rules.map((rule) => rule.id).join(", ")}`,
    "",
    "## Coverage by domain",
    "",
    ...config.policy.domains.map((domain) => `- ${domain}: ${selected.filter((entry) => entry.domain === domain).length}`),
    "",
    "## Source failures",
    "",
    ...(failures.length ? failures.map((receipt) => `- ${receipt.sourceId}: ${inline(receipt.detail ?? "No detail was reported")}`) : ["- None"]),
    "",
  ];
}

export function renderFormalDaily(config: EffectiveConfig, result: RunResult): string {
  return [...common(config, result, "daily", result.daily), "## Selected intelligence", "", result.daily.length ? result.daily.map(item).join("\n\n") : "No high-signal items passed the Daily gates. The empty result is intentional.", "", "## Exclusions", "", `- Machine-only items: ${result.machineOnly?.length ?? 0}`, `- Review items: ${result.review.length}`, ""].join("\n");
}

export function renderFormalReview(config: EffectiveConfig, result: RunResult): string {
  return [...common(config, result, "review", result.review), "## Boundary candidates", "", result.review.length ? result.review.map(item).join("\n\n") : "No boundary candidates passed the Review and stable-knowledge-potential gates. The queue was not padded.", ""].join("\n");
}
