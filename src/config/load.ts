import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import formatsModule, { type FormatsPlugin } from "ajv-formats";
import { parse } from "yaml";

import { resolveWithinRoot } from "./paths.js";
import type { BriefingIntent, EffectiveConfig, PresetDefinition } from "./types.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const addFormats = formatsModule as unknown as FormatsPlugin;

export class ConfigurationError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function formatProblem(error: ErrorObject): string {
  const location = error.instancePath || "configuration";
  if (error.keyword === "additionalProperties") {
    const property = String(error.params.additionalProperty);
    return `${location} contains unknown field '${property}'`;
  }
  return `${location} ${error.message ?? "is invalid"}`;
}

export async function parseIntent(configPath: string): Promise<BriefingIntent> {
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

  const validated = document as Pick<BriefingIntent, "version" | "name" | "interests"> &
    Partial<BriefingIntent>;
  return {
    version: 1,
    name: validated.name,
    preset: validated.preset ?? "ai-daily",
    interests: validated.interests,
    schedule: validated.schedule ?? "manual",
    output: validated.output ?? "markdown",
    outputDirectory: validated.outputDirectory ?? "briefs",
  };
}

export async function loadEffectiveConfig(configPath: string): Promise<EffectiveConfig> {
  const absoluteConfigPath = path.resolve(configPath);
  const projectRoot = path.dirname(absoluteConfigPath);
  const intent = await parseIntent(absoluteConfigPath);
  const preset = await loadPreset(intent.preset);

  return buildEffectiveConfig(projectRoot, intent, preset);
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
): EffectiveConfig {

  return {
    configVersion: 1,
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
      retries: 2,
      timeoutSeconds: 20,
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
