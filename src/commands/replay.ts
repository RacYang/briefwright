import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadEffectiveConfig } from "../config/load.js";
import { prepareSafeFilePath } from "../config/paths.js";
import { renderMarkdown } from "../outputs/markdown.js";
import { renderFormalDaily, renderFormalReview } from "../outputs/formal-markdown.js";
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
  artifacts: Array<{ kind: string; artifactPath: string; recordedHash: string; reproducedHash: string; diskHash: string; snapshotMatches: boolean; diskMatches: boolean }>;
}

export async function verifyReplay(configPath: string, runId: string): Promise<ReplayResult> {
  const current = await loadEffectiveConfig(configPath);
  const state = new SqliteStateStore(current.storage.path, current.projectRoot);
  try {
    const bundle = state.replayArtifacts(runId);
    const artifacts = [];
    for (const artifact of bundle.artifacts) {
      const rendered = artifact.kind === "daily-markdown"
        ? renderFormalDaily(bundle.config, bundle.result)
        : artifact.kind === "review-markdown"
          ? renderFormalReview(bundle.config, bundle.result)
          : renderMarkdown(bundle.config, bundle.result);
      const reproducedHash = createHash("sha256").update(rendered).digest("hex");
      await prepareSafeFilePath(bundle.config.projectRoot, artifact.path);
      const diskHash = createHash("sha256").update(await readFile(artifact.path)).digest("hex");
      artifacts.push({ kind: artifact.kind, artifactPath: artifact.path, recordedHash: artifact.contentHash, reproducedHash, diskHash, snapshotMatches: reproducedHash === artifact.contentHash, diskMatches: diskHash === artifact.contentHash });
    }
    const primary = artifacts[0]!;
    const snapshotMatches = artifacts.every((artifact) => artifact.snapshotMatches);
    const diskMatches = artifacts.every((artifact) => artifact.diskMatches);
    return {
      runId,
      artifactPath: primary.artifactPath,
      recordedHash: primary.recordedHash,
      reproducedHash: primary.reproducedHash,
      diskHash: primary.diskHash,
      snapshotMatches,
      diskMatches,
      matches: snapshotMatches && diskMatches,
      artifacts,
    };
  } finally {
    state.close();
  }
}
