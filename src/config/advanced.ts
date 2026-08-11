import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import formatsModule, { type FormatsPlugin } from "ajv-formats";
import { parse, stringify } from "yaml";

import type { EffectiveConfig, PolicyDefinition, PromptPackDefinition, ProviderDefinition, SourceDefinition } from "./types.js";
import { ConfigurationError } from "./errors.js";
import { validatePolicy } from "./policy.js";
import { assertSafeReadPath, resolveWithinRoot } from "./paths.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const addFormats = formatsModule as unknown as FormatsPlugin;

interface Resource { apiVersion: "briefwright.dev/v1alpha1"; kind: "Profile" | "PolicyBundle" | "PromptPack" | "Output" | "Source"; metadata: { id: string }; spec: Record<string, unknown> }

async function exists(target: string): Promise<boolean> { try { await access(target); return true; } catch { return false; } }

async function resourceFiles(root: string): Promise<string[]> {
  const directory = path.join(root, "briefwright.d");
  if (!(await exists(directory))) return [];
  await assertSafeReadPath(root, directory);
  const top = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name)).map((entry) => path.join(directory, entry.name));
  const sources = path.join(directory, "sources");
  if (await exists(sources)) await assertSafeReadPath(root, sources);
  const nested = await exists(sources) ? (await readdir(sources, { withFileTypes: true })).filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name)).map((entry) => path.join(sources, entry.name)) : [];
  return [...top, ...nested].sort();
}

async function readResources(root: string): Promise<Array<{ path: string; value: Resource }>> {
  const files = await resourceFiles(root);
  if (!files.length) return [];
  const schema = JSON.parse(await readFile(path.join(packageRoot, "schemas/resource.schema.json"), "utf8")) as object;
  const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv);
  const validate = ajv.compile(schema);
  const resources: Array<{ path: string; value: Resource }> = [];
  for (const file of files) {
    await assertSafeReadPath(root, file);
    const value = parse(await readFile(file, "utf8")) as unknown;
    if (!validate(value)) {
      const problems = (validate.errors ?? []).slice(0, 20).map((error: ErrorObject) => `${error.instancePath || "/"} ${error.message}`);
      throw new ConfigurationError(`Invalid advanced resource: ${file}`, problems);
    }
    resources.push({ path: file, value: value as Resource });
  }
  const identities = resources.map((entry) => `${entry.value.kind}:${entry.value.metadata.id}`);
  const duplicates = identities.filter((id, index) => identities.indexOf(id) !== index);
  if (duplicates.length) throw new ConfigurationError("Duplicate advanced resources", [...new Set(duplicates)]);
  return resources;
}

export async function applyAdvancedResources(config: EffectiveConfig): Promise<EffectiveConfig> {
  const resources = await readResources(config.projectRoot);
  if (!resources.length) return config;
  let next = structuredClone(config);
  const origins = { ...next.origins };
  for (const { path: resourcePath, value } of resources) {
    if (value.kind === "Profile") {
      const spec = value.spec as { runtime?: Partial<EffectiveConfig["runtime"]>; provider?: Partial<ProviderDefinition> };
      if (spec.runtime) { next.runtime = { ...next.runtime, ...spec.runtime }; origins.runtime = resourcePath; }
      if (spec.provider) {
        next.provider = {
          ...next.provider,
          ...spec.provider,
          ...((spec.provider.apiKey ?? next.provider.apiKey) ? { apiKey: spec.provider.apiKey ?? next.provider.apiKey } : {}),
        };
        origins.provider = resourcePath;
      }
    } else if (value.kind === "PolicyBundle") {
      next.policy = value.spec as unknown as PolicyDefinition; validatePolicy(next.policy); origins.policy = resourcePath;
    } else if (value.kind === "PromptPack") {
      next.prompts = value.spec as unknown as PromptPackDefinition; origins.prompts = resourcePath;
    } else if (value.kind === "Output") {
      next.output.directory = resolveWithinRoot(next.projectRoot, String(value.spec.directory)); origins["output.directory"] = resourcePath;
    } else if (value.kind === "Source") {
      const index = next.preset.sources.findIndex((source) => source.id === value.metadata.id);
      if (index < 0) throw new ConfigurationError(`Source override targets an unknown source: ${value.metadata.id}`);
      const spec = value.spec as Partial<SourceDefinition> & { enabled?: boolean };
      if (spec.enabled === false) next.preset.sources.splice(index, 1);
      else next.preset.sources[index] = { ...next.preset.sources[index]!, ...spec, id: value.metadata.id } as SourceDefinition;
      origins[`source.${value.metadata.id}`] = resourcePath;
    }
  }
  next.origins = origins;
  return next;
}

export async function ejectAdvancedResources(config: EffectiveConfig): Promise<string[]> {
  const directory = path.join(config.projectRoot, "briefwright.d");
  if (await exists(directory)) throw new Error(`Advanced configuration already exists: ${directory}`);
  const staging = path.join(config.projectRoot, `.briefwright.d.tmp-${randomUUID()}`);
  await mkdir(path.join(staging, "sources"), { recursive: true });
  const files: Array<[string, Resource]> = [
    [path.join(staging, "profile.yaml"), { apiVersion: "briefwright.dev/v1alpha1", kind: "Profile", metadata: { id: "local" }, spec: { runtime: config.runtime, provider: { model: config.provider.model, baseUrl: config.provider.baseUrl, apiKey: config.provider.apiKey } } }],
    [path.join(staging, "policy.yaml"), { apiVersion: "briefwright.dev/v1alpha1", kind: "PolicyBundle", metadata: { id: config.policy.id }, spec: config.policy as unknown as Record<string, unknown> }],
    [path.join(staging, "prompt.yaml"), { apiVersion: "briefwright.dev/v1alpha1", kind: "PromptPack", metadata: { id: config.prompts.id }, spec: config.prompts as unknown as Record<string, unknown> }],
    [path.join(staging, "output.yaml"), { apiVersion: "briefwright.dev/v1alpha1", kind: "Output", metadata: { id: "markdown" }, spec: { directory: path.relative(config.projectRoot, config.output.directory) } }],
    ...config.preset.sources.map((source): [string, Resource] => [path.join(staging, "sources", `${source.id.toLowerCase()}.yaml`), { apiVersion: "briefwright.dev/v1alpha1", kind: "Source", metadata: { id: source.id }, spec: { enabled: true, title: source.title, ...(source.domain ? { domain: source.domain } : {}), ...(source.cadence ? { cadence: source.cadence } : {}), connector: source.connector } }]),
  ];
  try {
    for (const [file, resource] of files) await writeFile(file, stringify(resource), { encoding: "utf8", flag: "wx" });
    await rename(staging, directory);
    return files.map(([file]) => path.join(directory, path.relative(staging, file)));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
