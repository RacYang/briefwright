import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import formatsModule, { type FormatsPlugin } from "ajv-formats";
import { parse } from "yaml";

import { assertSafeReadPath, resolveWithinRoot } from "./paths.js";
import type {
  BriefingIntent,
  EffectiveConfig,
  PolicyDefinition,
  PresetDefinition,
  PromptPackDefinition,
  ProtocolDefinition,
  ProviderDefinition,
} from "./types.js";
import { applyAdvancedResources } from "./advanced.js";
import { ConfigurationError } from "./errors.js";
import { validatePolicy } from "./policy.js";

export { ConfigurationError } from "./errors.js";
export { validatePolicy } from "./policy.js";

const CORE_VERSION = "1.0.0";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packagedProtocolFile = path.join(packageRoot, "protocol/ai-intelligence-contract.v1.json");
const packagedProtocolText = readFileSync(packagedProtocolFile, "utf8");
const PACKAGED_PROTOCOL = JSON.parse(packagedProtocolText) as ProtocolDefinition;
const addFormats = formatsModule as unknown as FormatsPlugin;
const validatedRuntimeDigests = new Set<string>();

function formatProblem(error: ErrorObject): string {
  const location = error.instancePath || "configuration";
  if (error.keyword === "additionalProperties") {
    const property = String(error.params.additionalProperty);
    return `${location} contains unknown field '${property}'`;
  }
  return `${location} ${error.message ?? "is invalid"}`;
}

export interface IntentMigrationResult {
  intent: BriefingIntent;
  fromVersion: number;
  changed: boolean;
}

export async function migrateIntentDocument(document: unknown): Promise<IntentMigrationResult> {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ConfigurationError("Briefwright configuration must be a mapping");
  }
  const input = structuredClone(document) as Record<string, unknown>;
  const fromVersion = Number(input.version);
  if (fromVersion === 1 || fromVersion === 2) {
    input.version = 3;
    input.model = input.ai ?? "qwen";
    delete input.ai;
    input.processStore ??= "sqlite";
    input.documentStore ??= "local";
    return { intent: input as unknown as BriefingIntent, fromVersion, changed: true };
  }
  if (fromVersion === 3) {
    if ("ai" in input) throw new ConfigurationError("briefing.yaml version 3 uses 'model', not the removed 'ai' field");
    return { intent: input as unknown as BriefingIntent, fromVersion: 3, changed: false };
  }
  throw new ConfigurationError(`Unsupported briefing.yaml version: ${String(input.version)}`, [
    "Supported versions are 1, 2, and 3; downgrades and unknown future versions are not automatic",
  ]);
}

