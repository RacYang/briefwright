import { access, constants } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadEffectiveConfig } from "../config/load.js";
import { prepareSafeFilePath, prepareSafeFilePathSync } from "../config/paths.js";
import { resolveSecret } from "../config/secrets.js";
import { connectorFor } from "../connectors/registry.js";
import { allowedHostsForSource, createHttpClient } from "../connectors/http.js";
import { QwenProvider } from "../providers/qwen.js";
import { databaseMigrationStatus } from "../state/migrations.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(configPath: string, options: { online?: boolean } = {}): Promise<DoctorCheck[]> {
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
    await prepareSafeFilePath(config.projectRoot, path.join(config.output.directory, ".briefwright-doctor-probe"));
    checks.push({ name: "output-boundary", ok: true, detail: config.output.directory });
  } catch (error) {
    checks.push({ name: "output-boundary", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  try {
    await resolveSecret(config.provider.apiKey, config.projectRoot);
    checks.push({ name: "credentials", ok: true, detail: `${config.provider.apiKey.provider}:${config.provider.apiKey.key} is available (value redacted)` });
  } catch (error) {
    checks.push({ name: "credentials", ok: !options.online, detail: `${error instanceof Error ? error.message : String(error)}${options.online ? "" : " Formal runs require it; offline demo and fixture preview do not."}` });
  }
  try {
    prepareSafeFilePathSync(config.projectRoot, config.storage.path);
    const database = new DatabaseSync(config.storage.path);
    const status = databaseMigrationStatus(database);
    database.close();
    checks.push({ name: "database-schema", ok: status.pending.length === 0 || status.current === 0, detail: status.current === 0 ? `Fresh database will initialize at schema ${status.latest}` : `schema ${status.current}/${status.latest}; pending ${status.pending.map((item) => item.version).join(",") || "none"}` });
  } catch (error) {
    checks.push({ name: "database-schema", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
  if (options.online) {
    const provider = await new QwenProvider().check({ interests: config.interests, domains: config.policy.domains, prompt: config.prompts, provider: config.provider, projectRoot: config.projectRoot });
    checks.push({ name: "provider:qwen", ...provider });
    const allowedHosts = config.preset.sources.flatMap(allowedHostsForSource);
    const fetchClient = createHttpClient({ timeoutSeconds: config.runtime.timeoutSeconds, retries: 0, allowedHosts });
    for (const source of config.preset.sources) {
      try {
        const result = await connectorFor(source).check(source, { fetch: fetchClient, now: () => new Date() });
        checks.push({ name: `connector:${source.id}`, ...result });
      } catch (error) {
        checks.push({ name: `connector:${source.id}`, ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return checks;
}
