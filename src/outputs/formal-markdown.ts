import { createHash } from "node:crypto";

import type { EffectiveConfig } from "../config/types.js";
import { canonicalJson } from "../config/load.js";
import { countReceipts, runOutcome } from "../core/accounting.js";
import type { BriefingItem, RunResult } from "../core/types.js";
import { retainExcerpt } from "../connectors/retention.js";
import { parse } from "yaml";

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
    `- Status: ${item.disposition ?? "unassigned"}`,
    `- Captured at: ${item.capturedAt ?? "not recorded"}`,
    `- Published at: ${item.publishedAt ?? "not confirmed"}`,
    `- Content hash: ${item.captureHash ?? "not recorded"}`,
    "- Score dimensions:",
    ...(scores.length ? scores : ["  - Not recorded"]),
    "",
    "Three-sentence summary:",
    `1. What changed: ${inline(item.summary)}`,
    `2. Why it matters: ${inline(item.whyItMatters)}`,
    `3. Evidence boundary: ${inline(item.evidenceStatus ?? item.evidence)} evidence from ${inline(item.sourceId)}; open the canonical source before relying on details beyond these claims.`,
    "",
    `Canonical quotation (maximum 25 words): ${inline(item.sourceExcerpt ?? "") || "Not available; open the canonical source for verbatim context."}`,
    "",
    "Read-only relationship to existing Notes/Refs: Not resolved automatically.",
    "",
    `Processing record: ${item.id} / ${item.sourceId} / ${item.disposition ?? "unassigned"}`,
    "",
    "Claims:",
    ...((item.claims?.length ? item.claims : ["No bounded claims recorded."]).map((claim) => `- ${inline(claim)}`)),
    "",
    `Knowledge potential: ${item.knowledgePotential ? inline(item.knowledgePotential.reason) : "Not evaluated"}`,
    "",
    `Boundary reasons: ${item.exclusionReasons?.map(inline).join(", ") || "none"}`,
  ].join("\n");
}

