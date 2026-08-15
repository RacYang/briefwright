import { createHash } from "node:crypto";

import type { EffectiveConfig } from "../config/types.js";
import { canonicalJson, executionConfigProjection } from "../config/load.js";
import { countReceipts, runOutcome } from "../core/accounting.js";
import type { BriefingItem, RunResult } from "../core/types.js";
import { retainExcerpt } from "../connectors/retention.js";
import { parse } from "yaml";
import { detectOutputLanguage, type OutputLanguage } from "./locale.js";

function inline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[#>*_`\[\]()]/g, "").replace(/\s+/g, " ").trim();
}

const STAGE_LABELS: Record<string, string> = {
  initialize: "初始化",
  freeze_due_manifest: "冻结到期来源清单",
  discover: "发现",
  capture: "抓取",
  write_receipts: "写入回执",
  normalize: "规范化",
  verify_evidence: "核验证据",
  deduplicate: "去重",
  score: "评分",
  select: "筛选",
  publish: "发布",
  persist: "持久化",
  validate_integrity: "完整性校验",
  complete: "完成",
};

function localizedDetail(detail?: string): string {
  const value = inline(detail ?? "未报告详情");
  if (value === "fetch failed") return "抓取失败";
  const http = /^Webpage returned HTTP (\d+)$/.exec(value);
  if (http) return `网页返回 HTTP ${http[1]}`;
  const missingCapture = /^Validated browser capture bundle has no entry for (.+)$/.exec(value);
  if (missingCapture) return `已验证的浏览器捕获包中缺少 ${missingCapture[1]}`;
  if (value === "Cadence governance runs on Monday in Asia/Shanghai") return "节奏治理仅在 Asia/Shanghai 时区的周一运行";
  if (value === "latest diagnosis is newer than 7 days") return "最新诊断尚未满 7 天";
  return value;
}

