import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { EffectiveConfig } from "../config/types.js";
import { configDigest, packagedProtocolPath } from "../config/load.js";
import { runtimeTreeDigest } from "../runtime-integrity.js";

export const CODEX_AUTOMATION_PROMPT_LIMIT = 2_200;

function rrule(schedule: EffectiveConfig["schedule"]): string {
  if (schedule === "daily-at-10") return "FREQ=DAILY;BYHOUR=10;BYMINUTE=0;BYSECOND=0";
  if (schedule === "weekdays-at-09") return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0";
  throw new Error("Schedule is manual. Choose a recurring schedule before exporting a Codex automation.");
}

function enclosingGitCheckout(filePath: string): string | undefined {
  let current = path.dirname(path.resolve(filePath));
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function codexAutomationDefinition(config: EffectiveConfig, configPath: string) {
  const absolute = path.resolve(configPath); const fileDigest = createHash("sha256").update(await readFile(absolute)).digest("hex");
  const executionDigest = configDigest(config);
  const runtimeDigest = await runtimeTreeDigest();
  const contractPath = packagedProtocolPath(); const contractDigest = createHash("sha256").update(await readFile(contractPath)).digest("hex");
  const cliPath = path.resolve(process.argv[1]!); const cliDigest = createHash("sha256").update(await readFile(cliPath)).digest("hex");
  const checkoutRoot = enclosingGitCheckout(cliPath);
  const runtime = checkoutRoot
    ? { immutable: false, sourceCheckout: checkoutRoot, warning: "The exported CLI is inside a mutable Git checkout. Install a released package in a versioned runtime directory and export again before production scheduling." }
    : { immutable: true };
  const sourceValidator = config.sourceContract
    ? path.join(config.documents.root, "Inbox/AI Intelligence/Tools/validate-rule-contract.mjs")
    : undefined;
  const prompt = [
    "你在独立任务运行 Briefwright；不要依赖历史会话。",
    `cwd: ${config.projectRoot}`,
    `node: ${process.execPath}`,
    `config: ${absolute}`,
    `config_sha256: ${fileDigest}`,
    `execution_config_digest: ${executionDigest}`,
    `cli: ${cliPath}`,
    `cli_sha256: ${cliDigest}`,
    `runtime_digest: ${runtimeDigest}`,
    `protocol: ${contractPath}`,
    `protocol_sha256: ${contractDigest}`,
    ...(config.sourceContract ? [`source_contract: ${config.sourceContract.path}`, `contract_sha256: ${config.sourceContract.sha256}`] : []),
    "1. 核对以上 SHA-256、capabilities.runtimeDigest、config render 的 effectiveConfig.digest；任一不符立即失败且零写入。",
    ...(sourceValidator ? [`validator: ${sourceValidator}`, "2. 前置运行 NODE VALIDATOR。"] : []),
    "3. 运行 NODE CLI --json capture manifest --config CONFIG。",
    "4. manifest 有来源才只读采集：codex-browser 仅公开 X；captureMode=in-app-browser 用隔离 Codex Browser，不能接管 Chrome/桌面；captureMode=computer-use 仅本地 App/UI。严格限 entryUrl/allowedHosts；禁止登录、输入、下载、互动、改设置、读私密内容。",
    "5. 写 manifest.bundlePath 的 v1 bundle；每源 captured/unchanged/failed，captureMode 须匹配 manifest。publishedAt 配 dateKind=event 或 page-updated，仅 event 算事件时间。只用当次可见证据，禁止虚构；零来源不建 bundle。",
    "6. 有 bundle 才运行 NODE CLI --json capture validate <bundle> --config CONFIG。",
    "7. 运行 NODE CLI --json doctor --online --config CONFIG。",
    "8. blocking checks 通过后运行 run；有 bundle 加 --capture-bundle <bundle>，并始终带 --config CONFIG。",
    ...(sourceValidator ? ["9. 后置再次运行 NODE VALIDATOR。"] : []),
    "只返回 completionReport、产物路径、失败 Source/Rule ID、存储校验；不返回原文、完整响应、secret、worker 日志。空产物合法。",
  ].join("\n");
  if (prompt.length > CODEX_AUTOMATION_PROMPT_LIMIT) {
    throw new Error(`Codex automation prompt is ${prompt.length} characters; limit is ${CODEX_AUTOMATION_PROMPT_LIMIT}. Shorten the project, config, runtime, or contract paths before exporting.`);
  }
  return { kind: "cron", name: config.name, status: "ACTIVE", rrule: rrule(config.schedule), executionEnvironment: "local", cwd: config.projectRoot, independentTask: true, notificationPolicy: "failed_runs_only", prompt, runtime,
    configDigest: executionDigest, configFileDigest: fileDigest, cliPath, cliDigest, runtimeDigest, contractPath, contractDigest, ...(config.sourceContract ? { sourceContractPath: config.sourceContract.path, sourceContractDigest: config.sourceContract.sha256 } : {}) };
}
