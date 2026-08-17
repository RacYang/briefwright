import { describe, expect, it } from "vitest";

import { LARK_FIELD_MANIFEST, LARK_FIELD_MANIFEST_VERSION } from "../src/control-plane/lark-field-manifest.js";
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

describe(`${LARK_FIELD_MANIFEST_VERSION} field coverage`, () => {
  it("contains every field in the accepted nine-table checklist exactly once", () => {
    for (const [kind, required] of Object.entries(checklist) as Array<[ControlEntityKind, string[]]>) {
      const names = LARK_FIELD_MANIFEST[kind].map((field) => field.name);
      expect(new Set(names).size, `${kind} has duplicate field names`).toBe(names.length);
      expect(names).toEqual(expect.arrayContaining(required));
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
      .toMatchObject({ 处置结果: "daily", "主张 JSON": "[\"claim\"]", "知识潜力 JSON": expect.stringContaining("reusableQuestion"), "各维度评分理由 JSON": expect.stringContaining("primary") });
  });
});