function english(content: string): string {
  const replacements: Array<[string, string]> = [
    ["· 日报", "· Daily"], ["· 待复核", "· Review"],
    ["## 运行摘要", "## Run summary"], ["- 结果：成功", "- Outcome: success"], ["- 结果：部分成功", "- Outcome: partial"], ["- 结果：失败", "- Outcome: failed"],
    ["- 到期来源：", "- Due sources: "], ["- 回执：", "- Receipts: "], ["- 更新 / 无变化 / 失败 / 跳过 / 缺失：", "- Updated / unchanged / failed / skipped / missing: "],
    ["- 模型失败：", "- Model failures: "], ["- 入选条目：", "- Selected items: "], ["- 覆盖领域：无", "- Covered domains: none"], ["- 覆盖领域：", "- Covered domains: "], ["- 生效规则：", "- Active rules: "],
    ["## 发布前阶段耗时", "## Stage timings before publish"], ["- 未记录阶段耗时", "- No stage timings recorded"],
    ["## 领域覆盖\n", "## Coverage by domain\n"], ["## 来源失败", "## Source failures"], ["## 模型失败", "## Model failures"], ["- 无", "- None"],
    ["## 完成与存储校验", "## Completion and storage validation"], ["- 规则合同有效：是", "- Rule contract valid: true"], ["- 规则合同有效：否", "- Rule contract valid: false"],
    ["- 流程存储有效：是", "- Process store valid: true"], ["- 流程存储有效：否", "- Process store valid: false"], ["- 文档存储有效：是", "- Document store valid: true"], ["- 文档存储有效：否", "- Document store valid: false"],
    ["- 发现 / 抓取 / 核验 / 去重 / 评分：", "- Discovered / captured / verified / deduplicated / scored: "], ["- 日报 / 待复核 / 机器层 / 错误：", "- Daily / review / machine-only / errors: "],
    ["- 缺失来源 ID：无", "- Missing source IDs: none"], ["- 缺失来源 ID：", "- Missing source IDs: "], ["- 流程存储同步失败：", "- Process-store sync failures: "], ["- 对账失败：", "- Reconciliation failures: "],
    ["- 节奏评估：节奏治理仅在 Asia/Shanghai 时区的周一运行", "- Cadence evaluation: Cadence governance runs on Monday in Asia/Shanghai"], ["- 节奏评估：", "- Cadence evaluation: "],
    ["- 已批准的生效节奏覆盖：无", "- Active approved cadence overrides: none"], ["- 已批准的生效节奏覆盖：", "- Active approved cadence overrides: "],
    ["- 改进评估：最新诊断尚未满 7 天", "- Improvement evaluator: latest diagnosis is newer than 7 days"], ["- 改进评估：", "- Improvement evaluator: "], ["- 最终完成报告不可用。", "- Final completion report was not available."],
    ["## 今日总判断", "## Today's assessment"], ["## 候选条目", "## Selected items"], ["## 领域覆盖表", "## Domain coverage"], ["## 跨领域影响", "## Cross-domain impact"], ["## 未收录线索", "## Excluded leads"], ["## 检索与质量说明", "## Retrieval and quality notes"],
    ["### 为什么重要", "### Why it matters"], ["> 原文摘录：", "> Source excerpt: "], ["复核边界：", "Review boundary: "],
    ["本批次没有条目通过日报门槛；空结果是有效结果，不凑数。", "No items passed the Daily gate; an empty result is valid and will not be padded."], ["无可报告的跨领域影响。", "No cross-domain impact is reportable."],
    ["未通过门槛的线索保留在审计控制面，不在阅读版展开。", "Leads below the selection threshold remain in the audit control plane and are not expanded in this reading edition."],
    ["本阅读版仅呈现通过一手证据核验的条目；运行审计保留在控制面。", "This reading edition contains only items verified against primary evidence; run audit data remains in the control plane."],
    ["- 机器层：", "- Machine-only: "], ["- 待复核：", "- Review: "], ["- 来源回执：", "- Source receipts: "], ["- 完整性校验在产物暂存后执行；最终状态保留在运行日志与完成报告中。", "- Integrity validation follows artifact staging; final status is retained in the run journal and completion report."],
    ["## 待复核候选", "## Review candidates"], ["没有边界候选通过待复核与稳定知识潜力门；队列未被填充。", "No boundary candidates passed the Review and stable-knowledge-potential gates; the queue was not padded."], ["## 复核说明", "## Review notes"], ["任何候选在用户明确决定前都不会进入常青知识库或改变生效规则。", "No candidate enters evergreen knowledge or changes active rules before an explicit user decision."],
    ["- 领域：", "- Domain: "], ["- 总分：", "- Score: "], ["- 证据状态：", "- Evidence status: "], ["- 原文：", "- Source: "], ["- 来源 ID：", "- Source ID: "], ["- 状态：", "- Status: "], ["- 抓取时间：", "- Captured at: "], ["- 来源日期：", "- Source date: "], ["- 内容哈希：", "- Content hash: "], ["- 评分维度：", "- Score dimensions:"],
    ["三句摘要：", "Three-sentence summary:"], ["1. 发生了什么：", "1. What changed: "], ["2. 为什么重要：", "2. Why it matters: "], ["原文引文（最多 25 词）：", "Canonical quotation (maximum 25 words): "],
    ["与现有 Notes/Refs 的只读关系：未自动解析。", "Read-only relationship to existing Notes/Refs: Not resolved automatically."], ["处理记录：", "Processing record: "], ["事实主张：", "Claims:"], ["知识潜力：", "Knowledge potential: "], ["边界原因：无", "Boundary reasons: none"], ["边界原因：", "Boundary reasons: "],
  ];
  let translated = content;
  for (const [from, to] of replacements) translated = translated.replaceAll(from, to);
  for (const [stage, label] of Object.entries(STAGE_LABELS)) translated = translated.replaceAll(`- ${label}：`, `- ${stage}: `);
  translated = translated.replaceAll(" 毫秒", " ms").replace(/：抓取失败/g, ": fetch failed").replace(/：网页返回 HTTP (\d+)/g, ": Webpage returned HTTP $1").replace(/：已验证的浏览器捕获包中缺少 ([^\n]+)/g, ": Validated browser capture bundle has no entry for $1");
  translated = translated.replace(/3\. 证据边界：证据状态为 ([^，]+)，来源为 ([^；]+)；如需依赖上述主张之外的细节，请打开 canonical 原文核对。/g, "3. Evidence boundary: $1 evidence from $2; open the canonical source before relying on details beyond these claims.");
  translated = translated.replace(/本批次有 (\d+) 条高信号情报通过日报门槛；结论仅限已核验来源。/g, "This run has $1 high-signal item(s) that passed the Daily gate; conclusions are limited to verified sources.");
  return translated;
}

function output(content: string, language: OutputLanguage): string {
  return language === "zh-CN" ? content : english(content);
}

