import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { EffectiveConfig } from "../config/types.js";
import { packagedProtocolPath } from "../config/load.js";

function rrule(schedule: EffectiveConfig["schedule"]): string {
  if (schedule === "daily-at-10") return "FREQ=DAILY;BYHOUR=10;BYMINUTE=0;BYSECOND=0";
  if (schedule === "weekdays-at-09") return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0";
  throw new Error("Schedule is manual. Choose a recurring schedule before exporting a Codex automation.");
}

export async function codexAutomationDefinition(config: EffectiveConfig, configPath: string) {
  const absolute = path.resolve(configPath); const fileDigest = createHash("sha256").update(await readFile(absolute)).digest("hex");
  const contractPath = packagedProtocolPath(); const contractDigest = createHash("sha256").update(await readFile(contractPath)).digest("hex");
  const cliPath = path.resolve(process.argv[1]!); const cliDigest = createHash("sha256").update(await readFile(cliPath)).digest("hex");
  const browserCapture = config.controlPlane.lark?.xCapture === "codex-browser";
  const sourceValidator = config.sourceContract
    ? path.join(config.documents.root, "Inbox/AI Intelligence/Tools/validate-rule-contract.mjs")
    : undefined;
  const prompt = [
    "你正在独立任务中运行 Briefwright。不要依赖历史会话或聊天摘要推断规则和状态。",
    `cwd: ${config.projectRoot}`,
    `node: ${process.execPath}`,
    `config: ${absolute}`,
    `config_sha256: ${fileDigest}`,
    `cli: ${cliPath}`,
    `cli_sha256: ${cliDigest}`,
    `protocol: ${contractPath}`,
    `protocol_sha256: ${contractDigest}`,
    ...(config.sourceContract ? [`source_contract: ${config.sourceContract.path}`, `contract_sha256: ${config.sourceContract.sha256}`] : []),
    "1. 先计算并核对以上全部 SHA-256；任一不符立即失败且不得写入。",
    ...(sourceValidator ? [`validator: ${sourceValidator}`, "2. 前置运行 NODE VALIDATOR。"] : []),
    ...(browserCapture ? [
      "3. 运行 NODE CLI --json capture manifest --config CONFIG。",
      "4. 仅当 manifest 有来源时，用浏览器只读查看所列公开 X 账号；禁止互动、设置变更和私密内容。按 manifest.bundlePath 写 v1 bundle，每源必须 captured/unchanged/failed，禁止虚构。零来源不建 bundle。",
      "5. 有 bundle 才运行 NODE CLI --json capture validate <bundle> --config CONFIG。",
      "6. 运行 NODE CLI --json doctor --online --config CONFIG。",
      "7. blocking checks 通过后，有 bundle 运行 NODE CLI --json run --capture-bundle <bundle> --config CONFIG；否则运行 NODE CLI --json run --config CONFIG。",
    ] : [
      "3. 运行 NODE CLI --json doctor --online --config CONFIG。",
      "4. blocking checks 通过后运行 NODE CLI --json run --config CONFIG。",
    ]),
    ...(sourceValidator ? ["8. 后置再次运行 NODE VALIDATOR。"] : []),
    "只返回有界 completionReport、产物路径、失败 Source ID、Rule ID 及存储校验；不返回原文、完整响应、secret 或 worker 日志。空 Daily/Review 合法。",
  ].join("\n");
  return { kind: "cron", name: config.name, status: "ACTIVE", rrule: rrule(config.schedule), executionEnvironment: "local", cwd: config.projectRoot, independentTask: true, notificationPolicy: "failed_runs_only", prompt,
    configDigest: fileDigest, cliPath, cliDigest, contractPath, contractDigest, ...(config.sourceContract ? { sourceContractPath: config.sourceContract.path, sourceContractDigest: config.sourceContract.sha256 } : {}) };
}
