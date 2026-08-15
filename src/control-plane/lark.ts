import { createHash } from "node:crypto";

import type { EffectiveConfig, RuleSnapshot, SourceDefinition } from "../config/types.js";
import { canonicalJson } from "../config/load.js";
import { LarkCliClient, systemLarkRunner, type LarkFieldDefinition, type LarkRunner } from "./lark-cli.js";
import type { CanonicalControlRecord, ControlEntityKind, ControlPlaneCheck, ControlPlaneSnapshot, ControlPlaneStore, SyncPlan, SyncResult } from "./types.js";

const options = (...names: string[]) => names.map((name) => ({ name }));
const DOMAIN_OPTIONS = ["基础", "机器学习与深度学习", "模型与生成式 AI", "数据与知识", "系统与工程", "安全与治理", "应用域", "Agent"];

export const REQUIRED_LARK_FIELDS: Record<ControlEntityKind, string[]> = {
  sources: ["Source ID", "名称", "状态", "来源类型", "入口 URL", "采集方式", "采集域名", "来源层级", "覆盖领域", "扫描频率", "优先级", "最后扫描", "最后成功", "最后有效更新", "下次扫描", "调度状态"],
  runs: ["Run ID", "状态", "发布状态", "当前阶段", "触发类型", "工作流版本", "评分版本", "开始时间", "结束时间", "Obsidian 简报", "质量说明", "到期来源数", "到期清单摘要", "日报摘要", "待复核摘要"],
  items: ["Item ID", "标题", "当前状态", "Canonical URL", "中文摘要", "为什么值得关注", "主领域", "证据状态", "总分", "评分版本"],
  events: ["Event ID", "事件时间", "原状态", "新状态", "执行者", "迁移原因", "Rule ID 快照", "幂等键", "载荷指纹", "尝试次数", "错误码", "运行批次", "规则记录"],
  feedback: ["Feedback ID", "反馈时间", "判断", "原因标签", "反馈说明", "价值评分", "整合目标", "情报条目", "运行批次"],
  experiments: ["Experiment ID", "标题", "状态", "观察到的问题", "假设", "变更类型", "基线 Rule IDs", "候选 Rule IDs", "实验指标", "实验结论", "回滚条件", "审批结果"],
  captures: ["Capture ID", "发现 URL", "最终 URL", "Canonical 候选 URL", "发现渠道", "发现时间", "抓取时间", "抓取状态", "提取状态", "HTTP 状态码", "尝试次数", "内容类型", "语言", "原始标题", "原始作者或机构", "发布日期原值", "事件日期原值", "ETag", "Last-Modified", "内容哈希", "载荷指纹", "解析器版本", "失败原因", "运行批次", "数据源"],
  rules: ["Rule ID", "版本", "标题", "规则类型", "状态", "规则说明", "配置 JSON", "校验和", "回滚目标版本"],
  receipts: ["Scan ID", "扫描结果", "到期原因", "应扫描时间", "开始时间", "结束时间", "工作流版本", "错误与说明", "发现 URL 数", "新内容数", "标准化事件数", "入围数", "耗时毫秒", "执行通道", "响应指纹"],
};

const SCALAR_LARK_FIELDS: Record<ControlEntityKind, LarkFieldDefinition[]> = {
  sources: [
    { name: "Source ID", type: "text" }, { name: "名称", type: "text" }, { name: "状态", type: "select", options: options("启用", "停用") },
    { name: "来源类型", type: "select", options: options("官网", "官方博客", "官方文档", "GitHub", "X", "论文", "监管与标准", "媒体", "其他") },
    { name: "入口 URL", type: "text" }, { name: "采集方式", type: "select", options: options("Computer Use", "Codex Browser") }, { name: "采集域名", type: "text" },
    { name: "来源层级", type: "select", options: options("一手来源", "二手来源", "发现线索") },
    { name: "覆盖领域", type: "select", multiple: true, options: options(...DOMAIN_OPTIONS) }, { name: "扫描频率", type: "select", options: options("每日", "每周", "按需") }, { name: "优先级", type: "number" },
    { name: "最后扫描", type: "datetime" }, { name: "最后成功", type: "datetime" }, { name: "最后有效更新", type: "datetime" },
    { name: "下次扫描", type: "datetime" }, { name: "调度状态", type: "select", options: options("自动", "人工锁定") },
  ],
  runs: [
    { name: "Run ID", type: "text" }, { name: "状态", type: "select", options: options("运行中", "部分成功", "成功", "失败", "健康空结果") },
    { name: "当前阶段", type: "select", options: options("完成") },
    { name: "发布状态", type: "select", options: options("已发布", "已扣留") }, { name: "触发类型", type: "select", options: options("定时", "重跑") },
    { name: "工作流版本", type: "text" }, { name: "评分版本", type: "text" }, { name: "开始时间", type: "datetime" },
    { name: "结束时间", type: "datetime" }, { name: "Obsidian 简报", type: "text" }, { name: "质量说明", type: "text" },
    { name: "数据源数", type: "number" }, { name: "入围数", type: "number" }, { name: "到期来源数", type: "number" },
    { name: "到期清单摘要", type: "text" }, { name: "日报摘要", type: "text" }, { name: "待复核摘要", type: "text" },
  ],
  items: [
    { name: "Item ID", type: "text" }, { name: "标题", type: "text" }, { name: "当前状态", type: "select", options: options("已生成简报", "人工复核", "已淘汰") },
    { name: "Canonical URL", type: "text" }, { name: "中文摘要", type: "text" }, { name: "为什么值得关注", type: "text" },
    { name: "主领域", type: "select", options: options(...DOMAIN_OPTIONS) }, { name: "证据状态", type: "select", options: options("已确认", "部分确认", "待原始来源确认") }, { name: "总分", type: "number" },
    { name: "评分版本", type: "text" },
  ],
  events: [
    { name: "Event ID", type: "text" }, { name: "事件时间", type: "datetime" }, { name: "原状态", type: "select" },
    { name: "新状态", type: "select" }, { name: "执行者", type: "select" }, { name: "迁移原因", type: "text" }, { name: "Rule ID 快照", type: "text" },
    { name: "幂等键", type: "text" }, { name: "载荷指纹", type: "text" }, { name: "尝试次数", type: "number" }, { name: "错误码", type: "text" },
  ],
  feedback: [
    { name: "Feedback ID", type: "text" }, { name: "反馈时间", type: "datetime" }, { name: "判断", type: "select" },
    { name: "原因标签", type: "select" }, { name: "反馈说明", type: "text" }, { name: "价值评分", type: "number" },
    { name: "整合目标", type: "text" },
  ],
  experiments: [
    { name: "Experiment ID", type: "text" }, { name: "标题", type: "text" }, { name: "状态", type: "select" },
    { name: "观察到的问题", type: "text" }, { name: "假设", type: "text" }, { name: "变更类型", type: "select" },
    { name: "基线 Rule IDs", type: "text" }, { name: "候选 Rule IDs", type: "text" }, { name: "实验指标", type: "text" },
    { name: "实验结论", type: "text" }, { name: "回滚条件", type: "text" }, { name: "审批结果", type: "select" },
  ],
  captures: [
    { name: "Capture ID", type: "text" }, { name: "发现 URL", type: "text" }, { name: "最终 URL", type: "text" },
    { name: "Canonical 候选 URL", type: "text" }, { name: "发现渠道", type: "select", options: options("官网巡检", "X", "GitHub", "论文索引", "监管与标准入口", "其他") }, { name: "发现时间", type: "datetime" },
    { name: "抓取时间", type: "datetime" }, { name: "抓取状态", type: "select", options: options("成功", "失败", "访问受限", "等待重试", "隔离") },
    { name: "提取状态", type: "select", options: options("成功", "失败", "未尝试", "无需提取") },
    { name: "HTTP 状态码", type: "number" }, { name: "尝试次数", type: "number" }, { name: "内容类型", type: "text" },
    { name: "语言", type: "text" }, { name: "原始标题", type: "text" }, { name: "原始作者或机构", type: "text" },
    { name: "发布日期原值", type: "text" }, { name: "事件日期原值", type: "text" }, { name: "ETag", type: "text" },
    { name: "Last-Modified", type: "text" }, { name: "短摘录", type: "text" }, { name: "内容哈希", type: "text" },
    { name: "载荷指纹", type: "text" }, { name: "解析器版本", type: "text" }, { name: "失败原因", type: "text" },
  ],
  rules: [
    { name: "Rule ID", type: "text" }, { name: "版本", type: "text" }, { name: "标题", type: "text" },
    { name: "规则类型", type: "select" }, { name: "状态", type: "select", options: options("生效中") }, { name: "规则说明", type: "text" },
    { name: "配置 JSON", type: "text" }, { name: "校验和", type: "text" }, { name: "回滚目标版本", type: "text" },
  ],
  receipts: [
    { name: "Scan ID", type: "text" }, { name: "扫描结果", type: "select", options: options("有更新", "无更新", "失败", "跳过") },
    { name: "到期原因", type: "select", options: options("每日到期", "每周到期", "首次基线", "覆盖缺口", "人工强制") },
    { name: "应扫描时间", type: "datetime" }, { name: "开始时间", type: "datetime" }, { name: "结束时间", type: "datetime" },
    { name: "工作流版本", type: "text" }, { name: "错误与说明", type: "text" }, { name: "发现 URL 数", type: "number" },
    { name: "新内容数", type: "number" }, { name: "标准化事件数", type: "number" }, { name: "入围数", type: "number" },
    { name: "耗时毫秒", type: "number" }, { name: "执行通道", type: "select", options: options("官网与文档", "GitHub", "论文与监管", "中国厂商", "X") }, { name: "响应指纹", type: "text" },
  ],
};

