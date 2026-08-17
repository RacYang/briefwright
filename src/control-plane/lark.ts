import { createHash } from "node:crypto";

import type { EffectiveConfig, RuleSnapshot, SourceDefinition } from "../config/types.js";
import { canonicalJson } from "../config/load.js";
import { LarkCliClient, systemLarkRunner, type LarkRunner } from "./lark-cli.js";
import { LARK_COMPATIBILITY_LINK_FIELDS, LARK_FIELD_INVENTORY, LARK_FIELD_MANIFEST, LARK_FIELD_MANIFEST_VERSION, LARK_ID_FIELDS, LARK_LINK_FIELDS, LARK_ROW_COMPLETENESS_FIELDS, LARK_SCALAR_FIELDS } from "./lark-field-manifest.js";
import type { CanonicalControlRecord, ControlEntityKind, ControlPlaneCheck, ControlPlaneSnapshot, ControlPlaneStore, SyncPlan, SyncResult } from "./types.js";

/* Public compatibility export derived from the sole versioned field contract. */
export const REQUIRED_LARK_FIELDS: Record<ControlEntityKind, string[]> = Object.fromEntries(
  Object.entries(LARK_FIELD_MANIFEST).map(([kind, fields]) => [kind, fields.map((field) => field.name)]),
) as Record<ControlEntityKind, string[]>;
const SCALAR_LARK_FIELDS = LARK_SCALAR_FIELDS;
const LINK_LARK_FIELDS = LARK_LINK_FIELDS;

const LARK_BATCH_LIMIT = 200;
const LARK_SAFE_CLI_JSON_BYTES = 64 * 1024;

function first(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return undefined;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : typeof value === "string" ? [value] : [];
}

function larkFrequency(value: unknown): string | undefined {
  const normalized = first(value);
  return normalized === "daily" ? "每日" : normalized === "weekly" ? "每周" : normalized === "on-demand" ? "按需" : normalized;
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

function jsonText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let text: string;
  if (typeof value === "string") {
    try { text = canonicalJson(JSON.parse(value)); }
    catch { text = value; }
  } else text = canonicalJson(value);
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= 24 * 1024) return text;
  return canonicalJson({
    oversized: true,
    originalBytes,
    sha256: createHash("sha256").update(text).digest("hex"),
    preview: text.slice(0, 2_048),
    storage: "local-runtime-journal",
  });
}

