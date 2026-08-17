import type { LarkFieldDefinition } from "./lark-cli.js";
import type { ControlEntityKind } from "./types.js";

const options = (...names: string[]) => names.map((name) => ({ name }));
const domains = ["基础", "机器学习与深度学习", "模型与生成式 AI", "数据与知识", "系统与工程", "安全与治理", "应用域", "Agent"];

export const LARK_FIELD_MANIFEST_VERSION = "briefwright-lark-v2";

export interface LarkManifestField extends LarkFieldDefinition {
  target?: ControlEntityKind;
}

const text = (name: string): LarkManifestField => ({ name, type: "text" });
const number = (name: string): LarkManifestField => ({ name, type: "number" });
const datetime = (name: string): LarkManifestField => ({ name, type: "datetime" });
const checkbox = (name: string): LarkManifestField => ({ name, type: "checkbox" });
const select = (name: string, values: string[] = [], multiple = false): LarkManifestField => ({ name, type: "select", multiple, ...(values.length ? { options: options(...values) } : {}) });
const link = (name: string, target: ControlEntityKind): LarkManifestField => ({ name, type: "link", target });

/**
 * The sole schema contract for the nine Briefwright Base tables. Provisioning,
 * diagnostics, projections, readback and regression tests all consume this map.
 */