const LINK_LARK_FIELDS: Partial<Record<ControlEntityKind, Array<{ name: string; target: ControlEntityKind }>>> = {
  runs: [{ name: "到期来源", target: "sources" }, { name: "发现条目", target: "items" }, { name: "原始采集", target: "captures" }, { name: "状态事件", target: "events" },
    { name: "扫描回执", target: "receipts" }, { name: "使用规则", target: "rules" }, { name: "人工反馈", target: "feedback" }],
  items: [{ name: "发现批次", target: "runs" }, { name: "来源", target: "sources" }, { name: "原始采集", target: "captures" }, { name: "评分规则", target: "rules" }, { name: "状态事件", target: "events" }],
  events: [{ name: "运行批次", target: "runs" }, { name: "情报条目", target: "items" }, { name: "规则记录", target: "rules" }, { name: "相关实验", target: "experiments" }],
  feedback: [{ name: "情报条目", target: "items" }, { name: "运行批次", target: "runs" }, { name: "相关实验", target: "experiments" }],
  experiments: [{ name: "基线规则", target: "rules" }, { name: "候选规则", target: "rules" }],
  captures: [{ name: "运行批次", target: "runs" }, { name: "数据源", target: "sources" }, { name: "情报条目", target: "items" }],
  receipts: [{ name: "运行批次", target: "runs" }, { name: "数据源", target: "sources" }, { name: "工作流规则", target: "rules" }],
};

const LARK_BATCH_LIMIT = 200;

function first(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return undefined;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : typeof value === "string" ? [value] : [];
}

function linkedRecordIds(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string" ? [(entry as { id: string }).id] : []) : [];
}

function linkUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const markdown = /^\[[^\]]*\]\((https:\/\/[^)]+)\)$/.exec(value.trim());
  const raw = markdown?.[1] ?? value.trim();
  try { const url = new URL(raw); return url.protocol === "https:" ? url.toString() : undefined; }
  catch { return undefined; }
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}+08:00` : value;
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function sourceType(value: string | undefined): NonNullable<SourceDefinition["sourceType"]> {
  return ({ 官网: "website", 官方博客: "official-blog", 官方文档: "official-docs", GitHub: "github", X: "x", 论文: "paper", "监管与标准": "regulation", 媒体: "media", 其他: "other" } as const)[value ?? ""] ?? "other";
}

function evidenceTier(value: string | undefined): NonNullable<SourceDefinition["evidenceTier"]> {
  return value === "一手来源" ? "primary" : value === "发现线索" ? "clue" : "secondary";
}

function frequency(value: string | undefined): NonNullable<NonNullable<SourceDefinition["scheduleState"]>["frequency"]> {
  return value === "每日" ? "daily" : value === "每周" ? "weekly" : "on-demand";
}

function cadence(value: string | undefined): NonNullable<SourceDefinition["cadence"]> {
  if (value === "每日") return { minimumHours: 6, defaultHours: 24, maximumHours: 168 };
  if (value === "每周") return { minimumHours: 24, defaultHours: 168, maximumHours: 720 };
  return { minimumHours: 168, defaultHours: 720, maximumHours: 2160 };
}

function githubRepository(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com") return undefined;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[1] === "releases") return undefined;
  if (parts.length >= 3 && parts[2] !== "releases") return undefined;
  return `${parts[0]}/${parts[1]}`;
}

function arxivFeed(url: string): string | undefined {
  const feed = /^https:\/\/export\.arxiv\.org\/rss\/([^/?#]+)\/?$/.exec(url);
  if (feed?.[1]) return `https://export.arxiv.org/rss/${feed[1]}`;
  const match = /^https:\/\/arxiv\.org\/list\/([^/]+)\/recent\/?$/.exec(url);
  return match?.[1] ? `https://export.arxiv.org/rss/${match[1]}` : undefined;
}

export function larkSource(row: { recordId: string; fields: Record<string, unknown> }, xCapture: "api" | "codex-browser" = "api"): SourceDefinition | null {
  const id = first(row.fields["Source ID"]);
  const title = first(row.fields["名称"]);
  const url = linkUrl(row.fields["入口 URL"]);
  if (!id || !title || !url || !/^SRC-[A-Z0-9-]+$/.test(id)) return null;
  const type = sourceType(first(row.fields["来源类型"]));
  const repository = type === "github" ? githubRepository(url) : undefined;
  const selectedFrequency = first(row.fields["扫描频率"]);
  const lastScanAt = isoDate(row.fields["最后扫描"]);
  const lastSuccessAt = isoDate(row.fields["最后成功"]);
  const lastEffectiveUpdateAt = isoDate(row.fields["最后有效更新"]);
  const nextScanAt = isoDate(row.fields["下次扫描"]);
  const captureMethod = first(row.fields["采集方式"]);
  const feed = captureMethod === "RSS" || new URL(url).pathname.toLowerCase().endsWith(".rss") ? url : arxivFeed(url);
  const captureHosts = (first(row.fields["采集域名"]) ?? "").split(/[\s,，]+/).map((host) => host.trim().toLowerCase()).filter((host) => /^[A-Za-z0-9.-]+$/.test(host));
  return {
    id, title, enabled: list(row.fields["状态"]).includes("启用"), sourceType: type,
    evidenceTier: evidenceTier(first(row.fields["来源层级"])), coverageDomains: list(row.fields["覆盖领域"]),
    ...(list(row.fields["覆盖领域"])[0] ? { domain: list(row.fields["覆盖领域"])[0] } : {}),
    ...(typeof row.fields["优先级"] === "number" ? { priority: row.fields["优先级"] } : {}),
    cadence: cadence(selectedFrequency),
    scheduleState: {
      frequency: frequency(selectedFrequency),
      ...(lastScanAt ? { lastScanAt } : {}),
      ...(lastSuccessAt ? { lastSuccessAt } : {}),
      ...(lastEffectiveUpdateAt ? { lastEffectiveUpdateAt } : {}),
      ...(nextScanAt ? { nextScanAt } : {}),
      ...(list(row.fields["调度状态"]).includes("人工锁定") ? { humanLocked: true } : {}),
    },
    connector: captureMethod === "Computer Use" ? { type: "computer-use", config: { url, allowedHosts: [...new Set(captureHosts.length ? captureHosts : [new URL(url).hostname])] } }
      : captureMethod === "Codex Browser" && type !== "x" ? { type: "in-app-browser", config: { url, allowedHosts: [...new Set(captureHosts.length ? captureHosts : [new URL(url).hostname])] } }
      : repository ? { type: "github-releases", config: { repository } }
      : feed ? { type: "rss", config: { url: feed } }
      : type === "x" && /^https:\/\/x\.com\/([A-Za-z0-9_]+)\/?$/.test(url) ? (captureMethod === "Codex Browser" || (!captureMethod && xCapture === "codex-browser")
        ? { type: "codex-browser", config: { username: /^https:\/\/x\.com\/([A-Za-z0-9_]+)/.exec(url)![1]! } }
        : { type: "x-api", config: { username: /^https:\/\/x\.com\/([A-Za-z0-9_]+)/.exec(url)![1]!, bearerToken: { provider: "env", key: "X_BEARER_TOKEN" } } })
      : { type: "webpage", config: { url } },
  };
}

