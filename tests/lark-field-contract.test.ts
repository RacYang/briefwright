import { describe, expect, it } from "vitest";

import { assertBackfillAuthorization, historicalSourceEvidence, remoteWithoutLocalEvidenceByKind } from "../src/commands/import-sync.js";
import { LARK_COMPATIBILITY_FIELDS, LARK_FIELD_INVENTORY, LARK_FIELD_MANIFEST, LARK_FIELD_MANIFEST_VERSION } from "../src/control-plane/lark-field-manifest.js";
import { larkFields } from "../src/control-plane/lark.js";
import type { ControlEntityKind } from "../src/control-plane/types.js";

const checklist: Record<ControlEntityKind, string[]> = {
  sources: ["连接器类型", "连接器版本", "连接器配置（脱敏）", "配置摘要", "最小扫描间隔小时", "当前扫描间隔小时", "最大扫描间隔小时", "游标摘要", "最近失败时间", "最近错误码", "最近失败详情", "最近响应指纹"],
  runs: ["运行类型", "运行模式", "父运行批次", "配置摘要", "策略摘要", "提示词摘要", "来源清单摘要", "协议合同摘要", "执行计划摘要", "执行计划 JSON", "Daily 路径", "Review 路径", "运行时版本", "运行时摘要", "进程存储已确认", "远端读回 Revision", "远端读回摘要", "发布提交已确认", "规则合同有效", "文档存储有效", "完成报告 JSON", "更新来源数", "无变化来源数", "失败来源数", "跳过来源数", "缺失回执数", "缺失 Source IDs", "Daily 条目数", "Review 条目数", "机器层条目数", "模型失败数", "模型失败明细", "分析积压数", "分析积压明细", "阶段耗时 JSON", "产物阶段耗时 JSON", "领域计数 JSON", "Top Item IDs", "执行 Owner", "Lease 到期", "最近心跳", "Fencing Token", "中止遗弃原因"],
  items: ["处置结果", "Canonical Identity", "Capture Hash", "抓取时间", "页面更新时间", "主张 JSON", "主张证据 JSON", "七维评分详情 JSON", "各维度评分理由 JSON", "知识潜力 JSON", "淘汰原因集合", "Daily 排除原因集合", "分析状态", "模型 Provider", "模型名称", "Prompt 版本", "分析时间", "分析耗时毫秒", "输入 Token", "输出 Token", "已知成本", "条目快照摘要", "新鲜度判定", "日期语义"],
  events: ["所属阶段", "事件类型", "实体类型", "实体 ID", "完整载荷 JSON", "运行内序号", "事件 Schema 版本", "关联事件 ID", "持续时间毫秒", "严重级别"],
  feedback: ["反馈类型", "目标字段", "原值 JSON", "建议值 JSON", "处理状态", "处理时间", "处理人", "处理结果决议", "幂等键", "载荷指纹", "反馈来源渠道"],
  experiments: ["基线策略摘要", "候选策略摘要", "样本摘要", "基线策略 JSON", "候选策略 JSON", "样本 JSON", "指标结果 JSON", "Guardrail 结果 JSON", "评审条目数", "观察天数", "14天门槛通过", "50条评审门槛通过", "批准时间", "激活时间", "回滚时间", "决策理由", "实验 Revision"],
  captures: ["External Key", "连接器类型", "连接器版本", "标准化发布时间", "页面更新时间", "页面更新时间原值", "证据类别", "日期语义", "恢复自内容哈希", "Capture Bundle ID", "Bundle 摘要", "Capture Manifest 摘要", "抓取耗时毫秒", "外部请求 ID", "重定向链 JSON", "内容长度", "原始载荷摘要", "原始载荷 Schema 版本"],
  rules: ["Policy ID", "Policy 版本", "Policy 摘要", "规则来源", "Rule Schema 版本", "父规则替代规则", "回滚目标规则", "人工锁定", "不可变 Revision", "Runtime 兼容范围", "依赖 Rule IDs", "依赖 Prompt Pack", "Guardrail JSON", "退役原因"],
  receipts: ["尝试次数", "错误码", "连接器类型", "连接器版本", "游标前摘要", "游标后摘要", "是否可重试", "下次重试时间", "外部请求 ID", "到期清单摘要", "请求载荷摘要", "结构化详情 JSON", "来源有效更新时间"],
};