export const LARK_FIELD_MANIFEST: Record<ControlEntityKind, readonly LarkManifestField[]> = {
  sources: [
    text("Source ID"), text("名称"), select("状态", ["启用", "停用"]),
    select("来源类型", ["官网", "官方博客", "官方文档", "GitHub", "X", "论文", "监管与标准", "媒体", "其他"]),
    text("入口 URL"), select("采集方式", ["RSS", "GitHub Releases", "Webpage", "X API", "Computer Use", "Codex Browser", "Extension"]),
    text("采集域名"), select("来源层级", ["一手来源", "二手来源", "发现线索"]), select("覆盖领域", domains, true),
    select("扫描频率", ["每日", "每周", "按需"]), number("优先级"), datetime("最后扫描"), datetime("最后成功"), datetime("最后有效更新"),
    datetime("下次扫描"), select("调度状态", ["自动", "人工锁定"]),
    select("连接器类型", ["rss", "github-releases", "webpage", "x-api", "codex-browser", "in-app-browser", "computer-use", "extension"]),
    text("连接器版本"), text("连接器配置（脱敏）"), text("配置摘要"), number("最小扫描间隔小时"), number("当前扫描间隔小时"), number("最大扫描间隔小时"),
    text("游标摘要"), datetime("最近失败时间"), text("最近错误码"), text("最近失败详情"), text("最近响应指纹"),
    number("30天扫描数"), number("30天失败数"), number("30天更新数"), number("30天入围数"), text("节奏调整建议"), text("节奏建议依据"),
  ],
  runs: [
    text("Run ID"), select("状态", ["运行中", "部分成功", "成功", "失败", "健康空结果", "已遗弃"]),
    select("发布状态", ["已发布", "已扣留"]), select("当前阶段", ["初始化", "冻结到期清单", "发现", "抓取", "写回执", "标准化", "去重", "分析", "证据核验", "评分", "选择", "渲染", "校验产物", "同步进程存储", "提交发布", "完成", "已遗弃"]),
    select("触发类型", ["定时", "手动", "重跑"]), select("运行类型", ["preview", "formal", "formal-retry"]), select("运行模式", ["fixture", "live"]),
    text("工作流版本"), text("评分版本"), datetime("开始时间"), datetime("结束时间"), text("Obsidian 简报"), text("Daily 路径"), text("Review 路径"), text("质量说明"),
    number("数据源数"), number("入围数"), number("到期来源数"), text("到期清单摘要"), text("日报摘要"), text("待复核摘要"),
    text("配置摘要"), text("策略摘要"), text("提示词摘要"), text("来源清单摘要"), text("协议合同摘要"), text("执行计划摘要"), text("执行计划 JSON"),
    text("运行时版本"), text("运行时摘要"), checkbox("进程存储已确认"), text("远端读回 Revision"), text("远端读回摘要"), checkbox("发布提交已确认"),
    checkbox("规则合同有效"), checkbox("文档存储有效"), text("完成报告 JSON"),
    number("更新来源数"), number("无变化来源数"), number("失败来源数"), number("跳过来源数"), number("缺失回执数"), text("缺失 Source IDs"),
    number("Daily 条目数"), number("Review 条目数"), number("机器层条目数"), number("模型失败数"), text("模型失败明细"), number("分析积压数"), text("分析积压明细"),
    text("阶段耗时 JSON"), text("产物阶段耗时 JSON"), text("领域计数 JSON"), text("Top Item IDs"),
    text("执行 Owner"), datetime("Lease 到期"), datetime("最近心跳"), text("Fencing Token"), text("中止遗弃原因"),
    link("父运行批次", "runs"), link("到期来源", "sources"), link("发现条目", "items"), link("原始采集", "captures"), link("状态事件", "events"), link("扫描回执", "receipts"), link("使用规则", "rules"), link("人工反馈", "feedback"),
  ],
  items: [
    text("Item ID"), text("标题"), select("当前状态", ["已生成简报", "人工复核", "已淘汰"]), select("处置结果", ["daily", "review", "machine-only"]),
    text("Canonical URL"), text("Canonical Identity"), text("Capture Hash"), datetime("抓取时间"), datetime("页面更新时间"), text("中文摘要"), text("为什么值得关注"),
    select("主领域", domains), select("证据状态", ["已确认", "部分确认", "待原始来源确认"]), number("总分"), text("评分版本"),
    text("主张 JSON"), text("主张证据 JSON"), text("七维评分详情 JSON"), text("各维度评分理由 JSON"), text("知识潜力 JSON"), text("淘汰原因集合"), text("Daily 排除原因集合"),
    select("分析状态", ["成功", "失败", "待处理", "跳过"]), text("模型 Provider"), text("模型名称"), text("Prompt 版本"), datetime("分析时间"), number("分析耗时毫秒"), number("输入 Token"), number("输出 Token"), number("已知成本"),
    text("条目快照摘要"), select("新鲜度判定", ["新鲜", "过期", "未来时间", "未知"]), select("日期语义", ["event", "page-updated", "unknown"]),
    link("发现批次", "runs"), link("来源", "sources"), link("原始采集", "captures"), link("评分规则", "rules"), link("状态事件", "events"),
  ],
  events: [
    text("Event ID"), datetime("事件时间"), text("所属阶段"), text("事件类型"), select("实体类型", ["run", "source", "capture", "item", "rule", "experiment"]), text("实体 ID"), text("完整载荷 JSON"),
    number("运行内序号"), text("事件 Schema 版本"), text("关联事件 ID"), number("持续时间毫秒"), select("严重级别", ["debug", "info", "warning", "error", "critical"]),
    select("原状态"), select("新状态"), select("执行者"), text("迁移原因"), text("Rule ID 快照"), text("幂等键"), text("载荷指纹"), number("尝试次数"), text("错误码"), text("事件详情"),
    link("运行批次", "runs"), link("情报条目", "items"), link("规则记录", "rules"), link("相关实验", "experiments"),
  ],
  feedback: [
    text("Feedback ID"), datetime("反馈时间"), select("判断", ["纳入", "略过", "复核", "比较", "纠正分类", "纠正评分", "纠正来源", "流程反馈"]), select("原因标签", ["include", "skip", "review", "compare", "classification-correction", "score-correction", "source-correction", "process-feedback"]), text("反馈说明"), number("价值评分"), text("整合目标"),
    select("反馈类型", ["include", "skip", "review", "compare", "classification-correction", "score-correction", "source-correction", "process-feedback"]), text("目标字段"), text("原值 JSON"), text("建议值 JSON"),
    select("处理状态", ["待处理", "已接受", "已拒绝", "已应用"]), datetime("处理时间"), text("处理人"), text("处理结果决议"), text("幂等键"), text("载荷指纹"), select("反馈来源渠道", ["briefing", "cli", "feishu", "import", "system"]),
    link("情报条目", "items"), link("运行批次", "runs"), link("相关实验", "experiments"),
  ],
  experiments: [
    text("Experiment ID"), text("标题"), select("状态", ["候选", "已评估", "已批准", "运行中", "已回滚", "已拒绝"]), text("观察到的问题"), text("假设"), select("变更类型"),
    text("基线 Rule IDs"), text("候选 Rule IDs"), text("实验指标"), text("实验结论"), text("回滚条件"), select("审批结果", ["待审批", "已批准", "已拒绝"]),
    text("基线策略摘要"), text("候选策略摘要"), text("样本摘要"), text("基线策略 JSON"), text("候选策略 JSON"), text("样本 JSON"), text("指标结果 JSON"), text("Guardrail 结果 JSON"),
    number("评审条目数"), number("观察天数"), checkbox("14天门槛通过"), checkbox("50条评审门槛通过"), datetime("批准时间"), datetime("激活时间"), datetime("回滚时间"), text("决策理由"), text("实验 Revision"),
    link("基线规则", "rules"), link("候选规则", "rules"),
  ],
  captures: [
    text("Capture ID"), text("External Key"), text("发现 URL"), text("最终 URL"), text("Canonical 候选 URL"), select("发现渠道", ["官网巡检", "X", "GitHub", "论文索引", "监管与标准入口", "其他"]), datetime("发现时间"), datetime("抓取时间"),
    select("抓取状态", ["成功", "失败", "访问受限", "等待重试", "隔离"]), select("提取状态", ["成功", "失败", "未尝试", "无需提取"]), number("HTTP 状态码"), number("尝试次数"), text("内容类型"), text("语言"), text("原始标题"), text("原始作者或机构"),
    text("发布日期原值"), datetime("标准化发布时间"), datetime("页面更新时间"), text("页面更新时间原值"), text("事件日期原值"), select("证据类别", ["primary", "secondary"]), select("日期语义", ["event", "page-updated", "unknown"]),
    text("ETag"), text("Last-Modified"), text("短摘录"), text("内容哈希"), text("载荷指纹"), text("解析器版本"), text("失败原因"),
    select("连接器类型", ["rss", "github-releases", "webpage", "x-api", "codex-browser", "in-app-browser", "computer-use", "extension"]), text("连接器版本"), text("恢复自内容哈希"), text("Capture Bundle ID"), text("Bundle 摘要"), text("Capture Manifest 摘要"),
    number("抓取耗时毫秒"), text("外部请求 ID"), text("重定向链 JSON"), number("内容长度"), text("原始载荷摘要"), text("原始载荷 Schema 版本"), text("原始快照"), text("保留策略"), text("解析结果 JSON"),
    link("运行批次", "runs"), link("数据源", "sources"), link("情报条目", "items"),
  ],
  rules: [
    text("Rule ID"), text("版本"), text("标题"), select("规则类型"), select("状态", ["生效中", "候选", "已退役", "已回滚"]), text("规则说明"), text("配置 JSON"), text("校验和"), text("回滚目标版本"),
    text("Policy ID"), text("Policy 版本"), text("Policy 摘要"), select("规则来源", ["packaged", "project", "human", "experiment"]), text("Rule Schema 版本"), checkbox("人工锁定"), text("不可变 Revision"), text("Runtime 兼容范围"),
    text("依赖 Rule IDs"), text("依赖 Prompt Pack"), text("Guardrail JSON"), text("退役原因"), text("批准人"), datetime("批准时间"), text("生效条件"), text("阈值 JSON"), text("权重 JSON"),
    link("父规则替代规则", "rules"), link("回滚目标规则", "rules"),
  ],
  receipts: [
    text("Scan ID"), select("扫描结果", ["有更新", "已观察", "无更新", "失败", "跳过"]), select("到期原因", ["每日到期", "每周到期", "首次基线", "覆盖缺口", "人工强制"]), datetime("应扫描时间"), datetime("开始时间"), datetime("结束时间"),
    text("工作流版本"), text("错误与说明"), number("发现 URL 数"), number("新内容数"), number("标准化事件数"), number("入围数"), number("耗时毫秒"), select("执行通道", ["官网与文档", "GitHub", "论文与监管", "中国厂商", "X"]), text("响应指纹"),
    number("尝试次数"), text("错误码"), select("连接器类型", ["rss", "github-releases", "webpage", "x-api", "codex-browser", "in-app-browser", "computer-use", "extension"]), text("连接器版本"), text("游标前摘要"), text("游标后摘要"), checkbox("是否可重试"), datetime("下次重试时间"), text("外部请求 ID"), text("到期清单摘要"), text("请求载荷摘要"), text("结构化详情 JSON"), datetime("来源有效更新时间"), number("HTTP 状态"), text("扫描频率"),
    link("运行批次", "runs"), link("数据源", "sources"), link("工作流规则", "rules"),
  ],
};

export const LARK_ID_FIELDS: Record<ControlEntityKind, string> = {
  sources: "Source ID", runs: "Run ID", items: "Item ID", events: "Event ID", feedback: "Feedback ID",
  experiments: "Experiment ID", captures: "Capture ID", rules: "Rule ID", receipts: "Scan ID",
};

export const LARK_SCALAR_FIELDS: Record<ControlEntityKind, LarkFieldDefinition[]> = Object.fromEntries(
  Object.entries(LARK_FIELD_MANIFEST).map(([kind, fields]) => [kind, fields.filter((field) => field.type !== "link").map(({ target: _target, ...field }) => field)]),
) as Record<ControlEntityKind, LarkFieldDefinition[]>;

export const LARK_LINK_FIELDS: Partial<Record<ControlEntityKind, Array<{ name: string; target: ControlEntityKind }>>> = Object.fromEntries(
  Object.entries(LARK_FIELD_MANIFEST).map(([kind, fields]) => [kind, fields.flatMap((field) => field.type === "link" && field.target ? [{ name: field.name, target: field.target }] : [])]),
) as Partial<Record<ControlEntityKind, Array<{ name: string; target: ControlEntityKind }>>>;