function connectorConfigForControlPlane(source: SourceDefinition): Record<string, unknown> {
  const config = { ...source.connector.config } as Record<string, unknown>;
  if ("bearerToken" in config) config.bearerToken = "[secret-reference]";
  return config;
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

function writableLarkFields(_kind: ControlEntityKind, fields: Record<string, unknown>, available?: Set<string>): Record<string, unknown> {
  if (!available) return fields;
  const managed = new Set(LARK_FIELD_MANIFEST[_kind].map((field) => field.name));
  return Object.fromEntries(Object.entries(fields).filter(([name]) => managed.has(name) || available.has(name)));
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

function ruleType(value: unknown): string | undefined {
  const token = String(value ?? "").split("-")[1];
  return ({ WORKFLOW: "工作流", SCORE: "评分", SELECTION: "筛选规则", SOURCE: "数据源", IMPROVEMENT: "状态机", RETENTION: "存储与集成", REVIEW: "筛选规则" } as Record<string, string>)[token ?? ""];
}

const SOURCE_TYPE_TO_LARK: Record<NonNullable<SourceDefinition["sourceType"]>, string> = {
  website: "官网", "official-blog": "官方博客", "official-docs": "官方文档", github: "GitHub", x: "X",
  paper: "论文", regulation: "监管与标准", media: "媒体", other: "其他",
};

function managedLarkFields(record: CanonicalControlRecord, links: Partial<Record<ControlEntityKind, Map<string, string>>> = {}): Record<string, unknown> {
  const p = record.payload;
  const linked = (kind: ControlEntityKind): Array<{ id: string }> | undefined => {
    const ids = record.links?.[kind]?.map((id) => links[kind]?.get(id)).filter((id): id is string => Boolean(id));
    return ids?.length ? ids.map((id) => ({ id })) : undefined;
  };
  if (record.kind === "sources") {
    const source = p as unknown as SourceDefinition;
    const url = "url" in source.connector.config ? source.connector.config.url : source.connector.type === "github-releases" ? `https://github.com/${source.connector.config.repository}/releases`
      : source.connector.type === "x-api" || source.connector.type === "codex-browser" ? `https://x.com/${source.connector.config.username}` : undefined;
    const captureMethod = ({ rss: "RSS", "github-releases": "GitHub Releases", webpage: "Webpage", "x-api": "X API", "computer-use": "Computer Use",
      "in-app-browser": "Codex Browser", "codex-browser": "Codex Browser", extension: "Extension" } as Record<string, string>)[source.connector.type];
    const connectorConfig = connectorConfigForControlPlane(source);
    return compact({ "Source ID": source.id, "名称": source.title, "状态": source.enabled === false ? "停用" : "启用",
      "来源类型": SOURCE_TYPE_TO_LARK[source.sourceType ?? "other"], "入口 URL": url, "采集方式": captureMethod,
      "采集域名": source.connector.type === "computer-use" || source.connector.type === "in-app-browser" ? (source.connector.config.allowedHosts ?? [new URL(source.connector.config.url).hostname]).join(", ") : "",
      "来源层级": source.evidenceTier === "primary" ? "一手来源" : source.evidenceTier === "clue" ? "发现线索" : "二手来源",
      "覆盖领域": source.coverageDomains ?? (source.domain ? [source.domain] : []), "扫描频率": source.scheduleState?.frequency === "weekly" ? "每周" : source.scheduleState?.frequency === "on-demand" ? "按需" : "每日",
      "优先级": source.priority, "调度状态": source.scheduleState?.humanLocked ? "人工锁定" : "自动", "最后扫描": larkDate(source.scheduleState?.lastScanAt), "最后成功": larkDate(source.scheduleState?.lastSuccessAt),
      "最后有效更新": larkDate(source.scheduleState?.lastEffectiveUpdateAt), "下次扫描": larkDate(source.scheduleState?.nextScanAt),
      "连接器类型": source.connector.type, "连接器版本": p.connector_version, "连接器配置（脱敏）": jsonText(connectorConfig), "配置摘要": digest(connectorConfig),
      "最小扫描间隔小时": source.cadence?.minimumHours, "当前扫描间隔小时": source.cadence?.defaultHours, "最大扫描间隔小时": source.cadence?.maximumHours,
      "游标摘要": p.cursor_digest, "最近失败时间": larkDate(p.last_failure_at), "最近错误码": p.last_error_code, "最近失败详情": p.last_failure_detail,
      "最近响应指纹": p.last_response_fingerprint, "30天扫描数": p.scans_30d, "30天失败数": p.failures_30d, "30天更新数": p.updates_30d,
      "30天入围数": p.selections_30d, "节奏调整建议": p.cadence_proposal, "节奏建议依据": p.cadence_reason });
  }
  if (record.kind === "runs") {
    const result = jsonObject(p.result_json); const plan = jsonObject(p.execution_plan_json); const provenance = jsonObject(plan.provenance);
    const rules = Array.isArray(plan.rules) ? plan.rules as Array<Record<string, unknown>> : [];
    const workflowVersion = rules.find((entry) => String(entry.id).startsWith("RULE-WORKFLOW-"))?.version;
    const scoreVersion = rules.find((entry) => String(entry.id).startsWith("RULE-SCORE-"))?.version;
    const artifacts = jsonObject(result.artifactPaths); const integrity = jsonObject(result.integrityManifest); const completion = jsonObject(result.completionReport);
    const sync = jsonObject(result.controlPlaneSync); const commit = jsonObject(result.controlPlaneCommit); const document = jsonObject(result.documentManifest);
    const daily = Array.isArray(result.daily) ? result.daily : []; const review = Array.isArray(result.review) ? result.review : []; const machineOnly = Array.isArray(result.machineOnly) ? result.machineOnly : [];
    return compact({ "Run ID": record.id, "状态": p.status === "success" ? "成功" : p.status === "partial" ? "部分成功" : p.status === "empty" ? "健康空结果" : p.status === "failed" ? "失败" : p.status === "abandoned" ? "已遗弃" : "运行中",
      "发布状态": p.publication_state === "published" || result.publicationState === "published" ? "已发布" : "已扣留",
      "当前阶段": p.current_stage === "complete" ? "完成" : p.current_stage === "abandoned" ? "已遗弃" : p.current_stage,
      "触发类型": result.runKind === "formal-retry" ? "重跑" : p.trigger_type === "manual" ? "手动" : "定时", "运行类型": result.runKind, "运行模式": result.mode,
      "工作流版本": workflowVersion ?? provenance.coreVersion, "评分版本": scoreVersion ?? provenance.policyVersion,
      "开始时间": larkDate(p.started_at ?? p.generated_at), "结束时间": larkDate(p.completed_at), "Obsidian 简报": artifacts.daily, "Daily 路径": artifacts.daily, "Review 路径": artifacts.review,
      "质量说明": result.outcome ? `Briefwright ${String(result.outcome)}; config ${String(p.config_digest).slice(0, 12)}` : undefined,
      "数据源数": record.links?.sources?.length ?? 0, "入围数": daily.length + review.length,
      "到期来源数": Array.isArray(integrity.dueSourceIds) ? integrity.dueSourceIds.length : p.due_source_count,
      "到期清单摘要": integrity.dueManifestDigest ?? p.due_manifest_digest, "日报摘要": integrity.dailyArtifactDigest ?? p.daily_artifact_digest,
      "待复核摘要": integrity.reviewArtifactDigest ?? p.review_artifact_digest,
      "配置摘要": p.config_digest ?? result.configDigest, "策略摘要": p.policy_digest ?? provenance.policyDigest, "提示词摘要": p.prompt_digest ?? provenance.promptDigest,
      "来源清单摘要": p.source_digest ?? document.sourceManifestDigest, "协议合同摘要": document.contractDigest ?? provenance.protocolDigest,
      "执行计划摘要": p.execution_plan_digest ?? (p.execution_plan_json ? digest(p.execution_plan_json) : undefined), "执行计划 JSON": jsonText(p.execution_plan_json),
      "运行时版本": provenance.coreVersion ?? p.runtime_version, "运行时摘要": p.runtime_digest,
      "进程存储已确认": sync.acknowledged ?? completion.processStoreValid, "远端读回 Revision": sync.readbackRevision, "远端读回摘要": sync.readbackDigest,
      "发布提交已确认": commit.acknowledged ?? (result.publicationState === "published" || p.publication_state === "published"), "规则合同有效": completion.ruleContractValid, "文档存储有效": completion.documentStoreValid,
      "完成报告 JSON": jsonText(result.completionReport), "更新来源数": completion.updated, "无变化来源数": completion.unchanged, "失败来源数": completion.failed,
      "跳过来源数": completion.skipped, "缺失回执数": completion.missing, "缺失 Source IDs": Array.isArray(completion.missingSourceIds) ? completion.missingSourceIds.join(" | ") : undefined,
      "Daily 条目数": completion.daily ?? daily.length, "Review 条目数": completion.review ?? review.length, "机器层条目数": machineOnly.length,
      "模型失败数": Array.isArray(result.modelFailures) ? result.modelFailures.length : 0, "模型失败明细": jsonText(result.modelFailures),
      "分析积压数": Array.isArray(result.analysisBacklog) ? result.analysisBacklog.reduce((sum, entry) => sum + Number(jsonObject(entry).count ?? 0), 0) : 0,
      "分析积压明细": jsonText(result.analysisBacklog), "阶段耗时 JSON": jsonText(result.stageTimings), "产物阶段耗时 JSON": jsonText(result.artifactStageTimings),
      "领域计数 JSON": jsonText(completion.domainCounts), "Top Item IDs": Array.isArray(completion.topItemIds) ? completion.topItemIds.join(" | ") : undefined,
      "执行 Owner": p.execution_owner, "Lease 到期": larkDate(p.lease_expires_at), "最近心跳": larkDate(p.heartbeat_at), "Fencing Token": p.fencing_token,
      "中止遗弃原因": p.abandon_reason ?? p.abort_reason, "父运行批次": linked("runs"),
      "发现条目": linked("items"), "原始采集": linked("captures"), "状态事件": linked("events"), "扫描回执": linked("receipts"), "使用规则": linked("rules"), "人工反馈": linked("feedback") });
  }
  if (record.kind === "items") {
    const analysis = jsonObject(p.analysis_json); const evidenceJson = jsonObject(p.evidence_json); const attemptAnalysis = jsonObject(p.analysis_evidence_json); const scoreDimensions = jsonObject(analysis.scoreDimensions);
    const verification = jsonObject(attemptAnalysis._evidenceVerification); const exclusions = Array.isArray(analysis.exclusionReasons) ? analysis.exclusionReasons.map(String) : [];
    const evidence = p.evidence_status === "confirmed-primary" ? "已确认" : p.evidence_status === "secondary-clue" ? "部分确认" : "待原始来源确认";
    return compact({ "Item ID": record.id, "标题": p.title, "当前状态": p.disposition === "daily" ? "已生成简报" : p.disposition === "review" ? "人工复核" : "已淘汰",
      "Canonical URL": analysis.url, "中文摘要": p.summary, "为什么值得关注": p.why_it_matters, "主领域": p.domain,
      "证据状态": evidence, "总分": p.score, "评分版本": analysis.scoreVersion ?? "1.0", "处置结果": p.disposition,
      "Canonical Identity": p.canonical_identity, "Capture Hash": analysis.captureHash ?? p.capture_hash, "抓取时间": larkDate(analysis.capturedAt ?? p.captured_at), "页面更新时间": larkDate(analysis.pageUpdatedAt ?? p.page_updated_at),
      "主张 JSON": jsonText(analysis.claims ?? evidenceJson.claims), "主张证据 JSON": jsonText(verification.claimSupport ?? attemptAnalysis.claimEvidence ?? evidenceJson.claimSupport ?? analysis.claimEvidence),
      "七维评分详情 JSON": jsonText(scoreDimensions), "各维度评分理由 JSON": jsonText(Object.fromEntries(Object.entries(scoreDimensions).map(([key, value]) => [key, jsonObject(value).reason]))),
      "知识潜力 JSON": jsonText(analysis.knowledgePotential), "淘汰原因集合": Array.isArray(analysis.exclusionReasons) ? analysis.exclusionReasons.join(" | ") : p.exclusion_reason,
      "Daily 排除原因集合": Array.isArray(analysis.dailyExclusionReasons) ? analysis.dailyExclusionReasons.join(" | ") : undefined,
      "分析状态": p.analysis_status === "failed" ? "失败" : p.analysis_status === "pending" ? "待处理" : p.analysis_status === "skipped" ? "跳过" : "成功",
      "模型 Provider": p.provider_id ?? analysis.provider, "模型名称": p.model_id ?? analysis.model, "Prompt 版本": p.prompt_version ?? analysis.promptVersion,
      "分析时间": larkDate(p.analysis_attempted_at ?? analysis.analyzedAt), "分析耗时毫秒": p.analysis_duration_ms, "输入 Token": p.input_tokens, "输出 Token": p.output_tokens, "已知成本": p.cost_usd,
      "条目快照摘要": digest(analysis), "新鲜度判定": analysis.freshnessStatus ?? (exclusions.includes("stale-source") ? "过期" : exclusions.includes("future-dated") ? "未来时间" : analysis.capturedAt ? "新鲜" : "未知"),
      "日期语义": analysis.dateSemantics ?? (analysis.pageUpdatedAt ? "page-updated" : analysis.publishedAt ? "event" : "unknown"),
      "发现批次": linked("runs"), "来源": linked("sources"), "原始采集": linked("captures"), "评分规则": linked("rules"), "状态事件": linked("events") });
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
      "解析器版本": value("parserVersion", "parser_version"), "失败原因": value("failureReason", "failure_reason"), "载荷指纹": p.payload_fingerprint ?? p.content_hash,
      "External Key": value("externalKey", "external_key"), "连接器类型": value("connectorType", "connector_type"), "连接器版本": value("connectorVersion", "connector_version"),
      "标准化发布时间": larkDate(p.published_at), "页面更新时间": larkDate(value("pageUpdatedAt", "page_updated_at")), "页面更新时间原值": value("pageUpdatedRaw", "page_updated_raw"),
      "证据类别": value("evidenceClass", "evidence_class"), "日期语义": value("dateSemantics", "date_semantics") ?? "unknown", "恢复自内容哈希": value("recoveryOfContentHash", "recovery_of_content_hash"),
      "Capture Bundle ID": value("captureBundleId", "capture_bundle_id"), "Bundle 摘要": value("bundleDigest", "bundle_digest"), "Capture Manifest 摘要": value("captureManifestDigest", "capture_manifest_digest"),
      "抓取耗时毫秒": value("durationMs", "duration_ms"), "外部请求 ID": value("requestId", "request_id"), "重定向链 JSON": jsonText(value("redirectChain", "redirect_chain_json")),
      "内容长度": value("contentLength", "content_length"), "原始载荷摘要": value("rawPayloadDigest", "raw_payload_digest") ?? digest(raw), "原始载荷 Schema 版本": value("rawSchemaVersion", "raw_schema_version"),
      "原始快照": value("rawSnapshot", "raw_snapshot"), "保留策略": value("retentionPolicy", "retention_policy"), "解析结果 JSON": jsonText(value("parserResult", "parser_result_json")),
      "运行批次": linked("runs"), "数据源": linked("sources"), "情报条目": linked("items") });
  }
  if (record.kind === "receipts") return compact({ "Scan ID": record.id, "扫描结果": p.result === "updated" ? "有更新" : p.result === "observed" ? "已观察" : p.result === "unchanged" ? "无更新" : p.result === "failed" ? "失败" : "跳过",
    "到期原因": String(p.due_reason ?? "").startsWith("recovery-") ? "人工强制" : String(p.due_reason ?? "").includes("never") ? "首次基线" : "每日到期",
    "开始时间": larkDate(p.attempted_at), "结束时间": larkDate(p.completed_at), "错误与说明": p.detail,
    "发现 URL 数": p.capture_count, "耗时毫秒": p.duration_ms, "执行通道": receiptExecutionChannel(p.execution_channel), "工作流版本": record.links?.rules?.find((id) => id.startsWith("RULE-WORKFLOW-"))?.match(/-V(\d+\.\d+)$/)?.[1],
    "尝试次数": p.attempts, "错误码": p.error_code, "连接器类型": p.connector_type, "连接器版本": p.connector_version, "游标前摘要": p.cursor_before_digest,
    "游标后摘要": p.cursor_after_digest, "是否可重试": p.retryable, "下次重试时间": larkDate(p.next_retry_at), "外部请求 ID": p.request_id,
    "到期清单摘要": p.due_manifest_digest, "请求载荷摘要": p.request_payload_digest, "结构化详情 JSON": jsonText(p.structured_detail ?? p.detail_json),
    "来源有效更新时间": larkDate(p.source_effective_updated_at), "响应指纹": p.response_fingerprint, "HTTP 状态": p.http_status, "扫描频率": p.scan_frequency,
    "运行批次": linked("runs"), "数据源": linked("sources"), "工作流规则": linked("rules") });
  if (record.kind === "events") {
    const detail = jsonObject(p.payload_json);
    return compact({ "Event ID": record.id, "事件时间": larkDate(p.occurred_at), "原状态": detail.fromState ?? "无",
    "新状态": detail.toState ?? (p.stage === "complete" ? "已生成简报" : "已发现"), "执行者": detail.actor ?? "编排器",
    "迁移原因": detail.reason ?? p.event_type, "幂等键": p.idempotency_key, "载荷指纹": p.payload_fingerprint,
    "Rule ID 快照": detail.ruleIdSnapshot ?? record.links?.rules?.[0], "尝试次数": detail.attempts, "错误码": detail.errorCode ?? detail.detail,
    "所属阶段": p.stage, "事件类型": p.event_type, "实体类型": p.entity_type, "实体 ID": p.entity_id, "完整载荷 JSON": jsonText(p.payload_json),
    "运行内序号": p.sequence, "事件 Schema 版本": p.schema_version ?? "event-v1", "关联事件 ID": p.causation_event_id ?? p.correlation_event_id,
    "持续时间毫秒": p.duration_ms ?? detail.durationMs, "严重级别": p.severity ?? (p.error_code || detail.errorCode ? "error" : "info"), "事件详情": jsonText(detail),
    "运行批次": linked("runs"), "情报条目": linked("items"), "规则记录": linked("rules"), "相关实验": linked("experiments") });
  }
  if (record.kind === "feedback") {
    const judgment = ({ include: "纳入", used: "纳入", "knowledge-worthy": "纳入", skip: "略过", ignored: "略过", review: "复核", reviewed: "复核",
      compare: "比较", "classification-correction": "纠正分类", "score-correction": "纠正评分", "source-correction": "纠正来源", "process-feedback": "流程反馈" } as Record<string, string>)[String(p.feedback_type)] ?? "复核";
    return compact({ "Feedback ID": record.id, "反馈时间": larkDate(p.created_at), "判断": judgment, "原因标签": p.feedback_type,
      "反馈说明": p.note, "反馈类型": p.feedback_type, "目标字段": p.target_field, "原值 JSON": jsonText(p.before_json ?? p.original_value), "建议值 JSON": jsonText(p.after_json ?? p.suggested_value),
      "处理状态": ({ pending: "待处理", accepted: "已接受", rejected: "已拒绝", applied: "已应用" } as Record<string, string>)[String(p.processing_status)] ?? p.processing_status,
      "处理时间": larkDate(p.processed_at), "处理人": p.processed_by ?? p.user_id, "处理结果决议": p.resolution, "幂等键": p.idempotency_key,
      "载荷指纹": p.payload_fingerprint, "反馈来源渠道": p.channel ?? p.source_channel,
      "价值评分": p.value_score, "整合目标": p.integration_target, "情报条目": linked("items"), "运行批次": linked("runs"), "相关实验": linked("experiments") });
  }
  if (record.kind === "experiments") {
    const baseline = jsonObject(p.baseline_policy_json); const candidate = jsonObject(p.candidate_policy_json);
    const baselineRules = Array.isArray(baseline.rules) ? (baseline.rules as Array<Record<string, unknown>>).map((item) => String(item.id)).sort() : [];
    const candidateRules = Array.isArray(candidate.rules) ? (candidate.rules as Array<Record<string, unknown>>).map((item) => String(item.id)).sort() : [];
    const status = ({ candidate: "候选", evaluated: "已评估", approved: "已批准", active: "运行中", "rolled-back": "已回滚", rejected: "已拒绝" } as Record<string, string>)[String(p.status)] ?? p.status;
    const sample = jsonObject(p.sample_json); const metrics = jsonObject(p.metrics_json); const guardrails = jsonObject(metrics.guardrails);
    return compact({ "Experiment ID": record.id, "标题": `Briefwright experiment ${record.id}`, "状态": status,
      "假设": candidate.hypothesis, "基线 Rule IDs": baselineRules.join(" | "), "候选 Rule IDs": candidateRules.join(" | "),
      "实验指标": p.metrics_json, "实验结论": metrics.recommendation ?? (p.status === "approved" ? "approved" : undefined),
      "基线策略摘要": p.baseline_policy_digest ?? digest(baseline), "候选策略摘要": p.candidate_policy_digest ?? digest(candidate), "样本摘要": p.sample_digest ?? (p.sample_json ? digest(sample) : undefined),
      "基线策略 JSON": jsonText(p.baseline_policy_json), "候选策略 JSON": jsonText(p.candidate_policy_json), "样本 JSON": jsonText(p.sample_json), "指标结果 JSON": jsonText(p.metrics_json),
      "Guardrail 结果 JSON": jsonText(guardrails), "评审条目数": metrics.reviewedItems, "观察天数": metrics.spanDays, "14天门槛通过": Number(metrics.spanDays ?? 0) >= 14,
      "50条评审门槛通过": Number(metrics.reviewedItems ?? 0) >= 50, "批准时间": larkDate(p.approved_at), "激活时间": larkDate(p.activated_at), "回滚时间": larkDate(p.rolled_back_at),
      "决策理由": p.decision_reason ?? metrics.recommendation, "实验 Revision": p.revision,
      "基线规则": linked("rules"), "候选规则": linked("rules") });
  }
  if (record.kind === "rules") return compact({ "Rule ID": p.id ?? record.id, "版本": p.version, "标题": p.title, "状态": p.status === "retired" ? "已退役" : p.status === "candidate" ? "候选" : "生效中",
    "规则类型": p.rule_type ?? ruleType(p.id ?? record.id), "规则说明": p.description, "配置 JSON": jsonText(p.config_json ?? p.config), "校验和": p.checksum ?? digest(p), "回滚目标版本": p.rollback_target_version,
    "Policy ID": p.policy_id, "Policy 版本": p.policy_version, "Policy 摘要": p.policy_digest, "规则来源": p.source ?? "packaged", "Rule Schema 版本": p.schema_version ?? "rule-v1",
    "人工锁定": p.human_locked, "不可变 Revision": p.revision ?? digest(p), "Runtime 兼容范围": p.runtime_compatibility, "依赖 Rule IDs": Array.isArray(p.dependency_rule_ids) ? p.dependency_rule_ids.join(" | ") : p.dependency_rule_ids,
    "依赖 Prompt Pack": p.prompt_pack, "Guardrail JSON": jsonText(p.guardrails), "退役原因": p.retirement_reason, "批准人": p.approved_by, "批准时间": larkDate(p.approved_at),
    "生效条件": p.effective_condition, "阈值 JSON": jsonText(p.thresholds), "权重 JSON": jsonText(p.weights), "父规则替代规则": linked("rules"), "回滚目标规则": linked("rules") });
  return p;
}