const productionExtras: Record<ControlEntityKind, string[]> = {
  sources: ["近30天更新率", "连续失败次数", "最近调频", "发现条目", "近30天入围数", "创建时间", "机构", "权威分", "调频原因", "连续无更新次数", "备注", "近30天扫描数", "近30天有效更新数", "连续建议周期", "原始采集", "建议频率", "近30天入围率", "扫描回执", "调频分", "更新时间", "基准频率"],
  runs: ["错误数", "创建时间", "发现数", "更新时间", "覆盖开始", "核验数", "覆盖结束"],
  items: ["发现渠道", "去重键", "可行动分", "相关性分", "URL 指纹", "人工反馈", "事件日期", "证据分", "更新时间", "创建时间", "淘汰原因", "候选编号", "重复于", "时效分", "发布日期", "关键短摘录", "新颖分", "来源权威分", "交叉领域", "Obsidian 链接", "影响分"],
  events: ["创建时间", "旧规则标识（迁移前）"],
  feedback: ["反馈前状态", "反馈后状态", "创建时间", "反馈人"],
  experiments: ["基线指标", "旧基线标识（迁移前）", "样本窗口开始", "相关状态事件", "旧候选标识（迁移前）", "发布时间", "审批人", "触发反馈", "样本窗口结束", "更新时间", "创建时间"],
  captures: ["更新时间", "解析结果", "原始快照位置", "创建时间", "保留级别"],
  rules: ["入围阈值", "失效时间", "来源实验", "人工复核阈值", "审批说明", "审批人", "创建时间", "生效时间", "指标与权重", "硬性门槛", "更新时间", "状态事件", "运行批次", "单领域上限", "每日总上限"],
  receipts: ["创建时间", "频率快照"],
};

const productionFieldCounts: Record<ControlEntityKind, number> = {
  sources: 55, runs: 74, items: 60, events: 28, feedback: 25, experiments: 42, captures: 53, rules: 43, receipts: 35,
};

