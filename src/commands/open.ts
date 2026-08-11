import { access } from "node:fs/promises";
import { spawn } from "node:child_process";

import { projectStatus } from "./status.js";
import { loadEffectiveConfig } from "../config/load.js";
import { documentStoreFor } from "../documents/filesystem.js";

export async function latestArtifactPath(configPath: string): Promise<string> {
  const status = await projectStatus(configPath);
  const artifactPath = status.latestRun?.artifactPath;
  if (!artifactPath) {
    throw new Error("No briefing artifact exists yet. Run 'briefwright preview' first.");
  }
  await access(artifactPath);
  return artifactPath;
}

export function launchArtifact(artifactPath: string): void {
  const command = process.platform === "darwin"
    ? { file: "open", args: [artifactPath] }
    : process.platform === "win32"
      ? { file: "explorer.exe", args: [artifactPath] }
      : { file: "xdg-open", args: [artifactPath] };
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.unref();
}

export async function launchProjectArtifact(configPath: string, artifactPath: string): Promise<void> {
  documentStoreFor(await loadEffectiveConfig(configPath)).open(artifactPath);
}