function rule(row: { recordId: string; fields: Record<string, unknown> }): RuleSnapshot | null {
  const id = first(row.fields["Rule ID"]); const version = first(row.fields["版本"]); const title = first(row.fields["标题"]);
  return id && version && title && list(row.fields["状态"]).includes("生效中") ? { id, version, title } : null;
}

function optionalInteger(value: unknown): number | undefined {
  const scalar = Array.isArray(value) ? value[0] : value;
  if (typeof scalar === "number" && Number.isSafeInteger(scalar) && scalar >= 0) return scalar;
  if (typeof scalar === "string" && /^\d+$/.test(scalar.trim())) return Number.parseInt(scalar, 10);
  return undefined;
}

function historicalPayload(kind: ControlEntityKind, id: string, fields: Record<string, unknown>, links: NonNullable<CanonicalControlRecord["links"]>): Record<string, unknown> {
  if (kind === "runs") return compact({ run_id: id, status: first(fields["状态"]) === "成功" ? "success" : first(fields["状态"]) === "部分成功" ? "partial" : first(fields["状态"]) === "健康空结果" ? "empty" : first(fields["状态"]) === "失败" ? "failed" : "running",
    publication_state: first(fields["发布状态"]) === "已发布" ? "published" : "withheld",
    current_stage: first(fields["当前阶段"]) ?? "complete", config_digest: `remote:${digest(fields)}`, generated_at: isoDate(fields["开始时间"]), started_at: isoDate(fields["开始时间"]), completed_at: isoDate(fields["结束时间"]),
    due_source_count: optionalInteger(fields["到期来源数"]), due_manifest_digest: first(fields["到期清单摘要"]), daily_artifact_digest: first(fields["日报摘要"]), review_artifact_digest: first(fields["待复核摘要"]) });
  if (kind === "items") return { item_id: id, title: first(fields["标题"]) ?? id, score: typeof fields["总分"] === "number" ? fields["总分"] : 0,
    disposition: first(fields["当前状态"]) === "人工复核" ? "review" : ["已生成简报", "已整合"].includes(first(fields["当前状态"]) ?? "") ? "daily" : "machine-only",
    summary: first(fields["中文摘要"]) ?? "", why_it_matters: first(fields["为什么值得关注"]) ?? "", domain: first(fields["主领域"]) ?? "unknown",
    evidence_status: first(fields["证据状态"]) === "已确认" ? "confirmed-primary" : first(fields["证据状态"]) === "部分确认" ? "secondary-clue" : "unverified",
    analysis_json: JSON.stringify({ url: linkUrl(fields["Canonical URL"]), importedFrom: "lark" }) };
  if (kind === "captures") return { capture_id: id, source_id: links.sources?.[0] ?? "UNKNOWN", canonical_url: linkUrl(fields["Canonical 候选 URL"]) ?? linkUrl(fields["最终 URL"]) ?? linkUrl(fields["发现 URL"]) ?? "https://invalid.local/",
    content_hash: first(fields["内容哈希"]) ?? first(fields["载荷指纹"]) ?? digest(fields), title: first(fields["原始标题"]) ?? id, summary: first(fields["短摘录"]) ?? "",
    captured_at: isoDate(fields["抓取时间"]), published_at: isoDate(fields["发现时间"]), evidence_class: "secondary",
    discovery_channel: first(fields["发现渠道"]), fetch_status: first(fields["抓取状态"]), extract_status: first(fields["提取状态"]),
    http_status: fields["HTTP 状态码"], attempts: fields["尝试次数"], content_type: first(fields["内容类型"]), language: first(fields["语言"]),
    author: first(fields["原始作者或机构"]), published_raw: first(fields["发布日期原值"]), event_date_raw: first(fields["事件日期原值"]),
    etag: first(fields["ETag"]), last_modified: first(fields["Last-Modified"]), parser_version: first(fields["解析器版本"]), failure_reason: first(fields["失败原因"]) };
  if (kind === "receipts") return { run_id: links.runs?.[0] ?? "UNKNOWN", source_id: links.sources?.[0] ?? "UNKNOWN",
    result: first(fields["扫描结果"]) === "有更新" ? "updated" : first(fields["扫描结果"]) === "无更新" ? "unchanged" : first(fields["扫描结果"]) === "失败" ? "failed" : "skipped",
    detail: first(fields["错误与说明"]), attempted_at: isoDate(fields["开始时间"]), completed_at: isoDate(fields["结束时间"]), capture_count: fields["发现 URL 数"] };
  if (kind === "events") return { event_id: id, event_type: first(fields["新状态"]) ?? "remote.transition", idempotency_key: first(fields["幂等键"]) ?? `remote:${id}`,
    payload_fingerprint: first(fields["载荷指纹"]) ?? digest(fields), occurred_at: isoDate(fields["事件时间"]), stage: first(fields["新状态"]) ?? "remote", payload_json: JSON.stringify({ reason: first(fields["迁移原因"]), importedFrom: "lark" }) };
  if (kind === "experiments") return { experiment_id: id, status: first(fields["状态"]) ?? "remote", metrics_json: first(fields["实验指标"]), candidate_policy_json: JSON.stringify({ hypothesis: first(fields["假设"]) }) };
  if (kind === "feedback") {
    const judgment = first(fields["判断"]); const feedbackType = ({ 纳入: "include", 略过: "skip", 复核: "review", 比较: "compare", 分类纠正: "classification-correction", 纠正分类: "classification-correction", 评分纠正: "score-correction", 纠正评分: "score-correction", 来源纠正: "source-correction", 纠正来源: "source-correction", 流程反馈: "process-feedback", 反馈流程: "process-feedback" } as Record<string, string>)[judgment ?? ""] ?? "reviewed";
    return { feedback_id: id, feedback_type: feedbackType, original_judgment: judgment, note: first(fields["反馈说明"]), created_at: isoDate(fields["反馈时间"]) };
  }
  return fields;
}