export async function parseIntentWithMigration(configPath: string): Promise<IntentMigrationResult> {
  await assertSafeReadPath(path.dirname(configPath), configPath);
  const [schemaText, configText] = await Promise.all([
    readFile(path.join(packageRoot, "schemas/briefing.schema.json"), "utf8"),
    readFile(configPath, "utf8"),
  ]);
  const schema = JSON.parse(schemaText) as object;
  let document: unknown;
  try {
    document = parse(configText);
  } catch (error) {
    throw new ConfigurationError(
      `Unable to parse Briefwright configuration at ${configPath}`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);

  if (!validate(document)) {
    const problems = (validate.errors ?? []).map(formatProblem);
    throw new ConfigurationError(`Invalid Briefwright configuration at ${configPath}`, problems);
  }

  const migrated = await migrateIntentDocument(document);
  const validated = migrated.intent as Pick<BriefingIntent, "version" | "name" | "interests"> &
    Partial<BriefingIntent>;
  return { ...migrated, intent: {
    version: 3,
    name: validated.name,
    preset: validated.preset ?? "ai-daily",
    interests: validated.interests,
    schedule: validated.schedule ?? "manual",
    output: validated.output ?? "markdown",
    outputDirectory: validated.outputDirectory ?? "briefs",
    ...(validated.sourceContract ? { sourceContract: validated.sourceContract } : {}),
    model: validated.model ?? "qwen",
    processStore: validated.processStore ?? "auto",
    documentStore: validated.documentStore ?? "auto",
  } };
}

export async function parseIntent(configPath: string): Promise<BriefingIntent> {
  return (await parseIntentWithMigration(configPath)).intent;
}

export async function loadEffectiveConfig(configPath: string): Promise<EffectiveConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const projectRoot = path.dirname(absoluteConfigPath);
  const intent = await parseIntent(absoluteConfigPath);
  const resources = await loadPackagedRuntime(intent);
  let effective = await applyAdvancedResources(buildEffectiveConfig(projectRoot, intent, resources.preset, resources.policy, resources.prompts, resources.provider, resources.protocol, "packaged"));
  if (intent.sourceContract) effective = await bindSourceContract(effective, intent.sourceContract);
  try {
    const activePolicyPath = path.join(projectRoot, ".briefwright/active-policy.json");
    await assertSafeReadPath(projectRoot, activePolicyPath);
    const policy = JSON.parse(await readFile(activePolicyPath, "utf8")) as PolicyDefinition;
    validatePolicy(policy);
    effective.policy = policy;
    effective.provenance.policyOrigin = "approved-experiment";
    effective.provenance.policyVersion = policy.version;
    effective.origins.policy = ".briefwright/active-policy.json";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  validateEffectiveConfig(effective);
  return effective;
}

async function bindSourceContract(config: EffectiveConfig, reference: NonNullable<BriefingIntent["sourceContract"]>): Promise<EffectiveConfig> {
  const source = path.resolve(config.projectRoot, reference.path); const content = await readFile(source, "utf8");
  const actualDigest = createHash("sha256").update(content).digest("hex");
  if (actualDigest !== reference.sha256) throw new ConfigurationError("Source execution contract digest does not match briefing.yaml", [`expected ${reference.sha256}`, `actual ${actualDigest}`]);
  let contract: Record<string, unknown>; try { contract = JSON.parse(content) as Record<string, unknown>; } catch { throw new ConfigurationError("Source execution contract is not valid JSON"); }
  const identity = contract.identity_contract as { active_rules?: Array<{ rule_id?: unknown }> } | undefined;
  const activeRuleIds = (identity?.active_rules ?? []).map((rule) => rule.rule_id).filter((id): id is string => typeof id === "string").sort();
  const expectedRuleIds = config.policy.rules.map((rule) => rule.id).sort();
  const systems = contract.systems as { obsidian_root?: unknown; base_token?: unknown; tables?: Record<string, unknown> } | undefined;
  const outputs = contract.obsidian_outputs as { daily_path?: unknown; review_path?: unknown; forbidden_writes?: unknown } | undefined;
  const problems: string[] = [];
  if (contract.contract_id !== config.protocol.contractId) problems.push("contract_id does not match the packaged execution protocol");
  if (activeRuleIds.join("\n") !== expectedRuleIds.join("\n")) problems.push("active Rule IDs do not match the packaged policy");
  if (systems?.obsidian_root !== config.documents.root) problems.push("Obsidian root does not match the configured document store");
  if (config.controlPlane.driver === "lark" && config.controlPlane.lark) {
    if (systems?.base_token !== config.controlPlane.lark.baseToken) problems.push("Lark Base token does not match the configured process store");
    for (const [kind, table] of Object.entries(config.controlPlane.lark.tables)) if (systems?.tables?.[kind] !== table) problems.push(`Lark table mapping does not match for ${kind}`);
  }
  if (outputs?.daily_path !== "Inbox/AI Intelligence/Daily/YYYY-MM-DD-AI情报简报.md" || outputs?.review_path !== "Inbox/AI Intelligence/Review/YYYY-MM-DD-AI情报待复核.md") problems.push("source contract document paths do not match the supported Daily/Review layout");
  if (!contract.run_contract || !contract.due_manifest || !contract.capture_contract || !contract.feedback_and_improvement || !contract.completion_report) problems.push("source contract is missing a required workflow, evidence, improvement, or completion section");
  if (problems.length) throw new ConfigurationError("Source execution contract is incompatible with this Briefwright configuration", problems);
  return { ...config, sourceContract: { path: source, sha256: actualDigest }, provenance: { ...config.provenance, sourceContractDigest: actualDigest }, origins: { ...config.origins, sourceContract: source } };
}

export async function loadPackagedRuntime(intent: BriefingIntent): Promise<{
  preset: PresetDefinition;
  policy: PolicyDefinition;
  prompts: PromptPackDefinition;
  provider: ProviderDefinition;
  protocol: ProtocolDefinition;
}> {
  const legacyAi = (intent as unknown as { ai?: string }).ai;
  const [preset, policy, prompts, provider] = await Promise.all([
    loadPreset(intent.preset),
    loadPackagedJson<PolicyDefinition>("policies/ai-intelligence-v1.json"),
    loadPackagedJson<PromptPackDefinition>("prompts/ai-intelligence-v1.json"),
    loadProviderDefinition(intent.model ?? legacyAi ?? "qwen"),
  ]);
  return { preset, policy, prompts, provider, protocol: structuredClone(PACKAGED_PROTOCOL) };
}

async function loadProviderDefinition(intent: BriefingIntent["model"]): Promise<ProviderDefinition> {
  const requested = typeof intent === "string" ? { provider: intent } : intent;
  let packaged: ProviderDefinition | undefined;
  try {
    packaged = await loadPackagedJson<ProviderDefinition>(`providers/${requested.provider}.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!packaged && (!requested.protocol || !requested.model || !requested.baseUrl)) {
    throw new ConfigurationError(`Unknown model provider '${requested.provider}'`, [
      "Use a bundled provider ID or specify protocol, model, baseUrl, allowedHosts, and an optional apiKey",
    ]);
  }
  const base = packaged ?? {
    id: requested.provider,
    version: "1.0.0",
    protocol: requested.protocol!,
    model: requested.model!,
    baseUrl: requested.baseUrl!,
    timeoutSeconds: 60,
    retries: 2,
    endpointPolicy: { allowedHosts: requested.allowedHosts ?? [] },
  };
  const baseUrl = requested.baseUrl ?? base.baseUrl;
  return {
    ...base,
    id: requested.provider,
    ...(requested.protocol ? { protocol: requested.protocol } : {}),
    ...(requested.model ? { model: requested.model } : {}),
    ...(requested.reasoningEffort ? { reasoningEffort: requested.reasoningEffort } : {}),
    baseUrl,
    ...(requested.apiKey ? { apiKey: requested.apiKey } : {}),
    endpointPolicy: {
      allowedHosts: requested.allowedHosts ?? base.endpointPolicy.allowedHosts,
      ...(base.endpointPolicy.allowedHostSuffixes ? { allowedHostSuffixes: base.endpointPolicy.allowedHostSuffixes } : {}),
      ...(requested.allowInsecureLocalhost ?? base.endpointPolicy.allowInsecureLocalhost
        ? { allowInsecureLocalhost: requested.allowInsecureLocalhost ?? base.endpointPolicy.allowInsecureLocalhost }
        : {}),
    },
  };
}

async function loadPackagedJson<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(path.join(packageRoot, relativePath), "utf8")) as T;
}

function validatePackagedResources(
  policy: PolicyDefinition,
  prompts: PromptPackDefinition,
  provider: ProviderDefinition,
  bundled = true,
): void {
  const validationDigest = createHash("sha256").update(canonicalJson({ policy, prompts, provider, bundled })).digest("hex");
  if (validatedRuntimeDigests.has(validationDigest)) return;
  const problems: string[] = [];
  try { validatePolicy(policy); } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  try {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(prompts.outputSchema);
    const validProbe = {
      summary: "summary", whyItMatters: "reason", domain: "Agent", claims: ["claim"],
      knowledgePotential: { reusableQuestion: true, mechanismIncrement: true, durableWithoutVersion: true, reason: "reason" },
      scores: Object.fromEntries(["authority", "evidence", "relevance", "impact", "novelty", "recency", "actionability"].map((id) => [id, { value: 3, reason: "reason" }])),
      exclusions: [],
    };
    if (!validate(validProbe)) throw new Error("schema rejects the canonical analysis shape");
    for (const field of ["summary", "whyItMatters", "domain", "claims", "knowledgePotential", "scores", "exclusions"] as const) {
      const invalid = structuredClone(validProbe) as Record<string, unknown>;
      delete invalid[field];
      if (validate(invalid)) throw new Error(`schema does not require ${field}`);
    }
    if (validate({ ...validProbe, unexpected: true })) throw new Error("schema permits unknown top-level analysis fields");
    if (validate({ ...validProbe, domain: 1 })) throw new Error("schema permits a non-string domain");
    if (validate({ ...validProbe, claims: "claim" })) throw new Error("schema permits non-array claims");
    const invalidScore = structuredClone(validProbe);
    invalidScore.scores.authority!.value = 6;
    if (validate(invalidScore)) throw new Error("schema permits score values above 5");
  } catch (error) {
    problems.push(`prompt output schema is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const providerUrl = new URL(provider.baseUrl);
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const localHttp = providerUrl.protocol === "http:" && localHosts.has(providerUrl.hostname) && provider.endpointPolicy.allowInsecureLocalhost === true;
  const cleanUrl = (providerUrl.protocol === "https:" || localHttp) && providerUrl.username === "" && providerUrl.password === "" && providerUrl.search === "" && providerUrl.hash === "";
  if (!cleanUrl) problems.push("provider baseUrl must be clean HTTPS, or explicitly approved HTTP on localhost");
  const codingPlanEndpoint = providerUrl.hostname.startsWith("coding.dashscope.");
  if (codingPlanEndpoint) problems.push("Coding Plan endpoints are not pay-as-you-go or trial inference endpoints");
  const allowedBySuffix = (provider.endpointPolicy.allowedHostSuffixes ?? []).some((suffix) =>
    providerUrl.hostname !== suffix && providerUrl.hostname.endsWith(`.${suffix}`));
  if (!codingPlanEndpoint && !provider.endpointPolicy.allowedHosts.includes(providerUrl.hostname) && !allowedBySuffix) problems.push("provider baseUrl host must match endpointPolicy allowedHosts or an approved subdomain suffix");
  if (bundled && !provider.endpointPolicy.allowedHosts.length && !(provider.endpointPolicy.allowedHostSuffixes?.length)) problems.push("bundled provider must declare an endpoint host allowlist");
  if (provider.apiKey?.provider === "env" && !/^[A-Z][A-Z0-9_]*$/.test(provider.apiKey.key)) problems.push("provider env secret key is invalid");
  if (provider.apiKey?.provider === "file" && (!provider.apiKey.key || path.isAbsolute(provider.apiKey.key))) problems.push("provider file secret reference must be a relative path");
  if (provider.reasoningEffort && !["low", "medium", "high", "xhigh"].includes(provider.reasoningEffort)) problems.push("provider reasoningEffort is invalid");
  if (problems.length) throw new ConfigurationError("Packaged runtime resources are invalid", problems);
  validatedRuntimeDigests.add(validationDigest);
}

export function validateEffectiveConfig(config: EffectiveConfig): void {
  validatePackagedResources(config.policy, config.prompts, config.provider, false);
  const ids = new Set<string>();
  const problems: string[] = [];
  for (const source of config.preset.sources) {
    if (ids.has(source.id)) problems.push(`duplicate source ID: ${source.id}`);
    ids.add(source.id);
    if (source.cadence && !(source.cadence.minimumHours <= source.cadence.defaultHours && source.cadence.defaultHours <= source.cadence.maximumHours)) problems.push(`${source.id} cadence must satisfy minimum <= default <= maximum`);
    if (source.connector.type === "github-releases" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.connector.config.repository)) problems.push(`${source.id} has invalid GitHub repository`);
    if (source.connector.type === "rss") {
      try { if (new URL(source.connector.config.url).protocol !== "https:") problems.push(`${source.id} RSS URL must use HTTPS`); } catch { problems.push(`${source.id} has invalid RSS URL`); }
    }
    if (source.connector.type === "webpage") {
      try { if (new URL(source.connector.config.url).protocol !== "https:") problems.push(`${source.id} webpage URL must use HTTPS`); } catch { problems.push(`${source.id} has invalid webpage URL`); }
    }
    if (source.connector.type === "x-api") {
      if (!/^[A-Za-z0-9_]{1,15}$/.test(source.connector.config.username)) problems.push(`${source.id} has invalid X username`);
      if (source.connector.config.bearerToken.provider === "env" && !/^[A-Z][A-Z0-9_]*$/.test(source.connector.config.bearerToken.key)) problems.push(`${source.id} has invalid X env secret reference`);
    }
    if (source.connector.type === "codex-browser" && !/^[A-Za-z0-9_]{1,15}$/.test(source.connector.config.username)) problems.push(`${source.id} has invalid browser-capture username`);
    if (source.connector.type === "extension") {
      if (!/^[a-z][a-z0-9-]*$/.test(source.connector.config.adapter)) problems.push(`${source.id} has invalid extension adapter`);
      const hosts = source.connector.config.options.allowedHosts;
      if (!Array.isArray(hosts) || !hosts.length || hosts.some((host) => typeof host !== "string" || !/^[A-Za-z0-9.-]+$/.test(host))) problems.push(`${source.id} extension must declare valid options.allowedHosts`);
    }
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(config.provider.model)) problems.push("provider model contains unsupported characters");
  if (canonicalJson([...config.protocol.activeRuleIds].sort()) !== canonicalJson(config.policy.rules.map((rule) => rule.id).sort())) problems.push("protocol activeRuleIds do not match the policy rule set");
  if (config.protocol.stages.length !== 14 || config.protocol.stages[0] !== "initialize" || config.protocol.stages.at(-1) !== "complete") problems.push("protocol must declare the canonical 14-stage workflow");
  if (problems.length) throw new ConfigurationError("Effective configuration is invalid", problems);
}

export async function loadPreset(presetId: BriefingIntent["preset"]): Promise<PresetDefinition> {
  const [presetText, schemaText] = await Promise.all([
    readFile(path.join(packageRoot, `presets/${presetId}.json`), "utf8"),
    readFile(path.join(packageRoot, "schemas/preset.schema.json"), "utf8"),
  ]);
  const document = JSON.parse(presetText) as unknown;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(schemaText) as object);
  if (!validate(document)) {
    throw new ConfigurationError(
      `Bundled preset '${presetId}' is invalid`,
      (validate.errors ?? []).map(formatProblem),
    );
  }
  const preset = document as PresetDefinition;
  const sourceIds = preset.sources.map((source) => source.id);
  const duplicates = sourceIds.filter((id, index) => sourceIds.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new ConfigurationError(`Bundled preset '${presetId}' is invalid`, [
      `sources contain duplicate IDs: ${[...new Set(duplicates)].join(", ")}`,
    ]);
  }
  return preset;
}

export function buildEffectiveConfig(
  projectRoot: string,
  intent: BriefingIntent,
  preset: PresetDefinition,
  policy?: PolicyDefinition,
  prompts?: PromptPackDefinition,
  provider?: ProviderDefinition,
  protocol: ProtocolDefinition = PACKAGED_PROTOCOL,
  policyOrigin: EffectiveConfig["provenance"]["policyOrigin"] = "packaged",
): EffectiveConfig {
  if (!policy || !prompts || !provider) {
    throw new ConfigurationError("Packaged policy, prompt, and provider resources are required");
  }
  validatePackagedResources(policy, prompts, provider);
  const processStore = compileProcessStore(intent.processStore ?? "sqlite");
  const documents = compileDocumentStore(projectRoot, intent.documentStore ?? "local", intent.outputDirectory);
  return {
    configVersion: 3,
    projectRoot,
    name: intent.name,
    preset,
    interests: intent.interests,
    schedule: intent.schedule,
    output: {
      format: intent.output,
      directory: resolveWithinRoot(documents.root, documents.briefingDirectory),
    },
    storage: {
      driver: "sqlite",
      path: resolveWithinRoot(projectRoot, ".briefwright/state.db"),
    },
    controlPlane: processStore,
    documents,
    runtime: {
      httpConcurrency: 12,
      modelConcurrency: 6,
      maximumCapturesPerRun: 200,
      retries: 2,
      timeoutSeconds: 20,
    },
    policy,
    prompts,
    provider,
    protocol,
    provenance: {
      coreVersion: CORE_VERSION,
      intentVersion: intent.version,
      presetVersion: preset.version,
      policyVersion: policy.version,
      promptVersion: prompts.version,
      providerVersion: provider.version,
      contractVersion: protocol.contractVersion,
      contractDigest: createHash("sha256").update(protocol === PACKAGED_PROTOCOL ? packagedProtocolText : canonicalJson(protocol)).digest("hex"),
      policyOrigin,
    },
    origins: {
      name: "briefing.yaml",
      interests: "briefing.yaml",
      schedule: "briefing.yaml",
      "output.directory": "briefing.yaml",
      preset: "packaged preset",
      policy: policyOrigin === "approved-experiment" ? ".briefwright/active-policy.json" : "packaged policy",
      prompts: "packaged prompt pack",
      provider: "packaged provider",
      protocol: "packaged protocol/ai-intelligence-contract.v1.json",
      controlPlane: "briefing.yaml",
      documents: "briefing.yaml",
      runtime: "schema defaults",
    },
  };
}

export function packagedProtocolPath(): string { return packagedProtocolFile; }

export const STANDARD_LARK_TABLES = {
  sources: "数据源", runs: "运行批次", items: "情报条目", events: "状态事件", feedback: "人工反馈",
  experiments: "优化实验", captures: "原始采集", rules: "规则版本", receipts: "扫描回执",
} satisfies import("./types.js").LarkTableMapping;

function compileProcessStore(intent: BriefingIntent["processStore"]): EffectiveConfig["controlPlane"] {
  if (intent === "auto" || intent === "sqlite") return { driver: "sqlite", mode: "fallback" };
  if (intent.driver === "lark") {
    if (!intent.baseToken) throw new ConfigurationError("Lark process store requires baseToken");
    return { driver: "lark", mode: "configured", lark: {
      baseToken: intent.baseToken, identity: intent.identity ?? "user", tables: { ...STANDARD_LARK_TABLES, ...intent.tables },
      xCapture: intent.xCapture ?? "api",
      ...(intent.profile ? { profile: intent.profile } : {}),
    } };
  }
  if (intent.driver === "postgres" || intent.driver === "mysql") {
    if (!intent.connection) throw new ConfigurationError(`${intent.driver} process store requires a connection secret reference`);
    return { driver: intent.driver, mode: "configured", connection: intent.connection };
  }
  return { driver: "sqlite", mode: intent.driver === "sqlite" ? "configured" : "fallback" };
}

function compileDocumentStore(projectRoot: string, intent: BriefingIntent["documentStore"], outputDirectory: string): EffectiveConfig["documents"] {
  const selected: { driver: "auto" | "local" | "obsidian"; root?: string; briefingDirectory?: string } =
    typeof intent === "string" ? { driver: intent } : intent;
  const driver = selected.driver === "obsidian" ? "obsidian" : "local";
  const root = selected.root ? path.resolve(projectRoot, selected.root) : projectRoot;
  return {
    driver,
    mode: intent === "auto" ? "fallback" : "configured",
    root,
    briefingDirectory: selected.briefingDirectory ?? outputDirectory,
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? "null" : canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

export function configDigest(config: EffectiveConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}
