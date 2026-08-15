import { access, constants, lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadEffectiveConfig } from "../config/load.js";
import { assertSafeReadPath } from "../config/paths.js";
import { resolveSecret } from "../config/secrets.js";
import { connectorFor } from "../connectors/registry.js";
import { allowedHostsForSource, createHttpClient } from "../connectors/http.js";
import { providerFor } from "../providers/registry.js";
import { databaseMigrationStatus } from "../state/migrations.js";
import { controlPlaneFor, hydrateControlPlaneContext } from "../control-plane/registry.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  blocking?: boolean;
}

export interface DoctorDependencies {
  httpClientFactory?: typeof createHttpClient;
  modelProviderFactory?: typeof providerFor;
}

export function doctorReport(checks: DoctorCheck[]): { ok: boolean; command: "doctor"; checks: DoctorCheck[] } {
  return {
    ok: checks.every((check) => check.ok || check.blocking === false),
    command: "doctor",
    checks,
  };
}

function errorDetail(error: unknown): string {
  const details: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null && !seen.has(current); depth += 1) {
    seen.add(current);
    details.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return details.filter(Boolean).join("; caused by: ") || "Unknown error";
}

function requiresExternalCapture(source: { connector: { type: string } }): boolean {
  return source.connector.type === "codex-browser" || source.connector.type === "in-app-browser" || source.connector.type === "computer-use";
}

async function writableAncestor(projectRoot: string, target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      await access(current, constants.W_OK);
      const stats = await lstat(current);
      if (path.resolve(current) === path.resolve(target) && !stats.isDirectory()) {
        throw new Error(`Output directory target is not a directory: ${target}`);
      }
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (path.resolve(current) === path.resolve(projectRoot)) throw error;
      current = path.dirname(current);
    }
  }
}

export async function runDoctor(
  configPath: string,
  options: { online?: boolean; allSources?: boolean } = {},
  dependencies: DoctorDependencies = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let config;
  try {
    config = await loadEffectiveConfig(configPath);
    checks.push({ name: "configuration", ok: true, detail: "briefing.yaml is valid" });
  } catch (error) {
    checks.push({
      name: "configuration",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return checks;
  }

  try {
    await access(config.projectRoot, constants.W_OK);
    checks.push({ name: "project-directory", ok: true, detail: config.projectRoot });
  } catch {
    checks.push({
      name: "project-directory",
      ok: false,
      detail: `Project directory is not writable: ${config.projectRoot}`,
    });
  }

  try {
    await assertSafeReadPath(config.documents.root, config.output.directory);
    const ancestor = await writableAncestor(config.documents.root, config.output.directory);
    checks.push({ name: "output-boundary", ok: true, detail: `${config.output.directory} (writable ancestor: ${ancestor})` });
  } catch (error) {
    checks.push({ name: "output-boundary", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    if (!config.provider.apiKey) {
      checks.push({ name: "credentials", ok: true, detail: "This provider does not require an API key" });
    } else {
      await resolveSecret(config.provider.apiKey, config.projectRoot);
      checks.push({ name: "credentials", ok: true, detail: `${config.provider.apiKey.provider}:${config.provider.apiKey.key} is available (value redacted)` });
    }
  } catch (error) {
    checks.push({ name: "credentials", ok: !options.online, detail: `${error instanceof Error ? error.message : String(error)}${options.online ? "" : " Formal runs require it; offline demo and fixture preview do not."}` });
  }
  try {
    await assertSafeReadPath(config.projectRoot, config.storage.path);
    try {
      await access(config.storage.path, constants.R_OK);
      const database = new DatabaseSync(config.storage.path, { readOnly: true });
      const status = databaseMigrationStatus(database);
      database.close();
      checks.push({ name: "database-schema", ok: status.pending.length === 0, detail: `schema ${status.current}/${status.latest}; pending ${status.pending.map((item) => item.version).join(",") || "none"}` });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      checks.push({ name: "database-schema", ok: true, detail: "Fresh database will initialize at the latest packaged schema on first Preview or Run" });
    }
  } catch (error) {
    checks.push({ name: "database-schema", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  if (options.online) {
    let onlineConfig = config;
    const controlPlane = controlPlaneFor(config);
    try { checks.push(...await controlPlane.doctor()); } finally { await controlPlane.close(); }
    try { onlineConfig = (await hydrateControlPlaneContext(config)).config; checks.push({ name: "control-plane-context", ok: true, detail: `${onlineConfig.preset.sources.length} enabled sources and ${onlineConfig.policy.rules.length} active rules loaded` }); }
    catch (error) { checks.push({ name: "control-plane-context", ok: false, detail: error instanceof Error ? error.message : String(error) }); }
    const provider = await (dependencies.modelProviderFactory ?? providerFor)(onlineConfig.provider).check({ interests: onlineConfig.interests, domains: onlineConfig.policy.domains, prompt: onlineConfig.prompts, provider: onlineConfig.provider, projectRoot: onlineConfig.projectRoot });
    checks.push({ name: `provider:${onlineConfig.provider.id}`, ...provider });
    const now = new Date();
    const sources = options.allSources ? onlineConfig.preset.sources : onlineConfig.preset.sources.filter((source) => {
      const schedule = source.scheduleState;
      if (!schedule?.lastScanAt) return true;
      if (schedule.nextScanAt) return new Date(schedule.nextScanAt).getTime() <= now.getTime();
      const hours = source.cadence?.defaultHours ?? 24;
      return new Date(schedule.lastScanAt).getTime() + hours * 3_600_000 <= now.getTime();
    });
    checks.push({ name: "source-check-scope", ok: true, detail: `${sources.length}/${onlineConfig.preset.sources.length} ${options.allSources ? "enabled" : "currently due"} sources checked` });
    const allowedHosts = sources.flatMap(allowedHostsForSource);
    const fetchClient = (dependencies.httpClientFactory ?? createHttpClient)({ timeoutSeconds: onlineConfig.runtime.timeoutSeconds, retries: 0, allowedHosts });
    const sourceChecks = new Array<DoctorCheck>(sources.length); let next = 0;
    const workers = Array.from({ length: Math.min(onlineConfig.runtime.httpConcurrency, sources.length) }, async () => {
      for (;;) {
        const index = next++; const source = sources[index]; if (!source) return;
        const externalCapture = requiresExternalCapture(source);
        try {
          const result = await connectorFor(source).check(source, { fetch: fetchClient, now: () => new Date(), projectRoot: onlineConfig.projectRoot });
          sourceChecks[index] = { name: `connector:${source.id}`, ...result, ...(result.ok || !externalCapture ? {} : { blocking: false }) };
        } catch (error) {
          sourceChecks[index] = { name: `connector:${source.id}`, ok: false, detail: errorDetail(error), ...(externalCapture ? { blocking: false } : {}) };
        }
      }
    });
    try {
      await Promise.all(workers);
      checks.push(...sourceChecks);
    } finally {
      try {
        const cleanup = await fetchClient.close();
        checks.push({
          name: "connector-http-cleanup",
          ok: cleanup.mode === "graceful",
          detail: cleanup.detail,
          ...(cleanup.mode === "graceful" ? {} : { blocking: false }),
        });
      } catch (error) {
        checks.push({ name: "connector-http-cleanup", ok: false, detail: errorDetail(error), blocking: false });
      }
    }
  }
  return checks;
}
