import { describe, expect, it } from "vitest";

import { LarkControlPlaneStore, larkFields, larkSource, provisionLarkControlPlane } from "../src/control-plane/lark.js";
import type { LarkRunner } from "../src/control-plane/lark-cli.js";
import type { LarkTableMapping } from "../src/config/types.js";

const tables = Object.fromEntries(["sources", "runs", "items", "events", "feedback", "experiments", "captures", "rules", "receipts"].map((kind) => [kind, `tbl_${kind}`])) as unknown as LarkTableMapping;

describe("Lark control plane", () => {
  it("provisions a blank Base idempotently with nine standard tables and relationship fields", () => {
    const calls: string[][] = []; const fields = new Map<string, Array<{ id: string; name: string; type: string }>>(); let next = 0;
    const runner: LarkRunner = (args) => {
      calls.push(args);
      if (args.includes("+table-list")) return { tables: [] };
      if (args.includes("+table-create")) {
        const id = `tbl_new_${next++}`; const definitions = JSON.parse(args[args.indexOf("--fields") + 1]!) as Array<{ name: string; type: string }>;
        fields.set(id, definitions.map((field, index) => ({ id: `fld_${index}`, name: field.name, type: field.type })));
        return { table_id: id };
      }
      if (args.includes("+field-list")) return { fields: fields.get(args[args.indexOf("--table-id") + 1]!) ?? [] };
      if (args.includes("+field-create")) {
        const id = args[args.indexOf("--table-id") + 1]!; const field = JSON.parse(args[args.indexOf("--json") + 1]!) as { name: string; type: string };
        fields.set(id, [...(fields.get(id) ?? []), { id: `fld_${fields.get(id)?.length ?? 0}`, name: field.name, type: field.type }]); return {};
      }
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const standard = { sources: "数据源", runs: "运行批次", items: "情报条目", events: "状态事件", feedback: "人工反馈", experiments: "优化实验", captures: "原始采集", rules: "规则版本", receipts: "扫描回执" };
    const result = provisionLarkControlPlane({ baseToken: "base", identity: "user", tables: standard }, runner);
    expect(result.createdTables).toHaveLength(9); expect(result.createdFields).toContain("情报条目.评分规则");
    expect(calls.filter((args) => args.includes("+table-create"))).toHaveLength(9);
  });

  it("maps an existing Base source into a typed connector and remote cadence", () => {
    const source = larkSource({ recordId: "rec1", fields: {
      "Source ID": "SRC-OPENAI-GITHUB", 名称: "OpenAI releases", 状态: ["启用"], 来源类型: ["GitHub"],
      "入口 URL": "[releases](https://github.com/openai/openai-node/releases)", 来源层级: ["一手来源"],
      覆盖领域: ["Agent与开发工具"], 扫描频率: ["每日"], 优先级: 99, 下次扫描: "2026-08-11T02:00:00Z",
    } });
    expect(source).toMatchObject({ id: "SRC-OPENAI-GITHUB", enabled: true, evidenceTier: "primary",
      connector: { type: "github-releases", config: { repository: "openai/openai-node" } },
      scheduleState: { frequency: "daily", nextScanAt: "2026-08-11T02:00:00.000Z" } });
  });

  it("maps X to the explicitly configured Codex browser bridge without an API secret", () => {
    const source = larkSource({ recordId: "rec-x", fields: { "Source ID": "SRC-OPENAI-X", 名称: "OpenAI X", 状态: ["启用"], 来源类型: ["X"],
      "入口 URL": "https://x.com/OpenAI", 来源层级: ["发现线索"], 覆盖领域: ["Agent"], 扫描频率: ["每日"] } }, "codex-browser");
    expect(source).toMatchObject({ connector: { type: "codex-browser", config: { username: "OpenAI" } } });
    expect(JSON.stringify(source)).not.toContain("X_BEARER_TOKEN");
  });

  it("maps canonical run data to real Chinese Base fields without leaking canonical keys", () => {
    const fields = larkFields({ kind: "runs", id: "RUN-20260811-DAILY", payload: {
      status: "partial", current_stage: "complete", started_at: "2026-08-11T02:00:00Z", completed_at: "2026-08-11T02:05:00Z",
      config_digest: "abcdef1234567890", result_json: JSON.stringify({ outcome: "partial", daily: [{ id: "AI-1" }], review: [] }),
      execution_plan_json: JSON.stringify({ provenance: { coreVersion: "2.0", policyVersion: "1.1" } }),
    } });
    expect(fields).toMatchObject({ "Run ID": "RUN-20260811-DAILY", 状态: "部分成功", 当前阶段: "完成", 工作流版本: "2.0", 评分版本: "1.1", 开始时间: "2026-08-11 10:00:00", 入围数: 1 });
    expect(fields).not.toHaveProperty("run_id");
  });

  it("maps successful and failed capture metadata to the production Base contract", () => {
    const fields = larkFields({ kind: "captures", id: "CAP-FAILED", payload: {
      source_id: "SRC-X", canonical_url: "https://x.com/example", content_hash: "abc", title: "Example", summary: "",
      captured_at: "2026-08-11T02:00:00Z", raw_json: JSON.stringify({ discoveryUrl: "https://x.com/example", discoveryChannel: "x-api",
        fetchStatus: "failed", extractStatus: "not-attempted", httpStatus: 429, attempts: 3, parserVersion: "1.0.0", failureReason: "HTTP 429" }),
    } });
    expect(fields).toMatchObject({ "Capture ID": "CAP-FAILED", "发现渠道": "x-api", "抓取状态": "失败", "提取状态": "未尝试", "HTTP 状态码": 429, "尝试次数": 3, "解析器版本": "1.0.0", "失败原因": "HTTP 429" });
  });

  it("maps canonical failure transition identity, attempts, and error code", () => {
    const fields = larkFields({ kind: "events", id: "EVT-1", payload: {
      occurred_at: "2026-08-11T02:00:00Z", event_type: "capture.failed", idempotency_key: "RUN:SRC:RULE-WORKFLOW-V1.3",
      payload_fingerprint: "fingerprint", payload_json: JSON.stringify({ fromState: "已发现", toState: "抓取失败", actor: "采集器", reason: "HTTP 503", attempts: 3, errorCode: "CAPTURE_FAILED", ruleIdSnapshot: "RULE-WORKFLOW-V1.3" }),
    }, links: { rules: ["RULE-WORKFLOW-V1.3"] } });
    expect(fields).toMatchObject({ 原状态: "已发现", 新状态: "抓取失败", 执行者: "采集器", "Rule ID 快照": "RULE-WORKFLOW-V1.3", 尝试次数: 3, 错误码: "CAPTURE_FAILED" });
  });

  it("pulls paginated sources/rules and uses lark-cli upsert for writable entities", async () => {
    const calls: string[][] = [];
    const runner: LarkRunner = (args) => {
      calls.push(args);
      if (args.includes("+record-list")) {
        const table = args[args.indexOf("--table-id") + 1];
        if (table === tables.sources) return { record_id_list: ["rec_source"], fields: ["Source ID", "名称", "状态", "来源类型", "入口 URL", "来源层级", "覆盖领域", "扫描频率"], data: [["SRC-OPENAI", "OpenAI", ["启用"], ["官网"], "https://openai.com/news/", ["一手来源"], ["模型与产品发布"], ["每日"]]], has_more: false };
        if (table === tables.rules) return { record_id_list: ["rec_rule"], fields: ["Rule ID", "版本", "标题", "状态"], data: [["RULE-WORKFLOW-V1.3", "1.3", "Workflow", ["生效中"]]], has_more: false };
        return { record_id_list: [], fields: [], data: [], has_more: false };
      }
      if (args.includes("+record-upsert")) return { record_id: "rec_run" };
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const store = new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner);
    const snapshot = await store.pull();
    expect(snapshot.sources).toHaveLength(1); expect(snapshot.rules).toHaveLength(1);
    const plan = await store.plan([{ kind: "runs", id: "RUN-20260811-DAILY", payload: { status: "success", current_stage: "complete" } }]);
    const result = await store.apply(plan);
    expect(result).toMatchObject({ created: 1, updated: 0, failed: [] });
    const write = calls.find((args) => args.includes("+record-upsert"));
    expect(write).toBeDefined();
    expect(JSON.parse(write![write!.indexOf("--json") + 1]!)).toMatchObject({ "Run ID": "RUN-20260811-DAILY", 状态: "成功" });
  });

  it("resolves linked Base feedback to stable item and run IDs", async () => {
    const runner: LarkRunner = (args) => {
      if (!args.includes("+record-list")) throw new Error(`unexpected call ${args.join(" ")}`);
      const table = args[args.indexOf("--table-id") + 1];
      if (table === tables.items) return { record_id_list: ["rec_item"], fields: ["Item ID"], data: [["AI-1"]], has_more: false };
      if (table === tables.runs) return { record_id_list: ["rec_run"], fields: ["Run ID"], data: [["RUN-1"]], has_more: false };
      if (table === tables.feedback) return { record_id_list: ["rec_feedback"], fields: ["Feedback ID", "判断", "反馈说明", "情报条目", "运行批次"], data: [["FDB-1", "纳入", "useful", [{ id: "rec_item" }], [{ id: "rec_run" }]]], has_more: false };
      return { record_id_list: [], fields: [], data: [], has_more: false };
    };
    const snapshot = await new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner).pull();
    expect(snapshot.feedback).toEqual([expect.objectContaining({ id: "FDB-1", payload: expect.objectContaining({ feedback_type: "include" }), links: { items: ["AI-1"], runs: ["RUN-1"] } })]);
    expect(larkFields({ kind: "feedback", id: "FDB-2", payload: { feedback_type: "source-correction", created_at: "2026-08-11T00:00:00Z" } })).toMatchObject({ 判断: "纠正来源", 原因标签: "source-correction" });
  });
});