function concise(value: string, maximum = 240): string {
  const normalized = inline(value);
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function editorialAssessment(items: BriefingItem[], language: OutputLanguage): string {
  if (!items.length) return language === "zh-CN"
    ? "今天没有通过新鲜度、证据与价值门槛的更新；不以历史恢复结果或低信号内容凑数。"
    : "No update passed the freshness, evidence, and value gates today; historical recovery results and low-signal material are not used as padding.";
  const ranked = [...items].sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
  const top = ranked[0]!;
  const domains = [...new Set(ranked.map((item) => item.domain).filter(Boolean))];
  const remainder = ranked.length - 1;
  return language === "zh-CN"
    ? `首要跟进「${concise(top.title, 120)}」：${concise(top.whyItMatters)}${remainder ? ` 另有 ${remainder} 条通过门槛，覆盖 ${domains.join("、") || "未分类领域"}；优先顺序按生效规则的综合分排列。` : ""}`
    : `Top priority: “${concise(top.title, 120)}” — ${concise(top.whyItMatters)}${remainder ? ` ${remainder} other item${remainder === 1 ? "" : "s"} passed the gates across ${domains.join(", ") || "uncategorized domains"}; ordering follows the active policy score.` : ""}`;
}

function legacyAssessment(items: BriefingItem[]): string {
  const domains = [...new Set(items.map((item) => item.domain).filter(Boolean))].join("、");
  return items.length
    ? `今天有 ${items.length} 条值得跟进的更新${domains ? `，主要集中在${domains}` : ""}。优先看：${items.slice(0, 3).map((item) => inline(item.title)).join("；")}。`
    : "今天没有通过新鲜度、证据与价值门槛的更新；不以历史恢复结果或低信号内容凑数。";
}

function crossDomainAssessment(items: BriefingItem[], language: OutputLanguage): string[] {
  const groups = new Map<string, BriefingItem[]>();
  for (const item of items) {
    const domain = item.domain ?? (language === "zh-CN" ? "未知" : "Unknown");
    groups.set(domain, [...(groups.get(domain) ?? []), item]);
  }
  if (groups.size === 0) return [language === "zh-CN" ? "无可报告的跨领域影响。" : "No cross-domain impact is reportable."];
  if (groups.size === 1) {
    const domain = [...groups.keys()][0]!;
    return [language === "zh-CN"
      ? `本批次只有${domain}领域的条目通过门槛，没有足够证据形成跨领域判断。`
      : `Only the ${domain} domain passed the gates in this run, so there is not enough evidence for a cross-domain assessment.`];
  }
  const strongest = [...groups.entries()].map(([domain, entries]) => {
    const top = [...entries].sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))[0]!;
    return language === "zh-CN"
      ? `- ${domain}：${concise(top.title, 100)} — ${concise(top.whyItMatters, 180)}`
      : `- ${domain}: ${concise(top.title, 100)} — ${concise(top.whyItMatters, 180)}`;
  });
  return [...strongest, "", language === "zh-CN"
    ? "以上是各领域当前最强的已核验信号；它们可以并列影响技术决策，但现有证据不足以声称彼此存在因果关系。"
    : "These are the strongest verified signals in each domain. They may jointly affect technical decisions, but the evidence does not establish a causal relationship between them."];
}

function item(item: BriefingItem): string {
  const published = item.publishedAt ? item.publishedAt.slice(0, 10) : "未确认";
  const boundaries = [...(item.exclusionReasons ?? []), ...(item.dailyExclusionReasons ?? [])];
  return [
    `## ${inline(item.title)}`,
    "",
    inline(item.summary),
    "",
    "### 为什么重要",
    "",
    inline(item.whyItMatters),
    "",
    `- 领域：${item.domain ?? "未知"}`,
    `- 证据状态：${item.evidenceStatus ?? item.evidence}`,
    `- 来源日期：${published}`,
    ...(item.pageUpdatedAt ? [`- 页面更新时间：${item.pageUpdatedAt.slice(0, 10)}（不作为事件发布时间）`] : []),
    `- 原文：<${item.url}>`,
    ...(item.sourceExcerpt ? ["", `> 原文摘录：${inline(item.sourceExcerpt)}`] : []),
    ...(boundaries.length ? ["", `复核边界：${boundaries.map(inline).join("、")}`] : []),
  ].join("\n");
}

export function formalDocumentManifest(config: EffectiveConfig, result: RunResult): NonNullable<RunResult["documentManifest"]> {
  const projected = executionConfigProjection(config);
  const sourceManifestDigest = createHash("sha256").update(canonicalJson(projected.preset.sources)).digest("hex");
  const contractDigest = createHash("sha256").update(canonicalJson({ configDigest: result.configDigest, rules: projected.policy.rules,
    policy: projected.policy, prompts: projected.prompts, sources: projected.preset.sources })).digest("hex");
  return { contractDigest, sourceManifestDigest };
}

function common(config: EffectiveConfig, result: RunResult, kind: "daily" | "review", selected: BriefingItem[]): string[] {
  const counts = countReceipts(result.dueSourceIds ?? config.preset.sources.map((source) => source.id), result.receipts);
  const outcome = result.outcome ?? runOutcome(counts);
  const manifest = result.documentManifest ?? formalDocumentManifest(config, result);
  const day = result.runId.match(/^RUN-(\d{4})(\d{2})(\d{2})-/)?.slice(1, 4).join("-") ?? result.generatedAt.slice(0, 10);
  return [
    "---",
    `title: ${JSON.stringify(`${config.name} · ${kind === "daily" ? "日报" : "待复核"}`)}`,
    `type: ${kind === "daily" ? "briefing" : "review-queue"}`,
    `run_id: ${result.runId}`,
    `status: ${outcome}`,
    `created: ${day}`,
    `item_count: ${selected.length}`,
    `generated_at: ${result.generatedAt}`,
    `config_digest: ${result.configDigest}`,
    `contract_digest: ${manifest.contractDigest}`,
    `source_manifest_digest: ${manifest.sourceManifestDigest}`,
    ...(result.readerFormatVersion === 2 ? ["reader_format_version: 2"] : []),
    "---",
    "",
    `# ${inline(config.name)} · ${kind === "daily" ? "日报" : "待复核"}`,
    "",
  ];
}