function common(config: EffectiveConfig, result: RunResult, kind: "daily" | "review", selected: BriefingItem[]): string[] {
  const counts = countReceipts(result.dueSourceIds ?? config.preset.sources.map((source) => source.id), result.receipts);
  const failures = result.receipts.filter((receipt) => receipt.result === "failed");
  const domains = new Set(selected.map((entry) => entry.domain).filter(Boolean));
  const outcome = result.outcome ?? runOutcome(counts);
  const policyDigest = createHash("sha256").update(canonicalJson(config.policy)).digest("hex");
  const promptDigest = createHash("sha256").update(canonicalJson(config.prompts)).digest("hex");
  const sourceDigest = createHash("sha256").update(canonicalJson(config.preset.sources)).digest("hex");
  const ruleVersion = (prefix: string) => config.policy.rules.find((rule) => rule.id.startsWith(prefix))?.version ?? "0.0";
  const day = result.runId.match(/^RUN-(\d{4})(\d{2})(\d{2})-/)?.slice(1, 4).join("-") ?? result.generatedAt.slice(0, 10);
  return [
    "---",
    `title: ${JSON.stringify(`${config.name} · ${kind === "daily" ? "Daily" : "Review"}`)}`,
    `type: ${kind === "daily" ? "briefing" : "review-queue"}`,
    `run_id: ${result.runId}`,
    `artifact_kind: ${kind}`,
    `status: ${outcome}`,
    `created: ${day}`,
    `reviewed: ${day}`,
    `item_count: ${selected.length}`,
    `generated_at: ${result.generatedAt}`,
    `config_digest: ${result.configDigest}`,
    `workflow_version: ${JSON.stringify(ruleVersion("RULE-WORKFLOW-"))}`,
    `score_version: ${JSON.stringify(ruleVersion("RULE-SCORE-"))}`,
    `selection_version: ${JSON.stringify(ruleVersion("RULE-SELECTION-"))}`,
    `source_policy_version: ${JSON.stringify(ruleVersion("RULE-SOURCE-"))}`,
    `core_release: ${JSON.stringify(config.provenance.coreVersion)}`,
    `intent_version: ${config.provenance.intentVersion}`,
    `preset_version: ${config.provenance.presetVersion}`,
    `policy_release: ${JSON.stringify(config.policy.version)}`,
    `policy_digest: ${policyDigest}`,
    `prompt_release: ${JSON.stringify(config.prompts.version)}`,
    `prompt_digest: ${promptDigest}`,
    `provider_release: ${JSON.stringify(config.provider.version)}`,
    `provider_model: ${JSON.stringify(config.provider.model)}`,
    `source_manifest_digest: ${sourceDigest}`,
    `rule_ids: ${yamlList(config.policy.rules.map((rule) => rule.id))}`,
    "---",
    "",
    `# ${inline(config.name)} · ${kind === "daily" ? "Daily" : "Review"}`,
    "",
    "## Run summary",
    "",
    `- Outcome: ${outcome}`,
    `- Due sources: ${counts.due}`,
    `- Receipts: ${result.receipts.length}`,
    `- Updated / unchanged / failed / skipped / missing: ${counts.updated} / ${counts.unchanged} / ${counts.failed} / ${counts.skipped} / ${counts.missing}`,
    `- Model failures: ${result.modelFailures?.length ?? 0}`,
    `- Selected items: ${selected.length}`,
    `- Covered domains: ${domains.size ? [...domains].join(", ") : "none"}`,
    `- Active rules: ${config.policy.rules.map((rule) => rule.id).join(", ")}`,
    "",
    "## Stage timings before publish",
    "",
    ...(Object.entries(result.artifactStageTimings ?? {}).length
      ? Object.entries(result.artifactStageTimings ?? {}).map(([stage, duration]) => `- ${stage}: ${duration} ms`)
      : ["- No stage timings recorded"]),
    "",
    "## Coverage by domain",
    "",
    ...config.policy.domains.map((domain) => `- ${domain}: ${selected.filter((entry) => entry.domain === domain).length}`),
    "",
    "## Source failures",
    "",
    ...(failures.length ? failures.map((receipt) => `- ${receipt.sourceId}: ${inline(receipt.detail ?? "No detail was reported")}`) : ["- None"]),
    "",
    "## Model failures",
    "",
    ...(result.modelFailures?.length
      ? result.modelFailures.map((failure) => `- ${failure.sourceId} / ${failure.captureId}: ${inline(failure.detail)}`)
      : ["- None"]),
    "",
    "## Completion and storage validation",
    "",
    ...(result.completionReport ? [
      `- Rule contract valid: ${result.completionReport.ruleContractValid}`,
      `- Process store valid: ${result.completionReport.processStoreValid}`,
      `- Document store valid: ${result.completionReport.documentStoreValid}`,
      `- Discovered / captured / verified / deduplicated / scored: ${result.completionReport.discovered} / ${result.completionReport.captured} / ${result.completionReport.verified} / ${result.completionReport.deduplicated} / ${result.completionReport.scored}`,
      `- Daily / review / machine-only / errors: ${result.completionReport.daily} / ${result.completionReport.review} / ${result.completionReport.eliminated} / ${result.completionReport.errors}`,
      `- Missing source IDs: ${result.completionReport.missingSourceIds.join(", ") || "none"}`,
      `- Process-store sync failures: ${result.controlPlaneSync?.failed.length ?? 0}`,
      `- Reconciliation failures: ${result.controlPlaneReconciliation?.failed.length ?? 0}`,
      `- Cadence evaluation: ${result.cadenceGovernance?.evaluated ? `proposed ${result.cadenceGovernance.proposals.length} change(s)` : result.cadenceGovernance?.reason ?? "not recorded"}`,
      `- Active approved cadence overrides: ${result.cadenceGovernance?.activeOverrides?.map((entry) => `${entry.sourceId}=${entry.hours}h${entry.humanLocked ? " (locked)" : ""}`).join(", ") || "none"}`,
      `- Improvement evaluator: ${result.improvementGovernance?.evaluated ? `diagnosed ${result.improvementGovernance.proposalCount} proposal(s)` : result.improvementGovernance?.reason ?? "not recorded"}`,
    ] : ["- Final completion report was not available."]),
    "",
  ];
}