function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return value && typeof value === "object" ? value as Record<string, unknown> : {};
  try { const parsed = JSON.parse(value) as unknown; return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

function larkDate(value: unknown): string | undefined {
  const iso = isoDate(value); if (!iso) return undefined;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const valueByType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${valueByType.year}-${valueByType.month}-${valueByType.day} ${valueByType.hour}:${valueByType.minute}:${valueByType.second}`;
}

function compact(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
}

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  if (typeof value === "string") {
    const linked = /^\[[^\]]*\]\((https:\/\/[^)]+)\)$/.exec(value.trim()); if (linked?.[1]) return linked[1];
    const date = isoDate(value); if (date && /^\d{4}-\d{2}-\d{2}[ T]/.test(value)) return date;
  }
  return value;
}

function fieldsMatch(actual: Record<string, unknown>, expected: Record<string, unknown>, only?: string[]): boolean {
  const keys = only ?? Object.keys(expected); return keys.every((key) => {
    if (expected[key] === undefined) return true;
    const rawActual = expected[key] === "" && (actual[key] === undefined || actual[key] === null || (Array.isArray(actual[key]) && (actual[key] as unknown[]).length === 0)) ? "" : actual[key];
    const actualValue = Array.isArray(rawActual) && !Array.isArray(expected[key]) && rawActual.length === 1 ? rawActual[0] : rawActual;
    const expectedValue = Array.isArray(expected[key]) && !Array.isArray(actual[key]) && (expected[key] as unknown[]).length === 1 ? (expected[key] as unknown[])[0] : expected[key];
    return canonicalJson(comparable(actualValue)) === canonicalJson(comparable(expectedValue));
  });
}

const SOURCE_RUNTIME_FIELDS = new Set(["最后扫描", "最后成功", "最后有效更新", "下次扫描"]);

function comparisonFields(record: CanonicalControlRecord, fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([name]) => {
    if (record.kind === "sources" && SOURCE_RUNTIME_FIELDS.has(name)) return false;
    // The remote rule title is governed reader-facing metadata. Local policy titles are
    // implementation labels, so syncing a run must preserve the remote title.
    if (record.kind === "rules" && name === "标题") return false;
    return true;
  }));
}

function writableLarkFields(_kind: ControlEntityKind, fields: Record<string, unknown>): Record<string, unknown> {
  return fields;
}

function captureDiscoveryChannel(value: unknown, url: unknown): string {
  const channel = String(value ?? "");
  if (["官网巡检", "X", "GitHub", "论文索引", "监管与标准入口", "其他"].includes(channel)) return channel;
  if (["x-api", "codex-browser"].includes(channel)) return "X";
  if (channel === "github-releases") return "GitHub";
  if (channel === "rss") {
    try {
      const host = new URL(String(url)).hostname.toLowerCase();
      if (host === "export.arxiv.org" || host.endsWith("nature.com")) return "论文索引";
    } catch { /* invalid URLs are retained elsewhere as failed evidence */ }
    return "官网巡检";
  }
  if (["webpage", "in-app-browser", "computer-use"].includes(channel)) return "官网巡检";
  return "其他";
}

function receiptExecutionChannel(value: unknown): string {
  const channel = String(value ?? "");
  if (["官网与文档", "GitHub", "论文与监管", "中国厂商", "X"].includes(channel)) return channel;
  if (["x-api", "codex-browser"].includes(channel)) return "X";
  if (channel === "github-releases") return "GitHub";
  if (channel === "rss") return "论文与监管";
  return "官网与文档";
}

function captureFetchStatus(value: unknown): string {
  return ({ success: "成功", failed: "失败", restricted: "访问受限", "robots-blocked": "访问受限", isolated: "隔离" } as Record<string, string>)[String(value)] ?? "成功";
}

function captureExtractStatus(value: unknown): string {
  return ({ success: "成功", failed: "失败", "not-attempted": "未尝试", isolated: "未尝试" } as Record<string, string>)[String(value)] ?? "成功";
}

const SOURCE_TYPE_TO_LARK: Record<NonNullable<SourceDefinition["sourceType"]>, string> = {
  website: "官网", "official-blog": "官方博客", "official-docs": "官方文档", github: "GitHub", x: "X",
  paper: "论文", regulation: "监管与标准", media: "媒体", other: "其他",
};

export function larkFields(record: CanonicalControlRecord, links: Partial<Record<ControlEntityKind, Map<string, string>>> = {}): Record<string, unknown> {
  const p = record.payload;
  const linked = (kind: ControlEntityKind): Array<{ id: string }> | undefined => {
    const ids = record.links?.[kind]?.map((id) => links[kind]?.get(id)).filter((id): id is string => Boolean(id));
    return ids?.length ? ids.map((id) => ({ id })) : undefined;
  };
  if (record.kind === "sources") {
    const source = p as unknown as SourceDefinition;
    const url = "url" in source.connector.config ? source.connector.config.url : source.connector.type === "github-releases" ? `https://github.com/${source.connector.config.repository}/releases`
      : source.connector.type === "x-api" || source.connector.type === "codex-browser" ? `https://x.com/${source.connector.config.username}` : undefined;
    const captureMethod = source.connector.type === "computer-use" ? "Computer Use" : source.connector.type === "in-app-browser" || source.connector.type === "codex-browser" ? "Codex Browser" : "";
    return compact({ "Source ID": source.id, "名称": source.title, "状态": source.enabled === false ? "停用" : "启用",
      "来源类型": SOURCE_TYPE_TO_LARK[source.sourceType ?? "other"], "入口 URL": url, "采集方式": captureMethod,
      "采集域名": source.connector.type === "computer-use" || source.connector.type === "in-app-browser" ? (source.connector.config.allowedHosts ?? [new URL(source.connector.config.url).hostname]).join(", ") : "",
      "来源层级": source.evidenceTier === "primary" ? "一手来源" : source.evidenceTier === "clue" ? "发现线索" : "二手来源",
      "覆盖领域": source.coverageDomains ?? (source.domain ? [source.domain] : []), "扫描频率": source.scheduleState?.frequency === "weekly" ? "每周" : source.scheduleState?.frequency === "on-demand" ? "按需" : "每日",
      "优先级": source.priority, "调度状态": source.scheduleState?.humanLocked ? "人工锁定" : "自动", "最后扫描": larkDate(source.scheduleState?.lastScanAt), "最后成功": larkDate(source.scheduleState?.lastSuccessAt),
      "最后有效更新": larkDate(source.scheduleState?.lastEffectiveUpdateAt), "下次扫描": larkDate(source.scheduleState?.nextScanAt) });
  }
  if (record.kind === "runs") {
    const result = jsonObject(p.result_json); const plan = jsonObject(p.execution_plan_json); const provenance = jsonObject(plan.provenance);
    const rules = Array.isArray(plan.rules) ? plan.rules as Array<Record<string, unknown>> : [];
    const workflowVersion = rules.find((entry) => String(entry.id).startsWith("RULE-WORKFLOW-"))?.version;
    const scoreVersion = rules.find((entry) => String(entry.id).startsWith("RULE-SCORE-"))?.version;
    const artifacts = jsonObject(result.artifactPaths); const integrity = jsonObject(result.integrityManifest);
    return compact({ "Run ID": record.id, "状态": p.status === "success" ? "成功" : p.status === "partial" ? "部分成功" : p.status === "empty" ? "健康空结果" : p.status === "failed" ? "失败" : "运行中",
      "发布状态": p.publication_state === "published" || result.publicationState === "published" ? "已发布" : "已扣留",
      "当前阶段": p.current_stage === "complete" ? "完成" : p.current_stage, "触发类型": result.runKind === "formal-retry" ? "重跑" : "定时",
      "工作流版本": workflowVersion ?? provenance.coreVersion, "评分版本": scoreVersion ?? provenance.policyVersion,
      "开始时间": larkDate(p.started_at ?? p.generated_at), "结束时间": larkDate(p.completed_at), "Obsidian 简报": artifacts.daily,
      "质量说明": result.outcome ? `Briefwright ${String(result.outcome)}; config ${String(p.config_digest).slice(0, 12)}` : undefined,
      "数据源数": record.links?.sources?.length ?? 0, "入围数": [...(Array.isArray(result.daily) ? result.daily : []), ...(Array.isArray(result.review) ? result.review : [])].length,
      "到期来源数": Array.isArray(integrity.dueSourceIds) ? integrity.dueSourceIds.length : p.due_source_count,
      "到期清单摘要": integrity.dueManifestDigest ?? p.due_manifest_digest, "日报摘要": integrity.dailyArtifactDigest ?? p.daily_artifact_digest,
      "待复核摘要": integrity.reviewArtifactDigest ?? p.review_artifact_digest,
      "发现条目": linked("items"), "原始采集": linked("captures"), "状态事件": linked("events"), "扫描回执": linked("receipts"), "使用规则": linked("rules"), "人工反馈": linked("feedback") });
  }
  if (record.kind === "items") {
    const analysis = jsonObject(p.analysis_json);
    const evidence = p.evidence_status === "confirmed-primary" ? "已确认" : p.evidence_status === "secondary-clue" ? "部分确认" : "待原始来源确认";
    return compact({ "Item ID": record.id, "标题": p.title, "当前状态": p.disposition === "daily" ? "已生成简报" : p.disposition === "review" ? "人工复核" : "已淘汰",
      "Canonical URL": analysis.url, "中文摘要": p.summary, "为什么值得关注": p.why_it_matters, "主领域": p.domain,
      "证据状态": evidence, "总分": p.score, "评分版本": "1.0", "发现批次": linked("runs"), "来源": linked("sources"), "原始采集": linked("captures"), "评分规则": linked("rules"), "状态事件": linked("events") });
  }
  if (record.kind === "captures") {
    const raw = jsonObject(p.raw_json);
    const value = (camel: string, snake: string) => raw[camel] ?? p[snake];
    const discoveryUrl = value("discoveryUrl", "discovery_url") ?? p.canonical_url;
    return compact({ "Capture ID": record.id, "发现 URL": value("discoveryUrl", "discovery_url") ?? p.canonical_url, "最终 URL": p.canonical_url,
      "Canonical 候选 URL": p.canonical_url, "发现渠道": captureDiscoveryChannel(value("discoveryChannel", "discovery_channel"), discoveryUrl), "原始标题": p.title,
      "短摘录": p.summary, "内容哈希": p.content_hash, "发现时间": larkDate(p.published_at ?? p.captured_at), "抓取时间": larkDate(p.captured_at),
      "抓取状态": captureFetchStatus(value("fetchStatus", "fetch_status")),
      "提取状态": captureExtractStatus(value("extractStatus", "extract_status")),
      "HTTP 状态码": value("httpStatus", "http_status"), "尝试次数": value("attempts", "attempts"), "内容类型": value("contentType", "content_type"),
      "语言": value("language", "language"), "原始作者或机构": value("author", "author"), "发布日期原值": value("publishedRaw", "published_raw"),
      "事件日期原值": value("eventDateRaw", "event_date_raw"), "ETag": value("etag", "etag"), "Last-Modified": value("lastModified", "last_modified"),
      "解析器版本": value("parserVersion", "parser_version"), "失败原因": value("failureReason", "failure_reason"), "载荷指纹": p.content_hash,
      "运行批次": linked("runs"), "数据源": linked("sources"), "情报条目": linked("items") });
  }
  if (record.kind === "receipts") return compact({ "Scan ID": record.id, "扫描结果": p.result === "updated" ? "有更新" : p.result === "unchanged" ? "无更新" : p.result === "failed" ? "失败" : "跳过",
    "到期原因": String(p.due_reason ?? "").startsWith("recovery-") ? "人工强制" : String(p.due_reason ?? "").includes("never") ? "首次基线" : "每日到期",
    "开始时间": larkDate(p.attempted_at), "结束时间": larkDate(p.completed_at), "错误与说明": p.detail,
    "发现 URL 数": p.capture_count, "耗时毫秒": p.duration_ms, "执行通道": receiptExecutionChannel(p.execution_channel), "工作流版本": record.links?.rules?.find((id) => id.startsWith("RULE-WORKFLOW-"))?.match(/-V(\d+\.\d+)$/)?.[1],
    "运行批次": linked("runs"), "数据源": linked("sources"), "工作流规则": linked("rules") });
  if (record.kind === "events") {
    const detail = jsonObject(p.payload_json);
    return compact({ "Event ID": record.id, "事件时间": larkDate(p.occurred_at), "原状态": detail.fromState ?? "无",
    "新状态": detail.toState ?? (p.stage === "complete" ? "已生成简报" : "已发现"), "执行者": detail.actor ?? "编排器",
    "迁移原因": detail.reason ?? p.event_type, "幂等键": p.idempotency_key, "载荷指纹": p.payload_fingerprint,
    "Rule ID 快照": detail.ruleIdSnapshot ?? record.links?.rules?.[0], "尝试次数": detail.attempts, "错误码": detail.errorCode ?? detail.detail,
    "运行批次": linked("runs"), "情报条目": linked("items"), "规则记录": linked("rules"), "相关实验": linked("experiments") });
  }
  if (record.kind === "feedback") {
    const judgment = ({ include: "纳入", used: "纳入", "knowledge-worthy": "纳入", skip: "略过", ignored: "略过", review: "复核", reviewed: "复核",
      compare: "比较", "classification-correction": "纠正分类", "score-correction": "纠正评分", "source-correction": "纠正来源", "process-feedback": "流程反馈" } as Record<string, string>)[String(p.feedback_type)] ?? "复核";
    return compact({ "Feedback ID": record.id, "反馈时间": larkDate(p.created_at), "判断": judgment, "原因标签": p.feedback_type,
      "反馈说明": p.note, "情报条目": linked("items"), "运行批次": linked("runs"), "相关实验": linked("experiments") });
  }
  if (record.kind === "experiments") {
    const baseline = jsonObject(p.baseline_policy_json); const candidate = jsonObject(p.candidate_policy_json);
    const baselineRules = Array.isArray(baseline.rules) ? (baseline.rules as Array<Record<string, unknown>>).map((item) => String(item.id)).sort() : [];
    const candidateRules = Array.isArray(candidate.rules) ? (candidate.rules as Array<Record<string, unknown>>).map((item) => String(item.id)).sort() : [];
    const status = ({ candidate: "观察中", evaluated: "观察中", approved: "已采纳", active: "运行中", "rolled-back": "已回滚", rejected: "已拒绝" } as Record<string, string>)[String(p.status)] ?? p.status;
    return compact({ "Experiment ID": record.id, "标题": `Briefwright experiment ${record.id}`, "状态": status,
      "假设": candidate.hypothesis, "基线 Rule IDs": baselineRules.join(" | "), "候选 Rule IDs": candidateRules.join(" | "),
      "实验指标": p.metrics_json, "实验结论": p.status === "approved" ? "approved" : undefined,
      "基线规则": linked("rules"), "候选规则": linked("rules") });
  }
  if (record.kind === "rules") return compact({ "Rule ID": p.id ?? record.id, "版本": p.version, "标题": p.title, "状态": "生效中" });
  return p;
}