export function renderFormalDaily(config: EffectiveConfig, result: RunResult, language: OutputLanguage = detectOutputLanguage()): string {
  const modern = result.readerFormatVersion === 2;
  const assessment = modern ? editorialAssessment(result.daily, language) : legacyAssessment(result.daily);
  const crossDomain = modern ? crossDomainAssessment(result.daily, language) : [result.daily.length
    ? "仅保留条目中有直接证据支持的影响说明；不自动扩展为未证实的系统性结论。"
    : "无可报告的跨领域影响。"];
  return output([...common(config, result, "daily", result.daily),
    "## 今日总判断", "", assessment, "",
    "## 候选条目", "", result.daily.length ? result.daily.map(item).join("\n\n") : "无。", "",
    "## 领域覆盖表", "", ...config.policy.domains.map((domain) => `- ${domain}: ${result.daily.filter((entry) => entry.domain === domain).length}`), "",
    "## 跨领域影响", "", ...crossDomain, "",
    "## 未收录线索", "", "未通过门槛的线索保留在审计控制面，不在阅读版展开。", "",
    "## 检索与质量说明", "", "本阅读版仅呈现通过一手证据核验的条目；运行审计保留在控制面。", ""].join("\n"), language);
}

export function renderFormalReview(config: EffectiveConfig, result: RunResult, language: OutputLanguage = detectOutputLanguage()): string {
  return output([...common(config, result, "review", result.review), "## 待复核候选", "", result.review.length ? result.review.map((entry) => `${item(entry)}\n\n需要用户决定什么：纳入、略过、比较、纠正分类/评分/来源，或记录流程反馈。`) .join("\n\n") : "没有边界候选通过待复核与稳定知识潜力门；队列未被填充。", "", "## 复核说明", "", "任何候选在用户明确决定前都不会进入常青知识库或改变生效规则。", ""].join("\n"), language);
}

export function validateFormalArtifact(config: EffectiveConfig, result: RunResult, kind: "daily" | "review", content: string): void {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match?.[1]) throw new Error(`${kind} artifact is missing YAML frontmatter`);
  const frontmatter = parse(match[1]) as Record<string, unknown>;
  if (frontmatter.run_id !== result.runId || frontmatter.status !== result.outcome) throw new Error(`${kind} artifact run identity or terminal status is inconsistent`);
  if (result.readerFormatVersion === 2 && frontmatter.reader_format_version !== 2) throw new Error(`${kind} artifact reader format version is inconsistent`);
  const expectedManifest = result.documentManifest ?? formalDocumentManifest(config, result);
  if (frontmatter.contract_digest !== expectedManifest.contractDigest || frontmatter.source_manifest_digest !== expectedManifest.sourceManifestDigest) {
    throw new Error(`${kind} artifact is not bound to the frozen execution contract`);
  }
  const required = kind === "daily" ? [["今日总判断", "Today's assessment"], ["候选条目", "Selected items"], ["领域覆盖表", "Domain coverage"], ["跨领域影响", "Cross-domain impact"], ["未收录线索", "Excluded leads"], ["检索与质量说明", "Retrieval and quality notes"]] : [["待复核候选", "Review candidates"], ["复核说明", "Review notes"]];
  for (const headings of required) if (!headings.some((heading) => content.includes(`## ${heading}`))) throw new Error(`${kind} artifact is missing section ${headings[0]}`);
  const fenceCount = (content.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 !== 0) throw new Error(`${kind} artifact has an unclosed code fence`);
  const selected = kind === "daily" ? result.daily : result.review;
  for (const item of selected) {
    if (item.sourceExcerpt && retainExcerpt(item.sourceExcerpt) !== item.sourceExcerpt.trim()) throw new Error(`${kind} artifact source excerpt exceeds the 25-word retention boundary for ${item.id}`);
    if (!content.includes(`## ${inline(item.title)}`) || !(content.includes(`- 原文：<${item.url}>`) || content.includes(`- Source: <${item.url}>`)) ||
      !(content.includes("### 为什么重要") || content.includes("### Why it matters"))) {
      throw new Error(`${kind} artifact is missing required fields for ${item.id}`);
    }
  }
}
