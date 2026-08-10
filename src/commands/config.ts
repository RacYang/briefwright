import { configDigest, loadEffectiveConfig } from "../config/load.js";

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

  const origins: Record<string, string> = {
    name: "briefing.yaml",
    interests: "briefing.yaml",
    schedule: "briefing.yaml",
    "output.format": "briefing.yaml",
    "output.directory": "briefing.yaml resolved against the project root",
    preset: "selected preset",
    runtime: "built-in safe defaults",
    storage: "built-in local profile",
  };
  const origin = origins[field] ?? origins[parts[0] ?? ""] ?? "compiled effective configuration";
  return `${field} = ${JSON.stringify(value)}\norigin: ${origin}`;
}