function larkLinkFields(record: CanonicalControlRecord, links: Partial<Record<ControlEntityKind, Map<string, string>>>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const relation of LINK_LARK_FIELDS[record.kind] ?? []) {
    const businessIds = record.links?.[relation.target];
    if (!businessIds?.length) continue;
    const resolved = businessIds.map((id) => links[relation.target]?.get(id));
    const missing = businessIds.filter((_id, index) => !resolved[index]);
    if (missing.length) throw new Error(`unresolved ${relation.target} links: ${missing.length}`);
    fields[relation.name] = resolved.map((id) => ({ id }));
  }
  return fields;
}

function chunks<T>(values: T[], maximum = LARK_BATCH_LIMIT): T[][] {
  return Array.from({ length: Math.ceil(values.length / maximum) }, (_value, index) => values.slice(index * maximum, (index + 1) * maximum));
}

export interface LarkProvisionResult {
  tables: Record<ControlEntityKind, string>;
  createdTables: string[];
  createdFields: string[];
  updatedFields: string[];
}

/**
 * Idempotently creates the standard Briefwright Base shape. Existing tables and
 * fields are preserved; this command never deletes or renames user data.
 */
export function provisionLarkControlPlane(
  config: NonNullable<EffectiveConfig["controlPlane"]["lark"]>,
  runner: LarkRunner = systemLarkRunner(config.profile),
): LarkProvisionResult {
  const client = new LarkCliClient(config.baseToken, config.identity, runner);
  const configuredNames = config.tables;
  const discovered = client.tables();
  const duplicateNames = discovered.map((table) => table.name).filter((name, index, values) => values.indexOf(name) !== index);
  if (duplicateNames.length) throw new Error(`Lark Base contains duplicate table names: ${[...new Set(duplicateNames)].join(", ")}; configure explicit table IDs`);
  const byName = new Map(discovered.map((table) => [table.name, table.id]));
  const byId = new Map(discovered.map((table) => [table.id, table.id]));
  const tables = {} as Record<ControlEntityKind, string>;
  const createdTables: string[] = [];
  const createdFields: string[] = [];
  const updatedFields: string[] = [];

  for (const kind of Object.keys(SCALAR_LARK_FIELDS) as ControlEntityKind[]) {
    const configured = configuredNames[kind];
    const existing = byId.get(configured) ?? byName.get(configured);
    if (existing) { tables[kind] = existing; continue; }
    if (configured.startsWith("tbl")) throw new Error(`Configured Lark table ID does not exist for ${kind}: ${configured}`);
    const id = client.createTable(configured, SCALAR_LARK_FIELDS[kind]);
    tables[kind] = id; byId.set(id, id); byName.set(configured, id); createdTables.push(configured);
  }

  for (const kind of Object.keys(SCALAR_LARK_FIELDS) as ControlEntityKind[]) {
    const actual = new Map(client.fields(tables[kind]).map((field) => [field.name, field]));
    for (const field of SCALAR_LARK_FIELDS[kind]) {
      const existing = actual.get(field.name);
      if (!existing) {
        client.createField(tables[kind], field); createdFields.push(`${configuredNames[kind]}.${field.name}`); actual.set(field.name, { id: "created", ...field });
        continue;
      }
      if (existing.type !== field.type) throw new Error(`Lark field ${configuredNames[kind]}.${field.name} has type ${existing.type}; expected ${field.type}`);
      if (field.type !== "select" || !field.options?.length) continue;
      const existingNames = new Set((existing.options ?? []).map((option) => option.name));
      const missing = field.options.filter((option) => !existingNames.has(option.name));
      if (!missing.length) continue;
      const updated = { name: existing.name, type: "select" as const, multiple: existing.multiple ?? field.multiple ?? false, options: [...(existing.options ?? []), ...missing] };
      client.updateField(tables[kind], existing.id, updated); updatedFields.push(`${configuredNames[kind]}.${field.name}`); actual.set(field.name, { ...existing, ...updated });
    }
    for (const link of LINK_LARK_FIELDS[kind] ?? []) {
      const existing = actual.get(link.name);
      if (existing) {
        if (existing.type !== "link" || existing.link_table !== tables[link.target]) throw new Error(`Lark field ${configuredNames[kind]}.${link.name} must be a link to ${configuredNames[link.target]}`);
        continue;
      }
      client.createField(tables[kind], { name: link.name, type: "link", link_table: tables[link.target] });
      createdFields.push(`${configuredNames[kind]}.${link.name}`); actual.set(link.name, { id: "created", name: link.name, type: "link", link_table: tables[link.target] });
    }
  }
  return { tables, createdTables, createdFields, updatedFields };
}

