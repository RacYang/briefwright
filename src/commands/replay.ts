import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadEffectiveConfig } from "../config/load.js";
import { prepareSafeFilePath } from "../config/paths.js";
import { renderMarkdown } from "../outputs/markdown.js";
import { SqliteStateStore } from "../state/sqlite.js";

export interface ReplayResult {
  runId: string;
  artifactPath: string;
  recordedHash: string;
  reproducedHash: string;
  diskHash: string;
  snapshotMatches: boolean;
  diskMatches: boolean;
  matches: boolean;
}

export async function verifyReplay(configPath: string, runId: string): Promise<ReplayResult> {
  const current = await loadEffectiveConfig(configPath);
  const state = new SqliteStateStore(current.storage.path, current.projectRoot);
  try {
    const bundle = state.replayBundle(runId);
    const reproducedHash = createHash("sha256")
      .update(renderMarkdown(bundle.config, bundle.result))
      .digest("hex");
    await prepareSafeFilePath(bundle.config.projectRoot, bundle.artifactPath);
    const diskHash = createHash("sha256").update(await readFile(bundle.artifactPath)).digest("hex");
    const snapshotMatches = reproducedHash === bundle.contentHash;
    const diskMatches = diskHash === bundle.contentHash;
    return {
      runId,
      artifactPath: bundle.artifactPath,
      recordedHash: bundle.contentHash,
      reproducedHash,
      diskHash,
      snapshotMatches,
      diskMatches,
      matches: snapshotMatches && diskMatches,
    };
  } finally {
    state.close();
  }
}