describe(`${LARK_FIELD_MANIFEST_VERSION} field coverage`, () => {
  it("treats a receipt source snapshot as local evidence before cleanup classification", () => {
    const records = [
      {
        kind: "receipts" as const,
        id: "RUN-1:SRC-HISTORICAL",
        payload: {
          source_id: "SRC-HISTORICAL",
          source_snapshot_json: JSON.stringify({ id: "SRC-HISTORICAL", title: "Historical source" }),
        },
        links: { sources: ["SRC-HISTORICAL"] },
      },
      {
        kind: "receipts" as const,
        id: "RUN-2:SRC-MISMATCH",
        payload: {
          source_id: "SRC-MISMATCH",
          source_snapshot_json: JSON.stringify({ id: "SRC-OTHER", title: "Wrong source" }),
        },
        links: { sources: ["SRC-MISMATCH"] },
      },
      {
        kind: "receipts" as const,
        id: "RUN-3:SRC-BROKEN",
        payload: { source_id: "SRC-BROKEN", source_snapshot_json: "not-json" },
        links: { sources: ["SRC-BROKEN"] },
      },
    ];

    expect([...historicalSourceEvidence(records)]).toEqual(["SRC-HISTORICAL"]);
    const recordMap = new Map(records.map((record) => [`${record.kind}\n${record.id}`, record]));
    const remoteIds = Object.fromEntries([
      "sources", "runs", "items", "events", "feedback", "experiments", "captures", "rules", "receipts",
    ].map((kind) => [kind, kind === "sources" ? ["SRC-HISTORICAL", "SRC-UNKNOWN"] : []])) as Record<ControlEntityKind, string[]>;
    expect(remoteWithoutLocalEvidenceByKind(recordMap, remoteIds)).toMatchObject({ sources: 1, receipts: 0 });
  });

  it("binds every applied backfill to the exact reviewed digest and update count", () => {
    expect(() => assertBackfillAuthorization({ digest: "abc", updates: 1549 }, "abc", 1549)).not.toThrow();
    expect(() => assertBackfillAuthorization({ digest: "changed", updates: 1549 }, "abc", 1549)).toThrow(/digest changed/);
    expect(() => assertBackfillAuthorization({ digest: "abc", updates: 1550 }, "abc", 1549)).toThrow(/update count changed/);
    expect(() => assertBackfillAuthorization({ digest: "abc", updates: 1549 })).toThrow(/requires --expect-digest and --expect-updates/);
  });

  it("contains every field in the accepted nine-table checklist exactly once", () => {
    for (const [kind, required] of Object.entries(checklist) as Array<[ControlEntityKind, string[]]>) {
      const names = LARK_FIELD_MANIFEST[kind].map((field) => field.name);
      expect(new Set(names).size, `${kind} has duplicate field names`).toBe(names.length);
      expect(names).toEqual(expect.arrayContaining(required));
    }
  });

  it("covers the complete observed production schema instead of only newly managed columns", () => {
    for (const kind of Object.keys(productionExtras) as ControlEntityKind[]) {
      const compatibility = LARK_COMPATIBILITY_FIELDS[kind].map((field) => field.name);
      const inventory = LARK_FIELD_INVENTORY[kind].map((field) => field.name);
      expect(compatibility, `${kind} production compatibility fields drifted`).toEqual(productionExtras[kind]);
      expect(new Set(inventory).size, `${kind} inventory has duplicate names`).toBe(inventory.length);
      expect(inventory, `${kind} production inventory is incomplete`).toHaveLength(productionFieldCounts[kind]);
    }
  });

  it("uses typed self-links for recovery and rule lineage", () => {
    expect(LARK_FIELD_MANIFEST.runs).toContainEqual(expect.objectContaining({ name: "父运行批次", type: "link", target: "runs" }));
    expect(LARK_FIELD_MANIFEST.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "父规则替代规则", type: "link", target: "rules" }),
      expect.objectContaining({ name: "回滚目标规则", type: "link", target: "rules" }),
    ]));
  });

  it("projects representative rich payloads instead of merely provisioning empty columns", () => {
    expect(larkFields({ kind: "events", id: "EVT-1", payload: { stage: "capture", event_type: "capture.failed", entity_type: "source", entity_id: "SRC-1", payload_json: "{\"error\":\"boom\"}", sequence: 7, duration_ms: 42 } }))
      .toMatchObject({ 所属阶段: "capture", 事件类型: "capture.failed", 实体类型: "source", "实体 ID": "SRC-1", 运行内序号: 7, 持续时间毫秒: 42 });
    expect(larkFields({ kind: "receipts", id: "SCAN-1", payload: { result: "observed", attempts: 2, error_code: "RATE_LIMIT", connector_type: "rss", retryable: true } }))
      .toMatchObject({ 扫描结果: "已观察", 尝试次数: 2, 错误码: "RATE_LIMIT", 连接器类型: "rss", 是否可重试: true });
    expect(larkFields({ kind: "items", id: "ITEM-1", payload: { disposition: "daily", score: 91, analysis_json: JSON.stringify({ claims: ["claim"], knowledgePotential: { reusableQuestion: true }, scoreDimensions: { authority: { value: 5, weight: 1, weighted: 5, reason: "primary" } } }) } }))
      .toMatchObject({ 处置结果: "daily", "主张 JSON": "[\"claim\"]", "知识潜力 JSON": expect.stringContaining("reusableQuestion"), "各维度评分理由 JSON": expect.stringContaining("primary"), 来源权威分: 5 });
    expect(larkFields({ kind: "sources", id: "SRC-1", payload: { id: "SRC-1", title: "Source", enabled: true, sourceType: "website", evidenceTier: "primary", priority: 90,
      connector: { type: "webpage", config: { url: "https://example.com" } }, scans_30d: 10, updates_30d: 4, selections_30d: 2 } }))
      .toMatchObject({ 近30天扫描数: 10, 近30天有效更新数: 4, 近30天入围数: 2, 近30天更新率: 0.4, 近30天入围率: 0.2, 权威分: 5 });
    expect(larkFields({ kind: "receipts", id: "SCAN-2", payload: { scan_frequency: "weekly" } }))
      .toMatchObject({ 频率快照: "每周" });
  });
});
