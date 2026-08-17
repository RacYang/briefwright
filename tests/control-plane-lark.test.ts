import { describe, expect, it } from "vitest";

import { auditLarkControlPlane, LarkControlPlaneStore, larkFields, larkSource, provisionLarkControlPlane } from "../src/control-plane/lark.js";
import { LARK_FIELD_INVENTORY, LARK_FIELD_MANIFEST } from "../src/control-plane/lark-field-manifest.js";
import { reconciliationRecords } from "../src/control-plane/registry.js";
import type { LarkFieldDefinition, LarkRunner } from "../src/control-plane/lark-cli.js";
import type { LarkTableMapping } from "../src/config/types.js";
import type { CanonicalControlRecord, SyncPlan } from "../src/control-plane/types.js";

const tables = Object.fromEntries(["sources", "runs", "items", "events", "feedback", "experiments", "captures", "rules", "receipts"].map((kind) => [kind, `tbl_${kind}`])) as unknown as LarkTableMapping;

describe("Lark control plane", () => {
  it("fails the read-only audit for an unrecognized production field or blank core value", () => {
    const kindByTable = new Map(Object.entries(tables).map(([kind, table]) => [table, kind as keyof typeof LARK_FIELD_MANIFEST]));
    const runner: LarkRunner = (args) => {
      const table = args[args.indexOf("--table-id") + 1]!; const kind = kindByTable.get(table)!;
      if (args.includes("+field-list")) return { fields: [
        ...LARK_FIELD_MANIFEST[kind].map((field, index) => ({ ...field, id: `fld_${index}`, ...(field.type === "link" ? { link_table: tables[field.target!] } : {}) })),
        ...(kind === "runs" ? [{ id: "fld_unknown", name: "未受管列", type: "text" as const }] : []),
      ] };
      if (args.includes("+record-list")) {
        const requested = args.flatMap((arg, index) => arg === "--field-id" ? [args[index + 1]!] : []);
        return { record_id_list: [`rec_${kind}`], fields: requested, data: [requested.map((field) => kind === "items" && field === "标题" ? null : "filled")], has_more: false };
      }
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const result = auditLarkControlPlane({ baseToken: "base", identity: "user", tables }, runner);
    expect(result.ready).toBe(false);
    expect(result.tables.find((table) => table.kind === "runs")?.unrecognizedFields).toEqual(["未受管列"]);
    expect(result.tables.find((table) => table.kind === "items")?.requiredBlankFields).toContainEqual({ name: "标题", blank: 1, filled: 0 });
  });

  it("provisions a blank Base idempotently with nine standard tables and relationship fields", () => {
    const calls: string[][] = []; const fields = new Map<string, Array<LarkFieldDefinition & { id: string }>>(); const tableNames = new Map<string, string>(); let next = 0;
    const runner: LarkRunner = (args) => {
      calls.push(args);
      if (args.includes("+table-list")) return { tables: [...tableNames].map(([id, name]) => ({ id, name })) };
      if (args.includes("+table-create")) {
        const id = `tbl_new_${next++}`; const definitions = JSON.parse(args[args.indexOf("--fields") + 1]!) as LarkFieldDefinition[];
        tableNames.set(id, args[args.indexOf("--name") + 1]!);
        fields.set(id, definitions.map((field, index) => ({ id: `fld_${index}`, ...field })));
        return { table_id: id };
      }
      if (args.includes("+field-list")) return { fields: fields.get(args[args.indexOf("--table-id") + 1]!) ?? [] };
      if (args.includes("+field-create")) {
        const id = args[args.indexOf("--table-id") + 1]!; const field = JSON.parse(args[args.indexOf("--json") + 1]!) as LarkFieldDefinition;
        fields.set(id, [...(fields.get(id) ?? []), { id: `fld_${fields.get(id)?.length ?? 0}`, ...field }]); return {};
      }
      if (args.includes("+field-update")) {
        const table = args[args.indexOf("--table-id") + 1]!; const fieldId = args[args.indexOf("--field-id") + 1]!;
        const field = JSON.parse(args[args.indexOf("--json") + 1]!) as LarkFieldDefinition;
        fields.set(table, (fields.get(table) ?? []).map((entry) => entry.id === fieldId ? { id: fieldId, ...field } : entry)); return {};
      }
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const standard = { sources: "数据源", runs: "运行批次", items: "情报条目", events: "状态事件", feedback: "人工反馈", experiments: "优化实验", captures: "原始采集", rules: "规则版本", receipts: "扫描回执" };
    const result = provisionLarkControlPlane({ baseToken: "base", identity: "user", tables: standard }, runner);
    expect(result.createdTables).toHaveLength(9); expect(result.createdFields).toContain("情报条目.评分规则");
    expect(calls.filter((args) => args.includes("+table-create"))).toHaveLength(9);
    const linkDefinition = calls.filter((args) => args.includes("+field-create")).map((args) => JSON.parse(args[args.indexOf("--json") + 1]!) as Record<string, unknown>).find((field) => field.type === "link");
    expect(linkDefinition).toMatchObject({ type: "link", link_table: expect.stringMatching(/^tbl_new_/) });
    expect(linkDefinition).not.toHaveProperty("linkTableId");
    const runsTable = [...tableNames].find(([, name]) => name === "运行批次")![0];
    fields.set(runsTable, fields.get(runsTable)!.map((field) => field.name === "发布状态" ? { ...field, options: [] } : field));
    calls.length = 0;
    const migrated = provisionLarkControlPlane({ baseToken: "base", identity: "user", tables: standard }, runner);
    expect(migrated.createdTables).toEqual([]); expect(migrated.createdFields).toEqual([]);
    expect(migrated.updatedFields).toContain("运行批次.发布状态");
    expect(calls.some((args) => args.includes("+field-update") && args.includes("--yes"))).toBe(true);
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

  it("maps an explicitly governed dynamic source to the Computer Use bridge", () => {
    const source = larkSource({ recordId: "rec-dynamic", fields: {
      "Source ID": "SRC-VOLC-DYNAMIC", 名称: "Volcengine dynamic docs", 状态: ["启用"], 来源类型: ["官方文档"],
      "入口 URL": "https://www.volcengine.com/docs/82379", "采集方式": ["Computer Use"], "采集域名": "www.volcengine.com, docs.volcengine.com",
      来源层级: ["一手来源"], 覆盖领域: ["模型与平台"], 扫描频率: ["每日"],
    } });
    expect(source).toMatchObject({
      evidenceTier: "primary",
      connector: { type: "computer-use", config: { url: "https://www.volcengine.com/docs/82379", allowedHosts: ["www.volcengine.com", "docs.volcengine.com"] } },
    });
    const fields = larkFields({ kind: "sources", id: source!.id, payload: source as unknown as Record<string, unknown> });
    expect(fields).toMatchObject({ "入口 URL": "https://www.volcengine.com/docs/82379", "采集方式": "Computer Use", "采集域名": "www.volcengine.com, docs.volcengine.com" });
  });

  it("maps a non-X Codex Browser source to the isolated in-app Browser bridge", () => {
    const source = larkSource({ recordId: "rec-browser", fields: {
      "Source ID": "SRC-XAI-NEWS", 名称: "xAI News", 状态: ["启用"], 来源类型: ["官方博客"],
      "入口 URL": "https://x.ai/news", "采集方式": ["Codex Browser"], "采集域名": "x.ai",
      来源层级: ["一手来源"], 覆盖领域: ["模型与生成式 AI"], 扫描频率: ["每日"],
    } });
    expect(source).toMatchObject({ connector: { type: "in-app-browser", config: { url: "https://x.ai/news", allowedHosts: ["x.ai"] } } });
    expect(larkFields({ kind: "sources", id: source!.id, payload: source as unknown as Record<string, unknown> }))
      .toMatchObject({ "采集方式": "Codex Browser", "采集域名": "x.ai" });
  });

  it("plans a source connector change instead of comparing only mutable scan timestamps", async () => {
    const runner: LarkRunner = (args) => {
      if (!args.includes("+record-list")) throw new Error(`unexpected call ${args.join(" ")}`);
      return { record_id_list: ["rec_source"], fields: ["Source ID", "名称", "状态", "来源类型", "入口 URL", "采集方式", "采集域名", "来源层级", "覆盖领域", "扫描频率", "优先级", "调度状态"],
        data: [["SRC-DYNAMIC", "Dynamic", "启用", "官网", "https://example.com/news", "网页直连", "", "一手来源", ["模型"], "每日", 90, "自动"]], has_more: false };
    };
    const store = new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner);
    const plan = await store.plan([{ kind: "sources", id: "SRC-DYNAMIC", payload: { id: "SRC-DYNAMIC", title: "Dynamic", enabled: true, sourceType: "website", evidenceTier: "primary", coverageDomains: ["模型"], priority: 90,
      connector: { type: "computer-use", config: { url: "https://example.com/news", allowedHosts: ["example.com"] } } } }]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.unchanged).toHaveLength(0);
  });

  it("keeps compatibility columns out of normal planning but includes them in an explicit backfill plan", async () => {
    const record: CanonicalControlRecord = { kind: "sources", id: "SRC-BACKFILL", payload: { id: "SRC-BACKFILL", title: "Backfill", enabled: true,
      sourceType: "website", evidenceTier: "primary", priority: 90, scans_30d: 10, updates_30d: 4, selections_30d: 2,
      connector: { type: "webpage", config: { url: "https://example.com" } } } };
    const expected = larkFields(record);
    const runner: LarkRunner = (args) => {
      if (args.includes("+field-list")) return { fields: LARK_FIELD_INVENTORY.sources.map((field, index) => ({ ...field, id: `fld_${index}` })) };
      if (args.includes("+record-list")) {
        const requested = args.flatMap((arg, index) => arg === "--field-id" ? [args[index + 1]!] : []);
        return { record_id_list: ["rec_source"], fields: requested,
          data: [requested.map((field) => field === "近30天扫描数" ? null : expected[field] ?? null)], has_more: false };
      }
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const store = new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner);
    expect((await store.plan([record])).unchanged).toHaveLength(1);
    expect((await store.plan([record], { includeCompatibility: true })).updates).toHaveLength(1);
  });

  it("plans and emits explicit field clears when a browser source becomes a direct webpage", async () => {
    const runner: LarkRunner = (args) => {
      if (!args.includes("+record-list")) throw new Error(`unexpected call ${args.join(" ")}`);
      return { record_id_list: ["rec_source"], fields: ["Source ID", "名称", "状态", "来源类型", "入口 URL", "采集方式", "采集域名", "来源层级", "覆盖领域", "扫描频率", "优先级", "调度状态"],
        data: [["SRC-DYNAMIC", "Dynamic", "启用", "官网", "https://example.com/news", "Computer Use", "example.com", "一手来源", ["模型"], "每日", 90, "自动"]], has_more: false };
    };
    const record: CanonicalControlRecord = { kind: "sources", id: "SRC-DYNAMIC", payload: { id: "SRC-DYNAMIC", title: "Dynamic", enabled: true, sourceType: "website", evidenceTier: "primary", coverageDomains: ["模型"], priority: 90,
      connector: { type: "webpage", config: { url: "https://example.com/news" } } } };
    const fields = larkFields(record);
    expect(fields).toMatchObject({ "采集方式": "Webpage", "采集域名": "", "连接器类型": "webpage" });
    const plan = await new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner).plan([record]);
    expect(plan.updates).toHaveLength(1);
  });

  it("round-trips an exported arXiv RSS URL without degrading it to a webpage connector", () => {
    const source = larkSource({ recordId: "rec-arxiv", fields: {
      "Source ID": "SRC-ARXIV-CS-AI", 名称: "arXiv CS.AI", 状态: ["启用"], 来源类型: ["论文"],
      "入口 URL": "https://export.arxiv.org/rss/cs.AI", 来源层级: ["一手来源"], 覆盖领域: ["基础"], 扫描频率: ["每日"],
    } });
    expect(source).toMatchObject({ connector: { type: "rss", config: { url: "https://export.arxiv.org/rss/cs.AI" } } });
  });

  it("round-trips a generic official .rss URL without requiring a select option", () => {
    const source = larkSource({ recordId: "rec-nature", fields: {
      "Source ID": "SRC-NATURE-ML", 名称: "Nature ML", 状态: ["启用"], 来源类型: ["媒体"],
      "入口 URL": "https://www.nature.com/subjects/machine-learning.rss", 来源层级: ["二手来源"], 覆盖领域: ["基础"], 扫描频率: ["每周"],
    } });
    expect(source).toMatchObject({ connector: { type: "rss", config: { url: "https://www.nature.com/subjects/machine-learning.rss" } } });
  });

  it("maps canonical run data to real Chinese Base fields without leaking canonical keys", () => {
    const fields = larkFields({ kind: "runs", id: "RUN-20260811-DAILY", payload: {
      status: "partial", current_stage: "complete", started_at: "2026-08-11T02:00:00Z", completed_at: "2026-08-11T02:05:00Z",
      config_digest: "abcdef1234567890", result_json: JSON.stringify({ outcome: "partial", daily: [{ id: "AI-1" }], review: [] }),
      execution_plan_json: JSON.stringify({ provenance: { coreVersion: "2.0", policyVersion: "1.1" } }),
    } });
    expect(fields).toMatchObject({ "Run ID": "RUN-20260811-DAILY", 状态: "部分成功", 发布状态: "已扣留", 当前阶段: "完成", 工作流版本: "2.0", 评分版本: "1.1", 开始时间: "2026-08-11 10:00:00", 入围数: 1 });
    expect(fields).not.toHaveProperty("run_id");
    expect(larkFields({ kind: "runs", id: "RUN-EMPTY", payload: { status: "empty", publication_state: "published" } })).toMatchObject({ 状态: "健康空结果", 发布状态: "已发布" });
  });

  it("maps recovery receipts to the existing manual-force due-reason option", () => {
    const fields = larkFields({ kind: "receipts", id: "RUN-20260812-DAILY-R01:SRC-X", payload: {
      result: "failed", due_reason: "recovery-of-RUN-20260812-DAILY", attempted_at: "2026-08-12T00:00:00Z",
    } });
    expect(fields["到期原因"]).toBe("人工强制");
  });

  it("maps successful and failed capture metadata to the production Base contract", () => {
    const fields = larkFields({ kind: "captures", id: "CAP-FAILED", payload: {
      source_id: "SRC-X", canonical_url: "https://x.com/example", content_hash: "abc", title: "Example", summary: "",
      captured_at: "2026-08-11T02:00:00Z", raw_json: JSON.stringify({ discoveryUrl: "https://x.com/example", discoveryChannel: "x-api",
        fetchStatus: "failed", extractStatus: "not-attempted", httpStatus: 429, attempts: 3, parserVersion: "1.0.0", failureReason: "HTTP 429" }),
    } });
    expect(fields).toMatchObject({ "Capture ID": "CAP-FAILED", "发现渠道": "X", "抓取状态": "失败", "提取状态": "未尝试", "HTTP 状态码": 429, "尝试次数": 3, "解析器版本": "1.0.0", "失败原因": "HTTP 429" });
    expect(larkFields({ kind: "captures", id: "CAP-SUCCESS", payload: {
      canonical_url: "https://example.com", content_hash: "def", title: "Success", summary: "", captured_at: "2026-08-11T02:00:00Z",
      raw_json: JSON.stringify({ fetchStatus: "success", extractStatus: "success" }),
    } })).toMatchObject({ "抓取状态": "成功", "提取状态": "成功" });
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
    let createdRun: Record<string, unknown> | undefined;
    const runner: LarkRunner = (args) => {
      calls.push(args);
      if (args.includes("+record-list")) {
        const table = args[args.indexOf("--table-id") + 1];
        if (table === tables.sources) return { record_id_list: ["rec_source"], fields: ["Source ID", "名称", "状态", "来源类型", "入口 URL", "来源层级", "覆盖领域", "扫描频率"], data: [["SRC-OPENAI", "OpenAI", ["启用"], ["官网"], "https://openai.com/news/", ["一手来源"], ["模型与产品发布"], ["每日"]]], has_more: false };
        if (table === tables.rules) return { record_id_list: ["rec_rule"], fields: ["Rule ID", "版本", "标题", "状态"], data: [["RULE-WORKFLOW-V1.3", "1.3", "Workflow", ["生效中"]]], has_more: false };
        if (table === tables.runs && createdRun) {
          const fields = Object.keys(createdRun); return { record_id_list: ["rec_run"], fields, data: [fields.map((field) => createdRun![field])], has_more: false };
        }
        return { record_id_list: [], fields: [], data: [], has_more: false };
      }
      if (args.includes("+record-batch-create")) {
        createdRun = (JSON.parse(args[args.indexOf("--json") + 1]!) as { create_records: Array<Record<string, unknown>> }).create_records[0];
        return { record_id_list: ["rec_run"] };
      }
      if (args.includes("+data-query")) return { main_data: [{ count: { value: 0 } }] };
      if (args.includes("+field-list")) return { fields: [] };
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const store = new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner);
    const snapshot = await store.pull();
    expect(snapshot.sources).toHaveLength(1); expect(snapshot.rules).toHaveLength(1);
    const plan = await store.plan([{ kind: "runs", id: "RUN-20260811-DAILY", payload: { status: "success", current_stage: "complete" } }]);
    const result = await store.apply(plan);
    expect(result).toMatchObject({ created: 1, updated: 0, failed: [] });
    const write = calls.find((args) => args.includes("+record-batch-create"));
    expect(write).toBeDefined();
    expect(JSON.parse(write![write!.indexOf("--json") + 1]!)).toMatchObject({ create_records: [{ "Run ID": "RUN-20260811-DAILY", 状态: "成功" }] });
  });

  it("keeps disabled sources in the audit snapshot while excluding them from runnable sources", async () => {
    const runner: LarkRunner = (args) => {
      if (!args.includes("+record-list")) throw new Error(`unexpected call ${args.join(" ")}`);
      const table = args[args.indexOf("--table-id") + 1];
      if (table === tables.sources) return { record_id_list: ["rec_disabled"], fields: ["Source ID", "名称", "状态", "来源类型", "入口 URL", "来源层级", "覆盖领域", "扫描频率"],
        data: [["SRC-DISABLED", "Disabled", ["停用"], ["官网"], "https://example.com/news", ["一手来源"], ["模型"], ["每日"]]], has_more: false };
      return { record_id_list: [], fields: [], data: [], has_more: false };
    };
    const snapshot = await new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner).pull("context");
    expect(snapshot.sources).toEqual([]);
    expect(snapshot.records).toEqual([expect.objectContaining({ kind: "sources", id: "SRC-DISABLED", payload: expect.objectContaining({ enabled: false }) })]);
  });

  it("omits blank historical run integrity numbers instead of inventing a count", async () => {
    const runner: LarkRunner = (args) => {
      if (!args.includes("+record-list")) throw new Error(`unexpected call ${args.join(" ")}`);
      const table = args[args.indexOf("--table-id") + 1];
      if (table === tables.runs) return { record_id_list: ["rec_legacy"], fields: ["Run ID", "状态", "到期来源数"],
        data: [["RUN-LEGACY", "成功", ""]], has_more: false };
      return { record_id_list: [], fields: [], data: [], has_more: false };
    };
    const snapshot = await new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner).pull();
    const legacy = snapshot.records.find((record) => record.kind === "runs" && record.id === "RUN-LEGACY");
    expect(legacy?.payload).not.toHaveProperty("due_source_count");
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

  it("rejects a successful write response when canonical field readback does not match", async () => {
    const runner: LarkRunner = (args) => {
      if (args.includes("+record-batch-create")) return { record_id_list: ["rec_run"] };
      if (args.includes("+field-list")) return { fields: [] };
      if (args.includes("+record-list")) return {
        record_id_list: ["rec_run"], fields: ["Run ID", "状态", "发布状态"],
        data: [["RUN-READBACK", "运行中", "已扣留"]], has_more: false,
      };
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const store = new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner);
    const result = await store.apply({ driver: "lark", creates: [{ kind: "runs", id: "RUN-READBACK", payload: { status: "success", publication_state: "published" } }],
      updates: [], unchanged: [], conflicts: [], digest: "expected" });
    expect(result.acknowledged).toBe(false);
    expect(result.failed).toEqual([{ kind: "runs", id: "RUN-READBACK", detail: expect.stringContaining("readback failed") }]);
  });

  it("rejects a missing select option before the first external record write", async () => {
    const calls: string[][] = [];
    const runner: LarkRunner = (args) => {
      calls.push(args);
      if (args.includes("+field-list")) return { fields: [{ id: "fld_status", name: "状态", type: "select", options: [{ name: "运行中" }] }] };
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const store = new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner);
    await expect(store.apply({ driver: "lark", creates: [{ kind: "runs", id: "RUN-PREFLIGHT", payload: { status: "success" } }],
      updates: [], unchanged: [], conflicts: [], digest: "expected" })).rejects.toThrow("missing options 成功");
    expect(calls.some((args) => args.includes("+record-batch-create") || args.includes("+record-batch-update"))).toBe(false);
  });

  it("treats ignored batch fields as a failed write and stops dependent creates", async () => {
    const writes: string[][] = [];
    const runner: LarkRunner = (args) => {
      if (args.includes("+field-list")) return { fields: [] };
      if (args.includes("+record-batch-create")) {
        writes.push(args); return { record_id_list: ["rec_run"], ignored_fields: ["发布状态"] };
      }
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const store = new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner);
    const result = await store.apply({ driver: "lark", creates: [
      { kind: "runs", id: "RUN-IGNORED", payload: { status: "success" } },
      { kind: "items", id: "AI-SHOULD-NOT-WRITE", payload: { title: "blocked", disposition: "daily" }, links: { runs: ["RUN-IGNORED"] } },
    ], updates: [], unchanged: [], conflicts: [], digest: "expected" });
    expect(result.acknowledged).toBe(false);
    expect(result.failed).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "runs", detail: expect.stringContaining("ignored 1 field") }),
      expect.objectContaining({ kind: "items", detail: expect.stringContaining("stopped before relationship writes") }),
    ]));
    expect(writes).toHaveLength(1);
  });

  it("accepts an eventually consistent readback only after canonical fields match", async () => {
    let reads = 0;
    const runner: LarkRunner = (args) => {
      if (args.includes("+record-batch-create")) return { record_id_list: ["rec_run"] };
      if (args.includes("+field-list")) return { fields: [] };
      if (args.includes("+record-list")) {
        reads += 1;
        return { record_id_list: ["rec_run"], fields: ["Run ID", "状态", "发布状态", "触发类型", "数据源数", "入围数", "发布提交已确认", "Daily 条目数", "Review 条目数", "机器层条目数", "模型失败数", "分析积压数"],
          data: [["RUN-EVENTUAL", reads === 1 ? ["运行中"] : ["成功"], reads === 1 ? ["已扣留"] : ["已发布"], ["定时"], 0, 0, reads > 1, 0, 0, 0, 0, 0]], has_more: false };
      }
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const store = new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner);
    const result = await store.apply({ driver: "lark", creates: [{ kind: "runs", id: "RUN-EVENTUAL", payload: { status: "success", publication_state: "published" } }],
      updates: [], unchanged: [], conflicts: [], digest: "expected" });
    expect(result.acknowledged).toBe(true);
    expect(reads).toBe(2);
  });

  it("reads back touched record IDs directly instead of rescanning the whole table", async () => {
    const calls: string[][] = [];
    const record: CanonicalControlRecord = { kind: "runs", id: "RUN-TARGETED", storeRecordId: "rec_targeted", payload: { status: "success", publication_state: "published" } };
    const expected = larkFields(record);
    const runner: LarkRunner = (args) => {
      calls.push(args);
      if (args.includes("+field-list")) return { fields: [] };
      if (args.includes("+record-get")) {
        const fields = args.flatMap((value, index) => value === "--field-id" ? [args[index + 1]!] : []);
        return { record_id_list: ["rec_targeted"], fields, data: [fields.map((field) => expected[field])], has_more: false };
      }
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const result = await new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner)
      .apply({ driver: "lark", creates: [], updates: [], unchanged: [record], conflicts: [], digest: "targeted" });
    expect(result).toMatchObject({ acknowledged: true, failed: [] });
    expect(calls.some((args) => args.includes("+record-get"))).toBe(true);
    expect(calls.some((args) => args.includes("+record-list"))).toBe(false);
  });

  it("uses the same governed comparison contract for planning and readback", async () => {
    const sourceRecord: CanonicalControlRecord = { kind: "sources", id: "SRC-STABLE", payload: {
      id: "SRC-STABLE", title: "Stable", enabled: true, sourceType: "website", evidenceTier: "primary", coverageDomains: ["基础"],
      connector: { type: "webpage", config: { url: "https://example.com" } },
      scheduleState: { frequency: "daily", lastScanAt: "2026-08-14T01:00:00Z" },
    } };
    const ruleRecord: CanonicalControlRecord = { kind: "rules", id: "RULE-WORKFLOW-V1.3", payload: {
      id: "RULE-WORKFLOW-V1.3", version: "1.3", title: "Internal workflow label",
    } };
    const captureRecord: CanonicalControlRecord = { kind: "captures", id: "CAP-BLANK", payload: {
      canonical_url: "https://example.com/item", content_hash: "blank", title: "Blank summary", summary: "", captured_at: "2026-08-14T02:00:00Z",
      raw_json: JSON.stringify({ fetchStatus: "success", extractStatus: "success" }),
    }, storeRecordId: "rec_capture" };
    const runner: LarkRunner = (args) => {
      if (args.includes("+field-list")) return { fields: [] };
      if (!args.includes("+record-list")) throw new Error(`unexpected call ${args.join(" ")}`);
      const table = args[args.indexOf("--table-id") + 1];
      if (table === tables.sources) {
        const expected = larkFields(sourceRecord); const fields = Object.keys(expected);
        return { record_id_list: ["rec_source"], fields, data: [fields.map((field) => field === "最后扫描" ? "2026-08-13T09:00:00+08:00" : expected[field])], has_more: false };
      }
      if (table === tables.rules) {
        const expected = larkFields(ruleRecord); const fields = Object.keys(expected);
        return { record_id_list: ["rec_rule"], fields, data: [fields.map((field) => field === "标题" ? "面向读者的中文治理标题" : expected[field])], has_more: false };
      }
      if (table === tables.captures) {
        const expected = larkFields(captureRecord); const fields = Object.keys(expected);
        return { record_id_list: ["rec_capture"], fields, data: [fields.map((field) => expected[field] === "" ? null : expected[field])], has_more: false };
      }
      return { record_id_list: [], fields: [], data: [], has_more: false };
    };
    const store = new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner);
    const plan = await store.plan([sourceRecord, ruleRecord]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toHaveLength(2);
    const result = await store.apply({ driver: "lark", creates: [], updates: [], unchanged: [captureRecord], conflicts: [], digest: "expected" });
    expect(result).toMatchObject({ acknowledged: true, failed: [] });
  });

  it("rejects a name-only relationship field with the wrong type before writing records", async () => {
    const calls: string[][] = [];
    const runner: LarkRunner = (args) => {
      calls.push(args);
      if (args.includes("+field-list")) return { fields: [{ id: "fld_run", name: "运行批次", type: "text" }] };
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const store = new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner);
    await expect(store.plan([{ kind: "events", id: "EVT-1", payload: { event_id: "EVT-1" }, links: { runs: ["RUN-1"] } }]))
      .rejects.toThrow("运行批次 has type text");
    expect(calls.some((args) => args.includes("+record-batch-create") || args.includes("+record-batch-update"))).toBe(false);
  });

  it("batches large link backfills and retries only failed records plus new audit records", async () => {
    const eventCount = 450;
    const eventIds = Array.from({ length: eventCount }, (_, index) => `EVT-${String(index).padStart(4, "0")}`);
    const records: CanonicalControlRecord[] = [
      { kind: "runs", id: "RUN-LARGE", payload: { status: "partial", current_stage: "complete" }, links: { events: eventIds } },
      ...eventIds.map((id) => ({ kind: "events" as const, id, payload: { event_id: id, event_type: "test", stage: "complete" }, links: { runs: ["RUN-LARGE"] } })),
    ];
    const recordIds = new Map<string, string>();
    const remoteRows = new Map<string, Map<string, Record<string, unknown>>>();
    const creates: Array<{ table: string; records: Array<Record<string, unknown>> }> = [];
    const batches: Array<{ table: string; records: Record<string, Record<string, unknown>> }> = [];
    let eventBatchOrdinal = 0;
    let failSecondEventBatch = true;
    const runner: LarkRunner = (args) => {
      const table = args[args.indexOf("--table-id") + 1]!;
      if (args.includes("+field-list")) return { fields: [] };
      if (args.includes("+record-batch-create")) {
        const body = JSON.parse(args[args.indexOf("--json") + 1]!) as { create_records: Array<Record<string, unknown>> };
        creates.push({ table, records: body.create_records });
        const ids = body.create_records.map((fields) => {
          const businessId = String(fields[table === tables.runs ? "Run ID" : "Event ID"]);
          const recordId = `rec_${businessId}`; recordIds.set(`${table}\n${businessId}`, recordId);
          const rows = remoteRows.get(table) ?? new Map<string, Record<string, unknown>>(); rows.set(recordId, { ...fields }); remoteRows.set(table, rows); return recordId;
        });
        return { record_id_list: ids };
      }
      if (args.includes("+record-batch-update")) {
        const body = JSON.parse(args[args.indexOf("--json") + 1]!) as { update_records: Record<string, Record<string, unknown>> };
        batches.push({ table, records: body.update_records });
        if (table === tables.events) {
          eventBatchOrdinal += 1;
          if (failSecondEventBatch && eventBatchOrdinal === 2) throw new Error("simulated linked-record batch rejection");
        }
        const rows = remoteRows.get(table) ?? new Map<string, Record<string, unknown>>();
        for (const [recordId, fields] of Object.entries(body.update_records)) rows.set(recordId, { ...(rows.get(recordId) ?? {}), ...fields });
        remoteRows.set(table, rows);
        return {};
      }
      if (args.includes("+record-list")) {
        const requested = args.flatMap((value, index) => value === "--field-id" ? [args[index + 1]!] : []);
        const rows = [...(remoteRows.get(table)?.entries() ?? [])];
        return { record_id_list: rows.map(([recordId]) => recordId), fields: requested,
          data: rows.map(([, fields]) => requested.map((field) => fields[field])), has_more: false };
      }
      throw new Error(`unexpected call ${args.join(" ")}`);
    };
    const store = new LarkControlPlaneStore({ baseToken: "base", identity: "user", tables }, runner);
    const initialPlan: SyncPlan = { driver: "lark", creates: records, updates: [], unchanged: [], conflicts: [], digest: "initial" };
    const initial = await store.apply(initialPlan);

    expect(initial.failed).toHaveLength(200);
    expect(creates.map(({ table, records: entries }) => [table, entries.length])).toEqual([
      [tables.runs, 1], [tables.events, 200], [tables.events, 200], [tables.events, 50],
    ]);
    expect(creates.every(({ records: entries }) => entries.every((fields) => !Object.keys(fields).some((field) => ["状态事件", "运行批次"].includes(field))))).toBe(true);
    expect(batches.map(({ table, records: entries }) => [table, Object.keys(entries).length])).toEqual([
      [tables.runs, 1], [tables.events, 200], [tables.events, 200], [tables.events, 50],
    ]);

    const withStoreIds = records.map((record) => ({ ...record, storeRecordId: recordIds.get(`${tables[record.kind]}\n${record.id}`)! }));
    const audit: CanonicalControlRecord = { kind: "events", id: "EVT-AUDIT", payload: { event_id: "EVT-AUDIT", event_type: "control-plane.partial", stage: "persist" }, links: { runs: ["RUN-LARGE"] } };
    const changedRun = { ...withStoreIds[0]!, payload: { ...withStoreIds[0]!.payload, status: "partial" }, links: { events: [...eventIds, audit.id] } };
    const retryRecords = reconciliationRecords([changedRun, ...withStoreIds.slice(1), audit], records, initial.failed);
    expect(retryRecords).toHaveLength(202);
    expect(retryRecords.filter((record) => ![audit.id, "RUN-LARGE"].includes(record.id)).every((record) => initial.failed.some((failed) => failed.kind === record.kind && failed.id === record.id))).toBe(true);

    failSecondEventBatch = false;
    eventBatchOrdinal = 0;
    const failedKeys = new Set(initial.failed.map((failed) => `${failed.kind}\n${failed.id}`));
    const retryPlan: SyncPlan = { driver: "lark", creates: [audit], updates: [changedRun], unchanged: retryRecords.filter((record) => failedKeys.has(`${record.kind}\n${record.id}`)), conflicts: [], digest: "retry",
      linkTargets: {
        runs: { "RUN-LARGE": recordIds.get(`${tables.runs}\nRUN-LARGE`)! },
        events: Object.fromEntries(eventIds.map((id) => [id, recordIds.get(`${tables.events}\n${id}`)!])),
      } };
    const createsBeforeRetry = creates.length;
    const batchesBeforeRetry = batches.length;
    const retry = await store.apply(retryPlan);

    expect(retry.failed).toEqual([]);
    expect(creates).toHaveLength(createsBeforeRetry + 1);
    expect(batches.slice(batchesBeforeRetry).map(({ records: entries }) => Object.keys(entries).length)).toEqual([1, 200, 1, 1]);
  });
});