function dimensionValue(dimensions: Record<string, unknown>, key: string): number | undefined {
  const value = jsonObject(dimensions[key]).value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compatibilityLarkFields(record: CanonicalControlRecord, links: Partial<Record<ControlEntityKind, Map<string, string>>>): Record<string, unknown> {
  const p = record.payload;
  const linked = (kind: ControlEntityKind): Array<{ id: string }> | undefined => {
    const ids = record.links?.[kind]?.map((id) => links[kind]?.get(id)).filter((id): id is string => Boolean(id));
    return ids?.length ? ids.map((id) => ({ id })) : undefined;
  };
  if (record.kind === "sources") {
    const scans = optionalInteger(p.scans_30d); const updates = optionalInteger(p.updates_30d); const selections = optionalInteger(p.selections_30d);
    const schedule = jsonObject(p.scheduleState); const current = first(schedule.frequency) ?? first(p.scan_frequency);
    return compact({
      "近30天扫描数": scans, "近30天有效更新数": updates, "近30天入围数": selections,
      "近30天更新率": scans && updates !== undefined ? updates / scans : undefined,
      "近30天入围率": scans && selections !== undefined ? selections / scans : undefined,
      "连续失败次数": p.consecutive_failures, "连续无更新次数": p.consecutive_no_update,
      "最近调频": larkDate(p.last_cadence_adjusted_at), "机构": p.organization, "权威分": p.authority_score ?? p.priority,
      "调频原因": p.cadence_reason, "备注": p.notes, "连续建议周期": p.cadence_streak,
      "建议频率": p.cadence_proposal, "调频分": p.cadence_score, "基准频率": current === "weekly" ? "每周" : current === "on-demand" ? "按需" : current === "daily" ? "每日" : current,
      "发现条目": linked("items"), "原始采集": linked("captures"), "扫描回执": linked("receipts"),
    });
  }
  if (record.kind === "runs") {
    const result = jsonObject(p.result_json); const completion = jsonObject(result.completionReport); const coverage = jsonObject(result.coverageWindow);
    const modelFailures = Array.isArray(result.modelFailures) ? result.modelFailures.length : undefined;
    const failed = optionalInteger(completion.failed);
    return compact({
      "错误数": p.error_count ?? (failed !== undefined || modelFailures !== undefined ? (failed ?? 0) + (modelFailures ?? 0) : undefined),
      "发现数": p.discovered_count ?? result.discoveredCount, "核验数": p.verified_count ?? result.verifiedCount,
      "覆盖开始": larkDate(p.coverage_started_at ?? coverage.start), "覆盖结束": larkDate(p.coverage_completed_at ?? coverage.end),
    });
  }
  if (record.kind === "items") {
    const analysis = jsonObject(p.analysis_json); const dimensions = jsonObject(analysis.scoreDimensions);
    const canonicalUrl = first(analysis.url) ?? first(p.canonical_url);
    const exclusions = Array.isArray(analysis.exclusionReasons) ? analysis.exclusionReasons.map(String) : [];
    return compact({
      "发现渠道": analysis.discoveryChannel ?? p.discovery_channel, "去重键": p.canonical_identity,
      "可行动分": dimensionValue(dimensions, "actionability"), "相关性分": dimensionValue(dimensions, "relevance"),
      "URL 指纹": canonicalUrl ? digest(canonicalUrl) : undefined, "事件日期": larkDate(analysis.publishedAt ?? p.published_at),
      "证据分": dimensionValue(dimensions, "evidence"), "淘汰原因": p.exclusion_reason ?? exclusions[0], "候选编号": p.candidate_id,
      "时效分": dimensionValue(dimensions, "recency"), "发布日期": larkDate(analysis.publishedAt ?? p.published_at),
      "关键短摘录": p.summary, "新颖分": dimensionValue(dimensions, "novelty"), "来源权威分": dimensionValue(dimensions, "authority"),
      "交叉领域": analysis.crossDomains, "Obsidian 链接": p.obsidian_link,
      "影响分": dimensionValue(dimensions, "impact"), "人工反馈": linked("feedback"), "重复于": linked("items"),
    });
  }
  if (record.kind === "events") {
    const detail = jsonObject(p.payload_json);
    return compact({ "旧规则标识（迁移前）": detail.legacyRuleId ?? p.legacy_rule_id });
  }
  if (record.kind === "feedback") return compact({
    "反馈前状态": p.before_status, "反馈后状态": p.after_status,
  });
  if (record.kind === "experiments") {
    const sample = jsonObject(p.sample_json); const metrics = jsonObject(p.metrics_json);
    return compact({
      "基线指标": jsonText(metrics.baseline), "旧基线标识（迁移前）": p.legacy_baseline_id,
      "样本窗口开始": larkDate(sample.windowStart), "旧候选标识（迁移前）": p.legacy_candidate_id,
      "发布时间": larkDate(p.published_at), "样本窗口结束": larkDate(sample.windowEnd), "相关状态事件": linked("events"), "触发反馈": linked("feedback"),
    });
  }
  if (record.kind === "captures") {
    const raw = jsonObject(p.raw_json);
    return compact({
      "解析结果": jsonText(raw.parserResult ?? p.parser_result_json), "原始快照位置": raw.snapshotLocation ?? p.raw_snapshot_location,
      "保留级别": raw.retentionLevel ?? p.retention_level,
    });
  }
  if (record.kind === "rules") {
    const thresholds = jsonObject(p.thresholds); const weights = jsonObject(p.weights);
    return compact({
      "入围阈值": thresholds.daily ?? p.daily_threshold, "人工复核阈值": thresholds.review ?? p.review_threshold,
      "失效时间": larkDate(p.retired_at), "审批说明": p.approval_note, "生效时间": larkDate(p.effective_at),
      "指标与权重": Object.keys(weights).length ? jsonText(weights) : undefined, "硬性门槛": jsonText(p.guardrails),
      "单领域上限": p.per_domain_limit, "每日总上限": p.daily_limit, "来源实验": linked("experiments"), "状态事件": linked("events"), "运行批次": linked("runs"),
    });
  }
  if (record.kind === "receipts") return compact({ "频率快照": larkFrequency(p.scan_frequency) });
  return {};
}

export function larkFields(record: CanonicalControlRecord, links: Partial<Record<ControlEntityKind, Map<string, string>>> = {}): Record<string, unknown> {
  return { ...managedLarkFields(record, links), ...compatibilityLarkFields(record, links) };
}

function larkLinkFields(record: CanonicalControlRecord, links: Partial<Record<ControlEntityKind, Map<string, string>>>, available?: Set<string>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const managed = LINK_LARK_FIELDS[record.kind] ?? [];
  const compatibility = (LARK_COMPATIBILITY_LINK_FIELDS[record.kind] ?? []).filter((relation) => available?.has(relation.name));
  for (const relation of [...managed, ...compatibility]) {
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

export function chunksByJsonBytes<T>(
  values: T[],
  serialize: (batch: T[]) => unknown,
  maximumBytes = LARK_SAFE_CLI_JSON_BYTES,
  maximumCount = LARK_BATCH_LIMIT,
): T[][] {
  const result: T[][] = [];
  let current: T[] = [];
  for (const value of values) {
    const candidate = [...current, value];
    if (current.length && (candidate.length > maximumCount || Buffer.byteLength(JSON.stringify(serialize(candidate)), "utf8") > maximumBytes)) {
      result.push(current);
      current = [value];
    } else current = candidate;
  }
  if (current.length) result.push(current);
  return result;
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

export interface LarkTableAudit {
  kind: ControlEntityKind;
  records: number;
  fields: number;
  missingManagedFields: string[];
  unrecognizedFields: string[];
  typeMismatches: string[];
  fullyBlankFields: Array<{ name: string; blank: number }>;
  partiallyBlankFields: Array<{ name: string; blank: number; filled: number }>;
  requiredBlankFields: Array<{ name: string; blank: number; filled: number }>;
}

function blankLarkValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

/** Read-only production inventory and row-completeness audit. */
export function auditLarkControlPlane(
  config: NonNullable<EffectiveConfig["controlPlane"]["lark"]>,
  runner: LarkRunner = systemLarkRunner(config.profile),
): { ready: boolean; manifestVersion: string; tables: LarkTableAudit[] } {
  const client = new LarkCliClient(config.baseToken, config.identity, runner);
  const tables: LarkTableAudit[] = [];
  for (const kind of Object.keys(LARK_FIELD_MANIFEST) as ControlEntityKind[]) {
    const actualFields = client.fields(config.tables[kind]);
    const actualByName = new Map(actualFields.map((field) => [field.name, String(field.type)]));
    const inventory = new Map(LARK_FIELD_INVENTORY[kind].map((field) => [field.name, field.type]));
    const rows = client.records(config.tables[kind], actualFields.map((field) => field.name));
    const blankCounts = new Map(actualFields.map((field) => [field.name, rows.reduce((count, row) => count + Number(blankLarkValue(row.fields[field.name])), 0)]));
    const blankFields = actualFields.flatMap((field) => {
      const blank = blankCounts.get(field.name) ?? 0; const filled = rows.length - blank;
      return blank ? [{ name: field.name, blank, filled }] : [];
    });
    const required = new Set(LARK_ROW_COMPLETENESS_FIELDS[kind]);
    tables.push({
      kind, records: rows.length, fields: actualFields.length,
      missingManagedFields: LARK_FIELD_MANIFEST[kind].map((field) => field.name).filter((name) => !actualByName.has(name)),
      unrecognizedFields: actualFields.map((field) => field.name).filter((name) => !inventory.has(name)),
      typeMismatches: actualFields.flatMap((field) => inventory.has(field.name) && inventory.get(field.name) !== String(field.type) ? [`${field.name}:actual=${field.type},expected=${inventory.get(field.name)}`] : []),
      fullyBlankFields: blankFields.filter((field) => field.filled === 0).map(({ name, blank }) => ({ name, blank })),
      partiallyBlankFields: blankFields.filter((field) => field.filled > 0),
      requiredBlankFields: blankFields.filter((field) => required.has(field.name)),
    });
  }
  return { ready: tables.every((table) => !table.missingManagedFields.length && !table.unrecognizedFields.length && !table.typeMismatches.length && !table.requiredBlankFields.length),
    manifestVersion: LARK_FIELD_MANIFEST_VERSION, tables };
}

export class LarkControlPlaneStore implements ControlPlaneStore {
  readonly driver = "lark" as const;
  private readonly client: LarkCliClient;

  constructor(private readonly config: NonNullable<EffectiveConfig["controlPlane"]["lark"]>, runner?: LarkRunner) {
    this.client = new LarkCliClient(config.baseToken, config.identity, runner ?? systemLarkRunner(config.profile));
  }

  businessIds(): Record<ControlEntityKind, string[]> {
    return Object.fromEntries((Object.keys(LARK_ID_FIELDS) as ControlEntityKind[]).map((kind) => {
      const idField = LARK_ID_FIELDS[kind];
      const ids = this.client.records(this.config.tables[kind], [idField]).flatMap((row) => {
        const id = first(row.fields[idField]); return id ? [id] : [];
      });
      return [kind, ids];
    })) as Record<ControlEntityKind, string[]>;
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
        const inventory = new Map(LARK_FIELD_INVENTORY[kind].map((field) => [field.name, field.type]));
        const missing = REQUIRED_LARK_FIELDS[kind].filter((field) => !actual.has(field));
        const unrecognized = fields.filter((field) => !inventory.has(field.name)).map((field) => `${field.name}:unrecognized-${field.type}`);
        const inventoryTypeMismatches = fields.flatMap((field) => {
          const expected = inventory.get(field.name);
          return expected && expected !== field.type ? [`${field.name}:type=${field.type},inventory=${expected}`] : [];
        });
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
        const problems = [...missing.map((field) => `${field}:missing`), ...invalidScalars, ...invalidLinks, ...unrecognized, ...inventoryTypeMismatches];
        checks.push({ name: `lark-table:${kind}`, ok: problems.length === 0, detail: problems.length ? `invalid fields: ${problems.join(", ")}` : `${actual.size} fields; ${LARK_FIELD_MANIFEST_VERSION} managed contract present and every production field is inventoried` });
        const count = this.client.countRecords(this.config.tables[kind], LARK_ID_FIELDS[kind]);
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
        const id = first(row.fields[LARK_ID_FIELDS[kind]]); return id ? [[row.recordId, id] as const] : [];
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

  async plan(records: CanonicalControlRecord[], options: { includeCompatibility?: boolean } = {}): Promise<SyncPlan> {
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
      const idField = LARK_ID_FIELDS[kind];
      const recordsForKind = records.filter((record) => record.kind === kind);
      const available = options.includeCompatibility ? new Set(this.client.fields(this.config.tables[kind]).map((field) => field.name)) : new Set<string>();
      const readable = options.includeCompatibility
        ? [...new Set([...REQUIRED_LARK_FIELDS[kind], ...LARK_FIELD_INVENTORY[kind].map((field) => field.name)])].filter((name) => available.has(name))
        : REQUIRED_LARK_FIELDS[kind];
      const requestedIds = new Set(recordsForKind.map((record) => record.id));
      const rows = options.includeCompatibility
        ? this.client.records(this.config.tables[kind], readable).filter((row) => requestedIds.has(first(row.fields[idField]) ?? ""))
        : this.client.recordsMatchingAny(this.config.tables[kind], idField, [...requestedIds], readable);
      const existing = new Map(rows.map((row) => [first(row.fields[idField]), row]));
      knownTargets[kind] = new Map([...existing.entries()].flatMap(([id, row]) => id ? [[id, row.recordId] as const] : []));
      for (const record of recordsForKind) {
        const current = existing.get(record.id); const storeRecordId = current?.recordId;
        const expected = writableLarkFields(kind, larkFields(record), available);
        const expectedForComparison = comparisonFields(record, expected);
        const matches = current ? fieldsMatch(current.fields, expectedForComparison) : false;
        if (storeRecordId && matches) unchanged.push({ ...record, storeRecordId });
        else if (storeRecordId) updates.push({ ...record, storeRecordId }); else creates.push(record);
      }
      if (creates.some((record) => record.kind === kind)) existingCounts.set(kind, this.client.countRecords(this.config.tables[kind], idField));
    }
    const referencedKinds = [...new Set(records.flatMap((record) => Object.entries(record.links ?? {}).flatMap(([kind, ids]) => ids?.length ? [kind as ControlEntityKind] : [])))];
    for (const kind of referencedKinds) {
      const idField = LARK_ID_FIELDS[kind];
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
    const schemaByKind = new Map<ControlEntityKind, Map<string, ReturnType<LarkCliClient["fields"]>[number]>>();
    for (const kind of [...new Set(plannedRecords.map((record) => record.kind))]) {
      const schema = new Map(this.client.fields(this.config.tables[kind]).map((field) => [field.name, field]));
      schemaByKind.set(kind, schema);
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
      const available = new Set(schemaByKind.get(kind)!.keys());
      const prepared = plan.creates.filter((record) => record.kind === kind)
        .map((record) => ({ record, fields: writableLarkFields(kind, larkFields(record), available) }));
      for (const batch of chunksByJsonBytes(prepared, (entries) => ({ create_records: entries.map(({ fields }) => fields) }))) {
        try {
          const response = this.client.batchCreate(this.config.tables[kind], batch.map(({ fields }) => fields));
          const object = response && typeof response === "object" ? response as Record<string, unknown> : {};
          const ids = Array.isArray(object.record_id_list) ? object.record_id_list.filter((id): id is string => typeof id === "string" && Boolean(id))
            : Array.isArray(object.recordIdList) ? object.recordIdList.filter((id): id is string => typeof id === "string" && Boolean(id)) : [];
          if (ids.length !== batch.length) throw new Error(`lark-cli returned ${ids.length}/${batch.length} record IDs for ${kind}`);
          batch.forEach(({ record }, ordinal) => {
            const storeRecordId = ids[ordinal]!; index[kind]!.set(record.id, storeRecordId); completed.set(key(record), { ...record, storeRecordId });
          });
        } catch (error) {
          const detail = `record create failed: ${error instanceof Error ? error.message : String(error)}`;
          for (const { record } of batch) failed.push({ kind: record.kind, id: record.id, detail });
          scalarWriteFailed = true;
          break createKinds;
        }
      }
    }
    updateKinds: for (const kind of scalarWriteFailed ? [] : [...new Set(plan.updates.map((record) => record.kind))]) {
      const available = new Set(schemaByKind.get(kind)!.keys());
      const prepared = plan.updates.filter((record) => record.kind === kind)
        .map((record) => ({ record, fields: writableLarkFields(kind, larkFields(record), available) }));
      for (const batch of chunksByJsonBytes(prepared, (entries) => ({ update_records: Object.fromEntries(entries.map(({ record, fields }) => [record.storeRecordId!, fields])) }))) {
        try {
          this.client.batchUpdate(this.config.tables[kind], Object.fromEntries(batch.map(({ record, fields }) => [record.storeRecordId!, fields])));
          for (const { record } of batch) completed.set(key(record), record);
        } catch (error) {
          const detail = `record update failed: ${error instanceof Error ? error.message : String(error)}`;
          for (const { record } of batch) failed.push({ kind: record.kind, id: record.id, detail });
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
        try { return [{ record, fields: larkLinkFields(record, index, new Set(schemaByKind.get(kind)!.keys())) }]; }
        catch (error) {
          failed.push({ kind: record.kind, id: record.id, detail: `link update failed: ${error instanceof Error ? error.message : String(error)}` });
          return [];
        }
      });
      for (const batch of chunksByJsonBytes(prepared, (entries) => ({ update_records: Object.fromEntries(entries.map(({ record, fields }) => [record.storeRecordId!, fields])) }))) {
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
      const available = new Set(schemaByKind.get(kind)!.keys());
      const expectedById = new Map(records.map((record) => [record.id, comparisonFields(record, writableLarkFields(kind, larkFields(record, index), available))]));
      const fields = [...new Set([LARK_ID_FIELDS[kind], ...records.flatMap((record) => Object.keys(expectedById.get(record.id)!))])];
      let pending = records;
      let lastError: unknown;
      for (let attempt = 0; attempt < 5 && pending.length; attempt += 1) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        try {
          const actualById = new Map(this.client.recordsByIds(this.config.tables[kind], records.map((record) => record.storeRecordId!).filter(Boolean), fields).flatMap((row) => {
            const id = first(row.fields[LARK_ID_FIELDS[kind]]);
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
