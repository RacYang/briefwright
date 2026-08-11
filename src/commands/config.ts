import { configDigest, loadEffectiveConfig } from "../config/load.js";
import { ejectAdvancedResources } from "../config/advanced.js";

export async function validateConfiguration(configPath: string): Promise<void> {
  await loadEffectiveConfig(configPath);
}

export async function renderConfiguration(configPath: string): Promise<string> {
  const config = await loadEffectiveConfig(configPath);
  return JSON.stringify(
    {
      ...config,
      digest: configDigest(config),
    },
    null,
    2,
  );
}

export async function explainConfiguration(configPath: string, field: string): Promise<string> {
  const config = await loadEffectiveConfig(configPath);
  const parts = field.split(".");
  let value: unknown = config;
  for (const part of parts) {
    if (!value || typeof value !== "object" || !(part in value)) {
      throw new Error(`Unknown effective configuration field: ${field}`);
    }
    value = (value as Record<string, unknown>)[part];
  }

  const origin = config.origins[field] ?? config.origins[parts[0] ?? ""] ?? "compiled effective configuration";
  return `${field} = ${JSON.stringify(value)}\norigin: ${origin}`;
}

export async function ejectConfiguration(configPath: string): Promise<string[]> {
  return ejectAdvancedResources(await loadEffectiveConfig(configPath));
}

function differences(left: unknown, right: unknown, prefix = ""): Array<{ field: string; left: unknown; right: unknown }> {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = new Set([...Object.keys(left as object), ...Object.keys(right as object)]);
    return [...keys].sort().flatMap((key) => differences((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key));
  }
  return [{ field: prefix || "/", left, right }];
}

export async function diffConfiguration(configPath: string, againstPath: string) {
  const [left, right] = await Promise.all([loadEffectiveConfig(configPath), loadEffectiveConfig(againstPath)]);
  return differences(left, right).filter((entry) => !entry.field.startsWith("projectRoot") && !entry.field.startsWith("storage.path") && !entry.field.startsWith("origins"));
}