export class LarkControlPlaneStore implements ControlPlaneStore {
  readonly driver = "lark" as const;
  private readonly client: LarkCliClient;

  constructor(private readonly config: NonNullable<EffectiveConfig["controlPlane"]["lark"]>, runner?: LarkRunner) {
    this.client = new LarkCliClient(config.baseToken, config.identity, runner ?? systemLarkRunner(config.profile));
  }

  async doctor(): Promise<ControlPlaneCheck[]> {
    const checks: ControlPlaneCheck[] = [];
    try { const version = this.client.version(); checks.push({ name: "lark-cli-version", ok: /^lark-cli version \d+\.\d+\.\d+$/.test(version), detail: version }); }
    catch (error) { return [{ name: "lark-cli-version", ok: false, detail: error instanceof Error ? error.message : String(error) }]; }
    try { this.client.whoami(); checks.push({ name: "lark-cli-identity", ok: true, detail: `${this.config.identity} identity is available` }); }
    catch (error) { return [{ name: "lark-cli-identity", ok: false, detail: error instanceof Error ? error.message : String(error) }]; }
    for (const kind of Object.keys(REQUIRED_LARK_FIELDS) as ControlEntityKind[]) {
      try {
        const fields = this.client.fields(this.config.tables[kind]);
        const actual = new Set(fields.map((field) => field.name));
        const missing = REQUIRED_LARK_FIELDS[kind].filter((field) => !actual.has(field));
        const invalidLinks = (LINK_LARK_FIELDS[kind] ?? []).flatMap((link) => {
          const field = fields.find((entry) => entry.name === link.name);
          return !field ? [`${link.name}:missing`] : field.type !== "link" ? [`${link.name}:type=${field.type}`]
            : field.link_table !== this.config.tables[link.target] ? [`${link.name}:target=${field.link_table ?? "unknown"}`] : [];
        });
        const invalidScalars = SCALAR_LARK_FIELDS[kind].flatMap((expected) => {
          const field = fields.find((entry) => entry.name === expected.name);
          if (!field) return [];
          if (field.type !== expected.type) return [`${expected.name}:type=${field.type},expected=${expected.type}`];
          if (expected.type !== "select" || !expected.options?.length) return [];
          const actualOptions = new Set((field.options ?? []).map((option) => option.name));
          const missingOptions = expected.options.filter((option) => !actualOptions.has(option.name)).map((option) => option.name);
          return missingOptions.length ? [`${expected.name}:missing-options=${missingOptions.join("|")}`] : [];
        });
        const problems = [...missing.map((field) => `${field}:missing`), ...invalidScalars, ...invalidLinks];
        checks.push({ name: `lark-table:${kind}`, ok: problems.length === 0, detail: problems.length ? `invalid fields: ${problems.join(", ")}` : `${actual.size} fields; scalar and link mappings are present` });
        const count = this.client.countRecords(this.config.tables[kind], REQUIRED_LARK_FIELDS[kind][0]!);
        const limit = this.config.maximumRecordsPerTable ?? 2000;
        const remaining = limit - count;
        checks.push({ name: `lark-capacity:${kind}`, ok: remaining > 0,
          detail: `${count}/${limit} records; ${Math.max(remaining, 0)} writable slots remain${remaining <= Math.ceil(limit * 0.1) ? "; archive or move the append-only ledger before the next formal run" : ""}` });
      } catch (error) { checks.push({ name: `lark-table:${kind}`, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
    }
    try { this.client.upsert(this.config.tables.runs, { "Run ID": "BRIEFWRIGHT-DOCTOR-DRY-RUN" }, undefined, true); checks.push({ name: "lark-write-request", ok: true, detail: "record-upsert dry-run request compiled; no record was written" }); }
    catch (error) { checks.push({ name: "lark-write-request", ok: false, detail: error instanceof Error ? error.message : String(error) }); }
    return checks;
  }

  async pull(mode: "context" | "full" = "context"): Promise<ControlPlaneSnapshot> {
    const rowsByKind = {} as Record<ControlEntityKind, Array<{ recordId: string; fields: Record<string, unknown> }>>;
    const fieldsFor = (kind: ControlEntityKind) => [...new Set([...REQUIRED_LARK_FIELDS[kind], ...(LINK_LARK_FIELDS[kind] ?? []).map((link) => link.name)])];
    rowsByKind.sources = this.client.records(this.config.tables.sources, fieldsFor("sources"));
    rowsByKind.rules = this.client.records(this.config.tables.rules, fieldsFor("rules"));
    rowsByKind.items = this.client.records(this.config.tables.items, mode === "full" ? fieldsFor("items") : ["Item ID"]);
    rowsByKind.runs = this.client.records(this.config.tables.runs, fieldsFor("runs"));
    rowsByKind.feedback = this.client.records(this.config.tables.feedback, fieldsFor("feedback"));
    if (mode === "full") for (const kind of ["events", "experiments", "captures", "receipts"] as ControlEntityKind[]) rowsByKind[kind] = this.client.records(this.config.tables[kind], fieldsFor(kind));
    const sourceRows = rowsByKind.sources; const ruleRows = rowsByKind.rules; const itemRows = rowsByKind.items; const runRows = rowsByKind.runs;
    const itemIds = new Map(itemRows.map((row) => [row.recordId, first(row.fields["Item ID"])])); const runIds = new Map(runRows.map((row) => [row.recordId, first(row.fields["Run ID"])]));
    const feedbackRows = rowsByKind.feedback;
    const allSources = sourceRows.map((row) => larkSource(row, this.config.xCapture)).filter((source): source is SourceDefinition => source !== null);
    const sources = allSources.filter((source) => source.enabled !== false);
    const rules = ruleRows.map(rule).filter((item): item is RuleSnapshot => item !== null).sort((a, b) => a.id.localeCompare(b.id));
    const feedback: CanonicalControlRecord[] = feedbackRows.flatMap((row) => {
      const id = first(row.fields["Feedback ID"]); if (!id) return [];
      const judgment = first(row.fields["判断"]); const feedbackType = ({ 纳入: "include", 略过: "skip", 复核: "review", 比较: "compare", 分类纠正: "classification-correction", 评分纠正: "score-correction", 来源纠正: "source-correction", 流程反馈: "process-feedback" } as Record<string, string>)[judgment ?? ""] ?? "reviewed";
      const items = linkedRecordIds(row.fields["情报条目"]).map((recordId) => itemIds.get(recordId)).filter((value): value is string => Boolean(value));
      const runs = linkedRecordIds(row.fields["运行批次"]).map((recordId) => runIds.get(recordId)).filter((value): value is string => Boolean(value));
      return [{ kind: "feedback", id, storeRecordId: row.recordId, payload: { feedback_id: id, feedback_type: feedbackType, original_judgment: judgment, note: first(row.fields["反馈说明"]), created_at: isoDate(row.fields["反馈时间"]) }, links: { ...(items.length ? { items } : {}), ...(runs.length ? { runs } : {}) } }];
    });
    let records: CanonicalControlRecord[] = [
      ...allSources.map((source) => { const storeRecordId = sourceRows.find((row) => first(row.fields["Source ID"]) === source.id)?.recordId; return { kind: "sources" as const, id: source.id, payload: source as unknown as Record<string, unknown>, ...(storeRecordId ? { storeRecordId } : {}) }; }),
      ...rules.map((item) => { const storeRecordId = ruleRows.find((row) => first(row.fields["Rule ID"]) === item.id)?.recordId; return { kind: "rules" as const, id: item.id, payload: item as unknown as Record<string, unknown>, ...(storeRecordId ? { storeRecordId } : {}) }; }),
      ...feedback,
    ];
    if (mode === "context") {
      const sourceIds = new Map(sourceRows.flatMap((row) => { const id = first(row.fields["Source ID"]); return id ? [[row.recordId, id] as const] : []; }));
      records.push(...runRows.flatMap((row) => {
        const id = first(row.fields["Run ID"]); if (!id) return [];
        const due = linkedRecordIds(row.fields["到期来源"]).map((recordId) => sourceIds.get(recordId)).filter((value): value is string => Boolean(value));
        return [{ kind: "runs" as const, id, payload: historicalPayload("runs", id, row.fields, due.length ? { sources: due } : {}),
          ...(due.length ? { links: { sources: due } } : {}), storeRecordId: row.recordId }];
      }));
    }
    if (mode === "full") {
      const idByRecord: Partial<Record<ControlEntityKind, Map<string, string>>> = {};
      for (const kind of Object.keys(rowsByKind) as ControlEntityKind[]) idByRecord[kind] = new Map(rowsByKind[kind].flatMap((row) => {
        const id = first(row.fields[REQUIRED_LARK_FIELDS[kind][0]!]); return id ? [[row.recordId, id] as const] : [];
      }));
      const full: CanonicalControlRecord[] = [];
      for (const kind of Object.keys(rowsByKind) as ControlEntityKind[]) for (const row of rowsByKind[kind]) {
        const id = idByRecord[kind]!.get(row.recordId); if (!id) continue;
        const stableLinks: NonNullable<CanonicalControlRecord["links"]> = {};
        for (const relation of LINK_LARK_FIELDS[kind] ?? []) {
          const ids = linkedRecordIds(row.fields[relation.name]).map((recordId) => idByRecord[relation.target]?.get(recordId)).filter((value): value is string => Boolean(value));
          if (ids.length) stableLinks[relation.target] = [...new Set(ids)];
        }
        if (kind === "sources") {
          const source = larkSource(row, this.config.xCapture); if (source) full.push({ kind, id, payload: source as unknown as Record<string, unknown>, storeRecordId: row.recordId });
        } else if (kind === "rules") {
          const version = first(row.fields["版本"]); const title = first(row.fields["标题"]); if (version && title) full.push({ kind, id, payload: { id, version, title, status: first(row.fields["状态"]) }, storeRecordId: row.recordId });
        } else full.push({ kind, id, payload: historicalPayload(kind, id, row.fields, stableLinks), ...(Object.keys(stableLinks).length ? { links: stableLinks } : {}), storeRecordId: row.recordId });
      }
      records = full;
    }
    return { revision: digest(records), sources, rules, feedback, records };
  }

  async plan(records: CanonicalControlRecord[]): Promise<SyncPlan> {
    const creates: CanonicalControlRecord[] = []; const updates: CanonicalControlRecord[] = []; const unchanged: CanonicalControlRecord[] = [];
    const existingCounts = new Map<ControlEntityKind, number>();
    const linkKinds = [...new Set(records.filter((record) => record.links && Object.values(record.links).some((ids) => ids?.length)).map((record) => record.kind))];
    for (const kind of linkKinds) {
      const fields = this.client.fields(this.config.tables[kind]);
      const problems = (LINK_LARK_FIELDS[kind] ?? []).flatMap((link) => {
        if (!records.some((record) => record.kind === kind && record.links?.[link.target]?.length)) return [];
        const field = fields.find((entry) => entry.name === link.name);
        return !field ? [`${link.name} is missing`] : field.type !== "link" ? [`${link.name} has type ${field.type}`]
          : field.link_table !== this.config.tables[link.target] ? [`${link.name} targets ${field.link_table ?? "unknown"}`] : [];
      });
      if (problems.length) throw new Error(`Lark link schema is invalid for ${kind}: ${problems.join(", ")}`);
    }
    const knownTargets: Partial<Record<ControlEntityKind, Map<string, string>>> = {};
    for (const kind of [...new Set(records.map((record) => record.kind))]) {
      const idField = REQUIRED_LARK_FIELDS[kind][0]!;
      const recordsForKind = records.filter((record) => record.kind === kind);
      const existing = new Map(this.client.recordsMatchingAny(this.config.tables[kind], idField, recordsForKind.map((record) => record.id), REQUIRED_LARK_FIELDS[kind]).map((row) => [first(row.fields[idField]), row]));
      knownTargets[kind] = new Map([...existing.entries()].flatMap(([id, row]) => id ? [[id, row.recordId] as const] : []));
      for (const record of recordsForKind) {
        const current = existing.get(record.id); const storeRecordId = current?.recordId;
        const expected = larkFields(record);
        const expectedForComparison = comparisonFields(record, expected);
        const matches = current ? fieldsMatch(current.fields, expectedForComparison) : false;
        if (storeRecordId && matches) unchanged.push({ ...record, storeRecordId });
        else if (storeRecordId) updates.push({ ...record, storeRecordId }); else creates.push(record);
      }
      if (creates.some((record) => record.kind === kind)) existingCounts.set(kind, this.client.countRecords(this.config.tables[kind], idField));
    }
    const referencedKinds = [...new Set(records.flatMap((record) => Object.entries(record.links ?? {}).flatMap(([kind, ids]) => ids?.length ? [kind as ControlEntityKind] : [])))];
    for (const kind of referencedKinds) {
      const idField = REQUIRED_LARK_FIELDS[kind][0]!;
      const targets = knownTargets[kind] ?? new Map<string, string>();
      const requiredIds = [...new Set(records.flatMap((record) => record.links?.[kind] ?? []))];
      const missingIds = requiredIds.filter((id) => !targets.has(id));
      for (const row of this.client.recordsMatchingAny(this.config.tables[kind], idField, missingIds, [idField])) {
        const id = first(row.fields[idField]);
        if (id) targets.set(id, row.recordId);
      }
      knownTargets[kind] = targets;
    }
    const conflicts = [...new Set(creates.map((record) => record.kind))].flatMap((kind) => {
      const limit = this.config.maximumRecordsPerTable ?? 2000;
      const projected = (existingCounts.get(kind) ?? 0) + creates.filter((record) => record.kind === kind).length;
      return projected > limit
        ? [{ kind, id: "*", reason: `Lark table capacity would be exceeded: ${projected}/${limit}` }]
        : [];
    });
    return { driver: this.driver, creates, updates, unchanged, conflicts, digest: digest(records),
      linkTargets: Object.fromEntries(Object.entries(knownTargets).map(([kind, values]) => [kind, Object.fromEntries(values!)])) };
  }

  async apply(plan: SyncPlan): Promise<SyncResult> {
    if (plan.driver !== this.driver) throw new Error(`Cannot apply ${plan.driver} plan through Lark`);
    if (plan.conflicts.length) throw new Error("Cannot apply a sync plan with unresolved conflicts");
    const plannedRecords = [...plan.creates, ...plan.updates, ...plan.unchanged];
    for (const kind of [...new Set(plannedRecords.map((record) => record.kind))]) {
      const schema = new Map(this.client.fields(this.config.tables[kind]).map((field) => [field.name, field]));
      for (const record of plannedRecords.filter((entry) => entry.kind === kind)) {
        for (const [name, value] of Object.entries(larkFields(record))) {
          const field = schema.get(name);
          if (!field || field.type !== "select" || value === undefined || value === null) continue;
          const available = new Set((field.options ?? []).map((option) => option.name));
          const values = (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === "string" && entry !== "");
          const missing = values.filter((entry) => !available.has(entry));
          if (missing.length) throw new Error(`Lark select schema is invalid before write for ${kind}.${name}: missing options ${[...new Set(missing)].join(", ")}`);
        }
      }
    }
    const failed: SyncResult["failed"] = [];
    const all = plannedRecords;
    const index: Partial<Record<ControlEntityKind, Map<string, string>>> = {};
    for (const kind of Object.keys(REQUIRED_LARK_FIELDS) as ControlEntityKind[]) index[kind] = new Map([
      ...Object.entries(plan.linkTargets?.[kind] ?? {}),
      ...all.filter((record) => record.kind === kind && record.storeRecordId).map((record) => [record.id, record.storeRecordId!] as const),
    ]);
    const completed = new Map<string, CanonicalControlRecord>();
    const key = (record: Pick<CanonicalControlRecord, "kind" | "id">) => `${record.kind}\n${record.id}`;
    const finish = (readbackRows: Array<{ kind: ControlEntityKind; id: string; fields: Record<string, unknown> }>): SyncResult => {
      const acknowledged = failed.length === 0 && readbackRows.length === completed.size;
      return { driver: this.driver, created: plan.creates.length - failed.filter((item) => plan.creates.some((record) => record.kind === item.kind && record.id === item.id)).length,
        updated: plan.updates.length - failed.filter((item) => plan.updates.some((record) => record.kind === item.kind && record.id === item.id)).length,
        unchanged: plan.unchanged.length - failed.filter((item) => plan.unchanged.some((record) => record.kind === item.kind && record.id === item.id)).length,
        failed, digest: plan.digest, acknowledged,
        ...(acknowledged ? { readbackRevision: digest(readbackRows), readbackDigest: digest(readbackRows) } : {}) };
    };
    let scalarWriteFailed = false;
    createKinds: for (const kind of [...new Set(plan.creates.map((record) => record.kind))]) {
      for (const batch of chunks(plan.creates.filter((record) => record.kind === kind))) {
        try {
          const response = this.client.batchCreate(this.config.tables[kind], batch.map((record) => writableLarkFields(kind, larkFields(record))));
          const object = response && typeof response === "object" ? response as Record<string, unknown> : {};
          const ids = Array.isArray(object.record_id_list) ? object.record_id_list.filter((id): id is string => typeof id === "string" && Boolean(id))
            : Array.isArray(object.recordIdList) ? object.recordIdList.filter((id): id is string => typeof id === "string" && Boolean(id)) : [];
          if (ids.length !== batch.length) throw new Error(`lark-cli returned ${ids.length}/${batch.length} record IDs for ${kind}`);
          batch.forEach((record, ordinal) => {
            const storeRecordId = ids[ordinal]!; index[kind]!.set(record.id, storeRecordId); completed.set(key(record), { ...record, storeRecordId });
          });
        } catch (error) {
          const detail = `record create failed: ${error instanceof Error ? error.message : String(error)}`;
          for (const record of batch) failed.push({ kind: record.kind, id: record.id, detail });
          scalarWriteFailed = true;
          break createKinds;
        }
      }
    }
    updateKinds: for (const kind of scalarWriteFailed ? [] : [...new Set(plan.updates.map((record) => record.kind))]) {
      for (const batch of chunks(plan.updates.filter((record) => record.kind === kind))) {
        try {
          this.client.batchUpdate(this.config.tables[kind], Object.fromEntries(batch.map((record) => [record.storeRecordId!, writableLarkFields(kind, larkFields(record))])));
          for (const record of batch) completed.set(key(record), record);
        } catch (error) {
          const detail = `record update failed: ${error instanceof Error ? error.message : String(error)}`;
          for (const record of batch) failed.push({ kind: record.kind, id: record.id, detail });
          scalarWriteFailed = true;
          break updateKinds;
        }
      }
    }
    for (const record of plan.unchanged) completed.set(key(record), record);
    if (scalarWriteFailed) {
      for (const record of all) if (!failed.some((item) => item.kind === record.kind && item.id === record.id)) {
        failed.push({ kind: record.kind, id: record.id, detail: "sync stopped before relationship writes and readback after an earlier scalar batch failure" });
      }
      return finish([]);
    }
    const linkRecords = [...completed.values()].filter((record) => record.storeRecordId && record.links && Object.values(record.links).some((ids) => ids?.length));
    for (const kind of [...new Set(linkRecords.map((record) => record.kind))]) {
      const prepared = linkRecords.filter((record) => record.kind === kind).flatMap((record) => {
        try { return [{ record, fields: larkLinkFields(record, index) }]; }
        catch (error) {
          failed.push({ kind: record.kind, id: record.id, detail: `link update failed: ${error instanceof Error ? error.message : String(error)}` });
          return [];
        }
      });
      for (const batch of chunks(prepared)) {
        try {
          this.client.batchUpdate(this.config.tables[kind], Object.fromEntries(batch.map(({ record, fields }) => [record.storeRecordId!, fields])));
        } catch (error) {
          const detail = `link update failed: ${error instanceof Error ? error.message : String(error)}`;
          for (const { record } of batch) if (!failed.some((item) => item.kind === record.kind && item.id === record.id)) failed.push({ kind: record.kind, id: record.id, detail });
        }
      }
    }
    const readbackRows: Array<{ kind: ControlEntityKind; id: string; fields: Record<string, unknown> }> = [];
    for (const kind of [...new Set([...completed.values()].map((record) => record.kind))]) {
      const records = [...completed.values()].filter((record) => record.kind === kind && !failed.some((item) => item.kind === record.kind && item.id === record.id));
      if (!records.length) continue;
      const expectedById = new Map(records.map((record) => [record.id, comparisonFields(record, larkFields(record, index))]));
      const fields = [...new Set([REQUIRED_LARK_FIELDS[kind][0]!, ...records.flatMap((record) => Object.keys(expectedById.get(record.id)!))])];
      let pending = records;
      let lastError: unknown;
      for (let attempt = 0; attempt < 5 && pending.length; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        try {
          const actualById = new Map(this.client.recordsByIds(this.config.tables[kind], records.map((record) => record.storeRecordId!).filter(Boolean), fields).flatMap((row) => {
            const id = first(row.fields[REQUIRED_LARK_FIELDS[kind][0]!]);
            return id ? [[id, row] as const] : [];
          }));
          const next: typeof pending = [];
          for (const record of pending) {
            const actual = actualById.get(record.id); const expected = expectedById.get(record.id)!;
            if (!actual || !fieldsMatch(actual.fields, expected)) next.push(record);
            else readbackRows.push({ kind, id: record.id, fields: actual.fields });
          }
          pending = next; lastError = undefined;
        } catch (error) { lastError = error; }
      }
      for (const record of pending) {
        const detail = lastError ? `record readback failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`
          : "record readback failed: business ID was missing or canonical fields did not match after bounded retries";
        failed.push({ kind: record.kind, id: record.id, detail });
      }
    }
    return finish(readbackRows);
  }

  async close(): Promise<void> {}
}
