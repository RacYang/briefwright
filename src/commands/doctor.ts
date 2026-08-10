import { access, constants } from "node:fs/promises";
import path from "node:path";

import { loadEffectiveConfig } from "../config/load.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runDoctor(configPath: string): Promise<DoctorCheck[]> {
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

  checks.push({
    name: "output-boundary",
    ok: (() => {
      const relative = path.relative(config.projectRoot, config.output.directory);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    })(),
    detail: config.output.directory,
  });
  checks.push({
    name: "credentials",
    ok: true,
    detail: "The bundled ai-daily preview does not require credentials",
  });
  return checks;
}