export function renderFormalDaily(config: EffectiveConfig, result: RunResult): string {
  return [...common(config, result, "daily", result.daily),
    "## 今日总判断", "", result.daily.length ? `本批次有 ${result.daily.length} 条高信号情报通过 Daily 门槛；结论仅限已核验来源。` : "本批次没有条目通过 Daily 门槛；空结果是有效结果，不凑数。", "",
    "## 候选条目", "", result.daily.length ? result.daily.map(item).join("\n\n") : "无。", "",
    "## 领域覆盖表", "", ...config.policy.domains.map((domain) => `- ${domain}: ${result.daily.filter((entry) => entry.domain === domain).length}`), "",
    "## 跨领域影响", "", result.daily.length ? "仅保留条目中有直接证据支持的影响说明；不自动扩展为未证实的系统性结论。" : "无可报告的跨领域影响。", "",
    "## 未收录线索", "", `- Machine-only: ${result.machineOnly?.length ?? 0}`, `- Review: ${result.review.length}`, "",
    "## 检索与质量说明", "", `- Source receipts: ${result.receipts.length}`, `- Model failures: ${result.modelFailures?.length ?? 0}`, "- Integrity validation follows artifact staging; final status is retained in the run journal and completion report.", ""].join("\n");
}

export function renderFormalReview(config: EffectiveConfig, result: RunResult): string {
  return [...common(config, result, "review", result.review), "## 待复核候选", "", result.review.length ? result.review.map((entry) => `${item(entry)}\n\n需要用户决定什么：纳入、略过、比较、纠正分类/评分/来源，或记录流程反馈。`) .join("\n\n") : "没有边界候选通过 Review 与稳定知识潜力门；队列未被填充。", "", "## 复核说明", "", "任何候选在用户明确决定前都不会进入常青知识库或改变生效规则。", ""].join("\n");
}

export function validateFormalArtifact(config: EffectiveConfig, result: RunResult, kind: "daily" | "review", content: string): void {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match?.[1]) throw new Error(`${kind} artifact is missing YAML frontmatter`);
  const frontmatter = parse(match[1]) as Record<string, unknown>;
  const expectedVersions = Object.fromEntries([
    ["workflow_version", "RULE-WORKFLOW-"], ["score_version", "RULE-SCORE-"], ["selection_version", "RULE-SELECTION-"], ["source_policy_version", "RULE-SOURCE-"],
  ].map(([field, prefix]) => [field, config.policy.rules.find((rule) => rule.id.startsWith(prefix!))?.version]));
  for (const [field, value] of Object.entries(expectedVersions)) {
    if (!/^\d+\.\d+$/.test(String(frontmatter[field] ?? "")) || String(frontmatter[field]) !== value) throw new Error(`${kind} artifact has invalid ${field}`);
  }
  if (frontmatter.run_id !== result.runId || frontmatter.status !== result.outcome) throw new Error(`${kind} artifact run identity or terminal status is inconsistent`);
  const ruleIds = Array.isArray(frontmatter.rule_ids) ? frontmatter.rule_ids.map(String) : [];
  if (canonicalJson([...ruleIds].sort()) !== canonicalJson(config.policy.rules.map((rule) => rule.id).sort())) throw new Error(`${kind} artifact does not contain the complete canonical rule set`);
  const required = kind === "daily" ? ["今日总判断", "候选条目", "领域覆盖表", "跨领域影响", "未收录线索", "检索与质量说明"] : ["待复核候选", "复核说明"];
  for (const heading of required) if (!content.includes(`## ${heading}`)) throw new Error(`${kind} artifact is missing section ${heading}`);
  const fenceCount = (content.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 !== 0) throw new Error(`${kind} artifact has an unclosed code fence`);
  const selected = kind === "daily" ? result.daily : result.review;
  for (const item of selected) {
    if (item.sourceExcerpt && retainExcerpt(item.sourceExcerpt) !== item.sourceExcerpt.trim()) throw new Error(`${kind} artifact source excerpt exceeds the 25-word retention boundary for ${item.id}`);
    if (!content.includes(`## ${item.id} ·`) || !content.includes(`- Source: <${item.url}>`) || !content.includes(`- Content hash: ${item.captureHash ?? "not recorded"}`) ||
      !content.includes("Three-sentence summary:") || !content.includes(`Processing record: ${item.id}`) || !content.includes("Boundary reasons:")) {
      throw new Error(`${kind} artifact is missing required fields for ${item.id}`);
    }
  }
}
