import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import formatsModule, { type FormatsPlugin } from "ajv-formats";
import { parse } from "yaml";

import { resolveWithinRoot } from "./paths.js";
import type {
  BriefingIntent,
  EffectiveConfig,
  PolicyDefinition,
  PresetDefinition,
  PromptPackDefinition,
  ProviderDefinition,
} from "./types.js";
import { applyAdvancedResources } from "./advanced.js";
import { ConfigurationError } from "./errors.js";
import { validatePolicy } from "./policy.js";

export { ConfigurationError } from "./errors.js";
export { validatePolicy } from "./policy.js";

const CORE_VERSION = "0.2.0";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const addFormats = formatsModule as unknown as FormatsPlugin;

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
  if (input.version === 1) {
    input.version = 2;
    input.ai ??= "qwen";
    return { intent: input as unknown as BriefingIntent, fromVersion: 1, changed: true };
  }
  if (input.version === 2) {
    return { intent: input as unknown as BriefingIntent, fromVersion: 2, changed: false };
  }
  throw new ConfigurationError(`Unsupported briefing.yaml version: ${String(input.version)}`, [
    "Supported versions are 1 and 2; downgrades and unknown future versions are not automatic",
  ]);
}

export async function parseIntentWithMigration(configPath: string): Promise<IntentMigrationResult> {
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
    version: 2,
    name: validated.name,
    preset: validated.preset ?? "ai-daily",
    interests: validated.interests,
    schedule: validated.schedule ?? "manual",
    output: validated.output ?? "markdown",
    outputDirectory: validated.outputDirectory ?? "briefs",
    ai: validated.ai ?? "qwen",
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
  let effective = await applyAdvancedResources(buildEffectiveConfig(projectRoot, intent, resources.preset, resources.policy, resources.prompts, resources.provider, "packaged"));
  try {
    const policy = JSON.parse(await readFile(path.join(projectRoot, ".briefwright/active-policy.json"), "utf8")) as PolicyDefinition;
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

export async function loadPackagedRuntime(intent: BriefingIntent): Promise<{
  preset: PresetDefinition;
  policy: PolicyDefinition;
  prompts: PromptPackDefinition;
  provider: ProviderDefinition;
}> {
  const [preset, policy, prompts, provider] = await Promise.all([
    loadPreset(intent.preset),
    loadPackagedJson<PolicyDefinition>("policies/ai-intelligence-v1.json"),
    loadPackagedJson<PromptPackDefinition>("prompts/ai-intelligence-v1.json"),
    loadPackagedJson<ProviderDefinition>(`providers/${intent.ai}.json`),
  ]);
  return { preset, policy, prompts, provider };
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
  const problems: string[] = [];
  try { validatePolicy(policy); } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  try {
    new Ajv2020({ allErrors: true, strict: true }).compile(prompts.outputSchema);
  } catch (error) {
    problems.push(`prompt output schema is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const providerUrl = new URL(provider.baseUrl);
  const allowed = providerUrl.hostname === "dashscope.aliyuncs.com" || providerUrl.hostname === "dashscope-us.aliyuncs.com" ||
    providerUrl.hostname === "coding.dashscope.aliyuncs.com" || providerUrl.hostname === "coding-intl.dashscope.aliyuncs.com" ||
    /^[a-z0-9-]+\.(cn-beijing|ap-southeast-1|ap-northeast-1)\.maas\.aliyuncs\.com$/.test(providerUrl.hostname);
  if (providerUrl.protocol !== "https:" || !allowed) problems.push("provider baseUrl is not an approved Alibaba Model Studio endpoint");
  if (bundled && (provider.apiKey.provider !== "env" || provider.apiKey.key !== "DASHSCOPE_API_KEY")) problems.push("bundled Qwen provider must use env:DASHSCOPE_API_KEY");
  if (provider.apiKey.provider === "env" && !/^[A-Z][A-Z0-9_]*$/.test(provider.apiKey.key)) problems.push("provider env secret key is invalid");
  if (provider.apiKey.provider === "file" && (!provider.apiKey.key || path.isAbsolute(provider.apiKey.key))) problems.push("provider file secret reference must be a relative path");
  if (problems.length) throw new ConfigurationError("Packaged runtime resources are invalid", problems);
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
    if (source.connector.type === "extension") {
      if (!/^[a-z][a-z0-9-]*$/.test(source.connector.config.adapter)) problems.push(`${source.id} has invalid extension adapter`);
      const hosts = source.connector.config.options.allowedHosts;
      if (!Array.isArray(hosts) || !hosts.length || hosts.some((host) => typeof host !== "string" || !/^[A-Za-z0-9.-]+$/.test(host))) problems.push(`${source.id} extension must declare valid options.allowedHosts`);
    }
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(config.provider.model)) problems.push("provider model contains unsupported characters");
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
  policyOrigin: EffectiveConfig["provenance"]["policyOrigin"] = "packaged",
): EffectiveConfig {
  if (!policy || !prompts || !provider) {
    throw new ConfigurationError("Packaged policy, prompt, and provider resources are required");
  }
  validatePackagedResources(policy, prompts, provider);
  return {
    configVersion: 2,
    projectRoot,
    name: intent.name,
    preset,
    interests: intent.interests,
    schedule: intent.schedule,
    output: {
      format: intent.output,
      directory: resolveWithinRoot(projectRoot, intent.outputDirectory),
    },
    storage: {
      driver: "sqlite",
      path: resolveWithinRoot(projectRoot, ".briefwright/state.db"),
    },
    runtime: {
      httpConcurrency: 4,
      modelConcurrency: 2,
      maximumCapturesPerRun: 40,
      retries: 2,
      timeoutSeconds: 20,
    },
    policy,
    prompts,
    provider,
    provenance: {
      coreVersion: CORE_VERSION,
      intentVersion: intent.version,
      presetVersion: preset.version,
      policyVersion: policy.version,
      promptVersion: prompts.version,
      providerVersion: provider.version,
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
      runtime: "schema defaults",
    },
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function configDigest(config: EffectiveConfig): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex");
}
