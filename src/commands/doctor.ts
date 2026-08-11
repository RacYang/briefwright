import { access, constants, lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadEffectiveConfig } from "../config/load.js";
import { assertSafeReadPath } from "../config/paths.js";
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
    await assertSafeReadPath(config.projectRoot, config.output.directory);
    const ancestor = await writableAncestor(config.projectRoot, config.output.directory);
    checks.push({ name: "output-boundary", ok: true, detail: `${config.output.directory} (writable ancestor: ${ancestor})` });
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
